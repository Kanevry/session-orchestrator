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

import { expectDeny, expectAllow } from '../_helpers/hook-decision.mjs';

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

  it('rules array count stays inside the floor/ceiling corridor (testing.md § Dynamic Artifact Counts)', () => {
    expect(Array.isArray(policy.rules)).toBe(true);
    // Floor 13 catches accidental rule deletion; ceiling 40 catches runaway
    // growth. Exact-count pinning drifted on every legitimate rule addition
    // (13→14 via #983 redirect-truncate-protected).
    expect(policy.rules.length).toBeGreaterThanOrEqual(13);
    expect(policy.rules.length).toBeLessThanOrEqual(40);
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
    expect(uniqueIds.size).toBe(policy.rules.length);
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

  it('rule "redirect-truncate-protected" has type/severity/denylist/modes contract (#983)', () => {
    const rule = policy.rules.find((r) => r.id === 'redirect-truncate-protected');
    expect(rule).toBeDefined();
    expect(rule.type).toBe('redirect-truncate');
    expect(rule.severity).toBe('block');
    expect(Array.isArray(rule['target-denylist'])).toBe(true);
    expect(rule['target-denylist'].length).toBeGreaterThan(0);
    expect(rule.modes).toEqual(['truncate']);
  });

  it('target-denylist appears ONLY on redirect-truncate rules — a DIFFERENT field than path-allowlist (#983)', () => {
    // Denylist polarity is exclusive to the redirect rule class: a
    // target-denylist leaking onto a pattern rule would silently change its
    // matching semantics (the guard rule-loop dispatches on rule.type).
    for (const rule of policy.rules) {
      if (rule['target-denylist'] !== undefined) {
        expect(rule.type).toBe('redirect-truncate');
        expect(rule['path-allowlist']).toBeUndefined();
      }
    }
    const withDenylist = policy.rules
      .filter((r) => r['target-denylist'] !== undefined)
      .map((r) => r.id);
    expect(withDenylist).toEqual(['redirect-truncate-protected']);
  });
});

// ---------------------------------------------------------------------------
// Section 2 — Hook integration: blocked commands (deny envelope on stdout)
//
// Since #906 a deny is `exit 0` + a `hookSpecificOutput` envelope, NOT `exit 2`
// — under `exit 2` Claude Code discards stdout, so the reason never reaches the
// operator. The exit code alone therefore no longer distinguishes allow from
// deny; expectDeny/expectAllow assert on stdout, which does.
// ---------------------------------------------------------------------------

describe('hook blocks dangerous commands (deny envelope)', { timeout: 20000 }, () => {
  it('blocks "git reset --hard HEAD~1" (rule: git-reset-hard)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git reset --hard HEAD~1' });
    expectDeny(result);
  });

  it('blocks "git checkout -- ." (rule: git-checkout-discard) — REGRESSION TEST', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git checkout -- .' });
    expectDeny(result);
  });

  it('blocks "git checkout -- src/file.ts" (rule: git-checkout-discard)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git checkout -- src/file.ts' });
    expectDeny(result);
  });

  it('blocks "git clean -fd" (rule: git-clean)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git clean -fd' });
    expectDeny(result);
  });

  it('blocks "git push --force" (rule: git-push-force)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git push --force' });
    expectDeny(result);
  });

  it('blocks "git push -f origin main" (rule: git-push-force short form)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'git push -f origin main' });
    expectDeny(result);
  });

  it('blocks "rm -rf /var/data" (rm-rf outside safe paths)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf /var/data' });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// Section 3 — Hook allows safe rm -rf paths (exit 0 + SILENT stdout)
// ---------------------------------------------------------------------------

describe('hook allows rm -rf on safe paths (exit 0, empty stdout)', { timeout: 20000 }, () => {
  it('allows "rm -rf node_modules" (safe path exception)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf node_modules' });
    expectAllow(result);
  });

  it('allows "rm -rf .orchestrator/tmp/cache" (safe path exception)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf .orchestrator/tmp/cache' });
    expectAllow(result);
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
    expectAllow(result);
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
    expectAllow(result);
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

// The exhaustive /tmp-allowlist + quoted-payload FP matrix (FP1, private/tmp,
// os.tmpdir, memory-propose, force-push-string, echo-literal) is already
// covered case-by-case against a FIXTURE policy in
// pre-bash-destructive-guard.test.mjs — that fixture mirrors this real policy
// file 1:1 (see its own "14 rules mirroring the spec" docstring), and the
// structural test above ("rule 'rm-rf-destructive' carries a path-allowlist
// with /tmp + $TMPDIR (#641)") already pins that the REAL file carries the
// same allowlist shape. Re-running all 6 FP scenarios against the real policy
// here added no falsifier the fixture-based matrix + structural pin don't
// already cover. One representative case is kept as an end-to-end smoke: it
// would catch a genuine wiring defect (e.g. the real policy file failing to
// load, or the hook not actually reading the /tmp allowlist from disk) that
// the structural JSON-shape test alone cannot.
describe('#641 — /tmp allowlist + quoted-payload FP smoke against the REAL policy (exit 0, empty stdout)', { timeout: 20000 }, () => {
  it('allows "rm -rf /tmp/wondraiwork-632" (FP1 — agent tmp clone)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: 'rm -rf /tmp/wondraiwork-632' });
    expectAllow(result);
  });
});

describe('#641 — bypass vectors still blocked against real policy (deny envelope)', { timeout: 30000 }, () => {
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
    expectDeny(result);
  });

  it('blocks "ls && git reset --hard HEAD" (chained git reset)', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: `ls && ${RESET} HEAD` });
    expectDeny(result);
  });

  it('blocks bare "git reset --hard HEAD~1"', async () => {
    const dir = await mkTempProject();
    const result = await runGuard({ projectDir: dir, command: `${RESET} HEAD~1` });
    expectDeny(result);
  });

  it('blocks psql -c "DROP TABLE users" (SQL executor)', async () => {
    const dir = await mkTempProject();
    const command = 'psql -c "' + 'DROP ' + 'TABLE users"';
    const result = await runGuard({ projectDir: dir, command });
    expectDeny(result);
  });

  it('blocks mixed chain where one rm target is non-allowlisted', async () => {
    const dir = await mkTempProject();
    const command = `${RMRF} /tmp/x; ${RMRF} src/`;
    const result = await runGuard({ projectDir: dir, command });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// Section 7 — #972 floor/overlay merge: a consumer overlay cannot disarm the
// plugin's floor policy.
//
// Every harness above collapses floor == overlay (cwd is the repo root, so the
// same file serves both roles). runGuardSplit is the FIRST harness with two
// DISTINCT roots: CLAUDE_PLUGIN_ROOT → floorDir (the production policy),
// cwd + CLAUDE_PROJECT_DIR → overlayDir (a consumer repo with its own policy).
// Pre-#972 first-hit-wins, the overlay file in cwd was the ONLY policy loaded —
// `{"version":1,"rules":[]}` silently switched the guard off.
// ---------------------------------------------------------------------------

/**
 * Spawn the guard with SPLIT floor/overlay roots (#972).
 * NB: deny and allow BOTH exit 0 since #906 — assert via expectDeny/expectAllow.
 */
async function runGuardSplit({ floorDir, overlayDir, command }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: floorDir,
      CLAUDE_PROJECT_DIR: overlayDir,
    };

    const child = spawn(process.execPath, [HOOK], {
      cwd: overlayDir,
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

/** Temp consumer project carrying its own overlay policy (object or raw string). */
async function mkOverlayProject(policyContent) {
  const dir = await mkTempProject();
  const policyDir = path.join(dir, '.orchestrator', 'policy');
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, 'blocked-commands.json'),
    typeof policyContent === 'string'
      ? policyContent
      : JSON.stringify(policyContent, null, 2)
  );
  return dir;
}

describe('#972 — floor/overlay merge (production floor + consumer overlay)', { timeout: 30000 }, () => {
  // Fragments so no blocked literal appears on the test-runner shell line.
  const RESET = 'git ' + 'reset --hard';
  const RMRF = 'rm ' + '-rf';

  it('T1: empty overlay rules [] cannot disarm the floor — git reset --hard still DENIED', async () => {
    const overlayDir = await mkOverlayProject({ version: 1, rules: [] });
    const result = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: `${RESET} HEAD~1`,
    });
    expectDeny(result);
    expect(result.stderr).toContain('overlay policy ignored');
  });

  it('T2: overlay severity downgrade block→warn on git-reset-hard → DENIED + shadow warning on stderr', async () => {
    const overlayDir = await mkOverlayProject({
      version: 1,
      rules: [{
        id: 'git-reset-hard',
        pattern: 'git ' + 'reset --hard',
        severity: 'warn',
        rationale: 'downgrade attempt',
      }],
    });
    const result = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: `${RESET} HEAD~1`,
    });
    expectDeny(result);
    expect(result.stderr).toContain('shadowed');
  });

  it('T2b: overlay severity "ignore" on git-reset-hard → still DENIED', async () => {
    const overlayDir = await mkOverlayProject({
      version: 1,
      rules: [{
        id: 'git-reset-hard',
        pattern: 'git ' + 'reset --hard',
        severity: 'ignore',
        rationale: 'disarm attempt via unknown severity',
      }],
    });
    const result = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: `${RESET} HEAD~1`,
    });
    expectDeny(result);
  });

  it('T7: overlay is invalid JSON → DENIED via floor (fail-to-floor; pre-#972 this failed OPEN)', async () => {
    const overlayDir = await mkOverlayProject('{ this is not json');
    const result = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: `${RESET} HEAD~1`,
    });
    expectDeny(result);
    expect(result.stderr).toContain('malformed');
  });

  it('T4: overlay path-allowlist ["/"] on rm-rf-destructive cannot widen the floor allowlist', async () => {
    const overlayDir = await mkOverlayProject({
      version: 1,
      rules: [{
        id: 'rm-rf-destructive',
        pattern: 'rm ' + '-rf',
        severity: 'block',
        rationale: 'allowlist-widening attempt',
        'path-allowlist': ['/'],
      }],
    });
    const result = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: `${RMRF} /var/data`,
    });
    expectDeny(result);
  });

  it('T5: overlay-only block rule is enforced additively — and a floor rule stays active beside it', async () => {
    const overlayDir = await mkOverlayProject({
      version: 1,
      rules: [{
        id: 'consumer-drop-db',
        pattern: 'dropdb --force',
        severity: 'block',
        rationale: 'consumer-specific rule',
      }],
    });

    const overlayDeny = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: 'dropdb --force production',
    });
    expectDeny(overlayDeny);

    // Floor spot-check: a production rule with NO overlay involvement still bites.
    const floorDeny = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: 'git clean -fd',
    });
    expectDeny(floorDeny);
  });

  it('fresh consumer repo without any overlay policy → floor enforced silently', async () => {
    const overlayDir = await mkTempProject();
    const result = await runGuardSplit({
      floorDir: REPO_ROOT,
      overlayDir,
      command: `${RESET} HEAD~1`,
    });
    expectDeny(result);
  });
});
