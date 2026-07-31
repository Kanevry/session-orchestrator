/**
 * tests/scripts/check-package-manager.test.mjs
 *
 * Vitest suite for scripts/check-package-manager.mjs — the package-manager
 * recurrence guard (issue #715). Exercises the exported pure functions
 * against synthetic tmp git repos, plus the CLI end-to-end via spawnSync so
 * exit codes and stdout/stderr contracts are verified, not just the library
 * surface.
 *
 * Finding codes under test:
 *   w1  node_modules/.pnpm exists (pnpm's own dependency store)
 *   w2  node_modules/vitest is a symlink (pnpm hoisting signature)
 *   w3  a stray root pnpm-lock.yaml sits alongside package-lock.json
 *   c0  git itself is unavailable — committed-tree invariants NOT verified
 *   c1  pnpm-lock.yaml is tracked in git (must not be)
 *   c2  package-lock.json is not tracked in git (must be)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import {
  checkCommittedTree,
  checkWorkingTreeDrift,
  resolveRepoRoot,
  parseCiEnv,
  runPackageManagerGuard,
} from '../../scripts/check-package-manager.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-package-manager.mjs');

// ---------------------------------------------------------------------------
// CI-wiring derivation (#958 finding 1) — marker-delimited so a falsification
// harness can execute THIS source verbatim against a mutated .gitlab-ci.yml
// copy and observe the assertion go red (same verbatim-block technique as
// tests/husky/pre-commit-nul-byte-guard.test.mjs).
// ci-guard-derivation:begin
/** `npm ci` in command position (never the `npm install` in the nested-deps step). */
const NPM_CI_RE = /(^|[\s;&|(])npm ci(\s|$)/;
/** The guard invocation in command position (never inside an echo or a comment). */
const GUARD_COMMAND_RE = /(^|[\s;&|(])node scripts\/check-package-manager\.mjs(\s|$)/;

/**
 * Flatten a parsed `.gitlab-ci.yml` into its executable step lists, keeping the
 * ones that BOTH install with `npm ci` and run the package-manager guard, and
 * recording whether the guard comes after the install it verifies.
 *
 * js-yaml resolves `<<:` merge keys to the same array instance the anchor
 * declares, so inheriting jobs are deduped by identity: a shared `before_script`
 * is reported once, under the anchor, not once per consumer.
 *
 * @param {Record<string, unknown>} ciDoc parsed `.gitlab-ci.yml` document
 * @returns {{ block: string, phase: string, guardAfterInstall: boolean }[]}
 */
function deriveInstallAndGuardLists(ciDoc) {
  const seen = new Set();
  const lists = [];
  for (const [block, value] of Object.entries(ciDoc ?? {})) {
    if (value === null || typeof value !== 'object') continue;
    for (const phase of ['before_script', 'script', 'after_script']) {
      const rawSteps = value[phase];
      if (!Array.isArray(rawSteps) || seen.has(rawSteps)) continue;
      seen.add(rawSteps);
      const steps = rawSteps.flat(Infinity).map(String);
      const installIdx = steps.findIndex((step) => NPM_CI_RE.test(step));
      const guardIdx = steps.findIndex((step) => GUARD_COMMAND_RE.test(step));
      if (installIdx === -1 || guardIdx === -1) continue;
      lists.push({ block, phase, guardAfterInstall: guardIdx > installIdx });
    }
  }
  return lists;
}
// ci-guard-derivation:end

const installAndGuardLists = deriveInstallAndGuardLists(
  loadYaml(readFileSync(join(REPO_ROOT, '.gitlab-ci.yml'), 'utf8')),
);

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function gitInit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  // Override any global gpgsign requirement so commits never hang on a passphrase.
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
}

function gitCommitAll(dir, message = 'init') {
  spawnSync('git', ['add', '-A'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', message], { cwd: dir });
}

/** Writes a minimal package.json (+ optional package-lock.json) into `dir`. */
function writePackageFiles(dir, { lockfile = true } = {}) {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  if (lockfile) {
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ name: 'fixture', lockfileVersion: 3 }),
    );
  }
}

/** A committed, npm-canonical repo: package.json + package-lock.json, both tracked. */
function makeCleanNpmRepo(dir) {
  writePackageFiles(dir);
  gitInit(dir);
  gitCommitAll(dir);
}

function runCli(args, { cwd, env } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    timeout: 8000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Base CLI env with CI explicitly cleared, so ambient CI vars never leak into a test. */
function baseEnv(overrides = {}) {
  return { ...process.env, CI: '', ...overrides };
}

// ---------------------------------------------------------------------------

describe('check-package-manager.mjs', () => {
  let tmp;
  let extraDirs;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'check-pkg-mgr-'));
    extraDirs = [];
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    for (const dir of extraDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeExtraTmpDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    extraDirs.push(dir);
    return dir;
  }

  // -------------------------------------------------------------------------
  // checkCommittedTree — c0/c1/c2
  // -------------------------------------------------------------------------

  describe('checkCommittedTree (committed-tree invariant)', () => {
    it('returns no findings for a clean npm repo (package-lock.json tracked, no pnpm-lock.yaml)', () => {
      makeCleanNpmRepo(tmp);
      expect(checkCommittedTree(tmp)).toEqual([]);
    });

    it('reports c1 when pnpm-lock.yaml is tracked in git', () => {
      makeCleanNpmRepo(tmp);
      writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
      gitCommitAll(tmp, 'add pnpm-lock.yaml');

      expect(checkCommittedTree(tmp)).toEqual([
        {
          code: 'c1',
          severity: 'error',
          message:
            'pnpm-lock.yaml is tracked in git — this repo is npm-canonical (package-lock.json is the committed lockfile). Untrack it: git rm --cached pnpm-lock.yaml',
        },
      ]);
    });

    it('reports c2 when package-lock.json is not tracked in git', () => {
      writePackageFiles(tmp, { lockfile: false });
      gitInit(tmp);
      spawnSync('git', ['add', 'package.json'], { cwd: tmp });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmp });

      expect(checkCommittedTree(tmp)).toEqual([
        {
          code: 'c2',
          severity: 'error',
          message:
            'package-lock.json is not tracked in git — required for this npm-canonical repo. Run: npm install && git add package-lock.json',
        },
      ]);
    });

    it('reports c0 with severity warn when git itself is unavailable', () => {
      makeCleanNpmRepo(tmp);
      const originalPath = process.env.PATH;
      try {
        process.env.PATH = '';
        expect(checkCommittedTree(tmp)).toEqual([
          {
            code: 'c0',
            severity: 'warn',
            message:
              'git unavailable — committed-tree invariants NOT verified (could not run `git ls-files` for pnpm-lock.yaml / package-lock.json).',
          },
        ]);
      } finally {
        process.env.PATH = originalPath;
      }
    });
  });

  // -------------------------------------------------------------------------
  // checkWorkingTreeDrift — w1/w2/w3
  // -------------------------------------------------------------------------

  describe('checkWorkingTreeDrift (working-tree drift)', () => {
    it('returns no findings for a clean repo with no node_modules and no stray lockfile', () => {
      makeCleanNpmRepo(tmp);
      expect(checkWorkingTreeDrift(tmp)).toEqual([]);
    });

    it('reports w1 when node_modules/.pnpm exists', () => {
      makeCleanNpmRepo(tmp);
      mkdirSync(join(tmp, 'node_modules', '.pnpm'), { recursive: true });

      const findings = checkWorkingTreeDrift(tmp);
      expect(findings).toEqual([
        {
          code: 'w1',
          severity: 'error',
          message:
            "node_modules/.pnpm exists — node_modules has a pnpm layout, not npm's. Remediation: rm -rf node_modules pnpm-lock.yaml && npm ci",
        },
      ]);
    });

    it('reports w2 when node_modules/vitest is a symlink', () => {
      makeCleanNpmRepo(tmp);
      mkdirSync(join(tmp, 'node_modules'), { recursive: true });
      mkdirSync(join(tmp, '.dummy-target'), { recursive: true });
      symlinkSync(join(tmp, '.dummy-target'), join(tmp, 'node_modules', 'vitest'), 'dir');

      const findings = checkWorkingTreeDrift(tmp);
      expect(findings).toEqual([
        {
          code: 'w2',
          severity: 'error',
          message:
            "node_modules/vitest is a symlink — node_modules has a pnpm layout, not npm's. Remediation: rm -rf node_modules pnpm-lock.yaml && npm ci",
        },
      ]);
    });

    it('does not report w1/w2 when node_modules is absent, regardless of allowMissingNodeModules', () => {
      makeCleanNpmRepo(tmp);
      expect(checkWorkingTreeDrift(tmp, { allowMissingNodeModules: true })).toEqual([]);
    });

    // -----------------------------------------------------------------------
    // Fake-regression check (testing.md "Negative-Assertion Fake-Regression
    // Check"): the RED test below PLANTS the exact drift the guard exists to
    // catch (a stray untracked pnpm-lock.yaml sitting next to
    // package-lock.json) and asserts the guard reports it. Its GREEN half is
    // the first test in this describe block ("returns no findings for a clean
    // repo…") — same fixture, same call, `toEqual([])`; a second, byte-identical
    // copy of it used to sit here purely to be adjacent to the RED case, which
    // is duplication, not coverage (TV-002), so it was removed.
    // -----------------------------------------------------------------------

    it('RED path (guard bites): reports w3 when a stray untracked pnpm-lock.yaml is planted', () => {
      makeCleanNpmRepo(tmp);
      writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');

      const findings = checkWorkingTreeDrift(tmp);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ code: 'w3', severity: 'warn' });
    });
  });

  // -------------------------------------------------------------------------
  // resolveRepoRoot
  // -------------------------------------------------------------------------

  describe('resolveRepoRoot', () => {
    it('returns the git root when cwd is inside a git working tree', () => {
      makeCleanNpmRepo(tmp);
      const result = resolveRepoRoot(tmp);
      expect(result).toEqual({ repoRoot: realpathSync(tmp), gitRoot: realpathSync(tmp) });
    });

    it('falls back to the script parent directory with a null gitRoot outside a git working tree', () => {
      const nonGitDir = makeExtraTmpDir('check-pkg-mgr-nogit-');
      const result = resolveRepoRoot(nonGitDir);
      expect(result).toEqual({ repoRoot: resolve(REPO_ROOT), gitRoot: null });
    });
  });

  // -------------------------------------------------------------------------
  // parseCiEnv
  // -------------------------------------------------------------------------

  describe('parseCiEnv', () => {
    it.each([
      ['', false],
      ['0', false],
      ['false', false],
      ['FALSE', false],
      ['no', false],
      [undefined, false],
      ['true', true],
      ['1', true],
      ['yes', true],
      ['anything', true],
    ])('parseCiEnv(%j) returns %s', (input, expected) => {
      expect(parseCiEnv(input)).toBe(expected);
    });
  });

  // -------------------------------------------------------------------------
  // runPackageManagerGuard
  // -------------------------------------------------------------------------

  describe('runPackageManagerGuard', () => {
    // NOTE: `cwd` is always pinned to `tmp` alongside the explicit `repoRoot`
    // below. Without it, `cwd` defaults to `process.cwd()` (the real
    // session-orchestrator checkout, which has its own package.json) and the
    // SCOPE GUARD (`resolve(cwd) !== resolve(gitRoot)` + a package.json at
    // cwd) fires unintentionally, short-circuiting the result to
    // `skipped:true` before the fixture is ever inspected.

    it('returns ok:true with empty findings for a clean repo', () => {
      makeCleanNpmRepo(tmp);
      const result = runPackageManagerGuard({ repoRoot: tmp, cwd: tmp, ci: false });
      expect(result).toEqual({ ok: true, ci: false, skipped: false, repoRoot: tmp, findings: [] });
    });

    it('w3 stays effectiveSeverity warn (ok:true) locally when ci is false', () => {
      makeCleanNpmRepo(tmp);
      writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
      const result = runPackageManagerGuard({ repoRoot: tmp, cwd: tmp, ci: false });
      expect(result.ok).toBe(true);
      expect(result.findings).toEqual([
        expect.objectContaining({ code: 'w3', severity: 'warn', effectiveSeverity: 'warn' }),
      ]);
    });

    it('w3 is promoted to effectiveSeverity error (ok:false) under CI', () => {
      makeCleanNpmRepo(tmp);
      writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
      const result = runPackageManagerGuard({ repoRoot: tmp, cwd: tmp, ci: true });
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        expect.objectContaining({ code: 'w3', severity: 'warn', effectiveSeverity: 'error' }),
      ]);
    });

    it('w1 (a hard error finding) fails the guard even when ci is false', () => {
      makeCleanNpmRepo(tmp);
      mkdirSync(join(tmp, 'node_modules', '.pnpm'), { recursive: true });
      const result = runPackageManagerGuard({ repoRoot: tmp, cwd: tmp, ci: false });
      expect(result.ok).toBe(false);
    });

    it('SCOPE GUARD: skips with skipped:true for a nested cwd that is not the git root', () => {
      makeCleanNpmRepo(tmp);
      const nested = join(tmp, 'skills', 'vault-sync');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'package.json'), '{}');

      const result = runPackageManagerGuard({ cwd: nested });
      expect(result).toEqual({
        ok: true,
        ci: result.ci,
        skipped: true,
        repoRoot: realpathSync(tmp),
        findings: [],
      });
    });
  });

  // -------------------------------------------------------------------------
  // CLI (spawned subprocess)
  // -------------------------------------------------------------------------

  describe('CLI', () => {
    it('exits 0 and prints OK for a clean repo', () => {
      makeCleanNpmRepo(tmp);
      const r = runCli([], { cwd: tmp, env: baseEnv() });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        '[check-package-manager] OK — package manager is consistent (npm-canonical)',
      );
    });

    it('--json prints a parseable result object with ok:true and empty findings for a clean repo', () => {
      makeCleanNpmRepo(tmp);
      const r = runCli(['--json'], { cwd: tmp, env: baseEnv() });
      const parsed = JSON.parse(r.stdout.trim());
      expect(parsed).toMatchObject({ ok: true, skipped: false, findings: [] });
    });

    it('unknown flag exits 2 with a usage error message', () => {
      makeCleanNpmRepo(tmp);
      const r = runCli(['--bogus-flag'], { cwd: tmp, env: baseEnv() });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('[check-package-manager] unknown flag(s): --bogus-flag');
    });

    it('--help exits 0 with usage text referencing issue #715', () => {
      const r = runCli(['--help'], { cwd: tmp, env: baseEnv() });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('check-package-manager.mjs — package-manager recurrence guard (issue #715)');
    });

    it('--version exits 0 and prints the package version', () => {
      const r = runCli(['--version'], { cwd: tmp, env: baseEnv() });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('SCOPE GUARD: a nested cwd with its own package.json exits 0 silently (skip message)', () => {
      makeCleanNpmRepo(tmp);
      const nested = join(tmp, 'skills', 'vault-sync');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'package.json'), '{}');

      const r = runCli([], { cwd: nested, env: baseEnv() });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('[check-package-manager] cwd is not the repo root (nested package.json)');
    });

    // -------------------------------------------------------------------
    // Fake-regression check (CLI level): GREEN baseline vs RED planted-drift,
    // under both a local and a CI environment. Proves the CLI's exit code
    // and message actually change when the w3 drift is introduced.
    // -------------------------------------------------------------------

    it('GREEN baseline: local run with no stray lockfile has no warning suffix', () => {
      makeCleanNpmRepo(tmp);
      const r = runCli([], { cwd: tmp, env: baseEnv() });
      expect(r.stdout).not.toMatch(/warning\(s\)/);
    });

    it('RED path (guard bites) local: planted stray pnpm-lock.yaml exits 0 but warns', () => {
      makeCleanNpmRepo(tmp);
      writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
      const r = runCli([], { cwd: tmp, env: baseEnv() });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(
        '[check-package-manager] OK — package manager is consistent (npm-canonical) (1 warning(s))',
      );
      expect(r.stderr).toContain('[check-package-manager] WARN (w3):');
    });

    it('RED path (guard bites) under CI: planted stray pnpm-lock.yaml exits 1 fail-closed', () => {
      makeCleanNpmRepo(tmp);
      writeFileSync(join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
      const r = runCli([], { cwd: tmp, env: baseEnv({ CI: 'true' }) });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain('[check-package-manager] FAIL-CLOSED: 1 guard violation(s) — see above');
    });

    // -------------------------------------------------------------------
    // c0 — git unavailable (PATH stripped so the `git` binary cannot be
    // found). Because git itself is unavailable, resolveRepoRoot() falls
    // back to this script's own parent directory regardless of cwd — the
    // fixture cwd content is irrelevant here, only its git-independence
    // matters. We assert on the c0 finding's own shape (deterministic)
    // rather than on the overall `ok`/exit code for the local case, since
    // that also reflects the real host repo's unrelated working-tree state.
    // -------------------------------------------------------------------

    it('c0: --json reports a warn finding when git is unavailable (local)', () => {
      const r = runCli(['--json'], { cwd: tmp, env: { PATH: '' } });
      const parsed = JSON.parse(r.stdout.trim());
      const c0 = parsed.findings.find((f) => f.code === 'c0');
      expect(c0).toEqual({
        code: 'c0',
        severity: 'warn',
        message:
          'git unavailable — committed-tree invariants NOT verified (could not run `git ls-files` for pnpm-lock.yaml / package-lock.json).',
        effectiveSeverity: 'warn',
      });
    });

    it('c0: exits 1 fail-closed under CI when git is unavailable', () => {
      const r = runCli(['--json'], { cwd: tmp, env: { PATH: '', CI: 'true' } });
      expect(r.status).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Wiring contract (#715 follow-up) — this repo's `.npmrc` sets
  // `ignore-scripts=true` (SEC-020), which makes npm's own `preinstall`/
  // `pretest` lifecycle hooks silently DEAD (npm never runs them). The guard
  // is instead wired via an explicit `&&`-chain in the `test`/`test:coverage`
  // scripts, a git-native `.husky/pre-commit` hook, and a GitLab CI
  // `before_script` step. These tests assert the wiring stays in place — a
  // regression here means the guard silently stops firing again, exactly the
  // incident class #715 exists to prevent.
  // -------------------------------------------------------------------------

  describe('wiring contract (#715 — ignore-scripts=true kills preinstall/pretest)', () => {
    const rootPackageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

    it('test script chains check-package-manager.mjs before vitest runs', () => {
      expect(rootPackageJson.scripts.test).toMatch(/^node scripts\/check-package-manager\.mjs && /);
    });

    it('test:coverage script chains check-package-manager.mjs before vitest runs', () => {
      expect(rootPackageJson.scripts['test:coverage']).toMatch(
        /^node scripts\/check-package-manager\.mjs && /,
      );
    });

    it('has no preinstall/pretest keys — both are dead under ignore-scripts=true (.npmrc) and would never fire', () => {
      expect(rootPackageJson.scripts.preinstall).toBeUndefined();
      expect(rootPackageJson.scripts.pretest).toBeUndefined();
    });

    it('.husky/pre-commit invokes check-package-manager.mjs in command position', () => {
      // The hook mentions the guard three times: a header comment (stage list),
      // the real invocation, and an `echo "Run \`node scripts/…\`"` remediation
      // hint. A file-wide `toContain` — the previous form — is satisfied by
      // EITHER non-executable mention, so it stayed green with the invocation
      // itself deleted. Scope to lines whose COMMAND position is the guard.
      const commandLines = readFileSync(join(REPO_ROOT, '.husky', 'pre-commit'), 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => !line.startsWith('#'));

      expect(commandLines.filter((line) => GUARD_COMMAND_RE.test(line))).toHaveLength(1);
    });

    // -----------------------------------------------------------------------
    // CI wiring, asserted against the PARSED job graph (#958 finding 1).
    //
    // The previous form compared byte offsets in the raw file:
    //   ciConfig.indexOf('- npm ci') vs ciConfig.indexOf('node scripts/…')
    // `- npm ci` occurs twice (the shared node-setup anchor and the
    // vault-integration-watcher job) and so does the guard (the anchor and the
    // standalone package-manager-guard job). Deleting the guard from the
    // anchor's before_script therefore only slid `indexOf` forward to the
    // standalone job's occurrence — still numerically after the first
    // `- npm ci` — so the assertion stayed GREEN while the wiring it claimed to
    // check was gone. A file-wide offset is not evidence about a block.
    //
    // The property that is actually load-bearing is per-block ORDER: inside one
    // executable step list, the guard runs after the install it is verifying.
    // js-yaml resolves anchors and `<<:` merge keys, so the inheriting jobs
    // share the anchor's resolved array (deduped by identity below) and the
    // assertion follows a rename of the anchor or its consumers.
    // -----------------------------------------------------------------------

    it('runs the guard after `npm ci` inside the same CI step list', () => {
      expect(installAndGuardLists.length).toBeGreaterThan(0);
      expect(installAndGuardLists.filter((entry) => !entry.guardAfterInstall)).toEqual([]);
    });
  });
});
