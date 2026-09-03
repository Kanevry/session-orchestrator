/**
 * Unit tests for scripts/lib/vault-mirror/process.mjs
 * Focus: deriveRepo, emitAction, processLearning, processSession
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import YAML from 'js-yaml';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual('node:child_process');
  return { ...actual };
});

// #1147: emitAction now also writes an `orchestrator.vault.mirror_completed`
// ledger record. These are UNIT tests of the stdout protocol — without this mock
// every processLearning/processSession case here would append synthetic records
// to the REAL `.orchestrator/metrics/events.jsonl` (the tests/lib/worktree.test.mjs
// self-poisoning class, #984). The CLI-level tests in tests/unit/vault-mirror.test.mjs
// exercise the real emitter against a pinned throwaway CLAUDE_PROJECT_DIR.
vi.mock('../../../scripts/lib/vault-mirror/telemetry.mjs', () => ({
  MIRROR_EVENT: 'orchestrator.vault.mirror_completed',
  MIRROR_RUN_EVENT: 'orchestrator.vault.mirror_run_completed',
  emitMirrorEvent: vi.fn(async () => {}),
  emitMirrorRunEvent: vi.fn(async () => {}),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Golden-record `git remote -v` stdout for ONE remote (#1039).
 *
 * Every `execFileSync` double below goes through this function, because
 * `deriveRepo()` no longer runs `git remote get-url origin` — since #1039 it
 * resolves its identity through `listRemotes` (`scripts/lib/vcs-repo-spec.mjs`),
 * a single `git -C <root> remote -v` spawn whose output is parsed as
 * `<name>\t<url> (fetch|push)` lines.
 *
 * Returning a bare URL — what these doubles used to return — parses to ZERO
 * remotes, so `deriveRepo()` degrades **silently** to `basename(process.cwd())`
 * rather than failing loudly. Twelve of the doubles in this file and its sibling
 * were in exactly that state: green, and asserting nothing about the identity
 * they claimed to pin. Route every new double through here so the next protocol
 * change touches one function instead of twenty-one call sites.
 *
 * Shape captured from real `git remote -v` output, 2026-08-19 (tab separator,
 * one fetch + one push line per remote, trailing newline).
 *
 * @param {string} url - the remote's fetch/push URL.
 * @param {string} [name] - the remote's name; `origin` unless a test needs otherwise.
 * @returns {string}
 */
function remoteV(url, name = 'origin') {
  return `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`;
}

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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@github.com:org/repo.git')) };
    });
    const { deriveRepo } = await import('@lib/vault-mirror/process.mjs');
    expect(deriveRepo()).toBe('org/repo');
  });

  it('parses https origin format: https://host/org/name.git -> "org/name"', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('https://gitlab.example.com/Kanevry/session-orchestrator.git')) };
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
    const mockExec = vi.fn(() => remoteV('git@github.com:cached/repo.git'));
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    const { emitAction } = await import('@lib/vault-mirror/process.mjs');
    const vaultDir = '/vault';
    const filePath = '/vault/40-learnings/my-learning.md';
    const { lines } = await captureStdout(() =>
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    const { emitAction } = await import('@lib/vault-mirror/process.mjs');
    const vaultDir = '/vault';
    const filePath = '/vault/50-sessions/session.md';
    const { lines } = await captureStdout(() =>
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
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

  // ── #725 D1: slug source = normalized id, not raw prose subject ──────────────

  it('#725 D1: v1 prose subject with spaces → hyphenated slug, not a concatenated run', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    // Real v1 shape: kebab id + prose subject with spaces. The slug derives from
    // the PRE-MAPPED subject (spaces → hyphens BEFORE subjectToSlug), yielding the
    // correctly-hyphenated, lowercased form — NOT the pre-fix space-collapsed run.
    const entry = {
      id: 'command-hook-continue-on-block-irrelevant',
      type: 'gotcha',
      subject: 'command hook continueOnBlock irrelevant',
      insight: 'The continueOnBlock field is ignored for command hooks',
      evidence: 'grep transcript',
      confidence: 0.9,
      source_session: 'session-2026-07-02',
      created_at: '2026-07-02T10:00:00Z',
    };
    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'created', id: 'command-hook-continueonblock-irrelevant' });
    // NOT the pre-fix space-collapsed run.
    expect(lines[0].id).not.toBe('commandhookcontinueonblockirrelevant');
  });

  it('#725 D1: v1 with space-subject and NO id → hyphenated derived slug, not a concatenated run', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    // No id → normalizeLearningEntry derives a hyphenated slug from the subject.
    const entry = {
      type: 'anti-pattern',
      subject: 'Dead fallback removal when primary parser matures',
      insight: 'Remove the fallback once the primary path is proven',
      evidence: 'grep transcript',
      confidence: 0.7,
      source_session: 'session-2026-07-02',
      created_at: '2026-07-02T10:00:00Z',
    };
    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    // Hardcoded expected slug — the correctly-hyphenated form, NOT the pre-fix
    // concatenated run 'deadfallbackremovalwhenprimaryparsermatures'.
    expect(lines[0].id).toBe('dead-fallback-removal-when-primary-parser-matures');
    expect(lines[0].id).not.toBe('deadfallbackremovalwhenprimaryparsermatures');
  });

  it('#725 D1 regression: an existing kebab subject slug is unchanged', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning();
    // subject already kebab + id equal to it → slug stays 'explicit-contracts'.
    const { lines } = await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' }),
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ action: 'created', id: 'explicit-contracts' });
  });

  // ── #725 D2: source-repo frontmatter attribution ────────────────────────────

  it('#725 D2: created learning note frontmatter carries source-repo: <repoNs>', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processLearning = await getProcessLearning(); // git mock → repo 'o/r' → repoNs 'r'
    let written = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { written = content; });
    await captureStdout(() =>
      processLearning(VALID_V1, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' }),
    );
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    expect(written).toContain('source-repo: r\n');
    // Sits inside the frontmatter block, before the _generator marker.
    expect(written.indexOf('source-repo: r')).toBeLessThan(written.indexOf('_generator:'));
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
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

  // ── #732: source-repo frontmatter attribution (rename from legacy `repo`) ──

  it('#732: created session note frontmatter carries source-repo: <repoNs>, never the raw repo:', async () => {
    existsSyncSpy.mockReturnValue(false);
    const processSession = await getProcessSession(); // git mock → repo 'o/r' → repoNs 'r'
    let written = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { written = content; });
    await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' }),
    );
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    expect(written).toContain('source-repo: r\n');
    // Sits inside the frontmatter block, before the _generator marker.
    expect(written.indexOf('source-repo: r')).toBeLessThan(written.indexOf('_generator:'));
    // The legacy raw field must be gone entirely — not just relocated.
    expect(written).not.toMatch(/^repo: /m);
  });

  it('#732: regenerating a legacy note (repo: field) on update self-heals to source-repo', async () => {
    // The on-disk note still carries the pre-#732 raw `repo:` field — the
    // exact shape a note written before the #732 fix would have.
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(
      '---\nid: session-2026-04-13\nupdated: 2026-04-13\nrepo: leaky-name\n_generator: session-orchestrator-vault-mirror@1\n---\n\nOld body.\n'
    );
    let written = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { written = content; });
    // Newer completed_at forces the date-advance branch → action 'updated'
    // (mirrors "uses completed_at date for the updated field comparison" above).
    const newerEntry = { ...VALID_V1_SESSION, completed_at: '2026-04-14T10:00:00Z' };
    const processSession = await getProcessSession(); // git mock → repo 'o/r' → repoNs 'r'

    const { lines } = await captureStdout(() =>
      processSession(newerEntry, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('updated');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    // The regenerated content self-heals to the CURRENT source-repo field —
    // the stale on-disk `repo:` field is never preserved into the rewrite;
    // the whole note body (frontmatter included) is regenerated from scratch.
    expect(written).toContain('source-repo: r\n');
    expect(written).not.toMatch(/^repo: /m);
  });
});

// ── #732: repo-namespace leak-guard reaches session frontmatter ──────────────
//
// Prior to #732, processSession rendered the frontmatter with the RAW
// deriveRepo() output (`repo: <raw org/name>`) while the write path alone used
// resolveRepoNamespace(). An owner-leaky git origin (matching one of the
// isOwnerLeakySegment CP1/CP6/CP10 patterns) therefore reached the vault
// verbatim via the session-note frontmatter even though its directory AND the
// sibling learning notes' `source-repo` field were already redacted/pseudonym-
// mapped. This describe block proves the fix: the SAME resolveRepoNamespace()
// return value now backs BOTH the write path and the rendered `source-repo`
// field — proven by stubbing resolveRepoNamespace() to a sentinel value that
// deliberately DIFFERS from the raw git-origin identifier, so a regression
// back to the pre-#732 "frontmatter uses raw deriveRepo()" behaviour would
// make this test fail. (The CP1/CP6/CP10 leak-detection + pseudonym-mapping
// mechanism ITSELF is exhaustively covered in namespace.test.mjs; duplicating
// real private-slug fixtures here would also trip check-owner-leakage.mjs's
// scanner for this file, which is not on its SELF_EXCLUSIONS allowlist.)

describe('processSession #732: source-repo uses resolveRepoNamespace(), never raw deriveRepo()', () => {
  let _existsSyncSpy;
  let writeFileSyncSpy;

  beforeEach(() => {
    _existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
    vi.doUnmock('@lib/vault-mirror/namespace.mjs');
  });

  const VALID_V1_SESSION = {
    session_id: 'session-2026-07-03',
    session_type: 'feature',
    started_at: '2026-07-03T08:00:00Z',
    completed_at: '2026-07-03T10:00:00Z',
    duration_seconds: 7200,
    total_waves: 1,
    total_agents: 2,
    total_files_changed: 4,
    agent_summary: { complete: 2, partial: 0, failed: 0, spiral: 0 },
    waves: [{ wave: 1, role: 'Planning', agent_count: 2, files_changed: 4, quality: 'ok' }],
    effectiveness: { planned_issues: 1, completed: 1, carryover: 0, emergent: 0, completion_rate: 1.0 },
  };

  it('write path AND rendered source-repo both use resolveRepoNamespace()s return value, never the raw origin', async () => {
    vi.resetModules();
    // git origin resolves to a raw identifier that deriveRepo() would return
    // VERBATIM if the (pre-#732) frontmatter path ever fell back to it.
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:raw-org/raw-origin-identifier.git')) };
    });
    // Stub resolveRepoNamespace() to a sentinel that deliberately differs from
    // the raw origin above — proves process.mjs consumes the FUNCTION'S return
    // value for the frontmatter, not deriveRepo() directly.
    vi.doMock('@lib/vault-mirror/namespace.mjs', async () => {
      const actual = await vi.importActual('@lib/vault-mirror/namespace.mjs');
      return { ...actual, resolveRepoNamespace: vi.fn(() => 'leak-guarded-sentinel') };
    });
    const { processSession } = await import('@lib/vault-mirror/process.mjs');

    let writtenPath = '';
    let written = '';
    writeFileSyncSpy.mockImplementation((p, content) => { writtenPath = p; written = content; });

    await captureStdout(() =>
      processSession(VALID_V1_SESSION, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' }),
    );

    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    // Write path uses resolveRepoNamespace()'s return value.
    expect(writtenPath).toContain('/50-sessions/leak-guarded-sentinel/');
    // Frontmatter ALSO uses it — the #732 fix (previously it used raw deriveRepo()).
    expect(written).toContain('source-repo: leak-guarded-sentinel\n');
    // Never the raw origin identifier, and never the legacy `repo:` field name.
    expect(written).not.toContain('raw-origin-identifier');
    expect(written).not.toMatch(/^repo: /m);
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processLearning;
  }

  async function getProcessSession() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
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

// ── #740 narrative-chars gate is sessions-only, never applied to learnings ───
//
// Regression guard against a future "symmetry" edit that wires the
// sessions-only qualityMinNarrativeChars gate into processLearning. The
// field is already destructured (as `_qualityMinNarrativeChars`, unused) in
// processLearning's ctx — see process.mjs — so the trap is real: a well-
// intentioned refactor could "complete the symmetry" and start gating
// learnings on insight length too. This test pins that it must not.

describe('processLearning #740: narrative-chars gate is sessions-only, never applied to learnings', () => {
  let writeFileSyncSpy;

  beforeEach(() => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function getProcessLearning() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processLearning;
  }

  it('short insight (< qualityMinNarrativeChars) with confidence >= min still emits created, never skipped-quality-low', async () => {
    const processLearning = await getProcessLearning();
    // 350-char insight — deliberately shorter than the qualityMinNarrativeChars
    // value passed below (1000). If a future edit wires the sessions-only
    // narrative-length gate into processLearning, this entry would wrongly
    // flip to skipped-quality-low and this assertion would fail.
    const shortInsight = 'x'.repeat(350);
    const entry = {
      id: 'a1b2c3d4-0001-4000-8000-000000000740',
      type: 'gotcha',
      subject: 'short-insight-probe',
      insight: shortInsight,
      evidence: 'unit test',
      confidence: 0.6,
      source_session: 'session-2026-07-10',
      created_at: '2026-07-10T10:00:00Z',
    };

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, {
        vaultDir: '/vault',
        dryRun: false,
        kind: 'learning',
        qualityMinNarrativeChars: 1000, // would fail the (sessions-only) narrative gate if it were ever wired
      }),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
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
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
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

// ── #909: abandoned sessions are never mirrored ───────────────────────────────
//
// A `status: 'abandoned'` record is a phantom stub backfilled from events.jsonl
// for a session that never ran /close — 0 waves, 0 agents, synthesized fields.
// It is legitimate ledger DATA but not legitimate knowledge-store SIGNAL.

describe('processSession #909: status:abandoned is filtered before rendering', () => {
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

  async function getProcessSession() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    const mod = await import('@lib/vault-mirror/process.mjs');
    return mod.processSession;
  }

  const SESSION = {
    session_id: 'main-2026-07-30-session-1',
    session_type: 'feature',
    started_at: '2026-07-30T08:00:00Z',
    completed_at: '2026-07-30T10:00:00Z',
    duration_seconds: 7200,
    waves: 2,
    agents_dispatched: 4,
    agent_summary: { complete: 4, partial: 0, failed: 0, spiral: 0 },
    effectiveness: { planned_issues: 2, completed_issues: 2, carryover: 0, completion_rate: 1.0 },
  };

  it('writes NO note at all for an abandoned session', async () => {
    const processSession = await getProcessSession();
    const { lines } = await captureStdout(() =>
      processSession({ ...SESSION, status: 'abandoned' }, 1, {
        vaultDir: '/vault', dryRun: false, kind: 'session',
      })
    );
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      action: 'skipped-abandoned',
      path: null,
      kind: 'session',
      id: 'main-2026-07-30-session-1',
      reason: 'status:abandoned',
    });
  });

  it('does not consult the filesystem before skipping an abandoned session', async () => {
    // The skip must precede the render + the existence probes, not merely
    // suppress the write — otherwise an abandoned stub still costs a git
    // subprocess and a full render on every mirror run.
    const processSession = await getProcessSession();
    await captureStdout(() =>
      processSession({ ...SESSION, status: 'abandoned' }, 1, {
        vaultDir: '/vault', dryRun: false, kind: 'session',
      })
    );
    expect(existsSyncSpy).not.toHaveBeenCalled();
  });

  it('still mirrors a completed session (the filter does not over-fire)', async () => {
    const processSession = await getProcessSession();
    const { lines } = await captureStdout(() =>
      processSession({ ...SESSION, status: 'completed' }, 1, {
        vaultDir: '/vault', dryRun: false, kind: 'session',
      })
    );
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    expect(writeFileSyncSpy.mock.calls[0][1]).toContain('status: verified');
  });

  it('still mirrors a status-less record (fail-open: the pre-#724 majority)', async () => {
    const processSession = await getProcessSession();
    const { lines } = await captureStdout(() =>
      processSession(SESSION, 1, { vaultDir: '/vault', dryRun: false, kind: 'session' })
    );
    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    expect(writeFileSyncSpy.mock.calls[0][1]).toContain('status: verified');
  });
});

// ── #974: env-secret values are masked before anything is written ─────────────
//
// Everything this mirror writes lands in a TRACKED and PUSHED artifact
// (auto-commit.mjs runs `git add` + `commit` in the vault repo), and the records
// it carries are agent-authored free text that routinely quotes command lines and
// error output. A leak here cannot be fixed by deleting a file.
//
// It is NOT the only such channel — an earlier revision of this comment said so
// and was wrong. Measured 2026-08-15 at vault `83a868059`: 18 tracked
// `_session-narrative.md` + 1 tracked `research/hardware-patterns.md` live in the
// same pushed repo (see the corrected note in process.mjs § maskEntrySecrets).
//
// Every test below names the bug it catches; the needle is generated at RUNTIME
// (never a literal in this file) so no credential-shaped string is committed.

describe('processLearning/processSession #974: env-secret masking', () => {
  let existsSyncSpy;
  let writeFileSyncSpy;
  /** Runtime-generated needle — lowercase kebab, so an UNMASKED value would
   *  survive subjectToSlug() verbatim and reach the committed filename. */
  let needle;

  beforeEach(() => {
    needle = `so-test-needle-${randomUUID()}`;
    vi.stubEnv('SO_TEST_MASK_TOKEN', needle);
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function loadProcess() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    return import('@lib/vault-mirror/process.mjs'); // git mock → repoNs 'r'
  }

  const LEARNING = {
    id: 'a1b2c3d4-0001-4000-8000-000000000974',
    type: 'gotcha',
    subject: 'explicit-contracts',
    insight: 'Prefer explicit contracts',
    evidence: 'Three modules broke',
    confidence: 0.9,
    source_session: 'session-2026-08-14',
    created_at: '2026-08-14T10:00:00Z',
  };

  const SESSION = {
    session_id: 'main-2026-08-14-session-1',
    session_type: 'feature',
    started_at: '2026-08-14T08:00:00Z',
    completed_at: '2026-08-14T10:00:00Z',
    duration_seconds: 7200,
    waves: 1,
    agents_dispatched: 2,
    effectiveness: { planned_issues: 1, completed_issues: 1, carryover: 0, completion_rate: 1.0 },
  };

  // BUG CAUGHT: an agent pastes a shell line carrying a live token into
  // `insight`; the mirror writes it verbatim into a note that auto-commit.mjs
  // git-adds and pushes to a foreign repo, where it is not deletable.
  it('a secret env VALUE quoted in the insight never reaches the written note', async () => {
    const { processLearning } = await loadProcess();
    let written = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { written = content; });

    const { lines } = await captureStdout(() =>
      processLearning(
        { ...LEARNING, insight: `The run died on GITLAB_TOKEN=${needle} in the env` },
        1,
        { vaultDir: '/vault', dryRun: false, kind: 'learning' },
      ),
    );

    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    expect(written).not.toContain(needle);
    expect(written).toContain('The run died on GITLAB_TOKEN=[REDACTED] in the env');
  });

  // BUG CAUGHT: the FILENAME is committed too. A masker wired at the write (or
  // at the renderer's output) leaves the slug — derived from `subject` — carrying
  // the raw value, so the secret is published as a tracked path and in the
  // emitted action line.
  it('a secret in the subject never reaches the committed filename or the action line', async () => {
    const { processLearning } = await loadProcess();

    const { lines } = await captureStdout(() =>
      processLearning(
        { ...LEARNING, subject: `probe ${needle} case` },
        1,
        { vaultDir: '/vault', dryRun: false, kind: 'learning' },
      ),
    );

    const writtenPath = writeFileSyncSpy.mock.calls[0][0];
    expect(writtenPath).not.toContain(needle);
    expect(writtenPath).toBe('/vault/40-learnings/r/probe-redacted-case.md');
    expect(lines[0].id).toBe('probe-redacted-case');
  });

  // BUG CAUGHT: masking AFTER the render injects a bare `title: [REDACTED] …`,
  // because yamlQuoteIfNeeded() already made its quoting decision on the raw
  // text. YAML then reads the value as a flow SEQUENCE (or fails outright), and
  // the note is rejected by the vault-sync frontmatter schema at the session-end
  // hard gate. Masking the input keeps the title a quoted string.
  it('frontmatter stays valid YAML when the secret opens the title', async () => {
    const { processLearning } = await loadProcess();
    let written = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { written = content; });

    await captureStdout(() =>
      processLearning(
        { ...LEARNING, insight: `${needle} was printed by the failing hook` },
        1,
        { vaultDir: '/vault', dryRun: false, kind: 'learning' },
      ),
    );

    const fmBlock = written.slice(4, written.indexOf('\n---', 3));
    const fm = YAML.load(fmBlock);
    expect(typeof fm.title).toBe('string');
    expect(fm.title).toBe('[REDACTED] was printed by the failing hook');
    expect(written).not.toContain(needle);
  });

  // BUG CAUGHT: the wiring perturbs notes that contain no secret at all —
  // over-masking, or a JSON round-trip / key-reorder artefact introduced by the
  // entry walk. The baseline is produced by calling the renderer DIRECTLY (an
  // independent text, not a JSON.stringify of the same object), and compared
  // byte for byte.
  it('a record without any secret is byte-identical to the unmasked renderer output', async () => {
    const { processLearning } = await loadProcess();
    const { generateLearningNote } = await import('@lib/vault-mirror/render-learnings.mjs');
    let written = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { written = content; });

    await captureStdout(() =>
      processLearning(LEARNING, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning' }),
    );

    // Needles ARE configured (see beforeEach) — this pins pass-through, not a
    // zero-needle fast path.
    expect(written).toBe(generateLearningNote(LEARNING, 'explicit-contracts', { repoNs: 'r' }));
    expect(existsSyncSpy).toHaveBeenCalled();
  });

  // BUG CAUGHT: only ONE of the two entry points is wired. processSession has
  // its own free-text field (`notes`) and its own render path; a fix applied to
  // learnings alone ships a second, unhardened channel beside the hardened one.
  it('a secret in the session notes never reaches the written session note', async () => {
    const { processSession } = await loadProcess();
    let written = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { written = content; });

    const { lines } = await captureStdout(() =>
      processSession(
        { ...SESSION, notes: `curl -H "PRIVATE-TOKEN: ${needle}" failed. ${'n'.repeat(500)}` },
        1,
        { vaultDir: '/vault', dryRun: false, kind: 'session' },
      ),
    );

    expect(lines[0].action).toBe('created');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    expect(written).not.toContain(needle);
    expect(written).toContain('curl -H "PRIVATE-TOKEN: [REDACTED]" failed.');
  });
});

// ── #1025: masking is env-derived, so idempotency must survive an env change ──
//
// The masker's needle set comes from `process.env`, which is NOT part of the
// record. Two runs over the SAME record therefore mask differently when the env
// differs between them — and the idempotency comparison sits directly downstream
// of that asymmetry.

describe('processLearning #1025: redaction-aware idempotency across an env change', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let writeFileSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  // resetModules is load-bearing TWICE here: it gives each run a FRESH masker
  // singleton, so run 2 genuinely rebuilds its needle set from the (now
  // secret-free) env instead of reusing run 1's.
  async function loadProcess() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    return import('@lib/vault-mirror/process.mjs'); // git mock → repoNs 'r'
  }

  const LEARNING = {
    id: 'a1b2c3d4-0001-4000-8000-000000001025',
    type: 'architectural',
    subject: 'explicit-contracts',
    insight: 'Prefer explicit contracts',
    evidence: 'Three modules broke',
    confidence: 0.9,
    source_session: 'session-2026-08-14',
    created_at: '2026-08-14T10:00:00Z',
  };

  // BUG CAUGHT (#1025 Probe A — a REPEATED leak, written by the run that was
  // supposed to be a no-op): run 1 has the secret in env and correctly writes
  // `[REDACTED]`. Run 2 does not, so it renders the RAW value; plain field
  // equality then reports "content changed" and the mirror OVERWRITES the
  // already-redacted note with the raw secret — publishing it a second time into
  // a tracked, pushed artifact. The on-disk note here is a golden record: it is
  // produced by run 1 through the real renderer, never hand-shaped.
  it('a second run WITHOUT the secret in env re-writes neither the note nor the raw value', async () => {
    const needle = `so-test-needle-${randomUUID()}`;
    const entry = { ...LEARNING, insight: `The run died on GITLAB_TOKEN=${needle} in the env` };

    // ── Run 1: secret present in env → note is created with [REDACTED] ────────
    vi.stubEnv('SO_TEST_MASK_TOKEN', needle);
    const { processLearning: run1 } = await loadProcess();
    existsSyncSpy.mockReturnValue(false);
    let onDisk = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { onDisk = content; });

    const first = await captureStdout(() =>
      run1(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false }),
    );
    expect(first.lines[0].action).toBe('created');
    expect(onDisk).toContain('[REDACTED]');
    expect(onDisk).not.toContain(needle);

    // ── Run 2: same record, secret NO LONGER in env ───────────────────────────
    vi.unstubAllEnvs();
    const { processLearning: run2 } = await loadProcess();
    writeFileSyncSpy.mockClear();
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(onDisk);

    const second = await captureStdout(() =>
      run2(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false }),
    );

    expect(second.lines[0].action).toBe('skipped-noop');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();

    // ── Run 3 (#1028 extension): the on-disk note is ALREADY redacted (no raw
    // needle survives — asserted above) and the needle is put BACK in env. The
    // #1028 `maskerWouldChange` guard must not treat an already-masked note as
    // "still leaking": masking `[REDACTED]` text again is a no-op (there is no
    // raw needle left to replace), so this must still be skipped-noop — proving
    // the new guard does not cause churn on a genuinely healed note.
    vi.stubEnv('SO_TEST_MASK_TOKEN', needle);
    const { processLearning: run3 } = await loadProcess();
    writeFileSyncSpy.mockClear();

    const third = await captureStdout(() =>
      run3(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false }),
    );

    expect(third.lines[0].action).toBe('skipped-noop');
    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });
});

// ── #1028 residue 1: the masked re-run must heal a leak in a NON-canonical
// field. `learningContentMatches` compares only five canonical fields (status,
// expires, confidence, insight, source_session); `evidence` is not one of them,
// so a raw secret sitting there matches on all five forever and the mirror
// never rewrites it, even once the env carries the needle. The `!force` guard
// on the disambig-collision branch was also missing (unlike the other two
// skipped-noop sites), so `force: true` was silently ignored there.

describe('processLearning #1028 residue 1: a leak in a non-canonical field must heal', () => {
  let existsSyncSpy;
  let readFileSyncSpy;
  let writeFileSyncSpy;

  beforeEach(() => {
    existsSyncSpy = vi.spyOn(fs, 'existsSync');
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync');
    writeFileSyncSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock('node:child_process');
  });

  async function loadProcess() {
    vi.resetModules();
    vi.doMock('node:child_process', async () => {
      const actual = await vi.importActual('node:child_process');
      return { ...actual, execFileSync: vi.fn(() => remoteV('git@x:o/r.git')) };
    });
    return import('@lib/vault-mirror/process.mjs'); // git mock → repoNs 'r'
  }

  const LEARNING = {
    id: 'a1b2c3d4-0001-4000-8000-000000001028',
    type: 'architectural',
    subject: 'explicit-contracts-1028',
    insight: 'Prefer explicit contracts',
    confidence: 0.9,
    source_session: 'session-2026-08-14',
    created_at: '2026-08-14T10:00:00Z',
  };

  // (a) BUG CAUGHT: a raw secret sitting only in `evidence` (non-canonical)
  // matches on all five canonical fields forever, so the pre-fix code returns
  // skipped-noop even once the env carries the needle — the raw secret never
  // heals. Fake-regression (quoted below in the report) confirms this was RED
  // against the pre-fix HEAD version of process.mjs.
  it('a raw secret sitting only in evidence heals the first time the env carries it', async () => {
    const needle = `so-test-needle-${randomUUID()}`;
    const entry = { ...LEARNING, evidence: `curl -H "PRIVATE-TOKEN: ${needle}" failed` };

    // ── Run 1: no needle in env → evidence written RAW (masker has 0 needles) ──
    const { processLearning: run1 } = await loadProcess();
    existsSyncSpy.mockReturnValue(false);
    let onDisk = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { onDisk = content; });

    const first = await captureStdout(() =>
      run1(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false }),
    );
    expect(first.lines[0].action).toBe('created');
    expect(onDisk).toContain(needle);

    // ── Run 2: same record, needle NOW in env. The five canonical fields are
    // byte-identical to run 1 (evidence is not one of them), so the five-field
    // compare alone reports a match — this is exactly the residual the
    // maskerWouldChange guard must catch.
    vi.stubEnv('SO_TEST_MASK_TOKEN', needle);
    const { processLearning: run2 } = await loadProcess();
    writeFileSyncSpy.mockClear();
    let rewritten = '';
    writeFileSyncSpy.mockImplementation((_p, content) => { rewritten = content; });
    existsSyncSpy.mockReturnValue(true);
    readFileSyncSpy.mockReturnValue(onDisk);

    const second = await captureStdout(() =>
      run2(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: false }),
    );

    expect(second.lines[0].action).not.toBe('skipped-noop');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
    expect(rewritten).toContain('[REDACTED]');
    expect(rewritten).not.toContain(needle);
  });

  // (b) BUG CAUGHT: the disambig-collision branch's date/content guard did not
  // check `force` at all (unlike the legacy-flat and same-id branches), so
  // `force: true` was silently ignored on this one path — an identical-content
  // disambig note was skipped instead of rewritten even when the caller
  // explicitly asked to bypass the comparison.
  it('force:true bypasses the disambig-collision skip even when content matches', async () => {
    const { processLearning } = await loadProcess();
    const { generateLearningNote } = await import('@lib/vault-mirror/render-learnings.mjs');
    const { subjectToSlug, uuidPrefix8 } = await import('@lib/vault-mirror/utils.mjs');

    const entry = {
      ...LEARNING,
      id: 'a1b2c3d4-0001-4000-8000-00000000c011',
      subject: 'disambig-force-1028',
    };
    const slug = subjectToSlug(entry.subject);
    const disambigSlug = `${slug}-${uuidPrefix8(entry.id)}`;
    // '(none recorded)' matches normalizeLearningEntry's fallback for a missing
    // `evidence` field — see render-learnings.mjs normalizeLearningEntry.
    const disambigContent = generateLearningNote({ ...entry, evidence: '(none recorded)' }, disambigSlug, {
      repoNs: 'r',
    });

    const mainContent =
      '---\nid: different-id-1028\nupdated: 2026-01-01\n_generator: session-orchestrator-vault-mirror@1\n---\n';

    existsSyncSpy
      .mockReturnValueOnce(true) // legacy-flat check operand: targetPath exists
      .mockReturnValueOnce(true) // explicit existsSync(targetPath): main slug file exists
      .mockReturnValueOnce(true); // disambig existsSync(targetPath): disambig file exists
    readFileSyncSpy.mockReturnValueOnce(mainContent).mockReturnValueOnce(disambigContent);

    const { lines } = await captureStdout(() =>
      processLearning(entry, 1, { vaultDir: '/vault', dryRun: false, kind: 'learning', force: true }),
    );

    expect(lines[0].action).not.toBe('skipped-noop');
    expect(writeFileSyncSpy).toHaveBeenCalledOnce();
  });
});

// ── #1025 Q1: the wildcard predicate is a SHARED export (narrative-mirror.mjs
// imports it), and `[REDACTED]` is ordinary prose in this repo — ADRs, rule
// files and learnings all discuss the marker by name. Its presence is therefore
// evidence a mask MAY have run, never proof one did, and the pattern it compiles
// to must stay anchored to something.

describe('matchesModuloRedaction (shared #1025 predicate)', () => {
  async function load() {
    return import('@lib/vault-mirror/process.mjs');
  }

  // BUG CAUGHT: a value whose ENTIRE content is the marker splits into two empty
  // segments, so the join compiled to `^[\s\S]*?$` — a pattern matching EVERY
  // string. That field then reports "unchanged" against any candidate forever:
  // a permanent blind spot, reachable with no masker involved at all (agent prose
  // that merely quotes the marker).
  it('refuses to treat a marker-only value as a universal wildcard', async () => {
    const { matchesModuloRedaction } = await load();
    expect(matchesModuloRedaction('[REDACTED]', 'a completely unrelated value')).toBe(false);
    expect(matchesModuloRedaction('[REDACTED][REDACTED]', 'anything at all')).toBe(false);
  });

  // A masked needle is >= MIN_MASKABLE_LENGTH (8) characters by construction, so
  // a redacted span standing for ZERO characters is never a real redaction — it
  // is only extra wildcard reach. `+?` keeps the true case and drops the empty one.
  it('requires a redacted span to stand for at least one character', async () => {
    const { matchesModuloRedaction } = await load();
    expect(matchesModuloRedaction('token=[REDACTED] failed', 'token=hunter2hunter2 failed')).toBe(true);
    expect(matchesModuloRedaction('token=[REDACTED] failed', 'token= failed')).toBe(false);
  });
});
