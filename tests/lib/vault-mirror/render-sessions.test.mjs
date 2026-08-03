/**
 * Unit tests for scripts/lib/vault-mirror/render-sessions.mjs
 * Focus: detectSessionSchema, generateSessionNote, generateSessionNoteV2
 */

import { describe, it, expect } from 'vitest';
import {
  detectSessionSchema,
  normalizeSessionEntry,
  generateSessionNote,
  generateSessionNoteV2,
  generateSessionNoteV3,
  vaultStatusForSession,
  RENDERABLE_SESSION_FIELDS_V1,
  RENDERABLE_SESSION_FIELDS_V2,
  RENDERABLE_SESSION_FIELDS_V3,
} from '@lib/vault-mirror/render-sessions.mjs';
import { REQUIRED_FIELDS } from '@lib/session-schema/constants.mjs';
import { validateSession, ValidationError } from '@lib/session-schema/validator.mjs';

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
  // TV-003 consolidation: 9 near-identical required-field cases parametrized.
  // Both nullish forms stay covered — the guard tests `null || undefined`, so
  // each field is exercised with the form the original per-field test used.
  it.each([
    ['session_id', undefined], ['session_type', null], ['started_at', undefined],
    ['completed_at', null], ['total_waves', undefined], ['total_agents', null],
    ['total_files_changed', undefined], ['agent_summary', undefined], ['waves', null],
  ])('throws when required field "%s" is missing', (field, nullish) => {
    expect(() => generateSessionNote(makeV1Entry({ [field]: nullish }))).toThrow(
      `missing required field '${field}'`,
    );
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

  it('#732: emits source-repo line in frontmatter when options.repoNs is set', () => {
    const out = generateSessionNote(makeV1Entry(), { repoNs: 'session-orchestrator' });
    expect(out).toMatch(/^source-repo: session-orchestrator$/m);
  });

  it('#732: does not emit source-repo line when options.repoNs is absent', () => {
    const out = generateSessionNote(makeV1Entry(), {});
    expect(out).not.toMatch(/^source-repo: /m);
  });

  it('#732: no longer emits the legacy repo: field, even when repoNs is set', () => {
    const out = generateSessionNote(makeV1Entry(), { repoNs: 'session-orchestrator' });
    expect(out).not.toMatch(/^repo: /m);
  });

  it('#732: an arbitrary repoNs value (e.g. a pseudonym-mapped alias) reaches source-repo verbatim', () => {
    // Mirrors the D5 pattern in render-learnings.test.mjs: the renderer does not
    // care whether repoNs came from a plain slug or a pseudonym map — it just
    // emits whatever string it is given. The pseudonym MAPPING mechanism itself
    // (and its CP1/CP6/CP10 leak-detection fixtures) is exhaustively tested in
    // namespace.test.mjs; this asserts only the render contract, using a
    // synthetic (non-owner-leaky) alias so this file needn't carry a real
    // private-slug literal.
    const out = generateSessionNote(makeV1Entry(), { repoNs: 'alpha-team' });
    expect(out).toMatch(/^source-repo: alpha-team$/m);
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

  it('#732: emits source-repo line in frontmatter when options.repoNs is set', () => {
    const out = generateSessionNoteV2(makeV2Entry(), { repoNs: 'name' });
    expect(out).toMatch(/^source-repo: name$/m);
  });

  it('#732: does not emit source-repo line when options.repoNs is absent', () => {
    const out = generateSessionNoteV2(makeV2Entry(), {});
    expect(out).not.toMatch(/^source-repo: /m);
  });

  it('#732: no longer emits the legacy repo: field, even when repoNs is set', () => {
    const out = generateSessionNoteV2(makeV2Entry(), { repoNs: 'name' });
    expect(out).not.toMatch(/^repo: /m);
  });

  it('#793: falls back to "n/a" (not "0") when effectiveness.carryover is absent', () => {
    const out = generateSessionNoteV2(makeV2Entry({ effectiveness: { completion_rate: 1.0 } }));
    expect(out).toContain('carryover=n/a');
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

  it('#732: emits source-repo line in frontmatter when options.repoNs is set', () => {
    const out = generateSessionNoteV3(makeV3Entry(), { repoNs: 'name' });
    expect(out).toMatch(/^source-repo: name$/m);
  });

  it('#732: does not emit source-repo line when options.repoNs is absent', () => {
    const out = generateSessionNoteV3(makeV3Entry(), {});
    expect(out).not.toMatch(/^source-repo: /m);
    expect(out).not.toContain('source-repo: undefined');
  });

  it('#732: no longer emits the legacy repo: field, even when repoNs is set', () => {
    const out = generateSessionNoteV3(makeV3Entry(), { repoNs: 'name' });
    expect(out).not.toMatch(/^repo: /m);
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

// ── normalizeSessionEntry (#635) ──────────────────────────────────────────────

describe('normalizeSessionEntry (#635 producer-alias normalization)', () => {
  it('maps ended_at to completed_at when completed_at is missing', () => {
    const e = normalizeSessionEntry({ session_id: 's', ended_at: '2026-05-01T10:00:00Z' });
    expect(e.completed_at).toBe('2026-05-01T10:00:00Z');
  });

  it('does not overwrite an existing completed_at', () => {
    const e = normalizeSessionEntry({ session_id: 's', completed_at: 'KEEP', ended_at: 'ALIAS' });
    expect(e.completed_at).toBe('KEEP');
  });

  it('maps mode to session_type when session_type is missing', () => {
    const e = normalizeSessionEntry({ session_id: 's', mode: 'housekeeping' });
    expect(e.session_type).toBe('housekeeping');
  });

  it('does not overwrite an existing session_type', () => {
    const e = normalizeSessionEntry({ session_id: 's', session_type: 'deep', mode: 'housekeeping' });
    expect(e.session_type).toBe('deep');
  });

  it('fills scalar waves from total_waves so the entry routes to v3', () => {
    const e = normalizeSessionEntry({ session_id: 's', total_waves: 5 });
    expect(e.waves).toBe(5);
    expect(detectSessionSchema(e)).toBe('v3');
  });

  it('falls back to waves_completed when total_waves is absent', () => {
    const e = normalizeSessionEntry({ session_id: 's', waves_completed: 3 });
    expect(e.waves).toBe(3);
  });

  it('defaults waves to 0 when no wave info exists at all (coordinator-direct)', () => {
    const e = normalizeSessionEntry({ session_id: 's' });
    expect(e.waves).toBe(0);
    expect(detectSessionSchema(e)).toBe('v3');
  });

  it('never touches an existing waves array (v1/v2 pass-through)', () => {
    const waves = [{ wave: 1, role: 'discovery', agent_count: 2, files_changed: 0, quality: 'pass' }];
    const e = normalizeSessionEntry({ session_id: 's', total_waves: 1, waves });
    expect(e.waves).toBe(waves);
  });

  it('never touches an existing scalar waves (v3 pass-through)', () => {
    const e = normalizeSessionEntry({ session_id: 's', waves: 4, total_waves: 9 });
    expect(e.waves).toBe(4);
  });

  it('passes a fully canonical v3 entry through unchanged', () => {
    const v3 = {
      session_id: 'main-2026-06-10-deep-1',
      session_type: 'deep',
      started_at: '2026-06-10T12:55:00Z',
      completed_at: '2026-06-10T14:46:03Z',
      waves: 5,
      effectiveness: { completion_rate: 1, carryover: 0 },
    };
    expect(normalizeSessionEntry(v3)).toEqual(v3);
  });

  it('does not mutate the input entry', () => {
    const raw = { session_id: 's', ended_at: 'E', mode: 'deep', total_waves: 2 };
    const frozen = JSON.parse(JSON.stringify(raw));
    normalizeSessionEntry(raw);
    expect(raw).toEqual(frozen);
  });

  it('returns null/undefined input unchanged', () => {
    expect(normalizeSessionEntry(null)).toBe(null);
    expect(normalizeSessionEntry(undefined)).toBe(undefined);
  });

  it('renders the ended_at/mode/total_waves producer shape via v3 after normalization', () => {
    const raw = {
      session_id: 'main-2026-05-12-session-2',
      mode: 'housekeeping',
      started_at: '2026-05-12T09:00:00Z',
      ended_at: '2026-05-12T10:30:00Z',
      total_waves: 1,
      branch: 'main',
      effectiveness: { completion_rate: 1, carryover: 0, completed_issues: 2 },
      quality_gates: { tests: 'pass' },
    };
    const e = normalizeSessionEntry(raw);
    expect(detectSessionSchema(e)).toBe('v3');
    expect(() => generateSessionNoteV3(e, { repoNs: 'org-repo' })).not.toThrow();
  });

  it('renders the waves_completed/files_changed_total producer shape after normalization', () => {
    const raw = {
      session_id: 'main-2026-05-08-deep-1',
      session_type: 'deep',
      started_at: '2026-05-08T09:00:00Z',
      completed_at: '2026-05-08T12:00:00Z',
      total_waves: 5,
      waves_completed: 5,
      files_changed_total: 12,
      agent_summary: { complete: 10, partial: 0, failed: 0 },
      effectiveness: { completion_rate: 1, carryover: 0 },
      issues_planned: [1, 2],
      recommendations: [],
    };
    const e = normalizeSessionEntry(raw);
    expect(detectSessionSchema(e)).toBe('v3');
    expect(() => generateSessionNoteV3(e, { repoNs: 'org-repo' })).not.toThrow();
  });
});

// ── #909: vault `status` reflects the real ledger status ──────────────────────
//
// All three generators previously hard-coded `status: verified` and never read
// `entry.status`, so every mirrored session claimed "verified" no matter how it
// ended. These tests pin the mapping AND the invariant that makes it mandatory:
// the ledger enum (completed|abandoned) and the vault enum are DISJOINT, so a
// raw pass-through would emit an off-schema value and hard-fail vault-sync.

describe('#909 vaultStatusForSession — ledger status → vault status mapping', () => {
  // Source of truth: vaultNoteStatusSchema, skills/vault-sync/validator.mjs.
  // A value outside this set hard-fails vault-sync (session-end Phase 1 gate).
  const VAULT_STATUS_ENUM = ['draft', 'active', 'verified', 'archived', 'production', 'mvp', 'idea'];

  it('maps completed → verified', () => {
    expect(vaultStatusForSession({ status: 'completed' })).toBe('verified');
  });

  it('maps abandoned → draft (the phantom-stub case that must never claim verified)', () => {
    expect(vaultStatusForSession({ status: 'abandoned' })).toBe('draft');
  });

  it('maps an absent status → verified, keeping pre-#724 notes byte-identical', () => {
    expect(vaultStatusForSession({ session_id: 'x' })).toBe('verified');
    expect(vaultStatusForSession({ status: null })).toBe('verified');
    expect(vaultStatusForSession({ status: '' })).toBe('verified');
  });

  it('maps an unrecognised ledger status → draft, never the raw off-schema value', () => {
    // The ledger enum is additive-optional and has grown once already (#724).
    // Passing a future value through verbatim would write `status: interrupted`
    // into frontmatter and hard-fail vault-sync.
    expect(vaultStatusForSession({ status: 'interrupted' })).toBe('draft');
  });

  it('never returns an inherited Object.prototype member for a hostile status string', () => {
    // A bare `MAP[raw]` lookup returns a FUNCTION for 'constructor'/'toString',
    // which would interpolate `function Object() { [native code] }` into YAML.
    expect(vaultStatusForSession({ status: 'constructor' })).toBe('draft');
    expect(vaultStatusForSession({ status: 'toString' })).toBe('draft');
    expect(vaultStatusForSession({ status: '__proto__' })).toBe('draft');
  });

  it('returns a schema-legal value for every input, including non-objects', () => {
    for (const input of [null, undefined, 'abandoned', 42, [], { status: 'completed' }, { status: {} }]) {
      expect(VAULT_STATUS_ENUM).toContain(vaultStatusForSession(input));
    }
  });
});

describe('#909 generators emit the mapped status in BOTH frontmatter and tag', () => {
  const statusLine = (md) => (md.match(/^status: (.*)$/m) || [])[1];
  const tagsLine = (md) => (md.match(/^tags: (.*)$/m) || [])[1];

  const RENDERERS = [
    ['v1', generateSessionNote, makeV1Entry],
    ['v2', generateSessionNoteV2, makeV2Entry],
    ['v3', generateSessionNoteV3, makeV3Entry],
  ];

  for (const [label, render, makeEntry] of RENDERERS) {
    it(`${label}: an abandoned session renders status draft, not verified`, () => {
      const md = render(makeEntry({ status: 'abandoned' }));
      expect(statusLine(md)).toBe('draft');
      expect(tagsLine(md)).toContain('status/draft');
      expect(tagsLine(md)).not.toContain('status/verified');
    });

    it(`${label}: an unrecognised status renders draft, not the raw value`, () => {
      const md = render(makeEntry({ status: 'interrupted' }));
      expect(statusLine(md)).toBe('draft');
      expect(md).not.toContain('status: interrupted');
    });

    it(`${label}: a completed session still renders verified`, () => {
      const md = render(makeEntry({ status: 'completed' }));
      expect(statusLine(md)).toBe('verified');
      expect(tagsLine(md)).toContain('status/verified');
    });

    it(`${label}: a status-less record still renders verified (no re-write churn)`, () => {
      const md = render(makeEntry());
      expect(statusLine(md)).toBe('verified');
      expect(tagsLine(md)).toContain('status/verified');
    });
  }
});

// ── M1: absent optional fields must never render as the literal "undefined" ───

describe('M1 v1 generator — absent optional fields render a placeholder, not "undefined"', () => {
  /**
   * The bug: only `wave` and `role` are schema-required per wave, and every
   * `effectiveness` sub-field is optional, but the v1 generator interpolated
   * all of them raw — so a real ledger record wrote `| 1 | Impl-Core A | 6 |
   * undefined | undefined |` into a vault note a human reads. The v2 generator
   * already guarded the same cells with `?? '?'`; only the v1 path lacked it.
   */
  it('renders no literal "undefined"/"NaN" when waves and effectiveness omit optional fields', () => {
    const md = generateSessionNote(
      makeV1Entry({
        // Shape of the real repaired ledger records: agent_count present,
        // files_changed + quality absent; effectiveness carries only the
        // `completed_issues` alias and no completion_rate/emergent.
        waves: [{ wave: 1, role: 'Impl-Core A', agent_count: 6 }],
        effectiveness: { planned_issues: 16, completed_issues: 16, carryover: 0 },
      }),
    );

    expect(md).not.toMatch(/undefined|NaN/);
    expect(md).toContain('| 1 | Impl-Core A | 6 | ? | ? |');
    // planned/carryover survive; the alias supplies `completed`; the two
    // genuinely-absent values degrade to the same token v2/v3 already use.
    expect(md).toContain(
      '- **Effectiveness:** planned=16, completed=16, carryover=0, emergent=n/a, rate=n/a',
    );
  });

  /**
   * The absent-vs-measured-zero distinction. `??` is load-bearing here: with
   * `||` every one of these real zeros would render as `?`/`n/a`, i.e. the
   * generator would claim "unknown" about a value that WAS measured.
   */
  it('renders a measured 0 as 0, never as the missing-value placeholder', () => {
    const md = generateSessionNote(
      makeV1Entry({
        waves: [{ wave: 1, role: 'Finalization', agent_count: 0, files_changed: 0, quality: 0 }],
        effectiveness: { planned_issues: 0, completed: 0, carryover: 0, emergent: 0, completion_rate: 0 },
      }),
    );

    expect(md).toContain('| 1 | Finalization | 0 | 0 | 0 |');
    expect(md).toContain(
      '- **Effectiveness:** planned=0, completed=0, carryover=0, emergent=0, rate=0%',
    );
    expect(md).not.toContain('?');
    expect(md).not.toContain('n/a');
  });
});

// ── #968 v3 generator — absent optional fields must not claim a measured zero ──

describe('#968 v3 generator — an ABSENT value renders a placeholder, never 0', () => {
  /**
   * Nameable bug (TV-001): v3 defaulted `emergent` to `0` (`?? 0`) and
   * destructured `agent_summary` with `= 0` defaults over a `{}` fallback. A
   * record whose producer never wrote those fields therefore rendered
   * "emergent=0" and "Complete: 0 · Partial: 0 · Failed: 0 · Spiral: 0" — a
   * verified-looking zero asserted about something never measured, in a note a
   * human reads. v3 already used 'n/a' for its neighbours (`carryover` used
   * `?? 'n/a'` one line above `emergent`'s `?? 0`), so this was an inconsistency
   * INSIDE v3. No pre-existing test caught it because `makeV3Entry()` supplies
   * every value.
   */
  it('renders emergent=n/a when neither unplanned_finds nor emergent was written', () => {
    const md = generateSessionNoteV3(
      makeV3Entry({ effectiveness: { completion_rate: 1, completed_issues: 2, carryover: 0 } }),
    );
    expect(md).toContain('carryover=0, emergent=n/a, rate=100%');
  });

  it('renders the agent summary as n/a when agent_summary is absent entirely', () => {
    const md = generateSessionNoteV3(makeV3Entry({ agent_summary: undefined }));
    expect(md).toContain('Complete: n/a · Partial: n/a · Failed: n/a · Spiral: n/a');
  });

  /**
   * The other half of the same distinction, mirroring the v1 pair above: `??`
   * (never `||`) means a MEASURED zero still renders `0`. Without this, the fix
   * for the two tests above could be "always print n/a", which is a worse bug.
   */
  it('still renders a measured 0 as 0, not as the placeholder', () => {
    const md = generateSessionNoteV3(
      makeV3Entry({
        effectiveness: { completion_rate: 0, completed_issues: 0, carryover: 0, unplanned_finds: 0 },
        agent_summary: { complete: 0, partial: 0, failed: 0, spiral: 0 },
      }),
    );
    expect(md).toContain('completed=0, carryover=0, emergent=0, rate=0%');
    expect(md).toContain('Complete: 0 · Partial: 0 · Failed: 0 · Spiral: 0');
    expect(md).not.toContain('n/a');
  });
});

// ── #964 the five validator faces — mechanical superset invariant ─────────────

describe('#964 generator required-field sets vs the write-path schema', () => {
  /**
   * Nameable bug (TV-001): a generator that renders write-path-valid records
   * requires a DIFFERENT field set than `validateSession`, so a record the
   * writer accepts silently gets no vault note. Before this test the repo held
   * five independent notions of "a valid session record" — `REQUIRED_FIELDS`
   * plus three function-local generator lists plus the integrity banner — with
   * no mechanical relationship between any of them.
   *
   * The invariant is NOT "all four lists are equal". Renderable is strictly
   * stronger than schema-valid (see render-sessions.mjs header), so the correct
   * assertion is SUPERSET, in one direction only.
   */
  it('v1 requires a superset of REQUIRED_FIELDS — every writable record is renderable', () => {
    const missing = REQUIRED_FIELDS.filter((f) => !RENDERABLE_SESSION_FIELDS_V1.includes(f));
    expect(missing).toEqual([]);
  });

  it('v1 is stronger than the schema by exactly effectiveness', () => {
    const extra = RENDERABLE_SESSION_FIELDS_V1.filter((f) => !REQUIRED_FIELDS.includes(f));
    expect(extra).toEqual(['effectiveness']);
  });

  /**
   * v2 and v3 require FEWER fields than `REQUIRED_FIELDS`. That is an EARNED
   * carve-out, not an oversight — and it is earned by measurement, not by this
   * comment: each routing predicate is mutually exclusive with `validateSession`,
   * so no schema-valid record can ever reach those generators. If a future edit
   * makes one of them reachable, the witness below goes red and the carve-out
   * must be re-justified or the list widened to the superset.
   *
   * v3's exclusion is the sharpest: `_validateWaves` throws unless
   * `Array.isArray(waves)`; `generateSessionNoteV3` throws unless
   * `typeof waves === 'number'`. No value is both.
   */
  const WRITE_PATH_UNREACHABLE = [
    // [label, list, a witness entry that ROUTES there, the routing field]
    ['v2', RENDERABLE_SESSION_FIELDS_V2, { ...makeV1Entry(), total_agents: undefined, files_changed: 12 }],
    ['v3', RENDERABLE_SESSION_FIELDS_V3, { ...makeV1Entry(), waves: 5 }],
  ];

  it.each(WRITE_PATH_UNREACHABLE)(
    '%s: carve-out is earned — its routing predicate and validateSession are mutually exclusive',
    (label, _list, witness) => {
      expect(detectSessionSchema(witness)).toBe(label);
      expect(() => validateSession(witness)).toThrow(ValidationError);
    },
  );

  it.each(WRITE_PATH_UNREACHABLE)(
    '%s: the carve-out is real — it omits fields REQUIRED_FIELDS mandates',
    (_label, list) => {
      const missing = REQUIRED_FIELDS.filter((f) => !list.includes(f));
      expect(missing).toEqual([
        'total_waves',
        'agent_summary',
        'total_agents',
        'total_files_changed',
      ]);
    },
  );

  it('a schema-valid record routes to v1, the generator the superset rule binds', () => {
    const valid = makeV1Entry();
    expect(() => validateSession(valid)).not.toThrow();
    expect(detectSessionSchema(normalizeSessionEntry(valid))).toBe('v1');
  });
});

// ── ABSENT IS NOT ZERO — the duration/commits sites (#969 LOW-1) ─────────────

describe('absent-is-not-zero: duration and commits', () => {
  // Bug this catches that nothing else in the suite does: a record lacking
  // `duration_seconds`/`duration_minutes` rendered `**Duration:** 0m` — a
  // claimed MEASURED zero, contradicted by the `started_at → completed_at` span
  // printed on the SAME line, and sitting beside four correct `n/a`s. Neither
  // duration field is in any RENDERABLE_SESSION_FIELDS_* list, so absence is
  // reachable in all three generators.
  //
  // It survived because every factory above supplies every value: the three
  // `?? 0` defaults were only reachable from a record no existing test built.
  // Deleting a key from the factory is therefore the whole point of these rows.
  //
  // The `0` rows are the other half of the guard, and the reason this is `??`
  // and not `||`: swapping in `||` turns a genuinely measured zero into `n/a`,
  // which is the same absent/measured confusion pointing the other way.
  it.each([
    ['v1', generateSessionNote, makeV1Entry, ['duration_seconds']],
    ['v2', generateSessionNoteV2, makeV2Entry, ['duration_seconds']],
    ['v3', generateSessionNoteV3, makeV3Entry, ['duration_minutes', 'duration_seconds']],
  ])('%s renders n/a — not 0m — when every duration field is absent', (_v, generate, make, durationKeys) => {
    const entry = make();
    for (const key of durationKeys) delete entry[key];
    const out = generate(entry);
    expect(out).toContain('**Duration:** n/a (');
    expect(out).not.toContain('**Duration:** 0m');
  });

  // Consolidated here from two standalone v3 duration tests (`renders duration
  // from duration_minutes` / `falls back to duration_seconds when
  // duration_minutes is absent`): every case is one input to the same
  // `renderDuration`, so one table covers the value space the two singletons
  // covered plus the measured-zero rows the `??` chain exists for.
  it.each([
    ['v1 measured zero', generateSessionNote, makeV1Entry, { duration_seconds: 0 }, '0m'],
    ['v2 measured zero', generateSessionNoteV2, makeV2Entry, { duration_seconds: 0 }, '0m'],
    ['v3 measured zero', generateSessionNoteV3, makeV3Entry, { duration_minutes: 0 }, '0m'],
    ['v1 rounds duration_seconds', generateSessionNote, makeV1Entry, { duration_seconds: 7200 }, '120m'],
    ['v3 prefers duration_minutes', generateSessionNoteV3, makeV3Entry, { duration_seconds: 99999 }, '86m'],
    ['v3 falls back to duration_seconds', generateSessionNoteV3, makeV3Entry, { duration_minutes: undefined, duration_seconds: 120 }, '2m'],
  ])('%s → renders the measured value, never n/a', (_v, generate, make, overrides, expected) => {
    expect(generate(make(overrides))).toContain(`**Duration:** ${expected}`);
  });

  it('v3 renders commits as n/a when absent and 0 when recorded-but-empty', () => {
    // Absent array = "not recorded"; empty array = "recorded, and there were
    // none". The old `: 0` gave the second answer to the first question.
    const absent = makeV3Entry();
    delete absent.commits;
    expect(generateSessionNoteV3(absent)).toContain('**Commits:** n/a');
    expect(generateSessionNoteV3(makeV3Entry({ commits: [] }))).toContain('**Commits:** 0');
  });
});
