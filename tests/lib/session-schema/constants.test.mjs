/**
 * tests/lib/session-schema/constants.test.mjs
 *
 * Vitest suite for scripts/lib/session-schema/constants.mjs.
 * Covers: version number, SESSION_KEY_ALIASES frozen-ness + entries,
 * VALID_SESSION_TYPES, REQUIRED_FIELDS completeness, AGENT_SUMMARY_FIELDS.
 */

import { describe, it, expect } from 'vitest';
import {
  CURRENT_SESSION_SCHEMA_VERSION,
  SESSION_KEY_ALIASES,
  VALID_SESSION_TYPES,
  REQUIRED_FIELDS,
  AGENT_SUMMARY_FIELDS,
  OPTIONAL_FIELDS,
} from '@lib/session-schema/constants.mjs';

describe('CURRENT_SESSION_SCHEMA_VERSION', () => {
  it('is the number 2', () => {
    expect(CURRENT_SESSION_SCHEMA_VERSION).toBe(2);
  });
});

describe('SESSION_KEY_ALIASES', () => {
  it('is a frozen object (cannot be mutated)', () => {
    expect(Object.isFrozen(SESSION_KEY_ALIASES)).toBe(true);
  });

  // TV-003 consolidation (#964): 6 single-assertion mapping tests folded into
  // one table. Each row still names the alias it pins; nothing is lost.
  it.each([
    ['type', 'session_type'],
    ['mode', 'session_type'], // #373
    ['closed_issues', 'issues_closed'],
    ['waves_completed', 'total_waves'], // legacy scalar alias
    ['head_ref', 'branch'],
    ['files_changed', 'total_files_changed'],
  ])('maps %s → %s', (alias, canonical) => {
    expect(SESSION_KEY_ALIASES[alias]).toBe(canonical);
  });

  it('has at least 13 declared entries (completeness floor — grows additively, see test-quality.md dynamic-count carve-out)', () => {
    const count = Object.keys(SESSION_KEY_ALIASES).length;
    expect(count).toBeGreaterThanOrEqual(13);
    expect(count).toBeLessThanOrEqual(40);
  });

  it('all values are non-empty strings', () => {
    for (const val of Object.values(SESSION_KEY_ALIASES)) {
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    }
  });
});

describe('VALID_SESSION_TYPES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(VALID_SESSION_TYPES)).toBe(true);
  });

  // TV-003 consolidation (#964): membership + count folded into one exact-array
  // assertion. A closed enum's whole contract is the exact list, so `toEqual`
  // is strictly stronger than `toContain` × 3 plus a length pin — and it drops
  // a `toHaveLength(<literal>)` the test-value scanner flags.
  it('is exactly [feature, deep, housekeeping] (closed enum)', () => {
    expect([...VALID_SESSION_TYPES]).toEqual(['feature', 'deep', 'housekeeping']);
  });
});

describe('REQUIRED_FIELDS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(REQUIRED_FIELDS)).toBe(true);
  });

  // TV-003 consolidation (#964): membership + count folded into one exact-array
  // assertion. This list is a CLOSED contract, not a growing catalog — the
  // dynamic-count carve-out does not apply, and pinning it exactly is what
  // makes the vault-mirror superset test (tests/lib/vault-mirror/
  // render-sessions.test.mjs) meaningful: both sides must be stable to compare.
  it('is exactly the 9 canonical required fields, in order', () => {
    expect([...REQUIRED_FIELDS]).toEqual([
      'session_id',
      'session_type',
      'started_at',
      'completed_at',
      'total_waves',
      'waves',
      'agent_summary',
      'total_agents',
      'total_files_changed',
    ]);
  });
});

describe('AGENT_SUMMARY_FIELDS', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(AGENT_SUMMARY_FIELDS)).toBe(true);
  });

  // TV-003 consolidation (#964): membership + count → one exact-array assertion.
  it('is exactly [complete, partial, failed, spiral]', () => {
    expect([...AGENT_SUMMARY_FIELDS]).toEqual(['complete', 'partial', 'failed', 'spiral']);
  });
});

// ---------------------------------------------------------------------------
// OPTIONAL_FIELDS (ADR-364 thin-slice)
// ---------------------------------------------------------------------------

describe('OPTIONAL_FIELDS', () => {
  it('is a frozen array', () => {
    expect(Array.isArray(OPTIONAL_FIELDS)).toBe(true);
    expect(Object.isFrozen(OPTIONAL_FIELDS)).toBe(true);
  });

  it('has the expected optional fields (floor/ceiling — grows additively, see testing.md dynamic-count carve-out)', () => {
    // Floor: 9 (current count after Epic #644 added 3 token-rollup fields).
    // Ceiling: 30 (generous headroom for future additive extensions).
    // Named-field assertions below pin the new fields without locking the count.
    expect(OPTIONAL_FIELDS.length).toBeGreaterThanOrEqual(9);
    expect(OPTIONAL_FIELDS.length).toBeLessThanOrEqual(30);
  });

  // TV-003 consolidation (#964): 10 single-`toContain` tests folded into ONE
  // membership assertion. Every field is still named, and the failure message
  // names exactly which one went missing — strictly more informative than 10
  // separate greens, at a tenth of the volume. `filter`, not `toEqual`, keeps
  // this a floor: the list may grow additively without editing this test.
  it('declares every known optional field (ADR-364 + #644 + #773 + #964)', () => {
    const expected = [
      'agent_identity',
      'worktree_path',
      'parent_run_id',
      'lease_acquired_at',
      'lease_ttl_seconds',
      'expected_cost_tier',
      'total_token_input', // #644
      'total_token_output', // #644
      'subagents_with_tokens', // #644
      'open_questions_asked', // #773
      'open_questions_answered', // #773
      'open_questions_deferred', // #773
      'effectiveness', // #964
    ];
    expect(expected.filter((f) => !OPTIONAL_FIELDS.includes(f))).toEqual([]);
  });

  /**
   * Nameable bug (TV-001): `effectiveness` was shape-checked by
   * `_validateOptionalFields` while appearing in NEITHER list, so its status was
   * only inferrable from an `if`. #964 states it — and the direction matters.
   * Promoting it to REQUIRED_FIELDS would retroactively invalidate the 10
   * existing records that lack it plus every `abandoned` backfill stub, so this
   * pins that it landed on the optional side and stayed there. The vault-mirror
   * v1 renderer requires it separately; that stronger contract is pinned in
   * tests/lib/vault-mirror/render-sessions.test.mjs.
   */
  it('#964: effectiveness is OPTIONAL on the write path, never required', () => {
    expect(OPTIONAL_FIELDS).toContain('effectiveness');
    expect(REQUIRED_FIELDS).not.toContain('effectiveness');
  });

  it('fields appear in stable canonical order', () => {
    expect(OPTIONAL_FIELDS[0]).toBe('agent_identity');
    expect(OPTIONAL_FIELDS[1]).toBe('worktree_path');
    expect(OPTIONAL_FIELDS[2]).toBe('parent_run_id');
    expect(OPTIONAL_FIELDS[3]).toBe('lease_acquired_at');
    expect(OPTIONAL_FIELDS[4]).toBe('lease_ttl_seconds');
    expect(OPTIONAL_FIELDS[5]).toBe('expected_cost_tier');
  });

  it('has no overlap with REQUIRED_FIELDS', () => {
    expect(REQUIRED_FIELDS.some((f) => OPTIONAL_FIELDS.includes(f))).toBe(false);
  });
});
