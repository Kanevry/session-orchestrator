/**
 * tests/lib/locks/index-shim.test.mjs
 *
 * Unit tests for scripts/lib/locks/index.mjs — the DEPRECATED re-export barrel
 * restored in 5.2.0 as a one-cycle migration shim (removed in 6.0.0; see the
 * module's own docblock and `.claude/rules/development.md` § Package Lifecycle
 * & Versioning).
 *
 * The nameable bug this file exists to catch: a future edit drops one of the
 * 12 public names the v5.1.0 barrel shipped, or turns the shim into a NAMED
 * export barrel — which would make `check-unwired-features.mjs` S4 report it
 * as an `unreachable-library-module` again (the exact reason it was deleted in
 * dd05e0f8) — and nobody notices until a consumer's deep import breaks.
 *
 * Platform-pin discipline: the import + deprecation-warning assertions run in
 * a REAL node child (`spawnSync`), never in-process — vitest's in-process
 * module resolution does not reproduce Node's own module-not-found/import
 * behaviour faithfully for this kind of pin.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Portable repo root — matches the convention in sibling lock tests
// (tests/lib/backlog-scan.test.mjs, tests/lib/git-config-drift.test.mjs, …):
// vitest always runs with cwd at the repo root.
const repoRoot = process.cwd();
const SHIM_PATH = path.join(repoRoot, 'scripts', 'lib', 'locks', 'index.mjs');

// The exact 12 names the v5.1.0 barrel re-exported (git show v5.1.0:scripts/lib/locks/index.mjs,
// re-verified 2026-09-17 @ 9e8146b4 against the live state-md-lock.mjs / staging-fence-lock.mjs).
const EXPECTED_NAMES = Object.freeze([
  'STATE_LOCK_PATH',
  'DEFAULT_STATE_LOCK_TIMEOUT_MS',
  'STATE_LOCK_POLL_MS',
  'acquireStateLock',
  'releaseStateLock',
  'withStateMdLock',
  'STAGING_FENCE_LOCK_PATH',
  'DEFAULT_STAGING_FENCE_LOCK_TIMEOUT_MS',
  'STAGING_FENCE_LOCK_POLL_MS',
  'acquireStagingFenceLock',
  'releaseStagingFenceLock',
  'withStagingFenceLock',
]);

const DEPRECATION_MARKER = 'scripts/lib/locks/index.mjs is deprecated since 5.2.0';

/**
 * Import the shim in a real node child process and report which of the
 * expected names resolved to a defined value.
 *
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function importShimInChild() {
  const script = `
    import * as shim from ${JSON.stringify(pathToFileURL(SHIM_PATH).href)};
    const defined = ${JSON.stringify(EXPECTED_NAMES)}.filter((name) => typeof shim[name] !== 'undefined');
    console.log(JSON.stringify({ defined, allKeys: Object.keys(shim).sort() }));
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
}

describe('locks/index.mjs — deprecation shim', () => {
  it('re-exports all 12 v5.1.0 names and warns once on stderr, in a real node child', () => {
    const result = importShimInChild();

    expect(result.status).toBe(0);

    const stdout = JSON.parse(result.stdout.trim());
    expect(stdout.defined.sort()).toEqual([...EXPECTED_NAMES].sort());

    const markerOccurrences = result.stderr.split(DEPRECATION_MARKER).length - 1;
    expect(markerOccurrences).toBe(1);
  });

  it('carries zero named exports — stays invisible to check-unwired-features S4 census', () => {
    const source = readFileSync(SHIM_PATH, 'utf8');

    // Same grammar collectExportedSymbols() in check-unwired-features.mjs uses:
    // a named export declaration or an `export { ... }` clause. Neither may
    // appear — only `export * from '...'` re-exports are allowed.
    expect(source).not.toMatch(/^export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+[A-Za-z0-9_$]+/m);
    expect(source).not.toMatch(/^export\s*\{/m);

    // The two re-export targets must still be present in the `export *` form.
    expect(source).toMatch(/^export\s+\*\s+from\s+['"]\.\/state-md-lock\.mjs['"];?\s*$/m);
    expect(source).toMatch(/^export\s+\*\s+from\s+['"]\.\/staging-fence-lock\.mjs['"];?\s*$/m);
  });
});
