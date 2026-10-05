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
  VALID_SESSION_PROFILES,
  REQUIRED_FIELDS,
  AGENT_SUMMARY_FIELDS,
  OPTIONAL_FIELDS,
} from '@lib/session-schema/constants.mjs';
import { validateSession } from '@lib/session-schema/validator.mjs';

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
  it('is exactly [feature, deep, housekeeping, unknown] (closed enum)', () => {
    // GitLab #1234 widened this by ONE member. `unknown` is not a fourth session
    // MODE — it is the absence of a measurement, written only by
    // `synthesizeRecord()` for records it also flags `_session_type_inferred`.
    // The exact-array assertion is what makes a fifth member a deliberate act:
    // adding one silently would let a value reach `scripts/lib/wave-sizing.mjs`
    // (which THROWS on an unlisted type) and `telemetry/schema.mjs` (which
    // relabels it `other`) with no test to notice.
    expect([...VALID_SESSION_TYPES]).toEqual(['feature', 'deep', 'housekeeping', 'unknown']);
  });
});

describe('VALID_SESSION_PROFILES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(VALID_SESSION_PROFILES)).toBe(true);
  });

  // GitLab #1252 moved the SSOT here from scripts/lib/telemetry/schema.mjs,
  // which now re-exports it. Mirrors the exact-array pin above for the same
  // reason: `session_profile` is copied from repo-authored STATE.md frontmatter,
  // so only an enumeration of names that are public BY CONSTRUCTION keeps a
  // private-looking value off the telemetry wire. A second member must be a
  // deliberate act here AND in the server mirror (server/ingest/validate.mjs
  // SESSION_PROFILES, held in lockstep by tests/telemetry/parity.test.mjs).
  it('is exactly [ultradeep] (closed enum, and NOT a VALID_SESSION_TYPES member)', () => {
    expect([...VALID_SESSION_PROFILES]).toEqual(['ultradeep']);
    for (const profile of VALID_SESSION_PROFILES) {
      expect(VALID_SESSION_TYPES).not.toContain(profile);
    }
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

  // #986 (TV-002b): the hand-typed membership floor that stood here is gone —
  // the census test below derives the set from the validator and is strictly
  // stronger (it named 11 undeclared fields the floor never could).

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

  /**
   * Nameable bug (TV-001, #986): `_validateOptionalFields` shape-checked 11
   * fields that OPTIONAL_FIELDS never declared, and the hand-typed floor that
   * preceded this test could not notice — it only checks names someone remembered to type. The
   * census here is taken from the validator ITSELF: a Proxy records every key
   * `validateSession` reads off a minimal valid record. Minus the required
   * fields and `schema_version`, what remains is exactly the set of optional
   * keys the validator inspects. A new `if (entry.x …)` without a declaration
   * goes red, and so does a declaration whose check is removed.
   */
  it('#986: matches the optional keys validateSession actually inspects (census from code)', () => {
    const minimal = {
      session_id: 'sess-2026-04-24-test',
      session_type: 'deep',
      started_at: '2026-04-24T08:00:00Z',
      completed_at: '2026-04-24T09:00:00Z',
      total_waves: 1,
      waves: [{ wave: 1, role: 'implement' }],
      agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
      total_agents: 1,
      total_files_changed: 1,
    };
    const read = new Set();
    const probe = new Proxy(minimal, {
      get(target, key, receiver) {
        if (typeof key === 'string') read.add(key);
        return Reflect.get(target, key, receiver);
      },
    });
    validateSession(probe);
    const inspected = [...read].filter(
      (k) => k !== 'schema_version' && !REQUIRED_FIELDS.includes(k)
    );
    // Vacuum guard: a probe that records nothing would make both checks pass.
    expect(inspected).toContain('effectiveness');
    expect(inspected.length).toBeGreaterThanOrEqual(30);

    expect(inspected.filter((k) => !OPTIONAL_FIELDS.includes(k))).toEqual([]);
    // Ratchet: declared fields with a live writer but no validator check.
    // Adding a check for one of them, or declaring another unchecked field,
    // must edit this list on purpose.
    expect(OPTIONAL_FIELDS.filter((k) => !inspected.includes(k)).sort()).toEqual([
      '_repair_source',
      'raw_session_id',
      'session_start_ref',
    ]);
  });

  it('has no overlap with REQUIRED_FIELDS', () => {
    expect(REQUIRED_FIELDS.some((f) => OPTIONAL_FIELDS.includes(f))).toBe(false);
  });
});
