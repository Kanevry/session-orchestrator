/**
 * security-pulse-banner.mjs — session-start probe 21 `security-pulse` (#1769, stage 2).
 *
 * Reads ONLY the host-local cache (`security-pulse/cache.mjs`) — no HTTP request
 * ever — plus at most one short `git rev-parse HEAD`, and turns what is already
 * known into ONE banner line:
 *   a. the running Node is below the cached security floor of its own major;
 *   b. the cached lockfile findings at HEAD carry a malicious package or a
 *      critical vuln (KEV-listed ones counted where the ids allow the join);
 *   c. with `security-delta.mode` ≠ off: the newest close in this repo's sessions
 *      ledger has no `orchestrator.security.delta` event inside its own span.
 *
 * No finding → no banner. A missing, stale or unreadable cache is NOT a finding
 * (HR-101: "cache empty" fires on every first start and changes no decision),
 * but it is never "clean" either: the result carries `state` explicitly
 * (`not-measured` | `degraded` | `stale` | `fresh`). `degraded` = a cached part
 * records a failed or partial measurement (a source fetch failed, OSV left
 * packages unchecked); it is no banner either, and cached findings are still
 * reported. When any part is due (see {@link cachePartStatus}) the probe starts
 * the detached refresher (throttled, see spawn.mjs).
 */
import { execFile } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

import { eventsFilePath } from './events.mjs';
import { resolveLedgerPath } from './ledger-path.mjs';
import { SECURITY_DELTA_EVENT } from './security-delta/contract.mjs';
import { compareVersions, parseVersion } from './security-delta/runtime-floor.mjs';
import { CACHE_TTL_MS, cachePaths, readCacheFile, stampMs } from './security-pulse/cache.mjs';
import { maybeSpawnRefresh } from './security-pulse/spawn.mjs';

const HEAD_TIMEOUT_MS = 1500;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SESSIONS_REL = '.orchestrator/metrics/sessions.jsonl';

/**
 * NAMED CEILING (BV-004): the close-vs-delta check reads only the newest bytes of
 * each ledger — 1 MiB of sessions.jsonl (~140 records, 2026-10) and 4 MiB of
 * events.jsonl (the active file was 3.7 MiB here on 2026-10-25, it rotates).
 * A tail that starts AFTER the newest close began answers "not measurable",
 * never a finding. Revisit when events.jsonl routinely exceeds 4 MiB between
 * rotations, or when the probe's work time approaches its 2 s budget.
 */
const SESSIONS_TAIL_BYTES = 1024 * 1024;
const EVENTS_TAIL_BYTES = 4 * 1024 * 1024;
/** A delta event may be written up to this long after the session record's `completed_at`. */
const CLOSE_SLACK_MS = 5 * 60 * 1000;

/** A degraded (failed or partial) cache part is retried after this long, not after the 6 h TTL. */
export const DEGRADED_RETRY_MS = 30 * 60 * 1000;

/**
 * The ONE freshness/due rule for a cache part, shared by this probe and the
 * refresher (`security-pulse/refresh.mjs`) so both always agree.
 *
 * @param {{at: number|null, complete: boolean}} part  `at` = last attempt (epoch ms);
 *   `complete` = that attempt measured everything it set out to
 * @param {number} nowMs
 * @returns {{fresh: boolean, due: boolean}} fresh = complete and inside the TTL;
 *   due = never attempted, stamped in the future, or older than the TTL
 *   (complete) / the retry interval (degraded)
 */
export function cachePartStatus({ at, complete }, nowMs) {
  if (at === null || at > nowMs) return { fresh: false, due: true };
  const age = nowMs - at;
  return { fresh: complete && age < CACHE_TTL_MS, due: age >= (complete ? CACHE_TTL_MS : DEGRADED_RETRY_MS) };
}

/** Cache part of one host source (`node` / `kev` entry written by the refresher). */
export function hostSourcePart(entry) {
  return { at: stampMs(entry?.attempted_at) ?? stampMs(entry?.fetched_at), complete: entry?.status === 'ok' };
}

/** Cache part of a repo entry: complete only when OSV checked every package. */
export function repoPart(entry) {
  const unchecked = Number.isFinite(entry?.unchecked) ? entry.unchecked : 0;
  return {
    at: stampMs(entry?.fetched_at),
    complete: (entry?.status === 'ok' || entry?.status === 'skipped') && unchecked === 0,
  };
}

/*
 * Lockfile-derived names reach the SessionStart systemMessage, so only a strict
 * charset passes (a committed lockfile can carry newlines, prompt text, ANSI).
 */
const VERSION_RE = /^[0-9A-Za-z.+_~-]{1,64}$/;
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]{0,213}$/i;
/** PEP 508 project name (letters, digits, `._-` inside, alphanumeric at both ends). */
const PYPI_NAME_RE = /^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]{0,212}[A-Z0-9])$/i;

/** `name` when it is a valid npm or PyPI package name, else null. */
export function safePackageName(name) {
  return typeof name === 'string' && (NPM_NAME_RE.test(name) || PYPI_NAME_RE.test(name)) ? name : null;
}

/** `version` when it matches the strict version charset, else null. */
export function safePackageVersion(version) {
  return typeof version === 'string' && VERSION_RE.test(version) ? version : null;
}

/** Last line of defence for the banner text: no C0/C1 control characters. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Close records written by a ledger backfill, not by a real `/close`. */
function isBackfilledRecord(rec) {
  // Measured on the real ledger (2026-10-25, 649 records): 222 `_synthetic`,
  // 400 with `_backfill_source` (178 of them not synthetic but reconstructed,
  // all with `_backfill_incomplete_fields`); every `session_type: 'unknown'`
  // record is synthetic (0 otherwise). A real close always writes its type,
  // so `unknown` alone also marks a record that is no real close.
  return rec._synthetic === true || '_backfill_source' in rec || rec.session_type === 'unknown';
}

const nonEmpty = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** A Claude Code raw session id: a UUID (8-4-4-4-12 hex). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sort ids into raw (UUID-shaped) and semantic (anything else) by the SHAPE of
 * each value, not by the field that holds it: older ledger records carry the
 * raw UUID in `session_id`, and an event's `session_id` can hold either kind.
 * @param {unknown[]} values
 * @returns {{raw: Set<string>, semantic: Set<string>}}
 */
function classifyIds(values) {
  const out = { raw: new Set(), semantic: new Set() };
  for (const v of values) {
    const id = nonEmpty(v);
    if (id !== null) out[UUID_RE.test(id) ? 'raw' : 'semantic'].add(id);
  }
  return out;
}

/**
 * Does a delta event belong to the close? `'match'` when any raw↔raw or
 * semantic↔semantic value matches; `'foreign'` when at least one class is
 * present on both sides and none matches; `'unknown'` when no class is
 * present on both sides.
 */
function eventIdentity(close, ev) {
  const evIds = classifyIds([ev.session_id, ev.semantic_session_id]);
  let comparable = false;
  for (const cls of ['raw', 'semantic']) {
    if (close.ids[cls].size === 0 || evIds[cls].size === 0) continue;
    comparable = true;
    for (const id of evIds[cls]) if (close.ids[cls].has(id)) return 'match';
  }
  return comparable ? 'foreign' : 'unknown';
}

/** Default HEAD reader: one bounded `git rev-parse HEAD`, null on any failure. */
function defaultReadHead(repoRoot) {
  return new Promise((resolve) => {
    try {
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
      execFile('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { timeout: HEAD_TIMEOUT_MS, encoding: 'utf8', env }, (err, stdout) => {
        const out = String(stdout ?? '').trim();
        resolve(!err && SHA_RE.test(out) ? out : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Last `maxBytes` of a file as complete lines; `truncated` = the head was cut.
 * @returns {{lines: string[], truncated: boolean}|null} null when unreadable
 */
function readTailLines(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    const truncated = size > len;
    if (truncated) lines.shift(); // partial first line
    return { lines: lines.filter((l) => l.trim() !== ''), truncated };
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* closed */ }
  }
}

function parseLine(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Finding c: the newest completed close carries no delta event in its span.
 * @returns {{measured: boolean, finding: boolean, reason?: string}}
 */
export function checkCloseWithoutDelta({ sessionsFile, eventsFile }) {
  const sessions = readTailLines(sessionsFile, SESSIONS_TAIL_BYTES);
  if (sessions === null) return { measured: false, finding: false, reason: 'no-sessions-ledger' };
  let newest = null;
  for (const line of sessions.lines) {
    const rec = parseLine(line);
    if (rec === null || isBackfilledRecord(rec)) continue;
    const done = stampMs(rec.completed_at);
    const begun = stampMs(rec.started_at);
    if (done === null || begun === null) continue;
    if (newest === null || done > newest.done) {
      newest = { done, begun, ids: classifyIds([rec.raw_session_id, rec.session_id]) };
    }
  }
  if (newest === null) return { measured: false, finding: false, reason: 'no-completed-close' };
  const events = readTailLines(eventsFile, EVENTS_TAIL_BYTES);
  if (events === null) return { measured: false, finding: false, reason: 'no-events-ledger' };
  let oldestSeen = null;
  for (const line of events.lines) {
    // Substring prefilter on the serialized needle: cheap, and exact for an
    // ASCII event name (no JSON escaping can apply).
    const ts = line.includes(SECURITY_DELTA_EVENT) ? parseLine(line) : null;
    if (oldestSeen === null) oldestSeen = stampMs(parseLine(line)?.timestamp);
    if (ts?.event !== SECURITY_DELTA_EVENT) continue;
    // An event of another session never satisfies this close.
    // Ids are compared per class (raw UUID / semantic), classified by value
    // shape, so it does not matter which field carries which kind.
    // NAMED CEILING (BV-004): when no id class is present on both sides (an
    // event emitted without a provably owned lock carries no id at all; a close
    // with only a raw UUID meets an event with only a semantic id) only the time
    // span decides, so an overlapping peer close can still hide a missing delta
    // there. Revisit when every delta event is emitted with both the raw and the
    // semantic session id.
    if (eventIdentity(newest, ts) === 'foreign') continue;
    const at = stampMs(ts.timestamp);
    if (at !== null && at >= newest.begun && at <= newest.done + CLOSE_SLACK_MS) {
      return { measured: true, finding: false };
    }
  }
  // A cut tail that begins after the close started cannot rule the event out.
  if (events.truncated && (oldestSeen === null || oldestSeen > newest.begun)) {
    return { measured: false, finding: false, reason: 'events-tail-too-short' };
  }
  return { measured: true, finding: true };
}

/** Hours (one decimal) between `ms` and `nowMs`, or null. */
function ageHours(ms, nowMs) {
  return ms === null ? null : Math.max(0, Math.round(((nowMs - ms) / 3_600_000) * 10) / 10);
}

/**
 * Probe entry. Never throws, never touches the network.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {object} [opts.config]            parsed Session Config (`security-delta.mode`)
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.now]               epoch ms (tests)
 * @param {string} [opts.nodeVersion]       running Node (default `process.version`)
 * @param {(repoRoot: string) => Promise<string|null>} [opts.readHead]
 * @param {(o: {repoRoot: string, env?: NodeJS.ProcessEnv}) => void} [opts.spawnRefresh]
 * @param {string} [opts.sessionsFile]      ledger override (tests)
 * @param {string} [opts.eventsFile]        ledger override (tests)
 * @returns {Promise<object>} `{severity, state, message?, ...counts}`
 */
export async function checkSecurityPulse({
  repoRoot,
  config = {},
  env = process.env,
  now,
  nodeVersion = process.version,
  readHead = defaultReadHead,
  spawnRefresh,
  sessionsFile,
  eventsFile,
} = {}) {
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const result = {
    severity: 'ok',
    state: 'not-measured',
    reasons: [],
    nodeBelowFloor: null,
    repoMalicious: null,
    repoCritical: null,
    kevHits: null,
    closeWithoutDelta: null,
    cacheAgeH: null,
    refresh: 'not-needed',
  };
  try {
    const paths = cachePaths(repoRoot, { env });
    const host = readCacheFile(paths.hostFile);
    const repo = readCacheFile(paths.repoFile);
    if (!host.ok) result.reasons.push(`host-${host.reason}`);
    if (!repo.ok) result.reasons.push(`repo-${repo.reason}`);
    const head = await readHead(repoRoot).catch(() => null);
    if (head === null) result.reasons.push('head-unknown');

    const parts = [];
    const ages = [];

    // a. running Node vs cached floor of its own major
    const floors = host.ok ? host.value?.node?.floors : null;
    const nodeAt = host.ok ? stampMs(host.value?.node?.fetched_at) : null;
    const nodePart = cachePartStatus(hostSourcePart(host.ok ? host.value?.node : null), nowMs);
    const kevPart = cachePartStatus(hostSourcePart(host.ok ? host.value?.kev : null), nowMs);
    const degraded = [];
    if (host.ok) {
      for (const name of ['node', 'kev']) {
        const entry = host.value?.[name];
        if (entry && entry.status !== 'ok') degraded.push(`${name}-degraded`);
      }
    }
    const running = parseVersion(nodeVersion);
    const floorRaw = floors && running ? floors[String(running[0])] : undefined;
    const floor = typeof floorRaw === 'string' ? parseVersion(floorRaw) : null;
    if (running && floor && floor.length === 3) {
      ages.push(nodeAt);
      result.nodeBelowFloor = compareVersions(running, floor) < 0 ? 1 : 0;
      if (result.nodeBelowFloor === 1) parts.push(`Node ${nodeVersion} unter Sicherheitsstand ${floor.join('.')}`);
    }

    // b. cached repo findings, only when they describe the current HEAD
    const repoAt = repo.ok ? stampMs(repo.value?.fetched_at) : null;
    const repoAtHead = repo.ok && head !== null && repo.value?.head === head;
    if (repo.ok && head !== null && !repoAtHead) result.reasons.push('repo-head-moved');
    const repoMeasure = repoPart(repo.ok ? repo.value : null);
    const repoStatus = repoAtHead ? cachePartStatus(repoMeasure, nowMs) : { fresh: false, due: true };
    if (repoAtHead && !repoMeasure.complete) {
      const why = typeof repo.value.reason === 'string' && /^[a-z0-9-]{1,40}$/.test(repo.value.reason) ? `:${repo.value.reason}` : '';
      degraded.push(`repo-degraded${why}`);
      if (Number.isFinite(repo.value.unchecked) && repo.value.unchecked > 0) degraded.push(`repo-unchecked-${repo.value.unchecked}`);
    }
    if (repoAtHead) {
      ages.push(repoAt);
      const findings = Array.isArray(repo.value.findings) ? repo.value.findings : [];
      const serious = findings.filter((f) => f?.class === 'malicious' || (f?.class === 'vuln' && f?.severity === 'critical'));
      result.repoMalicious = findings.filter((f) => f?.class === 'malicious').length;
      result.repoCritical = findings.filter((f) => f?.class === 'vuln' && f?.severity === 'critical').length;
      // KEV counted among the LISTED findings only: the number sits inside the
      // parenthesis describing them, so a KEV-listed high vuln outside the list
      // must not inflate it.
      result.kevHits = serious.filter((f) => f?.kev === true).length;
      if (serious.length > 0) {
        const first = serious[0];
        const name = safePackageName(first.package);
        const label = name !== null ? `${name}@${safePackageVersion(first.version) ?? '?'}` : 'unbenannt';
        const kinds = [];
        if (result.repoMalicious > 0) kinds.push(`${result.repoMalicious} bösartig`);
        if (result.repoCritical > 0) kinds.push(`${result.repoCritical} kritisch`);
        const kev = result.kevHits > 0 ? `, ${result.kevHits} in KEV` : '';
        parts.push(`${serious.length} Paket-Fund${serious.length === 1 ? '' : 'e'} (${kinds.join(', ')}${kev}), z. B. ${label}`);
      }
    }

    // c. last close without a security delta (only when the delta is armed)
    const mode = config?.['security-delta']?.mode;
    if (typeof mode === 'string' && mode !== 'off') {
      const c = checkCloseWithoutDelta({
        sessionsFile: sessionsFile ?? resolveLedgerPath(SESSIONS_REL, repoRoot),
        eventsFile: eventsFile ?? eventsFilePath(repoRoot),
      });
      if (c.measured) {
        result.closeWithoutDelta = c.finding ? 1 : 0;
        if (c.finding) parts.push('letzter Close ohne Security-Delta');
      } else {
        result.reasons.push(`close-${c.reason}`);
      }
    }

    // State: degraded when a cached part records an incomplete measurement;
    // fresh only when node, KEV and the repo part at HEAD are complete and inside the TTL.
    result.reasons.push(...degraded);
    const allFresh = nodePart.fresh && kevPart.fresh && repoStatus.fresh;
    result.state = !host.ok && !repo.ok ? 'not-measured' : degraded.length > 0 ? 'degraded' : allFresh ? 'fresh' : 'stale';
    const known = ages.filter((a) => a !== null);
    result.cacheAgeH = known.length > 0 ? ageHours(Math.min(...known), nowMs) : null;

    if (nodePart.due || kevPart.due || repoStatus.due) {
      result.refresh = maybeSpawnRefresh({ repoRoot, markerPath: paths.spawnMarker, nowMs, env, spawnRefresh });
    }

    if (parts.length > 0) {
      result.severity = 'warn';
      const age = result.cacheAgeH !== null ? ` (Stand vor ${Math.round(result.cacheAgeH)} h)` : '';
      result.message = `⚠ security-pulse: ${parts.join('; ')}${age}`.replace(CONTROL_RE, '');
    }
    return result;
  } catch {
    result.reasons.push('internal-error');
    return result;
  }
}

