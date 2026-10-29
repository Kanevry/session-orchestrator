/**
 * contract.mjs — shared shapes of the close-time Security-Delta (#1769, stage 1).
 *
 * Every check module under `scripts/lib/security-delta/` returns one
 * CheckResult built by `makeCheckResult()`, whose findings are built by
 * `makeFinding()`. The runner folds the CheckResults into one Result via
 * `summarize()`, `deriveStatus()` and `deriveVerdict()`. Nothing here does
 * I/O: the checks own their reads, the runner owns budget and telemetry.
 *
 * Status vs verdict are two axes on purpose:
 *   - status  says how completely the delta was MEASURED. A degraded check
 *     makes the whole run `degraded`, never `clean` — a partial measurement
 *     that reads as clean is the failure this field exists to prevent.
 *   - verdict says what the close should DO with what was found:
 *     `pass` | `warn` | `block`. Only findings the range INTRODUCED move it;
 *     pre-existing ones stay listed in the checks and totals but pass. Only
 *     mode `strict` can produce `block`, and only for an introduced blocking
 *     finding (see `isBlockingFinding`).
 *
 * Mode vocabulary is `off | warn | strict` — `strict` is the repo's canonical
 * word for "blocks" (#217); the issue's `block` was not adopted as a mode.
 */

/** Check ids, in the order the runner reports them. */
export const CHECK_IDS = Object.freeze([
  'lockfile',
  'runtime-floor',
  'floating-tag',
  'gitleaks',
  'age-gate',
  'package-floor',
]);

/**
 * Per-check measurement status.
 * `ok`             — measured completely.
 * `degraded`       — measured partly (timeout, network error, capped lookups);
 *                    `unchecked` > 0 names what was not measured.
 * `skipped`        — nothing to measure (no relevant change, binary absent, mode off).
 * `not-measurable` — the input exists but carries no measurable value (`lts/*`).
 */
export const CHECK_STATUS = Object.freeze(['ok', 'degraded', 'skipped', 'not-measurable']);

/** Severity, most severe first. OSV `MODERATE` maps to `medium`. */
export const SEVERITY = Object.freeze(['critical', 'high', 'medium', 'low', 'unknown']);

/**
 * Finding classes. `malicious` = OSV `MAL-*` record; `package-floor` = a package
 * below its security-floor register floor, or on a bad line (#1769 stage 3).
 */
export const FINDING_CLASS = Object.freeze([
  'vuln',
  'malicious',
  'runtime-floor',
  'floating-tag',
  'secret',
  'age-gate-missing',
  'package-floor',
]);

/** Session Config `security-delta.mode` values. */
export const MODES = Object.freeze(['off', 'warn', 'strict']);

/** Run status values (`Result.status`). Never `ok`: see the module header. */
export const RUN_STATUS = Object.freeze(['clean', 'findings', 'degraded', 'skipped']);

/** Verdict values (`Result.verdict`). */
export const VERDICTS = Object.freeze(['pass', 'warn', 'block']);

/** Budget for the whole run; the network share is a sub-budget of the total. */
export const BUDGET = Object.freeze({ totalMs: 3000, networkMs: 2000 });

/** Telemetry event name. Its payload carries counts only (events may be POSTed to a webhook). */
export const SECURITY_DELTA_EVENT = 'orchestrator.security.delta';

/** CLI exit code for a `block` verdict (0 = pass/warn/degraded, 1 = usage error). */
export const EXIT_BLOCK = 3;

/** Public ecosystems a finding can name; `null` for findings without a package (secrets). */
export const ECOSYSTEMS = Object.freeze(['npm', 'PyPI', 'node', 'image']);

class ContractError extends TypeError {
  constructor(message) {
    super(`security-delta contract: ${message}`);
    this.name = 'ContractError';
  }
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new ContractError(`${field} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
  }
  return value;
}

function nonNegativeInt(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ContractError(`${field} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function stringOrNull(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ContractError(`${field} must be a non-empty string or null, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Stable dedupe key of a finding: `secdelta:<class>:<subject>`.
 * The subject is the package name, or the file for findings without a package.
 *
 * @param {string} cls      one of FINDING_CLASS
 * @param {string} subject  package name or repo-relative file
 * @returns {string}
 */
export function makeFingerprint(cls, subject) {
  oneOf(cls, FINDING_CLASS, 'class');
  if (typeof subject !== 'string' || subject.length === 0) {
    throw new ContractError(`fingerprint subject must be a non-empty string, got ${JSON.stringify(subject)}`);
  }
  return `secdelta:${cls}:${subject}`;
}

/**
 * Rank of a severity: 0 = critical … 4 = unknown. Unknown input ranks as `unknown`.
 * @param {string} severity
 * @returns {number}
 */
export function severityRank(severity) {
  const i = SEVERITY.indexOf(severity);
  return i === -1 ? SEVERITY.length - 1 : i;
}

/**
 * Map an OSV / GHSA severity word (`database_specific.severity`) to SEVERITY.
 * `MODERATE` → `medium`; anything unrecognised → `unknown`.
 * @param {unknown} word
 * @returns {string}
 */
export function normalizeOsvSeverity(word) {
  if (typeof word !== 'string') return 'unknown';
  const w = word.trim().toLowerCase();
  if (w === 'moderate') return 'medium';
  return SEVERITY.includes(w) ? w : 'unknown';
}

/**
 * Build one finding. Throws ContractError on a value outside the contract —
 * a check that cannot classify a finding must say so, never invent a class.
 *
 * @param {object} f
 * @param {string} f.class            one of FINDING_CLASS
 * @param {string} f.severity         one of SEVERITY
 * @param {string|null} [f.ecosystem] one of ECOSYSTEMS or null
 * @param {string|null} [f.package]   package / runtime / image name; null for secrets
 * @param {string|null} [f.version]   the version found in the head tree
 * @param {string|null} [f.fixedIn]   first fixed version, null if none is known
 * @param {string[]} [f.ids]          OSV ids (GHSA-…, CVE-…, MAL-…); [] otherwise
 * @param {string|null} [f.file]      repo-relative file the finding was read from
 * @param {boolean} f.introduced      true = new or changed in base..head
 * @returns {{class:string,severity:string,ecosystem:string|null,package:string|null,version:string|null,fixedIn:string|null,ids:string[],file:string|null,introduced:boolean,fingerprint:string}}
 */
export function makeFinding(f) {
  if (!f || typeof f !== 'object') throw new ContractError('finding must be an object');
  const cls = oneOf(f.class, FINDING_CLASS, 'class');
  const severity = oneOf(f.severity, SEVERITY, 'severity');
  const ecosystem = f.ecosystem === undefined || f.ecosystem === null ? null : oneOf(f.ecosystem, ECOSYSTEMS, 'ecosystem');
  const pkg = stringOrNull(f.package, 'package');
  const file = stringOrNull(f.file, 'file');
  if (typeof f.introduced !== 'boolean') throw new ContractError('introduced must be a boolean');
  const ids = f.ids === undefined ? [] : f.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new ContractError('ids must be an array of non-empty strings');
  }
  const subject = pkg ?? file;
  if (subject === null) throw new ContractError('a finding needs a package or a file');
  return {
    class: cls,
    severity,
    ecosystem,
    package: pkg,
    version: stringOrNull(f.version, 'version'),
    fixedIn: stringOrNull(f.fixedIn, 'fixedIn'),
    ids: [...ids],
    file,
    introduced: f.introduced,
    fingerprint: makeFingerprint(cls, subject),
  };
}

/**
 * Build one check result.
 *
 * @param {object} r
 * @param {string} r.id               one of CHECK_IDS
 * @param {string} r.status           one of CHECK_STATUS
 * @param {string|null} [r.reason]    short machine reason (`binary-absent`, `timeout`, `lts-alias`, …)
 * @param {number} [r.checked]        items measured
 * @param {number} [r.unchecked]      items that should have been measured but were not
 * @param {object[]} [r.findings]     built by makeFinding()
 * @param {number} [r.ms]             own wall time in ms
 * @returns {{id:string,status:string,reason:string|null,checked:number,unchecked:number,findings:object[],ms:number}}
 */
export function makeCheckResult(r) {
  if (!r || typeof r !== 'object') throw new ContractError('check result must be an object');
  const id = oneOf(r.id, CHECK_IDS, 'id');
  const status = oneOf(r.status, CHECK_STATUS, 'status');
  const checked = nonNegativeInt(r.checked ?? 0, 'checked');
  const unchecked = nonNegativeInt(r.unchecked ?? 0, 'unchecked');
  const findings = r.findings ?? [];
  if (!Array.isArray(findings)) throw new ContractError('findings must be an array');
  // A partial measurement must say so: unchecked items with status ok would read as complete.
  if (status === 'ok' && unchecked > 0) {
    throw new ContractError(`status ok with unchecked=${unchecked} — use degraded`);
  }
  const ms = r.ms ?? 0;
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) throw new ContractError('ms must be a non-negative number');
  return { id, status, reason: stringOrNull(r.reason, 'reason'), checked, unchecked, findings: [...findings], ms };
}

/**
 * Whether a finding may block the close under mode `strict`: an INTRODUCED
 * malicious package, an INTRODUCED critical vulnerability with a known fix, or
 * an INTRODUCED critical package-floor miss with a known floor (`fixedIn`).
 * A bad-line package-floor finding (`fixedIn: null`) never blocks: there is no
 * same-line version to move to. Pre-existing findings and secrets never block
 * (stage 1; gitleaks already blocks at pre-commit).
 *
 * @param {ReturnType<typeof makeFinding>} finding
 * @returns {boolean}
 */
export function isBlockingFinding(finding) {
  if (!finding || finding.introduced !== true) return false;
  if (finding.class === 'malicious') return true;
  return (
    (finding.class === 'vuln' || finding.class === 'package-floor') &&
    finding.severity === 'critical' &&
    typeof finding.fixedIn === 'string'
  );
}

/**
 * Overall measurement status of a run.
 * `skipped` when no check measured anything (every check skipped/not-measurable),
 * else `degraded` when any check degraded (wins over findings: the run is
 * incomplete), else `findings` when any finding exists, else `clean`.
 *
 * @param {ReturnType<typeof makeCheckResult>[]} checks
 * @returns {string} one of RUN_STATUS
 */
export function deriveStatus(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return 'skipped';
  if (checks.every((c) => c.status === 'skipped' || c.status === 'not-measurable')) return 'skipped';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return checks.some((c) => c.findings.length > 0) ? 'findings' : 'clean';
}

/**
 * What the close does with the result. Only `introduced: true` findings count:
 * a pre-existing finding stays in `checks[].findings` and `summarize()`, but
 * alone it gives `pass` — the delta judges what the session changed, and a
 * warning on every close in every repo with an old pin is noise (HR-101).
 * mode off → pass. Any blocking finding → block under strict, warn under warn.
 * Any other introduced finding → warn. A degraded run without introduced
 * findings → pass (fail-open; the status field carries the gap).
 *
 * @param {string} mode  one of MODES
 * @param {ReturnType<typeof makeCheckResult>[]} checks
 * @returns {string} one of VERDICTS
 */
export function deriveVerdict(mode, checks) {
  oneOf(mode, MODES, 'mode');
  if (mode === 'off') return 'pass';
  const findings = (checks ?? []).flatMap((c) => c.findings).filter((f) => f.introduced === true);
  if (findings.some(isBlockingFinding)) return mode === 'strict' ? 'block' : 'warn';
  return findings.length > 0 ? 'warn' : 'pass';
}

/**
 * Counts across all checks — the only finding data the telemetry event carries.
 *
 * @param {ReturnType<typeof makeCheckResult>[]} checks
 * @returns {{findings:number,introduced:number,blocking:number,bySeverity:Record<string,number>,byClass:Record<string,number>,checked:number,unchecked:number}}
 */
export function summarize(checks) {
  const bySeverity = Object.fromEntries(SEVERITY.map((s) => [s, 0]));
  const byClass = Object.fromEntries(FINDING_CLASS.map((c) => [c, 0]));
  let findings = 0;
  let introduced = 0;
  let blocking = 0;
  let checked = 0;
  let unchecked = 0;
  for (const c of checks ?? []) {
    checked += c.checked;
    unchecked += c.unchecked;
    for (const f of c.findings) {
      findings += 1;
      if (f.introduced) introduced += 1;
      if (isBlockingFinding(f)) blocking += 1;
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
      byClass[f.class] = (byClass[f.class] ?? 0) + 1;
    }
  }
  return { findings, introduced, blocking, bySeverity, byClass, checked, unchecked };
}
