/**
 * expand-home.test.mjs — regression coverage for the #1182 expandHome
 * consolidation.
 *
 * `expandHome` was implemented 8 times across scripts/ in 3 non-equivalent
 * shapes (see the census in scripts/lib/vault-status/board-lock.mjs git
 * history and the GitLab #1182 description). All 8 call sites now delegate
 * to the single canonical `expandTilde` export in scripts/lib/common.mjs —
 * this file proves the migration is behaviourally sound, NOT a re-test of
 * expandTilde's base contract (that lives in tests/lib/common.test.mjs; see
 * its `~`, `~/x`, absolute-passthrough, and non-string cases, which this
 * file deliberately does not duplicate per TV-004).
 *
 * Two things this file names as bugs it would catch (TV-001):
 *   1. A `~user/x`-shaped path silently regressing to be treated as `~`/`~/` —
 *      the historical `gitlab-portfolio/cli.mjs` copy did exactly this via
 *      `p.slice(1)` on ANY leading `~`, resolving `~alice/repo` to
 *      `<home>/alice/repo` instead of leaving another user's home alone.
 *   2. A migrated call site (`resolveBoardPath`, `boardLockPathFor`) losing
 *      its home-expansion wiring after the inline copy was deleted in favour
 *      of the shared import — neither function had a `~`-prefixed test
 *      before this migration (verified: `grep -n "resolveBoardPath('~"
 *      tests/lib/vault-status/board-writer.test.mjs` and the `boardLockPathFor`
 *      equivalent both returned zero matches prior to this file).
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import { expandTilde } from '@lib/common.mjs';
import { resolveBoardPath } from '@lib/vault-status/board-writer.mjs';
import { boardLockPathFor } from '@lib/vault-status/board-lock.mjs';

// ---------------------------------------------------------------------------
// The `~user/x` case — the load-bearing edge of #1182
// ---------------------------------------------------------------------------

describe('expandTilde — ~user/x (issue #1182 edge case)', () => {
  it('leaves a `~user/x`-shaped path unchanged — a different user\'s home is never this process\'s business', () => {
    // Catches: any future edit that widens the `~`-prefix check from
    // `p === '~' || p.startsWith('~/')` back to a bare `p.startsWith('~')`.
    expect(expandTilde('~alice/repo')).toBe('~alice/repo');
    expect(expandTilde('~bob')).toBe('~bob');
  });
});

// ---------------------------------------------------------------------------
// Historical bug reproduction — proves the pre-#1182 gitlab-portfolio/cli.mjs
// copy actually mis-expanded `~user/x`, which is why this consolidation
// exists rather than being a pure style cleanup.
// ---------------------------------------------------------------------------

describe('historical gitlab-portfolio/cli.mjs expandHome (pre-#1182, reproduced verbatim)', () => {
  // Exact shape removed from scripts/lib/gitlab-portfolio/cli.mjs by this
  // migration — kept here ONLY as a fossil to prove the bug it had.
  const buggyExpandHome = (p) => {
    if (typeof p === 'string' && p.startsWith('~')) {
      return path.join(os.homedir(), p.slice(1));
    }
    return p;
  };

  it('mis-expands `~user/x` into `<home>/user/x` — the #1182 bug', () => {
    expect(buggyExpandHome('~alice/repo')).toBe(path.join(os.homedir(), 'alice/repo'));
    // Diverges from the canonical (fixed) behaviour on the exact same input.
    expect(buggyExpandHome('~alice/repo')).not.toBe(expandTilde('~alice/repo'));
  });

  it('agrees with the canonical helper on the cases it got right (`~`, `~/x`)', () => {
    expect(buggyExpandHome('~')).toBe(expandTilde('~'));
    expect(buggyExpandHome('~/Projects/vault')).toBe(expandTilde('~/Projects/vault'));
  });
});

// ---------------------------------------------------------------------------
// Migrated call-site wiring — resolveBoardPath / boardLockPathFor now
// delegate to the shared helper instead of an inline copy.
// ---------------------------------------------------------------------------

describe('resolveBoardPath — delegates to the canonical expandTilde', () => {
  it('expands a `~`-prefixed vaultDir before joining the board path', () => {
    expect(resolveBoardPath('~/vault')).toBe(
      path.join(os.homedir(), 'vault', '01-projects', '_active-sessions.md'),
    );
  });

  it('expands a bare `~` vaultDir', () => {
    expect(resolveBoardPath('~')).toBe(
      path.join(os.homedir(), '01-projects', '_active-sessions.md'),
    );
  });
});

describe('boardLockPathFor — delegates to the canonical expandTilde', () => {
  it('expands a `~`-prefixed vaultDir before joining the lock path', () => {
    expect(boardLockPathFor('~/vault')).toBe(
      path.join(os.homedir(), 'vault', '.orchestrator', 'board.lock'),
    );
  });

  it('expands a bare `~` vaultDir', () => {
    expect(boardLockPathFor('~')).toBe(path.join(os.homedir(), '.orchestrator', 'board.lock'));
  });
});
