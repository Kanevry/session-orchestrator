/**
 * tests/hooks/pre-bash-destructive-guard.test.mjs
 *
 * Vitest tests for hooks/pre-bash-destructive-guard.mjs.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin,
 * assert exit code and stderr for each behavioural case.
 *
 * Issue: #155 (deliverable 2)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/pre-bash-destructive-guard.mjs');

/** Minimal policy fixture used by most tests (13 rules mirroring the spec). */
const FIXTURE_POLICY = {
  version: 1,
  rules: [
    {
      id: 'git-reset-hard',
      pattern: 'git reset --hard',
      severity: 'block',
      rationale: 'Destroys staged or committed work that may belong to another session.',
    },
    {
      id: 'git-push-force',
      pattern: 'git push --force',
      severity: 'block',
      rationale: 'Rewrites shared history.',
    },
    {
      id: 'git-push-force-short',
      pattern: 'git push -f',
      severity: 'block',
      rationale: 'Rewrites shared history (short form).',
    },
    {
      id: 'git-checkout-discard',
      pattern: 'git checkout -- .',
      severity: 'block',
      rationale: 'Discards uncommitted changes that another session may be building.',
    },
    {
      id: 'git-clean-force',
      pattern: 'git clean -f',
      severity: 'block',
      rationale: 'Deletes untracked files another session created.',
    },
    {
      id: 'git-stash-any',
      pattern: 'git stash',
      severity: 'warn',
      rationale: 'Captures another session\'s changes into a stash they cannot find.',
    },
    {
      id: 'rm-rf-destructive',
      pattern: 'rm -rf',
      severity: 'block',
      rationale: 'Deletes files that may belong to another session.',
    },
    {
      id: 'git-revert-commit',
      pattern: 'git revert',
      severity: 'warn',
      rationale: 'May undo another session\'s completed work.',
    },
    {
      id: 'git-branch-delete',
      pattern: 'git branch -D',
      severity: 'block',
      rationale: 'Deletes branches that may contain another session\'s work.',
    },
    {
      id: 'git-branch-delete-lower',
      pattern: 'git branch -d',
      severity: 'warn',
      rationale: 'Deletes merged branches — confirm no parallel work.',
    },
    {
      id: 'git-restore-staged',
      pattern: 'git restore --staged',
      severity: 'warn',
      rationale: 'Unstages files that may belong to another session.',
    },
    {
      id: 'git-restore-worktree',
      pattern: 'git restore .',
      severity: 'block',
      rationale: 'Discards all tracked changes in the working tree.',
    },
    {
      id: 'git-push-force-lease',
      pattern: 'git push --force-with-lease',
      severity: 'warn',
      rationale: 'Force-with-lease is safer but still requires coordinator approval.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook, pipe stdin JSON, collect stdout/stderr, resolve with exit code.
 */
async function runHook({ projectDir, stdin, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_ROOT: projectDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/**
 * Create a temporary project dir with:
 *   - CLAUDE.md containing an optional ## Session Config block
 *   - .orchestrator/policy/blocked-commands.json with the given policy
 *   - a git repo (for git-stash-any tests)
 */
async function mkProject({ policy = FIXTURE_POLICY, claudeMdExtra = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-test-'));

  // CLAUDE.md
  const claudeMd = `# Test Project\n\n## Session Config\n\npersistence: true\n${claudeMdExtra}\n`;
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

  // Policy file
  const policyDir = path.join(dir, '.orchestrator', 'policy');
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, 'blocked-commands.json'),
    JSON.stringify(policy, null, 2)
  );

  // Git init (needed for git-stash-any tests)
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@test.com"`;
  await $`git -C ${dir} config user.name "Test"`;

  return dir;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectTracked(opts) {
  const dir = await mkProject(opts);
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function bashPayload(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function nonBashPayload() {
  return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } });
}

// ---------------------------------------------------------------------------
// G1 — tool filter
// ---------------------------------------------------------------------------

describe('tool filter', { timeout: 15000 }, () => {
  it('exits 0 for non-Bash tool (Edit)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: nonBashPayload() });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// G2 — missing policy → allow with warning
// ---------------------------------------------------------------------------

describe('missing policy file', { timeout: 15000 }, () => {
  it('exits 0 with stderr warning when policy file is absent', async () => {
    const dir = await mkProjectTracked();
    // Remove the policy file
    await fs.rm(path.join(dir, '.orchestrator', 'policy', 'blocked-commands.json'));
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('policy file not found');
  });
});

// ---------------------------------------------------------------------------
// G3 — bypass via allow-destructive-ops: true
// ---------------------------------------------------------------------------

describe('allow-destructive-ops bypass', { timeout: 15000 }, () => {
  it('exits 0 and emits bypass notice when allow-destructive-ops: true is set', async () => {
    const dir = await mkProjectTracked({
      claudeMdExtra: 'allow-destructive-ops: true',
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('bypassed');
  });

  it('blocks git reset --hard when allow-destructive-ops is absent (default)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Severity: block — various patterns
// ---------------------------------------------------------------------------

describe('severity block — git reset --hard', { timeout: 15000 }, () => {
  it('exits 2 for "git reset --hard HEAD~1"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(2);
  });

  it('stdout contains permissionDecision deny', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    const json = JSON.parse(result.stdout);
    expect(json.permissionDecision).toBe('deny');
  });

  it('deny reason references the pattern and rule id', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.stdout).toContain('git reset --hard');
    expect(result.stdout).toContain('git-reset-hard');
  });

  it('deny reason includes Override hint', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.stdout).toContain('allow-destructive-ops');
  });
});

describe('severity block — git push --force', { timeout: 15000 }, () => {
  it('exits 2 for "git push --force origin main"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push --force origin main'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "git push -f" short form', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push -f origin main'),
    });
    expect(result.code).toBe(2);
  });
});

describe('severity block — git clean -f', { timeout: 15000 }, () => {
  it('exits 2 for "git clean -f"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git clean -f'),
    });
    expect(result.code).toBe(2);
  });
});

describe('severity block — git restore .', { timeout: 15000 }, () => {
  it('exits 2 for "git restore ."', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git restore .'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// rm -rf — path exception logic
// ---------------------------------------------------------------------------

describe('rm -rf path exception', { timeout: 15000 }, () => {
  it('exits 2 (blocked) for "rm -rf src/"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf src/'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 0 (allowed) for "rm -rf .orchestrator/tmp/foo"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(`rm -rf ${path.join(dir, '.orchestrator/tmp/foo')}`),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 (allowed) for relative path .orchestrator/tmp/something', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf .orchestrator/tmp/something'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 (allowed) for "rm -rf node_modules"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf node_modules'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 2 (blocked) for "rm -rf /" (root)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// git-stash-any — warn only when non-empty stash
// ---------------------------------------------------------------------------

describe('git-stash-any — conditional warn', { timeout: 30000 }, () => {
  it('exits 0 silently when git stash is empty', async () => {
    const dir = await mkProjectTracked();
    // No stash entries in fresh repo
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git stash'),
    });
    expect(result.code).toBe(0);
    // Should be silent (no ⚠ stash warning)
    expect(result.stderr).not.toContain('git-stash-any');
  });

  it('exits 0 with warning when git stash is non-empty', async () => {
    const dir = await mkProjectTracked();
    // Create a stash entry
    const { $ } = await import('zx');
    $.verbose = false;
    $.quiet = true;
    // Need a tracked file + modification to create a stash
    await fs.writeFile(path.join(dir, 'README.md'), 'init');
    await $`git -C ${dir} add README.md`;
    await $`git -C ${dir} commit -m "init"`;
    await fs.writeFile(path.join(dir, 'README.md'), 'modified');
    await $`git -C ${dir} stash`;

    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git stash'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('git-stash-any');
  });
});

// ---------------------------------------------------------------------------
// Malformed policy — allow with warning
// ---------------------------------------------------------------------------

describe('malformed policy', { timeout: 15000 }, () => {
  it('exits 0 with warning when policy JSON is invalid', async () => {
    const dir = await mkProjectTracked();
    // Overwrite with invalid JSON
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'policy', 'blocked-commands.json'),
      'not valid json {'
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('malformed');
  });

  it('exits 0 with warning when policy is missing .rules array', async () => {
    const dir = await mkProjectTracked({
      policy: { version: 1 }, // no rules array
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('rules');
  });
});

// ---------------------------------------------------------------------------
// No match → allow
// ---------------------------------------------------------------------------

describe('no match → allow', { timeout: 15000 }, () => {
  it('exits 0 for a benign command like "git status"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git status'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 for "ls -la"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls -la'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Severity warn — git revert (non-stash)
// ---------------------------------------------------------------------------

describe('severity warn — git revert', { timeout: 15000 }, () => {
  it('exits 0 with ⚠ on stderr for "git revert HEAD"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git revert HEAD'),
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('⚠');
    expect(result.stderr).toContain('git-revert-commit');
  });
});

// ---------------------------------------------------------------------------
// Shell-operator bypass — conservative blocking
// ---------------------------------------------------------------------------

describe('shell-operator bypass — conservative blocking', { timeout: 15000 }, () => {
  it('exits 2 for semicolon-chained: "ls; git reset --hard HEAD"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls; git reset --hard HEAD'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for subshell: "(git reset --hard HEAD)"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('(git reset --hard HEAD)'),
    });
    expect(result.code).toBe(2);
  });
});
