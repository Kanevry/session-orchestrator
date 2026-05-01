/**
 * tests/scripts/promote-vault-strict.test.mjs
 *
 * Vitest integration tests for scripts/promote-vault-strict.mjs.
 *
 * Each test creates a fresh git-init'd tmpdir, populates it with a
 * minimal CLAUDE.md (or AGENTS.md) fixture, then invokes the script
 * via spawnSync with --repo pointing at the tmpdir.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'promote-vault-strict.mjs');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal CLAUDE.md with vault-integration mode: warn (inline format) */
const CLAUDE_WARN_INLINE = `# Test Repo

## Session Config

persistence: true
vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: warn }
docs-orchestrator:
  enabled: false
  mode: warn
`;

/** CLAUDE.md with vault-integration as YAML block (multi-line) */
const CLAUDE_WARN_BLOCK = `# Test Repo

## Session Config

persistence: true
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn               # strict | warn | off
docs-orchestrator:
  enabled: false
  mode: warn
`;

/** CLAUDE.md already set to strict */
const CLAUDE_ALREADY_STRICT = `# Test Repo

## Session Config

vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: strict }
`;

/** CLAUDE.md without any vault-integration block */
const CLAUDE_NO_VAULT = `# Test Repo

## Session Config

persistence: true
`;

/** CLAUDE.md with BOTH vault-integration mode: warn AND another mode: warn in docs-orchestrator */
const CLAUDE_MULTI_MODE = `# Test Repo

## Session Config

persistence: true
vault-integration: { enabled: true, vault-dir: ~/Projects/vault, mode: warn }
docs-orchestrator:
  enabled: false
  mode: warn
vault-staleness:
  enabled: false
  mode: warn
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpdirs = [];

/**
 * Create an isolated tmpdir, git-init it, and write a config file.
 * Returns the tmpdir path.
 */
function makeTmpRepo({ filename = 'CLAUDE.md', content }) {
  const tmp = mkdtempSync(join(tmpdir(), 'promote-test-'));
  tmpdirs.push(tmp);

  // Git init with deterministic author so commits don't fail on CI
  spawnSync('git', ['-C', tmp, 'init'], { encoding: 'utf8' });
  spawnSync('git', ['-C', tmp, 'config', 'user.email', 'test@test.local'], { encoding: 'utf8' });
  spawnSync('git', ['-C', tmp, 'config', 'user.name', 'Test'], { encoding: 'utf8' });

  if (filename && content !== undefined) {
    writeFileSync(join(tmp, filename), content, 'utf8');
    // Initial commit so HEAD exists (required for git commit later)
    spawnSync('git', ['-C', tmp, 'add', filename], { encoding: 'utf8' });
    spawnSync('git', ['-C', tmp, 'commit', '-m', 'init'], { encoding: 'utf8' });
  }

  return tmp;
}

/**
 * Run the script with given extra args. Returns the spawnSync result.
 */
function run(extraArgs = []) {
  return spawnSync(process.execPath, [SCRIPT, ...extraArgs], {
    encoding: 'utf8',
    timeout: 20_000,
  });
}

/**
 * Get the git log oneline output for a repo.
 */
function gitLog(repoDir) {
  const r = spawnSync('git', ['-C', repoDir, 'log', '--oneline'], { encoding: 'utf8' });
  return r.stdout.trim();
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const d of tmpdirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promote-vault-strict', () => {
  it('1. dry-run on warn repo — does NOT mutate file, output contains "would-change"', () => {
    const tmp = makeTmpRepo({ content: CLAUDE_WARN_INLINE });
    const originalContent = readFileSync(join(tmp, 'CLAUDE.md'), 'utf8');

    const result = run(['--repo', tmp, '--no-baseline']);

    // File must not be changed
    const afterContent = readFileSync(join(tmp, 'CLAUDE.md'), 'utf8');
    expect(afterContent).toBe(originalContent);

    // Output must reference dry-run / would-change
    const allOutput = result.stdout + result.stderr;
    expect(allOutput).toContain('would-change');
    expect(allOutput).toContain('warn → mode: strict');

    // No extra commit created (only the initial 'init' commit exists)
    const log = gitLog(tmp);
    expect(log.split('\n').filter(Boolean)).toHaveLength(1);

    expect(result.status).toBe(0);
  });

  it('2. --apply on warn repo — mutates file, creates commit, file shows mode: strict', () => {
    const tmp = makeTmpRepo({ content: CLAUDE_WARN_INLINE });

    const result = run(['--repo', tmp, '--apply', '--no-baseline']);

    // File must now have mode: strict
    const afterContent = readFileSync(join(tmp, 'CLAUDE.md'), 'utf8');
    expect(afterContent).toContain('mode: strict');
    expect(afterContent).not.toMatch(/vault-integration[^}]*mode: warn/);

    // Output must reference committed
    expect(result.stdout).toContain('committed');

    // A second commit must exist with the correct message
    const log = gitLog(tmp);
    const logLines = log.split('\n').filter(Boolean);
    expect(logLines).toHaveLength(2);
    const latestLine = logLines[0];
    expect(latestLine).toContain('chore(orchestrator): Promote vault-integration to strict mode');

    // Summary table must show 'committed'
    expect(result.stdout).toContain('committed');

    expect(result.status).toBe(0);
  });

  it('3. idempotent — already-strict repo produces no commit', () => {
    const tmp = makeTmpRepo({ content: CLAUDE_ALREADY_STRICT });

    const result = run(['--repo', tmp, '--apply', '--no-baseline']);

    // Only the init commit
    const log = gitLog(tmp);
    expect(log.split('\n').filter(Boolean)).toHaveLength(1);

    // Summary shows already-strict
    expect(result.stdout).toContain('already-strict');

    expect(result.status).toBe(0);
  });

  it('4. no vault-integration block — status no-config, no commit', () => {
    const tmp = makeTmpRepo({ content: CLAUDE_NO_VAULT });

    const result = run(['--repo', tmp, '--apply', '--no-baseline']);

    // Only the init commit
    const log = gitLog(tmp);
    expect(log.split('\n').filter(Boolean)).toHaveLength(1);

    // Summary shows no-config
    expect(result.stdout).toContain('no-config');

    // File unchanged
    const afterContent = readFileSync(join(tmp, 'CLAUDE.md'), 'utf8');
    expect(afterContent).toBe(CLAUDE_NO_VAULT);

    expect(result.status).toBe(0);
  });

  it('5. missing CLAUDE.md — status no-config-file, no commit', () => {
    const tmp = makeTmpRepo({ filename: null, content: undefined });
    // Commit a dummy file to have a HEAD
    writeFileSync(join(tmp, 'README.md'), '# hi', 'utf8');
    spawnSync('git', ['-C', tmp, 'add', 'README.md'], { encoding: 'utf8' });
    spawnSync('git', ['-C', tmp, 'commit', '-m', 'init'], { encoding: 'utf8' });

    const result = run(['--repo', tmp, '--apply', '--no-baseline']);

    // Only the init commit
    const log = gitLog(tmp);
    expect(log.split('\n').filter(Boolean)).toHaveLength(1);

    // Summary shows no-config-file
    expect(result.stdout).toContain('no-config-file');

    expect(result.status).toBe(0);
  });

  it('6. AGENTS.md fallback — repo with only AGENTS.md gets modified', () => {
    const tmp = makeTmpRepo({ filename: 'AGENTS.md', content: CLAUDE_WARN_INLINE });

    const result = run(['--repo', tmp, '--apply', '--no-baseline']);

    // AGENTS.md must now have mode: strict
    const afterContent = readFileSync(join(tmp, 'AGENTS.md'), 'utf8');
    expect(afterContent).toContain('mode: strict');

    // Two commits total
    const log = gitLog(tmp);
    const logLines = log.split('\n').filter(Boolean);
    expect(logLines).toHaveLength(2);
    expect(logLines[0]).toContain('chore(orchestrator): Promote vault-integration to strict mode');

    // Summary references AGENTS.md
    expect(result.stdout).toContain('AGENTS.md');
    expect(result.status).toBe(0);
  });

  it('7. selective replacement — only vault-integration mode: warn is changed, not docs-orchestrator mode: warn', () => {
    const tmp = makeTmpRepo({ content: CLAUDE_MULTI_MODE });

    const result = run(['--repo', tmp, '--apply', '--no-baseline']);

    const afterContent = readFileSync(join(tmp, 'CLAUDE.md'), 'utf8');

    // vault-integration mode must be strict
    expect(afterContent).toMatch(/vault-integration[^}]*mode: strict/);

    // docs-orchestrator mode must still be warn
    expect(afterContent).toMatch(/docs-orchestrator[\s\S]*?mode: warn/);

    // vault-staleness mode must still be warn
    expect(afterContent).toMatch(/vault-staleness[\s\S]*?mode: warn/);

    expect(result.status).toBe(0);
  });

  it('8. YAML block format — multi-line vault-integration block is correctly updated', () => {
    const tmp = makeTmpRepo({ content: CLAUDE_WARN_BLOCK });

    const result = run(['--repo', tmp, '--apply', '--no-baseline']);

    const afterContent = readFileSync(join(tmp, 'CLAUDE.md'), 'utf8');

    // The mode line inside the vault-integration block must be strict
    expect(afterContent).toContain('  mode: strict');

    // docs-orchestrator mode must remain warn
    expect(afterContent).toContain('  mode: warn');

    // Two commits
    const log = gitLog(tmp);
    expect(log.split('\n').filter(Boolean)).toHaveLength(2);

    expect(result.status).toBe(0);
  });
});
