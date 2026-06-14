/**
 * tests/lib/skill-health/join.test.mjs
 *
 * Unit tests for scripts/lib/skill-health/join.mjs (epic #645, issue #645).
 *
 * Strategy: write fixture JSONL files to a tmp dir; pass paths explicitly to
 * joinSkillOutcomes({ invocationsPath, sessionsPath }). Never touches
 * the real .orchestrator/metrics files.
 *
 * Covered:
 *   - happy path: 2 sessions for 1 skill — one with agent_summary, one absent
 *   - selections count and sessions array accuracy
 *   - totalSelections / sessionsJoined / sessionsUnknown counters
 *   - absent invocations file → empty bySkill, no throw
 *   - absent sessions file → all outcomes bucketed as unknown
 *   - malformed JSONL lines are silently skipped
 *   - duplicate session for same skill counted once in outcome aggregation
 *   - multiple skills across overlapping sessions
 *   - session with null session_id → unknown bucket
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { joinSkillOutcomes } from '../../../scripts/lib/skill-health/join.mjs';

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmp;
let invPath;
let sessPath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'skill-health-join-'));
  invPath = join(tmp, 'skill-invocations.jsonl');
  sessPath = join(tmp, 'sessions.jsonl');
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Append a skill-invocation record (selected event) to the invocations fixture.
 */
function appendInv({ skill, session_id }) {
  const rec = {
    timestamp: '2026-06-14T10:00:00.000Z',
    event: 'selected',
    skill,
    session_id: session_id ?? null,
    schema_version: 1,
  };
  appendFileSync(invPath, JSON.stringify(rec) + '\n');
}

/**
 * Append a session record to the sessions fixture.
 * agent_summary is optional — omit to simulate a session not yet in sessions.jsonl.
 */
function appendSession({ session_id, agent_summary }) {
  const rec = { session_id, ...(agent_summary ? { agent_summary } : {}) };
  appendFileSync(sessPath, JSON.stringify(rec) + '\n');
}

// ---------------------------------------------------------------------------
// J1 — happy path: skill selected across 2 sessions, one found, one absent
// ---------------------------------------------------------------------------

describe('happy path: 1 skill, 2 sessions (1 found, 1 absent)', () => {
  it('bySkill contains the skill with outcomes.complete from the found session', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 } });
    // sess-002 is absent from sessions.jsonl

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.outcomes.complete).toBe(3);
  });

  it('bySkill.discovery.outcomes.unknown is 1 for the absent session', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.outcomes.unknown).toBe(1);
  });

  it('bySkill.discovery.selections is 2', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.selections).toBe(2);
  });

  it('bySkill.discovery.sessions contains both session IDs (sorted)', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.sessions).toEqual(['sess-001', 'sess-002']);
  });

  it('totalSelections is 2', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.totalSelections).toBe(2);
  });

  it('sessionsJoined is 1 (only sess-001 found)', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.sessionsJoined).toBe(1);
  });

  it('sessionsUnknown is 1 (sess-002 absent from sessions.jsonl)', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.sessionsUnknown).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// J2 — absent invocations file → empty result, no throw
// ---------------------------------------------------------------------------

describe('absent invocations file', () => {
  it('returns bySkill: {} when invocations file is absent — no throw', async () => {
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill).toEqual({});
  });

  it('returns totalSelections: 0 when invocations file is absent', async () => {
    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.totalSelections).toBe(0);
  });

  it('returns sessionsJoined: 0 and sessionsUnknown: 0 when invocations file is absent', async () => {
    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.sessionsJoined).toBe(0);
    expect(result.sessionsUnknown).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// J3 — absent sessions file → all outcomes bucketed as unknown
// ---------------------------------------------------------------------------

describe('absent sessions file', () => {
  it('buckets all invocations as unknown when sessions file is absent', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-002' });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.outcomes.unknown).toBe(2);
    expect(result.bySkill.discovery.outcomes.complete).toBe(0);
  });

  it('sessionsUnknown equals totalSelections when sessions file is absent', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'test', session_id: 'sess-002' });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.sessionsUnknown).toBe(2);
    expect(result.sessionsJoined).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// J4 — malformed JSONL lines are silently skipped
// ---------------------------------------------------------------------------

describe('malformed JSONL lines skipped', () => {
  it('skips non-JSON lines in invocations file and processes valid ones', async () => {
    appendFileSync(invPath, 'not json\n');
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendFileSync(invPath, '{broken\n');
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.totalSelections).toBe(1);
    expect(result.bySkill.discovery.selections).toBe(1);
  });

  it('skips non-JSON lines in sessions file and processes valid ones', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendFileSync(sessPath, 'garbage\n');
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 5, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.outcomes.complete).toBe(5);
    expect(result.sessionsJoined).toBe(1);
  });

  it('skips invocation records where event !== "selected"', async () => {
    // Record with wrong event type — should be filtered out
    const wrongEvent = {
      timestamp: '2026-06-14T10:00:00.000Z',
      event: 'start',
      skill: 'discovery',
      session_id: 'sess-001',
      schema_version: 1,
    };
    appendFileSync(invPath, JSON.stringify(wrongEvent) + '\n');
    appendInv({ skill: 'discovery', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-002', agent_summary: { complete: 2, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    // Only the 'selected' event should be counted
    expect(result.totalSelections).toBe(1);
    expect(result.bySkill.discovery.selections).toBe(1);
  });

  it('skips invocation records where skill is missing or empty', async () => {
    const noSkill = {
      timestamp: '2026-06-14T10:00:00.000Z',
      event: 'selected',
      session_id: 'sess-001',
      schema_version: 1,
    };
    appendFileSync(invPath, JSON.stringify(noSkill) + '\n');
    appendInv({ skill: 'test', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-002', agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.totalSelections).toBe(1);
    expect(Object.keys(result.bySkill)).toEqual(['test']);
  });
});

// ---------------------------------------------------------------------------
// J5 — duplicate session for same skill counted once in outcome aggregation
// ---------------------------------------------------------------------------

describe('duplicate session for same skill', () => {
  it('counts a repeated session_id only once in outcome aggregation', async () => {
    // Same session_id selected the skill 3 times — outcomes accumulated once
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 4, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    // Outcome from sess-001 should appear once, not 3 times
    expect(result.bySkill.discovery.outcomes.complete).toBe(4);
    // sessionsJoined should be 1 not 3
    expect(result.sessionsJoined).toBe(1);
  });

  it('selections count reflects all invocations including duplicates', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 4, partial: 0, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    // selections counts every invocation
    expect(result.bySkill.discovery.selections).toBe(3);
    expect(result.totalSelections).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// J6 — null session_id on invocation → unknown bucket
// ---------------------------------------------------------------------------

describe('null session_id on invocation', () => {
  it('buckets the invocation as unknown when session_id is null', async () => {
    appendInv({ skill: 'discovery', session_id: null });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.outcomes.unknown).toBe(1);
    expect(result.sessionsUnknown).toBe(1);
  });

  it('does not add null to bySkill.discovery.sessions array', async () => {
    appendInv({ skill: 'discovery', session_id: null });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.discovery.sessions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// J7 — multiple skills, correct per-skill bucketing
// ---------------------------------------------------------------------------

describe('multiple skills', () => {
  it('bySkill has one entry per distinct skill', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'test', session_id: 'sess-002' });
    appendInv({ skill: 'discovery', session_id: 'sess-003' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 } });
    appendSession({ session_id: 'sess-002', agent_summary: { complete: 0, partial: 1, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    const skills = Object.keys(result.bySkill).sort();
    expect(skills).toEqual(['discovery', 'test']);
  });

  it('bySkill.test.outcomes.partial reflects the test-skill session only', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'test', session_id: 'sess-002' });
    appendSession({ session_id: 'sess-001', agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 } });
    appendSession({ session_id: 'sess-002', agent_summary: { complete: 0, partial: 3, failed: 0, spiral: 0 } });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.bySkill.test.outcomes.partial).toBe(3);
    expect(result.bySkill.test.outcomes.complete).toBe(0);
    expect(result.bySkill.discovery.outcomes.complete).toBe(1);
  });

  it('totalSelections equals the sum of all skill invocations', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendInv({ skill: 'test', session_id: 'sess-002' });
    appendInv({ skill: 'discovery', session_id: 'sess-003' });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    expect(result.totalSelections).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// J8 — outcome field summation from agent_summary
// ---------------------------------------------------------------------------

describe('agent_summary field summation', () => {
  it('sums complete, partial, failed, spiral from agent_summary into outcomes', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendSession({
      session_id: 'sess-001',
      agent_summary: { complete: 2, partial: 1, failed: 3, spiral: 1 },
    });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    const outcomes = result.bySkill.discovery.outcomes;
    expect(outcomes.complete).toBe(2);
    expect(outcomes.partial).toBe(1);
    expect(outcomes.failed).toBe(3);
    expect(outcomes.spiral).toBe(1);
    expect(outcomes.unknown).toBe(0);
  });

  it('treats missing agent_summary numeric fields as 0', async () => {
    appendInv({ skill: 'discovery', session_id: 'sess-001' });
    appendSession({
      session_id: 'sess-001',
      agent_summary: { complete: 2 }, // partial/failed/spiral absent
    });

    const result = await joinSkillOutcomes({ invocationsPath: invPath, sessionsPath: sessPath });
    const outcomes = result.bySkill.discovery.outcomes;
    expect(outcomes.complete).toBe(2);
    expect(outcomes.partial).toBe(0);
    expect(outcomes.failed).toBe(0);
    expect(outcomes.spiral).toBe(0);
  });
});
