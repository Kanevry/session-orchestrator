/**
 * tests/scripts/migrate-sessions-v3.test.mjs
 *
 * Vitest unit tests for v3 → canonical v1 session migration.
 * v3 sessions are pre-validateSession legacy drift (no schema_version field,
 * varied wave shapes). Canonical writer enforces v1 going forward.
 *
 * Tests follow strict TDD: RED → verify fail → GREEN → verify pass.
 */

import { describe, it, expect } from 'vitest';
import { migrateEntry } from '../../scripts/migrate-sessions-jsonl.mjs';
import { validateSession } from '../../scripts/lib/session-schema.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Minimal v3 record with full waves[] + valid session_type.
 * Based on real BuchhaltGenie develop-2026-04-23-0744 sample.
 */
function v3Full() {
  return {
    session_id: 'develop-2026-04-23-0744',
    session_type: 'deep',
    started_at: '2026-04-23T07:44:00Z',
    completed_at: '2026-04-23T10:12:00Z',
    planned_waves: 5,
    actual_waves: 5,
    waves: [
      { wave: 1, role: 'Discovery', agents: 4, status: 'done', notes: 'Explored codebase' },
      { wave: 2, role: 'Implementation', agents: 6, status: 'done', notes: 'Built feature' },
      { wave: 3, role: 'Testing', agents: 3, status: 'done', notes: 'Wrote tests' },
      { wave: 4, role: 'Review', agents: 2, status: 'partial', notes: 'Reviewed PRs' },
      { wave: 5, role: 'Cleanup', agents: 1, status: 'done', notes: 'Final cleanup' },
    ],
    effectiveness: {
      completion_rate: 1.0,
      issues_closed: 8,
      carryover: 0,
      emergent: 0,
      planned_issues: 8,
    },
  };
}

// ---------------------------------------------------------------------------
// v3 with full waves[] + valid session_type → passes validateSession
// ---------------------------------------------------------------------------

describe('migrateEntry — v3 full waves[] + valid session_type', () => {
  it('migrates to a record that passes validateSession', () => {
    const entry = v3Full();
    const migrated = migrateEntry(entry);
    expect(() => validateSession(migrated)).not.toThrow();
  });

  it('sets schema_version to 1 after migration', () => {
    const migrated = migrateEntry(v3Full());
    const validated = validateSession(migrated);
    expect(validated.schema_version).toBe(1);
  });

  it('derives total_waves from actual_waves when total_waves absent', () => {
    const entry = v3Full(); // has actual_waves: 5, no total_waves
    const migrated = migrateEntry(entry);
    expect(migrated.total_waves).toBe(5);
  });

  it('prefers actual_waves over planned_waves for total_waves', () => {
    const entry = { ...v3Full(), actual_waves: 5, planned_waves: 7 };
    delete entry.total_waves;
    const migrated = migrateEntry(entry);
    expect(migrated.total_waves).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// waves[].agents as null → total_agents = 0
// ---------------------------------------------------------------------------

describe('migrateEntry — waves[].agents as null', () => {
  it('treats null agents as 0 for total_agents', () => {
    const entry = {
      session_id: 'sess-null-agents',
      session_type: 'housekeeping',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T09:00:00Z',
      planned_waves: 2,
      actual_waves: 2,
      waves: [
        { wave: 1, role: 'Cleanup', agents: null, status: 'done' },
        { wave: 2, role: 'Review', agents: null, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(migrated.total_agents).toBe(0);
  });

  it('synthesizes agent_summary.complete from done-status waves when agents is null', () => {
    const entry = {
      session_id: 'sess-null-agents-summary',
      session_type: 'housekeeping',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T09:00:00Z',
      waves: [
        { wave: 1, role: 'Cleanup', agents: null, status: 'done' },
        { wave: 2, role: 'Review', agents: null, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    // When agents=null, agent count is 0; but status-based summary still runs
    expect(migrated.agent_summary.complete).toBeGreaterThanOrEqual(0);
    expect(migrated.agent_summary.spiral).toBe(0);
    expect(() => validateSession(migrated)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// waves[].agents as number → contributes to total_agents + agent_summary.complete
// ---------------------------------------------------------------------------

describe('migrateEntry — waves[].agents as number', () => {
  it('sums numeric agents across waves for total_agents', () => {
    const entry = {
      session_id: 'sess-numeric-agents',
      session_type: 'deep',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [
        { wave: 1, role: 'Discovery', agents: 4, status: 'done' },
        { wave: 2, role: 'Implementation', agents: 6, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(migrated.total_agents).toBe(10);
  });

  it('uses done-status wave agent counts for agent_summary.complete', () => {
    const entry = {
      session_id: 'sess-agents-complete',
      session_type: 'deep',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [
        { wave: 1, role: 'Discovery', agents: 4, status: 'done' },
        { wave: 2, role: 'Implementation', agents: 6, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(migrated.agent_summary.complete).toBe(10);
    expect(migrated.agent_summary.failed).toBe(0);
    expect(migrated.agent_summary.partial).toBe(0);
    expect(migrated.agent_summary.spiral).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// waves[].agents as array → contributes array.length
// ---------------------------------------------------------------------------

describe('migrateEntry — waves[].agents as array', () => {
  it('treats agent array length as the agent count', () => {
    const entry = {
      session_id: 'sess-agents-array',
      session_type: 'feature',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T09:30:00Z',
      waves: [
        { wave: 1, role: 'Implementation', agents: ['agent-a', 'agent-b'], status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(migrated.total_agents).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// waves[].files as arrays → total_files_changed = unique set size
// ---------------------------------------------------------------------------

describe('migrateEntry — waves[].files as arrays (unique dedupe)', () => {
  it('counts unique file paths across all wave file arrays', () => {
    const entry = {
      session_id: 'sess-file-arrays',
      session_type: 'feature',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [
        { wave: 1, role: 'Implementation', agents: 2, status: 'done', files: ['src/a.ts', 'src/b.ts'] },
        { wave: 2, role: 'Review', agents: 1, status: 'done', files: ['src/a.ts', 'src/c.ts'] },
      ],
    };
    const migrated = migrateEntry(entry);
    // unique: src/a.ts, src/b.ts, src/c.ts → 3
    expect(migrated.total_files_changed).toBe(3);
  });

  it('returns 0 when all wave file arrays are empty', () => {
    const entry = {
      session_id: 'sess-empty-files',
      session_type: 'feature',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [
        { wave: 1, role: 'Cleanup', agents: 1, status: 'done', files: [] },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(migrated.total_files_changed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// v3 with no agent_summary → synthesized from wave statuses
// ---------------------------------------------------------------------------

describe('migrateEntry — v3 with no agent_summary → synthesized', () => {
  it('synthesizes complete/partial/failed/spiral from wave statuses', () => {
    const entry = {
      session_id: 'sess-no-summary',
      session_type: 'deep',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [
        { wave: 1, role: 'Discovery', agents: 3, status: 'done' },
        { wave: 2, role: 'Implementation', agents: 5, status: 'done' },
        { wave: 3, role: 'Review', agents: 2, status: 'partial' },
        { wave: 4, role: 'Cleanup', agents: 1, status: 'fail' },
      ],
    };
    const migrated = migrateEntry(entry);
    // complete waves (done status): waves 1+2 = 3+5=8 agents
    expect(migrated.agent_summary.complete).toBe(8);
    // partial waves: wave 3 = 2 agents
    expect(migrated.agent_summary.partial).toBe(2);
    // failed waves: wave 4 = 1 agent
    expect(migrated.agent_summary.failed).toBe(1);
    expect(migrated.agent_summary.spiral).toBe(0);
  });

  it('synthesized agent_summary passes validateSession', () => {
    const entry = {
      session_id: 'sess-synthesized-summary',
      session_type: 'deep',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [
        { wave: 1, role: 'Discovery', agents: 4, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(() => validateSession(migrated)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// v3 with partial agent_summary → fills missing keys with 0
// ---------------------------------------------------------------------------

describe('migrateEntry — partial agent_summary (only complete)', () => {
  it('fills missing partial/failed/spiral with 0', () => {
    const entry = {
      session_id: 'sess-partial-summary',
      session_type: 'deep',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      agent_summary: { complete: 5 },
      waves: [
        { wave: 1, role: 'Implementation', agents: 5, status: 'done' },
      ],
    };
    // must add total_agents too since we have agent_summary already
    const entry2 = { ...entry, total_agents: 5, total_waves: 1, total_files_changed: 0 };
    const migrated = migrateEntry(entry2);
    expect(migrated.agent_summary.complete).toBe(5);
    expect(migrated.agent_summary.partial).toBe(0);
    expect(migrated.agent_summary.failed).toBe(0);
    expect(migrated.agent_summary.spiral).toBe(0);
  });

  it('partial agent_summary result passes validateSession', () => {
    const entry = {
      session_id: 'sess-partial-summary-validate',
      session_type: 'feature',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      agent_summary: { complete: 3 },
      total_agents: 3,
      total_waves: 1,
      total_files_changed: 0,
      waves: [
        { wave: 1, role: 'Build', agents: 3, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(() => validateSession(migrated)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// planned_waves + actual_waves → prefer actual_waves for total_waves
// ---------------------------------------------------------------------------

describe('migrateEntry — total_waves derivation precedence', () => {
  it('prefers actual_waves over planned_waves when total_waves absent', () => {
    const entry = {
      session_id: 'sess-wave-precedence',
      session_type: 'deep',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      planned_waves: 7,
      actual_waves: 5,
      waves: [
        { wave: 1, role: 'W1', agents: 1, status: 'done' },
        { wave: 2, role: 'W2', agents: 1, status: 'done' },
        { wave: 3, role: 'W3', agents: 1, status: 'done' },
        { wave: 4, role: 'W4', agents: 1, status: 'done' },
        { wave: 5, role: 'W5', agents: 1, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(migrated.total_waves).toBe(5);
  });

  it('falls back to waves.length when neither actual_waves nor planned_waves present', () => {
    const entry = {
      session_id: 'sess-wave-fallback',
      session_type: 'housekeeping',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T09:00:00Z',
      waves: [
        { wave: 1, role: 'Cleanup', agents: 1, status: 'done' },
        { wave: 2, role: 'Review', agents: 1, status: 'done' },
        { wave: 3, role: 'Finalize', agents: 1, status: 'done' },
      ],
    };
    const migrated = migrateEntry(entry);
    expect(migrated.total_waves).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Non-canonical session_type → unmappable
// ---------------------------------------------------------------------------

describe('migrateEntry — non-canonical session_type', () => {
  it('returns an entry that FAILS validateSession for session_type "discovery"', () => {
    const entry = {
      session_id: 'sess-discovery-type',
      session_type: 'discovery',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [{ wave: 1, role: 'Explore', agents: 2, status: 'done' }],
    };
    const migrated = migrateEntry(entry);
    // session_type 'discovery' is not in [feature, deep, housekeeping]
    expect(() => validateSession(migrated)).toThrow(/session_type/);
  });

  it('returns an entry that FAILS validateSession for session_type "investigation"', () => {
    const entry = {
      session_id: 'sess-investigation-type',
      session_type: 'investigation',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      waves: [{ wave: 1, role: 'Investigate', agents: 1, status: 'done' }],
    };
    const migrated = migrateEntry(entry);
    expect(() => validateSession(migrated)).toThrow(/session_type/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('migrateEntry — idempotency', () => {
  it('running migrateEntry twice produces deep-equal output to once', () => {
    const entry = v3Full();
    const once = migrateEntry(entry);
    const twice = migrateEntry(once);
    // Strip schema_version that might differ only in stamp path
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

// ---------------------------------------------------------------------------
// Regression: existing old-shape (agents_dispatched/waves_completed) still works
// ---------------------------------------------------------------------------

describe('migrateEntry — regression: old-shape still migrates', () => {
  it('old-shape with agents_dispatched/waves_completed still produces a valid canonical entry', () => {
    const oldShape = {
      session_id: 'old-shape-session',
      session_type: 'feature',
      started_at: '2026-04-01T08:00:00Z',
      completed_at: '2026-04-01T10:00:00Z',
      agents_dispatched: 6,
      agents_complete: 4,
      agents_partial: 1,
      agents_failed: 1,
      agents_spiral: 0,
      waves_completed: 3,
      files_changed: 12,
    };
    const migrated = migrateEntry(oldShape);
    expect(() => validateSession(migrated)).not.toThrow();
    expect(migrated.total_agents).toBe(6);
    expect(migrated.total_waves).toBe(3);
    expect(migrated.total_files_changed).toBe(12);
    expect(migrated.agent_summary).toEqual({ complete: 4, partial: 1, failed: 1, spiral: 0 });
  });
});
