#!/usr/bin/env node
// scripts/check-package-manager.mjs
//
// Package-manager recurrence guard (issue #715).
//
// WHY THIS EXISTS (the incident class):
//   This repo is npm-canonical — package-lock.json is the committed lockfile,
//   pnpm-lock.yaml is gitignored. A bare `pnpm install` run at the repo root
//   silently rewrites node_modules into a pnpm layout (a `.pnpm` store dir +
//   symlinked top-level deps) mid-workflow. The next `npm test` then fails
//   with a confusing ERR_MODULE_NOT_FOUND, because npm's own resolution
//   expects a flat node_modules tree, not pnpm's symlink farm. CI never sees
//   this directly (the stray pnpm-lock.yaml is gitignored, so it never lands
//   in a fresh CI clone) — the failure mode is entirely local-working-tree.
//
// WHAT THIS SCRIPT CHECKS:
//   1. Working-tree drift (only meaningful once node_modules exists):
//        w1  node_modules/.pnpm exists (pnpm's own dependency store)
//        w2  node_modules/vitest is a symlink (pnpm hoisting signature —
//            npm never symlinks a direct dependency into node_modules/<name>)
//        w3  a stray root pnpm-lock.yaml sits alongside package-lock.json
//            (warn locally; upgraded to a hard failure under CI)
//   2. Committed-tree invariant (cheap, always checked via `git ls-files`):
//        c0  git itself is unavailable — invariants below NOT verified
//            (warn locally; upgraded to a hard failure under CI)
//        c1  pnpm-lock.yaml must NOT be tracked in git
//        c2  package-lock.json MUST be tracked in git
//
// SCOPE GUARD:
//   This script only guards the REPOSITORY ROOT package.json. If invoked
//   with a cwd that has its own package.json but is not the git root (e.g. a
//   lifecycle script firing inside a nested package such as
//   skills/vault-sync), it exits 0 silently — the nested package owns its
//   own package-manager hygiene.
//
// WIRING (why this is NOT an npm `preinstall`/`pretest` lifecycle hook):
//   This repo's `.npmrc` sets `ignore-scripts=true` (SEC-020 supply-chain
//   hardening) — npm therefore NEVER runs `preinstall`/`pretest` lifecycle
//   hooks, so wiring this guard through them would be silently dead. It is
//   instead invoked from four real enforcement points:
//     1. package.json `test` / `test:coverage` / `test:watch` scripts — an
//        explicit `node scripts/check-package-manager.mjs && vitest ...`
//        chain (explicit `npm run <script>` always executes the full
//        command line regardless of `ignore-scripts`).
//     2. `.husky/pre-commit` — a git-native hook, unaffected by npm's
//        `ignore-scripts` setting.
//     3. `.gitlab-ci.yml` `.node-setup` `before_script`, right after
//        `npm ci` — exercises the working-tree checks (w1/w2/w3) against a
//        real, freshly-installed `node_modules` in every node CI job.
//     4. `.gitlab-ci.yml` standalone `package-manager-guard` job — the
//        cheap committed-tree (c1/c2) invariant, with no `node_modules`
//        required.
//
// USAGE:
//   node scripts/check-package-manager.mjs [--allow-missing-node-modules] [--json] [--help] [--version]
//
// EXIT CODES:
//   0  clean — no guard violations (warnings, if any, printed to stderr)
//   1  guard violation — package-manager drift or committed-tree invariant broken
//   2  usage error — unknown CLI flag
//
// Node stdlib only — no third-party dependencies (keeps this script
// runnable from a git-native hook or a CI `before_script` without waiting
// on any dependency install).

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Defensive optional import — reuse the shared gitignore-aware helper when
// it is importable, but never let a moved/renamed lib break this script
// (it must keep working standalone).
// ---------------------------------------------------------------------------
let isIgnoredRootFileFn = null;
try {
  const mod = await import('./lib/package-manager.mjs');
  if (typeof mod.isIgnoredRootFile === 'function') {
    isIgnoredRootFileFn = mod.isIgnoredRootFile;
  }
} catch {
  isIgnoredRootFileFn = null;
}

function describeStrayLockfile(repoRoot) {
  if (typeof isIgnoredRootFileFn !== 'function') return '';
  try {
    return isIgnoredRootFileFn(repoRoot, 'pnpm-lock.yaml') ? ' (gitignored/untracked)' : '';
  } catch {
    return '';
  }
}

/**
 * Checks whether `fileName` is tracked by git in `repoRoot`.
 * @param {string} repoRoot
 * @param {string} fileName
 * @returns {boolean|null} true/false, or null when git itself is unavailable
 */
function isTrackedByGit(repoRoot, fileName) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', fileName], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.error) return null;
  return result.status === 0;
}

/**
 * Committed-tree invariant (c1/c2) — always checked, cheap (no node_modules
 * required). Source of truth is `git ls-files`, not the gitignored working
 * tree, so this also catches the case where a stray file were ever
 * force-added despite .gitignore.
 *
 * When git itself cannot be executed (e.g. not installed, not on PATH),
 * `isTrackedByGit` returns `null` for both probes — callers comparing
 * `=== true` / `=== false` would silently see zero findings and report
 * `ok: true`, even though the committed-tree invariant was never actually
 * verified. Surface that explicitly as a `c0` finding instead, mirroring the
 * w3 pattern: `severity: 'warn'` here, upgraded to `'error'` under CI by the
 * `effectiveSeverity` computation in `runPackageManagerGuard` (fail-closed —
 * CI without git is a broken guard, not a clean one). This is distinct from
 * "git ran but the file is untracked" (a normal non-zero exit with no
 * `result.error`), which keeps its existing c1/c2 semantics.
 * @param {string} repoRoot
 * @returns {Array<{code: string, severity: 'error'|'warn', message: string}>}
 */
export function checkCommittedTree(repoRoot) {
  const findings = [];

  const pnpmTracked = isTrackedByGit(repoRoot, 'pnpm-lock.yaml');
  const npmLockTracked = isTrackedByGit(repoRoot, 'package-lock.json');

  if (pnpmTracked === null || npmLockTracked === null) {
    findings.push({
      code: 'c0',
      severity: 'warn',
      message:
        'git unavailable — committed-tree invariants NOT verified (could not run `git ls-files` for pnpm-lock.yaml / package-lock.json).',
    });
    return findings;
  }

  if (pnpmTracked === true) {
    findings.push({
      code: 'c1',
      severity: 'error',
      message:
        'pnpm-lock.yaml is tracked in git — this repo is npm-canonical (package-lock.json is the committed lockfile). Untrack it: git rm --cached pnpm-lock.yaml',
    });
  }

  if (npmLockTracked === false) {
    findings.push({
      code: 'c2',
      severity: 'error',
      message:
        'package-lock.json is not tracked in git — required for this npm-canonical repo. Run: npm install && git add package-lock.json',
    });
  }

  return findings;
}

/**
 * Working-tree drift (w1/w2/w3). w1/w2 need an existing node_modules to
 * inspect — when it is absent (a clean checkout, or `npm ci`'s own
 * node_modules removal step running preinstall), there is nothing to detect
 * and both are silently skipped, regardless of `allowMissingNodeModules`.
 * The flag exists to make that skip explicit/documented at call sites (the
 * preinstall hook passes it) rather than to change the outcome.
 * @param {string} repoRoot
 * @param {{ allowMissingNodeModules?: boolean }} [opts]
 * @returns {Array<{code: string, severity: 'error'|'warn', message: string}>}
 */
export function checkWorkingTreeDrift(repoRoot, opts = {}) {
  const { allowMissingNodeModules = false } = opts;
  const findings = [];
  const remediation = 'Remediation: rm -rf node_modules pnpm-lock.yaml && npm ci';
  const nodeModulesPath = join(repoRoot, 'node_modules');
  const nodeModulesExists = existsSync(nodeModulesPath);

  if (nodeModulesExists) {
    // w1 — node_modules/.pnpm is pnpm's own dependency store; its presence
    // means node_modules was rewritten to a pnpm layout mid-install.
    if (existsSync(join(nodeModulesPath, '.pnpm'))) {
      findings.push({
        code: 'w1',
        severity: 'error',
        message: `node_modules/.pnpm exists — node_modules has a pnpm layout, not npm's. ${remediation}`,
      });
    }

    // w2 — pnpm hoists direct deps as symlinks into node_modules/<name>;
    // npm never does. vitest is a required devDependency, so it's a
    // reliable canary.
    try {
      const stat = lstatSync(join(nodeModulesPath, 'vitest'));
      if (stat.isSymbolicLink()) {
        findings.push({
          code: 'w2',
          severity: 'error',
          message: `node_modules/vitest is a symlink — node_modules has a pnpm layout, not npm's. ${remediation}`,
        });
      }
    } catch {
      // vitest absent entirely — a missing dependency is a different
      // problem (out of scope for a package-manager-layout check).
    }
  }
  // else: node_modules genuinely absent. Nothing to inspect for w1/w2 either
  // way — `allowMissingNodeModules` only documents the expectation at the
  // call site (preinstall), it does not change this outcome. This also
  // keeps the CI guard job (which never runs `npm ci`) green by design.
  void allowMissingNodeModules;

  // w3 — orphan stray lockfile, independent of node_modules layout. Warn
  // locally (a stray gitignored file with an otherwise-clean npm layout is
  // annoying but not actively broken); the caller upgrades this to an error
  // under CI.
  const strayLockfilePath = join(repoRoot, 'pnpm-lock.yaml');
  if (existsSync(strayLockfilePath) && existsSync(join(repoRoot, 'package-lock.json'))) {
    findings.push({
      code: 'w3',
      severity: 'warn',
      message: `root pnpm-lock.yaml exists alongside package-lock.json${describeStrayLockfile(repoRoot)}. ${remediation}`,
    });
  }

  return findings;
}

/**
 * Resolves the git repo root for `cwd`. Falls back to this script's own
 * parent directory (scripts/..) when git is unavailable or `cwd` is not
 * inside a git working tree.
 * @param {string} [cwd]
 * @returns {{ repoRoot: string, gitRoot: string|null }}
 */
export function resolveRepoRoot(cwd = process.cwd()) {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout) {
    return { repoRoot: resolve(SELF_DIR, '..'), gitRoot: null };
  }
  const gitRoot = result.stdout.trim();
  return { repoRoot: gitRoot, gitRoot };
}

/**
 * Robustly parses the `CI` environment variable as a boolean. `Boolean(x)`
 * is `true` for ANY non-empty string, including the literal string
 * `"false"` — a real hazard for `CI` since some platforms/tools export it
 * as the string `"false"` when CI is not actually active. Treat `CI` as
 * true only when it is set to a value other than "", "0", "false", or "no"
 * (case-insensitive).
 * @param {string|undefined} value — raw `process.env.CI` value
 * @returns {boolean}
 */
export function parseCiEnv(value) {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return !['', '0', 'false', 'no'].includes(normalized);
}

/**
 * Runs the full guard and returns a plain-object result. Pure(ish) — the
 * only side effects are read-only fs/git calls. Never throws or exits.
 * @param {{ cwd?: string, ci?: boolean, allowMissingNodeModules?: boolean, repoRoot?: string }} [opts]
 * @returns {{ ok: boolean, ci: boolean, skipped: boolean, repoRoot: string, findings: Array<{code: string, severity: string, effectiveSeverity: string, message: string}> }}
 */
export function runPackageManagerGuard(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const ci = opts.ci ?? parseCiEnv(process.env.CI);
  const allowMissingNodeModules = opts.allowMissingNodeModules ?? false;

  let repoRoot = opts.repoRoot;
  let gitRoot = repoRoot ?? null;
  if (!repoRoot) {
    const resolved = resolveRepoRoot(cwd);
    repoRoot = resolved.repoRoot;
    gitRoot = resolved.gitRoot;
  }

  // Non-root cwd guard (see header § SCOPE GUARD).
  if (gitRoot && resolve(cwd) !== resolve(gitRoot) && existsSync(join(cwd, 'package.json'))) {
    return { ok: true, ci, skipped: true, repoRoot: gitRoot, findings: [] };
  }

  const raw = [
    ...checkCommittedTree(repoRoot),
    ...checkWorkingTreeDrift(repoRoot, { allowMissingNodeModules }),
  ];

  const findings = raw.map((f) => ({
    ...f,
    effectiveSeverity: f.severity === 'warn' && ci ? 'error' : f.severity,
  }));

  const ok = !findings.some((f) => f.effectiveSeverity === 'error');

  return { ok, ci, skipped: false, repoRoot, findings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `check-package-manager.mjs — package-manager recurrence guard (issue #715)

USAGE
  node scripts/check-package-manager.mjs [options]

DESCRIPTION
  Verifies this repo's committed lockfile matches its ACTUAL working-tree and
  node_modules layout. This repo is npm-canonical (package-lock.json is the
  committed lockfile) — a bare \`pnpm install\` at the repo root silently
  rewrites node_modules to a pnpm layout mid-\`npm test\`, producing a
  confusing ERR_MODULE_NOT_FOUND failure.

CHECKS
  Working-tree drift (w1/w2 skipped when node_modules does not exist yet):
    w1  node_modules/.pnpm exists (pnpm's own dependency store)
    w2  node_modules/vitest is a symlink (pnpm hoisting signature)
    w3  a stray root pnpm-lock.yaml sits alongside package-lock.json
        (warn locally; upgraded to a hard failure under CI)
  Committed-tree invariant (always checked, via \`git ls-files\`):
    c0  git itself is unavailable — invariants below NOT verified
        (warn locally; upgraded to a hard failure under CI, fail-closed)
    c1  pnpm-lock.yaml must NOT be tracked in git
    c2  package-lock.json MUST be tracked in git

OPTIONS
  --allow-missing-node-modules  Document that node_modules may not exist yet
                                 at the call site (e.g. a manual invocation
                                 before \`npm install\`). w1/w2 are skipped
                                 whenever node_modules is absent regardless
                                 of this flag — it only documents intent.
  --json                        Emit a single JSON result object to stdout.
  --help, -h                    Show this help and exit.
  --version                     Print the package version and exit.

EXIT CODES
  0  clean — no guard violations (warnings, if any, on stderr)
  1  guard violation — package-manager drift or committed-tree invariant broken
  2  usage error — unknown CLI flag

SCOPE
  This script only guards the repository root. When invoked from a nested
  package directory (its own package.json, different from the git root), it
  exits 0 silently.
`;

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(SELF_DIR, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const opts = { json: false, help: false, version: false, allowMissingNodeModules: false };
  const unknown = [];
  for (const arg of argv) {
    switch (arg) {
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
        opts.version = true;
        break;
      case '--allow-missing-node-modules':
        opts.allowMissingNodeModules = true;
        break;
      default:
        unknown.push(arg);
    }
  }
  return { opts, unknown };
}

// CLI entry — only when run directly, not when imported (e.g. by tests).
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const { opts, unknown } = parseArgs(process.argv.slice(2));

  if (unknown.length > 0) {
    console.error(`[check-package-manager] unknown flag(s): ${unknown.join(', ')}`);
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  if (opts.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (opts.version) {
    console.log(readVersion());
    process.exit(0);
  }

  const result = runPackageManagerGuard({ allowMissingNodeModules: opts.allowMissingNodeModules });

  if (opts.json) {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : 1);
  }

  if (result.skipped) {
    console.log(
      `[check-package-manager] cwd is not the repo root (nested package.json) — skipping (repo root: ${result.repoRoot})`,
    );
    process.exit(0);
  }

  const errors = result.findings.filter((f) => f.effectiveSeverity === 'error');
  const warnings = result.findings.filter((f) => f.effectiveSeverity === 'warn');

  for (const w of warnings) {
    console.error(`[check-package-manager] WARN (${w.code}): ${w.message}`);
  }
  for (const e of errors) {
    console.error(`[check-package-manager] FAIL (${e.code}): ${e.message}`);
  }

  if (errors.length === 0) {
    const suffix = warnings.length > 0 ? ` (${warnings.length} warning(s))` : '';
    console.log(`[check-package-manager] OK — package manager is consistent (npm-canonical)${suffix}`);
    process.exit(0);
  }

  console.error(`[check-package-manager] FAIL-CLOSED: ${errors.length} guard violation(s) — see above`);
  process.exit(1);
}
