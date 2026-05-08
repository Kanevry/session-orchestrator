/**
 * ci-detector.mjs — detects CI provider from repo structure.
 * Checks for .gitlab-ci.yml (GitLab) or .github/workflows/ (GitHub).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Detects CI provider from repo structure.
 * @param {string} repoRoot
 * @returns {'gitlab' | 'github' | 'none'}
 */
export function detectCiProvider(repoRoot) {
  if (existsSync(join(repoRoot, '.gitlab-ci.yml'))) return 'gitlab';
  if (existsSync(join(repoRoot, '.github', 'workflows'))) return 'github';
  return 'none';
}
