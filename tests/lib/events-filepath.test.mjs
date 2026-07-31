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

describe('emitEvent / eventsFilePath — opts.repoRoot parameter (#941)', () => {
  // The clean interface that replaced the hand-built `join(repoRoot, …)` recipes
  // at quality-gate.mjs and lock-reaper.mjs. `otherRepo` is a SECOND tree,
  // distinct from the SO_PROJECT_DIR default (= tmpDir) — so a regression to the
  // bare default would write to tmpDir and the "default NOT written" assertion
  // fails (the fake-regression guard).
  let tmpDir;
  let otherRepo;
  const origClaudeProjectDir = process.env.CLAUDE_PROJECT_DIR;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'so-events-reporoot-default-'));
    otherRepo = await mkdtemp(path.join(tmpdir(), 'so-events-reporoot-target-'));
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
    await rm(otherRepo, { recursive: true, force: true });
  });

  it('eventsFilePath(repoRoot) resolves under the SUPPLIED repoRoot, not SO_PROJECT_DIR', async () => {
    const { eventsFilePath } = await importEventsWithDir(tmpDir);

    // Bare call → SO_PROJECT_DIR default (= tmpDir).
    expect(eventsFilePath()).toBe(path.join(tmpDir, '.orchestrator', 'metrics', 'events.jsonl'));
    // Explicit repoRoot → that tree.
    expect(eventsFilePath(otherRepo)).toBe(
      path.join(otherRepo, '.orchestrator', 'metrics', 'events.jsonl'),
    );
  });

  it('emitEvent(type, payload, { repoRoot }) writes to the repoRoot-local log, NOT the global default', async () => {
    const { emitEvent, eventsFilePath } = await importEventsWithDir(tmpDir);

    await emitEvent('orchestrator.quality_gate.passed', { variant: 'auto-fix-loop' }, { repoRoot: otherRepo });

    // The repoRoot-local events.jsonl got the record.
    const targetPath = path.join(otherRepo, '.orchestrator', 'metrics', 'events.jsonl');
    const content = await readFile(targetPath, 'utf8');
    const record = JSON.parse(content.trim().split('\n')[0]);
    expect(record.event).toBe('orchestrator.quality_gate.passed');
    expect(record.variant).toBe('auto-fix-loop');

    // Fake-regression guard: the SO_PROJECT_DIR-global default (= tmpDir) must
    // NOT have been written. If emitEvent ignored opts.repoRoot (the pre-#941
    // behaviour that pinned every call to SO_PROJECT_DIR), this record would land
    // in the global log and this assertion would go red.
    await expect(access(eventsFilePath())).rejects.toThrow();
  });

  it('opts.filePath still wins over opts.repoRoot (explicit path is the strongest override)', async () => {
    const { emitEvent } = await importEventsWithDir(tmpDir);
    const overridePath = path.join(otherRepo, 'explicit', 'pinned.jsonl');

    await emitEvent('override.precedence', {}, { filePath: overridePath, repoRoot: otherRepo });

    // filePath wins.
    await expect(access(overridePath)).resolves.toBeUndefined();
    // The repoRoot-derived path was NOT used.
    await expect(
      access(path.join(otherRepo, '.orchestrator', 'metrics', 'events.jsonl')),
    ).rejects.toThrow();
  });
});
