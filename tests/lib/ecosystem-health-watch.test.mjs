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

const SCRIPT = join(import.meta.dirname, '../../scripts/lib/ecosystem-health.mjs');

describe('ecosystem-health --watch stays alive (#980 defect A1, third copy)', () => {
  it('is still running 2.5 s after start — measured by DURATION, not by exit code', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'eco-health-live-'));
    const child = spawn(process.execPath, [SCRIPT, '--watch', '--interval=1'], {
      cwd,
      env: { ...process.env, CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_ROOT: cwd },
      stdio: 'ignore',
    });

    const t0 = Date.now();
    /** @type {{code: number|null, afterMs: number}|null} */
    let earlyExit = null;
    child.on('exit', (code) => {
      earlyExit = { code, afterMs: Date.now() - t0 };
    });

    return new Promise((r) => setTimeout(r, 2500))
      .then(() => {
        // The assertion message carries the measurement, so a red run reports
        // "exited 0 after 48ms" rather than a bare `true !== false`.
        expect(earlyExit, `watcher exited early: ${JSON.stringify(earlyExit)}`).toBeNull();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(2500);
      })
      .finally(() => {
        child.kill('SIGKILL');
      });
  }, 15_000);
});

describe('ecosystem-health --watch project root (#1517)', () => {
  it('watches the state file of the PROJECT, not of CLAUDE_PLUGIN_ROOT', () => {
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
    const child = spawn(process.execPath, [SCRIPT, '--watch', '--interval=1'], {
      cwd: plugin,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_ROOT: plugin },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return new Promise((resolve) => {
      let buf = '';
      const deadline = setTimeout(() => resolve(null), 5000);
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(deadline);
        resolve(JSON.parse(buf.slice(0, nl)));
      });
    })
      .then((first) => {
        expect(first?.event).toBe('watcher.started');
      })
      .finally(() => {
        child.kill('SIGKILL');
      });
  }, 15_000);
});
