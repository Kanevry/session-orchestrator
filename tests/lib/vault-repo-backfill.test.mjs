/**
 * tests/lib/vault-repo-backfill.test.mjs
 *
 * Unit tests for the pure inference layer in
 * scripts/lib/vault-repo-backfill.mjs (Issue #700 Vault-Coverage-Lift, W1-D5).
 *
 * The module is PURE: all cross-repo data (sidIndex, bdIndex) and the namespace
 * resolver are INJECTED. Tests exercise the REAL exported functions against
 * deterministic fake indices + a deterministic per-call resolver — never just
 * the fakes (no test-the-mock). All expected values are hardcoded literals.
 */

import { describe, it, expect } from 'vitest';

import {
  parseSessionId,
  inferRepoForSession,
  buildBackfillIndex,
  isBackfillDerivable,
} from '@lib/vault-repo-backfill.mjs';

// ---------------------------------------------------------------------------
// Deterministic resolver injectables
// ---------------------------------------------------------------------------

/** Identity resolver — returns the repo basename unchanged (no leak-guard fired). */
function identityResolver({ vaultName }) {
  return vaultName ?? 'unknown-repo';
}

/** Resolver that downgrades a known private slug to the redacted sentinel. */
function redactingResolver({ vaultName }) {
  if (vaultName === 'LeakyFixtureRepo') return 'redacted-repo';
  return vaultName ?? 'unknown-repo';
}

// ---------------------------------------------------------------------------
// parseSessionId
// ---------------------------------------------------------------------------

describe('parseSessionId', () => {
  it('parses a hyphenated branch by anchoring on the date token', () => {
    expect(parseSessionId('feat-harness-reliability-2026-04-19-1515')).toEqual({
      branch: 'feat-harness-reliability',
      date: '2026-04-19',
    });
  });

  it('parses a simple single-segment branch', () => {
    expect(parseSessionId('main-2026-06-21-session-1')).toEqual({
      branch: 'main',
      date: '2026-06-21',
    });
  });

  it('parses a branch when the date token is the trailing segment (no suffix)', () => {
    expect(parseSessionId('main-2026-06-21')).toEqual({
      branch: 'main',
      date: '2026-06-21',
    });
  });

  it('returns null for an id with no date token', () => {
    expect(parseSessionId('vault-deep-s92')).toBeNull();
  });

  it('returns null for an id that starts with a bare date (empty branch)', () => {
    expect(parseSessionId('2026-04-19-x')).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(parseSessionId(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// inferRepoForSession — all 5 outcomes
// ---------------------------------------------------------------------------

describe('inferRepoForSession', () => {
  it('returns HIGH when the id maps to exactly one repo in sidIndex (sid-authoritative)', () => {
    const sidIndex = new Map([['main-2026-06-21-s1', new Set(['session-orchestrator'])]]);
    const result = inferRepoForSession(
      { id: 'main-2026-06-21-s1' },
      { sidIndex, bdIndex: new Map(), resolveNamespace: identityResolver },
    );
    expect(result).toEqual({
      repo: 'session-orchestrator',
      confidence: 'HIGH',
      source: 'sid-authoritative',
    });
  });

  it('returns SKIP id-collision when the id maps to more than one repo in sidIndex', () => {
    const sidIndex = new Map([
      ['main-2026-06-21-s1', new Set(['repo-a', 'repo-b'])],
    ]);
    const result = inferRepoForSession(
      { id: 'main-2026-06-21-s1' },
      { sidIndex, bdIndex: new Map(), resolveNamespace: identityResolver },
    );
    expect(result).toEqual({
      repo: null,
      confidence: 'SKIP',
      source: 'id-collision',
    });
  });

  it('returns MEDIUM when the id is absent from sidIndex but (branch,date) is unique in bdIndex', () => {
    const bdIndex = new Map([['main|2026-06-21', new Set(['session-orchestrator'])]]);
    const result = inferRepoForSession(
      { id: 'main-2026-06-21-s1' },
      { sidIndex: new Map(), bdIndex, resolveNamespace: identityResolver },
    );
    expect(result).toEqual({
      repo: 'session-orchestrator',
      confidence: 'MEDIUM',
      source: 'branchdate-unique',
    });
  });

  it('returns SKIP no-signal when (branch,date) maps to more than one repo in bdIndex', () => {
    const bdIndex = new Map([['main|2026-06-21', new Set(['repo-a', 'repo-b'])]]);
    const result = inferRepoForSession(
      { id: 'main-2026-06-21-s1' },
      { sidIndex: new Map(), bdIndex, resolveNamespace: identityResolver },
    );
    expect(result).toEqual({
      repo: null,
      confidence: 'SKIP',
      source: 'no-signal',
    });
  });

  it('returns SKIP no-signal when the id has no parseable date and no sid match', () => {
    const result = inferRepoForSession(
      { id: 'vault-deep-s92' },
      { sidIndex: new Map(), bdIndex: new Map(), resolveNamespace: identityResolver },
    );
    expect(result).toEqual({
      repo: null,
      confidence: 'SKIP',
      source: 'no-signal',
    });
  });

  it('returns SKIP leak-guarded when a unique sid resolves to the redacted sentinel', () => {
    const sidIndex = new Map([['main-2026-06-21-s1', new Set(['LeakyFixtureRepo'])]]);
    const result = inferRepoForSession(
      { id: 'main-2026-06-21-s1' },
      { sidIndex, bdIndex: new Map(), resolveNamespace: redactingResolver },
    );
    expect(result).toEqual({
      repo: null,
      confidence: 'SKIP',
      source: 'leak-guarded',
    });
  });
});

// ---------------------------------------------------------------------------
// buildBackfillIndex
// ---------------------------------------------------------------------------

describe('buildBackfillIndex', () => {
  it('keeps only confident (HIGH/MEDIUM) entries and omits every SKIP outcome', () => {
    const sidIndex = new Map([
      ['high-2026-06-21-s1', new Set(['repo-high'])],
      ['collision-2026-06-21-s1', new Set(['repo-a', 'repo-b'])],
    ]);
    const bdIndex = new Map([['medium|2026-06-22', new Set(['repo-medium'])]]);

    const parsedVaultSessions = [
      { id: 'high-2026-06-21-s1', frontmatter: { id: 'high-2026-06-21-s1' } },
      { id: 'collision-2026-06-21-s1', frontmatter: { id: 'collision-2026-06-21-s1' } },
      { id: 'medium-2026-06-22-s2', frontmatter: { id: 'medium-2026-06-22-s2' } },
      { id: 'nosignal-deep-s92', frontmatter: { id: 'nosignal-deep-s92' } },
    ];

    const index = buildBackfillIndex(parsedVaultSessions, {
      sidIndex,
      bdIndex,
      resolveNamespace: identityResolver,
    });

    expect(index.size).toBe(2);
    expect(index.get('high-2026-06-21-s1')).toEqual({
      repo: 'repo-high',
      confidence: 'HIGH',
      source: 'sid-authoritative',
    });
    expect(index.get('medium-2026-06-22-s2')).toEqual({
      repo: 'repo-medium',
      confidence: 'MEDIUM',
      source: 'branchdate-unique',
    });
    expect(index.has('collision-2026-06-21-s1')).toBe(false);
    expect(index.has('nosignal-deep-s92')).toBe(false);
  });

  it('returns an empty Map for a non-array input', () => {
    const index = buildBackfillIndex(null, { resolveNamespace: identityResolver });
    expect(index.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isBackfillDerivable
// ---------------------------------------------------------------------------

describe('isBackfillDerivable', () => {
  it('returns true for HIGH', () => {
    expect(isBackfillDerivable('HIGH')).toBe(true);
  });

  it('returns true for MEDIUM', () => {
    expect(isBackfillDerivable('MEDIUM')).toBe(true);
  });

  it('returns false for SKIP', () => {
    expect(isBackfillDerivable('SKIP')).toBe(false);
  });
});
