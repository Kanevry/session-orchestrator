/**
 * trigger.test.mjs — `maybeTriggerOrphanScan`, the ONE orphan-scan trigger both
 * hooks call (#1432 B4, consolidated in #1489).
 *
 * These cases lived twice — once in tests/hooks/on-stop.test.mjs, once in
 * tests/hooks/post-tool-batch.test.mjs — 11 identical titles over two verbatim
 * copies of the trigger. One implementation, one set of tests; each hook keeps
 * exactly one wiring case proving it really calls this trigger.
 *
 * No case spawns a real child: every spawn goes through an injected `spawnFn`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { maybeTriggerOrphanScan } from '../../../scripts/lib/orphan-reaper/trigger.mjs';

describe('maybeTriggerOrphanScan', () => {
  let rtmp;

  beforeEach(() => { rtmp = mkdtempSync(join(tmpdir(), 'reaper-trigger-')); });
  afterEach(() => { rmSync(rtmp, { recursive: true, force: true }); });

  /** Record every spawn the trigger attempts, without ever spawning. */
  function recordingSpawn(calls) {
    return (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return { unref() {} };
    };
  }

  function writeClaudeMd(body) {
    writeFileSync(join(rtmp, 'CLAUDE.md'), body, 'utf8');
  }

  it('does nothing when no CLAUDE.md/AGENTS.md exists', async () => {
    // Bug: an unreadable config defaulting to ENABLED would arm a signal-sending
    // watchdog on every repo that has no Session Config at all.
    const calls = [];
    const r = await maybeTriggerOrphanScan({ projectDir: rtmp, spawnFn: recordingSpawn(calls) });
    expect(r).toEqual({ spawned: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
  });

  it('reaper.enabled: false → no stat, no spawn', async () => {
    // Bug: the default-off block still paying for a marker stat on every hook.
    writeClaudeMd('reaper:\n  enabled: false\n');
    const calls = [];
    const stats = [];
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      statFn: (p) => { stats.push(p); throw new Error('nope'); },
    });
    expect(r).toEqual({ spawned: false, reason: 'disabled' });
    expect(calls).toHaveLength(0);
    expect(stats).toHaveLength(0);
  });

  it('spawns exactly one detached child when armed and the marker is absent', async () => {
    writeClaudeMd('reaper:\n  enabled: true\n');
    const calls = [];
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: true, reason: 'spawned' });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.cmd).toBe(process.execPath);
    expect(call.opts).toMatchObject({ detached: true, stdio: 'ignore' });
    // argv shape: <scriptPath> --repo-root <p> --mode <m> --min-age-seconds …
    // The script path is argv[0] — no `--input-type=module -e <program>` any
    // more, so nothing the trigger builds is executable source at all.
    expect(call.args[0]).toMatch(/orphan-reaper\.mjs$/);
    expect(call.args[0].startsWith('file://')).toBe(false);
    expect(call.args.slice(1, 5)).toEqual(['--repo-root', rtmp, '--mode', 'report']);
    // Bug: a checkout path reaching the child as anything but its OWN argv
    // value (an interpolated `-e` program, a concatenated `--repo-root=<p>`)
    // is code or an unparseable flag, not a value.
    expect(call.args).not.toContain('-e');
    expect(call.args.filter((a) => a.includes(rtmp))).toEqual([rtmp]);
  });

  it('the throttle skips the spawn when the marker is fresh', async () => {
    // Bug (PRD FA4, second scenario): without the throttle a PostToolBatch storm
    // spawns one ps-running child per tool call.
    writeClaudeMd('reaper:\n  enabled: true\n  min-scan-interval-seconds: 30\n');
    const calls = [];
    const now = 1_000_000;
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      now,
      spawnFn: recordingSpawn(calls),
      statFn: () => ({ mtimeMs: now - 5_000 }),
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: false, reason: 'throttled' });
    expect(calls).toHaveLength(0);
  });

  it('spawns again once the interval has elapsed', async () => {
    writeClaudeMd('reaper:\n  enabled: true\n  min-scan-interval-seconds: 30\n');
    const calls = [];
    const now = 1_000_000;
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      now,
      spawnFn: recordingSpawn(calls),
      statFn: () => ({ mtimeMs: now - 31_000 }),
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: true, reason: 'spawned' });
    expect(calls).toHaveLength(1);
  });

  it('reports an unstamped throttle instead of a normal spawn when the marker could not be written', async () => {
    // Bug (#1487 item 6): touchScanMarker's `false` was dropped, so a marker the
    // hook can never stamp (a planted link, a read-only tmp dir) — every fire
    // spawning a scan — returned exactly what a throttled spawn returns. The
    // scan still runs: the throttle fails toward scanning, never toward a
    // silently disabled reaper.
    writeClaudeMd('reaper:\n  enabled: true\n');
    const calls = [];
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      writeFn: () => { throw new Error('EACCES'); },
    });
    expect(r).toEqual({ spawned: true, reason: 'spawned-unthrottled' });
    expect(calls).toHaveLength(1);
  });

  it('passes mode: kill through to the child', async () => {
    writeClaudeMd('reaper:\n  enabled: true\n  mode: kill\n  min-age-seconds: 600\n');
    const calls = [];
    await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      writeFn: () => {},
    });
    expect(calls[0].args.slice(3, 7))
      .toEqual(['--mode', 'kill', '--min-age-seconds', '600']);
  });

  it('passes reaper.false-alarm-window through to the child — the key had NO consumer before 2026-09-22', async () => {
    // Bug: `false-alarm-window` was parsed, defaulted, documented and never
    // sent anywhere. `runOrphanScan` hard-coded REAPER_DEFAULTS, so configuring
    // it changed nothing at all — a config key that only its parser knows.
    writeClaudeMd('reaper:\n  enabled: true\n  false-alarm-window: 25\n');
    const calls = [];
    await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: recordingSpawn(calls),
      writeFn: () => {},
    });
    const i = calls[0].args.indexOf('--false-alarm-window');
    expect(i).toBeGreaterThan(0);
    expect(calls[0].args[i + 1]).toBe('25');
  });

  it('WARNS on stderr when the trigger overran reaper.max-hook-latency-ms, and stays silent inside it', async () => {
    // Bug: `max-hook-latency-ms` was a documented budget nothing measured
    // against — the only "enforcement" was the prose claim that the scan runs
    // detached. A budget with no measurement cannot be exceeded OR held.
    writeClaudeMd('reaper:\n  enabled: true\n  max-hook-latency-ms: 5\n');
    const written = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    try {
      // A clock that jumps 12 ms between entry and the post-spawn check.
      let t = 0;
      await maybeTriggerOrphanScan({
        projectDir: rtmp,
        spawnFn: () => ({ unref() {} }),
        writeFn: () => {},
        clockFn: () => { const v = t; t += 12; return v; },
      });
      expect(written.join('')).toMatch(/hook latency 12\.0 ms exceeded reaper\.max-hook-latency-ms \(5 ms\)/);

      written.length = 0;
      let t2 = 0;
      await maybeTriggerOrphanScan({
        projectDir: rtmp,
        spawnFn: () => ({ unref() {} }),
        writeFn: () => {},
        clockFn: () => { const v = t2; t2 += 1; return v; },
      });
      expect(written).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('reads an unresolvable project dir as disabled, not as error (#1498)', () => {
    // Bug: `getProjectDir()` ran inside the catch-all BEFORE the enabled check,
    // so a hook started in a deleted cwd (process.cwd() → ENOENT, no
    // *_PROJECT_DIR) answered `error` — and on-stop stamps `reaper_trigger`
    // for every reason but `disabled`, on a host whose reaper is OFF.
    // Production shape: a real process whose cwd is gone before node starts.
    const gone = mkdtempSync(join(tmpdir(), 'reaper-trigger-cwd-'));
    const env = { ...process.env };
    for (const k of ['CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'PI_PROJECT_DIR']) delete env[k];
    const url = pathToFileURL(join(process.cwd(), 'scripts', 'lib', 'orphan-reaper', 'trigger.mjs')).href;
    // A script FILE, like the hooks: `node -e` itself dies on the missing cwd.
    const probe = join(rtmp, 'probe.mjs');
    writeFileSync(probe, `const { maybeTriggerOrphanScan } = await import(${JSON.stringify(url)});\n`
      + 'process.stdout.write(JSON.stringify(await maybeTriggerOrphanScan()));\n');
    const r = spawnSync('/bin/sh', ['-c', 'cd "$1" && rmdir "$1" && exec "$2" "$3"',
      'sh', gone, process.execPath, probe], { env, encoding: 'utf8', timeout: 30_000 });
    expect(r.status, JSON.stringify({ signal: r.signal, stderr: r.stderr, errorCode: r.error?.code })).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ spawned: false, reason: 'disabled' });
  });

  it('degrades silently when the spawn throws', async () => {
    // Bug (PRD FA4): the hook must never fail because the reaper did.
    writeClaudeMd('reaper:\n  enabled: true\n');
    const r = await maybeTriggerOrphanScan({
      projectDir: rtmp,
      spawnFn: () => { throw new Error('EAGAIN'); },
      writeFn: () => {},
    });
    expect(r).toEqual({ spawned: false, reason: 'error' });
  });

  it('returns within reaper.max-hook-latency-ms (50 ms)', async () => {
    // Bug: running the scan inline. One ps round-trip out of Node was measured
    // at ~47 ms over 287 KB — alone enough to blow the budget.
    writeClaudeMd('reaper:\n  enabled: true\n');
    const spawnFn = () => ({ unref() {} });
    // Warm the dynamic import so the measurement is the STEADY-STATE cost the
    // hook pays, not the one-off module load of the very first tool batch.
    await maybeTriggerOrphanScan({ projectDir: rtmp, spawnFn, writeFn: () => {} });
    const started = performance.now();
    await maybeTriggerOrphanScan({ projectDir: rtmp, spawnFn, writeFn: () => {} });
    expect(performance.now() - started).toBeLessThan(50);
  });
});
