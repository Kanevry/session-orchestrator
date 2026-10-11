import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverActiveSessions } from '../session-discovery.mjs';
import { readRegistry, activeDir } from '../session-registry.mjs';
import { readCurrentStatus } from '../agent-status.mjs';
import { readLockDetailed, isLockLive } from '../session-lock.mjs';
import { readTailWindow } from '../tail-window.mjs';
import { parseSessionConfig } from '../config.mjs';
import { resolveStateMdPath } from '../state-md.mjs';
import { collectSnapshot } from './collect.mjs';
const exec = promisify(execFile);
export const MAX_EVENT_BYTES = 512 * 1024;

export function readEventTail(repoRoot) {
  try {
    const tail = readTailWindow(path.join(repoRoot, '.orchestrator/metrics/events.jsonl'), MAX_EVENT_BYTES);
    return { text: tail.cut ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text, degraded: tail.cut ? ['events:tail-only'] : [] };
  } catch (e) { return { text: '', degraded: [e.code === 'ENOENT' ? 'events:absent' : 'events:unreadable'] }; }
}

async function registryWithHealth() {
  // The canonical reader intentionally swallows failures; distinguish its directory first.
  try { await fs.readdir(activeDir()); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return readRegistry();
}

/** Capture fallback at the injected boundaries, without intercepting global stderr. */
export async function discover(repoRoot, { run = exec, registry = registryWithHealth, discovery = discoverActiveSessions, now = Date.now() } = {}) {
  const degraded = [];
  let registryEntries = [];
  const sessions = await discovery(repoRoot, {
    now, timeoutMs: 1000,
    listWorktreesImpl: async () => {
      try {
        const { stdout } = await run('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], { timeout: 700, maxBuffer: 512 * 1024 });
        return stdout.trim().split('\n\n').filter(Boolean).map(block => {
          const lines = block.split('\n');
          return { path: lines.find(l => l.startsWith('worktree '))?.slice(9), branch: lines.find(l => l.startsWith('branch '))?.slice(7).replace(/^refs\/heads\//, '') ?? '' };
        }).filter(w => w.path);
      } catch (e) {
        degraded.push(e.killed || e.code === 'ETIMEDOUT' ? 'discovery-timeout' : 'discovery-fallback');
        return [{ path: repoRoot, branch: '' }];
      }
    },
    registryReader: async () => {
      try { registryEntries = await registry(); return registryEntries; } catch { degraded.push('registry-unreadable'); return []; }
    },
  });
  if (sessions.some(s => s.registryOnly)) degraded.push('discovery:registry-fallback');
  return { sessions: sessions.map(s => ({ ...s, last_heartbeat: registryEntries.find(r => r.session_id === s.sessionId)?.last_heartbeat ?? null })), degraded };
}

async function config(repoRoot) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const source = await fs.readFile(path.join(repoRoot, name), 'utf8');
      if (!/^vault-integration:/m.test(source)) return { enabled: null, mode: null };
      // No host-local owner.yaml reads and no vault path resolution outside this repo.
      const parsed = parseSessionConfig(source, { hostPaths: { env: {}, ownerConfig: {} } });
      const value = parsed['vault-integration'];
      return { enabled: value?.enabled ?? null, mode: value?.mode ?? null };
    } catch (e) { if (e.code !== 'ENOENT') return { degraded: ['config:unreadable'] }; }
  }
  return { enabled: null, mode: null };
}
export async function measure(repoRoot) {
  return collectSnapshot(repoRoot, {
    now: Date.now, readText: file => fs.readFile(file, 'utf8'), lock: root => readLockDetailed({ repoRoot: root }),
    isLockLive, agents: root => readCurrentStatus({ repoRoot: root }), discover, events: readEventTail, config,
    statePath: path.relative(repoRoot, resolveStateMdPath(repoRoot)),
    sessionId: process.env.CLAUDE_SESSION_ID ?? process.env.SO_SESSION_ID ?? null,
  });
}
