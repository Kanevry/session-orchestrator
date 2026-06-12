/**
 * tests/hooks/blocked-commands-policy.test.mjs
 *
 * Regression and contract tests for the REAL production policy file
 * (.orchestrator/policy/blocked-commands.json) and the
 * hooks/pre-bash-destructive-guard.mjs hook that consumes it.
 *
 * Background: earlier tests used a FIXTURE policy, so a trailing-space bug
 * in the `git checkout -- ` pattern slipped through undetected. This suite
 * always loads the real file so structural regressions are caught at the
 * policy-authoring level, not only at hook runtime.
 *
 * Issues: #139 (hook implementation), #143–#145 (test migration wave)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const POLICY_PATH = path.join(REPO_ROOT, '.orchestrator', 'policy', 'blocked-commands.json');
const HOOK = path.join(REPO_ROOT, 'hooks', 'pre-bash-destructive-guard.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the guard hook as a subprocess with a bash command on stdin.
 * CLAUDE_PLUGIN_ROOT points to the repo root so the hook finds the real policy.
 * CLAUDE_PROJECT_DIR points to a fresh temp dir (git-init'd).
 */
async function runGuard({ projectDir, command }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: REPO_ROOT,
      CLAUDE_PROJECT_DIR: projectDir,
    };

    const child = spawn(process.execPath, [HOOK], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command },
    });
    child.stdin.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

const tmpDirs = [];

async function mkTempProject({ claudeMd } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-policy-test-'));
  tmpDirs.push(dir);

  // Init git so project-root detection matches production
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;

  if (claudeMd !== undefined) {
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd, 'utf8');
  }

  return dir;
}

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Section 1 — Policy file structural assertions
// (These tests exercise the JSON file directly, no subprocess needed)
// ---------------------------------------------------------------------------

describe('production policy file structure', () => {
  let policy;

  beforeEach(async () => {
    const raw = await fs.readFile(POLICY_PATH, 'utf8');
    policy = JSON.parse(raw);
  });

  it('JSON is parseable and has version: 1', () => {
    expect(policy.version).toBe(1);
  });

  it('rules array has exactly 13 entries', () => {
    expect(Array.isArray(policy.rules)).toBe(true);
    expect(policy.rules).toHaveLength(13);
  });

  it('every rule has required fields: id, pattern, severity, rationale', () => {
    for (const rule of policy.rules) {
      expect(typeof rule.id).toBe('string');
      expect(rule.id.length).toBeGreaterThan(0);
      expect(typeof rule.pattern).toBe('string');
      expect(rule.pattern.length).toBeGreaterThan(0);
      expect(typeof rule.severity).toBe('string');
      expect(typeof rule.rationale).toBe('string');
      expect(rule.rationale.length).toBeGreaterThan(0);
    }
  });

  it('all severity values are "block" or "warn"', () => {
    const validSeverities = new Set(['block', 'warn']);
    for (const rule of policy.rules) {
      expect(validSeverities.has(rule.severity)).toBe(true);
    }
  });

  it('all rule ids are unique', () => {
    const ids = policy.rules.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(13);
  });

  it('rule id "git-checkout-discard" pattern has no trailing whitespace (regression: trailing-space bypass)', () => {
    const rule = policy.rules.find((r) => r.id === 'git-checkout-discard');
    expect(rule).toBeDefined();
    // The trailing-space bug: pattern was "git checkout -- " (trailing space)
    // which would miss "git checkout -- ." because the match failed.
    // Verify there is no trailing or leading whitespace in the pattern.
    expect(rule.pattern).toBe(rule.pattern.trim());
  });

  it('rule "rm-rf-destructive" carries a path-allowlist with /tmp + $TMPDIR (#641)', () => {
    const rule = policy.rules.find((r) => r.id === 'rm-rf-destructive');
    expect(rule).toBeDefined();
    expect(rule['path-allowlist']).toEqual(['/tmp/', '/private/tmp/', '$TMPDIR']);
  });

  it('path-allowlist appears ONLY on rm-rf-destructive (never on git/SQL rules) (#641)', () => {
    const withAllowlist = policy.rules
      .filter((r) => r['path-allowlist'] !== undefined)
      .map((r) => r.id);
    expect(withAllowlist).toEqual(['rm-rf-destructive']);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — Hook integration: blocked commands (exit 2)
// ---------------------------------------------------------------------------

describe('hook blocks dangerous commands (exit 2)', { timeout: 20000 }, () => {
  it('blocks "git reset --hard HEAD~1" (rule: git-reset-hard)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git reset --hard HEAD~1' });
    expect(result.code).toBe(2);
  });

  it('blocks "git checkout -- ." (rule: git-checkout-discard) — REGRESSION TEST', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git checkout -- .' });
    expect(result.code).toBe(2);
  });

  it('blocks "git checkout -- src/file.ts" (rule: git-checkout-discard)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git checkout -- src/file.ts' });
    expect(result.code).toBe(2);
  });

  it('blocks "git clean -fd" (rule: git-clean)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git clean -fd' });
    expect(result.code).toBe(2);
  });

  it('blocks "git push --force" (rule: git-push-force)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git push --force' });
    expect(result.code).toBe(2);
  });

  it('blocks "git push -f origin main" (rule: git-push-force short form)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git push -f origin main' });
    expect(result.code).toBe(2);
  });

  it('blocks "rm -rf /var/data" (rm-rf outside safe paths)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf /var/data' });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — Hook allows safe rm -rf paths (exit 0)
// ---------------------------------------------------------------------------

describe('hook allows rm -rf on safe paths (exit 0)', { timeout: 20000 }, () => {
  it('allows "rm -rf node_modules" (safe path exception)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf node_modules' });
    expect(result.code).toBe(0);
  });

  it('allows "rm -rf .orchestrator/tmp/cache" (safe path exception)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf .orchestrator/tmp/cache' });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 4 — Warn severity: git stash with non-empty stash
// ---------------------------------------------------------------------------

describe('warn severity: git stash (exit 0, ⚠ on stderr)', { timeout: 20000 }, () => {
  it('exits 0 and writes ⚠ to stderr when git stash is used with non-empty stash', async () => {
    const dir = await mkTempProject();

    // Create a stash entry so stash is non-empty
    const { $ } = await import('zx');
    $.verbose = false;
    $.quiet = true;
    // Set up a commit and a dirty file so stash has something to record
    await $`git -C ${dir} config user.email "test@example.com"`;
    await $`git -C ${dir} config user.name "Test"`;
    await fs.writeFile(path.join(dir, 'init.txt'), 'init');
    await $`git -C ${dir} add init.txt`;
    await $`git -C ${dir} commit -m "init" -q`;
    await fs.writeFile(path.join(dir, 'dirty.txt'), 'change');
    await $`git -C ${dir} add dirty.txt`;
    // Stash it so the stash list is non-empty
    await $`git -C ${dir} stash`.catch(() => {});

    const result = await runGuard({ projectDir: dir, command: 'git stash' });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('⚠');
  });
});

// ---------------------------------------------------------------------------
// Section 5 — allow-destructive-ops override in CLAUDE.md
// ---------------------------------------------------------------------------

describe('allow-destructive-ops: true in CLAUDE.md overrides block', { timeout: 20000 }, () => {
  it('exits 0 for "git reset --hard" when allow-destructive-ops: true is set in CLAUDE.md', async () => {
    const claudeMd = [
      '# Project Config',
      '',
      '## Session Config',
      '',
      'allow-destructive-ops: true',
    ].join('\n');

    const dir = await mkTempProject({ claudeMd });
    const result = await runGuard({ projectDir: dir, command: 'git reset --hard' });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 6 — /tmp allowlist + quoted-payload false-positive fixes (#641)
// Exercises the REAL production policy (which now carries path-allowlist).
//
// NOTE: blocked substrings are constructed as JS string literals passed via
// stdin to the spawned hook — never as literal substrings on this process's
// shell command line (the guard hook is active on the test runner itself).
// ---------------------------------------------------------------------------

describe('#641 — /tmp allowlist allows agent-owned scratch (exit 0)', { timeout: 20000 }, () => {
  it('allows "rm -rf /tmp/wondraiwork-632" (FP1 — agent tmp clone)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf /tmp/wondraiwork-632' });
    expect(result.code).toBe(0);
  });

  it('allows "rm -rf /private/tmp/foo" (macOS canonical /tmp)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf /private/tmp/foo' });
    expect(result.code).toBe(0);
  });

  it('allows a resolved os.tmpdir() target ($TMPDIR allowlist entry)', async () => {
    const dir = await mkTempProject();
    const target = path.join(os.tmpdir(), 'agent-scratch-641');
    const result = await runGuard({ projectDir: dir, command: `rm -rf ${target}` });
    expect(result.code).toBe(0);
  });
});

describe('#641 — quoted-payload guard removes false positives (exit 0)', { timeout: 20000 }, () => {
  it('allows memory-propose with blocked substrings inside quoted args (FP2)', async () => {
    const dir = await mkTempProject();
    // The FP2 command: blocked patterns live ONLY inside quoted --insight / --evidence.
    const insight = 'workaround used ' + 'rm ' + '-rf /tmp/x';
    const evidence = 'see ' + 'git ' + 'reset --hard note';
    const command = `node scripts/memory-propose.mjs --insight "${insight}" --evidence "${evidence}"`;
    const result = await runGuard({ projectDir: dir, command });
    expect(result.code).toBe(0);
  });

  it('allows node script with a force-push warning string in a quoted arg', async () => {
    const dir = await mkTempProject();
    const msg = 'do not run ' + 'git ' + 'push --force';
    const command = `node x.mjs --msg "${msg}"`;
    const result = await runGuard({ projectDir: dir, command });
    expect(result.code).toBe(0);
  });

  it('allows echo of a quoted destructive literal', async () => {
    const dir = await mkTempProject();
    const command = 'echo "' + 'rm ' + '-rf /"';
    const result = await runGuard({ projectDir: dir, command });
    expect(result.code).toBe(0);
  });
});

describe('#641 — bypass vectors still blocked against real policy (exit 2)', { timeout: 30000 }, () => {
  // Build each attack string from fragments so no literal blocked substring
  // appears on the test-runner shell command line.
  const RMRF = 'rm ' + '-rf';
  const RESET = 'git ' + 'reset --hard';
  const interpreterVectors = [
    ['bash -c', `bash -c "${RMRF} /data"`],
    ['sh -c', `sh -c "${RMRF} /data"`],
    ['eval', `eval "${RMRF} /data"`],
    ['xargs', `echo /data | xargs ${RMRF}`],
    ['semicolon', `ls; ${RMRF} /data`],
    ['and-and', `true && ${RMRF} /data`],
    ['pipe-to-rm', `echo x | ${RMRF} /data`],
    ['env-assign', `FOO=1 ${RMRF} /data`],
    ['cmd-subst', `x=$(${RMRF} /data)`],
    ['command-prefix', `command ${RMRF} /data`],
  ];

  it.each(interpreterVectors)('blocks bypass vector: %s', async (_label, command) => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command });
    expect(result.code).toBe(2);
  });

  it('blocks "ls && git reset --hard HEAD" (chained git reset)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: `ls && ${RESET} HEAD` });
    expect(result.code).toBe(2);
  });

  it('blocks bare "git reset --hard HEAD~1"', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: `${RESET} HEAD~1` });
    expect(result.code).toBe(2);
  });

  it('blocks psql -c "DROP TABLE users" (SQL executor)', async () => {
    const dir = await mkTempProject();
    const command = 'psql -c "' + 'DROP ' + 'TABLE users"';
    const result = await runGuard({ projectDir: dir, command });
    expect(result.code).toBe(2);
  });

  it('blocks mixed chain where one rm target is non-allowlisted', async () => {
    const dir = await mkTempProject();
    const command = `${RMRF} /tmp/x; ${RMRF} src/`;
    const result = await runGuard({ projectDir: dir, command });
    expect(result.code).toBe(2);
  });
});
