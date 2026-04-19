/**
 * Package-manager detection for Node.js repos (issue #183).
 *
 * Consumed by bootstrap when generating .orchestrator/policy/quality-gates.json
 * to pick sensible default test/typecheck/lint commands.
 *
 * Detection is lockfile-based and synchronous. Returns null when no lockfile
 * is present.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Detects the package manager used in the given repo.
 *
 * @param {string} repoRoot - absolute path to the repo root
 * @returns {"pnpm"|"yarn"|"bun"|"npm"|null}
 */
export function detectPackageManager(repoRoot) {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(join(repoRoot, 'package-lock.json'))) return 'npm';
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
