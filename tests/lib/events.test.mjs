/**
 * tests/lib/events.test.mjs
 *
 * Unit tests for scripts/lib/events.mjs
 * Issue #133 — JSONL event emission + optional webhook POST.
 *
 * Isolation strategy:
 *   - platform.mjs resolves SO_PROJECT_DIR via CLAUDE_PROJECT_DIR env var (fast-path).
 *   - Each describe block sets CLAUDE_PROJECT_DIR to a fresh tmpDir in beforeEach,
 *     then calls vi.resetModules() + dynamic import so the module re-initialises
 *     SO_PROJECT_DIR from that env var.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ARCHIVE_DIR_NAME, ROTATION_EVENT, validateEventRecord } from '@lib/events-schema.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Import events.mjs freshly with SO_PROJECT_DIR redirected to `dir`.
 * platform.mjs checks CLAUDE_PROJECT_DIR as its env-var fast-path.
 */
async function importEventsWithDir(dir) {
  // platform.mjs fast-path: CLAUDE_PROJECT_DIR beats CWD walk.
  process.env.CLAUDE_PROJECT_DIR = dir;
  vi.resetModules();
  return import('@lib/events.mjs');
}

// ---------------------------------------------------------------------------
// 1. eventsFilePath — path structure (uses real module, no isolation needed)
// ---------------------------------------------------------------------------

describe('eventsFilePath', () => {
  it('returns an absolute path', async () => {
    const { eventsFilePath } = await import('@lib/events.mjs');
    expect(path.isAbsolute(eventsFilePath())).toBe(true);
  });

  it('ends with .orchestrator/metrics/events.jsonl', async () => {
    const { eventsFilePath } = await import('@lib/events.mjs');
    const fp = eventsFilePath();
    const normalised = fp.split(path.sep).join('/');
    expect(normalised.endsWith('.orchestrator/metrics/events.jsonl')).toBe(true);
  });

  it('contains the ".orchestrator" segment', async () => {
    const { eventsFilePath } = await import('@lib/events.mjs');
    expect(eventsFilePath()).toContain('.orchestrator');
  });
});

// ---------------------------------------------------------------------------
// 2. emitEvent — JSONL writes
// ---------------------------------------------------------------------------

describe('emitEvent — JSONL output', () => {
  let tmpDir;
  const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'so-events-test-'));
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    // Restore original env state.
    if (origClaudeProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
    }
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('appended line contains timestamp in ISO 8601 format', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    await emitEvent('test.event', { foo: 'bar' });
    const fp = eventsFilePath();
    const content = await readFile(fp, 'utf8');
    const record = JSON.parse(content.trim().split('\n')[0]);
    expect(record.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('appended line contains event field equal to the type argument', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    await emitEvent('orchestrator.session.started', {});
    const fp = eventsFilePath();
    const content = await readFile(fp, 'utf8');
    const record = JSON.parse(content.trim().split('\n')[0]);
    expect(record.event).toBe('orchestrator.session.started');
  });

  it('appended line spreads payload fields into the record', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    await emitEvent('test.payload', { sessionId: 'abc123', wave: 2 });
    const fp = eventsFilePath();
    const content = await readFile(fp, 'utf8');
    const record = JSON.parse(content.trim().split('\n')[0]);
    expect(record.sessionId).toBe('abc123');
    expect(record.wave).toBe(2);
  });

  it('two sequential calls produce exactly two lines', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    await emitEvent('first.event', {});
    await emitEvent('second.event', {});
    const fp = eventsFilePath();
    const content = await readFile(fp, 'utf8');
    const lines = content.trim().split('\n').filter(l => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('first.event');
    expect(JSON.parse(lines[1]).event).toBe('second.event');
  });

  it('auto-creates the .orchestrator/metrics directory when missing', async () => {
    // tmpDir has no subdirectories — emitEvent must mkdir recursively.
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    await emitEvent('autocreate.test', {});
    const fp = eventsFilePath();
    await expect(access(fp)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. emitEvent — fetch not called without CLANK_EVENT_SECRET
// ---------------------------------------------------------------------------

describe('emitEvent — no fetch when CLANK_EVENT_SECRET is unset', () => {
  let tmpDir;
  const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'so-events-test-'));
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (origClaudeProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
    }
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('does not call fetch when CLANK_EVENT_SECRET is unset', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: 200 })
    );
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await emitEvent('no.secret', { x: 1 });
    await new Promise(r => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. emitEvent — fetch IS called when CLANK_EVENT_SECRET is set
// ---------------------------------------------------------------------------

// #228: Both CLANK_EVENT_SECRET and CLANK_EVENT_URL are required to POST.
// Setting only CLANK_EVENT_SECRET without a URL is a safe no-op (no personal-domain default).
describe('emitEvent — fetch called when both CLANK_EVENT_SECRET and CLANK_EVENT_URL are set', () => {
  let tmpDir;
  const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'so-events-test-'));
    delete process.env.CLANK_EVENT_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (origClaudeProjectDir === undefined) {
      delete process.env.CLAUDE_PROJECT_DIR;
    } else {
      process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
    }
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('calls fetch once when both CLANK_EVENT_SECRET and CLANK_EVENT_URL are set', async () => {
    process.env.CLANK_EVENT_SECRET = 'test-secret-token';
    process.env.CLANK_EVENT_URL = 'https://events.example.com';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: 200 })
    );
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await emitEvent('with.secret', { session: 's1' });
    await new Promise(r => setImmediate(r));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('passes the correct Authorization header to fetch', async () => {
    process.env.CLANK_EVENT_SECRET = 'my-secret';
    process.env.CLANK_EVENT_URL = 'https://events.example.com';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: 200 })
    );
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await emitEvent('auth.header.test', {});
    await new Promise(r => setImmediate(r));
    const [_url, init] = fetchSpy.mock.calls[0];
    expect(init.headers['Authorization']).toBe('Bearer my-secret');
  });

  it('swallows a network error — emitEvent still resolves', async () => {
    process.env.CLANK_EVENT_SECRET = 'test-secret-token';
    process.env.CLANK_EVENT_URL = 'https://events.example.com';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network failure'));
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await expect(emitEvent('network.error', {})).resolves.toBeUndefined();
    await new Promise(r => setImmediate(r));
  });

  // Webhook payload contract (#609 W4 fold-in) — guards the divergence-fix's core
  // value: JSONL and webhook MUST carry the SAME dotted event name + full payload.
  it('webhook body carries event_type (dotted name), source, and the full payload', async () => {
    process.env.CLANK_EVENT_SECRET = 'sek';
    process.env.CLANK_EVENT_URL = 'https://events.example.com';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: 200 })
    );
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await emitEvent('orchestrator.session.stopped', { session_id: 's1', branch: 'main', commit: 'abc123', wave: 2 });
    await new Promise(r => setImmediate(r));
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.event_type).toBe('orchestrator.session.stopped');
    expect(body.source).toBe('session-orchestrator');
    expect(body.payload).toEqual({ session_id: 's1', branch: 'main', commit: 'abc123', wave: 2 });
  });
});

// ---------------------------------------------------------------------------
// producer ↔ schema: emitEvent output must satisfy validateEventRecord (#609)
// ---------------------------------------------------------------------------

describe('emitEvent output conforms to events-schema validateEventRecord', () => {
  let tmpDir;
  let origClaudeProjectDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'events-schema-conform-'));
    origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(async () => {
    if (origClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('a record written by emitEvent passes validateEventRecord', async () => {
    const mod = await importEventsWithDir(tmpDir);
    await mod.emitEvent('orchestrator.session.ended', { session_id: 's1', reason: 'clear', duration_ms: 4200 });
    const raw = await readFile(mod.eventsFilePath(), 'utf8');
    const record = JSON.parse(raw.trim().split('\n').pop());
    expect(validateEventRecord(record)).toEqual({ valid: true, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// #1177 — schema_version stamping + pre-write validation
// ---------------------------------------------------------------------------

describe('emitEvent — schema_version + validation (#1177)', () => {
  let tmpDir;
  const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'so-events-schema-'));
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    if (origClaudeProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = origClaudeProjectDir;
    delete process.env.CLANK_EVENT_SECRET;
    delete process.env.CLANK_EVENT_URL;
    await rm(tmpDir, { recursive: true, force: true });
  });

  // Bug: records land in the ledger with no version marker, so a future schema
  // change cannot tell a v1 record from a v2 one — the migration has nothing to
  // branch on and every historical record becomes ambiguous.
  it('stamps schema_version: 1 on the emitted record', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    await emitEvent('orchestrator.session.started', { session_id: 's1' });
    const record = JSON.parse((await readFile(eventsFilePath(), 'utf8')).trim());
    expect(record.schema_version).toBe(1);
  });

  // Bug: the producer overwrites a caller-supplied schema_version, so a caller
  // replaying/migrating records cannot pin their own version — the stamp must be
  // additive, not authoritative.
  it('does not overwrite a caller-supplied schema_version', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    await emitEvent('orchestrator.session.started', { schema_version: 99 });
    const record = JSON.parse((await readFile(eventsFilePath(), 'utf8')).trim());
    expect(record.schema_version).toBe(99);
  });

  // Bug: a malformed orchestrator.* name is appended to the shared ledger and
  // only fails at read time. Validation must happen BEFORE any side effect, so
  // an invalid record leaves no line at all.
  it('rejects an invalid orchestrator.* name and writes no line', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    const { EventValidationError } = await import('@lib/events-schema.mjs');
    await expect(emitEvent('orchestrator.bad', {})).rejects.toBeInstanceOf(EventValidationError);
    // No file, and therefore no line — mkdir/appendFile never ran.
    await expect(access(eventsFilePath())).rejects.toThrow();
  });

  it('an invalid record fires no webhook POST', async () => {
    process.env.CLANK_EVENT_SECRET = 'sek';
    process.env.CLANK_EVENT_URL = 'https://events.example.com';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: 200 })
    );
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await expect(emitEvent('orchestrator.bad', {})).rejects.toThrow();
    await new Promise(r => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // Bug: schema_version leaks into the webhook envelope, changing a published
  // wire format an external consumer parses. The version describes the JSONL
  // record only — the POST body stays { event_type, source, payload }.
  it('webhook body carries the raw payload without schema_version', async () => {
    process.env.CLANK_EVENT_SECRET = 'sek';
    process.env.CLANK_EVENT_URL = 'https://events.example.com';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () => new Response('{}', { status: 200 })
    );
    const { emitEvent } = await importEventsWithDir(tmpDir);
    await emitEvent('orchestrator.session.stopped', { session_id: 's1' });
    await new Promise(r => setImmediate(r));
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(body.payload).toEqual({ session_id: 's1' });
    expect(Object.keys(body).sort()).toEqual(['event_type', 'payload', 'source']);
  });
});

// ---------------------------------------------------------------------------
// readEventsWithRotations — reading across rotation boundaries (#1401)
// ---------------------------------------------------------------------------

describe('readEventsWithRotations', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'events-read-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** One ledger line in the live record shape (harvested 2026-09-19). */
  const line = (timestamp, extra = {}) =>
    `${JSON.stringify({
      timestamp,
      event: 'orchestrator.auq_clarity.allowed',
      session_id: 'c8eeea77-cbd5-4fd1-81d4-89ba549d8fdb',
      schema_version: 1,
      ...extra,
    })}\n`;

  const rotationLine = (timestamp, archivedAs, range) =>
    `${JSON.stringify({
      timestamp,
      event: ROTATION_EVENT,
      archived_as: archivedAs,
      size_before: 10485760,
      lines: 53896,
      first_ts: range.first,
      last_ts: range.last,
      malformed_lines: 0,
      schema_version: 1,
    })}\n`;

  function archivePath(name) {
    mkdirSync(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });
    return path.join(dir, ARCHIVE_DIR_NAME, name);
  }

  it('returns events across the rotation boundary in time order', async () => {
    // BUG THIS CATCHES: every window analysis silently lost its whole history
    // at each rotation — census 2026-09-19 @ 8f15f77b found ZERO code readers
    // of any rotated backup, which is how the #1037 guard attribution ended up
    // computable for only 2 of 38 sessions.
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    const archived = archivePath('events-20260412T063301Z_20260918T191402Z.jsonl');

    writeFileSync(archived, line('2026-04-12T06:33:01.123Z') + line('2026-09-18T19:14:02Z'));
    writeFileSync(
      active,
      rotationLine('2026-09-19T07:00:00Z', archived, {
        first: '2026-04-12T06:33:01.123Z',
        last: '2026-09-18T19:14:02Z',
      }) + line('2026-09-19T08:00:00Z'),
    );

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.events.map((e) => e.timestamp)).toEqual([
      '2026-04-12T06:33:01.123Z',
      '2026-09-18T19:14:02Z',
      '2026-09-19T07:00:00Z',
      '2026-09-19T08:00:00Z',
    ]);
    expect(result.complete).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('reports a MISSING archive as a gap instead of silently returning a shorter history', async () => {
    // BUG THIS CATCHES: the 2026-09-19 loss itself. A subagent's
    // `touch <path> && rm -f <path>` ignore-probe adopted and destroyed a
    // 10 MB archive; with no tombstone the shortened ledger was indistinguishable
    // from one that had simply never rotated.
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    const vanished = archivePath('events-20260412T063301Z_20260918T191402Z.jsonl');

    writeFileSync(
      active,
      rotationLine('2026-09-19T07:00:00Z', vanished, {
        first: '2026-04-12T06:33:01.123Z',
        last: '2026-09-18T19:14:02Z',
      }) + line('2026-09-19T08:00:00Z'),
    );
    // `vanished` is deliberately never created — the tombstone points at nothing.

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.complete).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({
      kind: 'missing-archive',
      archived_as: vanished,
      first_ts: '2026-04-12T06:33:01.123Z',
      last_ts: '2026-09-18T19:14:02Z',
      lines: 53896,
      reported_by: active,
    });
    // The surviving records are still returned — a gap is a finding, not a throw.
    expect(result.events).toHaveLength(2);
  });

  it('resolves a MOVED checkout tombstone against the sibling _archive/ instead of reporting a phantom gap', async () => {
    // BUG THIS CATCHES (#1411): `archived_as` is an ABSOLUTE host path and the
    // reader compared it exactly, so renaming the repo, cloning it, or reading
    // the ledger from a sibling git worktree — routine here — reported
    // `missing-archive` for EVERY rotation while the archive sat right beside
    // the active file. A `complete: false` that fires on a move teaches the
    // reader to ignore the signal #1401 was built to raise (HR-101).
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    const name = 'events-20260412T063301Z_20260918T191402Z.jsonl';
    const here = archivePath(name);
    // The tombstone still names the archive under the checkout's OLD root.
    const oldRootPath = path.join('/nonexistent-old-checkout/.orchestrator/metrics', ARCHIVE_DIR_NAME, name);

    writeFileSync(here, line('2026-04-12T06:33:01.123Z') + line('2026-09-18T19:14:02Z'));
    writeFileSync(
      active,
      rotationLine('2026-09-19T07:00:00Z', oldRootPath, {
        first: '2026-04-12T06:33:01.123Z',
        last: '2026-09-18T19:14:02Z',
      }) + line('2026-09-19T08:00:00Z'),
    );

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.gaps).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.events.map((e) => e.timestamp)).toEqual([
      '2026-04-12T06:33:01.123Z',
      '2026-09-18T19:14:02Z',
      '2026-09-19T07:00:00Z',
      '2026-09-19T08:00:00Z',
    ]);
  });

  it('reports missing-archive when only a FOREIGN checkout still holds a file of that name', async () => {
    // BUG THIS CATCHES (#1411, second order): `existsSync(target)` on the
    // absolute tombstone value answers YES from a still-present OLD checkout,
    // so THIS ledger was validated against a FOREIGN repo's archive — a silent
    // false negative, worse than the phantom gap it hid behind.
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const foreignRoot = await mkdtemp(path.join(tmpdir(), 'events-foreign-'));
    try {
      const name = 'events-20260412T063301Z_20260918T191402Z.jsonl';
      const foreignArchive = path.join(foreignRoot, ARCHIVE_DIR_NAME, name);
      mkdirSync(path.dirname(foreignArchive), { recursive: true });
      writeFileSync(foreignArchive, line('2001-01-01T00:00:00Z'));
      // This ledger's own `_archive/` exists but holds NO file of that basename.
      mkdirSync(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });

      const active = path.join(dir, 'events.jsonl');
      writeFileSync(
        active,
        rotationLine('2026-09-19T07:00:00Z', foreignArchive, {
          first: '2026-04-12T06:33:01.123Z',
          last: '2026-09-18T19:14:02Z',
        }) + line('2026-09-19T08:00:00Z'),
      );

      const result = readEventsWithRotations(undefined, { filePath: active });

      expect(result.complete).toBe(false);
      expect(result.gaps).toEqual([
        expect.objectContaining({ kind: 'missing-archive', archived_as: foreignArchive }),
      ]);
      // The foreign checkout's records are never folded into this ledger.
      expect(result.events).toHaveLength(2);
    } finally {
      await rm(foreignRoot, { recursive: true, force: true });
    }
  });

  it('counts unreadable lines in malformed_lines, per source and in total', async () => {
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    const archived = archivePath('events-20260412T063301Z_20260501T000000Z.jsonl');

    writeFileSync(archived, line('2026-04-12T06:33:01.123Z') + '{"timestamp":"2026-05-0\n');
    writeFileSync(active, line('2026-09-19T08:00:00Z') + '[1,2,3]\nnot json at all\n');

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.malformed_lines).toBe(3);
    const bySource = Object.fromEntries(result.sources.map((s) => [s.path, s.malformed_lines]));
    expect(bySource[archived]).toBe(1);
    expect(bySource[active]).toBe(2);
    // The readable records survive the malformed ones.
    expect(result.events).toHaveLength(2);
  });

  it('reads a legacy .1 ring backup and reports a hole in the ring as a gap', async () => {
    // Two live fleet repos still carry a pre-#1401 `events.jsonl.1` (measured
    // 2026-09-19). A reader blind to the ring would drop that history and call
    // the result complete.
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');

    writeFileSync(`${active}.1`, line('2026-08-01T00:00:00Z'));
    // `.2` deliberately absent while `.3` exists — the ring was contiguous by
    // construction, so the hole proves an out-of-band deletion.
    writeFileSync(`${active}.3`, line('2026-06-01T00:00:00Z'));
    writeFileSync(active, line('2026-09-19T08:00:00Z'));

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.events.map((e) => e.timestamp)).toEqual([
      '2026-06-01T00:00:00Z',
      '2026-08-01T00:00:00Z',
      '2026-09-19T08:00:00Z',
    ]);
    expect(result.gaps).toEqual([
      expect.objectContaining({ kind: 'ring-hole', archived_as: `${active}.2` }),
    ]);
    expect(result.complete).toBe(false);
  });

  it('ignores a hand-placed file in _archive/ that rotation did not write', async () => {
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    const foreign = archivePath('events-worktree-vault-session-analysis-2026-08-17.jsonl');

    writeFileSync(foreign, line('2001-01-01T00:00:00Z'));
    writeFileSync(active, line('2026-09-19T08:00:00Z'));

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.events.map((e) => e.timestamp)).toEqual(['2026-09-19T08:00:00Z']);
    expect(result.sources.map((s) => s.path)).toEqual([active]);
    // BUG THIS CATCHES (#1423): the exclusion was SILENT. This repo's own
    // `_archive/` holds exactly such a file (80 records) and the reader still
    // answered `complete: true, gaps: 0` — a file it never read, nowhere named.
    // It is a NOTICE, not a gap: making it a gap would pin this repo at
    // `complete: false` forever and teach the operator to ignore the flag
    // (HR-101).
    expect(result.notices).toEqual([
      { kind: 'unindexed-archive-file', path: foreign },
    ]);
    expect(result.complete).toBe(true);
  });

  it('reports a tombstoned archive that EXISTS but was never read as an unindexed-archive gap', async () => {
    // BUG THIS CATCHES (#1423): `existsSync(sibling)` counted as "was read".
    // It is not: `discoverArchives` only ever reads names matching
    // ARCHIVE_NAME_RE, so a tombstone whose archive has been RENAMED out of
    // that shape silenced itself — `complete: true, gaps: []` while its records
    // were absent from `events`. Existence is not reading.
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    // The archive is ON DISK, under a basename outside ARCHIVE_NAME_RE — so
    // `discoverArchives` never reads it, while the tombstone names it.
    const renamed = archivePath('events-rotated-by-hand-20260412.jsonl');
    const tombstoned = path.join(
      '/nonexistent-old-checkout/.orchestrator/metrics',
      ARCHIVE_DIR_NAME,
      'events-rotated-by-hand-20260412.jsonl',
    );

    writeFileSync(renamed, line('2026-04-12T06:33:01.123Z'));
    writeFileSync(
      active,
      rotationLine('2026-09-19T07:00:00Z', tombstoned, {
        first: '2026-04-12T06:33:01.123Z',
        last: '2026-09-18T19:14:02Z',
      }) + line('2026-09-19T08:00:00Z'),
    );

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.complete).toBe(false);
    expect(result.gaps).toEqual([
      expect.objectContaining({ kind: 'unindexed-archive', archived_as: tombstoned, path: renamed }),
    ]);
    // The same file is ALSO reported as a notice — it was seen and not read.
    expect(result.notices).toEqual([{ kind: 'unindexed-archive-file', path: renamed }]);
    // Its records really are absent — the gap is not cosmetic.
    expect(result.events.map((e) => e.timestamp)).toEqual([
      '2026-09-19T07:00:00Z',
      '2026-09-19T08:00:00Z',
    ]);
  });

  it('reports complete: null — not true — when NO source exists at all', async () => {
    // BUG THIS CATCHES (#1423 F3): a repo with no ledger answered
    // `{complete: true, gaps: 0, events: 0}` — byte-identical to a verified,
    // whole read. Three states collapsed onto two, so "not measured" was
    // indistinguishable from "measured zero".
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.complete).toBe(null);
    expect(result.sources).toEqual([]);
    expect(result.events).toEqual([]);
    expect(result.gaps).toEqual([]);
  });

  it('end-to-end: a real maybeRotate run leaves an archive the reader finds', async () => {
    const { readEventsWithRotations } = await importEventsWithDir(dir);
    const { maybeRotate } = await import('@lib/events-rotation.mjs');
    const active = path.join(dir, 'events.jsonl');

    let body = line('2026-04-12T06:33:01.123Z');
    while (body.length < 1024 * 1024) body += line('2026-09-18T19:14:02Z');
    writeFileSync(active, body);

    const rot = maybeRotate({ logPath: active, maxSizeMb: 1, maxBackups: 5, enabled: true });
    expect(rot.rotated).toBe(true);
    expect(rot.recordWritten).toBe(true);

    // Post-rotation appends land in the new active file.
    writeFileSync(active, readFileSync(active, 'utf8') + line('2026-09-19T09:00:00Z'));

    const result = readEventsWithRotations(undefined, { filePath: active });

    expect(result.complete).toBe(true);
    expect(result.malformed_lines).toBe(0);
    expect(result.sources.map((s) => s.kind)).toEqual(['archive', 'active']);
    expect(result.events).toHaveLength(rot.lines + 2); // archive + tombstone + new append
    expect(result.events.at(0).timestamp).toBe('2026-04-12T06:33:01.123Z');
    expect(result.events.at(-1).timestamp).toBe('2026-09-19T09:00:00Z');
    expect(result.events.find((e) => e.event === ROTATION_EVENT).archived_as).toBe(rot.archivedAs);
  });
});

// ---------------------------------------------------------------------------
// listEventSourcesNewestFirst + scanEventsBackwards — streaming reads (#1414)
// ---------------------------------------------------------------------------

describe('streaming reads across rotations', () => {
  let dir;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'events-scan-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rec = (timestamp, event = 'orchestrator.auq_clarity.allowed') =>
    `${JSON.stringify({ timestamp, event, schema_version: 1 })}\n`;

  function archiveFile(name, body) {
    mkdirSync(path.join(dir, ARCHIVE_DIR_NAME), { recursive: true });
    const abs = path.join(dir, ARCHIVE_DIR_NAME, name);
    writeFileSync(abs, body);
    return abs;
  }

  it('orders the sources NEWEST first: active, archives descending, legacy ring ascending', async () => {
    // BUG THIS CATCHES (#1414): the two hot-path readers answered "never
    // happened" from the active file alone. A backwards walk is only correct if
    // the source order is newest-first — the wrong order returns an OLD hit as
    // the most recent one, which is worse than no answer.
    const { listEventSourcesNewestFirst } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    writeFileSync(active, rec('2026-09-20T00:00:00Z'));
    const older = archiveFile('events-20260101T000000Z_20260201T000000Z.jsonl', rec('2026-01-01T00:00:00Z'));
    const newer = archiveFile('events-20260301T000000Z_20260401T000000Z.jsonl', rec('2026-03-01T00:00:00Z'));
    // A hand-placed file is NOT a source (one definition of "this ledger").
    archiveFile('events-worktree-analysis-2026-08-17.jsonl', rec('2026-08-17T00:00:00Z'));
    writeFileSync(`${active}.1`, rec('2025-12-01T00:00:00Z'));
    writeFileSync(`${active}.2`, rec('2025-11-01T00:00:00Z'));

    const sources = listEventSourcesNewestFirst({ filePath: active });

    expect(sources).toEqual([
      { path: active, kind: 'active' },
      { path: newer, kind: 'archive' },
      { path: older, kind: 'archive' },
      { path: `${active}.1`, kind: 'legacy-ring' },
      { path: `${active}.2`, kind: 'legacy-ring' },
    ]);
  });

  it('omits a source that does not exist — an absent ledger yields no sources', async () => {
    const { listEventSourcesNewestFirst } = await importEventsWithDir(dir);
    expect(listEventSourcesNewestFirst({ filePath: path.join(dir, 'events.jsonl') })).toEqual([]);
  });

  it('walks BACKWARDS across the archive boundary and stops at the first accepted record', async () => {
    // BUG THIS CATCHES (#1414): the only `orchestrator.evolve.completed` record
    // on a rotated host sits in `_archive/`, so the single-file reader reported
    // "never ran" for a repo that HAS run it — and nagged it every session
    // start (HR-101). The stop-at-first-hit is what keeps the walk cheap.
    const { scanEventsBackwards } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    archiveFile(
      'events-20260101T000000Z_20260201T000000Z.jsonl',
      rec('2026-01-01T00:00:00Z') +
        rec('2026-01-05T00:00:00Z', 'orchestrator.evolve.completed') +
        rec('2026-01-09T00:00:00Z', 'orchestrator.evolve.completed') +
        rec('2026-01-10T00:00:00Z'),
    );
    writeFileSync(active, rec('2026-09-20T00:00:00Z') + rec('2026-09-21T00:00:00Z'));

    const seen = [];
    const hits = [];
    const result = scanEventsBackwards({
      filePath: active,
      onRecord: (record, source) => {
        seen.push([record.timestamp, source.kind]);
        if (record.event !== 'orchestrator.evolve.completed') return false;
        hits.push(record.timestamp);
        return true;
      },
    });

    expect(result.stopped).toBe(true);
    expect(result.truncated).toBe(false);
    // The NEWEST evolve record, not the oldest — the walk runs backwards.
    expect(hits).toEqual(['2026-01-09T00:00:00Z']);
    // Newest-first, and nothing older than the hit was ever parsed.
    expect(seen.map(([ts]) => ts)).toEqual([
      '2026-09-21T00:00:00Z',
      '2026-09-20T00:00:00Z',
      '2026-01-10T00:00:00Z',
      '2026-01-09T00:00:00Z',
    ]);
    expect(seen.map(([, kind]) => kind)).toEqual(['active', 'active', 'archive', 'archive']);
  });

  it('carries a record split across a chunk boundary instead of losing it', async () => {
    // BUG THIS CATCHES: a chunked backwards reader that parses the partial line
    // at the front of each chunk sees the split record as two invalid halves —
    // a repo that HAS the record is reported as "never". Same defect class the
    // #1290 hand-rolled scan was fixed for; it must not return via the shared
    // reader.
    const { scanEventsBackwards } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    const target = rec('2026-05-05T00:00:00Z', 'orchestrator.evolve.completed');
    // chunkBytes is tiny, so the target line is guaranteed to straddle one.
    writeFileSync(active, rec('2026-01-01T00:00:00Z') + target + rec('2026-09-01T00:00:00Z'));

    const hits = [];
    const result = scanEventsBackwards({
      filePath: active,
      chunkBytes: 16,
      onRecord: (record) => {
        if (record.event !== 'orchestrator.evolve.completed') return false;
        hits.push(record.timestamp);
        return true;
      },
    });

    expect(hits).toEqual(['2026-05-05T00:00:00Z']);
    expect(result.malformed_lines).toBe(0);
  });

  it('reports truncated — never a clean "not found" — when the budget runs out', async () => {
    // BUG THIS CATCHES (#1414): an unbounded walk on a 2 s session-start probe
    // must be able to give up, and giving up must NOT read as "never happened".
    // `truncated: true` with `stopped: false` is the undeterminable state.
    const { scanEventsBackwards } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    writeFileSync(active, rec('2026-09-20T00:00:00Z').repeat(50));

    const result = scanEventsBackwards({
      filePath: active,
      budgetMs: -1, // already expired when the walk starts
      onRecord: () => false,
    });

    expect(result.truncated).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.sources).toEqual([]);
  });

  it('names an unreadable source instead of reporting an empty walk', async () => {
    const { scanEventsBackwards } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    mkdirSync(active); // a DIRECTORY where the ledger should be: EISDIR on read

    const result = scanEventsBackwards({ filePath: active, onRecord: () => true });

    expect(result.unreadable).toEqual([active]);
    expect(result.stopped).toBe(false);
  });

  it('counts an unreadable line among the matching ones instead of skipping it silently', async () => {
    const { scanEventsBackwards } = await importEventsWithDir(dir);
    const active = path.join(dir, 'events.jsonl');
    writeFileSync(
      active,
      `{"event":"orchestrator.evolve.completed","timestamp":"2026-05-0\n` +
        rec('2026-09-01T00:00:00Z'),
    );

    const result = scanEventsBackwards({
      filePath: active,
      filter: 'orchestrator.evolve.completed',
      onRecord: () => true,
    });

    expect(result.stopped).toBe(false);
    expect(result.malformed_lines).toBe(1);
  });
});
