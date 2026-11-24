/**
 * contract.mjs — the shared result shape of the read-only `/security` modes (#2201).
 *
 * Every mode lives in `scripts/lib/security/<mode>.mjs` and exports exactly one
 * entry point:
 *
 *   export async function run({ repoRoot, ref, env, now }) -> Result
 *
 *   - `repoRoot` absolute path of the repository to judge.
 *   - `ref`      a full commit SHA already verified by the CLI
 *                (`git rev-parse --verify <ref>^{commit}`), or `null` when the
 *                operator gave no `--ref`. Each mode picks its own default for
 *                `null` (status reads the working tree; deps/posture judge HEAD).
 *   - `env`      the environment to resolve host-local paths from (never
 *                `process.env` directly, so tests can redirect it).
 *   - `now`      a `Date` for reported times (ages, expiry, timestamps in a
 *                Result). The OSV client's network deadline `deadlineMono`
 *                uses the monotonic `performance.now()` time base.
 *
 * `run()` must not write a file, emit an event or print anything; it returns a
 * Result built with {@link makeResult} and never throws for a read failure
 * (that becomes a check or finding in state `not-measurable`).
 *
 * Three states stay apart everywhere:
 *   - measured                → a check state such as `on`/`pass`/`fail`, or a finding;
 *   - not measurable here     → state `not-measurable` with a mandatory `reason`;
 *   - not judged on purpose   → state `skipped` with a mandatory `reason`.
 *
 * Result `status` (closed set {@link RESULT_STATUSES}):
 *   - `ok`        the mode did its job and found nothing to act on;
 *   - `findings`  the mode did its job and `findings` is non-empty; every check
 *                 in state `fail` must have a matching finding, so a result with a
 *                 `fail` check can never be `ok` (the validator rejects it);
 *   - `degraded`  the mode could not do its job (e.g. nothing at all was readable);
 *                 a single unreadable check does NOT make a result degraded — it
 *                 is counted in `notChecked` instead;
 *   - `skipped`   the mode does not apply here (`reason` mandatory).
 *
 * `notChecked` = number of items (checks, lockfiles, advisories, surfaces) that
 * were in scope but ended `not-measurable`. It is a count, never a list of names.
 *
 * `basis` = what was judged: `null`, or `{ tree: 'working-tree' | 'commit',
 * ref: <full sha> | null, note: string | null }` — e.g. deps on a dirty tree sets
 * `{ tree: 'commit', ref: '<sha>', note: 'uncommitted changes are not included' }`.
 *
 * Zero side effects on import; `node:*`-free on purpose.
 */

/** The modes the CLI dispatches; each maps to `./<mode>.mjs`. */
export const MODES = Object.freeze(['status', 'deps', 'posture', 'agent-setup']);

/** Closed set of `Result.status`. */
export const RESULT_STATUSES = Object.freeze(['ok', 'findings', 'degraded', 'skipped']);

/**
 * Closed set of `Check.state`.
 * status uses on/off/not-wired; posture uses pass/fail; every mode may use
 * not-measurable and skipped (both need a `reason`).
 */
export const CHECK_STATES = Object.freeze(['on', 'off', 'not-wired', 'pass', 'fail', 'not-measurable', 'skipped']);

/** Closed set of `Finding.state`: the finding was measured, or a part of it (e.g. severity) was not. */
export const FINDING_STATES = Object.freeze(['measured', 'not-measurable']);

/** Check and finding states that require a non-empty `reason`. */
export const STATES_NEEDING_REASON = Object.freeze(['not-measurable', 'skipped']);

/**
 * @typedef {object} Check
 * @property {string} id        stable machine id, e.g. `ci-audit-job`
 * @property {string} check     human label, e.g. `CI audit job`
 * @property {string} state     one of {@link CHECK_STATES}
 * @property {string} detail    one human line (no secret values, no cached package names)
 * @property {string|null} [reason] mandatory for `not-measurable` and `skipped`
 * @property {string} [file]    repo-relative path the state was read from
 * @property {string} [fix]     one proposed fix
 * Extra keys are allowed (mode-specific data such as counts).
 */

/**
 * @typedef {object} Finding
 * @property {string} id        stable id (advisory id, rule id, class+key)
 * @property {string} class     open, mode-defined class (`fix-now`, `endpoint-override`, …)
 * @property {string} state     one of {@link FINDING_STATES}
 * @property {string} detail    one human line
 * @property {string|null} [reason] mandatory when state is `not-measurable`
 * @property {string} [file]    repo-relative or real path the finding sits in
 * @property {string} [fix]     one proposed fix (`bump to 1.2.3`, …)
 * Extra keys are allowed (severity, package, lockfile, offers, …).
 */

/**
 * @typedef {object} Result
 * @property {string} mode
 * @property {string} status      one of {@link RESULT_STATUSES}
 * @property {Finding[]} findings
 * @property {number} notChecked  non-negative integer
 * @property {{tree: 'working-tree'|'commit', ref: string|null, note: string|null}|null} basis
 * @property {Check[]} checks
 * @property {string|null} reason  mandatory for `degraded` and `skipped`
 */

/** Typed contract violation — a mode returned or built a malformed Result. */
export class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContractError';
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function itemProblem(item, kind, labelKey, states) {
  if (!isPlainObject(item)) return `${kind} is not an object`;
  if (!isNonEmptyString(item.id)) return `${kind}.id must be a non-empty string`;
  if (!isNonEmptyString(item[labelKey])) return `${kind}.${labelKey} must be a non-empty string`;
  if (!states.includes(item.state)) return `${kind}.state ${JSON.stringify(item.state)} is not ${states.join('|')}`;
  if (typeof item.detail !== 'string') return `${kind}.detail must be a string`;
  if (STATES_NEEDING_REASON.includes(item.state) && !isNonEmptyString(item.reason)) return `${kind} ${item.id}: state ${item.state} needs a reason`;
  for (const key of ['file', 'fix']) {
    if (item[key] !== undefined && item[key] !== null && typeof item[key] !== 'string') return `${kind}.${key} must be a string`;
  }
  return null;
}

function basisProblem(basis) {
  if (basis === null) return null;
  if (!isPlainObject(basis)) return 'basis must be null or an object';
  if (basis.tree !== 'working-tree' && basis.tree !== 'commit') return 'basis.tree must be working-tree|commit';
  if (basis.ref !== null && !isNonEmptyString(basis.ref)) return 'basis.ref must be a string or null';
  if (basis.note !== null && typeof basis.note !== 'string') return 'basis.note must be a string or null';
  return null;
}

/**
 * Why `value` is not a Result, or null when it is one.
 * @param {*} value
 * @returns {string|null}
 */
export function resultProblem(value) {
  if (!isPlainObject(value)) return 'result is not an object';
  if (!isNonEmptyString(value.mode)) return 'mode must be a non-empty string';
  if (!RESULT_STATUSES.includes(value.status)) return `status ${JSON.stringify(value.status)} is not ${RESULT_STATUSES.join('|')}`;
  if ((value.status === 'degraded' || value.status === 'skipped') && !isNonEmptyString(value.reason)) return `status ${value.status} needs a reason`;
  if (value.reason !== null && typeof value.reason !== 'string') return 'reason must be a string or null';
  if (!Number.isInteger(value.notChecked) || value.notChecked < 0) return 'notChecked must be a non-negative integer';
  if (!Array.isArray(value.findings)) return 'findings must be an array';
  if (!Array.isArray(value.checks)) return 'checks must be an array';
  if (value.status === 'findings' && value.findings.length === 0) return 'status findings needs at least one finding';
  if (value.status === 'ok' && value.findings.length > 0) return 'status ok must not carry findings';
  if (value.status === 'ok' && value.checks.some((c) => c?.state === 'fail')) return 'status ok must not carry a fail check (add a finding for it)';
  for (const f of value.findings) {
    const p = itemProblem(f, 'finding', 'class', FINDING_STATES);
    if (p) return p;
  }
  for (const c of value.checks) {
    const p = itemProblem(c, 'check', 'check', CHECK_STATES);
    if (p) return p;
  }
  return basisProblem(value.basis);
}

/**
 * @param {*} value
 * @returns {boolean} true when `value` satisfies the Result contract
 */
export function isResult(value) {
  return resultProblem(value) === null;
}

/**
 * Build and validate a Result. Throws {@link ContractError} on a malformed one.
 * @param {{mode: string, status: string, findings?: Finding[], notChecked?: number,
 *   basis?: Result['basis'], checks?: Check[], reason?: string|null}} fields
 * @returns {Result}
 */
export function makeResult({ mode, status, findings = [], notChecked = 0, basis = null, checks = [], reason = null }) {
  const result = { mode, status, findings, notChecked, basis, checks, reason };
  const problem = resultProblem(result);
  if (problem) throw new ContractError(`security result (${String(mode)}): ${problem}`);
  return result;
}

// Strip C0/C1 controls, line/paragraph separators and bidi controls from any
// rendered string: details can carry text read from repo files. Code points,
// not a regex literal, so no invisible character sits in this source file.
const isControl = (cp) => cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x61c
  || cp === 0x200e || cp === 0x200f || cp === 0x2028 || cp === 0x2029
  || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
const clean = (v) => Array.from(String(v), (ch) => (isControl(ch.codePointAt(0)) ? ' ' : ch)).join('');

/**
 * Human rendering of a Result (the CLI's default output). Pure.
 * Shows only the common fields (check/class, id, state, detail, reason, file,
 * fix); mode-specific extra keys appear in `--json` only, so anything the
 * operator must read (e.g. a second offer such as `exception with date`) goes
 * into `detail` or `fix`.
 * @param {Result} result
 * @returns {string} text ending in a newline
 */
export function renderText(result) {
  const lines = [`security ${clean(result.mode)}: ${clean(result.status)}`];
  if (result.reason) lines.push(`  reason: ${clean(result.reason)}`);
  if (result.basis) {
    const at = result.basis.tree === 'commit' ? `commit ${clean(result.basis.ref ?? '?')}` : 'working tree';
    lines.push(`  judged: ${at}${result.basis.note ? ` (${clean(result.basis.note)})` : ''}`);
  }
  if (result.checks.length > 0) {
    const width = Math.max(...result.checks.map((c) => clean(c.check).length));
    for (const c of result.checks) {
      const why = STATES_NEEDING_REASON.includes(c.state) ? ` (${clean(c.reason)})` : '';
      lines.push(`  ${clean(c.check).padEnd(width)}  ${c.state.padEnd(14)}  ${clean(c.detail)}${why}`);
      if (c.fix) lines.push(`  ${''.padEnd(width)}  fix: ${clean(c.fix)}`);
    }
  }
  for (const f of result.findings) {
    const where = f.file ? ` [${clean(f.file)}]` : '';
    // A not-measurable finding is "could not be read", not a hit: say so in the line.
    const why = f.state === 'not-measurable' ? ` (not measurable: ${clean(f.reason)})` : '';
    lines.push(`  ${clean(f.class)}: ${clean(f.id)}${where} — ${clean(f.detail)}${why}`);
    if (f.fix) lines.push(`    fix: ${clean(f.fix)}`);
  }
  if (result.notChecked > 0) lines.push(`  not measurable here: ${result.notChecked}`);
  return `${lines.join('\n')}\n`;
}
