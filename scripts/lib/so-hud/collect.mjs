import path from 'node:path';
import { parseStateMd } from '../state-md/yaml-parser.mjs';

export const EVENT_NAMES = new Set([
  'orchestrator.quality_gate.passed', 'orchestrator.quality_gate.failed',
  'orchestrator.vault.mirror_run_completed', 'orchestrator.vault.board_written',
]);
const text = v => typeof v === 'string' && v.length ? v : null;
const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
const positive = v => Number.isSafeInteger(v) && v > 0 ? v : null;
export const safeId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(v);

export function parseEvents(tail) {
  return tail.split('\n').flatMap(line => {
    try {
      const e = JSON.parse(line);
      return EVENT_NAMES.has(e.event ?? e.event_type) ? [e] : [];
    } catch { return []; }
  }).sort((a, b) => (Date.parse(a.timestamp) || 0) - (Date.parse(b.timestamp) || 0));
}

export function gateFromEvent(e) {
  if (!e) return null;
  const failed = (e.event ?? e.event_type).endsWith('.failed') || e.check_failed === true || e.timed_out === true || (number(e.exit_code) !== null && e.exit_code !== 0);
  const reporting = ['baseline', 'incremental', 'per-file'].includes(e.variant);
  const proven = e.exit_code === 0 && (reporting ? e.check_failed === false : ['full-gate', 'auto-fix-loop'].includes(e.variant));
  return { variant: text(e.variant), passed: failed ? false : proven ? true : null,
    check_failed: typeof e.check_failed === 'boolean' ? e.check_failed : null,
    exit_code: number(e.exit_code), at: text(e.timestamp) };
}

/** Both scope sources must be readable; incomplete dispatch never proves disjointness. */
export function scopePaths(aggregate, dispatch) {
  if (!Array.isArray(aggregate) || !dispatch || !Array.isArray(dispatch.agents)) return null;
  if ((dispatch.scopeSignals?.['marker-absent'] ?? 0) > 0 || (dispatch.scopeSignals?.unparseable ?? 0) > 0) return null;
  const rows = [...aggregate, ...dispatch.agents];
  if (rows.some(r => !r || !Array.isArray(r.files) || r.files.some(f => typeof f !== 'string'))) return null;
  return [...new Set(rows.flatMap(r => r.files))];
}

/** All I/O and time are supplied. No writes, host discovery or defaults hidden in this fold. */
export async function collectSnapshot(repoRoot, readers) {
  const degraded = [];
  const read = async (file, json = false) => {
    try {
      const raw = await readers.readText(path.join(repoRoot, file));
      return { value: json ? JSON.parse(raw) : raw, absent: false };
    } catch (e) {
      if (e.code !== 'ENOENT') degraded.push(`${file}:unreadable`);
      return { value: null, absent: e.code === 'ENOENT' };
    }
  };
  const now = readers.now();
  const [lockResult, waveRead, stateRead, agentStatus, discovery, eventsRead, config, greenRead] = await Promise.all([
    readers.lock(repoRoot), read('.claude/wave-scope.json', true),
    readers.statePath ? read(readers.statePath) : read('.claude/STATE.md'),
    readers.agents(repoRoot), readers.discover(repoRoot), readers.events(repoRoot), readers.config(repoRoot), read('.orchestrator/runtime/last-green-sha.txt'),
  ]);
  degraded.push(...(discovery.degraded ?? []), ...(eventsRead.degraded ?? []), ...(config.degraded ?? []));
  if (!['ok', 'absent'].includes(lockResult.status)) degraded.push(`lock:${lockResult.status}`);
  const lock = lockResult.lock ?? null;
  const sid = readers.sessionId ?? lock?.session_id ?? null;
  const wave = waveRead.value && typeof waveRead.value === 'object' && !Array.isArray(waveRead.value) ? waveRead.value : null;
  const foreignWave = wave?.session_id && sid && wave.session_id !== sid;
  if (foreignWave) degraded.push('wave:foreign-session');
  const ownWave = foreignWave || !positive(wave?.wave) ? null : wave;
  if (!waveRead.absent && !ownWave && !foreignWave) degraded.push('wave:invalid-or-unreadable');
  const waveNumber = positive(ownWave?.wave);
  const fm = parseStateMd(stateRead.value)?.frontmatter ?? {};
  const foreignState = fm['session-id'] && sid && fm['session-id'] !== sid;
  if (foreignState) degraded.push('state:foreign-session');
  const state = foreignState ? {} : fm;
  const dispatch = safeId(sid) ? (await read(`.orchestrator/wave-dispatch-scopes.${sid}.json`, true)).value : null;
  const dispatchWave = positive(Number(String(dispatch?.waveKey ?? '').match(/\|w(\d+)\|/)?.[1]));
  const currentDispatch = dispatch && waveNumber && dispatchWave === waveNumber && Array.isArray(dispatch.agents) ? dispatch : null;
  const entries = new Map();
  for (const a of currentDispatch?.agents ?? []) {
    if (!text(a?.id)) continue;
    entries.set(a.id, { id: a.id, typ: text(a.typ ?? a.agent_type ?? a.type), modellfamilie: text(a.modellfamilie ?? a.model), status: null, tokens: null, letzter_request_at: null, quelle: 'dispatch' });
  }
  for (const [id, a] of Object.entries(agentStatus.entries ?? {})) {
    // Unbound/foreign status cannot make the current wave look alive.
    if (!sid || (a.session_id ?? a.sessionId) !== sid) continue;
    if (waveNumber && (a.wave ?? a.wave_number) !== waveNumber) continue;
    const existing = entries.get(id);
    entries.set(id, { id, typ: text(a.agent_type) ?? existing?.typ ?? null, modellfamilie: text(a.model) ?? existing?.modellfamilie ?? null,
      status: text(a.status ?? a.text), tokens: null, letzter_request_at: null, quelle: existing ? 'dispatch+agent-status' : 'agent-status' });
  }
  if (agentStatus.degraded) degraded.push('agents:degraded');
  const events = parseEvents(eventsRead.text ?? '');
  const gates = events.filter(e => (e.event ?? e.event_type).startsWith('orchestrator.quality_gate.'));
  const latest = name => events.filter(e => (e.event ?? e.event_type) === name && e.dry_run !== true).at(-1);
  const mirror = latest('orchestrator.vault.mirror_run_completed');
  const board = latest('orchestrator.vault.board_written');
  const peers = await Promise.all((discovery.sessions ?? []).filter(s => s.sessionId !== sid).map(async s => {
    const root = s.worktreePath;
    const peerRead = async file => { try { return JSON.parse(await readers.readText(path.join(root, file))); } catch { return null; } };
    const peerLock = (await readers.lock(root)).lock;
    const peerStateRaw = await readers.readText(path.join(root, '.claude/STATE.md')).catch(() => null);
    const peerFm = parseStateMd(peerStateRaw)?.frontmatter;
    const bound = peerFm?.['session-id'] === s.sessionId;
    const stateWave = bound ? positive(peerFm['current-wave']) : null;
    const pd = safeId(s.sessionId) ? await peerRead(`.orchestrator/wave-dispatch-scopes.${s.sessionId}.json`) : null;
    const dispatchNumber = pd?.waveKey?.startsWith(`${s.sessionId}|`) ? positive(Number(pd.waveKey.split('|')[1]?.slice(1))) : null;
    const currentWave = stateWave ?? dispatchNumber;
    const aggregate = currentWave ? await peerRead(`.claude/filescopes/wave-${currentWave}.scopes.json`) : null;
    return { session_id: s.sessionId, branch: text(s.branch), status: bound ? text(peerFm.status) : null,
      current_wave: currentWave, last_heartbeat: peerLock?.session_id === s.sessionId ? text(peerLock.last_heartbeat) : text(s.last_heartbeat),
      gleiches_working_copy: path.resolve(root) === path.resolve(repoRoot), scope_paths: dispatchNumber !== null && dispatchNumber !== currentWave ? null : scopePaths(aggregate, pd) };
  }));
  return {
    schema_version: 1, measured_at: new Date(now).toISOString(), repo: { root: repoRoot, name: path.basename(repoRoot) },
    lock: lock ? { session_id: text(lock.session_id), live: readers.isLockLive(lock, now), last_heartbeat: text(lock.last_heartbeat) } : null,
    session: sid ? { session_id: sid, semantic_session_id: text(lock?.semantic_session_id) } : null,
    wave: { running: waveRead.absent ? false : ownWave ? true : null, number: waveNumber, role: text(ownWave?.role),
      agents_total: Array.isArray(currentDispatch?.agents) ? currentDispatch.agents.length : null, source: ownWave ? '.claude/wave-scope.json' : null },
    agents: { entries: [...entries.values()], source: agentStatus.source ?? (currentDispatch ? 'dispatch' : null), at: agentStatus.at ?? text(currentDispatch?.updated), degraded: agentStatus.degraded ?? null },
    state: { status: text(state.status), session_type: text(state['session-type'] ?? state.type ?? state.mode), current_wave: positive(state['current-wave']), total_waves: positive(state['total-waves'] ?? state.waves) },
    gate: { last: gateFromEvent(gates.at(-1)), last_green_sha: typeof greenRead.value === 'string' && /^[a-f0-9]{7,64}$/i.test(greenRead.value.trim()) ? greenRead.value.trim() : null },
    peers, vault: { enabled: config.enabled ?? null, mode: config.mode ?? null,
      last_run: mirror ? { at: text(mirror.timestamp), created: number(mirror.created), updated: number(mirror.updated), failed: number(mirror.failed), aborted: mirror.aborted ?? null } : null,
      board: board ? { action: text(board.action), at: text(board.timestamp) } : null }, degraded: [...new Set(degraded)],
  };
}
