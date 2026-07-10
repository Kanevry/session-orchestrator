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
 * Contract:
 *   loadConfidentialNames({ namesPath, deps? }) → string[] | null
 *
 *   - `namesPath` empty/whitespace/non-string → null (no list configured; SILENT —
 *     this is the default for the ~99% of hosts without a list).
 *   - file missing / unreadable / malformed-JSON / non-array → null + one stderr WARN.
 *   - Each entry is validated: it must be a non-empty string within a length cap
 *     (MAX_NAME_LENGTH — a ReDoS/DoS guard against a manipulated host-local file;
 *     a real customer/repo name never exceeds it). Entries failing either check
 *     are dropped with an aggregate COUNT-ONLY WARN (the offending names are NOT
 *     logged — logging them would defeat the confidentiality guarantee).
 *   - Result is CACHED per process, keyed by namesPath (the scanner reads it once).
 *
 * Privacy: this module never writes the list anywhere; it only reads the operator's
 * host-local file. WARN messages carry the file PATH (the operator's own config
 * path, shown transiently on their terminal) but NEVER the confidential names.
 */

import { readFileSync, existsSync } from 'node:fs';

/**
 * Max characters for a single confidential name. A real customer / repo name is
 * always far shorter; a longer entry in the host-local file is a corruption or a
 * DoS payload (an oversized string fed into a regex constructor is a ReDoS/DoS
 * vector). Over-long entries are dropped with a count-only WARN.
 */
const MAX_NAME_LENGTH = 256;

/** Per-process cache: namesPath → (string[] | null). */
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
 * Returns null when the body is malformed or yields zero usable entries.
 *
 * @param {string} raw
 * @param {string} namesPath
 * @param {{ warn: (msg: string) => void }} d
 * @returns {string[]|null}
 */
function parseNames(raw, namesPath, d) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Fix 3 (security-reviewer): NEVER embed err.message — V8's JSON.parse error
    // text echoes the first ~10 chars of the file body, which for a confidential-
    // names file is a would-be confidential-name prefix. Log only the error CLASS
    // (err.name, e.g. SyntaxError) + the path. Keeps the module-docstring invariant
    // ("WARN messages … NEVER the confidential names") true.
    d.warn(
      `WARN validate/confidential-names: malformed JSON in ${namesPath} (${err.name}); CP11 inactive\n`,
    );
    return null;
  }

  if (!Array.isArray(parsed)) {
    d.warn(
      `WARN validate/confidential-names: ${namesPath} must be a JSON array of strings; ignoring the list (CP11 inactive)\n`,
    );
    return null;
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
      `WARN validate/confidential-names: ignored ${ignoredInvalid} invalid and ${ignoredOversized} oversized (>${MAX_NAME_LENGTH} chars) name entr(ies) in ${namesPath}\n`,
    );
  }

  return names.length > 0 ? names : null;
}

/**
 * Load and validate the host-local confidential-names list. Defensive — never throws.
 *
 * @param {object} opts
 * @param {string|null|undefined} opts.namesPath - absolute path to the names JSON, or
 *   empty/absent when no list is configured.
 * @param {Partial<typeof DEFAULT_DEPS>} [opts.deps] - injected fs / warn (tests).
 * @returns {string[]|null} the validated names, or null when unconfigured/unusable.
 */
export function loadConfidentialNames({ namesPath, deps = {} } = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };

  // Unconfigured → no list, no noise. This is the normal case for public repos
  // and for any host that has not opted into confidential-name scanning.
  if (typeof namesPath !== 'string' || namesPath.trim() === '') {
    return null;
  }

  if (_cache.has(namesPath)) {
    return _cache.get(namesPath);
  }

  let result = null; // default when the file is missing/unreadable/unusable
  try {
    if (!d.existsSync(namesPath)) {
      d.warn(
        `WARN validate/confidential-names: confidential-names-file is set but the file does not exist: ${namesPath}; CP11 inactive\n`,
      );
    } else {
      const raw = d.readFileSync(namesPath, 'utf8');
      result = parseNames(raw, namesPath, d);
    }
  } catch (err) {
    // Fix 3 (security-reviewer): log the error CLASS, not err.message. A filesystem
    // error rarely embeds file content, but keeping the invariant uniform ("the WARN
    // carries only counts / err-class + the path, never file body") removes the last
    // err.message sink in this module.
    d.warn(
      `WARN validate/confidential-names: failed to read confidential-names file at ${namesPath} (${err.name}); CP11 inactive\n`,
    );
  }

  _cache.set(namesPath, result);
  return result;
}
