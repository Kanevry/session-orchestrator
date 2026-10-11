import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
  it('registers the installation with 0700 directory and 0600 file in a fixture home', async () => {
    const home = await fixture();
    expect(await main(['--register-root'], { home })).toBe(0);
    const dir = path.join(home, '.config/session-orchestrator/hud');
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path.join(dir, 'so-root'))).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(path.join(dir, 'so-root'), 'utf8')).trim()).toBe(path.resolve('.'));
  });
  it('atomically replaces only its own beacon at 0600 and deletes it at end', async () => {
    const home = await fixture();
    await beaconIO('write', 'own', beacon(), { home });
    await beaconIO('write', 'own', { ...beacon(), zustand: 'arbeitet' }, { home });
    const dir = path.join(home, '.config/session-orchestrator/hud/beacons');
    expect(await fs.readdir(dir)).toEqual(['own.json']);
    expect((await fs.stat(path.join(dir, 'own.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(path.join(dir, 'own.json'), 'utf8')).zustand).toBe('arbeitet');
    await expect(beaconIO('write', '../peer', beacon(), { home })).rejects.toThrow();
    await beaconIO('remove', 'own', null, { home });
    expect(await fs.readdir(dir)).toEqual([]);
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
  it('orders status fields and only raises the specified band findings', async () => {
    const root = await fixture();
    const s = await collectSnapshot(root, readers());
    s.state = { session_type: 'deep', total_waves: 5 };
    s.wave = { number: 2, role: 'Impl-Core', agents_total: 3 };
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
  });
});

it('real CLI produces JSON with a fixture registry; records 20-run p95 without reading the host fleet', async () => {
  const root = await fixture({ 'CLAUDE.md': '# Project instructions\n', 'AGENTS.md': '## Session Config\n\nvault-integration:\n  enabled: false\n  mode: warn\n' });
  const cli = path.resolve('scripts/so-hud.mjs');
  const durations = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const result = spawnSync(process.execPath, [cli, '--json', '--repo-root', root], {
      cwd: root, encoding: 'utf8', timeout: 3000,
      env: { ...process.env, HOME: root, SO_SESSION_REGISTRY_DIR: path.join(root, 'registry'), SO_CONFIG_DIR: root },
    });
    durations.push(performance.now() - start);
    expect(result.status, result.stderr).toBe(0);
    const s = JSON.parse(result.stdout);
    expect(s.vault.enabled).toBe(false);
    expect(s.wave.running).toBe(false);
    expect(s.degraded).toContain('discovery-fallback');
  }
  const p95 = durations.sort((a, b) => a - b)[18];
  process.stdout.write(`so-hud fixture CLI: 20 runs, p95=${p95.toFixed(1)} ms\n`);
  expect(p95).toBeLessThanOrEqual(1500);
}, 30000);

it('ships the HUD manifest with a contributor author rather than personal identity', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('../../mods/so-hud/.claude-plugin/plugin.json', import.meta.url), 'utf8'));
  expect(manifest.author).toEqual({ name: 'session-orchestrator contributors' });
});
