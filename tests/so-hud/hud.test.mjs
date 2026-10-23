import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { collectSnapshot, scopePaths } from '../../scripts/lib/so-hud/collect.mjs';
import { readEventTail, discover } from '../../scripts/lib/so-hud/runtime.mjs';
import { main } from '../../scripts/so-hud.mjs';
import { beaconIO } from '../../mods/so-hud/hooks/beacon-io.mjs';
import { ownerQuestion, statusText, validateBeacon, ageBeacon, findings, completeState } from '../../mods/so-hud/hooks/logic.ts';

const roots = [];
const now = Date.parse('2026-10-10T15:10:00Z');
const stamp = new Date(now).toISOString();
async function fixture(files = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'so-hud-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(root, name);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(r => fs.rm(r, { recursive: true, force: true }))); });
// Awaited, not spawnSync with its own timeout (#1673): a slow run on a loaded host read as `status: null`, an assertion
// the full gate never re-runs. Now the test's own timeout decides and `signal` kills the child when it fires.
const runCli = (args, opts, signal) => new Promise(resolve => execFile(process.execPath, args, { ...opts, encoding: 'utf8', signal },
  (error, stdout, stderr) => resolve({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout, stderr })));
const readers = (extra = {}) => ({
  now: () => now, readText: p => fs.readFile(p, 'utf8'), lock: async () => ({ status: 'absent' }), isLockLive: () => true,
  agents: async () => ({ entries: {}, source: null, at: null, degraded: null }),
  discover: async () => ({ sessions: [], degraded: [] }), events: async root => readEventTail(root), config: async () => ({ enabled: true, mode: 'warn' }), ...extra,
});
const beacon = () => ({ schema_version: 1, session_id: 'own', name: null, repo_name: 'repo', branch: null, pid: 123, zustand: 'bereit', seit: stamp, warte_grund: null, heuristisch: false, kontext_prozent: 90, letzter_request_at: stamp, modell: null, welle: 2, aktualisiert_at: stamp });

describe('collector boundaries', () => {
  it('distinguishes absent, corrupt and unreadable wave instead of fabricating wave zero', async () => {
    const root = await fixture();
    expect((await collectSnapshot(root, readers())).wave).toMatchObject({ running: false, number: null, agents_total: null });
    await fs.mkdir(path.join(root, '.claude'));
    await fs.writeFile(path.join(root, '.claude/wave-scope.json'), '{');
    const corrupt = await collectSnapshot(root, readers());
    expect(corrupt.wave.running).toBeNull();
    expect(corrupt.degraded).toContain('.claude/wave-scope.json:unreadable');
    const blocked = await collectSnapshot(root, readers({ readText: async () => { throw Object.assign(new Error(), { code: 'EACCES' }); } }));
    expect(blocked.wave.running).toBeNull();
  });
  it('joins bound dispatch and agent status but rejects foreign session status', async () => {
    const root = await fixture({ '.claude/wave-scope.json': { session_id: 'own', wave: 2, role: 'Impl-Core' }, '.orchestrator/wave-dispatch-scopes.own.json': { waveKey: 'own|w2|Impl-Core', agents: [{ id: 'a', model: 'sonnet' }, { id: 'b' }, { id: 'c' }] }, '.claude/STATE.md': '---\nsession-id: own\nsession-type: deep\ncurrent-wave: 2\ntotal-waves: 5\nstatus: active\n---\n' });
    const s = await collectSnapshot(root, readers({ sessionId: 'own', lock: async () => ({ status: 'ok', lock: { session_id: 'own' } }), agents: async () => ({ entries: { a: { sessionId: 'own', wave: 2, text: 'running' }, foreign: { sessionId: 'other', wave: 2, text: 'done' } }, source: 'ledger', at: stamp }) }));
    expect(s.wave).toMatchObject({ running: true, number: 2, role: 'Impl-Core', agents_total: 3 });
    expect(s.agents.entries).toHaveLength(3);
    expect(s.agents.entries[0]).toMatchObject({ status: 'running', modellfamilie: 'sonnet', tokens: null, letzter_request_at: null });
    expect(s.state).toMatchObject({ session_type: 'deep', current_wave: 2, total_waves: 5 });
    const unbound = await collectSnapshot(root, readers({ agents: async () => ({ entries: { old: { text: 'running' } } }) }));
    expect(unbound.agents.entries).toEqual([]);
  });
  it('requires a live session-bound lock even with a remaining wave manifest', async () => {
    const root = await fixture({ '.claude/wave-scope.json': { session_id: 'own', wave: 2 } });
    for (const [lock, live, expected] of [
      [{ session_id: 'own' }, false, false], [null, false, false],
      [{ session_id: 'other' }, true, false], [{ session_id: 'own' }, true, true],
    ]) {
      const s = await collectSnapshot(root, readers({ sessionId: 'own', lock: async () => ({ status: lock ? 'ok' : 'absent', lock }), isLockLive: () => live }));
      expect(s.wave.running).toBe(expected);
    }
  });
  it('keeps the red gate through unproven events until proven green', async () => {
    const root = await fixture();
    const events = [
      { event: 'orchestrator.quality_gate.failed', variant: 'full-gate', exit_code: 1, timestamp: stamp },
      { event: 'orchestrator.quality_gate.passed', variant: 'baseline', exit_code: 0, timestamp: new Date(now + 1000).toISOString() },
    ];
    const deps = readers({ events: async () => ({ text: events.map(e => JSON.stringify(e)).join('\n') }) });
    expect((await collectSnapshot(root, deps)).gate.last).toMatchObject({ passed: false, exit_code: 1, at: stamp });
    events.push({ event: 'orchestrator.quality_gate.passed', variant: 'baseline', exit_code: 0, check_failed: false, timestamp: new Date(now + 2000).toISOString() });
    expect((await collectSnapshot(root, deps)).gate.last.passed).toBe(true);
    events.push({ event: 'orchestrator.quality_gate.passed', variant: 'baseline', exit_code: 0, timestamp: new Date(now + 3000).toISOString() });
    expect((await collectSnapshot(root, deps)).gate.last.passed).toBeNull();
  });
  it('does not label reporting-variant passed events green without check evidence', async () => {
    const events = [
      { event: 'orchestrator.quality_gate.passed', variant: 'full-gate', exit_code: 0, timestamp: stamp, commit: 'abc123' },
      { event: 'orchestrator.quality_gate.passed', variant: 'baseline', exit_code: 0, check_failed: true, timestamp: stamp },
      { event: 'invented.quality_gate.passed', variant: 'full-gate', exit_code: 0, timestamp: stamp },
    ];
    const root = await fixture({ '.orchestrator/runtime/last-green-sha.txt': 'abc1234\n', '.orchestrator/metrics/events.jsonl': events.map(e => JSON.stringify(e)).join('\n') });
    let s = await collectSnapshot(root, readers());
    expect(s.gate.last.passed).toBe(false);
    expect(s.gate.last_green_sha).toBe('abc1234');
    delete events[1].check_failed;
    await fs.writeFile(path.join(root, '.orchestrator/metrics/events.jsonl'), events.map(e => JSON.stringify(e)).join('\n'));
    s = await collectSnapshot(root, readers());
    expect(s.gate.last.passed).toBeNull();
  });
  it('reads only the bounded tail and ignores dry-run mirrors', async () => {
    const mirror = { event: 'orchestrator.vault.mirror_run_completed', timestamp: stamp, failed: 2, created: 0, updated: 1, aborted: 'filesystem-error' };
    const root = await fixture({ '.orchestrator/metrics/events.jsonl': 'x'.repeat(600_000) + '\n' + JSON.stringify(mirror) + '\n' + JSON.stringify({ ...mirror, dry_run: true, failed: 0 }) });
    const tail = readEventTail(root);
    expect(Buffer.byteLength(tail.text)).toBeLessThanOrEqual(512 * 1024);
    const s = await collectSnapshot(root, readers());
    expect(s.vault.last_run).toMatchObject({ created: 0, failed: 2, aborted: 'filesystem-error' });
    expect(s.degraded).toContain('events:tail-only');
  });
  it('reads both peer scopes and marks missing dispatch evidence unknown', async () => {
    const root = await fixture({ '.claude/STATE.md': '---\nsession-id: peer\ncurrent-wave: 2\nstatus: active\n---\n', '.claude/filescopes/wave-2.scopes.json': [{ id: 'a', files: ['a.ts'] }], '.orchestrator/wave-dispatch-scopes.peer.json': { agents: [{ id: 'a', files: ['b.ts'] }], scopeSignals: { extracted: 1 } } });
    const deps = readers({ sessionId: 'own', discover: async () => ({ sessions: [{ sessionId: 'peer', worktreePath: root, branch: 'feature' }] }) });
    const s = await collectSnapshot(root, deps);
    expect(s.peers[0]).toMatchObject({ gleiches_working_copy: true, scope_paths: ['a.ts', 'b.ts'], current_wave: 2 });
    await fs.unlink(path.join(root, '.orchestrator/wave-dispatch-scopes.peer.json'));
    expect((await collectSnapshot(root, deps)).peers[0].scope_paths).toBeNull();
    expect(scopePaths([], { agents: [], scopeSignals: { 'marker-absent': 1 } })).toBeNull();
    expect(scopePaths([], { agents: [], scopeSignals: { unparseable: 1 } })).toBeNull();
  });
  // Catches: a peer whose worktree path is a symlinked spelling of ours read as another working copy (no collision guard).
  it('counts a symlinked spelling of the same worktree as the same working copy', async () => {
    const root = await fixture();
    const link = `${root}-link`;
    roots.push(link);
    await fs.symlink(root, link);
    const s = await collectSnapshot(root, readers({ sessionId: 'own', discover: async () => ({ sessions: [{ sessionId: 'peer', worktreePath: link }] }) }));
    expect(s.peers[0]).toMatchObject({ session_id: 'peer', gleiches_working_copy: true });
  });
  it('surfaces discovery timeout and registry failure instead of a clean empty fleet', async () => {
    const root = await fixture();
    const d = await discover(root, { run: async () => { throw Object.assign(new Error(), { killed: true }); }, registry: async () => { throw new Error(); } });
    expect(d.degraded).toEqual(['discovery-timeout', 'registry-unreadable']);
    const s = await collectSnapshot(root, readers({ discover: async () => d }));
    expect(s.degraded).toContain('discovery-timeout');
  });
});

describe('CLI and private beacon files', () => {
  it('returns usage 2, missing-repo 6 and measured JSON 0', async () => {
    const cli = path.resolve('scripts/so-hud.mjs');
    expect(spawnSync(process.execPath, [cli], { encoding: 'utf8' }).status).toBe(2);
    const root = await fixture();
    expect(spawnSync(process.execPath, [cli, '--json', '--repo-root', path.join(root, 'missing')], { encoding: 'utf8' }).status).toBe(6);
    let output = '';
    expect(await main(['--json', '--repo-root', root], { output: v => { output += v; }, measure: p => collectSnapshot(p, readers()) })).toBe(0);
    expect(JSON.parse(output).schema_version).toBe(1);
  });
  // Catches: a session started in a subdirectory measuring that subdirectory as its repo (no peer, wrong wave scope),
  // or a symlinked session getting git's physical spelling, which its own file paths never start with (guard off).
  it('measures the git toplevel in the caller\'s spelling when --repo-root names a subdirectory', async () => {
    const root = await fixture({ 'scripts/x.mjs': '' });
    expect(spawnSync('git', ['init', '-q', root]).status).toBe(0);
    const link = `${root}-link`;
    roots.push(link);
    await fs.symlink(root, link);
    for (const [given, expected] of [[root, root], [link, link]]) {
      let output = '';
      expect(await main(['--json', '--repo-root', path.join(given, 'scripts')], { output: v => { output += v; }, measure: p => collectSnapshot(p, readers()) })).toBe(0);
      expect(JSON.parse(output).repo.root).toBe(expected);
    }
  });
  // Catches: a symlinked LAST path part (<d>/elsewhere/scripts → <d>/repo/scripts) mapped to the non-repo <d>/elsewhere,
  // which collect.mjs then compares physically against peers — collision guard silently off.
  it('never maps --repo-root to a directory that is not the repository', async () => {
    const d = await fixture({ 'repo/scripts/x.mjs': '' });
    expect(spawnSync('git', ['init', '-q', path.join(d, 'repo')]).status).toBe(0);
    await fs.mkdir(path.join(d, 'elsewhere'));
    await fs.symlink(path.join(d, 'repo', 'scripts'), path.join(d, 'elsewhere', 'scripts'));
    let output = '';
    expect(await main(['--json', '--repo-root', path.join(d, 'elsewhere', 'scripts')], { output: v => { output += v; }, measure: p => collectSnapshot(p, readers()) })).toBe(0);
    expect(await fs.realpath(JSON.parse(output).repo.root)).toBe(await fs.realpath(path.join(d, 'repo')));
  });
  it('registers the installation with 0700 directory and 0600 file in a fixture home (mode bits POSIX-only)', async () => {
    const home = await fixture();
    expect(await main(['--register-root'], { home })).toBe(0);
    const dir = path.join(home, '.config/session-orchestrator/hud');
    await expectMode(dir, 0o700);
    await expectMode(path.join(dir, 'so-root'), 0o600);
    expect((await fs.readFile(path.join(dir, 'so-root'), 'utf8')).trim()).toBe(path.resolve('.'));
  });
  it('atomically replaces only its own beacon at 0600 and deletes it at end (mode bits POSIX-only)', async () => {
    const home = await fixture();
    await beaconIO('write', 'own', beacon(), { home });
    await beaconIO('write', 'own', { ...beacon(), zustand: 'arbeitet' }, { home });
    const dir = path.join(home, '.config/session-orchestrator/hud/beacons');
    expect(await fs.readdir(dir)).toEqual(['own.json']);
    await expectMode(path.join(dir, 'own.json'), 0o600);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'own.json'), 'utf8')).zustand).toBe('arbeitet');
    await expect(beaconIO('write', '../peer', beacon(), { home })).rejects.toThrow();
    await beaconIO('remove', 'own', null, { home });
    expect(await fs.readdir(dir)).toEqual([]);
  });
  const receipt = () => ({ zeit: stamp, session_id: 'own', vorgang: 'pane-aktion', aktion: 'aussenwirkung', argv_sha256: 'a'.repeat(64), exit: 0, profil: 'ausgewogen', ergebnis: 'ausgefuehrt', art: 'push' });
  const hudDir = home => path.join(home, '.config/session-orchestrator/hud');
  // Native Windows has no POSIX mode bits: fs.stat reports 0o666 (438) for every file, so only the mode
  // assertion is POSIX-only; the content, symlink and hard-link refusals are asserted on every platform.
  const expectMode = async (p, mode) => { if (process.platform !== 'win32') expect((await fs.stat(p)).mode & 0o777).toBe(mode); };
  it('appends one receipt line per action to a fresh 0600 file under a 0700 directory (mode bits POSIX-only)', async () => {
    const home = await fixture();
    await beaconIO('aktion', 'own', receipt(), { home });
    await beaconIO('aktion', 'own', { ...receipt(), exit: null, ergebnis: 'abgelehnt' }, { home });
    const file = path.join(hudDir(home), 'aktionen.jsonl');
    expect((await fs.readFile(file, 'utf8')).trim().split('\n').map(l => JSON.parse(l).ergebnis)).toEqual(['ausgefuehrt', 'abgelehnt']);
    await expectMode(file, 0o600);
    await expectMode(hudDir(home), 0o700);
  });
  it('keeps the shared file of other writers intact and narrows its mode to 0600 (mode bits POSIX-only)', async () => {
    const home = await fixture();
    const file = path.join(hudDir(home), 'aktionen.jsonl');
    await fs.mkdir(hudDir(home), { recursive: true });
    const foreign = '{"zeit":"2026-10-10T15:00:00Z","vorgang":"inbox-aktion","ergebnis":"ok"}\n';
    await fs.writeFile(file, foreign, { mode: 0o644 });
    await beaconIO('aktion', 'own', receipt(), { home });
    const text = await fs.readFile(file, 'utf8');
    expect(text.startsWith(foreign)).toBe(true);
    expect(text.trim().split('\n')).toHaveLength(2);
    await expectMode(file, 0o600);
  });
  it('refuses a symlink planted at the receipt path and leaves its target untouched (mode bits POSIX-only)', async () => {
    const home = await fixture();
    const elsewhere = path.join(home, 'elsewhere.txt');
    await fs.writeFile(elsewhere, 'original', { mode: 0o644 });
    await fs.mkdir(hudDir(home), { recursive: true });
    await fs.symlink(elsewhere, path.join(hudDir(home), 'aktionen.jsonl'));
    await expect(beaconIO('aktion', 'own', receipt(), { home })).rejects.toThrow();
    expect(await fs.readFile(elsewhere, 'utf8')).toBe('original');
    await expectMode(elsewhere, 0o644);
  });
  // Catches: a hard link planted at the receipt path receiving the receipt and narrowing its target's mode to 0600.
  it.each([[undefined], [0]])('refuses a hard link at the receipt path and leaves its target untouched (noFollow %s) (mode bits POSIX-only)', async noFollow => {
    const home = await fixture();
    const victim = path.join(home, 'victim.txt');
    await fs.writeFile(victim, 'original');
    await fs.chmod(victim, 0o644);
    await fs.mkdir(hudDir(home), { recursive: true });
    await fs.link(victim, path.join(hudDir(home), 'aktionen.jsonl'));
    await expect(beaconIO('aktion', 'own', receipt(), { home, noFollow })).rejects.toThrow();
    expect(await fs.readFile(victim, 'utf8')).toBe('original');
    await expectMode(victim, 0o644);
  });
  // noFollow 0 simulates native Windows, where node:fs has no O_NOFOLLOW and the helper falls back to lstat.
  const homeWithLink = async linkAt => {
    const home = await fixture();
    const elsewhere = path.join(home, 'elsewhere');
    await fs.mkdir(elsewhere);
    await fs.chmod(elsewhere, 0o755);
    await fs.mkdir(path.dirname(linkAt(home)), { recursive: true });
    await fs.symlink(elsewhere, linkAt(home));
    return { home, elsewhere };
  };
  // Catches: a symlink planted at hud/ redirecting the helper's chmod and its receipt/beacon writes into a foreign directory.
  it.each([[undefined], [0]])('refuses a symlinked hud directory without chmod or write into its target (noFollow %s) (mode bits POSIX-only)', async noFollow => {
    const { home, elsewhere } = await homeWithLink(hudDir);
    await expect(beaconIO('aktion', 'own', receipt(), { home, noFollow })).rejects.toThrow();
    await expect(beaconIO('write', 'own', beacon(), { home, noFollow })).rejects.toThrow();
    expect(await fs.readdir(elsewhere)).toEqual([]);
    await expectMode(elsewhere, 0o755);
  });
  // Catches: a symlink planted at hud/beacons/ receiving our beacon (write) or losing a same-named file (remove).
  it.each([[undefined], [0]])('refuses a symlinked beacons directory for write and remove (noFollow %s) (mode bits POSIX-only)', async noFollow => {
    const { home, elsewhere } = await homeWithLink(h => path.join(hudDir(h), 'beacons'));
    await fs.writeFile(path.join(elsewhere, 'own.json'), 'foreign');
    await expect(beaconIO('write', 'own', beacon(), { home, noFollow })).rejects.toThrow();
    await expect(beaconIO('remove', 'own', null, { home, noFollow })).rejects.toThrow();
    expect(await fs.readFile(path.join(elsewhere, 'own.json'), 'utf8')).toBe('foreign');
    expect(await fs.readdir(elsewhere)).toEqual(['own.json']);
    await expectMode(elsewhere, 0o755);
  });
  // Catches: a hud directory planted by another user accepted as ours. The uid is injected: creating a directory
  // owned by another uid needs root, so the helper is told it runs as a different uid than the fixture's owner.
  it.skipIf(!process.getuid)('refuses a hud directory owned by another uid', async () => {
    const home = await fixture();
    const uid = process.getuid() + 1;
    await expect(beaconIO('aktion', 'own', receipt(), { home, uid })).rejects.toThrow();
    await expect(beaconIO('write', 'own', beacon(), { home, uid })).rejects.toThrow();
    await expect(fs.access(path.join(hudDir(home), 'aktionen.jsonl'))).rejects.toThrow();
    await expect(fs.access(path.join(hudDir(home), 'beacons'))).rejects.toThrow();
  });
  // Catches: a host without O_NOFOLLOW losing every receipt (headless runs leave no trace), or its fallback following a link.
  it('writes receipts without O_NOFOLLOW and still refuses a symlinked receipt file', async () => {
    const home = await fixture();
    const file = path.join(hudDir(home), 'aktionen.jsonl');
    await beaconIO('aktion', 'own', receipt(), { home, noFollow: 0 });
    expect(JSON.parse(await fs.readFile(file, 'utf8')).ergebnis).toBe('ausgefuehrt');
    await fs.rm(file);
    const elsewhere = path.join(home, 'elsewhere.txt');
    await fs.writeFile(elsewhere, 'original');
    await fs.symlink(elsewhere, file);
    await expect(beaconIO('aktion', 'own', receipt(), { home, noFollow: 0 })).rejects.toThrow();
    expect(await fs.readFile(elsewhere, 'utf8')).toBe('original');
  });
  it('rejects receipts outside the closed shape and writes nothing', async () => {
    const home = await fixture();
    for (const bad of [
      { ...receipt(), befehl: 'git push origin main' },
      { ...receipt(), toString: 'free text' },
      { ...receipt(), session_id: 'peer' },
      { ...receipt(), argv_sha256: 'A'.repeat(64) },
      { ...receipt(), argv_sha256: ['a'.repeat(64)] },
      { ...receipt(), art: 'push --force origin main' },
    ]) await expect(beaconIO('aktion', 'own', bad, { home })).rejects.toThrow('invalid receipt');
    await expect(fs.access(path.join(hudDir(home), 'aktionen.jsonl'))).rejects.toThrow();
  });
});

describe('mod pure logic', () => {
  it.each([
    ['Soll ich anfangen?', true], ['Sag weiter mit 2.', true], ['Die Pipeline läuft.', false],
    ['Fertig.\n```ts\nSoll ich?\n```', false], ['~~~\nweiter mit\n~~~\nStatus fertig.', false],
    ['Soll ich' + 'x'.repeat(401), false], ['Text\n```\nweiter mit', false],
  ])('owner question %j -> %s', (input, expected) => { expect(ownerQuestion(input)).toBe(expected); });
  it('validates enum, timestamp, path id and wait-reason coupling; dead stale is unknown', () => {
    expect(validateBeacon(beacon())).toBe(true);
    for (const change of [{ zustand: 'ok' }, { aktualisiert_at: 'yesterday' }, { session_id: '../x' }, { heuristisch: true }, { kontext_prozent: 101 }, { pid: -1 }, { zustand: 'wartet' }]) expect(validateBeacon({ ...beacon(), ...change })).toBe(false);
    expect(ageBeacon(beacon(), now + 120001, false).zustand).toBe('unbekannt');
    expect(ageBeacon(beacon(), now + 120001, true).zustand).toBe('bereit');
    expect(ageBeacon(beacon(), now + 120000, false).zustand).toBe('bereit');
    expect(completeState('Weiter mit 2.')).toEqual({ zustand: 'wartet', warte_grund: 'frage', heuristisch: true });
  });
  it('keeps untrusted gate, mirror and status text single-line and bounded', async () => {
    const root = await fixture();
    const s = await collectSnapshot(root, readers());
    const hostile = 'foreign\n\r\t\x1b\x00\u0085\u2028\u2029\u202e' + 'x'.repeat(1000);
    s.gate.last = { variant: hostile, passed: false, at: stamp, exit_code: 1 };
    s.vault.last_run = { at: stamp, failed: 1, aborted: hostile };
    s.state.session_type = hostile;
    s.wave.role = hostile;
    const warnings = findings(s, {}, null, now);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^Gate rot: foreign {9}/);
    for (const line of [...warnings, statusText(s, 'locker')]) {
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(line).toContain('foreign');
      expect(line).not.toContain('x'.repeat(121));
      expect(line.length).toBeLessThanOrEqual(800);
    }
    expect(warnings.every(line => line.length <= 120)).toBe(true);
  });
  // Catches (#1633): the HUD showing the dispatch list (wave.agents_total) as the agent count, an unknown count
  // (a live map older than the session) as a number, a missing measurement as 0 Agents, or decayed agents dropped.
  it.each([
    [{ running: 2, stale_reason: null, total: 5 }, '2 Agents'],
    [{ running: 0, stale_reason: null, total: 5 }, '0 Agents'],
    [{ running: null, stale_reason: 'older-than-session', total: 5 }, '? Agents'],
    [{ running: null, stale_reason: 'no-session', total: 5 }, null],
    [{ total: 5 }, null],
    // A parallel collector change counts agents without a Stop past 24 h apart: shown only when some decayed.
    [{ running: 3, stale_reason: null, decayed: 1, total: 5 }, '3 Agents (+1 ?)'],
    [{ running: 3, stale_reason: null, decayed: 0, total: 5 }, '3 Agents'],
    [{ running: 3, stale_reason: null, decayed: null, total: 5 }, '3 Agents'],
  ])('agents %j show %s', async ({ running, stale_reason, decayed, total }, shown) => {
    const s = await collectSnapshot(await fixture(), readers());
    s.wave = { number: 2, role: 'Impl-Core', agents_total: total };
    delete s.agents.running;
    delete s.agents.stale_reason;
    if (running !== undefined) Object.assign(s.agents, { running, stale_reason });
    if (decayed !== undefined) s.agents.decayed = decayed;
    const fields = statusText(s, 'locker').split(' · ');
    expect(fields.filter(f => / Agents\b/.test(f))).toEqual(shown === null ? [] : [shown]);
  });
  it('orders status fields and only raises the specified band findings', async () => {
    const root = await fixture();
    const s = await collectSnapshot(root, readers());
    s.state = { session_type: 'deep', total_waves: 5 };
    s.wave = { number: 2, role: 'Impl-Core', agents_total: 3 };
    s.agents.running = 3;
    s.agents.stale_reason = null;
    s.gate.last = { passed: true, at: stamp };
    s.peers = [{ gleiches_working_copy: true, scope_paths: null }];
    s.vault.last_run = { at: stamp, failed: 0, aborted: null };
    s.degraded = [];
    const line = statusText(s, 'locker');
    expect(line).toMatch(/^deep · W2\/5 · Impl-Core · 3 Agents · Gate ok \d\d:\d\d · 1 Peer · Vault \d\d:\d\d · locker$/);
    s.gate.last.passed = null;
    expect(statusText(s, 'streng')).not.toContain('Gate ok');
    expect(findings(null, {}, null, now)).toEqual([]);
    expect(findings(s, { percent: 80, tokens: 100000 }, new Date(now - 3600000).toISOString(), now)).toEqual(['Peer ohne bekannten Scope im selben Working Copy', 'Kontext 80 %', 'Cache kalt']);
    s.vault.enabled = false;
    expect(statusText(s, 'locker')).toContain('Vault aus');
    // Catches: a repo without a vault-integration block shown as an unknown "Vault ?" instead of not configured (#1552 F13);
    // an unreadable config stays unknown.
    s.vault.enabled = null;
    expect(statusText(s, 'locker')).toContain('Vault nicht eingerichtet');
    expect(statusText(s, 'locker', 'en')).toContain('Vault not configured');
    s.degraded = ['config:unreadable'];
    expect(statusText(s, 'locker')).toContain('Vault ? ·');
    // Catches (F13): a vault enabled but never mirrored shown as an unknown "Vault ?"; a run whose time does not parse stays "?".
    s.degraded = [];
    s.vault = { ...s.vault, enabled: true, last_run: null };
    expect(statusText(s, 'locker')).toContain('Vault noch kein Lauf ·');
    expect(statusText(s, 'locker', 'en')).toContain('Vault no run yet ·');
    s.vault.last_run = { at: 'gestern', failed: 0, aborted: null };
    expect(statusText(s, 'locker')).toContain('Vault ? ·');
    // Catches (F13): a fresh repo, where no session ever wrote events, marked "teilweise gemessen" although nothing is missing.
    s.degraded = ['events:absent'];
    expect(statusText(s, 'locker')).not.toContain('teilweise gemessen');
    s.degraded = ['events:absent', 'events:tail-only'];
    expect(statusText(s, 'locker')).toMatch(/ · teilweise gemessen$/);
  });
});

it('real CLI produces JSON with a fixture registry; records 20-run p95 without reading the host fleet', async ({ signal }) => {
  const root = await fixture({ 'CLAUDE.md': '# Project instructions\n', 'AGENTS.md': '## Session Config\n\nvault-integration:\n  enabled: false\n  mode: warn\n' });
  const cli = path.resolve('scripts/so-hud.mjs');
  const durations = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const result = await runCli([cli, '--json', '--repo-root', root], {
      cwd: root,
      env: { ...process.env, HOME: root, SO_SESSION_REGISTRY_DIR: path.join(root, 'registry'), SO_CONFIG_DIR: root },
    }, signal);
    durations.push(performance.now() - start);
    expect(result.status, result.stderr).toBe(0);
    const s = JSON.parse(result.stdout);
    expect(s.vault.enabled).toBe(false);
    expect(s.wave.running).toBe(false);
    expect(s.degraded).toContain('discovery-fallback');
  }
  const p95 = durations.sort((a, b) => a - b)[18];
  process.stdout.write(`so-hud fixture CLI: 20 runs, p95=${p95.toFixed(1)} ms\n`);
  // Report-only: wall-clock under shared-host load measures the host, not the code (#1625).
  if (p95 > 1500) process.stderr.write(`WARN so-hud fixture CLI p95=${p95.toFixed(1)} ms exceeds 1500 ms (report-only, #1625)\n`);
}, 30000);

it('ships the HUD manifest with a contributor author rather than personal identity', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../../mods/so-hud/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  expect(manifest.author).toEqual({ name: 'session-orchestrator contributors' });
});
