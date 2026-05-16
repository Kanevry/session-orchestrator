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
import { tmpdir } from 'node:os';
import path from 'node:path';

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
});
