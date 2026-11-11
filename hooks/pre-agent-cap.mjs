#!/usr/bin/env node
/**
 * pre-agent-cap.mjs — PreToolUse hook on the `Agent` dispatch tool: enforces the
 * agent caps of the fleet conditions ("Auflagen") and the memory emergency brake
 * (#1959). The logic, the cap sources, the counting rule and their ceilings live
 * in `scripts/lib/agent-cap.mjs`; this file only gathers the inputs.
 *
 * ## Failure direction
 *
 * - An internal error of THIS hook (a module that fails to load, a throw) is
 *   fail-OPEN: allow + one stderr line. The hook runs before every dispatch of
 *   every session on the host; a broken guard must not become a dispatch outage.
 * - "Memory not measurable" is NOT an internal error and never means free: the
 *   cap from the Auflagen still applies and a deny names „nicht messbar".
 * - Nothing is killed. The hook only refuses new starts (HR-101).
 *
 * ## State (both under `os.tmpdir()/session-orchestrator-agent-cap/`, mode 0700)
 *
 * - `<session>.json` — claims of allowed dispatches whose sidecar does not exist
 *   yet (same-message batches), read-modify-written under `withFileLock()`.
 * - `brake.json` — the emergency brake's hysteresis state. Host-wide on purpose:
 *   memory is a host property, not a session one.
 *
 * ## Cost
 *
 * Paid on every `Agent` dispatch: one stdin read, the settings (project
 * CLAUDE.md or AGENTS.md, owner.yaml), Auflagen/check-in file reads for known
 * keys (ENOENT is the common case), one navigator-lease read when fleet
 * integration is on, one `memory_pressure` spawn for a
 * process-starting dispatch (~2 ms measured 2026-11-05 on the M4), one directory
 * listing of the session's sidecars. The main transcript is read only when the
 * started count could reach the cap. Only when known keys (including a known
 * check-in's `session`) yield neither accepted Auflagen nor a check-in and a
 * native UUID is known: list/stat check-ins and read at most
 * CHECKIN_SESSION_SCAN_LIMIT newest files to recover semantic keys (#1979);
 * already-read keys are reused.
 *
 * ## Override
 *
 *   SO_DISABLED_HOOKS=pre-agent-cap   (session-level)
 *   SO_HOOK_PROFILE=minimal|off
 *
 * Caps and brake are configurable (env > owner.yaml > Session Config > default):
 * `scripts/lib/config/agent-caps.mjs`.
 */

import path from 'node:path';
import os from 'node:os';
import { lstatSync, mkdirSync, readFileSync } from 'node:fs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';

/** This hook's name — the `SO_DISABLED_HOOKS` key. */
const HOOK_NAME = 'pre-agent-cap';

/** The dispatch tool (measured name, see `hooks/pre-task-scope-disjoint.mjs` header #1). */
const DISPATCH_TOOL = 'Agent';

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/** Lock budget: the locked region is a directory listing and a small write. */
const LOCK_TIMEOUT_MS = 1500;
const LOCK_POLL_MS = 25;

// 2 × 1000 ms probes + 1500 ms lock < 5000 ms hook deadline, leaving room for I/O.
const MEMORY_PROBE_TIMEOUT_MS = 1000;

/**
 * State directory (claims + brake state), or null when it cannot be trusted.
 *
 * `mkdirSync(..., { mode: 0o700 })` is a no-op on an existing path, so on a
 * shared /tmp another user could pre-create it (or a symlink to a dir of
 * theirs) and read, plant or redirect our state. The dir counts only when it
 * is a real directory (lstat: no symlink), owned by this uid where uids exist,
 * with no group/other permission bits. Otherwise this call uses NO stored
 * state: the brake decides on the fresh measurement alone (no hysteresis) and
 * same-message batches are counted by existing sidecars only — the ceiling is
 * that one batch can exceed the cap by its own size until its sidecars appear.
 *
 * @returns {string|null}
 */
function trustedStateDir() {
  const dir = path.join(os.tmpdir(), 'session-orchestrator-agent-cap');
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return null;
    return dir;
  } catch {
    return null;
  }
}

/** @param {string} raw */
function fileToken(raw) {
  const t = String(raw ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return t === '' || t === '.' || t === '..' ? 'unknown' : t;
}

/** @param {string} file */
function readJsonOrNull(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * Session keys for the navigator files: the process-local ids first, then the
 * semantic id from `session.lock` — only when that lock names THIS process
 * (a peer's lock must not lend us its Auflagen).
 */
async function sessionKeys(input, projectDir) {
  const { readProcessLocalSessionIds } = await import('../scripts/lib/session-identity/own-session.mjs');
  const { isLockShape } = await import('../scripts/lib/session-lock-shape.mjs');
  const local = readProcessLocalSessionIds({ hookInput: input });
  // Tier 1 alone (#1972): the same reader with no env names only the ids the
  // harness wrote into THIS hook input.
  const hookIds = readProcessLocalSessionIds({ env: {}, hookInput: input });
  const keys = [...local];
  const lock = readJsonOrNull(path.join(projectDir, '.orchestrator', 'session.lock'));
  if (lock && isLockShape(lock) && local.includes(lock.session_id)
      && typeof lock.semantic_session_id === 'string' && lock.semantic_session_id.trim() !== '') {
    keys.push(lock.semantic_session_id.trim());
  }
  return { keys: [...new Set(keys)], native: local[0] ?? null, local, hookIds };
}

/**
 * The accepted Auflagen of this session (newest `zeit` wins, as in
 * `scripts/fleet-auflagen.mjs`), and — when none is accepted — the
 * `fallback_due_at` of its check-in (null without a check-in).
 *
 * @param {{ state: string }} lease — from `readNavigatorLease()`, read once per call
 */
async function fleetInputs(keys, native, projectDir, lease) {
  const fp = await import('../scripts/lib/fleet-protocol.mjs');
  let best = null;
  let bestRank = -Infinity;
  let fallbackDueAt = null;
  const checkedAuflagen = new Set();
  const checkins = new Map();
  const inspectAuflagen = async (candidates) => {
    for (const key of candidates) {
      if (!fp.isSafeSessionId(key) || checkedAuflagen.has(key)) continue;
      checkedAuflagen.add(key);
      const r = await fp.readAuflagen(key, { repoRoot: projectDir });
      if (r.state !== 'accepted') continue;
      const ms = Date.parse(String(r.auflagen.zeit ?? ''));
      const rank = Number.isFinite(ms) && ms <= Date.now() + 5 * 60_000 ? ms : -Infinity;
      if (best === null || rank > bestRank) { best = r.auflagen; bestRank = rank; }
    }
  };
  await inspectAuflagen(keys);
  if (best !== null) return { auflagen: best, fallbackDueAt: null };

  const inspectCheckins = async (candidates) => {
    for (const key of candidates) {
      if (!fp.isSafeSessionId(key)) continue;
      if (!checkins.has(key)) checkins.set(key, readJsonOrNull(fp.checkinPath(key)));
      const checkin = checkins.get(key);
      // A semantic key collides across repos (#1839): a check-in naming another
      // native session is not ours, including its `session` alias.
      if (native && typeof checkin?.session_uuid === 'string' && checkin.session_uuid !== native) continue;
      if (!checkin || typeof checkin.zeit !== 'string' || Number.isNaN(Date.parse(checkin.zeit))) continue;
      // The alias is another Auflagen key: only a check-in that names this very
      // session lends it, a missing uuid proves nothing (#1979).
      if (checkin.session_uuid === native) await inspectAuflagen([checkin.session]);
      fallbackDueAt ??= fp.fallbackDueAt(checkin.zeit, lease.state);
    }
  };
  await inspectCheckins(keys);
  // A check-in found under a known key already answered; the scan is the #1979
  // fallback for a session whose known keys found neither Auflagen nor check-in.
  if (best === null && fallbackDueAt === null && fp.isNativeUuid(native)) {
    const recovered = await fp.findCheckinSessionKeys(native, { checkins });
    await inspectAuflagen(recovered);
    if (best === null) await inspectCheckins(recovered);
  }
  return { auflagen: best, fallbackDueAt: best === null ? fallbackDueAt : null };
}

/**
 * Cap and brake settings: env > owner.yaml > Session Config (CLAUDE.md, else
 * AGENTS.md) > default. Same CLAUDE.md-first read as
 * `hooks/post-tool-context-threshold.mjs`.
 *
 * A broken settings module must not take the brake with it: the outer handler
 * fails open, so this call falls back to the defaults on its own.
 *
 * @param {string} projectDir
 * @param {{ DEFAULT_CAP_SETTINGS: object }} lib
 */
async function loadSettings(projectDir, lib) {
  let settingsModule;
  try {
    settingsModule = await import('../scripts/lib/config/agent-caps.mjs');
  } catch (e) {
    process.stderr.write(`⚠ ${HOOK_NAME}: settings unavailable, using defaults (${String(e?.message ?? e).split('\n')[0]})\n`);
    return lib.DEFAULT_CAP_SETTINGS;
  }
  const { _parseAgentCaps, resolveAgentCapSettings } = settingsModule;
  let committed = {};
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      committed = _parseAgentCaps(readFileSync(path.join(projectDir, name), 'utf8'));
      break;
    } catch { /* missing or unreadable — try the next candidate */ }
  }
  let ownerConfig;
  try {
    const { loadOwnerConfig } = await import('../scripts/lib/owner-yaml.mjs');
    ownerConfig = loadOwnerConfig().config;
  } catch { /* no owner tier; the resolver falls through */ }
  return resolveAgentCapSettings({ committed, env: process.env, ownerConfig });
}

/**
 * Tell the user, once per session and wording, that the repo weakened a limit.
 * stderr is not surfaced under exit 0, hence `emitWarn` (`systemMessage`). Only
 * on an allow: a deny already names the origin and owns the one stdout line.
 * Without a trusted state dir the notice repeats rather than disappears.
 *
 * @param {string[]} weakened — from `describeRepoWeakening()`
 * @param {string} projectDir
 * @param {string|null} noticePath
 * @param {{ emitWarn: (m: string) => void, writeJsonAtomicSync: Function }} io
 */
function noticeRepoWeakening(weakened, projectDir, noticePath, io) {
  if (weakened.length === 0) return;
  const text = `Die Session Config von Repo „${path.basename(projectDir)}“ schwächt den Agent-Schutz: ${weakened.join(', ')}. ` +
    'Eigene Werte setzt du in owner.yaml oder per Umgebungsvariable, sie gehen vor.';
  if (noticePath !== null) {
    if (readJsonOrNull(noticePath)?.text === text) return;
    try {
      io.writeJsonAtomicSync(noticePath, { text }, { tmpPrefix: '.notice', mode: 0o600 });
    } catch { /* then it repeats on the next dispatch */ }
  }
  io.emitWarn(text);
}

/**
 * Measure memory and advance the host-wide brake state.
 * `at` = the last MEASURED value that kept (or put) the brake engaged; an
 * unmeasurable call honours an engaged state only while `at` is young
 * (`BRAKE_UNMEASURABLE_HOLD_MS`), so it is refreshed on every measured
 * confirmation and never on an unmeasurable call.
 *
 * @param {string|null} dir — trusted state dir, or null (no stored state)
 * @param {{ brake: { engagePct: number|null, releasePct: number|null } }} settings
 */
async function brake(lib, dir, settings) {
  const probes = await import('../scripts/lib/resource-probe/probe-platform.mjs');
  const memory = await lib.measureMemory({
    pressurePctFree: () => probes.memoryPressurePctFree(MEMORY_PROBE_TIMEOUT_MS),
    ramAvailableGb: () => probes.ramAvailableGb(MEMORY_PROBE_TIMEOUT_MS),
  });
  const file = dir === null ? null : path.join(dir, 'brake.json');
  const prev = file === null ? null : readJsonOrNull(file);
  const wasEngaged = prev?.engaged === true;
  const confirmedAtMs = typeof prev?.at === 'string' ? Date.parse(prev.at) : null;
  const engaged = lib.nextBrakeState(memory.pct, wasEngaged, { confirmedAtMs, now: Date.now(), ...settings.brake });
  const confirmed = engaged && memory.pct !== null;
  if (file !== null && (engaged !== wasEngaged || confirmed)) {
    try {
      const { writeJsonAtomicSync } = await import('../scripts/lib/io.mjs');
      writeJsonAtomicSync(file, { engaged, pct: memory.pct, source: memory.source, at: new Date().toISOString() },
        { tmpPrefix: '.brake', mode: 0o600 });
    } catch { /* state is best-effort; the verdict below stands */ }
  }
  return { memory, engaged };
}

async function main() {
  const { readStdin, emitDeny, emitWarn, writeJsonAtomicSync } = await import('../scripts/lib/io.mjs');
  let input;
  try { input = await readStdin(); } catch { return; }
  if (!input || typeof input !== 'object' || input.tool_name !== DISPATCH_TOOL) return;

  const lib = await import('../scripts/lib/agent-cap.mjs');
  const projectDir = (process.env.CLAUDE_PROJECT_DIR || '').trim()
    || (typeof input.cwd === 'string' && input.cwd.trim()) || process.cwd();
  const classifyCache = new Map();
  const classify = (type) => lib.classifyAgentType(type, {
    pluginRoot: PLUGIN_ROOT, projectDir, homeDir: os.homedir(), cache: classifyCache,
  });
  const cls = classify(input.tool_input?.subagent_type);

  const { fleetIntegrationEnabled, readNavigatorLease } = await import('../scripts/lib/fleet-protocol.mjs');
  const fleetEnabled = fleetIntegrationEnabled();
  let fleet = { auflagen: null, fallbackDueAt: null };
  let isLead = false;
  let sessionToken = typeof input.session_id === 'string' ? input.session_id : '';
  if (fleetEnabled) {
    const { keys, native, local, hookIds } = await sessionKeys(input, projectDir);
    sessionToken ||= native ?? '';
    const lease = await readNavigatorLease();
    // The lead (#1971): the ACTIVE lease names one of this process's RAW ids —
    // never the semantic lock id or another lease field. Its subagents' hook
    // input carries the coordinator's raw id, so they count as the lead too.
    // Only the hook-input ids count (#1972): a headless `claude -p` started
    // from the lead's Bash inherits the lead's CLAUDE_CODE_SESSION_ID. The env
    // tier speaks only when the harness wrote no id into the input at all.
    const leadIds = hookIds.length > 0 ? hookIds : local;
    isLead = lease.state === 'active' && leadIds.includes(/** @type {{ session_id: string }} */ (lease.lease).session_id);
    fleet = await fleetInputs(keys, native, projectDir, lease);
  }
  const settings = await loadSettings(projectDir, lib);
  const cap = lib.resolveCaps({ fleetEnabled, ...fleet, isLead, now: Date.now(), settings });

  const dir = trustedStateDir();
  const weakened = lib.describeRepoWeakening(settings, { includeCaps: fleetEnabled && !isLead && fleet.auflagen === null });
  const noticePath = dir === null ? null : path.join(dir, `${fileToken(sessionToken)}.notice.json`);
  const conclude = (verdict) => {
    if (!verdict.allow) emitDeny(verdict.reason);
    else noticeRepoWeakening(weakened, projectDir, noticePath, { emitWarn, writeJsonAtomicSync });
  };

  const { memory, engaged } = cls === lib.CLASS_STARTING && settings.brake.engagePct !== null
    ? await brake(lib, dir, settings)
    : { memory: null, engaged: false };

  // No cap, or an engaged brake for a process-starting dispatch: the verdict
  // does not depend on the running count, so the transcript is not read. Under
  // memory pressure — the brake's own case — a 200 MB transcript parse can run
  // into the hook timeout, and a timed-out hook lets the dispatch through (#1965).
  if (cap.caps === null || (cls === lib.CLASS_STARTING && engaged)) {
    const verdict = lib.decideDispatch({ cls, running: { prozessstartend: 0, lesend: 0 }, cap, memory, brakeEngaged: engaged, settings });
    conclude(verdict);
    return;
  }

  const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : null;
  const useId = typeof input.tool_use_id === 'string' ? input.tool_use_id : '';
  // Untrusted state dir → no ledger: claims are neither read nor written.
  const ledgerPath = dir === null ? null : path.join(dir, `${fileToken(sessionToken)}.json`);

  const cycle = async () => {
    const now = Date.now();
    const started = lib.listStartedAgents(transcriptPath);
    const sidecarUseIds = new Set(started.map((s) => s.useId).filter(Boolean));
    const claims = lib.liveClaims(ledgerPath === null ? [] : readJsonOrNull(ledgerPath)?.claims, sidecarUseIds, now, useId);
    let running;
    const sameClass = started.filter((s) => classify(s.agentType) === cls).length
      + claims.filter((c) => c.cls === cls).length;
    if (sameClass < cap.caps[cls]) {
      // Upper bound of this class already below its cap — the transcript is not
      // read. Counted per class: agents of the other class never fill this cap (#1965).
      running = { prozessstartend: 0, lesend: 0 };
    } else {
      const { makeFinishedProbe } = await import('./pre-task-scope-disjoint.mjs');
      const isFinished = makeFinishedProbe({ transcriptPath: transcriptPath ?? undefined, now, selfUseId: useId });
      running = lib.countRunning(started, claims, { isFinished, classify, now });
    }
    const verdict = lib.decideDispatch({ cls, running, cap, memory, brakeEngaged: engaged, settings });
    if (verdict.allow && ledgerPath !== null) {
      try {
        writeJsonAtomicSync(ledgerPath, { claims: [...claims, { useId, cls, at: new Date(now).toISOString() }] },
          { tmpPrefix: '.claims', mode: 0o600 });
      } catch { /* a lost claim only weakens the next count, never this verdict */ }
    }
    return verdict;
  };

  if (ledgerPath === null) {
    conclude(await cycle());
    return;
  }
  const { withFileLock } = await import('../scripts/lib/file-lock.mjs');
  let locked;
  try {
    locked = await withFileLock(`${ledgerPath}.lock`, cycle, {
      timeoutMs: LOCK_TIMEOUT_MS,
      pollMs: LOCK_POLL_MS,
      staleCheck: 'pid',
      holder: HOOK_NAME,
      tmpPrefix: '.agent-cap.lock',
      warn: () => { /* a stale-lock override is bookkeeping */ },
    });
  } catch {
    locked = { ok: false };
  }
  // No lock → decide unlocked: the race returns, a dispatch is never denied for it.
  conclude(locked?.ok === true ? locked.value : await cycle());
}

// Entry guard (#1393): a bare `import()` runs nothing and never exits the importer.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook(HOOK_NAME)) process.exit(0);
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      try {
        process.stderr.write(`⚠ ${HOOK_NAME}: internal error — dispatch ALLOWED unchecked (${String(e?.message ?? e).split('\n')[0]})\n`);
      } catch { /* stderr may be closed */ }
      process.exit(0);
    });
}
