/**
 * package-manager-detector.mjs — detects package manager from lockfile presence
 * and reads package.json script names for informational surfacing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Detects package manager from lockfile presence.
 * @param {string} repoRoot
 * @returns {'pnpm' | 'yarn' | 'bun' | 'npm' | null}
 */
export function detectPackageManagerFromRoot(repoRoot) {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(join(repoRoot, 'package-lock.json'))) return 'npm';
  return null;
}

/**
 * Reads package.json scripts to surface script names (informational).
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function readPackageScripts(repoRoot) {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return Object.keys(pkg.scripts || {});
  } catch {
    return [];
  }
}
