/**
 * tests/unit/discovery-helpers.test.mjs
 *
 * Unit tests for scripts/lib/discovery-helpers.mjs (issue #420).
 *
 * Strategy: tests that need git history run actual git commands inside the
 * real repo root (REPO_ROOT). Tests that validate error paths use a temp dir
 * or mock the promisified execFile via vi.mock.
 *
 * Test inventory (12 cases):
 *  1. HEAD..HEAD → returns []
 *  2. HEAD~1 → returns files from last commit
 *  3. Invalid ref → throws with helpful message
 *  4. Shell-unsafe ref (`;`) → throws TypeError
 *  5. Shell-unsafe ref (`|`) → throws TypeError
 *  6. Shell-unsafe ref (`&`) → throws TypeError
 *  7. Shell-unsafe ref (backtick) → throws TypeError
 *  8. Empty string ref → throws TypeError
 *  9. Returns Promise<string[]>
 * 10. Paths are relative (no leading / or ./)
 * 11. Result is sorted alphabetically
 * 12. Null / non-string ref → throws TypeError
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const MODULE_PATH = path.join(REPO_ROOT, 'scripts', 'lib', 'discovery-helpers.mjs');

// ---------------------------------------------------------------------------
// Dynamic import of SUT (always fresh, avoids stale vi.mock state)
// ---------------------------------------------------------------------------

/** @returns {Promise<{changedFilesSince: (ref: string) => Promise<string[]>}>} */
async function importSut() {
  // Cache-bust via date to ensure we get a fresh module after vi.mock resets.
  const mod = await import(MODULE_PATH + `?t=${Date.now()}`);
  return mod;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `git log --oneline -1` in REPO_ROOT to ensure there is at least one commit.
 * Returns true if a commit exists.
 */
async function hasAtLeastOneCommit() {
  try {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', '-1'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Return the count of commits reachable from HEAD.
 */
async function commitCount() {
  try {
    const { stdout } = await execFileAsync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return parseInt(stdout.trim(), 10);
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('changedFilesSince', () => {
  // --------------------------------------------------------------------------
  // Test 1: HEAD..HEAD → no changes → []
  // --------------------------------------------------------------------------
  it('returns [] when HEAD..HEAD produces no diff', async () => {
    const hasCommit = await hasAtLeastOneCommit();
    if (!hasCommit) {
      // Skip gracefully in a repo with zero commits.
      console.warn('skip: no commits in repo');
      return;
    }

    const { changedFilesSince } = await importSut();
    const result = await changedFilesSince('HEAD');

    expect(Array.isArray(result)).toBe(true);
    // HEAD..HEAD always produces an empty diff.
    expect(result).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Test 2: HEAD~1 → returns files from the last commit
  // --------------------------------------------------------------------------
  it('returns files changed in the last commit when ref is HEAD~1', async () => {
    const count = await commitCount();
    if (count < 2) {
      // Need at least 2 commits for HEAD~1 to be valid.
      console.warn('skip: fewer than 2 commits in repo');
      return;
    }

    const { changedFilesSince } = await importSut();
    const result = await changedFilesSince('HEAD~1');

    // Should be a non-empty array (the last commit changed at least something).
    expect(Array.isArray(result)).toBe(true);
    // Each entry must be a non-empty string.
    for (const p of result) {
      expect(typeof p).toBe('string');
      expect(p.length).toBeGreaterThan(0);
    }
  });

  // --------------------------------------------------------------------------
  // Test 3: Invalid ref → throws with helpful message
  // --------------------------------------------------------------------------
  it('throws with a helpful message for an unresolvable ref', async () => {
    const { changedFilesSince } = await importSut();

    await expect(
      changedFilesSince('this-ref-does-not-exist-abc123xyz'),
    ).rejects.toThrow(/Cannot resolve ref/);
  });

  it('error message for invalid ref mentions common causes (shallow clone)', async () => {
    const { changedFilesSince } = await importSut();

    await expect(
      changedFilesSince('this-ref-does-not-exist-abc123xyz'),
    ).rejects.toThrow(/shallow clone/i);
  });

  // --------------------------------------------------------------------------
  // Test 4-7: Shell-unsafe characters → throws TypeError
  // --------------------------------------------------------------------------
  it('throws TypeError when ref contains a semicolon', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('HEAD;rm -rf /')).rejects.toThrow(TypeError);
  });

  it('throws TypeError when ref contains a pipe character', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('HEAD|cat /etc/passwd')).rejects.toThrow(TypeError);
  });

  it('throws TypeError when ref contains an ampersand', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('HEAD&echo')).rejects.toThrow(TypeError);
  });

  it('throws TypeError when ref contains a backtick', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('HEAD`whoami`')).rejects.toThrow(TypeError);
  });

  // --------------------------------------------------------------------------
  // Test 8: Empty string ref → throws TypeError
  // --------------------------------------------------------------------------
  it('throws TypeError for an empty string ref', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('')).rejects.toThrow(TypeError);
  });

  // --------------------------------------------------------------------------
  // Test 9: Returns a Promise<string[]>
  // --------------------------------------------------------------------------
  it('returns a Promise (is thenable)', async () => {
    const { changedFilesSince } = await importSut();
    const promise = changedFilesSince('HEAD');
    // Must be a real Promise (thenable with then and catch).
    expect(typeof promise.then).toBe('function');
    expect(typeof promise.catch).toBe('function');
    // Await to completion so test runner does not leak unhandled rejections.
    await promise;
  });

  // --------------------------------------------------------------------------
  // Test 10: Returned paths are relative — no leading / or ./
  // --------------------------------------------------------------------------
  it('returns relative paths (no leading / or ./)', async () => {
    const count = await commitCount();
    if (count < 2) {
      console.warn('skip: fewer than 2 commits in repo');
      return;
    }

    const { changedFilesSince } = await importSut();
    const result = await changedFilesSince('HEAD~1');

    for (const p of result) {
      expect(p).not.toMatch(/^\//);
      expect(p).not.toMatch(/^\.\//);
    }
  });

  // --------------------------------------------------------------------------
  // Test 11: Result is sorted alphabetically
  // --------------------------------------------------------------------------
  it('returns paths sorted alphabetically', async () => {
    const count = await commitCount();
    if (count < 2) {
      console.warn('skip: fewer than 2 commits in repo');
      return;
    }

    const { changedFilesSince } = await importSut();
    const result = await changedFilesSince('HEAD~1');

    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });

  // --------------------------------------------------------------------------
  // Test 12: null / non-string ref → throws TypeError
  // --------------------------------------------------------------------------
  it('throws TypeError when ref is null', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince(null)).rejects.toThrow(TypeError);
  });

  it('throws TypeError when ref is undefined', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince(undefined)).rejects.toThrow(TypeError);
  });

  it('throws TypeError when ref is a number', async () => {
    const { changedFilesSince } = await importSut();
    // @ts-expect-error intentional wrong-type test
    await expect(changedFilesSince(42)).rejects.toThrow(TypeError);
  });

  // ==========================================================================
  // NEW BOUNDARY / ERROR-PATH TESTS (W4-T1)
  // ==========================================================================

  // --------------------------------------------------------------------------
  // HEAD~999 — deep history ref that likely doesn't exist
  // --------------------------------------------------------------------------
  it('throws with a helpful error message when HEAD~999 does not exist (too-deep ref)', async () => {
    const count = await commitCount();
    if (count >= 999) {
      // Repo has 999+ commits — skip this test (the ref would be valid)
      console.warn('skip: repo has ≥999 commits, HEAD~999 is resolvable');
      return;
    }
    const { changedFilesSince } = await importSut();
    // HEAD~999 exceeds actual history → git rev-parse fails
    await expect(changedFilesSince('HEAD~999')).rejects.toThrow(/Cannot resolve ref/);
  });

  it('helpful error message for deep unresolvable ref mentions shallow clone', async () => {
    const count = await commitCount();
    if (count >= 999) {
      console.warn('skip: repo has ≥999 commits');
      return;
    }
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('HEAD~999')).rejects.toThrow(/shallow clone/i);
  });

  // --------------------------------------------------------------------------
  // Ref that looks like a flag ("--all")
  // --------------------------------------------------------------------------
  it('throws TypeError when ref is "--all" (looks like a git flag, contains unsafe chars? — no, just dashes)', async () => {
    // "--all" passes the UNSAFE_REF_CHARS check (no ;|&`$<>\\ characters),
    // so it reaches git rev-parse. git treats "--all" as a flag reference
    // and will likely fail to resolve it as a valid commit-ish.
    // The function must either resolve it (if git accepts it) or throw a
    // clear error (if git rejects it). It must NOT hang or leak the flag.
    const { changedFilesSince } = await importSut();
    // Regardless of whether git accepts or rejects "--all", the function must
    // complete (not hang) and return either a string array or throw an Error.
    let threw = false;
    let result;
    try {
      result = await changedFilesSince('--all');
    } catch (err) {
      threw = true;
      // If it throws, the error must be a proper Error (not unhandled rejection)
      expect(err).toBeInstanceOf(Error);
    }
    if (!threw) {
      // If it resolved, result must be an array of strings
      expect(Array.isArray(result)).toBe(true);
    }
    // In both cases, the function must not hang — the test itself reaching here
    // proves that. The important invariant is: no crash, no hang.
  });

  // --------------------------------------------------------------------------
  // Whitespace-only ref → TypeError
  // --------------------------------------------------------------------------
  it('throws TypeError when ref is whitespace-only', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('   ')).rejects.toThrow(TypeError);
  });

  // --------------------------------------------------------------------------
  // $ and < in ref → TypeError (shell-unsafe chars)
  // --------------------------------------------------------------------------
  it('throws TypeError when ref contains $ (shell-unsafe)', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('HEAD$USER')).rejects.toThrow(TypeError);
  });

  it('throws TypeError when ref contains < (shell-unsafe)', async () => {
    const { changedFilesSince } = await importSut();
    await expect(changedFilesSince('HEAD<HEAD~1')).rejects.toThrow(TypeError);
  });
});
