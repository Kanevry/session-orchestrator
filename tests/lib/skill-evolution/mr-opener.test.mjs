/**
 * mr-opener.test.mjs — Unit tests for openRepairMr + detectAddedPackages
 * (Epic #643 / issue #647 C2 auto-repair engine).
 *
 * openRepairMr fans out across injectable seams (git, leakageScan, slopcheck,
 * vcsDetect, createMr, writeFile, log). Every test exercises the REAL
 * openRepairMr and asserts on the returned { ok, action, mrUrl?, reason?, gate }
 * envelope — the seams only stand in for git/glab/subprocess (BE-012: no test
 * merely verifies a mock was configured). NEVER runs real git/glab.
 */

import { describe, it, expect, vi } from 'vitest';
import { openRepairMr, detectAddedPackages } from '@lib/skill-evolution/mr-opener.mjs';

const REPO = '/tmp/fake-repo';

/** A well-formed MR-tier candidate whose derived branch/title pass validation. */
const CANDIDATE = {
  id: 'abc123',
  target_path: 'skills/foo/SKILL.md',
  proposed_change: 'tighten the foo guardrail',
  source_ref: '#647',
};

/** A prose-only diff (no package adds → slopcheck skipped). */
const PROSE_DIFF = {
  content: 'new skill body\n',
  raw: '+++ skills/foo/SKILL.md\n+new skill body\n',
};

/** A git seam that resolves every call (checkout/add/commit/push) with empty stdout. */
function makeGit() {
  return vi.fn(async () => ({ stdout: '' }));
}

/** A leakage seam returning clean (no leak). */
const leakClean = async () => ({ ok: true, exitCode: 0 });

/** A createMr seam returning a freshly-created MR with a URL. */
const createMrOk = async () => ({ created: true, mrUrl: 'https://gitlab.example/mr/1' });

describe('openRepairMr — dry-run path', () => {
  it('returns advisory with a dry-run reason and never calls git/createMr seams', async () => {
    const git = makeGit();
    const createMr = vi.fn(createMrOk);

    const result = await openRepairMr(
      { candidate: CANDIDATE, diff: PROSE_DIFF, repoRoot: REPO, dryRun: true, vcs: 'gitlab' },
      { git, createMr, leakageScan: leakClean },
    );

    expect(result).toEqual({
      ok: true,
      action: 'advisory',
      reason: 'dry-run preview — no MR opened',
      gate: { ownerLeakage: 'pass' },
    });
    expect(git).not.toHaveBeenCalled();
    expect(createMr).not.toHaveBeenCalled();
  });
});

describe('openRepairMr — owner-leakage gate', () => {
  it('returns blocked with gate.ownerLeakage:fail when the leakage scan detects a leak', async () => {
    const result = await openRepairMr(
      { candidate: CANDIDATE, diff: PROSE_DIFF, repoRoot: REPO, vcs: 'gitlab' },
      {
        git: makeGit(),
        leakageScan: async () => ({ ok: false, exitCode: 1 }),
        createMr: createMrOk,
        writeFile: async () => {},
      },
    );

    expect(result.ok).toBe(false);
    expect(result.action).toBe('blocked');
    expect(result.reason).toBe('owner-leakage detected');
    expect(result.gate).toEqual({ ownerLeakage: 'fail' });
  });

  it('does not open an MR when leakage gate blocks (createMr seam untouched)', async () => {
    const createMr = vi.fn(createMrOk);
    const result = await openRepairMr(
      { candidate: CANDIDATE, diff: PROSE_DIFF, repoRoot: REPO, vcs: 'gitlab' },
      {
        git: makeGit(),
        leakageScan: async () => ({ ok: false, exitCode: 1 }),
        createMr,
        writeFile: async () => {},
      },
    );

    expect(result.action).toBe('blocked');
    expect(createMr).not.toHaveBeenCalled();
  });
});

describe('openRepairMr — happy path', () => {
  it('returns mr-opened with the MR url and gate.slopcheck:skipped for a prose diff', async () => {
    const result = await openRepairMr(
      { candidate: CANDIDATE, diff: PROSE_DIFF, repoRoot: REPO, vcs: 'gitlab' },
      {
        git: makeGit(),
        leakageScan: leakClean,
        createMr: createMrOk,
        // writeFile seam stubbed so no real FS write happens for content diffs.
        writeFile: async () => {},
      },
    );

    expect(result).toEqual({
      ok: true,
      action: 'mr-opened',
      mrUrl: 'https://gitlab.example/mr/1',
      gate: { ownerLeakage: 'pass', slopcheck: 'skipped' },
    });
  });
});

describe('openRepairMr — target_path escape guard (R5)', () => {
  it('blocks and does not write when a content-diff target_path escapes the repo', async () => {
    const writeFile = vi.fn(async () => {});
    const result = await openRepairMr(
      {
        candidate: { ...CANDIDATE, target_path: '../escape.md' },
        diff: { content: 'pwned\n', raw: '+pwned\n' },
        repoRoot: REPO,
        vcs: 'gitlab',
      },
      { git: makeGit(), leakageScan: leakClean, createMr: createMrOk, writeFile },
    );

    expect(result.ok).toBe(false);
    expect(result.action).toBe('blocked');
    expect(result.reason).toBe('target_path escapes repo');
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe('openRepairMr — no VCS available', () => {
  it('returns advisory when vcsDetect finds neither glab nor gh', async () => {
    const createMr = vi.fn(createMrOk);
    const result = await openRepairMr(
      // No explicit vcs arg → auto-detection runs via the seam.
      { candidate: CANDIDATE, diff: PROSE_DIFF, repoRoot: REPO },
      {
        git: makeGit(),
        leakageScan: leakClean,
        createMr,
        vcsDetect: () => ({ bin: null }),
      },
    );

    expect(result.ok).toBe(true);
    expect(result.action).toBe('advisory');
    expect(result.reason).toBe('glab/gh not installed — advisory only');
    expect(createMr).not.toHaveBeenCalled();
  });
});

describe('openRepairMr — slopcheck gate', () => {
  it('returns blocked with gate.slopcheck:fail when an added package classifies SLOP', async () => {
    const pkgDiff = {
      content: undefined,
      raw: '+++ b/package.json\n+    "left-pad-typosquat": "^1.0.0"\n',
    };
    const slopcheck = vi.fn(async () => [
      { name: 'left-pad-typosquat', classification: 'SLOP' },
    ]);

    const result = await openRepairMr(
      { candidate: CANDIDATE, diff: pkgDiff, repoRoot: REPO, vcs: 'gitlab' },
      {
        git: makeGit(),
        leakageScan: leakClean,
        slopcheck,
        createMr: createMrOk,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.action).toBe('blocked');
    expect(result.reason).toBe('slop package');
    expect(result.gate).toEqual({ ownerLeakage: 'pass', slopcheck: 'fail' });
    // SUT must have actually fed the detected package to the slopcheck seam.
    expect(slopcheck).toHaveBeenCalledWith(
      [{ name: 'left-pad-typosquat', registry: 'npm' }],
      { repoRoot: REPO },
    );
  });
});

describe('detectAddedPackages', () => {
  it('returns the added npm dependency from a package.json diff', () => {
    const diff = '+++ b/package.json\n+    "lodash": "^4.17.21"\n';
    expect(detectAddedPackages(diff)).toEqual([{ name: 'lodash', registry: 'npm' }]);
  });

  it('returns an empty array for a prose-only SKILL.md diff', () => {
    const diff = '+++ b/skills/foo/SKILL.md\n+This is a new guardrail sentence.\n';
    expect(detectAddedPackages(diff)).toEqual([]);
  });

  it('returns an empty array for non-string input', () => {
    expect(detectAddedPackages(undefined)).toEqual([]);
  });
});
