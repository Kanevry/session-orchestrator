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
    const { deriveRepo } = await import('../../../scripts/lib/vault-mirror/process.mjs');
    expect(deriveRepo()).toBe('org/repo');
  });

  it('parses https origin format: https://host/org/name.git -> "org/name"', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => 'https://gitlab.example.com/Kanevry/session-orchestrator.git\n') };
    });
    const { deriveRepo } = await import('../../../scripts/lib/vault-mirror/process.mjs');
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
    const { deriveRepo } = await import('../../../scripts/lib/vault-mirror/process.mjs');
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
    const { deriveRepo } = await import('../../../scripts/lib/vault-mirror/process.mjs');
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
    const { emitAction } = await import('../../../scripts/lib/vault-mirror/process.mjs');
    const vaultDir = '/vault';
    const filePath = '/vault/40-learnings/my-learning.md';
    const { lines } = captureStdout(() => emitAction('created', filePath, 'learning', 'my-id', vaultDir));
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
    const { emitAction } = await import('../../../scripts/lib/vault-mirror/process.mjs');
    const vaultDir = '/vault';
    const filePath = '/vault/50-sessions/session.md';
    const { lines } = captureStdout(() => emitAction('created', filePath, 'session', 'sess-id', vaultDir));
    expect(lines[0].path).toBe('50-sessions/session.md');
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
    const mod = await import('../../../scripts/lib/vault-mirror/process.mjs');
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

  it('throws when id is null', async () => {
    const processLearning = await getProcessLearning();
    await expect(
      processLearning({ ...VALID_V1, id: null }, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
    ).rejects.toThrow("missing required field 'id'");
  });

  it('throws when id is undefined', async () => {
    const processLearning = await getProcessLearning();
    const { id: _id, ...noId } = VALID_V1;
    await expect(
      processLearning(noId, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' })
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
    const mod = await import('../../../scripts/lib/vault-mirror/process.mjs');
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
