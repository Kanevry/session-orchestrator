/**
 * tests/scripts/lib/memory-proposals/store-safepath-reason.test.mjs
 *
 * G-M2 (issue #553, MED) — safePath result.reason text NOT asserted.
 *
 * Verifies that scripts/lib/memory-proposals/store.mjs:55-69 (`safePath`)
 * surfaces the `result.reason` value verbatim in the thrown TypeError
 * message — i.e. the operator-facing "(reason: lexical|symlink|input)"
 * suffix that lets a debugger distinguish path-traversal classes at a
 * glance (added in #548 A5).
 *
 * Mocking strategy:
 *   - Top-of-file `vi.mock('@lib/path-utils.mjs', ...)` so the import is
 *     hoisted BEFORE the SUT (`@lib/memory-proposals/store.mjs`) loads.
 *   - SIBLING-FILE isolation: this file mocks path-utils; the sibling
 *     `store.test.mjs` does NOT, so the mocks here do not leak into
 *     the existing happy-path/branch/parallel-race coverage.
 *   - We force `validatePathInsideProject` to return `{ok:false, reason:X}`
 *     so the SUT enters its `!result.ok` branch (lines 56-67) where the
 *     TypeError is constructed.
 *
 * Test-quality (.claude/rules/test-quality.md):
 *   - Hardcoded literal regex assertions — no computed expected values
 *   - One AAA per test, cyclomatic complexity = 1
 *   - Falsification-checked: each test fails if line 65 ("reason: ${result.reason}")
 *     were removed or the reason value swapped
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock() is hoisted ABOVE the SUT import below. Returning a vi.fn()
// per export lets each test seed its own return value via mockReturnValueOnce.
vi.mock('@lib/path-utils.mjs', () => ({
  validatePathInsideProject: vi.fn(),
}));

import { appendProposal } from '@lib/memory-proposals/store.mjs';
import { createProposalRecord } from '@lib/memory-proposals/schema.mjs';
import { validatePathInsideProject } from '@lib/path-utils.mjs';

/**
 * Build a valid ProposalRecord with sensible defaults.
 * The record must pass the BEFORE-lock confidence-floor check so the SUT
 * reaches `summaryPathFor(repoRoot, waveId)` → `safePath(...)` → throw.
 */
function makeRecord() {
  return createProposalRecord({
    type: 'workflow-pattern',
    subject: 'test-subject',
    insight: 'test insight for safePath reason tests',
    evidence: 'test evidence for safePath reason tests',
    confidence: 0.7,
    waveId: 'W1',
  });
}

describe('store.mjs safePath — surfaces result.reason in TypeError (G-M2, #553)', () => {
  beforeEach(() => {
    vi.mocked(validatePathInsideProject).mockReset();
  });

  // G-M2.1 — reason: lexical surfaces verbatim
  // Trigger: relPath escapes repoRoot lexically (../../ before any symlink
  // resolution). The SUT constructs:
  //   TypeError("store.mjs: path traversal blocked: <resolved> is outside <root> (reason: lexical)")
  // Falsification: if `reason: ${result.reason}` were dropped, the regex
  // `/reason: lexical/` would not match. If the reason were hardcoded to a
  // different string (e.g. "lexical-escape"), the literal /reason: lexical/
  // would still fail because of the trailing word boundary.
  it('throws TypeError with "reason: lexical" when validatePathInsideProject returns ok:false reason:lexical', async () => {
    vi.mocked(validatePathInsideProject).mockReturnValueOnce({
      ok: false,
      reason: 'lexical',
    });

    await expect(
      appendProposal({
        record: makeRecord(),
        repoRoot: '/tmp/nonexistent-repo-root',
        waveId: 'W1',
      }),
    ).rejects.toThrow(/reason: lexical\)/);
  });

  // G-M2.2 — reason: symlink surfaces verbatim
  // Trigger: relPath resolves through a symlink whose target lies outside
  // repoRoot. Same shape, different reason.
  it('throws TypeError with "reason: symlink" when validatePathInsideProject returns ok:false reason:symlink', async () => {
    vi.mocked(validatePathInsideProject).mockReturnValueOnce({
      ok: false,
      reason: 'symlink',
    });

    await expect(
      appendProposal({
        record: makeRecord(),
        repoRoot: '/tmp/nonexistent-repo-root',
        waveId: 'W1',
      }),
    ).rejects.toThrow(/reason: symlink\)/);
  });

  // G-M2.3 — reason: input surfaces verbatim
  // Trigger: relPath was malformed at the validator (empty string, non-string,
  // null byte). Same shape, third reason value.
  it('throws TypeError with "reason: input" when validatePathInsideProject returns ok:false reason:input', async () => {
    vi.mocked(validatePathInsideProject).mockReturnValueOnce({
      ok: false,
      reason: 'input',
    });

    await expect(
      appendProposal({
        record: makeRecord(),
        repoRoot: '/tmp/nonexistent-repo-root',
        waveId: 'W1',
      }),
    ).rejects.toThrow(/reason: input\)/);
  });
});
