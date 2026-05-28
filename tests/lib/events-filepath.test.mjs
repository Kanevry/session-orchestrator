/**
 * tests/lib/events-filepath.test.mjs
 *
 * Unit tests for the additive `opts.filePath` override on emitEvent()
 * (scripts/lib/events.mjs) — issue #611.
 *
 * Two guarantees under test:
 *   (a) emitEvent(type, payload, { filePath }) writes to the SUPPLIED path,
 *       NOT to eventsFilePath().
 *   (b) The 2-arg form emitEvent(type, payload) still resolves to
 *       eventsFilePath() (byte-identical default behaviour preserved).
 *
 * Isolation: platform.mjs resolves SO_PROJECT_DIR from CLAUDE_PROJECT_DIR; each
 * test sets it to a fresh tmpDir and re-imports the module (vi.resetModules).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function importEventsWithDir(dir) {
  process.env.CLAUDE_PROJECT_DIR = dir;
  vi.resetModules();
  return import('@lib/events.mjs');
}

describe('emitEvent — opts.filePath override (#611)', () => {
  let tmpDir;
  const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'so-events-filepath-'));
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

  it('(a) writes to the supplied filePath, not to eventsFilePath()', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    const overridePath = path.join(tmpDir, 'custom', 'override.jsonl');

    await emitEvent('orchestrator.grounding.injected', { file: 'x.ts', lines: 12 }, { filePath: overridePath });

    // The override path got the record.
    const content = await readFile(overridePath, 'utf8');
    const record = JSON.parse(content.trim().split('\n')[0]);
    expect(record.event).toBe('orchestrator.grounding.injected');
    expect(record.file).toBe('x.ts');
    expect(record.lines).toBe(12);

    // The default path must NOT have been written.
    await expect(access(eventsFilePath())).rejects.toThrow();
  });

  it('(a) auto-creates the parent directory of the supplied filePath', async () => {
    const { emitEvent } = await importEventsWithDir(tmpDir);
    const overridePath = path.join(tmpDir, 'deeply', 'nested', 'dir', 'out.jsonl');

    await emitEvent('test.override.mkdir', {}, { filePath: overridePath });

    await expect(access(overridePath)).resolves.toBeUndefined();
  });

  it('(b) 2-arg call still resolves to eventsFilePath() (default preserved)', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);

    await emitEvent('orchestrator.session.started', { session_id: 's1' });

    const content = await readFile(eventsFilePath(), 'utf8');
    const record = JSON.parse(content.trim().split('\n')[0]);
    expect(record.event).toBe('orchestrator.session.started');
    expect(record.session_id).toBe('s1');
  });

  it('(b) empty-opts call also resolves to eventsFilePath() (no filePath key)', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);

    await emitEvent('orchestrator.session.ended', { reason: 'clear' }, {});

    const content = await readFile(eventsFilePath(), 'utf8');
    const record = JSON.parse(content.trim().split('\n')[0]);
    expect(record.event).toBe('orchestrator.session.ended');
    expect(record.reason).toBe('clear');
  });

  it('default and override target distinct files in the same call sequence', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);
    const overridePath = path.join(tmpDir, 'side-channel.jsonl');

    await emitEvent('default.dest', { n: 1 });
    await emitEvent('override.dest', { n: 2 }, { filePath: overridePath });

    const defaultContent = await readFile(eventsFilePath(), 'utf8');
    const overrideContent = await readFile(overridePath, 'utf8');

    const defaultRecords = defaultContent.trim().split('\n').map((l) => JSON.parse(l));
    const overrideRecords = overrideContent.trim().split('\n').map((l) => JSON.parse(l));

    expect(defaultRecords).toHaveLength(1);
    expect(defaultRecords[0].event).toBe('default.dest');
    expect(overrideRecords).toHaveLength(1);
    expect(overrideRecords[0].event).toBe('override.dest');
  });
});
