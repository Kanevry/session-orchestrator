/**
 * Unit tests for scripts/lib/vault-mirror/render-sessions.mjs
 * Focus: detectSessionSchema, generateSessionNote, generateSessionNoteV2
 */

import { describe, it, expect } from 'vitest';
import {
  detectSessionSchema,
  generateSessionNote,
  generateSessionNoteV2,
  generateSessionNoteV3,
} from '@lib/vault-mirror/render-sessions.mjs';

// ── detectSessionSchema ───────────────────────────────────────────────────────

describe('detectSessionSchema', () => {
  it('returns "v2" when total_agents is undefined and files_changed is present', () => {
    expect(detectSessionSchema({ files_changed: 5 })).toBe('v2');
  });

  it('returns "v1" when total_agents is present', () => {
    expect(detectSessionSchema({ total_agents: 4, files_changed: 5 })).toBe('v1');
  });

  it('returns "v1" when entry is null', () => {
    expect(detectSessionSchema(null)).toBe('v1');
  });

  it('returns "v1" when files_changed is absent and total_agents is absent', () => {
    // Both absent → condition `total_agents === undefined && files_changed !== undefined` = false
    expect(detectSessionSchema({ session_id: 'test' })).toBe('v1');
  });

  it('returns "v3" when waves is a scalar number (coordinator-direct record) (#491)', () => {
    expect(detectSessionSchema({ waves: 5, agents_dispatched: 18 })).toBe('v3');
  });

  it('returns "v3" for a scalar-waves record even when total_agents is also present', () => {
    expect(detectSessionSchema({ waves: 3, total_agents: 6 })).toBe('v3');
  });

  it('still returns "v2" when waves is an array and total_agents is absent', () => {
    expect(detectSessionSchema({ waves: [{ wave: 1 }], files_changed: 5 })).toBe('v2');
  });

  it('still returns "v1" when waves is an array and total_agents is present', () => {
    expect(detectSessionSchema({ waves: [{ wave: 1 }], total_agents: 4, files_changed: 5 })).toBe('v1');
  });
});

// ── generateSessionNote (v1) ──────────────────────────────────────────────────

function makeV1Entry(overrides = {}) {
  return {
    session_id: 'session-2026-04-13',
    session_type: 'feature',
    platform: 'darwin',
    started_at: '2026-04-13T08:00:00Z',
    completed_at: '2026-04-13T10:00:00Z',
    duration_seconds: 7200,
    total_waves: 3,
    total_agents: 6,
    total_files_changed: 12,
    agent_summary: { complete: 5, partial: 1, failed: 0, spiral: 0 },
    waves: [
      { wave: 1, role: 'Planning', agent_count: 1, files_changed: 2, quality: 'ok' },
    ],
    effectiveness: { planned_issues: 3, completed: 3, carryover: 0, emergent: 1, completion_rate: 1.0 },
    ...overrides,
  };
}

describe('generateSessionNote (v1)', () => {
  it('throws when required field "session_id" is missing', () => {
    expect(() => generateSessionNote(makeV1Entry({ session_id: undefined }))).toThrow("missing required field 'session_id'");
  });

  it('throws when required field "session_type" is null', () => {
    expect(() => generateSessionNote(makeV1Entry({ session_type: null }))).toThrow("missing required field 'session_type'");
  });

  it('throws when required field "started_at" is undefined', () => {
    expect(() => generateSessionNote(makeV1Entry({ started_at: undefined }))).toThrow("missing required field 'started_at'");
  });

  it('throws when required field "completed_at" is null', () => {
    expect(() => generateSessionNote(makeV1Entry({ completed_at: null }))).toThrow("missing required field 'completed_at'");
  });

  it('throws when required field "total_waves" is undefined', () => {
    expect(() => generateSessionNote(makeV1Entry({ total_waves: undefined }))).toThrow("missing required field 'total_waves'");
  });

  it('throws when required field "total_agents" is null', () => {
    expect(() => generateSessionNote(makeV1Entry({ total_agents: null }))).toThrow("missing required field 'total_agents'");
  });

  it('throws when required field "total_files_changed" is undefined', () => {
    expect(() => generateSessionNote(makeV1Entry({ total_files_changed: undefined }))).toThrow("missing required field 'total_files_changed'");
  });

  it('throws when required field "agent_summary" is undefined', () => {
    expect(() => generateSessionNote(makeV1Entry({ agent_summary: undefined }))).toThrow("missing required field 'agent_summary'");
  });

  it('throws when required field "waves" is null', () => {
    expect(() => generateSessionNote(makeV1Entry({ waves: null }))).toThrow("missing required field 'waves'");
  });

  it('throws when effectiveness is not an object (string value)', () => {
    expect(() => generateSessionNote(makeV1Entry({ effectiveness: 'bad' }))).toThrow("missing nested field 'effectiveness'");
  });

  it('throws when agent_summary is not an object (number value)', () => {
    expect(() => generateSessionNote(makeV1Entry({ agent_summary: 42 }))).toThrow("missing nested field 'agent_summary'");
  });

  it('throws when waves is not an array (object value)', () => {
    expect(() => generateSessionNote(makeV1Entry({ waves: { not: 'array' } }))).toThrow("missing nested field 'waves'");
  });

  it('rounds duration_seconds=null to 0m', () => {
    const out = generateSessionNote(makeV1Entry({ duration_seconds: null }));
    expect(out).toContain('**Duration:** 0m');
  });

  it('rounds completion_rate 0.999 to 100%', () => {
    const out = generateSessionNote(makeV1Entry({
      effectiveness: { planned_issues: 5, completed: 5, carryover: 0, emergent: 0, completion_rate: 0.999 },
    }));
    expect(out).toContain('rate=100%');
  });

  it('skips platform bullet when platform is undefined (regression #343)', () => {
    const entry = makeV1Entry();
    delete entry.platform;
    const out = generateSessionNote(entry);
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('**Platform:**');
  });

  it('includes platform bullet when platform is defined', () => {
    const out = generateSessionNote(makeV1Entry({ platform: 'darwin' }));
    expect(out).toContain('**Platform:** darwin');
  });

  it('emits repo line in frontmatter when options.repo is set', () => {
    const out = generateSessionNote(makeV1Entry(), { repo: 'Kanevry/session-orchestrator' });
    expect(out).toMatch(/^repo: Kanevry\/session-orchestrator$/m);
  });

  it('does not emit repo line when options.repo is absent', () => {
    const out = generateSessionNote(makeV1Entry(), {});
    expect(out).not.toMatch(/^repo: /m);
  });

  it('emits the generator marker', () => {
    const out = generateSessionNote(makeV1Entry());
    expect(out).toContain('_generator: session-orchestrator-vault-mirror@1');
  });
});

// ── generateSessionNoteV2 ─────────────────────────────────────────────────────

function makeV2Entry(overrides = {}) {
  return {
    session_id: 'main-2026-04-19-0608',
    session_type: 'deep',
    started_at: '2026-04-19T06:08:00Z',
    completed_at: '2026-04-19T06:35:00Z',
    duration_seconds: 1968,
    branch: 'main',
    planned_issues: 2,
    files_changed: 7,
    waves: [
      { wave: 1, role: 'Discovery', agents: 4, dispatch: 'parallel', duration_s: 180, agents_done: 4, agents_partial: 0, agents_failed: 0 },
    ],
    issues_closed: [44],
    issues_created: [179],
    effectiveness: { completion_rate: 1.0, carryover: 0 },
    ...overrides,
  };
}

describe('generateSessionNoteV2', () => {
  it('throws when required field "session_id" is undefined', () => {
    expect(() => generateSessionNoteV2(makeV2Entry({ session_id: undefined }))).toThrow("missing required field 'session_id'");
  });

  it('throws when required field "waves" is null', () => {
    expect(() => generateSessionNoteV2(makeV2Entry({ waves: null }))).toThrow("missing required field 'waves'");
  });

  it('throws when waves is not an array', () => {
    expect(() => generateSessionNoteV2(makeV2Entry({ waves: {} }))).toThrow("'waves' must be an array");
  });

  it('throws when effectiveness is null', () => {
    expect(() => generateSessionNoteV2(makeV2Entry({ effectiveness: null }))).toThrow("missing required field 'effectiveness'");
  });

  it('uses em-dash when issues_closed is empty array', () => {
    const out = generateSessionNoteV2(makeV2Entry({ issues_closed: [] }));
    expect(out).toContain('**Issues closed:** —');
  });

  it('uses em-dash when issues_closed is absent', () => {
    const out = generateSessionNoteV2(makeV2Entry({ issues_closed: undefined }));
    expect(out).toContain('**Issues closed:** —');
  });

  it('omits notes block when notes is null', () => {
    const out = generateSessionNoteV2(makeV2Entry({ notes: null }));
    expect(out).not.toContain('## Notes');
  });

  it('omits notes block when notes is absent', () => {
    const out = generateSessionNoteV2(makeV2Entry());
    expect(out).not.toContain('## Notes');
  });

  it('includes notes block when notes is provided', () => {
    const out = generateSessionNoteV2(makeV2Entry({ notes: 'My special note.' }));
    expect(out).toContain('## Notes');
    expect(out).toContain('My special note.');
  });

  it('emits repo line in frontmatter when options.repo is set', () => {
    const out = generateSessionNoteV2(makeV2Entry(), { repo: 'org/name' });
    expect(out).toMatch(/^repo: org\/name$/m);
  });

  it('does not emit repo line when options.repo is absent', () => {
    const out = generateSessionNoteV2(makeV2Entry(), {});
    expect(out).not.toMatch(/^repo: /m);
  });

  it('aggregates total agents from wave.agents fields', () => {
    const entry = makeV2Entry({
      waves: [
        { wave: 1, role: 'A', agents: 3, agents_done: 3, agents_partial: 0, agents_failed: 0, dispatch: 'parallel', duration_s: 100 },
        { wave: 2, role: 'B', agents: 5, agents_done: 5, agents_partial: 0, agents_failed: 0, dispatch: 'parallel', duration_s: 200 },
      ],
    });
    const out = generateSessionNoteV2(entry);
    expect(out).toContain('**Agents:** 8');
  });

  it('emits the generator marker', () => {
    const out = generateSessionNoteV2(makeV2Entry());
    expect(out).toContain('_generator: session-orchestrator-vault-mirror@1');
  });
});

// ── generateSessionNoteV3 (coordinator-direct, scalar waves) ──────────────────

// Mirrors the shape session-end actually writes to sessions.jsonl (#491).
function makeV3Entry(overrides = {}) {
  return {
    schema_version: 1,
    session_id: 'main-2026-05-28-deep-1',
    session_type: 'deep',
    branch: 'main',
    started_at: '2026-05-28T10:25:00.000Z',
    completed_at: '2026-05-28T11:51:31.000Z',
    duration_minutes: 86,
    waves: 5,
    agents_dispatched: 18,
    agents_max_parallel: 4,
    agent_summary: { complete: 18, partial: 0, failed: 0, spiral: 0 },
    planned_issues: 2,
    effectiveness: { completion_rate: 1, carryover_ratio: 0, completed_issues: 2, carryover: 0, unplanned_finds: 2 },
    commits: ['403e66a', 'ef82027', '913ff2d', 'a16ebcf', '36d4301'],
    issues_closed: [357, 227],
    follow_ups_filed: [487, 488, 489, 490],
    tests_added: 168,
    tests_total_pre: 4784,
    tests_total_post: 4952,
    total_waves: 5,
    ...overrides,
  };
}

describe('generateSessionNoteV3', () => {
  it('throws when required field "session_id" is undefined', () => {
    expect(() => generateSessionNoteV3(makeV3Entry({ session_id: undefined }))).toThrow("missing required field 'session_id'");
  });

  it('throws when required field "waves" is undefined', () => {
    expect(() => generateSessionNoteV3(makeV3Entry({ waves: undefined }))).toThrow("missing required field 'waves'");
  });

  it('throws when waves is an array (wrong shape for v3)', () => {
    expect(() => generateSessionNoteV3(makeV3Entry({ waves: [{ wave: 1 }] }))).toThrow("'waves' must be a number");
  });

  it('throws when effectiveness is null', () => {
    expect(() => generateSessionNoteV3(makeV3Entry({ effectiveness: null }))).toThrow("missing required field 'effectiveness'");
  });

  it('renders scalar waves and agents_dispatched in the summary line', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    expect(out).toContain('**Waves:** 5 · **Agents:** 18 · **Commits:** 5');
  });

  it('renders duration from duration_minutes', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    expect(out).toContain('**Duration:** 86m');
  });

  it('falls back to duration_seconds when duration_minutes is absent', () => {
    const entry = makeV3Entry({ duration_minutes: undefined, duration_seconds: 120 });
    const out = generateSessionNoteV3(entry);
    expect(out).toContain('**Duration:** 2m');
  });

  it('renders completion rate and effectiveness aggregates', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    expect(out).toContain('planned=2, completed=2, carryover=0, emergent=2, rate=100%');
  });

  it('renders the tests pre→post delta', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    expect(out).toContain('**Tests:** 4784 → 4952');
  });

  it('renders issues_closed and follow_ups_filed with # prefixes', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    expect(out).toContain('**Issues closed:** #357, #227');
    expect(out).toContain('**Follow-ups filed:** #487, #488, #489, #490');
  });

  it('uses em-dash when issues_closed is empty', () => {
    const out = generateSessionNoteV3(makeV3Entry({ issues_closed: [] }));
    expect(out).toContain('**Issues closed:** —');
  });

  it('renders the agent summary line', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    expect(out).toContain('Complete: 18 · Partial: 0 · Failed: 0 · Spiral: 0');
  });

  it('emits repo line in frontmatter when options.repo is set', () => {
    const out = generateSessionNoteV3(makeV3Entry(), { repo: 'org/name' });
    expect(out).toMatch(/^repo: org\/name$/m);
  });

  it('does not emit repo line when options.repo is absent', () => {
    const out = generateSessionNoteV3(makeV3Entry(), {});
    expect(out).not.toMatch(/^repo: /m);
    expect(out).not.toContain('repo: undefined');
  });

  it('emits the generator marker', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    expect(out).toContain('_generator: session-orchestrator-vault-mirror@1');
  });

  it('produces a narrative body over the 400-char quality-gate floor', () => {
    const out = generateSessionNoteV3(makeV3Entry());
    const narrative = out.replace(/^---[\s\S]*?---/m, '').trim();
    expect(narrative.length).toBeGreaterThan(400);
  });
});
