/** Windows tree cleanup: CIM identities via PowerShell 7 or 5.1, then taskkill and readback. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from './native-command.mjs';

// Ceiling per native call: 5 s. Revisit if measured CIM startup exceeds this;
// a hung PowerShell must never hang gate cleanup (including the exit handler).
const OPTIONS = { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024 };
// One snapshot never spends more than the old single-call ceiling, whichever
// shells it tries (#1859). pwsh 7 measured 1.3–1.4 s on the reporting host, so
// 3 s leaves 5.1 a real fallback window; revisit if pwsh 7 is measured slower.
const SNAPSHOT_BUDGET_MS = OPTIONS.timeout;
const PWSH7_TIMEOUT_MS = 3000;
const system32 = (env = process.env) => path.join(env.SystemRoot || 'C:\\Windows', 'System32');

/** Both shells print CreationDate as the same explicit /Date(ms)/ string;
 * pwsh 7 would otherwise emit ISO 8601 where 5.1 emits /Date(ms)/ (#1859). */
export const CIM_PROCESS_QUERY = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ '
  + 'ProcessId = $_.ProcessId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; '
  + "CreationDate = $(if ($_.CreationDate) { '/Date(' + ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() + ')/' } else { $null }) "
  + '} } | ConvertTo-Json -Compress';

/** Absolute shell candidates in preference order. pwsh 7 only from
 * %ProgramFiles% as an existing absolute path — never a bare `pwsh` that a
 * cwd/PATH search could resolve to a repo-planted binary. */
function shellCandidates(env, existsSyncFn) {
  const candidates = [];
  const programFiles = (typeof env?.ProgramFiles === 'string' ? env.ProgramFiles : '').trim();
  if (programFiles && path.win32.isAbsolute(programFiles)) {
    const pwsh = path.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    let present = false;
    try { present = existsSyncFn(pwsh) === true; } catch { /* unreadable = absent */ }
    if (present) candidates.push({ file: pwsh, timeout: PWSH7_TIMEOUT_MS });
  }
  candidates.push({ file: path.join(system32(env), 'WindowsPowerShell', 'v1.0', 'powershell.exe'), timeout: OPTIONS.timeout });
  return candidates;
}

function parseSnapshot(result) {
  if (result.error) throw new Error(result.error.code ?? result.error.message ?? 'spawn error');
  if (result.status !== 0) throw new Error(result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout));
  } catch {
    // A truncated or banner-polluted snapshot is "not measurable", never "no processes".
    throw new Error('output is not JSON');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.length || rows.some(p => !p || !Number.isInteger(p.ProcessId)
    || !Number.isInteger(p.ParentProcessId))) {
    throw new Error('no usable process identities');
  }
  return rows;
}

/**
 * Read the Windows process table (ProcessId, ParentProcessId, Name, CreationDate).
 * Tries pwsh 7, then Windows PowerShell 5.1; a failed candidate (error, exit,
 * signal, timeout, unparseable output) falls through to the next. All failing
 * throws — callers must report "not measurable", never an empty table.
 * @param {{ env?: object, existsSyncFn?: (p: string) => boolean, spawnSyncFn?: Function }} [opts]
 * @returns {Array<{ ProcessId: number, ParentProcessId: number, Name?: string, CreationDate?: string|null }>}
 */
export function readWindowsProcessTable({ env = process.env, existsSyncFn = existsSync, spawnSyncFn = spawnSync } = {}) {
  const reasons = [];
  let spent = 0;
  for (const { file, timeout } of shellCandidates(env, existsSyncFn)) {
    const budget = Math.min(timeout, SNAPSHOT_BUDGET_MS - spent);
    if (budget <= 0) { reasons.push(`${path.win32.basename(file)}: no budget left`); continue; }
    const started = Date.now();
    try {
      return parseSnapshot(spawnSyncFn(file, ['-NoProfile', '-NonInteractive', '-Command', CIM_PROCESS_QUERY],
        { ...OPTIONS, timeout: budget }));
    } catch (err) {
      // A timed-out call consumes its whole budget even if the clock reads less.
      const timedOut = err.message === 'ETIMEDOUT';
      spent += timedOut ? budget : Math.max(Date.now() - started, 0);
      reasons.push(`${path.win32.basename(file)}: ${err.message}`);
    }
  }
  throw new Error(`CIM snapshot failed (${reasons.join('; ')})`);
}

// Primary form: the explicit /Date(epoch ms)/ the query emits. Tolerant
// fallback: ISO 8601 WITH an offset (pwsh 7 default serialisation). Anything
// else — offset-less local times, WMI dates — stays explicitly unmeasurable.
/** @param {{ CreationDate?: unknown }} row @returns {number|null} epoch ms, or null when unmeasurable */
export function creationMs(row) {
  const value = row?.CreationDate;
  if (typeof value !== 'string') return null;
  const match = /^\/Date\((-?\d+)\)\/$/.exec(value);
  if (match) return Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function descendantIds(rows, seeds) {
  const ids = new Set(seeds);
  let size;
  do {
    size = ids.size;
    for (const p of rows) if (ids.has(p.ParentProcessId)) ids.add(p.ProcessId);
  } while (ids.size !== size);
  return ids;
}

/** Same synchronous primitive for timeout and process-exit cleanup.
 * A live ChildProcess holds libuv's Windows handle, preventing root PID reuse.
 * After exit, only dated descendants may be targeted; the root is never killed.
 * null survivors means unmeasurable, never a successful empty measurement.
 */
export function killWindowsProcessTree(pid, {
  spawnSyncFn = spawnSync,
  env = process.env,
  existsSyncFn = existsSync,
  snapshotFn = () => readWindowsProcessTable({ env, existsSyncFn, spawnSyncFn }),
  child,
  spawnedAtMs,
  verifyTree = true,
} = {}) {
  const base = { signalsSent: [], aborted: null };
  const unknown = reason => ({ ...base, ok: false, survivors: null, error: `nicht messbar auf win32: ${reason}` });
  const rootHeld = child?.exitCode === null && child?.signalCode === null;
  let killError = null;
  const kill = (target, tree = true) => {
    base.signalsSent.push('taskkill');
    try {
      const args = tree ? ['/PID', String(target), '/T', '/F'] : ['/PID', String(target), '/F'];
      const result = spawnSyncFn(path.join(system32(env), 'taskkill.exe'), args, OPTIONS);
      if (result.error || result.status !== 0) killError = result.error?.message ?? `taskkill exit ${result.status}`;
    } catch (err) { killError = String(err); }
  };
  if (!verifyTree) {
    if (rootHeld) kill(pid);
    return unknown(`nicht gemessen (verifyTree: false)${killError ? `; ${killError}` : ''}`);
  }

  let before;
  let measurementError;
  try {
    before = snapshotFn();
    if (!Array.isArray(before)) throw Error('invalid snapshot');
  } catch (err) { measurementError = err; }
  if (measurementError) {
    if (rootHeld) kill(pid);
    return unknown(measurementError);
  }
  const ids = descendantIds(before, [pid]);
  const floor = Number.isFinite(spawnedAtMs) ? spawnedAtMs - 2000 : null;
  let targets = before.filter(p => ids.has(p.ProcessId));
  if (!rootHeld) {
    targets = targets.filter(p => p.ProcessId !== pid);
    if (floor === null || targets.some(p => creationMs(p) === null)) return unknown('missing descendant CreationDate or spawnedAtMs');
    targets = targets.filter(p => creationMs(p) >= floor);
    for (const p of targets) kill(p.ProcessId);
  } else {
    // Windows never rewrites ParentProcessId when a parent dies, so a process
    // older than our root can still name the root's (reused) PID as its parent
    // (Opus review M2, #1612). Such a process is not ours: drop it from the
    // targets, and when one exists, end ours one by one without /T so
    // taskkill's own PPID walk cannot reach it.
    const rootBorn = creationMs(targets.find(p => p.ProcessId === pid)) ?? floor;
    const stale = rootBorn === null ? [] : targets.filter(p => p.ProcessId !== pid
      && creationMs(p) !== null && creationMs(p) < rootBorn);
    if (stale.length === 0) {
      kill(pid);
    } else {
      targets = targets.filter(p => !stale.includes(p));
      for (const p of targets) kill(p.ProcessId, false);
    }
  }

  let after;
  try {
    after = snapshotFn();
    if (!Array.isArray(after)) throw Error('invalid snapshot');
  } catch (err) { return unknown(err); }
  if ((rootHeld && !targets.some(p => p.ProcessId === pid))
    || targets.some(p => creationMs(p) === null)
    || after.some(p => targets.some(q => q.ProcessId === p.ProcessId) && creationMs(p) === null)) {
    return unknown('missing tree identity');
  }
  const survivors = new Set(targets.filter(p => after.some(q =>
    q.ProcessId === p.ProcessId && creationMs(q) === creationMs(p))).map(p => p.ProcessId));

  // Include descendants born during taskkill, following parents through both
  // snapshots even when an intermediate parent has already disappeared.
  const treeIds = new Set([pid, ...targets.map(p => p.ProcessId)]);
  const related = descendantIds([...before, ...after], treeIds);
  for (const p of after) {
    if (p.ProcessId === pid || !related.has(p.ParentProcessId)) continue;
    const date = creationMs(p);
    if (date === null || floor === null) return unknown('missing descendant CreationDate or spawnedAtMs');
    if (date >= floor) survivors.add(p.ProcessId);
  }
  return { ...base, ok: survivors.size === 0 && !killError, survivors: [...survivors], error: killError };
}
