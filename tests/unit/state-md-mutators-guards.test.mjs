/**
 * tests/unit/state-md-mutators-guards.test.mjs
 *
 * Tests that requireRepoRoot guard throws on bad repoRoot values for all
 * five on-disk wrappers across body-sections.mjs and frontmatter-mutators.mjs.
 * These tests guard the PSA-005 mechanical serialization contract.
 */

import { describe, it, expect } from 'vitest';
import {
  appendDeviationOnDisk,
  markExpressPathCompleteOnDisk,
  recordAutoCommitOnDisk,
} from '@lib/state-md/body-sections.mjs';
import {
  updateFrontmatterFieldsOnDisk,
  touchUpdatedFieldOnDisk,
} from '@lib/state-md/frontmatter-mutators.mjs';

const ISO = '2026-05-23T00:00:00Z';

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
