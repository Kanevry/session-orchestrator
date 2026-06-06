// bootstrap-baseline-fetch-bridge.test.mjs — Regression guard for #618.
//
// #618: the bootstrap on-demand baseline-fetch bridge (S99/D99) was gated on a
// `-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.sh"` guard, but the plugin only
// ships `fetch-baseline.mjs`. The guard was always false → the bridge was dead
// code that silently never fetched. Wave 2 flipped every bootstrap guard/ref to
// `.mjs`, removed the dead `source`/shell-function calls, and plumbed
// `GITLAB_HOST` from the `gitlab-host` Session Config key.
//
// This suite pins the fixed state by reading the actual bootstrap files at test
// time and asserting concrete occurrence counts — so a future re-rename (or a
// stray `.sh` reference) fails here instead of shipping a silent dead bridge.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const bootstrapDir = path.join(repoRoot, 'skills', 'bootstrap');

// The bootstrap files that participate in (or document) the baseline-fetch
// bridge. Each is read fresh from disk so the test reflects current source.
const BOOTSTRAP_FILE_NAMES = [
  '_shared-template.md',
  'SKILL.md',
  'standard-template.md',
  'deep-template.md',
];

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Read a bootstrap file's body (asserts it exists first). */
function readBootstrap(name) {
  const full = path.join(bootstrapDir, name);
  expect(existsSync(full), `expected bootstrap file to exist: ${full}`).toBe(true);
  return readFileSync(full, 'utf8');
}

describe('bootstrap baseline-fetch bridge (#618 regression guard)', () => {
  // ── 1. No `fetch-baseline.sh` anywhere in the bootstrap surface ──────────
  describe('no stale fetch-baseline.sh reference', () => {
    it.each(BOOTSTRAP_FILE_NAMES)(
      '%s contains zero occurrences of "fetch-baseline.sh"',
      (name) => {
        const body = readBootstrap(name);
        expect(countOccurrences(body, 'fetch-baseline.sh')).toBe(0);
      },
    );
  });

  // ── 2. No dead shell-function names ──────────────────────────────────────
  describe('no dead shell-function references', () => {
    const DEAD_FUNCTIONS = [
      'fetch_baseline_file',
      'fetch_baseline_files_batch',
      'write_baseline_fetch_lock',
    ];

    it.each(DEAD_FUNCTIONS)(
      'no bootstrap file references the removed shell function "%s"',
      (fn) => {
        let total = 0;
        for (const name of BOOTSTRAP_FILE_NAMES) {
          total += countOccurrences(readBootstrap(name), fn);
        }
        expect(total).toBe(0);
      },
    );
  });

  // ── 3. The .mjs fetcher the guard checks for actually exists ─────────────
  it('scripts/lib/fetch-baseline.mjs exists (the guarded bridge target)', () => {
    const target = path.join(repoRoot, 'scripts', 'lib', 'fetch-baseline.mjs');
    expect(existsSync(target)).toBe(true);
  });

  it('_shared-template.md guards on the .mjs path (not the removed .sh)', () => {
    const body = readBootstrap('_shared-template.md');
    // Exactly one `-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs"` guard.
    expect(
      countOccurrences(body, '-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs"'),
    ).toBe(1);
  });

  // ── 4. Host plumbing — gitlab-host Session Config key → GITLAB_HOST env ──
  describe('GITLAB_HOST plumbing from gitlab-host Session Config key', () => {
    it('_shared-template.md reads the "gitlab-host" Session Config key', () => {
      const body = readBootstrap('_shared-template.md');
      expect(countOccurrences(body, 'gitlab-host')).toBeGreaterThanOrEqual(1);
    });

    it('_shared-template.md exports/uses GITLAB_HOST', () => {
      const body = readBootstrap('_shared-template.md');
      expect(countOccurrences(body, 'GITLAB_HOST')).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 5. No private-host leak in the bootstrap surface ─────────────────────
  describe('no private-host leak', () => {
    it.each(BOOTSTRAP_FILE_NAMES)(
      '%s contains zero occurrences of "gotzendorfer"',
      (name) => {
        const body = readBootstrap(name);
        expect(countOccurrences(body, 'gotzendorfer')).toBe(0);
      },
    );

    it.each(BOOTSTRAP_FILE_NAMES)(
      '%s contains zero occurrences of "DEFAULT_GITLAB_HOST"',
      (name) => {
        const body = readBootstrap(name);
        expect(countOccurrences(body, 'DEFAULT_GITLAB_HOST')).toBe(0);
      },
    );
  });
});
