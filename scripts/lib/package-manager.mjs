/**
 * Package-manager detection for Node.js repos (issue #183).
 *
 * Consumed by bootstrap when generating .orchestrator/policy/quality-gates.json
 * to pick sensible default test/typecheck/lint commands.
 *
 * Detection is synchronous. An explicit package.json packageManager field wins;
 * otherwise, root lockfiles are considered when they are not explicitly ignored
 * by the repo's root .gitignore.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGE_MANAGERS = new Set(['pnpm', 'yarn', 'bun', 'npm']);

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
];

function packageManagerFromPackageJson(repoRoot) {
  const path = join(repoRoot, 'package.json');
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const value = parsed.packageManager;
    if (typeof value !== 'string') return null;

    const name = value.split('@')[0];
    return PACKAGE_MANAGERS.has(name) ? name : null;
  } catch {
    return null;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function gitignorePatternMatchesRootFile(pattern, fileName) {
  let normalized = pattern.trim();
  if (!normalized || normalized.startsWith('#') || normalized.endsWith('/')) {
    return false;
  }

  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  if (normalized.includes('/')) {
    return normalized === fileName;
  }

  if (normalized.includes('*') || normalized.includes('?')) {
    const source = normalized
      .split('*')
      .map((part) => part.split('?').map(escapeRegExp).join('.'))
      .join('.*');
    return new RegExp(`^${source}$`).test(fileName);
  }

  return normalized === fileName;
}

/**
 * Returns true when `fileName` sits at the repo root AND is matched
 * (non-negated) by a pattern in the repo's root `.gitignore`.
 *
 * Shared by sibling package-manager detectors (ecosystem-wizard's
 * detectPackageManagerFromRoot, quality-gates-cache's computeDependencyHash)
 * so a gitignored root lockfile is treated as absent everywhere, not just
 * in detectPackageManager() below (issue #715 bug class).
 *
 * @param {string} repoRoot - absolute path to the repo root
 * @param {string} fileName - root-level file name to test (e.g. "pnpm-lock.yaml")
 * @returns {boolean}
 */
export function isIgnoredRootFile(repoRoot, fileName) {
  const path = join(repoRoot, '.gitignore');
  if (!existsSync(path)) return false;

  let ignored = false;
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const negated = line.startsWith('!');
      const pattern = negated ? line.slice(1) : line;
      if (gitignorePatternMatchesRootFile(pattern, fileName)) {
        ignored = !negated;
      }
    }
  } catch {
    return false;
  }

  return ignored;
}

/**
 * Detects the package manager used in the given repo.
 *
 * @param {string} repoRoot - absolute path to the repo root
 * @returns {"pnpm"|"yarn"|"bun"|"npm"|null}
 */
export function detectPackageManager(repoRoot) {
  const explicit = packageManagerFromPackageJson(repoRoot);
  if (explicit) return explicit;

  for (const [lockfile, packageManager] of LOCKFILES) {
    if (
      existsSync(join(repoRoot, lockfile)) &&
      !isIgnoredRootFile(repoRoot, lockfile)
    ) {
      return packageManager;
    }
  }

  return null;
}

const COMMANDS = {
  pnpm: {
    test: { command: 'pnpm test --run', required: true },
    typecheck: { command: 'pnpm typecheck', required: true },
    lint: { command: 'pnpm lint', required: true },
  },
  npm: {
    test: { command: 'npm test', required: true },
    typecheck: { command: 'npm run typecheck', required: true },
    lint: { command: 'npm run lint', required: true },
  },
  yarn: {
    test: { command: 'yarn test', required: true },
    typecheck: { command: 'yarn typecheck', required: true },
    lint: { command: 'yarn lint', required: true },
  },
  bun: {
    test: { command: 'bun test', required: true },
    typecheck: { command: 'bun run typecheck', required: true },
    lint: { command: 'bun run lint', required: true },
  },
};

/**
 * Returns the default quality-gate commands for a package manager.
 * Unknown / null → npm defaults (most portable).
 *
 * @param {"pnpm"|"yarn"|"bun"|"npm"|null|undefined} packageManager
 * @returns {{test: {command: string, required: boolean}, typecheck: {command: string, required: boolean}, lint: {command: string, required: boolean}}}
 */
export function defaultQualityGateCommands(packageManager) {
  return COMMANDS[packageManager] || COMMANDS.npm;
}
