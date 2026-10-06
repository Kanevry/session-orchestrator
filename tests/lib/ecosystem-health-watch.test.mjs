/**
 * tests/lib/ecosystem-health-watch.test.mjs — the watcher that watched nothing.
 *
 * THE BUG THIS NAMES: `scripts/lib/ecosystem-health.mjs` `sleep()` carried
 * `t.unref?.()` on its poll timer. That timer is the ONLY handle the process
 * holds, so the event loop drained and node exited 0 the instant the first tick
 * was scheduled — measured 2026-09-06: exit 0 after **48 ms** instead of running
 * until SIGTERM, with an empty stderr. Its two siblings
 * (`scripts/lib/convergence-monitor.mjs`, `scripts/lib/wave-transcript-tail.mjs`)
 * were fixed for exactly this defect (#980 A1) and now carry an explicit
 * "deliberately NOT `unref()`d" comment; this file was the third copy, missed.
 *
 * WHY THIS MEASURES DURATION, NOT EXIT CODE: the anti-pattern is that "a monitor
 * that exits with 0 immediately looks like a healthy one — only the duration
 * separates them". An exit-code assertion passes on BOTH the healthy and the
 * dead watcher, so it cannot pin this bug at all.
 *
 * FALSIFICATION: restore `t.unref?.()` in `sleep()` and this test goes red
 * (the child exits after ~48 ms, well inside the 2.5 s observation window).
 *
 * HERMETIC: the child runs with `--interval=1` in a cwd whose STATE.md and
 * `.orchestrator/` do not exist, so it can only poll — it reads nothing real
 * and writes nothing anywhere. stdout/stderr are ignored; the child is SIGKILLed.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const SCRIPT = join(import.meta.dirname, '../../scripts/lib/ecosystem-health.mjs');

// Register before awaiting anything: exit 0 is still an early termination, and
// close (not kill's return value) proves the child and its stdio are finished.
function observeChild(child, startedAt) {
  let earlyExit = null;
  let spawnError = null;
  let killedAfterMs = null;
  let didClose = false;
  const closed = new Promise((resolve) => {
    child.on('error', (error) => { spawnError = error; });
    child.once('exit', (code, signal) => {
      if (killedAfterMs === null) {
        earlyExit = { code, signal, afterMs: performance.now() - startedAt };
      }
    });
    child.once('close', (code, signal) => {
      didClose = true;
      resolve({ code, signal, afterMs: performance.now() - startedAt });
    });
  });
  return {
    closed,
    diagnostics: () => ({ earlyExit, spawnError: spawnError?.message ?? null, killedAfterMs }),
    async stop() {
      let timeout;
      try {
        if (!didClose && killedAfterMs === null) {
          killedAfterMs = performance.now() - startedAt;
          child.kill('SIGKILL');
        }
        return await Promise.race([
          closed,
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('watcher did not close after SIGKILL')), 5000);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function waitUntil(deadline) {
  // Node can invoke a timer slightly early; rearm the remainder instead of
  // weakening the 2500 ms floor or measuring a separately adjustable wall clock.
  let remaining;
  while ((remaining = deadline - performance.now()) > 0) {
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(remaining)));
  }
}

describe('ecosystem-health --watch stays alive (#980 defect A1, third copy)', () => {
  it('is still running 2.5 s after start — measured by DURATION, not by exit code', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'eco-health-live-'));
    const startedAt = performance.now();
    const child = spawn(process.execPath, [SCRIPT, '--watch', '--interval=1'], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_ROOT: cwd },
      stdio: 'ignore',
    });
    const observed = observeChild(child, startedAt);
    let termination;
    try {
      await waitUntil(startedAt + 2500);
    } finally {
      termination = await observed.stop();
    }
    const diagnostics = observed.diagnostics();
    expect(diagnostics.spawnError, JSON.stringify(diagnostics)).toBeNull();
    expect(diagnostics.earlyExit, `watcher exited early: ${JSON.stringify(diagnostics)}`).toBeNull();
    expect(diagnostics.killedAfterMs).toBeGreaterThanOrEqual(2500);
    // An exit notification can arrive after the deadline callback. Requiring
    // the observed kill signal also catches an earlier, delayed exit 0.
    expect(termination.signal, JSON.stringify(termination)).toBe('SIGKILL');
  }, 15_000);
});

describe('ecosystem-health --watch project root (#1517)', () => {
  it('watches the state file of the PROJECT, not of CLAUDE_PLUGIN_ROOT', async () => {
    // Bug (#1517): the watcher took its root from `CLAUDE_PLUGIN_ROOT || cwd`,
    // and CLAUDE_PLUGIN_ROOT is the installed plugin directory — under Claude
    // Code it watched the plugin cache and never saw the repo's state file. The
    // startup event discriminates: `watcher.started` only when the resolved
    // file exists. Falsification: restore the CLAUDE_PLUGIN_ROOT fallback and
    // the first event becomes `no-state-yet`.
    const project = mkdtempSync(join(tmpdir(), 'eco-health-proj-'));
    const plugin = mkdtempSync(join(tmpdir(), 'eco-health-plugin-'));
    mkdirSync(join(project, '.orchestrator', 'metrics'), { recursive: true });
    writeFileSync(join(project, '.orchestrator', 'metrics', 'ecosystem-health.jsonl'), '{"ok":true}\n');
    const startedAt = performance.now();
    const child = spawn(process.execPath, [SCRIPT, '--watch', '--interval=1'], {
      cwd: plugin,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: plugin },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const observed = observeChild(child, startedAt);
    let deadline;
    let first;
    try {
      first = await Promise.race([
        new Promise((resolve, reject) => {
          let buf = '';
          deadline = setTimeout(() => resolve(null), 5000);
          child.stdout.on('data', (chunk) => {
            buf += chunk;
            const nl = buf.indexOf('\n');
            if (nl === -1) return;
            try {
              resolve(JSON.parse(buf.slice(0, nl)));
            } catch (error) {
              reject(error);
            }
          });
        }),
        observed.closed.then(() => null),
      ]);
    } finally {
      clearTimeout(deadline);
      await observed.stop();
    }
    expect(observed.diagnostics().spawnError).toBeNull();
    expect(first?.event).toBe('watcher.started');
  }, 15_000);
});
