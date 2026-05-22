/**
 * tests/unit/quality-gate-session-config.test.mjs
 *
 * Vitest integration tests for three functions in scripts/lib/quality-gate.mjs:
 *
 *   - loadCommandsFromSessionConfig (exported — tested directly)
 *   - writeLastGreenSha (internal — tested via runQualityGateWithRetry side effects)
 *   - listChangedFiles  (internal — tested via runQualityGateWithRetry side effects)
 *
 * These functions are the runtime foundation of the auto-fix loop (Pattern 4 — issue #521).
 * They were identified as untested by the qa-strategist HIGH-3 finding in #525.
 *
 * Test strategy:
 *   - loadCommandsFromSessionConfig: tested directly (it is exported).
 *   - writeLastGreenSha / listChangedFiles: tested indirectly through
 *     runQualityGateWithRetry because they are module-internal (not exported).
 *     Observable effects:
 *       - writeLastGreenSha: writes .orchestrator/runtime/last-green-sha.txt
 *         after a successful gate run.
 *       - listChangedFiles: the changedFiles array passed to dispatchFixer
 *         reflects real git diff output when repoRoot is a git repository.
 *
 * Integration approach:
 *   - Real git repos are initialised with execSync — no mocking of git.
 *   - Real CLAUDE.md files are written to tmpdir — no mocking of fs.
 *   - parse-config.mjs subprocess is invoked for real.
 *   - Gates use `true` / `false` shell commands for hermetic control.
 *
 * Per .claude/rules/testing.md: testTimeout configured at suite level via
 * describe-scoped options. Integration tests with git subprocesses can take
 * 1-2s; 5s ceiling is safe and well below the global 10s default.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

import { loadCommandsFromSessionConfig, runQualityGateWithRetry } from '@lib/quality-gate.mjs';

// ---------------------------------------------------------------------------
// Per-test filesystem isolation
// ---------------------------------------------------------------------------

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'qg-session-cfg-'));
  // Pre-create the diagnostics dir so runQualityGateWithRetry can write bundles.
  mkdirSync(join(repoRoot, '.orchestrator', 'metrics', 'verification-failures'), {
    recursive: true,
  });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Git repo helper — initialise a minimal git repo in tmpdir
// ---------------------------------------------------------------------------

/**
 * Initialise a git repo in `dir`, configure a dummy identity, and create an
 * initial commit containing `file` with `content`. Returns the SHA of the
 * initial commit.
 *
 * @param {string} dir
 * @param {string} file  — filename relative to dir
 * @param {string} content
 * @returns {string} commit SHA (40-char hex)
 */
function initGitRepo(dir, file = 'A.txt', content = 'initial') {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "test@test.local"', { cwd: dir });
  execSync('git config user.name "Test"', { cwd: dir });
  writeFileSync(join(dir, file), content, 'utf8');
  execSync('git add .', { cwd: dir });
  execSync('git commit -m "init" -q', { cwd: dir });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

/**
 * Create and commit a new file in an existing git repo.
 *
 * @param {string} dir
 * @param {string} file  — filename relative to dir (supports subdirs)
 * @param {string} content
 * @param {string} [msg]
 * @returns {string} commit SHA
 */
function addCommit(dir, file, content, msg = 'add file') {
  const filePath = join(dir, file);
  // Ensure parent dirs exist for nested paths.
  const parentDir = filePath.substring(0, filePath.lastIndexOf('/'));
  if (parentDir !== dir) mkdirSync(parentDir, { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  execSync('git add .', { cwd: dir });
  execSync(`git commit -m "${msg}" -q`, { cwd: dir });
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf8' }).trim();
}

// ---------------------------------------------------------------------------
// Group A: loadCommandsFromSessionConfig
// ---------------------------------------------------------------------------

describe('loadCommandsFromSessionConfig — A1: missing CLAUDE.md', () => {
  it('returns {} when repoRoot has no reachable CLAUDE.md (parse-config exits non-zero)', { timeout: 5_000 }, () => {
    // repoRoot is a fresh tmpdir — no CLAUDE.md, no .git marker.
    // parse-config walks up to the filesystem root and exits 1 when nothing is found.
    const result = loadCommandsFromSessionConfig(repoRoot);
    expect(result).toEqual({});
  });
});

describe('loadCommandsFromSessionConfig — A2: reads lint/typecheck/test commands', () => {
  it('reads test-command from CLAUDE.md Session Config', { timeout: 5_000 }, () => {
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      '# Test Project\n## Session Config\ntest-command: vitest --run\nlint-command: eslint .\ntypecheck-command: tsc --noEmit\n',
      'utf8',
    );
    const result = loadCommandsFromSessionConfig(repoRoot);
    expect(result.test).toBe('vitest --run');
  });

  it('reads lint-command from CLAUDE.md Session Config', { timeout: 5_000 }, () => {
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      '# Test Project\n## Session Config\ntest-command: vitest --run\nlint-command: eslint .\ntypecheck-command: tsc --noEmit\n',
      'utf8',
    );
    const result = loadCommandsFromSessionConfig(repoRoot);
    expect(result.lint).toBe('eslint .');
  });

  it('reads typecheck-command from CLAUDE.md Session Config', { timeout: 5_000 }, () => {
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      '# Test Project\n## Session Config\ntest-command: vitest --run\nlint-command: eslint .\ntypecheck-command: tsc --noEmit\n',
      'utf8',
    );
    const result = loadCommandsFromSessionConfig(repoRoot);
    expect(result.typecheck).toBe('tsc --noEmit');
  });
});

describe('loadCommandsFromSessionConfig — A3: ignores unrecognised keys', () => {
  it('result has test: "foo" for test-command: foo and no bogus key', { timeout: 5_000 }, () => {
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      '# Test Project\n## Session Config\ntest-command: foo\nbogus-command: bar\n',
      'utf8',
    );
    const result = loadCommandsFromSessionConfig(repoRoot);
    expect(result.test).toBe('foo');
    expect(result).not.toHaveProperty('bogus');
  });

  it('all keys in result are members of {lint, typecheck, test}', { timeout: 5_000 }, () => {
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      '# Test Project\n## Session Config\ntest-command: npm test\nbogus-command: something\n',
      'utf8',
    );
    const result = loadCommandsFromSessionConfig(repoRoot);
    const allValid = Object.keys(result).every((k) => ['lint', 'typecheck', 'test'].includes(k));
    expect(allValid).toBe(true);
  });
});

describe('loadCommandsFromSessionConfig — A4: graceful failure when no config reachable', () => {
  it('returns {} when git repo has no CLAUDE.md (parse-config cannot find config file)', { timeout: 5_000 }, () => {
    // A dir with a .git marker stops parse-config upward walk at this dir.
    // Since CLAUDE.md is absent here, parse-config exits 1 → function returns {}.
    execSync('git init -q', { cwd: repoRoot });
    // Deliberately do NOT write CLAUDE.md.
    const result = loadCommandsFromSessionConfig(repoRoot);
    expect(result).toEqual({});
  });
});

describe('loadCommandsFromSessionConfig — A5: result keys are limited to the documented trio', () => {
  it('result contains exactly {lint, typecheck, test} when all three commands are present', { timeout: 5_000 }, () => {
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      '# Test Project\n## Session Config\ntest-command: mocha\nlint-command: biome lint\ntypecheck-command: flow check\n',
      'utf8',
    );
    const result = loadCommandsFromSessionConfig(repoRoot);
    expect(result).toHaveProperty('test');
    expect(result).toHaveProperty('lint');
    expect(result).toHaveProperty('typecheck');
    // Verify no extra keys slipped through
    expect(Object.keys(result).length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Group B: writeLastGreenSha (tested via runQualityGateWithRetry side effects)
//
// writeLastGreenSha is called by runQualityGateWithRetry after every successful
// gate run. It writes .orchestrator/runtime/last-green-sha.txt atomically.
// ---------------------------------------------------------------------------

describe('writeLastGreenSha (via runQualityGateWithRetry) — B1: writes HEAD SHA after success', () => {
  it('creates last-green-sha.txt after a passing gate run', { timeout: 5_000 }, async () => {
    initGitRepo(repoRoot);

    await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: 'true', typecheck: 'true', test: 'true' },
    });

    const shaFile = join(repoRoot, '.orchestrator', 'runtime', 'last-green-sha.txt');
    expect(existsSync(shaFile)).toBe(true);
  });

  it('SHA written to file matches output of git rev-parse HEAD', { timeout: 5_000 }, async () => {
    const headSha = initGitRepo(repoRoot);

    await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: 'true', typecheck: 'true', test: 'true' },
    });

    const shaFile = join(repoRoot, '.orchestrator', 'runtime', 'last-green-sha.txt');
    const writtenSha = readFileSync(shaFile, 'utf8').trim();
    expect(writtenSha).toBe(headSha);
  });

  it('no .tmp-* leftover files remain in runtime/ after atomic write', { timeout: 5_000 }, async () => {
    initGitRepo(repoRoot);

    await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: 'true', typecheck: 'true', test: 'true' },
    });

    const runtimeDir = join(repoRoot, '.orchestrator', 'runtime');
    const leftoverTmp = readdirSync(runtimeDir).filter((f) => f.startsWith('.tmp-'));
    expect(leftoverTmp).toHaveLength(0);
  });
});

describe('writeLastGreenSha (via runQualityGateWithRetry) — B2: overwrites on second success', () => {
  it('SHA in file equals HEAD of most recent commit after two sequential successful runs', { timeout: 5_000 }, async () => {
    initGitRepo(repoRoot, 'first.txt', 'first');

    // First successful gate run — writes SHA1
    await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: 'true', typecheck: 'true', test: 'true' },
    });

    // Add a second commit to advance HEAD
    const sha2 = addCommit(repoRoot, 'second.txt', 'second', 'second commit');

    // Second successful gate run — should overwrite with SHA2
    await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: 'true', typecheck: 'true', test: 'true' },
    });

    const shaFile = join(repoRoot, '.orchestrator', 'runtime', 'last-green-sha.txt');
    const writtenSha = readFileSync(shaFile, 'utf8').trim();
    expect(writtenSha).toBe(sha2);
  });
});

describe('writeLastGreenSha (via runQualityGateWithRetry) — B3: creates runtime/ dir if absent', () => {
  it('creates .orchestrator/runtime/ directory when it does not exist before the gate run', { timeout: 5_000 }, async () => {
    initGitRepo(repoRoot);

    // Ensure runtime/ dir does NOT exist.
    const runtimeDir = join(repoRoot, '.orchestrator', 'runtime');
    if (existsSync(runtimeDir)) {
      rmSync(runtimeDir, { recursive: true, force: true });
    }
    expect(existsSync(runtimeDir)).toBe(false);

    await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: 'true', typecheck: 'true', test: 'true' },
    });

    expect(existsSync(runtimeDir)).toBe(true);
    expect(existsSync(join(runtimeDir, 'last-green-sha.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group C: listChangedFiles (tested via runQualityGateWithRetry side effects)
//
// listChangedFiles is called on gate failure to build the changedFiles array
// passed to dispatchFixer. It runs `git diff --name-only <baseRef> HEAD`.
// When no last-green-sha.txt exists, baseRef defaults to HEAD~1.
// ---------------------------------------------------------------------------

describe('listChangedFiles (via runQualityGateWithRetry) — C1: changed files between commits', () => {
  it('changedFiles in dispatchFixer call includes file added in the last commit', { timeout: 5_000 }, async () => {
    initGitRepo(repoRoot, 'A.txt', 'a');
    addCommit(repoRoot, 'B.txt', 'b', 'add B');
    // HEAD~1 diff: last commit added B.txt

    let capturedChangedFiles;
    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async ({ changedFiles }) => {
        capturedChangedFiles = changedFiles;
      },
      repoRoot,
      commands: { lint: 'false', typecheck: 'true', test: 'true' },
    });

    expect(capturedChangedFiles).toContain('B.txt');
  });
});

describe('listChangedFiles (via runQualityGateWithRetry) — C2: HEAD~1 as default ref', () => {
  it('changedFiles uses HEAD~1 diff when no last-green-sha.txt exists', { timeout: 5_000 }, async () => {
    initGitRepo(repoRoot, 'A.txt', 'a');
    addCommit(repoRoot, 'C.txt', 'c', 'add C');
    // No last-green-sha.txt present → baseRef = HEAD~1

    let capturedChangedFiles;
    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async ({ changedFiles }) => {
        capturedChangedFiles = changedFiles;
      },
      repoRoot,
      commands: { lint: 'false', typecheck: 'true', test: 'true' },
    });

    expect(Array.isArray(capturedChangedFiles)).toBe(true);
    // C.txt was added in the last commit (HEAD vs HEAD~1)
    expect(capturedChangedFiles).toContain('C.txt');
  });
});

describe('listChangedFiles (via runQualityGateWithRetry) — C3: non-git directory', () => {
  it('changedFiles is an empty array when repoRoot has no git repository', { timeout: 5_000 }, async () => {
    // repoRoot has no git init — git diff fails → listChangedFiles returns []

    let capturedChangedFiles;
    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async ({ changedFiles }) => {
        capturedChangedFiles = changedFiles;
      },
      repoRoot,
      commands: { lint: 'false', typecheck: 'true', test: 'true' },
    });

    expect(capturedChangedFiles).toEqual([]);
  });
});

describe('listChangedFiles (via runQualityGateWithRetry) — C4: no changes between refs', () => {
  it('changedFiles is [] when last-green-sha equals HEAD (no new commits)', { timeout: 5_000 }, async () => {
    // Init git, one commit. Set last-green-sha to that same commit SHA.
    // git diff <headSha> HEAD → zero diff.
    const sha = initGitRepo(repoRoot, 'A.txt', 'a');
    mkdirSync(join(repoRoot, '.orchestrator', 'runtime'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.orchestrator', 'runtime', 'last-green-sha.txt'),
      sha + '\n',
      'utf8',
    );

    let capturedChangedFiles;
    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async ({ changedFiles }) => {
        capturedChangedFiles = changedFiles;
      },
      repoRoot,
      commands: { lint: 'false', typecheck: 'true', test: 'true' },
    });

    expect(capturedChangedFiles).toEqual([]);
  });
});

describe('listChangedFiles (via runQualityGateWithRetry) — C5: paths with spaces', () => {
  it('changedFiles contains the exact path with spaces for a file in a directory named "my dir"', { timeout: 5_000 }, async () => {
    initGitRepo(repoRoot, 'start.txt', 'init');

    // Commit a file inside a directory whose name contains a space.
    const spacedDir = join(repoRoot, 'my dir');
    mkdirSync(spacedDir, { recursive: true });
    writeFileSync(join(spacedDir, 'file.txt'), 'content', 'utf8');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -m "add spaced file" -q', { cwd: repoRoot });

    let capturedChangedFiles;
    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async ({ changedFiles }) => {
        capturedChangedFiles = changedFiles;
      },
      repoRoot,
      commands: { lint: 'false', typecheck: 'true', test: 'true' },
    });

    expect(capturedChangedFiles).toContain('my dir/file.txt');
  });
});
