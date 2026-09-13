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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  realpathSync,
  readdirSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  setStatus,
  setProgress,
  readCurrentStatus,
  readCurrentStatusEntries,
  rebuildCurrentFromLedger,
} from '@lib/agent-status.mjs';

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

    const map = readCurrentStatusEntries({ repoRoot });
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

    const map = readCurrentStatusEntries({ repoRoot });
    expect(map['agent-long'].text.length).toBe(256);

    const lines = readJsonl();
    expect(Buffer.byteLength(JSON.stringify(lines[0]) + '\n', 'utf8')).toBeLessThan(512);
  });
});

describe('agent-status — setProgress', () => {
  it('carries {step,total,label} into the map and a progress JSONL line', async () => {
    const res = await setProgress('agent-2', { step: 3, total: 7, label: 'typecheck' }, { repoRoot });
    expect(res).toEqual({ ok: true });

    const map = readCurrentStatusEntries({ repoRoot });
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

    const map = readCurrentStatusEntries({ repoRoot });
    expect(map['agent-3'].label).toBeUndefined();
    expect(map['agent-3']).toMatchObject({ kind: 'progress', step: 1, total: 2 });
  });
});

describe('agent-status — LWW semantics', () => {
  it('keeps the LATER value when the same agentId is written twice', async () => {
    await setStatus('agent-lww', 'first', { repoRoot });
    await setStatus('agent-lww', 'second', { repoRoot });

    const map = readCurrentStatusEntries({ repoRoot });
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
    const map = readCurrentStatusEntries({ repoRoot });
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
    const map = readCurrentStatusEntries({ repoRoot });
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

    const map = readCurrentStatusEntries({ repoRoot });
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

    const map = readCurrentStatusEntries({ repoRoot });
    expect(map['agent-corrupt-lock'].text).toBe('recovered');
  });
});

describe('agent-status — invalid input (no throw)', () => {
  it('returns invalid-input for an empty agentId on setStatus', async () => {
    const res = await setStatus('', 'x', { repoRoot });
    expect(res).toEqual({ ok: false, reason: 'invalid-input', error: expect.any(String) });
    // Nothing was written.
    expect(existsSync(join(repoRoot, JSONL))).toBe(false);
    expect(readCurrentStatusEntries({ repoRoot })).toEqual({});
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

    expect(readCurrentStatusEntries({ repoRoot })).toEqual({});
  });

  it('returns {} when the current map file is missing', () => {
    expect(readCurrentStatusEntries({ repoRoot })).toEqual({});
  });

  it('B1 (#1210): does NOT warn when the current-map file is simply absent (ENOENT)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(readCurrentStatusEntries({ repoRoot })).toEqual({});
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('B2 (#1210): warns on a non-ENOENT read failure (EISDIR) and still returns {}', () => {
    const currentFile = join(repoRoot, CURRENT);
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    // A DIRECTORY at the current-map path: the real fs.readFileSync throws
    // EISDIR, not ENOENT — no DI mock needed to force the "other" branch.
    mkdirSync(currentFile);

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(readCurrentStatusEntries({ repoRoot })).toEqual({});
      const warned = stderrSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' && call[0].includes(currentFile) && call[0].includes('EISDIR'),
      );
      expect(warned).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('recovers the map on the next write even when prior file was corrupt', async () => {
    const currentFile = join(repoRoot, CURRENT);
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    writeFileSync(currentFile, 'garbage', 'utf8');

    const res = await setStatus('agent-recover', 'ok now', { repoRoot });
    expect(res).toEqual({ ok: true });
    expect(readCurrentStatusEntries({ repoRoot })['agent-recover'].text).toBe('ok now');
  });
});

// ---------------------------------------------------------------------------
// #1342 — the ledger is the source of truth, the current-map is a cache.
// ---------------------------------------------------------------------------

describe('agent-status — provenance of the current view (#1342)', () => {
  /**
   * A lock body whose owner must NOT be taken over: `host` is a FOREIGN host, and
   * `isExistingStale` in file-lock.mjs never declares a cross-host lock stale
   * (PSA-003), so acquireLock can only report `timeout`.
   */
  function seedForeignHostLock() {
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    writeFileSync(
      join(repoRoot, LOCK),
      JSON.stringify({
        pid: 4242,
        host: 'foreign-host-1342.invalid',
        acquiredAt: new Date().toISOString(),
      }) + '\n',
      'utf8',
    );
  }

  /** Append a raw ledger line (an append whose map write never followed). */
  function appendLedgerLine(obj) {
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    const p = join(repoRoot, JSONL);
    const prev = existsSync(p) ? readFileSync(p, 'utf8') : '';
    writeFileSync(p, prev + JSON.stringify(obj) + '\n', 'utf8');
  }

  // BUG: with the map write blocked by a foreign-host lock, setStatus correctly
  // returned {ok:false,reason:'timeout'} while every reader of the map showed the
  // OLD `running` state as if current — no staleness marker anywhere.
  it('reports the LEDGER state (completed), never an unmarked stale `running`', async () => {
    expect(await setStatus('worker-1', 'running', { repoRoot, timeoutMs: 0 })).toEqual({ ok: true });

    seedForeignHostLock();

    const second = await setStatus('worker-1', 'completed', { repoRoot, timeoutMs: 0 });
    expect(second).toEqual({ ok: false, reason: 'timeout' });

    // The ledger tail carries the truth ...
    const lines = readJsonl();
    expect(lines[lines.length - 1]).toMatchObject({ agentId: 'worker-1', text: 'completed' });
    // ... and so does the reader, explicitly marked as rebuilt from the ledger.
    const view = readCurrentStatus({ repoRoot });
    expect(view.source).toBe('rebuilt-log');
    expect(view.entries['worker-1'].text).toBe('completed');
    expect(typeof view.at).toBe('string');
  });

  // BUG: a process that died between the ledger append and the map write left the
  // map one record behind, presented as live.
  it('death between append and map write surfaces as source `rebuilt-log`', async () => {
    await setStatus('worker-2', 'step 1', { repoRoot });
    appendLedgerLine({
      agentId: 'worker-2',
      kind: 'status',
      text: 'step 2',
      ts: new Date(Date.now() + 1000).toISOString(),
    });

    const view = readCurrentStatus({ repoRoot });
    expect(view.source).toBe('rebuilt-log');
    expect(view.entries['worker-2'].text).toBe('step 2');
    expect(view.degraded.reasons).toContain('cache-behind-ledger');
  });

  // BUG: a corrupt current-map read as `{}` — every agent silently disappeared
  // although the ledger still held their last state. No fabrication: ledger only.
  it('a corrupt current-map falls back to the ledger and flags the cache', async () => {
    await setStatus('worker-3', 'alive', { repoRoot });
    writeFileSync(join(repoRoot, CURRENT), '{ not json', 'utf8');

    const view = readCurrentStatus({ repoRoot });
    expect(view.source).toBe('rebuilt-log');
    expect(view.entries['worker-3'].text).toBe('alive');
    expect(view.degraded.reason).toBe('cache-unreadable');
  });

  // BUG: an in-flight (newline-less) last line could be half-parsed into a state.
  // It must be COUNTED as degraded and its agent left unknown, never invented.
  it('an incomplete last JSONL line is reported as degraded and fabricates nothing', async () => {
    await setStatus('worker-4', 'known', { repoRoot });
    const p = join(repoRoot, JSONL);
    writeFileSync(
      p,
      readFileSync(p, 'utf8') + '{"agentId":"ghost","kind":"status","text":"half-writ',
      'utf8',
    );

    const rebuilt = rebuildCurrentFromLedger({ repoRoot });
    expect(rebuilt.degraded.reasons).toContain('incomplete-last-line');
    expect(rebuilt.degraded.partialLines).toBe(1);
    expect(rebuilt.entries['worker-4'].text).toBe('known');
    expect(rebuilt.entries.ghost).toBeUndefined();
  });

  // BUG: a rebuild that wrote anything (map, ledger, lock) would make a READ path
  // mutate shared state — it runs in hooks and a 2s tmux poll loop.
  it('the rebuild is idempotent on disk — it writes nothing, twice', async () => {
    await setStatus('worker-5', 'x', { repoRoot });
    const before = readdirSync(join(repoRoot, RUNTIME)).sort();
    const ledgerBefore = readFileSync(join(repoRoot, JSONL), 'utf8');
    const mapBefore = readFileSync(join(repoRoot, CURRENT), 'utf8');

    const first = rebuildCurrentFromLedger({ repoRoot });
    const second = rebuildCurrentFromLedger({ repoRoot });

    expect(second).toEqual(first);
    expect(readdirSync(join(repoRoot, RUNTIME)).sort()).toEqual(before);
    expect(readFileSync(join(repoRoot, JSONL), 'utf8')).toBe(ledgerBefore);
    expect(readFileSync(join(repoRoot, CURRENT), 'utf8')).toBe(mapBefore);
  });

  // BUG: a same-agentId record from an OLDER session must not be folded over a
  // newer session's record just because it appears later in the file.
  it('an older-session record never overwrites a newer one for the same agentId', () => {
    appendLedgerLine({
      agentId: 'worker-6',
      kind: 'status',
      text: 'new session',
      sessionId: 's-2',
      ts: '2026-09-13T10:00:00.000Z',
    });
    appendLedgerLine({
      agentId: 'worker-6',
      kind: 'status',
      text: 'old session',
      sessionId: 's-1',
      ts: '2026-09-12T10:00:00.000Z',
    });

    const rebuilt = rebuildCurrentFromLedger({ repoRoot });
    expect(rebuilt.entries['worker-6'].text).toBe('new session');
    expect(rebuilt.entries['worker-6'].binding).toBe('bound');
  });

  // BUG: a record with no timestamp could win the fold and be presented as the
  // agent's current state. It may only fill a gap, and is marked `unknown`.
  it('an untimestamped record is marked `unknown` and never displaces a dated one', () => {
    appendLedgerLine({ agentId: 'worker-7', kind: 'status', text: 'dated', ts: '2026-09-13T10:00:00.000Z' });
    appendLedgerLine({ agentId: 'worker-7', kind: 'status', text: 'undated' });
    appendLedgerLine({ agentId: 'worker-8', kind: 'status', text: 'undated only' });

    const rebuilt = rebuildCurrentFromLedger({ repoRoot });
    expect(rebuilt.entries['worker-7'].text).toBe('dated');
    expect(rebuilt.entries['worker-7'].binding).toBe('legacy');
    expect(rebuilt.entries['worker-8'].binding).toBe('unknown');
  });

  // BUG: a missing ledger with a populated cache used to read as live state.
  it('a missing ledger with a populated cache is marked `stale-cache`', async () => {
    await setStatus('worker-9', 'cached', { repoRoot });
    rmSync(join(repoRoot, JSONL));

    const view = readCurrentStatus({ repoRoot });
    expect(view.source).toBe('stale-cache');
    expect(view.entries['worker-9'].text).toBe('cached');
    expect(view.degraded.reason).toBe('ledger-missing');
  });

  // BUG: a tail window that cuts a line must DISCARD the fragment and say so —
  // an agent visible only in that fragment is unknown, not `running`.
  it('a truncated tail window discards the cut line and reports it', async () => {
    await setStatus('worker-a', 'first', { repoRoot });
    await setStatus('worker-b', 'second', { repoRoot });

    // Size the window so it starts 3 bytes INTO the first record: line 1 is cut
    // (and must be discarded), line 2 arrives whole.
    const raw = readFileSync(join(repoRoot, JSONL), 'utf8');
    const firstLineBytes = Buffer.byteLength(raw.split('\n')[0], 'utf8') + 1;
    const rebuilt = rebuildCurrentFromLedger({
      repoRoot,
      maxBytes: Buffer.byteLength(raw, 'utf8') - firstLineBytes + 3,
    });

    expect(rebuilt.degraded.tailTruncated).toBe(true);
    expect(rebuilt.degraded.reasons).toContain('tail-truncated');
    expect(rebuilt.entries['worker-a']).toBeUndefined();
    expect(rebuilt.entries['worker-b'].text).toBe('second');
  });

  it('the normal path (both writes succeeded) reports source `live-map`', async () => {
    await setStatus('worker-c', 'fine', { repoRoot });
    const view = readCurrentStatus({ repoRoot });
    expect(view.source).toBe('live-map');
    expect(view.degraded).toBeUndefined();
    expect(view.entries['worker-c'].text).toBe('fine');
  });
});

// ---------------------------------------------------------------------------
// #1342 fix-pass — the fold is PER agentId, the sources are four, and a
// prototype-shaped agentId is not a map key.
// ---------------------------------------------------------------------------

describe('agent-status — per-agent fold and four sources (#1342 fix-pass)', () => {
  /** Append a raw ledger line (a record whose map write may never have followed). */
  function appendLedgerLine(obj) {
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    const p = join(repoRoot, JSONL);
    const prev = existsSync(p) ? readFileSync(p, 'utf8') : '';
    writeFileSync(p, prev + JSON.stringify(obj) + '\n', 'utf8');
  }

  function writeCache(map) {
    mkdirSync(join(repoRoot, RUNTIME), { recursive: true });
    writeFileSync(join(repoRoot, CURRENT), JSON.stringify(map), 'utf8');
  }

  // BUG (H1): the source verdict was decided by the GLOBAL newest timestamp of
  // each view. Agent A's map write was LOST (ledger `completed`, cache still
  // `running`), then sibling B pushed successfully a few seconds later — so the
  // cache's newest equalled the ledger's newest, the reader answered
  // `source: live-map`, and A was served from the cache as `running`:
  // byte-identical to the pre-#1342 defect. Every earlier staleness test used a
  // single agent, so none of them could see it.
  it('a lost map write for A is NOT masked by a later successful push from B', () => {
    const aRunning = { agentId: 'A', kind: 'status', text: 'running', ts: '2026-09-13T10:00:01.000Z' };
    const bRunning = { agentId: 'B', kind: 'status', text: 'running', ts: '2026-09-13T10:00:09.000Z' };

    // Ledger: A running → A completed (map write lost) → B running (map write ok).
    appendLedgerLine(aRunning);
    appendLedgerLine({ agentId: 'A', kind: 'status', text: 'completed', ts: '2026-09-13T10:00:05.000Z' });
    appendLedgerLine(bRunning);
    // Cache: A is a record behind; B is current.
    writeCache({ A: aRunning, B: bRunning });

    const view = readCurrentStatus({ repoRoot });
    expect(view.entries.A.text).toBe('completed');
    expect(view.entries.B.text).toBe('running');
    expect(view.source).toBe('rebuilt-log');
    expect(view.degraded.reasons).toContain('cache-behind-ledger');
  });

  // BUG: an equal-millisecond record in both views must not flip the verdict to
  // `rebuilt-log` — the cache is the writer's own last word for that agent, and a
  // tie is the NORMAL path (the map write succeeded).
  it('an equal-ms tie goes to the cache and stays source `live-map`', () => {
    const rec = { agentId: 'C', kind: 'status', text: 'fine', ts: '2026-09-13T10:00:00.000Z' };
    appendLedgerLine(rec);
    writeCache({ C: { ...rec, viaCache: true } });

    const view = readCurrentStatus({ repoRoot });
    expect(view.source).toBe('live-map');
    expect(view.entries.C.viaCache).toBe(true);
    expect(view.entries.C.binding).toBeUndefined(); // cache entry, not a folded one
    expect(view.degraded).toBeUndefined();
  });

  // BUG (M1): with NO ledger and NO cache the reader answered `live-map` — a
  // claim that the cache was verified against a ledger, when neither exists.
  it('an empty channel reports source `absent`, not `live-map`', () => {
    const view = readCurrentStatus({ repoRoot });
    expect(view.source).toBe('absent');
    expect(view.entries).toEqual({});
    expect(view.at).toBeNull();
    expect(view.degraded).toBeUndefined();
  });

  // BUG (Sec-L1): `entries[rec.agentId] = rec` with agentId `__proto__` on a
  // plain object REPLACED the prototype and DROPPED the record — the poisoned
  // key then leaked into every consumer's lookups.
  it('a `__proto__` agentId is dropped and never touches the prototype', () => {
    appendLedgerLine({ agentId: 'D', kind: 'status', text: 'real', ts: '2026-09-13T10:00:00.000Z' });
    appendLedgerLine({ agentId: '__proto__', kind: 'status', text: 'poison', ts: '2026-09-13T10:00:01.000Z' });

    const rebuilt = rebuildCurrentFromLedger({ repoRoot });
    expect(Object.keys(rebuilt.entries)).toEqual(['D']);
    expect(Object.getPrototypeOf(rebuilt.entries)).toBeNull();
    expect(rebuilt.degraded.unboundRecords).toBe(1);

    // Same guard on the CACHE read path (a poisoned current-map file).
    writeCache({ D: { agentId: 'D', kind: 'status', text: 'real', ts: '2026-09-13T10:00:00.000Z' } });
    writeFileSync(
      join(repoRoot, CURRENT),
      '{"D":{"agentId":"D","kind":"status","text":"real","ts":"2026-09-13T10:00:00.000Z"},' +
        '"__proto__":{"agentId":"__proto__","text":"poison"}}',
      'utf8',
    );
    const view = readCurrentStatus({ repoRoot });
    expect(Object.keys(view.entries)).toEqual(['D']);
    expect(Object.getPrototypeOf(view.entries)).toBeNull();
  });

  // BUG (QA-M4): the `parse-errors` and `records-without-agent-id` degradation
  // reasons were surviving mutants — reachable, but asserted by no test, so
  // deleting either branch kept the suite green.
  it('counts a corrupt mid-file line and a record without agentId separately', () => {
    appendLedgerLine({ agentId: 'E', kind: 'status', text: 'first', ts: '2026-09-13T10:00:00.000Z' });
    // A corrupt line in the MIDDLE of the file (not the in-flight last line).
    const p = join(repoRoot, JSONL);
    writeFileSync(p, readFileSync(p, 'utf8') + '{ not json\n', 'utf8');
    appendLedgerLine({ kind: 'status', text: 'no agent', ts: '2026-09-13T10:00:02.000Z' });
    appendLedgerLine({ agentId: 'E', kind: 'status', text: 'last', ts: '2026-09-13T10:00:03.000Z' });

    const rebuilt = rebuildCurrentFromLedger({ repoRoot });
    expect(rebuilt.degraded.reasons).toEqual(['parse-errors', 'records-without-agent-id']);
    expect(rebuilt.degraded.parseErrors).toBe(1);
    expect(rebuilt.degraded.unboundRecords).toBe(1);
    expect(rebuilt.degraded.partialLines).toBe(0);
    expect(rebuilt.entries.E.text).toBe('last');
  });
});
