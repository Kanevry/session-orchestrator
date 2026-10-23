// #1580 — so-hud agent count: lifecycle hooks feed the live-map, and a map older than the session is "?" not 0.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { collectSnapshot } from '../../scripts/lib/so-hud/collect.mjs';
import { LIFECYCLE_DECAY_MS, readCurrentStatus } from '../../scripts/lib/agent-status.mjs';
import { readLockDetailed } from '../../scripts/lib/session-lock.mjs';
import { main as soHudMain } from '../../scripts/so-hud.mjs';
import { fixtureGit } from '../_helpers/tmp-fixture.mjs';

const HOOK = path.join(process.cwd(), 'hooks/subagent-telemetry.mjs');
const SID = '3f1c2b9a-6d4e-4f7a-9b2c-1e5d8a7c6b40';
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(r => fs.rm(r, { recursive: true, force: true }))); });

async function sandbox(lockStartedAt) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'so-hud-agents-'));
  roots.push(root);
  await fs.mkdir(path.join(root, '.orchestrator/runtime'), { recursive: true });
  await fs.writeFile(path.join(root, '.orchestrator/session.lock'), JSON.stringify({
    session_id: SID, semantic_session_id: 'main-2026-10-14-session-94', started_at: lockStartedAt,
    last_heartbeat: lockStartedAt, pid: process.pid, host: os.hostname(), mode: 'deep', ttl_hours: 4, schema_version: 2,
  }));
  return root;
}

const readers = (root, now) => ({
  now: () => now, readText: p => fs.readFile(p, 'utf8'), lock: r => readLockDetailed({ repoRoot: r }), isLockLive: () => true,
  agents: r => readCurrentStatus({ repoRoot: r, now }), discover: async () => ({ sessions: [], degraded: [] }),
  events: async () => ({ text: '', degraded: [] }), config: async () => ({ enabled: null, mode: null }),
});

describe('so-hud agents (#1580)', () => {
  it('reports a live-map older than the running session as unknown, never as 0 agents', async () => {
    // Bug: a 4-day-old agent-status-current.json was reported as source live-map, and the HUD showed "0 Agents".
    const now = Date.parse('2026-10-12T10:00:00Z');
    const root = await sandbox('2026-10-12T09:00:00Z');
    const old = { agentId: 'w2-a-1', kind: 'status', text: 'running', ts: '2026-10-08T12:00:00.000Z' };
    await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status-current.json'), JSON.stringify({ [old.agentId]: old }));
    await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status.jsonl'), `${JSON.stringify(old)}\n`);

    const s = await collectSnapshot(root, readers(root, now));
    expect(s.agents).toMatchObject({ source: 'stale-cache', running: null, stale_reason: 'older-than-session', at: old.ts });
  });

  it('counts subagents started via SubagentStart/SubagentStop without any wave-executor self-report', async () => {
    // Bug: the lifecycle hooks wrote only subagents.jsonl, so a non-wave-executor subagent never reached the HUD.
    const root = await sandbox(new Date(Date.now() - 60_000).toISOString());
    const registry = await fs.mkdtemp(path.join(os.tmpdir(), 'so-hud-registry-'));
    roots.push(registry);
    const fire = payload => spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SID, cwd: root, ...payload }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: root, SO_SESSION_REGISTRY_DIR: registry, SO_HOOK_PROFILE: 'full', SO_DISABLED_HOOKS: '' },
    });
    for (const id of ['a1', 'a2', 'a3']) expect(fire({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'code-implementer' }).status).toBe(0);
    expect(fire({ hook_event_name: 'SubagentStop', agent_id: 'a2' }).status).toBe(0);
    // Phantom stop (#939): no start record, fresh id — must not create an entry.
    expect(fire({ hook_event_name: 'SubagentStop', agent_id: 'phantom' }).status).toBe(0);

    const s = await collectSnapshot(root, readers(root, Date.now()));
    expect(s.agents.running).toBe(2);
    expect(s.agents.stale_reason).toBeNull();
    expect(Object.fromEntries(s.agents.entries.map(e => [e.id, e.status]))).toEqual({ a1: 'running', a2: 'done', a3: 'running' });
    expect(s.agents.entries[0].typ).toBe('code-implementer');
  });

  it('reads 0 agents once the lifecycle writer is proven, and "?" only without any lifecycle record', async () => {
    // Bug: every fresh session showed "?" even with the hook writer wired, a signal that nearly always fires (HR-101).
    const now = Date.parse('2026-10-12T10:00:00Z');
    const foreign = kind => ({ agentId: 'x1', kind, status: 'done', text: 'done', session_id: 'b7e0c3d1-0000-4000-8000-000000000001', ts: '2026-10-08T12:00:00.000Z' });
    const seed = async rec => {
      const root = await sandbox('2026-10-12T09:00:00Z');
      await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status-current.json'), JSON.stringify({ x1: rec }));
      await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status.jsonl'), `${JSON.stringify(rec)}\n`);
      return (await collectSnapshot(root, readers(root, now))).agents;
    };
    expect(await seed(foreign('lifecycle'))).toMatchObject({ running: 0, stale_reason: null, source: 'live-map' });
    expect(await seed(foreign('status'))).toMatchObject({ running: null, stale_reason: 'older-than-session', source: 'stale-cache' });
  });

  it('reports a running agent without SubagentStop past the decay bound as decayed, not running', async () => {
    // Bug (#1633): an agent whose SubagentStop never arrived counted as running for the rest of its session.
    const now = Date.parse('2026-10-14T10:00:00Z');
    const root = await sandbox('2026-10-12T09:00:00Z');
    const rec = (agentId, ts) => ({ agentId, kind: 'lifecycle', status: 'running', session_id: SID, ts });
    const lost = rec('lost', new Date(now - LIFECYCLE_DECAY_MS - 1).toISOString());
    const live = rec('live', new Date(now - 60_000).toISOString());
    await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status-current.json'), JSON.stringify({ lost, live }));
    await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status.jsonl'), `${JSON.stringify(lost)}\n${JSON.stringify(live)}\n`);

    const s = await collectSnapshot(root, readers(root, now));
    expect(s.agents).toMatchObject({ running: 1, decayed: 1, stale_reason: null });
    expect(Object.fromEntries(s.agents.entries.map(e => [e.id, e.status]))).toEqual({ lost: 'decayed', live: 'running' });
  });

  it('keeps source absent when no map exists at all', async () => {
    // Bug: a missing map was relabelled stale-cache although there is no cache.
    const root = await sandbox('2026-10-12T09:00:00Z');
    const s = await collectSnapshot(root, readers(root, Date.parse('2026-10-12T10:00:00Z')));
    expect(s.agents).toMatchObject({ source: 'absent', running: null, stale_reason: 'older-than-session' });
  });

  it('does not mark agents degraded for a verified live map whose ledger outgrew the rebuild window', async () => {
    // Bug: past 256 KiB of ledger (~640 subagents) every poll reported agents:degraded for good.
    const root = await sandbox('2026-10-12T09:00:00Z');
    const map = {};
    const lines = [];
    for (let i = 0; i < 1700; i++) {
      const rec = { agentId: `a${String(i).padStart(5, '0')}`, kind: 'lifecycle', status: 'done', session_id: SID, agent_type: 'code-implementer', ts: new Date(Date.parse('2026-10-12T09:01:00Z') + i).toISOString() };
      map[rec.agentId] = rec;
      lines.push(JSON.stringify(rec));
    }
    await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status-current.json'), JSON.stringify(map));
    await fs.writeFile(path.join(root, '.orchestrator/runtime/agent-status.jsonl'), `${lines.join('\n')}\n`);
    expect((await fs.stat(path.join(root, '.orchestrator/runtime/agent-status.jsonl'))).size).toBeGreaterThan(256 * 1024);

    const s = await collectSnapshot(root, readers(root, Date.parse('2026-10-12T10:00:00Z')));
    expect(s.agents.degraded?.reasons).toEqual(['tail-truncated']);
    expect(s.agents).toMatchObject({ source: 'live-map', running: 0 });
    expect(s.degraded).not.toContain('agents:degraded');
  });

  it('writes the map beside the session lock, not into the launch checkout', async () => {
    // Bug class: a session whose lock moved into a worktree (#1605) fed a map the HUD of that worktree never reads.
    const launch = await fs.mkdtemp(path.join(os.tmpdir(), 'so-hud-launch-'));
    roots.push(launch);
    const worktree = await sandbox(new Date(Date.now() - 60_000).toISOString());
    const registry = await fs.mkdtemp(path.join(os.tmpdir(), 'so-hud-registry-'));
    roots.push(registry);
    await fs.mkdir(path.join(registry, 'active'), { recursive: true });
    await fs.writeFile(path.join(registry, 'active', `${SID}.json`), JSON.stringify({ session_id: SID, session_root: worktree, work_root: worktree, last_heartbeat: new Date().toISOString() }));
    const run = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SID, cwd: launch, hook_event_name: 'SubagentStart', agent_id: 'w1', agent_type: 'code-implementer' }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: launch, SO_SESSION_REGISTRY_DIR: registry, SO_HOOK_PROFILE: 'full', SO_DISABLED_HOOKS: '' },
    });
    expect(run.status).toBe(0);
    const map = JSON.parse(await fs.readFile(path.join(worktree, '.orchestrator/runtime/agent-status-current.json'), 'utf8'));
    expect(map.w1).toMatchObject({ status: 'running', session_id: SID });
    await expect(fs.stat(path.join(launch, '.orchestrator/runtime/agent-status-current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('counts the agents beside the own lock when the HUD measures another checkout (--session-id, #1730)', async () => {
    // Bug: the lock sits in the main checkout, the session works in a worktree, and the mod measures the worktree.
    // The writer put the agent beside the lock; the HUD read the worktree and showed no running agent.
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'so-hud-own-root-'));
    roots.push(base);
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    fixtureGit(['init', '-b', 'main', main], undefined, { stdio: 'ignore' });
    fixtureGit(['-c', 'user.email=test@example.invalid', '-c', 'user.name=Test', 'commit', '--allow-empty', '--no-verify', '-m', 'init'], main, { stdio: 'ignore' });
    fixtureGit(['worktree', 'add', '-b', 'wt', wt], main, { stdio: 'ignore' });
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    await fs.mkdir(path.join(main, '.orchestrator'), { recursive: true });
    await fs.writeFile(path.join(main, '.orchestrator/session.lock'), JSON.stringify({
      session_id: SID, started_at: startedAt, last_heartbeat: startedAt, pid: process.pid, host: os.hostname(), mode: 'deep', ttl_hours: 4, schema_version: 2,
    }));
    const registry = path.join(base, 'registry');
    await fs.mkdir(path.join(registry, 'active'), { recursive: true });
    await fs.writeFile(path.join(registry, 'active', `${SID}.json`), JSON.stringify({ session_id: SID, session_root: main, work_root: wt, last_heartbeat: new Date().toISOString() }));
    const fired = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SID, cwd: wt, hook_event_name: 'SubagentStart', agent_id: 'w1', agent_type: 'code-implementer' }), encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: main, SO_SESSION_REGISTRY_DIR: registry, SO_HOOK_PROFILE: 'full', SO_DISABLED_HOOKS: '' },
    });
    expect(fired.status).toBe(0);

    const prev = process.env.SO_SESSION_REGISTRY_DIR;
    process.env.SO_SESSION_REGISTRY_DIR = registry;
    try {
      const hud = async args => {
        let out = '';
        expect(await soHudMain(['--json', '--repo-root', wt, ...args], { output: v => { out += v; } })).toBe(0);
        return JSON.parse(out).agents;
      };
      expect((await hud([])).running).not.toBe(1);
      expect(await hud(['--session-id', SID])).toMatchObject({ running: 1, stale_reason: null });
    } finally {
      if (prev === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
      else process.env.SO_SESSION_REGISTRY_DIR = prev;
    }
  });
});
