/** Windows tree cleanup: PowerShell 5.1 CIM identities, then taskkill and readback. */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// Ceiling per native call: 5 s. Revisit if measured CIM startup exceeds this;
// a hung PowerShell must never hang gate cleanup (including the exit handler).
const OPTIONS = { encoding: 'utf8', shell: false, windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 * 1024 };
const system32 = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

function readWindowsProcesses(spawnSyncFn = spawnSync) {
  const result = spawnSyncFn(
    path.join(system32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate | ConvertTo-Json -Compress'],
    OPTIONS,
  );
  if (result.error || result.status !== 0) throw new Error('CIM snapshot failed');
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout));
  } catch {
    // A truncated or banner-polluted snapshot is "not measurable", never "no processes".
    throw new Error('CIM snapshot output is not JSON');
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  if (!rows.length || rows.some(p => !p || !Number.isInteger(p.ProcessId)
    || !Number.isInteger(p.ParentProcessId))) {
    throw new Error('CIM snapshot has no usable process identities');
  }
  return rows;
}

// PowerShell 5.1 ConvertTo-Json uses /Date(epoch milliseconds)/.
// Other formats (including WMI dates) remain explicitly unmeasurable.
function creationMs(row) {
  const match = /^\/Date\((-?\d+)\)\/$/.exec(row?.CreationDate);
  return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
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
  snapshotFn = () => readWindowsProcesses(spawnSyncFn),
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
      const result = spawnSyncFn(path.join(system32(), 'taskkill.exe'), args, OPTIONS);
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
    q.ProcessId === p.ProcessId && q.CreationDate === p.CreationDate)).map(p => p.ProcessId));

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
