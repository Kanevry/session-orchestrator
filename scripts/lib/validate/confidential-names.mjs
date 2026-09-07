/**
 * confidential-names.mjs — Host-local confidential customer/repo name list (Issue #728a).
 *
 * The owner-leakage scanner (check-owner-leakage.mjs) guards owner PATHS and a
 * CLOSED, audit-reviewed list of private slugs (CP6). It cannot enumerate the
 * OPEN-ended set of confidential customer / source-repo names the Operator's
 * confidentiality rule (2026-07-02) forbids in GitHub-visible artefacts — those
 * names must never live in a committed file (that would be the very leak they
 * guard against).
 *
 * This module loads a HOST-LOCAL name list, referenced by owner.yaml
 * (`paths.confidential-names-file`, env `SO_CONFIDENTIAL_NAMES_FILE`) OUTSIDE any
 * repo, so the confidential names are never committed; only the PATH mechanism is
 * committed. The scanner's CP11 rule builds word-boundary regexes from the loaded
 * names and REDACTS any match from its output (a CP11 hit printed verbatim to the
 * public CI log would be a WORSE leak than the one being guarded).
 *
 * Contract (#1250 + #1264 — TWO entry points; the discriminated one is ADDITIVE):
 *   loadConfidentialNames({ namesPath, deps? })    → string[] | null   (4.0.0 shape)
 *   inspectConfidentialNames({ namesPath, deps? }) → { status, names } (discriminated)
 *
 *   status ∈ 'ok' | 'empty' | 'all-dropped' | 'missing' | 'malformed' | 'unconfigured'
 *   names  is the validated list for 'ok', and `[]` for every other status.
 *
 *   `loadConfidentialNames` is the 4.0.0 PUBLIC contract and is preserved verbatim
 *   (`string[] | null`, null-collapsing): `package.json` carries no `exports` map,
 *   so a consumer repo can deep-import this module and a PATCH release must not
 *   break it. It is a thin wrapper over `inspectConfidentialNames`, which reports
 *   the class the older shape collapsed into `null` — exactly the distinction
 *   CP11's fail-closed verdict turns on: 'unconfigured' and 'empty' are operator
 *   choices (inactive, PASS), while 'missing', 'malformed' and 'all-dropped' mean
 *   a configured guard could not run (fail closed). The scanner had to re-read and
 *   re-classify the file to recover a class the loader already knew; it no longer does.
 *
 *   - `namesPath` empty/whitespace/non-string → 'unconfigured' (SILENT — this is
 *     the default for the ~99% of hosts without a list).
 *   - file missing → 'missing' + one stderr WARN.
 *   - unreadable / malformed-JSON / non-array → 'malformed' + one stderr WARN.
 *   - readable, well-formed, parsed array of length 0 → 'empty'. The operator
 *     deliberately wrote `[]` to switch CP11 off; that is a silent PASS.
 *   - readable, well-formed, parsed array NON-empty but every entry dropped by
 *     validation → 'all-dropped'. Distinct from 'empty' on purpose: the operator
 *     INTENDED names here, so a guard that ends up with zero patterns must fail
 *     closed rather than pass silently (W4 finding F3).
 *   - Each entry is validated: it must be a non-empty string within a length cap
 *     (MAX_NAME_LENGTH — a ReDoS/DoS guard against a manipulated host-local file;
 *     a real customer/repo name never exceeds it). Entries failing either check
 *     are dropped with an aggregate COUNT-ONLY WARN (the offending names are NOT
 *     logged — logging them would defeat the confidentiality guarantee).
 *   - Result is CACHED per process, keyed by namesPath (the scanner reads it once).
 *
 * Privacy: this module never writes the list anywhere; it only reads the operator's
 * host-local file. WARN messages carry NEITHER the confidential names NOR the file
 * PATH — only `basename(namesPath)` (W4 finding F1). The full path is host-local
 * (`/Users/<name>/…`), and these WARNs fire on exactly the branches the scanner turns
 * into a `FAIL` + exit 1 — output an operator pastes into a PUBLIC CI log, where the
 * path would leak the very shape CP1 exists to block. The scanner's own
 * `disabledReason` strings have always been path-free; the loader now matches them.
 */

import { readFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Max characters for a single confidential name. A real customer / repo name is
 * always far shorter; a longer entry in the host-local file is a corruption or a
 * DoS payload (an oversized string fed into a regex constructor is a ReDoS/DoS
 * vector). Over-long entries are dropped with a count-only WARN.
 */
const MAX_NAME_LENGTH = 256;

/** Per-process cache: namesPath → `{ status, names }` (shared by BOTH entry points). */
const _cache = new Map();

/**
 * Clear the per-process confidential-names cache. Test-only seam — production
 * code never needs to reset (the list file does not change mid-process).
 */
export function _resetConfidentialNamesCache() {
  _cache.clear();
}

/** Default (production) dependency bindings — overridable per call for tests. */
const DEFAULT_DEPS = {
  readFileSync,
  existsSync,
  warn: (msg) => process.stderr.write(msg),
};

/**
 * Parse + validate the raw JSON body into a list of confidential names.
 *
 * Distinguishes THREE zero-name outcomes, because the caller's verdict differs
 * between them: 'malformed' (unparseable or not an array), 'empty' (a parsed array
 * of length 0 — the operator deliberately switched CP11 off) and 'all-dropped'
 * (the operator DID list entries, and validation rejected every one of them).
 *
 * @param {string} raw
 * @param {string} label - basename of the names file, for WARN text (never the path)
 * @param {{ warn: (msg: string) => void }} d
 * @returns {{ status: 'ok'|'empty'|'all-dropped'|'malformed', names: string[] }}
 */
function parseNames(raw, label, d) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Fix 3 (security-reviewer): NEVER embed err.message — V8's JSON.parse error
    // text echoes the first ~10 chars of the file body, which for a confidential-
    // names file is a would-be confidential-name prefix. Log only the error CLASS
    // (err.name, e.g. SyntaxError) + the file BASENAME (never the host-local path,
    // W4 finding F1). Keeps the module-docstring invariant ("WARN messages … NEVER
    // the confidential names") true.
    d.warn(
      `WARN validate/confidential-names: malformed JSON in ${label} (${err.name}); CP11 inactive\n`,
    );
    return { status: 'malformed', names: [] };
  }

  if (!Array.isArray(parsed)) {
    d.warn(
      `WARN validate/confidential-names: ${label} must be a JSON array of strings; ignoring the list (CP11 inactive)\n`,
    );
    return { status: 'malformed', names: [] };
  }

  const names = [];
  let ignoredInvalid = 0;
  let ignoredOversized = 0;

  for (const entry of parsed) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      ignoredInvalid += 1;
      continue;
    }
    // Length cap on the RAW entry (before trim) — a padded oversized payload is
    // still a payload. A real confidential name never approaches this bound.
    if (entry.length > MAX_NAME_LENGTH) {
      ignoredOversized += 1;
      continue;
    }
    names.push(entry.trim());
  }

  if (ignoredInvalid > 0 || ignoredOversized > 0) {
    // Deliberately omit the offending entries — logging them would leak the very
    // confidential names the list exists to keep host-local. COUNTS only.
    d.warn(
      `WARN validate/confidential-names: ignored ${ignoredInvalid} invalid and ${ignoredOversized} oversized (>${MAX_NAME_LENGTH} chars) name entr(ies) in ${label}\n`,
    );
  }

  if (names.length > 0) return { status: 'ok', names };
  // F3 (W4 panel, fail-open): a file whose entries were ALL dropped by validation
  // is NOT the operator's `[]` opt-out — they listed names and meant them to bind.
  // Collapsing both into 'empty' made the scanner treat a corrupted list as a
  // deliberate opt-out and PASS silently with CP11 inactive.
  return parsed.length > 0
    ? { status: 'all-dropped', names: [] }
    : { status: 'empty', names: [] };
}

/**
 * Load and validate the host-local confidential-names list, reporting WHY the list
 * is unusable when it is. Defensive — never throws.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.namesPath - absolute path to the names JSON, or
 *   empty/absent when no list is configured.
 * @param {Partial<typeof DEFAULT_DEPS>} [opts.deps] - injected fs / warn (tests).
 * @returns {{ status: 'ok'|'empty'|'all-dropped'|'missing'|'malformed'|'unconfigured', names: string[] }}
 *   the validated names under `status: 'ok'`; `names` is `[]` for every other status.
 */
export function inspectConfidentialNames({ namesPath, deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };

  // Unconfigured → no list, no noise. This is the normal case for public repos
  // and for any host that has not opted into confidential-name scanning.
  if (typeof namesPath !== 'string' || namesPath.trim() === '') {
    return { status: 'unconfigured', names: [] };
  }

  if (_cache.has(namesPath)) {
    return _cache.get(namesPath);
  }

  // Default when the file is missing; the read/parse branches below overwrite it.
  let result = { status: 'missing', names: [] };
  try {
    if (!d.existsSync(namesPath)) {
      d.warn(
        `WARN validate/confidential-names: confidential-names-file is set but the file does not exist: ${basename(namesPath)}; CP11 inactive\n`,
      );
    } else {
      const raw = d.readFileSync(namesPath, 'utf8');
      result = parseNames(raw, basename(namesPath), d);
    }
  } catch (err) {
    // Fix 3 (security-reviewer): log the error CLASS, not err.message. A filesystem
    // error rarely embeds file content, but keeping the invariant uniform ("the WARN
    // carries only counts / err-class + the file basename, never the path and never
    // file body") removes the last err.message sink in this module.
    d.warn(
      `WARN validate/confidential-names: failed to read confidential-names file ${basename(namesPath)} (${err.name}); CP11 inactive\n`,
    );
    // An unreadable file is NOT 'missing' — existsSync said it is there. It shares
    // the 'malformed' verdict (configured but unusable → the caller fails closed).
    result = { status: 'malformed', names: [] };
  }

  _cache.set(namesPath, result);
  return result;
}

/**
 * The 4.0.0 PUBLIC contract, preserved verbatim: the validated names, or `null`
 * whenever no usable list could be loaded (unconfigured, missing, malformed,
 * empty, all-dropped alike). `package.json` has no `exports` map, so a consumer
 * repo may deep-import this function; a PATCH release must not change its shape.
 *
 * In-tree callers that need to distinguish an operator OPT-OUT from a guard that
 * FAILED TO RUN must use `inspectConfidentialNames` instead — that distinction is
 * precisely what this return type cannot express.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.namesPath
 * @param {Partial<typeof DEFAULT_DEPS>} [opts.deps]
 * @returns {string[] | null}
 */
export function loadConfidentialNames({ namesPath, deps = {} } = {}) {
  // Shares the one cache entry: inspect() keys it, this derives from the result.
  const { names } = inspectConfidentialNames({ namesPath, deps });
  return names.length > 0 ? names : null;
}
