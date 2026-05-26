/**
 * tests/unit/state-md-mutators-guards.test.mjs
 *
 * Tests that requireRepoRoot guard throws on bad repoRoot values for all
 * five on-disk wrappers across body-sections.mjs and frontmatter-mutators.mjs.
 * These tests guard the PSA-005 mechanical serialization contract.
 */

import { describe, it, expect } from 'vitest';
import {
  appendDeviation,
  appendDeviationOnDisk,
  markExpressPathCompleteOnDisk,
  recordAutoCommitOnDisk,
} from '@lib/state-md/body-sections.mjs';
import {
  updateFrontmatterFieldsOnDisk,
  touchUpdatedFieldOnDisk,
} from '@lib/state-md/frontmatter-mutators.mjs';

const ISO = '2026-05-23T00:00:00Z';

// Minimal STATE.md fixture for pure appendDeviation regression tests (issue #560)
const STATE_MD_FIXTURE = `---
schema-version: 1
status: active
updated: 2026-05-01T10:00:00Z
---

## Current Wave

Wave 1 — Discovery
`;

// ISO 8601 timestamp regex inside square brackets — matches both
// `Date#toISOString()` output (`2026-05-26T17:00:00.000Z`) and trimmed forms.
const ISO_BRACKET_REGEX = /\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?\]/;

// ─── appendDeviationOnDisk ────────────────────────────────────────────────────

describe('appendDeviationOnDisk()', () => {
  it('throws with repoRoot is required when repoRoot is undefined', async () => {
    await expect(appendDeviationOnDisk(undefined, ISO, 'test message'))
      .rejects.toThrow('repoRoot is required');
  });

  it('throws with repoRoot is required when repoRoot is null', async () => {
    await expect(appendDeviationOnDisk(null, ISO, 'test message'))
      .rejects.toThrow('repoRoot is required');
  });

  it('throws with repoRoot is required when repoRoot is empty string', async () => {
    await expect(appendDeviationOnDisk('', ISO, 'test message'))
      .rejects.toThrow('repoRoot is required');
  });
});

// ─── appendDeviation (pure) — undefined-timestamp regression guard (issue #560) ──
//
// W2-I4 fix: defensive guard in appendDeviation defaults isoTimestamp to
// `new Date().toISOString()` when it is undefined, null, empty string, or
// non-string. Previously, `undefined` was rendered as the literal text
// "undefined" in the deviations log (deep-2115 inter-wave 2→3 incident).
describe('appendDeviation() — undefined timestamp regression (#560)', () => {
  it('Test A: renders a valid string timestamp verbatim when provided', () => {
    const output = appendDeviation(
      STATE_MD_FIXTURE,
      '2026-05-26T17:00:00Z',
      'regression-test-A',
    );
    expect(output).toContain('[2026-05-26T17:00:00Z]');
    expect(output).toContain('regression-test-A');
    expect(output).toContain('- [2026-05-26T17:00:00Z] regression-test-A');
  });

  it('Test B: defaults to current ISO timestamp when isoTimestamp is undefined (no literal "undefined" leak)', () => {
    const output = appendDeviation(
      STATE_MD_FIXTURE,
      undefined,
      'regression-test-B',
    );
    // Bug regression: the literal text "undefined" must NOT appear anywhere.
    expect(output.includes('undefined')).toBe(false);
    // A valid ISO-8601 timestamp in square brackets must be present.
    expect(output).toMatch(ISO_BRACKET_REGEX);
    expect(output).toContain('regression-test-B');
  });

  it('Test C: defaults to current ISO timestamp when isoTimestamp is null', () => {
    const output = appendDeviation(
      STATE_MD_FIXTURE,
      null,
      'regression-test-C',
    );
    expect(output.includes('[null]')).toBe(false);
    expect(output).toMatch(ISO_BRACKET_REGEX);
    expect(output).toContain('regression-test-C');
  });

  it('Test D: defaults to current ISO timestamp when isoTimestamp is empty string', () => {
    const output = appendDeviation(
      STATE_MD_FIXTURE,
      '',
      'regression-test-D',
    );
    // An empty-string timestamp would render `- [] regression-test-D` without the guard.
    expect(output.includes('- [] ')).toBe(false);
    expect(output).toMatch(ISO_BRACKET_REGEX);
    expect(output).toContain('regression-test-D');
  });
});

// ─── updateFrontmatterFieldsOnDisk ───────────────────────────────────────────

describe('updateFrontmatterFieldsOnDisk()', () => {
  it('throws with repoRoot is required when repoRoot is undefined', async () => {
    await expect(updateFrontmatterFieldsOnDisk(undefined, { status: 'active' }))
      .rejects.toThrow('repoRoot is required');
  });

  it('throws with repoRoot is required when repoRoot is empty string', async () => {
    await expect(updateFrontmatterFieldsOnDisk('', { status: 'active' }))
      .rejects.toThrow('repoRoot is required');
  });
});

// ─── touchUpdatedFieldOnDisk ─────────────────────────────────────────────────

describe('touchUpdatedFieldOnDisk()', () => {
  it('throws with repoRoot is required when repoRoot is undefined', async () => {
    await expect(touchUpdatedFieldOnDisk(undefined, ISO))
      .rejects.toThrow('repoRoot is required');
  });

  it('throws with repoRoot is required when repoRoot is empty string', async () => {
    await expect(touchUpdatedFieldOnDisk('', ISO))
      .rejects.toThrow('repoRoot is required');
  });
});

// ─── markExpressPathCompleteOnDisk ───────────────────────────────────────────

describe('markExpressPathCompleteOnDisk()', () => {
  it('throws with repoRoot is required when repoRoot is undefined', async () => {
    await expect(markExpressPathCompleteOnDisk(undefined, { taskCount: 3 }))
      .rejects.toThrow('repoRoot is required');
  });

  it('throws with repoRoot is required when repoRoot is empty string', async () => {
    await expect(markExpressPathCompleteOnDisk('', { taskCount: 3 }))
      .rejects.toThrow('repoRoot is required');
  });
});

// ─── recordAutoCommitOnDisk ───────────────────────────────────────────────────

describe('recordAutoCommitOnDisk()', () => {
  it('throws with repoRoot is required when repoRoot is undefined', async () => {
    await expect(recordAutoCommitOnDisk(undefined, { sha: 'abc1234', waveN: 1, waveResultSummary: 'ok' }))
      .rejects.toThrow('repoRoot is required');
  });

  it('throws with repoRoot is required when repoRoot is empty string', async () => {
    await expect(recordAutoCommitOnDisk('', { sha: 'abc1234', waveN: 1, waveResultSummary: 'ok' }))
      .rejects.toThrow('repoRoot is required');
  });
});
