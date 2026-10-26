/**
 * secret-masker.mjs — value-based secret masking over arbitrary log text (#974).
 *
 * Builds a masking function from an env-like object: every value that survives
 * three filters becomes a NEEDLE, and every occurrence of a needle in the input
 * text is replaced with the repo-wide `[REDACTED]` marker.
 *
 * Pure and synchronous — no I/O, no module state, no dependencies beyond the
 * sibling `redact-spans.mjs` primitive — because hot-path consumers import it.
 * This module deliberately does NOT wire itself into any consumer; wiring is a
 * separate concern (and a separate wave).
 *
 * ---------------------------------------------------------------------------
 * THE NEEDLE SET IS A FUNCTION OF THE CALLER'S ENV — AND THAT IS NOT A DEFECT
 * ---------------------------------------------------------------------------
 * Two runs of the same consumer over the same records mask DIFFERENTLY when the
 * env differs between them (#1025): with `FOO_TOKEN` set, its value becomes
 * `[REDACTED]`; without it, the same text passes through verbatim. Consumers that
 * compare a previously-written artifact against a freshly-rendered candidate must
 * therefore treat an already-redacted span as a WILDCARD, or a later
 * partially-populated run re-writes the raw value it had already redacted (see
 * `matchesModuloRedaction` in `scripts/lib/vault-mirror/process.mjs`).
 *
 * The tempting fix — persist the needle set so a later run can mask without the
 * env — is REJECTED: it breaks the purity contract in the paragraph above and
 * puts a plaintext secrets file on disk to defend against secrets on disk. The
 * env dependency stays; consumers compensate.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FILTER ORDER IS ALLOWLIST → KEY-NAME → LENGTH, AND NOT LENGTH FIRST
 * ---------------------------------------------------------------------------
 * A "mask every env value longer than N characters" masker is the obvious
 * design and it is measurably WRONG. Discovery measured 40 env values of ≥8
 * characters on the development host against 5.2 MB of real log text; six of
 * them collide with ordinary log content:
 *
 *   len 21 → 157 corpus hits (USER, LOGNAME)
 *   len 28 → 157 corpus hits (HOME)
 *   len 58 → 154 corpus hits (PWD, OLDPWD)
 *   len 36 →  39 corpus hits (CLAUDE_CODE_SESSION_ID)
 *
 * The shortest REAL secret on that host is 32 characters; the longest collider
 * is 58. The bands overlap completely: any threshold ≤58 admits PWD (154
 * mis-maskings), any threshold >58 discards three real secrets (32/50/51). There
 * is no separating value — length is provably not a discriminating feature.
 * Length therefore runs LAST, purely as a guard against degenerate short values
 * (`X_KEY=1`), never as the primary filter.
 *
 * ---------------------------------------------------------------------------
 * CLAUDE_CODE_SESSION_ID — the sharpest boundary case, and why it is NOT
 * allowlisted
 * ---------------------------------------------------------------------------
 * It is 36 characters with 39 corpus hits: length-indistinguishable from a
 * 32-character token, yet a legitimate correlation key that appears in ordinary
 * log lines. Masking it would destroy the log's correlation value; not masking
 * it costs nothing, because a session id is not a credential (the credential
 * beside it is CLAUDE_CODE_MESSAGING_TOKEN, which DOES qualify via `_TOKEN`).
 *
 * The decision is to leave it OUT of the allowlist and let filter 2 exclude it
 * structurally: it ends in `_ID`, which the key-name heuristic does not match,
 * so it can never become a needle. An allowlist entry would be redundant today
 * AND silent tomorrow — if someone later widens the heuristic to `_ID`, an
 * allowlist entry would quietly absorb the change, whereas the pinned test
 * (`tests/lib/secret-masker.test.mjs`) goes RED and forces the decision to be
 * taken again. The louder mechanism wins.
 *
 * ---------------------------------------------------------------------------
 * NEEDLE SET IS `{raw}` ONLY — no base64, no percent-encoding
 * ---------------------------------------------------------------------------
 * Encoded variants are theoretical in this repo: the only encoders encode FILE
 * PATHS (`scripts/lib/fetch-baseline.mjs`, `scripts/lib/vault-backfill/glab.mjs`)
 * or HOOK SOURCE (`hooks/_lib/guard-source-loader.mjs`) — never credentials. And
 * typical token alphabets are URI-unreserved, so percent-encoding would be the
 * identity transform for them anyway. Each extra variant triples the needle set
 * and with it the collision surface, buying coverage for no reachable path.
 *
 * @see scripts/lib/redact-spans.mjs — the overlap-safe span merge this delegates to
 * @see scripts/lib/quality-gate/diagnostics.mjs — SECRET_ENV_NAME_RE, the shape mirrored below
 */

import { redactSpans } from './redact-spans.mjs';

/**
 * Filter 1 — deny-by-default for MASKING: these keys never become needles.
 *
 * Measured, not guessed: every entry either appears verbatim in ordinary log
 * text (paths, usernames, terminal identity) or is a public toolchain constant.
 * Masking any of them corrupts the log without protecting anything.
 *
 * HONEST NOTE ON ITS CURRENT REACH — measured, not assumed: no key in this set
 * ends in a secret-bearing suffix, so filter 2 alone already rejects every one
 * of them. Proven by a fake-regression probe: with this whole set bypassed and
 * filter 2 intact, the over-masking tests in `tests/lib/secret-masker.test.mjs`
 * stayed GREEN (16/17 — the single failure was the unrelated escaping probe run
 * in the same pass). This set is therefore defense-in-depth plus a record of the
 * measurement — NOT the load-bearing filter. Do not read a green over-masking
 * test as proof that this list stopped the collision; the key-name heuristic
 * did. Adding a secret-NAMED key here would open a silent hole in which a real
 * credential is never masked, so any such addition needs its own justification
 * beside the entry.
 *
 * @type {ReadonlySet<string>}
 */
const NEVER_MASK_KEYS = new Set([
  // A — POSIX / shell identity and paths; guaranteed to occur in log text.
  'PATH',
  'FPATH',
  'MANPATH',
  'INFOPATH',
  'XDG_DATA_DIRS',
  'HOME',
  'PWD',
  'OLDPWD',
  'TMPDIR',
  'SHELL',
  'USER',
  'LOGNAME',
  'LANG',
  'TERM',
  'TERMINFO',
  'COLORTERM',
  'COMMAND_MODE',
  '_',
  // B — toolchain install prefixes; public constants that appear in every
  //     build/tool log line.
  'HOMEBREW_PREFIX',
  'HOMEBREW_REPOSITORY',
  'HOMEBREW_CELLAR',
  'BUN_INSTALL',
  'PNPM_HOME',
  'DOTNET_ROOT',
  // C — terminal / platform identity.
  'GHOSTTY_SHELL_FEATURES',
  'GHOSTTY_BIN_DIR',
  'GHOSTTY_RESOURCES_DIR',
  '__CF_USER_TEXT_ENCODING',
  '__CFBundleIdentifier',
  'AI_AGENT',
  'CLAUDE_CODE_EXECPATH',
  'SSH_AUTH_SOCK',
]);

/**
 * Filter 2 — key-name heuristic: only semantically secret-bearing NAMES qualify.
 *
 * This MIRRORS the shape of `SECRET_ENV_NAME_RE` in
 * `scripts/lib/quality-gate/diagnostics.mjs:49` but is deliberately a SEPARATE
 * declaration rather than an import. Three reasons:
 *
 *  1. Layering. That module is a quality-gate diagnostics helper; this one must
 *     be importable from a hot path. Importing it would drag the diagnostics
 *     layer (and its redaction-pattern table) into every consumer for one regex.
 *  2. Different populations. There the input is a captured env SNAPSHOT inside a
 *     JSON bundle and the effect is "replace the value in place"; here the input
 *     is the live `process.env` of the host and the effect is "search for this
 *     value in unrelated text". The second is far more destructive when it
 *     over-matches, so the two are free to diverge — and SHOULD be.
 *  3. Recorded prior art: consolidating a primitive does not consolidate what
 *     its call sites feed it (learnings-index, conf 0.9). A shared regex here
 *     would create exactly that illusion of a single decision point.
 *
 * Deliberate widenings over the mirrored shape:
 *  - a bare name (`TOKEN`, `PASSWORD`, `SECRET`, `API_KEY`-less `KEY`, `DSN`)
 *    qualifies; the diagnostics form requires at least one character before the
 *    suffix.
 *  - the key is upper-cased before testing, so lowercase env keys
 *    (`github_token`) qualify too. `npm_config_*` keys are unaffected — none of
 *    them end in a secret-bearing suffix.
 *  - `_DSN` is a secret-bearing suffix (#1799 point 1): a database DSN carries
 *    its password inline, and before this widening a DSN leak stayed silent in
 *    the SEC-008 detector and unmasked in the vault. The bare `DSN` follows the
 *    same rule as every other suffix: each suffix has its bare form.
 *  - a key ending `_URL` / `_URI` qualifies ONLY when its VALUE carries a
 *    password in the userinfo or in a query parameter (`CREDENTIAL_URL_RE`,
 *    `QUERY_PASSWORD_URL_RE` below). This is the one
 *    value-dependent branch of filter 2: the key name alone cannot tell
 *    `DATABASE_URL=postgres://u:p@h/db` from `API_BASE_URL=https://h/v1`, and
 *    masking the second shreds every log line that names the endpoint.
 *
 * Measurement behind both (2026-10-25, one developer host, the process env of a
 * dispatched wave agent, names and counts only): 2 keys on the measured host
 * newly qualify via `_DSN`; 0 keys end in `_URL`/`_URI` at all, with or without
 * credentials. The URL
 * branch therefore adds no needle on that host today; it closes the
 * `DATABASE_URL` form other hosts and CI images carry, and the strict value
 * test is what keeps a credential-free URL out (over-masking stays the risk the
 * header names).
 */
const SECRET_KEY_RE =
  /^(?:[A-Z][A-Z0-9_]*(?:_TOKEN|_KEY|_SECRET|_PASSWORD|_DSN|_CREDENTIAL[A-Z_]*)|TOKEN|KEY|SECRET|PASSWORD|DSN)$/;

/** Key names whose value may be a URL; they qualify only via `CREDENTIAL_URL_RE` / `QUERY_PASSWORD_URL_RE`. */
const URL_KEY_RE = /^[A-Z][A-Z0-9_]*_UR[LI]$/;

/**
 * The scheme part of a credential URL: an optional `jdbc:` prefix (JDBC URLs
 * wrap the real scheme, `jdbc:mysql://…`), then one RFC 3986 scheme and `://`.
 * Kept to the one known wrapper rather than any `word:` chain: the strict form
 * is linear by construction and admits no `a:b:c://` shape nobody emits.
 */
const URL_SCHEME_SRC = String.raw`^(?:jdbc:)?[A-Za-z][A-Za-z0-9+.-]*:\/\/`;

/**
 * A URL whose userinfo carries a NON-EMPTY password: `scheme://user:password@`.
 * No whitespace, `/` or `@` inside user or password, and no `:` inside the user,
 * so `https://host/a@b` (an `@` in the path) and `ssh://git@host` (`user@` only)
 * never match. The user may be empty (`redis://:password@host`), because the
 * password, not the user, is the credential.
 *
 * NAMED CEILING (BV-004): the needle stays the WHOLE value. A leak that prints
 * only the password part of the URL (or the URL with the password elided or
 * re-encoded) is not caught. Neither is a password holding an UNENCODED `/`
 * (`postgres://u:ab/cd1234@h`): admitting `/` in the password makes every
 * `host:port/path@x` URL read as userinfo, the over-masking this filter exists
 * to prevent. Revisit trigger: a SEC-008 incident in either form.
 */
const CREDENTIAL_URL_RE = new RegExp(String.raw`${URL_SCHEME_SRC}[^\s/@:]*:[^\s/@]+@`);

/**
 * A URL whose QUERY carries a non-empty password parameter (`password=`,
 * `pwd=`, `pass=`, any case): `https://h/db?user=u&password=…`. The parameter
 * must open the query or follow an `&`, so `?nopass=x` does not match, and its
 * value must be non-empty. Linear: the path run stops at the first `?`, and the
 * one backtracking run tries a constant-length keyword at each `&`.
 */
const QUERY_PASSWORD_URL_RE = new RegExp(
  String.raw`${URL_SCHEME_SRC}[^\s?#]*\?(?:[^\s#]*&)?(?:password|pwd|pass)=[^\s&#]`,
  'i',
);

/**
 * Filter 3 — minimum value length.
 *
 * NAMED CEILING (this is a deliberate simplification, per the repo's
 * build-value rule): 8 is a DEGENERATE-VALUE guard, not a discriminator. It
 * exists so that a secret-named key carrying a trivial value (`X_KEY=1`,
 * `MY_TOKEN=abc`) cannot turn into a needle that shreds every line of the log.
 * It is explicitly NOT tuned to separate secrets from non-secrets — the header
 * shows that no such threshold exists on the measured host.
 *
 * REVISIT TRIGGER: if a consumer reports over-masking, the answer is an
 * allowlist entry or a narrower key-name heuristic — NOT a higher threshold.
 * Raising it past 32 starts discarding real secrets; every value below 58 still
 * admits PWD. Any patch that moves this number is treating a measurement as a
 * dial.
 */
const MIN_MASKABLE_LENGTH = 8;

/**
 * Decide whether a single env entry qualifies as a masking needle.
 *
 * The three filters run in the order documented in the module header:
 * allowlist → key-name heuristic → length.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {boolean}
 */
function qualifiesAsNeedle(key, value) {
  if (typeof key !== 'string' || typeof value !== 'string') return false;
  if (NEVER_MASK_KEYS.has(key)) return false; // 1 — allowlist
  const upper = key.toUpperCase();
  const named =
    SECRET_KEY_RE.test(upper) ||
    (URL_KEY_RE.test(upper) &&
      (CREDENTIAL_URL_RE.test(value) || QUERY_PASSWORD_URL_RE.test(value)));
  if (!named) return false; // 2 — key-name heuristic (URL keys: value must carry a password)
  if (value.length < MIN_MASKABLE_LENGTH) return false; // 3 — degenerate-value guard
  return true;
}

/**
 * The qualifying `[key, value]` entries of an env-like object — the SAME
 * allowlist → key-name → length selection `createSecretValueMasker` builds its
 * needles from, exposed for consumers that must attribute a hit to its KEY
 * (`scripts/lib/secret-output-detector.mjs`, #1786) without a second copy of
 * the filters. Additive export: the masker's own return contract is unchanged.
 *
 * The returned array CARRIES VALUES. Callers may compare against them; they
 * must never print, log, persist or return them.
 *
 * @param {Record<string, unknown>} env — a non-object yields `[]`.
 * @returns {Array<[string, string]>}
 */
export function secretNeedleEntries(env) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  if (env && typeof env === 'object') {
    for (const [key, value] of Object.entries(env)) {
      if (qualifiesAsNeedle(key, value)) entries.push([key, /** @type {string} */ (value)]);
    }
  }
  return entries;
}

/**
 * Build a value-based secret masker from an env-like object.
 *
 * Matching is LITERAL and CASE-SENSITIVE, with no word boundaries — two
 * deliberate departures from the confidential-names patterns that
 * `redactSpans` was extracted for:
 *   - No `\b`: a secret is not a word. Tokens routinely abut quotes, `=`, `:`
 *     and newlines, and many end in `-` or `_`, where `\b` simply fails to
 *     anchor. A boundary condition here would silently skip real hits.
 *   - Case-sensitive: secrets are case-sensitive by construction, and folding
 *     case only widens the collision surface for free.
 * Every value is regex-escaped before it becomes a pattern, so a secret
 * containing `.`, `(`, `[` or `*` matches itself and nothing else.
 * (`RegExp.escape` is stdlib from Node 23.5; this package requires `>=24.0.0`.)
 *
 * Returns an OBJECT rather than a bare function so the needle count is
 * available to callers without a function-property trick: a consumer can log
 * "masking active, N needles" (a count is safe to print; a value never is) and
 * can branch on `needleCount === 0` for a fast path. The masking function
 * itself is `mask`.
 *
 * @param {Record<string, unknown>} env — e.g. `process.env`. A non-object
 *   yields a masker with zero needles (identity) rather than throwing: a hot
 *   path must not die on a malformed argument, and there is genuinely nothing
 *   to mask in that case.
 * @returns {{ mask: (text: string) => string, needleCount: number }}
 */
export function createSecretValueMasker(env) {
  /** @type {Set<string>} deduped — two keys sharing a value need one pattern. */
  const values = new Set(secretNeedleEntries(env).map(([, value]) => value));

  const patterns = [...values].map((v) => new RegExp(RegExp.escape(v)));

  /**
   * Replace every needle occurrence in `text` with `[REDACTED]`.
   *
   * Delegates the overlap-safe interval merge to `redactSpans`, so a needle
   * that is a prefix of another needle yields ONE marker, not a nested pair —
   * no splice logic is re-derived here.
   *
   * @param {string} text
   * @returns {string}
   */
  const mask = (text) => {
    if (patterns.length === 0 || typeof text !== 'string') return text;
    return redactSpans(text, patterns);
  };

  return { mask, needleCount: patterns.length };
}
