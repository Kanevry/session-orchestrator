/**
 * fleet-protocol.mjs — Fleet protocol v1: file-based navigator lease + session
 * check-ins under `~/.config/navigator/` (#1462, PRD !53 § 3).
 *
 * The protocol state lives in plain files so every platform (Claude Code, Codex,
 * a headless run) can read and write it without a server:
 *
 *   <navigatorDir>/leases/navigator.json        — the navigator lease
 *   <navigatorDir>/checkin/<session_id>.json    — one check-in per session
 *   <navigatorDir>/auflagen/<session_id>.json   — conditions issued to a session
 *
 * `<navigatorDir>` is `NAVIGATOR_CONFIG_DIR` (trimmed; empty/whitespace counts as
 * unset) or `<home>/.config/navigator`. Files are 0600, directories 0700.
 * Check-in and lease timestamps are UTC with `Z`, in a form per file: the
 * check-in's `zeit` is seconds, `date -u +%FT%TZ` (`YYYY-MM-DDTHH:MM:SSZ`,
 * stamped by the CLI); the lease's `seit` / `laeuft_ab` are seconds or
 * milliseconds (`LEASE_TS_RE`); the auflagen content belongs to the navigator.
 *
 * "A navigator is active" means exactly one thing: a readable, well-formed lease
 * whose `laeuft_ab` lies in the future. Everything else is fail-closed — an
 * expired lease is `none`, a lease that cannot be read or validated is
 * `unreadable`, and neither is ever `active`.
 *
 * Session ids become file names, so {@link isSafeSessionId} is the security
 * boundary between check-in input and the filesystem: every path builder that
 * takes a session id refuses an unsafe one with a TypeError.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Env var that overrides the navigator directory. */
export const NAVIGATOR_CONFIG_DIR_ENV = 'NAVIGATOR_CONFIG_DIR';

/** Minutes a session waits for a navigator before it falls back (PRD !53 § 3). */
export const CHECKIN_FALLBACK_MIN = 10;

const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
const SESSION_ID_MAX = 128;
const UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Lease timestamps: UTC with `Z`, seconds or milliseconds — never a local-time reading. */
const LEASE_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const PLATTFORMEN = ['claude', 'codex', 'kopflos'];
const MODI = ['housekeeping', 'feature', 'deep', 'operations'];

/**
 * Resolve the navigator directory.
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string} absolute path
 */
export function navigatorDir({ env = process.env, home = os.homedir() } = {}) {
  const raw = env[NAVIGATOR_CONFIG_DIR_ENV];
  const override = typeof raw === 'string' ? raw.trim() : '';
  if (override) return path.resolve(override);
  return path.join(home, '.config', 'navigator');
}

/**
 * Path of the navigator lease file.
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string}
 */
export function leasePath(opts) {
  return path.join(navigatorDir(opts), 'leases', 'navigator.json');
}

/**
 * True when `id` is safe to use as a single file-name component: only
 * `[A-Za-z0-9._-]`, 1..128 chars, and not `.` / `..`. This excludes `/`, `\`,
 * NUL and every other separator by construction.
 * @param {unknown} id
 * @returns {boolean}
 */
export function isSafeSessionId(id) {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= SESSION_ID_MAX &&
    id !== '.' &&
    id !== '..' &&
    SESSION_ID_RE.test(id)
  );
}

/** @param {unknown} sessionId */
function assertSafeSessionId(sessionId) {
  if (!isSafeSessionId(sessionId)) {
    throw new TypeError(`unsafe session id: ${JSON.stringify(String(sessionId)).slice(0, 80)}`);
  }
}

/**
 * Path of a session's check-in file.
 * @param {string} sessionId
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string}
 * @throws {TypeError} when `sessionId` fails {@link isSafeSessionId}
 */
export function checkinPath(sessionId, opts) {
  assertSafeSessionId(sessionId);
  return path.join(navigatorDir(opts), 'checkin', `${sessionId}.json`);
}

/**
 * Path of a session's conditions ("Auflagen") file.
 * @param {string} sessionId
 * @param {{ env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {string}
 * @throws {TypeError} when `sessionId` fails {@link isSafeSessionId}
 */
export function auflagenPath(sessionId, opts) {
  assertSafeSessionId(sessionId);
  return path.join(navigatorDir(opts), 'auflagen', `${sessionId}.json`);
}

/**
 * Format a date as `YYYY-MM-DDTHH:MM:SSZ` (the output of `date -u +%FT%TZ`).
 * @param {Date} [date]
 * @returns {string}
 */
export function utcSecondsTimestamp(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * When the Standard-Auflagen apply to a check-in written at `zeit` if no
 * `auflagen/<session_id>.json` has appeared: {@link CHECKIN_FALLBACK_MIN} later
 * while a navigator is active (it may still write one), and at `zeit` itself
 * otherwise — with no active navigator nobody will, so the fallback is due at
 * once (#1501 item 8: this deadline lived only as prose in session-start).
 * @param {string} zeit the check-in's `zeit`, as {@link utcSecondsTimestamp} writes it
 * @param {'active'|'none'|'unreadable'} navigatorState from {@link readNavigatorLease}
 * @returns {string} same form as `zeit`
 */
export function fallbackDueAt(zeit, navigatorState) {
  if (navigatorState !== 'active') return zeit;
  return utcSecondsTimestamp(new Date(Date.parse(zeit) + CHECKIN_FALLBACK_MIN * 60_000));
}

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** @param {unknown} v */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/** @param {unknown} v */
function isIsoTimestamp(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function isLeaseTimestamp(v) {
  return typeof v === 'string' && LEASE_TS_RE.test(v) && isIsoTimestamp(v);
}

const REQUIRED_CHECKIN_FIELDS = [
  'session', 'plattform', 'repo', 'modus', 'auftrag_ref',
  'kandidaten', 'schreibbereich', 'rueckfall', 'zeit',
];

/** Repo name shape accepted in a check-in: `name` or `group/name`, no path parts. */
const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}(?:\/[A-Za-z0-9._-]{1,100})?$/;

/** Lease `adresse` shape (a ListAgents peer name): no whitespace, no control bytes. */
const ADRESSE_RE = /^[A-Za-z0-9._:@-]{1,128}$/;

/** True for an issue reference: a non-negative integer or a `#123` / `123` string. */
function isIssueRef(v) {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0;
  return typeof v === 'string' && /^#?\d{1,9}$/.test(v);
}

/**
 * Per-field type checks. Each returns an error message or null. Applied to every
 * PRESENT field; presence of the required ones is checked separately.
 * @type {Record<string, (v: unknown) => string|null>}
 */
const CHECKIN_FIELD_CHECKS = {
  session: (v) =>
    isSafeSessionId(v) ? null : 'session must be a safe id: [A-Za-z0-9._-], 1..128 chars, not . or ..',
  plattform: (v) => (PLATTFORMEN.includes(/** @type {string} */ (v)) ? null : `plattform must be one of ${PLATTFORMEN.join('|')}`),
  // A repo NAME (optionally `group/name`), never a filesystem path: the value
  // travels in `orchestrator.fleet.checkin`, which may leave the host over the
  // optional events webhook (docs/events-schema.md: "never the absolute root").
  repo: (v) => (typeof v === 'string' && REPO_NAME_RE.test(v) ? null : 'repo must be a repo name [A-Za-z0-9._-] (optionally group/name), not a path'),
  repo_id: (v) => (v === null || typeof v === 'string' ? null : 'repo_id must be a string or null'),
  worktree: (v) => (typeof v === 'boolean' ? null : 'worktree must be a boolean'),
  modus: (v) => (MODI.includes(/** @type {string} */ (v)) ? null : `modus must be one of ${MODI.join('|')}`),
  auftrag_ref: (v) => (isNonEmptyString(v) ? null : 'auftrag_ref must be a non-empty string'),
  konto_slot: (v) =>
    v === null || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))
      ? null
      : 'konto_slot must be a number, a string or null',
  quota: (v) => (typeof v === 'string' ? null : 'quota must be a string'),
  stand: (v) => (isPlainObject(v) ? null : 'stand must be an object'),
  // Issue numbers only (42 or "#42"), at most 64 — same webhook reasoning as `repo`.
  kandidaten: (v) =>
    Array.isArray(v) && v.length <= 64 && v.every(isIssueRef)
      ? null
      : 'kandidaten must be an array of at most 64 issue numbers (42 or "#42")',
  schreibbereich: (v) =>
    Array.isArray(v) && v.every((e) => typeof e === 'string') ? null : 'schreibbereich must be an array of strings',
  bedarf: (v) => (isPlainObject(v) ? null : 'bedarf must be an object'),
  vorab_geschrieben: (v) => (Array.isArray(v) ? null : 'vorab_geschrieben must be an array'),
  rueckfall: (v) => (isNonEmptyString(v) ? null : 'rueckfall must be a non-empty string'),
  zeit: (v) =>
    typeof v === 'string' && UTC_SECONDS_RE.test(v) && isIsoTimestamp(v)
      ? null
      : 'zeit must be a UTC timestamp YYYY-MM-DDTHH:MM:SSZ',
};

/**
 * Validate a check-in record (PRD !53 table 3.2).
 * @param {unknown} obj
 * @returns {string[]} error messages; empty means valid
 */
export function validateCheckin(obj) {
  if (!isPlainObject(obj)) return ['check-in must be a JSON object'];
  const rec = /** @type {Record<string, unknown>} */ (obj);
  const errors = [];
  for (const field of REQUIRED_CHECKIN_FIELDS) {
    if (rec[field] === undefined) errors.push(`missing required field: ${field}`);
  }
  for (const [field, check] of Object.entries(CHECKIN_FIELD_CHECKS)) {
    if (rec[field] === undefined) continue;
    const err = check(rec[field]);
    if (err) errors.push(err);
  }
  return errors;
}

/**
 * Validate a parsed lease; returns the first problem or null.
 * @param {unknown} lease
 * @returns {string|null}
 */
function leaseProblem(lease) {
  if (!isPlainObject(lease)) return 'lease is not a JSON object';
  const l = /** @type {Record<string, unknown>} */ (lease);
  // Shape-checked at the source ("escaped at generation"): both values can reach
  // the operator's session-start banner, so control bytes are refused here.
  if (!isSafeSessionId(l.session_id)) return 'lease.session_id missing or not a safe id';
  if (!PLATTFORMEN.includes(/** @type {string} */ (l.plattform))) return `lease.plattform must be one of ${PLATTFORMEN.join('|')}`;
  if (l.adresse !== undefined && l.adresse !== null && !(typeof l.adresse === 'string' && ADRESSE_RE.test(l.adresse))) {
    return 'lease.adresse must be null or a peer name [A-Za-z0-9._:@-] (1..128 chars)';
  }
  if (l.uebergabe_an !== undefined && l.uebergabe_an !== null && typeof l.uebergabe_an !== 'string') {
    return 'lease.uebergabe_an must be a string or null';
  }
  // Strict UTC form: a `Z`-less value would be read in the host's local time and
  // could EXTEND the lease west of UTC — a fail-open reading, hence unreadable.
  if (!isLeaseTimestamp(l.seit)) return 'lease.seit missing or not a UTC timestamp (…Z)';
  if (!isLeaseTimestamp(l.laeuft_ab)) return 'lease.laeuft_ab missing or not a UTC timestamp (…Z)';
  return null;
}

/**
 * Read the navigator lease. Never throws; fail-closed.
 *
 * @param {{ now?: number, env?: Record<string, string|undefined>, home?: string }} [opts]
 * @returns {Promise<{ state: 'active', lease: object } | { state: 'none' } | { state: 'unreadable', reason: string }>}
 */
export async function readNavigatorLease({ now = Date.now(), env, home } = {}) {
  let raw;
  try {
    raw = await fs.readFile(leasePath({ env, home }), 'utf8');
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return { state: 'none' };
    const code = err && /** @type {NodeJS.ErrnoException} */ (err).code;
    return { state: 'unreadable', reason: `read failed: ${code || 'unknown error'}` };
  }
  let lease;
  try {
    lease = JSON.parse(raw);
  } catch {
    return { state: 'unreadable', reason: 'lease is not valid JSON' };
  }
  const problem = leaseProblem(lease);
  if (problem) return { state: 'unreadable', reason: problem };
  if (Date.parse(lease.laeuft_ab) <= now) return { state: 'none' };
  return { state: 'active', lease };
}
