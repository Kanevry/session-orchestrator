#!/usr/bin/env node
/**
 * check-owner-leakage.mjs — Scan tracked files for owner-privacy leakage patterns.
 *
 * Implements the #462 audit trail durable CI guard (#471).
 * Canonicalization-before-matching refactor (issue #661): the historical
 * form-by-form treadmill (a fresh regex per encoding — P1 bare-no-slash #631,
 * P9 dash-encoded #634, …) is replaced by a single CANONICALIZATION step.
 * `canonicalizeLine()` collapses every known textual encoding of a path
 * (URL-percent, dash-as-separator, backslash, double-slash, `\uXXXX`/`%uXXXX`
 * escapes, HTML/numeric entities, unicode homoglyph slashes/dashes, case)
 * into ONE canonical slash-form, and the owner-secret patterns are matched
 * ONCE against that canonical form (plus the raw line, for belt-and-braces).
 * A novel encoding of the same path normalizes to the same canonical string,
 * so it is caught structurally — no new regex required. Err toward
 * over-matching: this is a security guard, a false-positive is cheap, a
 * false-negative ships a leak to the public mirror.
 *
 * Usage: check-owner-leakage.mjs <plugin-root>
 *
 * Forbidden patterns (canonical rules CP1–CP10):
 *   CP1  personal home path `/Users/bernhardg…` — matched on the CANONICAL form,
 *        so the slash-form (P1, #631), the dash-encoded projects-dir form
 *        (legacy P9, #634), URL-percent-encoded, backslash, and any future
 *        separator-encoding all collapse to one rule.
 *   CP2  private GitLab host `gitlab.gotzendorfer.at`
 *   CP3  private events domain `events.gotzendorfer.at`
 *   CP4  private package scope `@goetzendorfer/…`
 *   CP5  DEFAULT_GITLAB_HOST on line with 'gotzendorfer' OR as exported const
 *   CP6  private project slugs (see PRIVATE_SLUGS constant below). Two scopes:
 *        the tracked-file scan (runScan) uses the FULL 7-slug PRIVATE_SLUGS list;
 *        the in-process vault-namespace guard (isOwnerLeakySegment) uses the
 *        narrower CP6_INPROCESS_PATTERNS — PRIVATE_SLUGS minus VAULT_CLEAR_SLUGS,
 *        leaving only 2 retained slugs. See the VAULT_CLEAR_SLUGS carve-out
 *        (issue #59 owner decision 2026-07-18).
 *   CP7  catch-all `gotzendorfer.at` not matching an allowlisted exclusion
 *   CP8  full RFC1918 private dotted-quad (10.x.x.x / 192.168.x.x / 172.16-31.x.x)
 *        — internal IP leak. Placeholder `.x` forms and CIDR/range notation are NOT
 *        matched (only literal 4-octet IPs), so SSRF-range docs stay clean.
 *   CP10 `~/Projects/<PersonalName>/` — personal-name segment in a Projects path
 *        (name-denylist driven; see PERSONAL_NAMES constant below; issue #653)
 *   CP11 host-local confidential customer/repo names — matched from a NEVER-COMMITTED
 *        list referenced by owner.yaml `paths.confidential-names-file`
 *        (env SO_CONFIDENTIAL_NAMES_FILE; issue #728a). UNIQUE among CP-rules: a CP11
 *        violation REDACTS the matched name span from its reported lineContent, because
 *        this scanner runs in a PUBLIC GitHub-Actions mirror — printing the confidential
 *        name verbatim to the public CI log would be a worse leak than the one guarded.
 *
 * CP11 is INACTIVE unless a host-local names file is configured (the ~99% default),
 * so public CI and unconfigured hosts see no behaviour change.
 *
 * Legacy P-numbering note: P1+P9 are now ONE canonical rule (CP1). The FAIL
 * label still names the offending class for the audit trail.
 *
 * Exclusions (line-scoped, never whole-file):
 *   1. Lines with office@gotzendorfer.at or security@gotzendorfer.at
 *      and no other gotzendorfer.at token
 *   2. https://gotzendorfer.at[...] URLs in README.md and the 3 manifest files
 *   3. Manifest author/email/url/websiteURL/privacyPolicyURL/termsOfServiceURL keys
 *      in .claude-plugin/plugin.json, .claude-plugin/marketplace.json, .codex-plugin/plugin.json
 *      (covered by exclusions 1 + 2 above; listed explicitly for audit trail)
 *   4. .orchestrator/audits/** — never scanned (excluded in file enumeration)
 *   5. tests/lib/events-default-url.test.mjs — ONLY the exact JSDoc contract line:
 *      " *   - No literal `events.gotzendorfer.at` URL appears anywhere in scripts/ or hooks/."
 *      (a real string-literal events.gotzendorfer.at elsewhere in that file still FAILs)
 *   6. tests/scripts/export-hw-learnings.test.mjs — exempt from P8 ONLY: the RFC1918
 *      IPs there are the redaction subject of the anonymizeString suite, not leaks.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one failure (or usage error / unreadable root)
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, relative, basename, sep, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
// NOTE: the two host-local helper modules (../config/host-paths.mjs and
// ./confidential-names.mjs) are imported DYNAMICALLY inside
// getConfidentialNamePatterns(), NOT statically here. This scanner is a
// documented standalone single-file vendoring target (security.md § Owner-Privacy:
// "Reuse the same scanner") — the .husky/pre-commit E2E and any consumer that
// copies ONLY this file into a fresh tree would otherwise crash at module load
// with ERR_MODULE_NOT_FOUND, blocking clean commits. Dynamic import lets CP11 go
// silently inert when the helpers are absent while CP1–CP10 run unchanged.

// ---------------------------------------------------------------------------
// CLI / import-mode detection (#661)
// ---------------------------------------------------------------------------
//
// This module is BOTH a CLI script (run by validate-plugin + .husky/pre-commit)
// AND an importable library (the canonicalization helpers are unit-tested in
// isolation). When imported, the top-level scan + process.exit() must NOT run.
// `isMain` is true only when this file is the node entry point.
const isMain = argv[1] !== undefined && resolve(argv[1]) === fileURLToPath(import.meta.url);

// CLI: single positional arg required (only enforced when run directly).
const pluginRoot = argv[2];
if (isMain && !pluginRoot) {
  console.error('Usage: check-owner-leakage.mjs <plugin-root>');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Private slugs constant — #462 audit trail (list is CLOSED: add only after audit review)
// ---------------------------------------------------------------------------
const PRIVATE_SLUGS = [
  'launchpad-ai-factory',
  'Codex-Hackathon',
  'buchhaltgenie',
  'AngebotsChecker',
  'wien-forschungsfragen-klima',
  'aiat-pmo-module',
  'mail-assistant',
];

// ---------------------------------------------------------------------------
// VAULT_CLEAR_SLUGS carve-out (issue #59, owner decision 2026-07-18)
// ---------------------------------------------------------------------------
//
// Slugs that must STILL be blocked from leaking into TRACKED public-mirror files
// (so they remain in PRIVATE_SLUGS / CP6_PATTERNS, which runScan uses) but are
// CLEARED for use as an IN-PROCESS vault-namespace segment — the vault is a
// host-local, gitignored corpus, so collapsing these to the shared 'redacted-repo'
// bucket needlessly de-isolates per-repo notes without any public-leak benefit.
// isOwnerLeakySegment iterates the narrower CP6_INPROCESS_PATTERNS (PRIVATE_SLUGS
// minus these), so a carved-out slug resolves to its own namespace while the
// tracked-file scanner is UNCHANGED. Comparison is case-insensitive: values are
// lowercased here and every CP6_INPROCESS_PATTERNS filter lowercases before
// membership test.
export const VAULT_CLEAR_SLUGS = new Set([
  'buchhaltgenie',
  'mail-assistant',
  'wien-forschungsfragen-klima',
  'launchpad-ai-factory',
  'angebotschecker',
]);

// ---------------------------------------------------------------------------
// Canonicalization (issue #661)
// ---------------------------------------------------------------------------
//
// The historical evasion class (`encoded-path-forms-evade-slash-form-scanners`,
// #95) is structural: the SAME personal path is re-spelled with a different
// SEPARATOR or escape so a slash-anchored regex misses it. Rather than add a
// fresh regex per encoding, we DECODE every known encoding back to a single
// canonical slash-form ONCE, then match path patterns against that form.
//
// Decodings applied, in order (each is idempotent / safe to over-apply):
//   1. URL-percent escapes  (%2F → /, %2E → ., %2D → -, %5C → \, %20 → space …)
//   2. `\uXXXX` / `%uXXXX` JS/JSON unicode escapes for /, ., -, \
//   3. HTML numeric + named entities for /, ., - (&#47; &#x2F; &sol; …)
//   4. Unicode homoglyph separators → ASCII (fullwidth / division slash → '/',
//      various dashes/hyphens → '-')
//   5. Backslash → forward slash, and any run of separators collapsed
//   6. Dash-as-separator → slash (Claude Code projects-dir encoding, #634)
//
// After decoding, ALL of `/Users/bernhardg.`, `-Users-bernhardg--`,
// `%2FUsers%2Fbernhardg`, `\Users\bernhardg`, `／Users／bernhardg`, and a
// novel future spelling collapse to a canonical `/Users/bernhardg…` string the
// CP1 rule matches. CASE IS PRESERVED through every decode step so the
// `/Users` (capital-U) case-sensitivity contract and the uppercase-username
// near-miss guard both survive. Over-matching is intentional (security guard).

/** Unicode homoglyph / variant SLASH code points that should canonicalize to '/'. */
const HOMOGLYPH_SLASHES = /[⁄∕／⧸╱]/g; // ⁄ ∕ ／ ⧸ ╱
/** Unicode homoglyph / variant DASH code points that should canonicalize to '-'. */
const HOMOGLYPH_DASHES =
  /[‐‑‒–—―−﹘﹣－]/g; // ‐ ‑ ‒ – — ― − ﹘ ﹣ －

/**
 * Zero-width / format / invisible code points that a leak can splice INTO the
 * username (`/Users/bern<U+200B>hardg`) to evade a contiguous-literal match.
 * Stripped from the canonical form before matching (Finding 3). Over-stripping
 * is safe for a security guard — these glyphs never legitimately appear inside a
 * filesystem path segment. Code points (escaped to keep the source ASCII-clean
 * and lint-quiet): tab U+0009, soft-hyphen U+00AD, ZWSP U+200B, ZWNJ U+200C,
 * ZWJ U+200D, word-joiner U+2060, BOM/ZWNBSP U+FEFF. Built from an explicit
 * code-point list via a non-character-class alternation so the combining ZWJ
 * does not trip no-misleading-character-class.
 */
const ZERO_WIDTH_FORMAT = new RegExp(
  '(?:' +
    ['\\u0009', '\\u00ad', '\\u200b', '\\u200c', '\\u200d', '\\u2060', '\\ufeff'].join('|') +
    ')',
  'gu',
);

/**
 * Decode the printable-ASCII range of a hex code point, or null when out of
 * range. Used by the percent / unicode-escape decoders so the LETTERS of
 * `Users`/`bernhardg` (e.g. `%55` → `U`, `%62` → `b`) are decoded, not only the
 * separators (Finding 4). Over-decoding into the full printable-ASCII range is
 * intentional and safe for a security guard. CASE IS PRESERVED because the hex
 * value itself encodes the case (`%55`→`U`, `%75`→`u`).
 * @param {number} cp
 * @returns {string|null}
 */
function printableAsciiFromCodePoint(cp) {
  return cp >= 0x20 && cp <= 0x7e ? String.fromCharCode(cp) : null;
}

/**
 * Decode URL-percent escapes back to their ASCII characters, WITHOUT touching
 * unrelated literal `%`s (decodeURIComponent would throw on a stray `%`). The
 * decode targets the WHOLE printable-ASCII range — both separators (`%2F` → /)
 * AND the alphanumerics of `Users`/`bernhardg` (`%55` → U, #Finding 4) — and the
 * `%uXXXX` JS/JSON-style percent-unicode escape. Double-encoding (`%252F`) is
 * handled by the fixpoint loop in canonicalizeLine (a single decode pass turns
 * `%252F` → `%2F`; the next pass turns `%2F` → `/`). Only the small set of
 * always-relevant separators is hard-coded; everything else in printable-ASCII
 * is decoded generically.
 * @param {string} s
 * @returns {string}
 */
function decodePercent(s) {
  // `%uXXXX` (JS/JSON-style percent-unicode) — BMP code point in printable ASCII.
  let out = s.replace(/%u([0-9a-fA-F]{4})/g, (_m, hex) => {
    const cp = parseInt(hex, 16);
    const ch = printableAsciiFromCodePoint(cp);
    return ch === null ? _m : ch;
  });
  // `%XX` — any printable-ASCII byte (separators AND letters/digits).
  out = out.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => {
    const cp = parseInt(hex, 16);
    const ch = printableAsciiFromCodePoint(cp);
    return ch === null ? _m : ch;
  });
  return out;
}

/**
 * Decode JS/JSON `\uXXXX` escapes back to their ASCII characters — separators
 * AND the alphanumerics of `Users`/`bernhardg` (Finding 4). Out-of-range code
 * points are left intact.
 * @param {string} s
 * @returns {string}
 */
function decodeUnicodeEscapes(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex) => {
    const cp = parseInt(hex, 16);
    const ch = printableAsciiFromCodePoint(cp);
    return ch === null ? _m : ch;
  });
}

/**
 * Decode HTML named + numeric character references. Named entities cover the
 * path separators; numeric entities (`&#85;`, `&#x55;`) decode the WHOLE
 * printable-ASCII range so the LETTERS of `Users`/`bernhardg` are decoded, not
 * only the separators (Finding 4). Out-of-range code points are left intact.
 * @param {string} s
 * @returns {string}
 */
function decodeHtmlEntities(s) {
  return s
    .replace(/&sol;/gi, '/')
    .replace(/&period;/gi, '.')
    .replace(/&(?:dash|hyphen);/gi, '-')
    // numeric hex entity — any printable-ASCII code point
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const ch = printableAsciiFromCodePoint(parseInt(hex, 16));
      return ch === null ? _m : ch;
    })
    // numeric decimal entity — any printable-ASCII code point
    .replace(/&#(\d+);/g, (_m, dec) => {
      const ch = printableAsciiFromCodePoint(parseInt(dec, 10));
      return ch === null ? _m : ch;
    });
}

/**
 * Canonicalize one line of text into a single slash-form string suitable for
 * separator-agnostic path matching. CASE IS PRESERVED — the owner-path rule
 * (CP1) is anchored on the case-sensitive `/Users/bernhardg` literal, so a
 * deliberately-lowercased `/users/...` source literal and an uppercase-letter
 * username near-miss (`/Users/bernhardgXfoo`) both stay distinguishable after
 * canonicalization. Only SEPARATORS / escapes are normalized, never letter case.
 * Public for unit-testing the decode steps.
 * @param {string} line
 * @returns {string} canonical form (case preserved)
 */
export function canonicalizeLine(line) {
  let s = String(line);
  // 0. strip zero-width / format / invisible chars (and tab) spliced into a
  //    path segment to break a contiguous-literal match (Finding 3). Done first
  //    AND inside the fixpoint loop so a glyph wedged between two ENCODED chars
  //    (e.g. `%2<U+200B>F`) also vanishes once its neighbours decode.
  s = s.replace(ZERO_WIDTH_FORMAT, '');
  // 1–3. decode every textual encoding to a FIXPOINT (Finding 5). A single pass
  //    only peels one encoding layer; a nested encoding (one decoder's output
  //    feeding another — `%252F` → `%2F` → `/`, or an entity whose decoded form
  //    is itself a percent-escape) needs the loop. The decoders are monotone
  //    (each only ever shrinks/normalizes), so the loop converges; the bound is
  //    a safety valve against any pathological non-converging input.
  for (let i = 0; i < 12; i++) {
    const before = s;
    // strip format chars exposed by the previous round's decoding
    s = s.replace(ZERO_WIDTH_FORMAT, '');
    // percent escapes (separators AND letters, plus %uXXXX)
    s = decodePercent(s);
    // JS/JSON unicode escapes
    s = decodeUnicodeEscapes(s);
    // HTML entities (named + numeric, separators AND letters)
    s = decodeHtmlEntities(s);
    if (s === before) break; // fixpoint reached
  }
  // 4. unicode homoglyph separators → ASCII
  s = s.replace(HOMOGLYPH_SLASHES, '/').replace(HOMOGLYPH_DASHES, '-');
  // 5. backslash → forward slash
  s = s.replace(/\\/g, '/');
  // 6. dash-as-separator → slash. The Claude Code projects-dir encoding maps
  //    BOTH '/' and '.' to '-', so a leading/embedded dash run reconstructs the
  //    original separators. Converting every '-' run to '/' is over-broad but
  //    safe for matching: CP1 anchors on `/Users/bernhardg` which only appears
  //    when the real path is present. Collapse runs of '-'.
  s = s.replace(/-+/g, '/');
  // collapse repeated slashes produced by the decodings
  s = s.replace(/\/{2,}/g, '/');
  return s;
}

// ---------------------------------------------------------------------------
// Forbidden patterns (matched against canonical and/or raw form)
// ---------------------------------------------------------------------------

/**
 * CP1: personal home path — matched on the CANONICAL (lowercased, slash-form)
 * line. Because canonicalization collapses the slash-form (#631), the
 * dash-encoded projects-dir form (#634), percent/unicode/backslash/homoglyph
 * spellings into one string, a SINGLE rule replaces the old P1+P9 pair and
 * catches future encodings structurally.
 *
 * Mirrors the ORIGINAL P1 regex EXACTLY, applied to the canonical (separator-
 * normalized, case-PRESERVED) form: `/Users/bernhardg` + `[a-z.]*` (lowercase-
 * letter / dot continuation — catches the full-username form
 * `/Users/bernhardgoetzendorfer/`) + a trailing slash OR a word boundary.
 *
 * Because canonicalization is case-preserving, this single rule simultaneously:
 *   - is case-SENSITIVE on the host segment (`/Users`, not `/users`) — a
 *     deliberately-lowercased `/users/bernhardg.` literal does NOT match;
 *   - keeps the #631 fix (bare `/Users/bernhardg.` at EOL matches via `\b`);
 *   - keeps the old false-positive profile (the `[a-z.]*`-then-boundary stops
 *     at an uppercase / digit / underscore continuation):
 *       `/Users/bernhardgXfoo`  → `X` (uppercase) stops `[a-z.]*`, `g`→`X` no `\b` → reject
 *       `/Users/bernhardg9`     → `9` word-char, no `\b` after `g`               → reject
 *       `/Users/bernhardg_home` → `_` word-char, no `\b` after `g`              → reject
 *       `/Users/bernhardo`      → diverges before `g`                           → reject
 *       `/Users/bernhardgoetzendorfer/` → `[a-z.]*` eats `oetzendorfer`, `/`     → MATCH
 *
 * The win over the old P1+P9 pair: every ENCODED separator form (dash #634,
 * percent, backslash, homoglyph, html-entity, unicode-escape, and any future
 * spelling) collapses to `/Users/bernhardg…` in the canonical string, so ONE
 * rule catches them all instead of a fresh regex per encoding.
 *
 * Finding 1 (HIGH): the USERNAME segment is matched CASE-INSENSITIVELY via an
 * explicit per-letter token (`[bB][eE]…[gG]`) — not the `/i` flag, which would
 * also loosen the host anchor, and not an inline `(?i:…)` group, which Node 20
 * does not reliably support. On case-insensitive APFS, `/Users/Bernhardg.` is a
 * real path identifying the operator, so a capitalized username must still be
 * caught. Two case contracts are DELIBERATELY kept narrow:
 *   - the HOST segment stays case-SENSITIVE (`\/Users\/`, capital-U literal) so a
 *     lowercased `/users/bernhardg/x` source literal does NOT match;
 *   - the CONTINUATION class stays lowercase-only (`[a-z.]*`) so an UPPERCASE
 *     letter continuing the segment marks a DIFFERENT user and stops the match:
 *       `/Users/bernhardgXfoo` → `[a-z.]*` matches 0 chars, `g`→`X` (both word
 *       chars) gives no `\b` → reject (continuation-boundary survives).
 */
const CP1_CANON = /\/Users\/[bB][eE][rR][nN][hH][aA][rR][dD][gG][a-z.]*(\/|\b)/;

/**
 * Self-documentation guard: a line that QUOTES the scanner's own pattern regex
 * (e.g. CHANGELOG / migration-doc prose `…added P9 /-Users-bernhardg[a-z.]*-/…`)
 * contains the username token but is NOT a path — a real macOS home path never
 * embeds a regex character-class `[…]` immediately after the username.
 * This is the same self-reference class that SELF_EXCLUSIONS handles for the
 * scanner's source + test files; here it is line-scoped so a REAL leak elsewhere
 * in the same doc still fails. Without it, the #661 canonical rule (which is now
 * as strict on the dash-form as P1 always was on the slash-form) would newly
 * flag the pre-existing CHANGELOG entries that document the legacy P1/P9 regexes.
 *
 * NOTE: tested against the CANONICAL form, where the dash-run normalization has
 * already turned the regex range `[a-z` into `[a/z`. We therefore anchor on the
 * literal `[` right after `bernhardg` (`bernhardg\[`), which uniquely marks a
 * quoted character-class and never appears in a real path segment. Username is
 * matched case-insensitively to mirror the case-insensitive CP1 username token.
 *
 * Finding 2 (MED): the guard now BLANKS only the matched regex-quote TOKEN
 * (replacing the `bernhardg` username with a sentinel) rather than suppressing
 * the WHOLE line. A real leak that merely SHARES a line with a quoted regex
 * (`Real: /Users/bernhardg/Projects/secret (see regex /Users/bernhardg[a-z.]*)`)
 * is still caught: only the `…bernhardg[` token is neutralized, the real
 * `/Users/bernhardg/…` path on the same line survives the residue re-scan.
 * The `Users.bernhardg\[` anchor (with `.` matching the canonicalized slash)
 * leaves the real-path form `Users/bernhardg/` — username followed by a SLASH,
 * not a `[` — untouched.
 */
const SCANNER_REGEX_QUOTE_BLANK_G = /(Users.)[bB][eE][rR][nN][hH][aA][rR][dD][gG](\[)/g;

/** CP2: private GitLab host */
const CP2 = /\bgitlab\.gotzendorfer\.at\b/;

/** CP3: private events domain */
const CP3 = /\bevents\.gotzendorfer\.at\b/;

/** CP4: private package scope */
const CP4 = /@goetzendorfer\/[A-Za-z0-9*_-]+/;

/** CP5: DEFAULT_GITLAB_HOST on a line with 'gotzendorfer' OR as an exported const */
const CP5_WITH_GOTZ = /DEFAULT_GITLAB_HOST/;
const CP5_EXPORT = /\bexport\b.*\bconst\b.*\bDEFAULT_GITLAB_HOST\b/;

/**
 * CP6 (tracked-file scan): private project slugs (word-boundary anchored,
 * case-insensitive — #483 W4-Q6 caught "Buchhaltgenie" capitalized).
 * The FULL 7-slug list — runScan uses this so the public-mirror guard is UNCHANGED.
 */
const CP6_PATTERNS = PRIVATE_SLUGS.map((slug) => new RegExp(`\\b${escapeRegex(slug)}\\b`, 'i'));

/**
 * CP6 (in-process vault-namespace guard): PRIVATE_SLUGS minus VAULT_CLEAR_SLUGS
 * (issue #59 owner decision 2026-07-18). isOwnerLeakySegment iterates THIS list,
 * so carved-out slugs resolve to their own vault namespace instead of collapsing
 * to 'redacted-repo', while the tracked-file scanner (CP6_PATTERNS) still blocks
 * all 7 from leaking into the public mirror. Effectively only the 2 retained
 * slugs (Codex-Hackathon, aiat-pmo-module). Case-insensitive: filter lowercases
 * before the VAULT_CLEAR_SLUGS membership test, matching the 'i'-flag regex.
 */
const CP6_INPROCESS_PATTERNS = PRIVATE_SLUGS
  .filter((slug) => !VAULT_CLEAR_SLUGS.has(slug.toLowerCase()))
  .map((slug) => new RegExp(`\\b${escapeRegex(slug)}\\b`, 'i'));

/** CP7: catch-all gotzendorfer.at (must not match allowlist) */
const CP7 = /gotzendorfer\.at/;

/**
 * CP8: full RFC1918 private dotted-quad — internal-IP leak.
 * Matches only literal 4-octet private IPs (10.x.x.x, 192.168.x.x, 172.16-31.x.x).
 * Deliberately does NOT match placeholder `.x` forms (10.x, 192.168.x) or CIDR/range
 * notation used in SSRF-range documentation, nor TEST-NET (192.0.2.x, RFC 5737).
 */
const CP8 = /(?:\b10(?:\.\d{1,3}){3}|\b192\.168(?:\.\d{1,3}){2}|\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})/;

/** CP8 allowlist: files where RFC1918 IPs are a legitimate test subject (IP-redaction fixtures). */
const CP8_ALLOWLIST = new Set(['tests/scripts/export-hw-learnings.test.mjs']);

/**
 * Match an owner personal-home-path leak in a line, using canonicalization.
 * Returns the offending class label, or null when clean.
 *
 * Strategy: canonicalize separators/escapes (case preserved), then run the
 * single CP1 rule once. Because canonicalization collapses every known
 * encoding of `/Users/bernhardg…` to one string while preserving letter case,
 * this ONE structural rule replaces the P1-bare-slash + P9-dash regex
 * treadmill AND catches future encodings (percent / backslash / homoglyph /
 * html-entity / unicode-escape / dash) without a new regex per form.
 * @param {string} line
 * @returns {string|null}
 */
export function matchOwnerPath(line) {
  const canon = canonicalizeLine(line);
  // Self-documentation guard (line-scoped, Finding 2): BLANK only the quoted
  // regex TOKEN (`…bernhardg[`) — replacing the username with a sentinel — then
  // re-scan the RESIDUE. This neutralizes prose that quotes the scanner's own
  // pattern (`…bernhardg[a-z.]*…` — not a path) WITHOUT suppressing a real leak
  // that happens to share the line. Tested against the CANONICAL form because
  // the documented regex source spells separators with `\/` (escaped slash)
  // which only normalizes to `/` after canonicalization. See
  // SCANNER_REGEX_QUOTE_BLANK_G.
  const residue = canon.replace(SCANNER_REGEX_QUOTE_BLANK_G, '$1__REGEXQUOTE__$2');
  if (CP1_CANON.test(residue)) return 'CP1 (personal home path — canonicalized)';
  return null;
}

/** CP10: personal-name owner segment in a ~/Projects/<Name>/ path (#653).
 *  Name-denylist driven (CLOSED list, audit-reviewed) — mirrors PRIVATE_SLUGS (CP6).
 *  A generic ~/Projects/[A-Z][a-z]+/ would false-positive on legit capitalized
 *  project dirs (~/Projects/MyApp/), so we match only known personal names.
 *
 *  Matches the tilde form (`~/Projects/Bernhard`) OR an absolute home form
 *  (`/Users/<user>/Projects/Bernhard`, `/home/<user>/Projects/Bernhard`), then a
 *  trailing-slash OR word boundary. The slash-OR-word-boundary alternation is the
 *  Finding-1 fix for the original `…/<Name>/` form, which REQUIRED a slash after the
 *  name and so let a bare `~/Projects/Bernhard` (end-of-line, before `&&`) pass
 *  undetected — the same blindspot CP1 was patched for (see CP1 doc above). The
 *  absolute-home alternation is the Finding-3 defense-in-depth: a leak in a
 *  non-owner home (`/Users/alice/Projects/Bernhard/vault`) slipped both CP1 and the
 *  old tilde-only CP10. The trailing word boundary keeps the false-positive profile
 *  tight: `~/Projects/Bernhardt/` (denylisted name + a continuation letter) does
 *  NOT match, so names that merely START with a denylisted name are not flagged. */
const PERSONAL_NAMES = ['Bernhard'];
const CP10_PATTERNS = PERSONAL_NAMES.map(
  (name) => new RegExp(`(?:~|/Users/[^/]+|/home/[^/]+)/Projects/${escapeRegex(name)}(\\/|\\b)`),
);

/** CP10 allowlist: files where ~/Projects/Bernhard is a deliberate test subject
 *  (migration/drift fixtures) or a legitimate one-shot-migration source/target. */
const CP10_ALLOWLIST = new Set([
  'tests/scripts/vault-consolidate.test.mjs',
  'tests/scripts/migrate-vault-paths.test.mjs',
  'tests/lib/migrate-vault-paths-pure.test.mjs',
  'tests/lib/cli-flags.test.mjs',
  'tests/lib/config/vault-integration.test.mjs',
  'tests/skills/claude-md-drift-check/checker.test.mjs',
  'scripts/migrate-vault-paths.mjs',
  'scripts/vault-consolidate.mjs',
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Redact every confidential-name span from `line`, ORDER-INDEPENDENTLY (Fix 1 + Fix 2).
 *
 * This is the single redaction sink for the confidential-names privacy invariant.
 * It is applied at the print choke-point over EVERY violation's lineContent — not
 * only CP11 hits — because this scanner runs in a PUBLIC GitHub-Actions mirror: a
 * confidential customer/repo name that co-occurs with a CP1–CP10 hit on the same
 * line (e.g. a name beside an RFC1918 IP that fails CP8) would otherwise be echoed
 * verbatim to the public CI log (Fix 1).
 *
 * ORDER-INDEPENDENCE (Fix 2): a naïve chain of `.replace()` calls is order-dependent
 * — when one configured name is a PREFIX of another (`['acme','acme-corp-secret']`),
 * redacting the shorter first destroys the longer's match and leaks a suffix residue
 * (`[REDACTED]-corp-secret`). Instead we compute ALL match spans against the ORIGINAL
 * (unmutated) string across every pattern, merge overlapping/adjacent intervals, and
 * splice `[REDACTED]` per merged interval. No pattern ever sees a string another
 * pattern already rewrote, so prefix/suffix overlap cannot leak regardless of list
 * order.
 *
 * @param {string} line — the raw (already-trimmed) violation lineContent.
 * @param {RegExp[]} patterns — confidential-name regexes (word-boundary, case-insensitive).
 * @returns {string} the line with every configured name span replaced by [REDACTED].
 */
function redactSpans(line, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return line;

  // 1. Collect [start, end) spans of every match of every pattern against the
  //    ORIGINAL line (never a partially-mutated one). Global clone so exec() walks
  //    all matches; zero-width guard prevents an infinite loop on a degenerate regex.
  const spans = [];
  for (const re of patterns) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = g.exec(line)) !== null) {
      if (m[0].length === 0) {
        g.lastIndex += 1;
        continue;
      }
      spans.push([m.index, m.index + m[0].length]);
    }
  }
  if (spans.length === 0) return line;

  // 2. Merge overlapping / adjacent intervals (sorted by start).
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) {
      last[1] = Math.max(last[1], e);
    } else {
      merged.push([s, e]);
    }
  }

  // 3. Splice [REDACTED] per merged interval, left-to-right over the ORIGINAL line.
  let out = '';
  let cursor = 0;
  for (const [s, e] of merged) {
    out += line.slice(cursor, s) + '[REDACTED]';
    cursor = e;
  }
  out += line.slice(cursor);
  return out;
}

/**
 * CP11: build word-boundary, case-insensitive regexes from the host-local
 * confidential-names list (#728a). Mirrors CP6_PATTERNS (private slugs), but the
 * name source is LOADED from a never-committed host-local file instead of a
 * closed in-source array — the confidential customer/repo names must never live
 * in a committed file.
 *
 * LAZY BY CONTRACT: this reads the host-local file (owner.yaml + env), so it MUST
 * be called only from runScan() — NOT at module top-level. This module is
 * dual-mode (CLI entry point AND importable library, `isMain` guard); a top-level
 * fs read would fire on every library import (e.g. pseudonym-map.mjs importing
 * isOwnerLeakySegment). loadConfidentialNames caches per path, so calling this
 * once per scan reads the file at most once.
 *
 * STANDALONE-SAFE: the two host-local helper modules are DYNAMICALLY imported
 * here (not statically at the top of the file) so a single-file copy of this
 * scanner — the documented vendoring pattern (security.md § Owner-Privacy: "Reuse
 * the same scanner"; exercised by tests/husky/pre-commit-owner-leakage.test.mjs,
 * which copies ONLY this file into a tmp repo) — does not crash at module load
 * with ERR_MODULE_NOT_FOUND. When the helpers are unresolvable (or throw), CP11
 * degrades to inert ([] patterns) and CP1–CP10 run unchanged.
 *
 * @returns {Promise<RegExp[]>} one regex per configured name, or [] when
 *   unconfigured / unusable / unresolvable (standalone copy).
 */
async function getConfidentialNamePatterns() {
  try {
    const { loadHostPaths, resolveHostPath } = await import('../config/host-paths.mjs');
    const { loadConfidentialNames } = await import('./confidential-names.mjs');
    const ctx = loadHostPaths();
    const namesPath = resolveHostPath('confidential-names-file', '', ctx);
    const names = loadConfidentialNames({ namesPath });
    if (!names) return [];
    return names.map((name) => new RegExp(`\\b${escapeRegex(name)}\\b`, 'i'));
  } catch {
    // Helper modules absent (standalone single-file vendoring) or a config read
    // failure — CP11 goes silently inert; the CP1–CP10 rules need none of these
    // modules and continue to enforce the scan.
    return [];
  }
}

// ---------------------------------------------------------------------------
// Text-scan extension allowlist (spec A.2)
// ---------------------------------------------------------------------------
const TEXT_EXTS = new Set(['.md', '.mjs', '.js', '.ts', '.json', '.yml', '.yaml', '.sh', '.txt']);

// Dotfiles to include (checked by basename, BEFORE the extension gate —
// extname('.env.example') is '.example' (truthy), so an extension-first check
// would make that allowlist entry unreachable; W3-P3 finding, 2026-06-10)
const DOTFILE_ALLOWLIST = new Set(['.env.example', '.nvmrc', '.vault.yaml']);

function isTextFile(filePath) {
  const base = basename(filePath);
  if (DOTFILE_ALLOWLIST.has(base)) return true;
  const ext = extname(filePath);
  return ext ? TEXT_EXTS.has(ext) : false;
}

// ---------------------------------------------------------------------------
// File enumeration: git ls-files primary, recursive fs walk fallback (spec A.2)
// Exclusions: .git/, node_modules/, .orchestrator/audits/
// ---------------------------------------------------------------------------

function getTrackedFiles() {
  try {
    const output = execFileSync('git', ['ls-files'], { cwd: pluginRoot, encoding: 'utf8' });
    return output
      .split('\n')
      .filter(Boolean)
      .map((f) => join(pluginRoot, f));
  } catch {
    // git unavailable or not a git repo — fall back to recursive fs walk
    return walkDir(pluginRoot);
  }
}

function walkDir(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    // Exclusions: .git, node_modules, .orchestrator/audits
    if (entry === '.git' || entry === 'node_modules') continue;
    const rel = relative(pluginRoot, full);
    if (rel === join('.orchestrator', 'audits') || rel.startsWith(join('.orchestrator', 'audits') + sep)) continue;
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      walkDir(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Allowlist helpers (spec A.4)
// ---------------------------------------------------------------------------

/**
 * Return true if this gotzendorfer.at hit is covered by the exclusion allowlist.
 * @param {string} relPath - path relative to pluginRoot (forward slashes)
 * @param {string} line    - the raw line content
 * @returns {boolean}
 */
function isAllowlisted(relPath, line) {
  // Normalize to forward-slash for matching
  const norm = relPath.replace(/\\/g, '/');

  // A.4 exclusion 5: tests/lib/events-default-url.test.mjs — ONLY the exact JSDoc contract line
  if (norm === 'tests/lib/events-default-url.test.mjs') {
    // The exact doc-comment line: " *   - No literal `events.gotzendorfer.at` URL..."
    // Match the literal backtick-quoted pattern in a JSDoc/comment line
    if (/^\s+\*\s+- No literal `events\.gotzendorfer\.at`/.test(line)) {
      return true;
    }
    // Any other gotzendorfer.at in this file is NOT excluded
    return false;
  }

  // A.4 exclusion 1: lines with office@ or security@ gotzendorfer.at and NO other gotzendorfer.at token
  // (i.e., the only gotzendorfer.at occurrence is an email address — count occurrences)
  const SANCTIONED_EMAILS = /(?:office|security)@gotzendorfer\.at/g;
  const allGotzTokens = [...line.matchAll(/gotzendorfer\.at/g)];
  const sanctionedMatches = [...line.matchAll(SANCTIONED_EMAILS)];
  if (allGotzTokens.length > 0 && allGotzTokens.length === sanctionedMatches.length) {
    // All gotzendorfer.at occurrences are the sanctioned email addresses
    return true;
  }

  // A.4 exclusion 2 + 3: https://gotzendorfer.at URLs in README.md and the 3 manifest files
  const ALLOWLISTED_URL_PATHS = new Set([
    'README.md',
    '.claude-plugin/plugin.json',
    '.claude-plugin/marketplace.json',
    '.codex-plugin/plugin.json',
  ]);
  const inAllowlistedFile = ALLOWLISTED_URL_PATHS.has(norm);

  if (inAllowlistedFile) {
    // Check that the only gotzendorfer.at occurrences on this line are sanctioned URLs or emails
    const SANCTIONED_URL = /https?:\/\/gotzendorfer\.at\b/g;
    const allGotzOnLine = [...line.matchAll(/gotzendorfer\.at/g)];
    const sanctionedUrlMatches = [...line.matchAll(SANCTIONED_URL)];
    const emailMatches = [...line.matchAll(SANCTIONED_EMAILS)];
    const totalSanctioned = sanctionedUrlMatches.length + emailMatches.length;
    if (allGotzOnLine.length > 0 && allGotzOnLine.length === totalSanctioned) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

// ---------------------------------------------------------------------------
// Main check — only runs when invoked as the CLI entry point (#661). When this
// module is imported (for unit-testing the canonicalization helpers), the scan
// and process.exit() below are skipped.
// ---------------------------------------------------------------------------

async function runScan() {
console.log('--- Check 11: owner-privacy leakage ---');

if (!existsSync(pluginRoot)) {
  fail(`plugin root does not exist: ${pluginRoot}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const allFiles = getTrackedFiles();
const textFiles = allFiles.filter(isTextFile);

// Exclusions:
//   - .orchestrator/audits/** never scanned (A.2/A.4-5)
//   - This guard's own source file (pattern-doc-comments define the scanner — not leaks).
//   - This guard's own test file (string-literal fixtures exercise the detector — not leaks).
//   - Persona content-lint tests (assert template files don't contain leakage strings;
//     the assertion literals themselves match the scanner regex — fixtures, not leaks).
// Self-exclusions are the design-time fix for the latent bug exposed when scanner
// fixture files transition from untracked → tracked in the same commit that tightens
// detection (commit a68e94f for the original two; commit 95c8237 deep-3 W4 added the
// case-insensitive P6 regex + introduced content-lint.test.mjs in the same commit,
// producing a pre-commit false-pass — see pipeline #4365 / housekeeping-2 2026-05-19).
const SELF_EXCLUSIONS = new Set([
  'scripts/lib/validate/check-owner-leakage.mjs',
  'tests/lib/validate/check-owner-leakage.test.mjs',
  'tests/templates/personas/content-lint.test.mjs',
  'tests/husky/pre-commit-owner-leakage.test.mjs',
  // #634: encoding-contract fixtures (`-Users-bernhardg-` expected-value literals
  // are load-bearing for the resolveMemoryDir() assertions; P9 would self-flag them)
  'tests/lib/memory-paths.test.mjs',
  // #660: owner-leakage redaction-test fixtures — namespace.test.mjs feeds the real
  // CP1/CP6/CP10 leak literals into resolveRepoNamespace to prove they redact to
  // 'redacted-repo'; the assertion literals are fixtures, not leaks (same class as
  // check-owner-leakage.test.mjs above).
  'tests/lib/vault-mirror/namespace.test.mjs',
  // #700: vault-relocation classifier redaction-test fixtures — both files feed the
  // real CP6 private slugs (BuchhaltGenie / aiat-pmo-module) into the classifier to
  // prove they redact to 'redacted-repo'; assertion literals are fixtures, not leaks
  // (same class as namespace.test.mjs above).
  'tests/lib/vault-relocation-rules.test.mjs',
  'tests/scripts/relocate-vault-corpus.test.mjs',
]);
const scanFiles = textFiles.filter((f) => {
  const rel = relative(pluginRoot, f).replace(/\\/g, '/');
  if (rel.startsWith('.orchestrator/audits/')) return false;
  if (SELF_EXCLUSIONS.has(rel)) return false;
  return true;
});

// CP11 (#728a): load the host-local confidential-names patterns ONCE per scan.
// [] when unconfigured (the default) OR when the host-local helper modules are
// unresolvable (standalone single-file copy) → the CP11 block below is a no-op.
// Awaited once, before the per-line loop, because the helpers are now dynamically
// imported (standalone-safe) — CP1–CP10 behaviour is unchanged.
const cp11Patterns = await getConfidentialNamePatterns();

/** @type {Array<{relPath: string, lineNum: number, pattern: string, lineContent: string}>} */
const violations = [];

for (const filePath of scanFiles) {
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    continue; // unreadable — skip
  }

  const relPath = relative(pluginRoot, filePath).replace(/\\/g, '/');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // CP1: personal home path — CANONICALIZED match (#661). One structural rule
    // replaces the slash-form (P1, #631) + dash-encoded (P9, #634) treadmill and
    // catches percent/unicode/backslash/homoglyph encodings of the same path.
    const ownerPathHit = matchOwnerPath(line);
    if (ownerPathHit) {
      violations.push({ relPath, lineNum, pattern: ownerPathHit, lineContent: line.trim() });
    }

    // CP2: private GitLab host
    if (CP2.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'CP2 (gitlab.gotzendorfer.at)', lineContent: line.trim() });
    }

    // CP3: private events domain — check exclusion 6 first
    if (CP3.test(line)) {
      if (!isAllowlisted(relPath, line)) {
        violations.push({ relPath, lineNum, pattern: 'CP3 (events.gotzendorfer.at)', lineContent: line.trim() });
      }
    }

    // CP4: private package scope
    if (CP4.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'CP4 (@goetzendorfer/ scope)', lineContent: line.trim() });
    }

    // CP5: DEFAULT_GITLAB_HOST with gotzendorfer OR as exported const
    if (CP5_WITH_GOTZ.test(line) && /gotzendorfer/.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'CP5 (DEFAULT_GITLAB_HOST on gotzendorfer line)', lineContent: line.trim() });
    } else if (CP5_EXPORT.test(line)) {
      violations.push({ relPath, lineNum, pattern: 'CP5 (DEFAULT_GITLAB_HOST exported const)', lineContent: line.trim() });
    }

    // CP6: private project slugs
    for (let i = 0; i < CP6_PATTERNS.length; i++) {
      if (CP6_PATTERNS[i].test(line)) {
        violations.push({ relPath, lineNum, pattern: `CP6 (private slug: ${PRIVATE_SLUGS[i]})`, lineContent: line.trim() });
        break; // one violation per line per slug is enough
      }
    }

    // CP7: catch-all gotzendorfer.at — check exclusion allowlist
    if (CP7.test(line)) {
      if (!isAllowlisted(relPath, line)) {
        violations.push({ relPath, lineNum, pattern: 'CP7 (gotzendorfer.at catch-all)', lineContent: line.trim() });
      }
    }

    // CP8: full RFC1918 private dotted-quad — internal IP leak (redaction-test fixtures exempt)
    if (CP8.test(line) && !CP8_ALLOWLIST.has(relPath)) {
      violations.push({ relPath, lineNum, pattern: 'CP8 (RFC1918 private IP)', lineContent: line.trim() });
    }

    // CP10: personal-name segment in a ~/Projects/<name>/ path (allowlisted migration fixtures exempt) — #653
    if (!CP10_ALLOWLIST.has(relPath)) {
      for (const re of CP10_PATTERNS) {
        if (re.test(line)) {
          violations.push({ relPath, lineNum, pattern: 'CP10 (~/Projects/<name>/ personal segment)', lineContent: line.trim() });
          break;
        }
      }
    }

    // CP11: host-local confidential customer/repo names (#728a). INACTIVE unless a
    // names file is configured (cp11Patterns is [] by default).
    //
    // DETECTION ONLY here — the confidential-name REDACTION is applied at the print
    // choke-point (redactSpans over EVERY violation's lineContent), so a name that
    // rides in on a CP1–CP10 hit on the same line is scrubbed too (Fix 1), and a
    // name that is a prefix of another configured name cannot leak a suffix residue
    // (Fix 2). cp11Patterns are non-global, so `.test()` is stateless.
    if (cp11Patterns.length > 0 && cp11Patterns.some((re) => re.test(line))) {
      violations.push({ relPath, lineNum, pattern: 'CP11 (confidential name)', lineContent: line.trim() });
    }
  });
}

// Deduplicate: CP7 and CP3 can overlap — de-dup by (relPath, lineNum, pattern)
// But CP3 and CP7 are distinct patterns so they'd produce separate entries.
// However, one line could match both CP3 and CP7 — treat as two violations.
// The spec does not say to deduplicate, so keep as-is.

if (violations.length === 0) {
  pass(`no owner-privacy leakage found across ${scanFiles.length} scanned files`);
} else {
  for (const v of violations) {
    // Choke-point redaction (Fix 1 + Fix 2): scrub every configured confidential
    // name from EVERY violation's lineContent — not only CP11 hits — BEFORE it
    // reaches stdout (the public GitHub-Actions log). redactSpans is order-
    // independent (span-merge, never chained .replace), and is a no-op when no
    // names file is configured (cp11Patterns === []), so the CP1–CP10 default-path
    // output is byte-identical to before. Redact first, THEN truncate, so a name
    // straddling the 120-char boundary can never leak its tail.
    const safeContent = redactSpans(v.lineContent, cp11Patterns);
    fail(`${v.relPath}:${v.lineNum} — ${v.pattern}: ${safeContent.slice(0, 120)}`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Exported helper for in-process leak detection (Issue #660 namespace guard)
// ---------------------------------------------------------------------------

/**
 * Test whether a single value (a repo identifier or sanitised slug segment)
 * matches any owner-privacy leakage pattern.
 *
 * Runs the canonical CP1 check (via canonicalizeLine + CP1_CANON) and the
 * word-boundary CP6 (private project slugs) and CP10 (personal name in a
 * Projects path) checks against the raw value. Returns the matched pattern id
 * string or null when clean.
 *
 * CP6 here uses the NARROWER CP6_INPROCESS_PATTERNS (PRIVATE_SLUGS minus
 * VAULT_CLEAR_SLUGS — issue #59 owner decision 2026-07-18), so carved-out slugs
 * (buchhaltgenie, mail-assistant, wien-forschungsfragen-klima, launchpad-ai-factory,
 * angebotschecker) resolve to their own vault namespace here while the tracked-file
 * scanner (runScan, full CP6_PATTERNS) still blocks them from the public mirror.
 *
 * This is the single source of truth for in-process leak detection — do NOT
 * reimplement these pattern checks outside this module. The `namespace.mjs`
 * resolver uses this to guard vault path segments before any filesystem write.
 *
 * @param {string} value — raw repo identifier or sanitised slug to test.
 * @returns {'CP1'|'CP6'|'CP10'|null}
 */
export function isOwnerLeakySegment(value) {
  if (typeof value !== 'string' || !value) return null;

  // CP1: personal home path — canonicalize then match.
  const ownerPathMatch = matchOwnerPath(value);
  if (ownerPathMatch !== null) return 'CP1';

  // CP1 (bare): the personal-username token standing alone — e.g. the macOS login
  // name surfacing via deriveRepo()'s basename(process.cwd()) fallback when cwd is
  // the home directory. CP1_CANON only fires with a `/Users/` prefix, so the bare
  // segment would otherwise slip through into a committed vault path (#660 Q3-LOW-1).
  if (/^[bB][eE][rR][nN][hH][aA][rR][dD][gG][a-z]*$/.test(value)) return 'CP1';

  // CP6: private project slugs (word-boundary, case-insensitive). In-process
  // guard uses the VAULT_CLEAR_SLUGS-carved list, NOT the full CP6_PATTERNS the
  // tracked-file scanner uses (issue #59).
  for (const re of CP6_INPROCESS_PATTERNS) {
    if (re.test(value)) return 'CP6';
  }

  // CP10: personal name in a ~/Projects/<name>/ path.
  for (const re of CP10_PATTERNS) {
    if (re.test(value)) return 'CP10';
  }

  return null;
}

// Run the scan only when invoked directly as a CLI (#661).
if (isMain) {
  // runScan is async (the CP11 confidential-names helpers are now dynamically
  // imported, standalone-safe) and self-terminates via process.exit(). We do NOT
  // await it — that would make this a top-level-await module and force every static
  // importer of isOwnerLeakySegment to become async. Instead we attach a `.catch`
  // (Fix 4): while runScan's sole async step swallows its own errors today, an
  // unhandled rejection from ANY future refactor must fail CLOSED with context and a
  // deterministic exit 1 — never a silent unhandled-rejection warning + exit 0.
  runScan().catch((err) => {
    console.error('check-owner-leakage crashed:', err);
    process.exit(1);
  });
}
