/**
 * Unit tests for scripts/lib/vault-mirror/process.mjs
 * Focus: deriveRepo, emitAction, processLearning, processSession
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function captureStdout(fn) {
  const lines = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    if (typeof chunk === 'string') {
      for (const line of chunk.split('\n').filter(Boolean)) {
        try { lines.push(JSON.parse(line)); } catch { /* non-JSON skip */ }
      }
    }
    return true;
  });
  const result = fn();
  if (result && typeof result.then === 'function') {
    return result.then((v) => { spy.mockRestore(); return { lines, value: v }; })
      .catch((e) => { spy.mockRestore(); throw e; });
  }
  spy.mockRestore();
  return { lines, value: result };
}

// ── deriveRepo ────────────────────────────────────────────────────────────────

// Each deriveRepo test resets module cache so the _cachedRepo = null is fresh.

describe('deriveRepo', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
  });

  it('parses ssh origin format: git@host:org/name.git -> "org/name"', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@github.com:org/repo.git\n') };
    });
    const { deriveRepo } = await import('@lib/vault-mirror/process.mjs');
    expect(deriveRepo()).toBe('org/repo');
  });

  it('parses https origin format: https://host/org/name.git -> "org/name"', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'https://gitlab.example.com/Kanevry/session-orchestrator.git\n') };
    });
    const { deriveRepo } = await import('@lib/vault-mirror/process.mjs');
    expect(deriveRepo()).toBe('Kanevry/session-orchestrator');
  });

  it('falls back to basename(cwd) when execFileSync throws', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return {
        ...actual,
        execFileSync: vi.fn(() => { throw new Error('not a git repo'); }),
      };
    });
    const { deriveRepo } = await import('@lib/vault-mirror/process.mjs');
    const { basename } = await import('node:path');
    expect(deriveRepo()).toBe(basename(process.cwd()));
  });

  it('is cached: execFileSync called at most once across multiple calls', async () => {
    vi.resetModules();
    const mockExec = vi.fn(() => 'git@github.com:cached/repo.git\n');
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: mockExec };
    });
    const { deriveRepo } = await import('@lib/vault-mirror/process.mjs');
    deriveRepo();
    deriveRepo();
    deriveRepo();
    expect(mockExec).toHaveBeenCalledTimes(1);
  });
});

// ── emitAction ────────────────────────────────────────────────────────────────

describe('emitAction', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
  });

  it('emits a JSON line with action, kind, and id fields', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const { emitAction } = await import('@lib/vault-mirror/process.mjs');
    const vaultDir = '/vault';
    const filePath = '/vault/40-learnings/my-learning.md';
    const { lines } = captureStdout(() =>
      emitAction({ action: 'created', path: filePath, kind: 'learning', id: 'my-id', vaultDir }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(lines[0].kind).toBe('learning');
    expect(lines[0].id).toBe('my-id');
  });

  it('normalizes path to be relative to vaultDir', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const { emitAction } = await import('@lib/vault-mirror/process.mjs');
    const vaultDir = '/vault';
    const filePath = '/vault/50-sessions/session.md';
    const { lines } = captureStdout(() =>
      emitAction({ action: 'created', path: filePath, kind: 'session', id: 'sess-id', vaultDir }),
    );
    expect(lines[0].path).toBe('50-sessions/session.md');
    // Negative: the absolute input path must NOT leak into the emitted payload
    // under a `filePath` key. Kills a mutation that bundles the raw absolute
    // path alongside the relativized `path` (e.g. { path: rel, filePath: path }).
    expect(lines[0]).not.toHaveProperty('filePath');
  });
});

// ── processLearning ───────────────────────────────────────────────────────────

describe('processLearning', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let writeFileSyncSpy;
  let _mkdirSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    _mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function getProcessLearning() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processLearning;
  }

  const VALID_V1 = {
    id: 'a1b2c3d4-0001-4000-8000-000000000001',
    type: 'architectural',
    subject: 'explicit-contracts',
    insight: 'Prefer explicit contracts',
    evidence: 'Three modules broke',
    confidence: 0.9,
    source_session: 'session-2026-04-13',
    created_at: '2026-04-13T10:00:00Z',
  };

  it('derives id from the subject slug when id is null (#635 normalization)', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    const { lines } = await captureStdout(() =>
      processLearning({ ...VALID_V1, id: null }, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'created', id: 'explicit-contracts' });
  });

  it('derives id from the subject slug when id is undefined (#635 normalization)', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    const { id: _id, ...noId } = VALID_V1;
    const { lines } = await captureStdout(() =>
      processLearning(noId, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'created', id: 'explicit-contracts' });
  });

  it('still throws missing id when neither id nor any subject/insight source exists', async () => {
    const processLearning = await getProcessLearning();
    await expect(
      processLearning(
        { type: 'architectural', evidence: 'E', confidence: 0.9, created_at: '2026-04-13T10:00:00Z' },
        1,
        { vaultDir: '/vault', dryRun: false, kind: 'learning' }
      )
    ).rejects.toThrow("missing required field 'id'");
  });

  it('skips hand-written file when no _generator marker present', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('---\nid: explicit-contracts\ntitle: Manual\n---\n\nHand written.\n');
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-handwritten');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('creates new file when path does not exist (dry-run=false)', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
  });

  it('skips write in dry-run mode but still emits created action', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: true, kind: 'learning' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('emits skipped-noop when file is up-to-date and force=false', async () => {
    existsSyncSpy.mockReturnValue(true);
    // Existing file has same date as entry
    readFileSyncSpy.mockReturnValue(
      '---\nid: explicit-contracts\nupdated: 2026-04-13\n_generator: session-orchestrator-vault-mirror@1\n---\n'
    );
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-noop');
  });

  it('emits updated and writes when force=true even if date matches', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '---\nid: explicit-contracts\nupdated: 2026-04-13\n_generator: session-orchestrator-vault-mirror@1\n---\n'
    );
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: true })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('updated');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
  });

  it('uses v2 generator for entries with text field', async () => {
    existsSyncSpy.mockReturnValue(false);
    const v2Entry = {
      id: 's69-compose-pids',
      type: 'gotcha',
      text: 'docker-compose cross-validates pids_limit',
      scope: 'infra/docker',
      confidence: 0.85,
      first_seen: '2026-04-19',
    };
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(v2Entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    // v2 slug comes from id directly: 's69-compose-pids'
    expect(lines[0].id).toBe('s69-compose-pids');
  });

  it('emits skipped-collision-resolved when slug clashes with different id', async () => {
    // First existsSync: the main slug path → true (collision)
    // Second existsSync: the disambig path → false (no collision there)
    existsSyncSpy
      .mockReturnValueOnce(true)  // targetDir (mkdirSync won't be called in dry-run)
      .mockReturnValueOnce(true)  // main slug file exists
      .mockReturnValueOnce(false); // disambig file does not exist
    readFileSyncSpy.mockReturnValue(
      '---\nid: different-id\nupdated: 2026-01-01\n_generator: session-orchestrator-vault-mirror@1\n---\n'
    );
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-collision-resolved');
  });
});

// ── processSession ────────────────────────────────────────────────────────────

describe('processSession', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let writeFileSyncSpy;
  let _mkdirSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    _mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function getProcessSession() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processSession;
  }

  const VALID_V1_SESSION = {
    session_id: 'session-2026-04-13',
    session_type: 'feature',
    started_at: '2026-04-13T08:00:00Z',
    completed_at: '2026-04-13T10:00:00Z',
    duration_seconds: 7200,
    total_waves: 1,
    total_agents: 2,
    total_files_changed: 4,
    agent_summary: { complete: 2, partial: 0, failed: 0, spiral: 0 },
    waves: [{ wave: 1, role: 'Planning', agent_count: 2, files_changed: 4, quality: 'ok' }],
    effectiveness: { planned_issues: 1, completed: 1, carryover: 0, emergent: 0, completion_rate: 1.0 },
  };

  it('sanitises session_id with slashes via subjectToSlug (last segment)', async () => {
    existsSyncSpy.mockReturnValue(false);
    const slashyEntry = { ...VALID_V1_SESSION, session_id: 'feat/my-feature-2026-04-13' };
    const processSession = await getProcessSession();

    const { lines } = await captureStdout(() =>
      processSession(slashyEntry, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    // slug should be last segment of slash-path
    expect(lines[0].id).toBe('my-feature-2026-04-13');
  });

  it('creates file when path does not exist', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession();

    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
  });

  it('skips write in dry-run mode but emits created action', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession();

    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, { vaultDir: '/vault', dryRun: true, kind: 'session' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('emits skipped-noop when existing file has same generator and date is not newer', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '---\nid: session-2026-04-13\nupdated: 2026-04-13\n_generator: session-orchestrator-vault-mirror@1\n---\n'
    );
    const processSession = await getProcessSession();

    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, { vaultDir: '/vault', dryRun: false, kind: 'session', force: false })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-noop');
  });

  it('emits skipped-handwritten when existing file lacks _generator', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue('---\nid: session-2026-04-13\ntitle: Manual\n---\n\nHand written.\n');
    const processSession = await getProcessSession();

    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-handwritten');
  });

  it('uses completed_at date for the updated field comparison', async () => {
    // completed_at is 2026-04-14, existing file updated 2026-04-13 → should update
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '---\nid: session-2026-04-13\nupdated: 2026-04-13\n_generator: session-orchestrator-vault-mirror@1\n---\n'
    );
    const newerEntry = { ...VALID_V1_SESSION, completed_at: '2026-04-14T10:00:00Z' };
    const processSession = await getProcessSession();

    const { lines } = await captureStdout(() =>
      processSession(newerEntry, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' })
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('updated');
  });
});

// ── quality gate (PRD F1.2) ───────────────────────────────────────────────────

describe('quality gate', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let writeFileSyncSpy;
  let _mkdirSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    _mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function getProcessLearning() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processLearning;
  }

  async function getProcessSession() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processSession;
  }

  // ── learning quality gate ──────────────────────────────────────────────────

  const LEARNING_BASE = {
    id: 'a1b2c3d4-0001-4000-8000-000000000099',
    type: 'architectural',
    subject: 'quality-gate-probe',
    insight: 'gate behaviour',
    evidence: 'unit test',
    source_session: 'session-2026-05-21',
    created_at: '2026-05-21T10:00:00Z',
  };

  it('learning: confidence 0.49 below threshold 0.5 emits skipped-quality-low with reason', async () => {
    existsSyncSpy.mockReturnValue(false);
    writeFileSyncSpy.mockReturnValue(undefined);
    const processLearning = await getProcessLearning();
    const entry = { ...LEARNING_BASE, confidence: 0.49 };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
        qualityMinConfidence: 0.5,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
    expect(lines[0].path).toBe(null);
    expect(lines[0].id).toBe(LEARNING_BASE.id);
    expect(lines[0].reason).toBe('confidence:0.49 < min:0.5');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('learning: confidence non-numeric (string) defaults to 1.0 in the gate and passes through to created', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    // String value → typeof !== 'number' → gate fallback to 1.0 → must NOT be
    // caught by the gate. The renderer accepts any truthy value for confidence
    // (only null/undefined is rejected at the schema layer), so the entry
    // reaches the create-action path.
    const entry = { ...LEARNING_BASE, confidence: 'high' };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
        qualityMinConfidence: 0.5,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
  });

  it('learning: --force does NOT bypass quality gate (confidence 0.4 + force=true → skipped)', async () => {
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '---\nid: quality-gate-probe\nupdated: 2026-04-13\n_generator: session-orchestrator-vault-mirror@1\n---\n',
    );
    const processLearning = await getProcessLearning();
    const entry = { ...LEARNING_BASE, confidence: 0.4 };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
        force: true,
        qualityMinConfidence: 0.5,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('learning: qualityMinConfidence=0.0 lets ALL entries pass the gate (gate disabled)', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    const entry = { ...LEARNING_BASE, confidence: 0.0 };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
        qualityMinConfidence: 0.0,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
  });

  it('learning: qualityMinConfidence=1.0 skips entries with confidence=0.99', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    const entry = { ...LEARNING_BASE, confidence: 0.99 };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
        qualityMinConfidence: 1.0,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
    expect(lines[0].reason).toBe('confidence:0.99 < min:1');
  });

  it('learning: quality gate runs BEFORE existsSync (collision path is not entered)', async () => {
    // existsSync would return true (collision exists), but the quality gate
    // must short-circuit before the existsSync call → no readFileSync, no
    // collision-resolved action.
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '---\nid: different-id\nupdated: 2099-01-01\n_generator: session-orchestrator-vault-mirror@1\n---\n',
    );
    const processLearning = await getProcessLearning();
    const entry = { ...LEARNING_BASE, confidence: 0.3 };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
        qualityMinConfidence: 0.5,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
    // readFileSync must NOT have been called — collision detection never reached.
    expect(readFileSyncSpy).not.toHaveBeenCalled();
  });

  // ── session quality gate ───────────────────────────────────────────────────

  const VALID_V1_SESSION = {
    session_id: 'session-2026-05-21',
    session_type: 'feature',
    started_at: '2026-05-21T08:00:00Z',
    completed_at: '2026-05-21T10:00:00Z',
    duration_seconds: 7200,
    total_waves: 1,
    total_agents: 2,
    total_files_changed: 4,
    agent_summary: { complete: 2, partial: 0, failed: 0, spiral: 0 },
    waves: [{ wave: 1, role: 'Planning', agent_count: 2, files_changed: 4, quality: 'ok' }],
    effectiveness: { planned_issues: 1, completed: 1, carryover: 0, emergent: 0, completion_rate: 1.0 },
  };

  it('session: narrative-length BOUNDARY — chars === qualityMinNarrativeChars passes the gate', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession();
    // The rendered narrative for VALID_V1_SESSION is a known length; set the
    // threshold equal to it so the gate condition `narrative < min` is false.
    // The empirical narrative length on this fixture is 456 chars (verified
    // independently); set threshold equal to that to exercise the boundary.
    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'session',
        qualityMinNarrativeChars: 456,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
  });

  it('session: narrative-length BOUNDARY — chars < threshold by 1 → skipped-quality-low', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession();
    // Same fixture renders to 456 chars → threshold 457 must trip the gate.
    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'session',
        qualityMinNarrativeChars: 457,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
    expect(lines[0].path).toBe(null);
    expect(lines[0].id).toBe('session-2026-05-21');
    expect(lines[0].reason).toBe('narrative:456 < min:457');
  });

  it('session: --force does NOT bypass quality gate (force=true + short-narrative threshold → skipped)', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession();
    // Threshold higher than fixture length forces the gate; --force must not bypass it.
    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'session',
        force: true,
        qualityMinNarrativeChars: 10000,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
  });

  it('session: skipped-quality-low entry carries path: null AND reason field', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession();
    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'session',
        qualityMinNarrativeChars: 10000,
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
    expect(lines[0].path).toBe(null);
    expect(typeof lines[0].reason).toBe('string');
    expect(lines[0].reason).toMatch(/^narrative:\d+ < min:\d+$/);
  });

  it('session: default qualityMinNarrativeChars=400 is applied when ctx omits the field', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession();
    // No qualityMinNarrativeChars in ctx → defaults to 400 → fixture (456) passes.
    const { lines } = await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'session',
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
  });

  it('learning: default qualityMinConfidence=0.5 applied when ctx omits the field', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    const entry = { ...LEARNING_BASE, confidence: 0.3 };

    // ctx without qualityMinConfidence → defaults to 0.5 → entry skipped
    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-quality-low');
  });
});

// ── #635 slug-length cap (ENAMETOOLONG guard) ────────────────────────────────

describe('processLearning slug-length cap (#635)', () => {
  let existsSyncSpy;
  let writeFileSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  it('caps a prose-subject slug at 240 chars so the filename stays under 255 bytes', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const { processLearning } = await import('@lib/vault-mirror/process.mjs');

    const longSubject = 'w '.repeat(160).trim() + ' tail'; // slugifies far past 240 chars
    const entry = {
      id: 'long-subject-entry',
      type: 'process-pattern',
      subject: longSubject,
      insight: 'Some insight',
      evidence: 'Some evidence',
      confidence: 0.9,
      source_session: 's-1',
      created_at: '2026-06-01T00:00:00Z',
    };

    const lines = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string') {
        for (const line of chunk.split('\n').filter(Boolean)) {
          try { lines.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
      return true;
    });
    await processLearning(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' });
    stdoutSpy.mockRestore();

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(lines[0].id.length).toBeLessThanOrEqual(240);
    const writtenPath = writeFileSyncSpy.mock.calls[0][0];
    const filename = writtenPath.split('/').pop();
    expect(filename.length).toBeLessThanOrEqual(255);
    expect(existsSyncSpy).toHaveBeenCalled();
  });
});

// ── #635 session slug-length cap (symmetric to learnings) ───────────────────

describe('processSession slug-length cap (#635)', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  it('caps a pathologically long session_id slug at 240 chars', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const { processSession } = await import('@lib/vault-mirror/process.mjs');

    const longId = 'main-' + 'a1-'.repeat(120) + 'end'; // valid kebab slug far past 240 chars
    const entry = {
      session_id: longId,
      session_type: 'deep',
      started_at: '2026-06-11T09:00:00Z',
      completed_at: '2026-06-11T10:00:00Z',
      waves: 1,
      agents_dispatched: 2,
      effectiveness: { completion_rate: 1, carryover: 0, completed_issues: 1 },
      notes: 'n'.repeat(500), // keep rendered narrative above the 400-char quality floor
    };

    const lines = [];
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      if (typeof chunk === 'string') {
        for (const line of chunk.split('\n').filter(Boolean)) {
          try { lines.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
      return true;
    });
    await processSession(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' });
    stdoutSpy.mockRestore();

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(lines[0].id.length).toBeLessThanOrEqual(240);
  });
});

// ── #698 content-diff (detect-and-rewrite vs skipped-noop) ───────────────────
//
// These tests exercise the new learningContentMatches() path inside processLearning:
// when the file's `updated` date does NOT advance, the engine renders a candidate
// and compares canonical fields. If any differ → `updated`; if all match → `skipped-noop`.
//
// Falsification guarantee for the POSITIVE test (#698-positive-detect-rewrite):
//   If the content-diff fix were reverted (i.e., the engine went straight to
//   `skipped-noop` whenever updated does not advance — the pre-#698 behavior),
//   that test would assert `updated` but receive `skipped-noop`, and would FAIL.

describe('processLearning #698 content-diff: detect-and-rewrite vs skipped-noop', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let writeFileSyncSpy;
  let _mkdirSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    _mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function getProcessLearning() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processLearning;
  }

  // Entry with confidence=0.9, insight='Prefer explicit contracts', created_at='2026-04-13T10:00:00Z'
  // → updated date derived from created_at → '2026-04-13'
  // The existing note on disk will report updated: 2026-04-13 (same date, does NOT advance).
  const ENTRY_V1 = {
    id: 'a1b2c3d4-0001-4000-8000-000000000001',
    type: 'architectural',
    subject: 'explicit-contracts',
    insight: 'Prefer explicit contracts',
    evidence: 'Three modules broke',
    confidence: 0.9,
    source_session: 'session-2026-04-13',
    created_at: '2026-04-13T10:00:00Z',
  };

  // A generator-owned note where confidence bullet says 0.7 (stale) while entry has 0.9.
  // status: draft (confidence<=0.8 → draft in the renderer) also differs from verified.
  // updated: 2026-04-13 = same as entry's derived date → date does NOT advance.
  const EXISTING_NOTE_CONFIDENCE_MISMATCH =
    '---\n' +
    'id: explicit-contracts\n' +
    'type: learning\n' +
    'title: Prefer explicit contracts\n' +
    'status: draft\n' +
    'created: 2026-04-13\n' +
    'updated: 2026-04-13\n' +
    'tags: [learning-architectural, status-draft, source-session-2026-04-13]\n' +
    'source_session: "[[session-2026-04-13]]"\n' +
    '_generator: session-orchestrator-vault-mirror@1\n' +
    '---\n' +
    '\n' +
    '# Prefer explicit contracts\n' +
    '\n' +
    '- **Type:** architectural\n' +
    '- **Confidence:** 0.7\n' +
    '- **Source session:** [[session-2026-04-13]]\n' +
    '\n' +
    '## Insight\n' +
    '\n' +
    'Prefer explicit contracts\n' +
    '\n' +
    '## Evidence\n' +
    '\n' +
    'Three modules broke\n';

  // A generator-owned note whose canonical fields EXACTLY match what the renderer
  // would produce for ENTRY_V1: confidence=0.9, status=verified, same insight body.
  // updated: 2026-04-13 = same as entry → date does NOT advance.
  const EXISTING_NOTE_IDENTICAL =
    '---\n' +
    'id: explicit-contracts\n' +
    'type: learning\n' +
    'title: Prefer explicit contracts\n' +
    'status: verified\n' +
    'created: 2026-04-13\n' +
    'updated: 2026-04-13\n' +
    'tags: [learning-architectural, status-verified, source-session-2026-04-13]\n' +
    // #704: source_session is now a canonical content-diff field. ENTRY_V1's
    // 'session-2026-04-13' is NOT a resolvable session id, so the renderer emits
    // plain text (no [[wikilink]]). This fixture represents a note already in the
    // repaired plain form → a re-mirror is a true no-op → skipped-noop.
    'source_session: session-2026-04-13\n' +
    '_generator: session-orchestrator-vault-mirror@1\n' +
    '---\n' +
    '\n' +
    '# Prefer explicit contracts\n' +
    '\n' +
    '- **Type:** architectural\n' +
    '- **Confidence:** 0.9\n' +
    '- **Source session:** session-2026-04-13\n' +
    '\n' +
    '## Insight\n' +
    '\n' +
    'Prefer explicit contracts\n' +
    '\n' +
    '## Evidence\n' +
    '\n' +
    'Three modules broke\n';

  it('#698-positive: existing note with stale confidence (0.7) emits updated, NOT skipped-noop', async () => {
    // The existing note has updated=2026-04-13 matching entry's created_at → date does NOT advance.
    // BUT confidence bullet is 0.7 vs entry's 0.9 → content-diff detects change → emits updated.
    //
    // Falsification: revert the content-diff fix → engine always emits skipped-noop when
    // date does not advance → this test fails (received 'skipped-noop', expected 'updated').
    //
    // existsSync call order in processLearning:
    //   call 1: existsSync(targetPath) at line 235 → true  (namespaced file exists)
    //   call 2: existsSync(legacyFlatPath) at line 235 — NOT reached because call 1 is true
    //   call 3: existsSync(targetPath) at line 255 → true  (same check, same result)
    existsSyncSpy.mockReturnValue(true);  // all existsSync calls return true
    readFileSyncSpy.mockReturnValue(EXISTING_NOTE_CONFIDENCE_MISMATCH);
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(ENTRY_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('updated');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
  });

  it('#698-negative: existing note with identical canonical fields emits skipped-noop (no churn)', async () => {
    // Updated date same as entry, all canonical fields match (confidence=0.9, status=verified,
    // insight='Prefer explicit contracts') → learningContentMatches returns true → skipped-noop.
    //
    // existsSync call order:
    //   call 1: existsSync(targetPath) at line 235 → true (namespaced file exists)
    //   call 3: existsSync(targetPath) at line 255 → true (same path, same mock)
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(EXISTING_NOTE_IDENTICAL);
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(ENTRY_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-noop');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('#704: existing note with stale dangling [[wikilink]] source_session self-heals (emits updated, not skipped-noop)', async () => {
    // A historical note still carries the OLD dangling form `source_session: "[[session-2026-04-13]]"`.
    // ENTRY_V1's 'session-2026-04-13' is unresolvable → the renderer now emits plain text. Because #704
    // added source_session to the canonical content-diff (learningContentMatches), the stale wikilink is
    // detected and the note is re-rendered (repaired) on a NORMAL mirror run — no --force needed.
    // Falsification: drop source_session from learningContentMatches → received 'skipped-noop', this fails.
    const EXISTING_NOTE_DANGLING = EXISTING_NOTE_IDENTICAL
      .replace('source_session: session-2026-04-13', 'source_session: "[[session-2026-04-13]]"')
      .replace('- **Source session:** session-2026-04-13', '- **Source session:** [[session-2026-04-13]]');
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(EXISTING_NOTE_DANGLING);
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(ENTRY_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('updated');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
  });

  it('#698-invariant-create: file absent still emits created (content-diff path not reached)', async () => {
    // Both existsSync calls return false → falls through to create path.
    // The content-diff code is never entered. Guard against regression in create path.
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(ENTRY_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
  });

  it('#698-invariant-handwritten: no _generator marker still emits skipped-handwritten', async () => {
    // Even with the content-diff logic active, hand-authored notes must still be refused.
    //
    // existsSync call order:
    //   call 1: existsSync(targetPath) at line 235 → true (namespaced file exists, skip dual-probe)
    //   call 3: existsSync(targetPath) at line 255 → true
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '---\nid: explicit-contracts\ntitle: My Manual Note\n---\n\nHand written content.\n'
    );
    const processLearning = await getProcessLearning();

    const { lines } = await captureStdout(() =>
      processLearning(ENTRY_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false })
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('skipped-handwritten');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });
});

// ── #701.1 dual-probe date-advance fall-through ───────────────────────────────
//
// The #701.1 branch: a legacy flat note exists, the namespaced target is absent,
// the legacy note is generator-owned with a matching id, AND the entry's `updated`
// date ADVANCES past the legacy note's `updated`. In this case the code must NOT
// emit skipped-noop — it should fall through and write to the NAMESPACED path
// (not back to the legacy flat path).
//
// The complementary "date does not advance + content matches → skipped-noop" branch
// is covered by the existing test at line ~253.

describe('processLearning #701.1 dual-probe date-advance fall-through', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let writeFileSyncSpy;
  let _mkdirSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    _mkdirSyncSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function getProcessLearning() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'git@x:o/r.git\n') };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processLearning;
  }

  it('date advances past legacy flat note → does NOT emit skipped-noop; writes to namespaced path', async () => {
    // Setup:
    //   - Entry's created_at is '2026-05-01T10:00:00Z' → updated derived to '2026-05-01'.
    //   - Legacy flat note has updated: 2026-04-13 (OLDER → date ADVANCES).
    //   - Namespaced targetPath (/vault/40-learnings/r/explicit-contracts.md) is ABSENT.
    //   - legacyFlatPath (/vault/40-learnings/explicit-contracts.md) EXISTS
    //     with a generator-owned note whose id matches the slug.
    //
    // The dual-probe block: legacyFm['updated'] ('2026-04-13') < entryUpdated ('2026-05-01')
    // → does NOT enter the skipped-noop branch → falls through to write into namespaced path.
    //
    // Git mock: 'git@x:o/r.git' → repo='o/r' → repoNs='r'
    // so namespaced targetPath = /vault/40-learnings/r/explicit-contracts.md
    //    legacyFlatPath        = /vault/40-learnings/explicit-contracts.md
    //
    // existsSync call order in processLearning (post #660 dual-probe logic):
    //   1st: targetPath (namespaced)  → false
    //   2nd: legacyFlatPath (flat)    → true
    //   3rd: targetPath again in the second block → false (→ create)
    const LEGACY_FLAT_NOTE =
      '---\n' +
      'id: explicit-contracts\n' +
      'type: learning\n' +
      'title: Prefer explicit contracts\n' +
      'status: verified\n' +
      'created: 2026-04-13\n' +
      'updated: 2026-04-13\n' +
      'tags: [learning-architectural, status-verified, source-session-2026-04-13]\n' +
      'source_session: "[[session-2026-04-13]]"\n' +
      '_generator: session-orchestrator-vault-mirror@1\n' +
      '---\n' +
      '\n' +
      '# Prefer explicit contracts\n' +
      '\n' +
      '- **Type:** architectural\n' +
      '- **Confidence:** 0.9\n' +
      '- **Source session:** [[session-2026-04-13]]\n' +
      '\n' +
      '## Insight\n' +
      '\n' +
      'Prefer explicit contracts\n' +
      '\n' +
      '## Evidence\n' +
      '\n' +
      'Three modules broke\n';

    existsSyncSpy
      .mockReturnValueOnce(false)   // 1st: targetPath (namespaced) → absent
      .mockReturnValueOnce(true)    // 2nd: legacyFlatPath → exists
      .mockReturnValueOnce(false);  // 3rd: targetPath in second block → absent → create
    readFileSyncSpy.mockReturnValue(LEGACY_FLAT_NOTE);

    const processLearning = await getProcessLearning();

    const entry = {
      id: 'a1b2c3d4-0001-4000-8000-000000000001',
      type: 'architectural',
      subject: 'explicit-contracts',
      insight: 'Prefer explicit contracts',
      evidence: 'Three modules broke',
      confidence: 0.9,
      source_session: 'session-2026-04-13',
      created_at: '2026-05-01T10:00:00Z',  // ADVANCES past legacy '2026-04-13'
    };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false })
    );

    // Must NOT be skipped-noop — the date advanced.
    expect(lines).toHaveLength(1);
    expect(lines[0].action).not.toBe('skipped-noop');

    // Write must target the NAMESPACED path (contains '/r/'), not the legacy flat path.
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    const writtenPath = writeFileSyncSpy.mock.calls[0][0];
    expect(writtenPath).toContain('/40-learnings/r/');
    expect(writtenPath).not.toBe('/vault/40-learnings/explicit-contracts.md');
  });
});
