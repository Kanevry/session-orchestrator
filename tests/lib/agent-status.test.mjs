/**
 * tests/lib/agent-status.test.mjs
 *
 * Vitest tests for scripts/lib/agent-status.mjs (issue #565).
 *
 * Exports under test:
 *   setStatus, setProgress, readCurrentStatus
 *
 * Strategy:
 *   - Each test runs against a fresh tmp dir passed as `repoRoot`, so the
 *     repo's real `.orchestrator/runtime/` is never touched.
 *   - Real filesystem behaviour (no test-the-mock): we assert on the JSONL
 *     stream contents AND the LWW current-map that the SUT actually writes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { setStatus, setProgress, readCurrentStatus } from '@lib/agent-status.mjs';

// Absolute path to the REAL production module — the cross-process race test
// spawns separate `node` processes that import THIS file (not the @lib alias,
// which only resolves inside the vitest process).
const AGENT_STATUS_MODULE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'lib',
  'agent-status.mjs',
);

const RUNTIME = '.orchestrator/runtime';
const JSONL = join(RUNTIME, 'agent-status.jsonl');
const CURRENT = join(RUNTIME, 'agent-status-current.json');
const LOCK = join(RUNTIME, 'agent-status.lock');

let repoRoot;

beforeEach(() => {
  repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'agent-status-')));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

/** Read the JSONL stream as an array of parsed records. */
function readJsonl() {
  const p = join(repoRoot, JSONL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

describe('agent-status — setStatus', () => {
  it('writes the value into the current map and one JSONL line', async () => {
    const res = await setStatus('agent-1', 'building wave 2', { repoRoot });
    expect(res).toEqual({ ok: true });

    const map = readCurrentStatus({ repoRoot });
    expect(map['agent-1']).toMatchObject({
      agentId: 'agent-1',
      kind: 'status',
      text: 'building wave 2',
    });
    expect(typeof map['agent-1'].ts).toBe('string');

    const lines = readJsonl();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agentId: 'agent-1', kind: 'status', text: 'building wave 2' });
  });

  it('truncates over-long text to keep the JSONL line under PIPE_BUF', async () => {
    const long = 'x'.repeat(1000);
    const res = await setStatus('agent-long', long, { repoRoot });
    expect(res).toEqual({ ok: true });

    const map = readCurrentStatus({ repoRoot });
    expect(map['agent-long'].text.length).toBe(256);

    const lines = readJsonl();
    expect(Buffer.byteLength(JSON.stringify(lines[0]) + '\n', 'utf8')).toBeLessThan(512);
  });
});

describe('agent-status — setProgress', () => {
  it('carries {step,total,label} into the map and a progress JSONL line', async () => {
    const res = await setProgress('agent-2', { step: 3, total: 7, label: 'typecheck' }, { repoRoot });
    expect(res).toEqual({ ok: true });

    const map = readCurrentStatus({ repoRoot });
    expect(map['agent-2']).toMatchObject({
      agentId: 'agent-2',
      kind: 'progress',
      step: 3,
      total: 7,
      label: 'typecheck',
    });

    const lines = readJsonl();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ agentId: 'agent-2', kind: 'progress', step: 3, total: 7, label: 'typecheck' });
  });

  it('omits the label field when not provided', async () => {
    const res = await setProgress('agent-3', { step: 1, total: 2 }, { repoRoot });
    expect(res).toEqual({ ok: true });

    const map = readCurrentStatus({ repoRoot });
    expect(map['agent-3'].label).toBeUndefined();
    expect(map['agent-3']).toMatchObject({ kind: 'progress', step: 1, total: 2 });
  });
});

describe('agent-status — LWW semantics', () => {
  it('keeps the LATER value when the same agentId is written twice', async () => {
    await setStatus('agent-lww', 'first', { repoRoot });
    await setStatus('agent-lww', 'second', { repoRoot });

    const map = readCurrentStatus({ repoRoot });
    expect(map['agent-lww'].text).toBe('second');

    // Both pushes still produced JSONL lines (append-only log keeps history).
    const lines = readJsonl().filter((r) => r.agentId === 'agent-lww');
    expect(lines).toHaveLength(2);
    expect(lines.map((r) => r.text)).toEqual(['first', 'second']);
  });
});

describe('agent-status — in-process interleaved writers (LWW-map completeness)', () => {
  // NOTE: This test does NOT verify the cross-process write-mutex. The RMW
  // critical section in agent-status.mjs (acquireLock → read map → set key →
  // writeJsonAtomicSync → releaseLock) is fully synchronous, so Node's single
  // thread serialises these `Promise.all` writers trivially — the lock is never
  // contended in-process. What this DOES verify: across the `await appendJsonl`
  // suspension points (the only `await` boundary each writer crosses), the LWW
  // map still ends up complete and every writer's append lands exactly once.
  // The real cross-PROCESS race coverage is in the next describe block.
  it('records ALL keys across interleaved in-process writers (no append/RMW drop)', async () => {
    const ids = ['c-0', 'c-1', 'c-2', 'c-3', 'c-4'];
    const results = await Promise.all(
      ids.map((id) => setStatus(id, `status ${id}`, { repoRoot })),
    );

    // Every push succeeded.
    for (const r of results) expect(r).toEqual({ ok: true });

    // The LWW map carries ALL keys — no interleaved write lost an update.
    const map = readCurrentStatus({ repoRoot });
    expect(Object.keys(map).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(map[id]).toMatchObject({ agentId: id, kind: 'status', text: `status ${id}` });
    }

    // The append-only log has exactly one line per writer.
    expect(readJsonl()).toHaveLength(ids.length);
  });
});

describe('agent-status — cross-PROCESS concurrent-writer race (AC)', () => {
  /**
   * Spawn a real child `node` process that imports the production module by its
   * absolute path and calls setStatus against the SHARED repoRoot. Returns a
   * promise that resolves with { code, stderr } on exit. Using spawn (not
   * spawnSync) and awaiting all promises together is what produces genuine
   * OS-level concurrency — N processes contend for the file write-mutex at once.
   */
  function spawnSetStatus(agentId) {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          // process.argv after `-e <code>` is: [execPath, modulePath, agentId, repoRoot]
          "import(process.argv[1]).then((m) => m.setStatus(process.argv[2], 'cross-proc', { repoRoot: process.argv[3] })).then((r) => process.exit(r && r.ok ? 0 : 1)).catch(() => process.exit(2))",
          AGENT_STATUS_MODULE,
          agentId,
          repoRoot,
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('exit', (code) => resolve({ code, stderr }));
    });
  }

  // This test FAILS WITHOUT the lock: PoC-verified — neutering acquireLock to a
  // no-op (so the RMW races unguarded) loses updates (observed 4/8 keys), and
  // both assertions below trip. With the real lock the file write-mutex
  // serialises the 8 cross-process RMWs, so all 8 keys survive. The
  // in-process test above cannot catch this — it never exercises the mutex.
  it('preserves ALL keys and one JSONL line per writer across 8 concurrent processes', async () => {
    const N = 8;
    const ids = Array.from({ length: N }, (_, i) => `xp-${i}`);

    // Spawn all N first, THEN await — maximises true OS-level concurrency so the
    // file write-mutex is genuinely contended (NOT serialised by a spawn loop).
    const outcomes = await Promise.all(ids.map((id) => spawnSetStatus(id)));

    // Every child process exited 0 (setStatus returned { ok: true }).
    for (const { code, stderr } of outcomes) {
      expect(stderr).toBe('');
      expect(code).toBe(0);
    }

    // The LWW map carries ALL 8 keys — no cross-process RMW lost an update.
    const map = readCurrentStatus({ repoRoot });
    expect(Object.keys(map).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      expect(map[id]).toMatchObject({ agentId: id, kind: 'status', text: 'cross-proc' });
    }

    // The append-only JSONL log has exactly N lines — one per writer process.
    expect(readJsonl()).toHaveLength(N);
  }, 30000);
});

describe('agent-status — stale-lock recovery (AC)', () => {
  it('overrides a same-host dead-PID lock and still succeeds', async () => {
    const lockFile = join(repoRoot, LOCK);
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    // Pre-seed a stale lock: this host, a PID that cannot be alive.
    writeFileSync(
      lockFile,
      JSON.stringify({ pid: 999999, host: hostname(), acquiredAt: new Date().toISOString() }) + '\n',
      'utf8',
    );

    const res = await setStatus('agent-stale', 'after stale', { repoRoot, timeoutMs: 2000 });
    expect(res).toEqual({ ok: true });

    const map = readCurrentStatus({ repoRoot });
    expect(map['agent-stale'].text).toBe('after stale');

    // After release, the lock file is gone (we owned it post-override).
    expect(existsSync(lockFile)).toBe(false);
  });

  it('overrides an unparseable lock body and still succeeds', async () => {
    const lockFile = join(repoRoot, LOCK);
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    writeFileSync(lockFile, 'not-json-at-all', 'utf8');

    const res = await setStatus('agent-corrupt-lock', 'recovered', { repoRoot, timeoutMs: 2000 });
    expect(res).toEqual({ ok: true });

    const map = readCurrentStatus({ repoRoot });
    expect(map['agent-corrupt-lock'].text).toBe('recovered');
  });
});

describe('agent-status — invalid input (no throw)', () => {
  it('returns invalid-input for an empty agentId on setStatus', async () => {
    const res = await setStatus('', 'x', { repoRoot });
    expect(res).toEqual({ ok: false, reason: 'invalid-input', error: expect.any(String) });
    // Nothing was written.
    expect(existsSync(join(repoRoot, JSONL))).toBe(false);
    expect(readCurrentStatus({ repoRoot })).toEqual({});
  });

  it('returns invalid-input for whitespace-only text on setStatus', async () => {
    const res = await setStatus('agent-x', '   ', { repoRoot });
    expect(res).toEqual({ ok: false, reason: 'invalid-input', error: expect.any(String) });
  });

  it('returns invalid-input for a non-numeric step on setProgress', async () => {
    const res = await setProgress('agent-y', { step: 'nope', total: 5 }, { repoRoot });
    expect(res).toEqual({ ok: false, reason: 'invalid-input', error: expect.any(String) });
  });

  it('returns invalid-input for an empty agentId on setProgress', async () => {
    const res = await setProgress('', { step: 1, total: 2 }, { repoRoot });
    expect(res).toEqual({ ok: false, reason: 'invalid-input', error: expect.any(String) });
  });
});

describe('agent-status — corrupt current-json (no throw)', () => {
  it('returns {} when the current map file is corrupt', () => {
    const currentFile = join(repoRoot, CURRENT);
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    writeFileSync(currentFile, '{ this is : not json', 'utf8');

    expect(readCurrentStatus({ repoRoot })).toEqual({});
  });

  it('returns {} when the current map file is missing', () => {
    expect(readCurrentStatus({ repoRoot })).toEqual({});
  });

  it('recovers the map on the next write even when prior file was corrupt', async () => {
    const currentFile = join(repoRoot, CURRENT);
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    writeFileSync(currentFile, 'garbage', 'utf8');

    const res = await setStatus('agent-recover', 'ok now', { repoRoot });
    expect(res).toEqual({ ok: true });
    expect(readCurrentStatus({ repoRoot })['agent-recover'].text).toBe('ok now');
  });
});
