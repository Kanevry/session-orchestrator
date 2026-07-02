/**
 * Unit tests for scripts/lib/vault-mirror/render-learnings.mjs
 * Focus: detectLearningSchema, generateLearningNote, generateLearningNoteV2
 */

import { describe, it, expect } from 'vitest';
import {
  detectLearningSchema,
  normalizeLearningEntry,
  generateLearningNote,
  generateLearningNoteV2,
} from '@lib/vault-mirror/render-learnings.mjs';

// ── detectLearningSchema ──────────────────────────────────────────────────────

describe('detectLearningSchema', () => {
  it('returns "v2" when entry.text is a non-empty string', () => {
    expect(detectLearningSchema({ text: 'some insight' })).toBe('v2');
  });

  it('returns "v1" when entry.text is undefined', () => {
    expect(detectLearningSchema({ subject: 'foo', insight: 'bar' })).toBe('v1');
  });

  it('returns "v1" when entry.text is null', () => {
    expect(detectLearningSchema({ text: null, subject: 'foo' })).toBe('v1');
  });

  it('returns "v1" when entry.text is a number (not a string)', () => {
    expect(detectLearningSchema({ text: 0 })).toBe('v1');
  });

  it('returns "v1" when entry is null', () => {
    expect(detectLearningSchema(null)).toBe('v1');
  });

  it('returns "v2" when entry.text is an empty string (technically a string)', () => {
    // The check is `typeof entry.text === 'string'`, so even "" qualifies as v2
    expect(detectLearningSchema({ text: '' })).toBe('v2');
  });
});

// ── generateLearningNote (v1) ─────────────────────────────────────────────────

function makeV1Entry(overrides = {}) {
  return {
    id: 'a1b2c3d4-0001-4000-8000-000000000001',
    type: 'architectural',
    subject: 'cross-repo-deep-session',
    insight: 'Prefer explicit contracts over implicit coupling',
    evidence: 'Three modules broke when shared util changed',
    confidence: 0.9,
    source_session: 'session-2026-04-13',
    created_at: '2026-04-13T10:00:00Z',
    ...overrides,
  };
}

describe('generateLearningNote (v1)', () => {
  it('throws when required field "id" is missing', () => {
    const entry = makeV1Entry({ id: undefined });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'id'");
  });

  it('throws when required field "type" is null', () => {
    const entry = makeV1Entry({ type: null });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'type'");
  });

  it('throws when required field "subject" is undefined', () => {
    const entry = makeV1Entry({ subject: undefined });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'subject'");
  });

  it('throws when required field "insight" is null', () => {
    const entry = makeV1Entry({ insight: null });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'insight'");
  });

  it('throws when required field "evidence" is undefined', () => {
    const entry = makeV1Entry({ evidence: undefined });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'evidence'");
  });

  it('throws when required field "confidence" is undefined', () => {
    const entry = makeV1Entry({ confidence: undefined });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'confidence'");
  });

  it('throws when required field "source_session" is null', () => {
    const entry = makeV1Entry({ source_session: null });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'source_session'");
  });

  it('throws when required field "created_at" is undefined', () => {
    const entry = makeV1Entry({ created_at: undefined });
    expect(() => generateLearningNote(entry, 'slug')).toThrow("missing required field 'created_at'");
  });

  it('sets status to "verified" when confidence > 0.8', () => {
    const out = generateLearningNote(makeV1Entry({ confidence: 0.81 }), 'my-slug');
    expect(out).toContain('status: verified');
  });

  it('sets status to "draft" when confidence is exactly 0.8', () => {
    const out = generateLearningNote(makeV1Entry({ confidence: 0.8 }), 'my-slug');
    expect(out).toContain('status: draft');
  });

  it('truncates insight title at word boundary for long insights', () => {
    const longInsight = 'word '.repeat(20).trim(); // 99 chars, boundary before 80
    const out = generateLearningNote(makeV1Entry({ insight: longInsight }), 'my-slug');
    // Title must not exceed 80 chars in the raw value (before quoting)
    // "word word word word..." truncated at 80 chars to a word boundary
    expect(out).toMatch(/^title: /m);
    const titleLine = out.split('\n').find((l) => l.startsWith('title: '));
    expect(titleLine.length).toBeLessThanOrEqual(100); // after "title: " prefix and possible quotes
  });

  it('sanitises corrupted source_session "[object" to "object" in tags', () => {
    const out = generateLearningNote(makeV1Entry({ source_session: '[object' }), 'my-slug');
    expect(out).toContain('source/object');
    expect(out).not.toContain('source/[object');
  });

  it('omits expires line when expires_at is not set', () => {
    const out = generateLearningNote(makeV1Entry(), 'my-slug');
    expect(out).not.toContain('expires:');
  });

  it('includes expires line when expires_at is provided', () => {
    const out = generateLearningNote(makeV1Entry({ expires_at: '2027-04-13T00:00:00Z' }), 'my-slug');
    expect(out).toContain('expires: 2027-04-13');
  });

  it('quotes insight title in YAML when it contains a colon', () => {
    const out = generateLearningNote(makeV1Entry({ insight: 'Rule: always validate' }), 'my-slug');
    // The title line should have quotes around the value
    expect(out).toMatch(/^title: "Rule: always validate"$/m);
  });

  // ── #725 D2: source-repo attribution ────────────────────────────────────────

  it('#725 D2: emits source-repo line when opts.repoNs is provided', () => {
    const out = generateLearningNote(makeV1Entry(), 'my-slug', { repoNs: 'session-orchestrator' });
    expect(out).toContain('source-repo: session-orchestrator\n');
    // Placed inside the frontmatter, before the _generator marker.
    expect(out.indexOf('source-repo:')).toBeLessThan(out.indexOf('_generator:'));
  });

  it('#725 D2: omits source-repo line when opts.repoNs is absent (backward-compatible)', () => {
    const out = generateLearningNote(makeV1Entry(), 'my-slug');
    expect(out).not.toContain('source-repo:');
  });
});

// ── generateLearningNoteV2 ────────────────────────────────────────────────────

function makeV2Entry(overrides = {}) {
  return {
    id: 's69-compose-pids',
    type: 'gotcha',
    text: 'docker-compose cross-validates pids_limit',
    scope: 'infrastructure/docker',
    confidence: 0.85,
    first_seen: '2026-04-19',
    ...overrides,
  };
}

describe('generateLearningNoteV2', () => {
  it('throws when required field "id" is missing', () => {
    expect(() => generateLearningNoteV2(makeV2Entry({ id: undefined }), 'slug')).toThrow("missing required field 'id'");
  });

  it('throws when required field "type" is null', () => {
    expect(() => generateLearningNoteV2(makeV2Entry({ type: null }), 'slug')).toThrow("missing required field 'type'");
  });

  it('throws when required field "text" is undefined', () => {
    expect(() => generateLearningNoteV2(makeV2Entry({ text: undefined }), 'slug')).toThrow("missing required field 'text'");
  });

  it('throws when required field "scope" is null', () => {
    expect(() => generateLearningNoteV2(makeV2Entry({ scope: null }), 'slug')).toThrow("missing required field 'scope'");
  });

  it('throws when required field "confidence" is undefined', () => {
    expect(() => generateLearningNoteV2(makeV2Entry({ confidence: undefined }), 'slug')).toThrow("missing required field 'confidence'");
  });

  it('throws when required field "first_seen" is null', () => {
    expect(() => generateLearningNoteV2(makeV2Entry({ first_seen: null }), 'slug')).toThrow("missing required field 'first_seen'");
  });

  it('falls back to "unscoped" tag when scope slugifies to empty', () => {
    // All-special scope strips to empty → "unscoped"
    const out = generateLearningNoteV2(makeV2Entry({ scope: '!!!@@@' }), 'my-slug');
    expect(out).toContain('scope/unscoped');
  });

  it('derives scope tag from slugified scope value', () => {
    const out = generateLearningNoteV2(makeV2Entry({ scope: 'infrastructure/docker' }), 'my-slug');
    // subjectToSlug of "infrastructure/docker" → last segment "docker"
    expect(out).toContain('scope/docker');
  });

  it('sets status "verified" when confidence > 0.8', () => {
    const out = generateLearningNoteV2(makeV2Entry({ confidence: 0.9 }), 'my-slug');
    expect(out).toContain('status: verified');
  });

  it('sets status "draft" when confidence is exactly 0.8', () => {
    const out = generateLearningNoteV2(makeV2Entry({ confidence: 0.8 }), 'my-slug');
    expect(out).toContain('status: draft');
  });

  it('emits the generator marker in frontmatter', () => {
    const out = generateLearningNoteV2(makeV2Entry(), 'my-slug');
    expect(out).toContain('_generator: session-orchestrator-vault-mirror@1');
  });

  it('#725 D2: emits source-repo line when opts.repoNs is provided', () => {
    const out = generateLearningNoteV2(makeV2Entry(), 'my-slug', { repoNs: 'session-orchestrator' });
    expect(out).toContain('source-repo: session-orchestrator\n');
    expect(out.indexOf('source-repo:')).toBeLessThan(out.indexOf('_generator:'));
  });

  it('#725 D2: omits source-repo line when opts.repoNs is absent (backward-compatible)', () => {
    const out = generateLearningNoteV2(makeV2Entry(), 'my-slug');
    expect(out).not.toContain('source-repo:');
  });
});

// ── normalizeLearningEntry (#635) ─────────────────────────────────────────────

describe('normalizeLearningEntry (#635 producer-alias normalization)', () => {
  it('normalizes the summary/detail/sessions producer shape to renderable v1', () => {
    const raw = {
      id: 'count-drift-recurrence',
      type: 'recurring-issue',
      summary: 'Pinned artifact counts drift on catalog growth',
      detail: 'Use floor/ceiling range assertions for dynamically-grown artifact sets',
      sessions: ['main-2026-05-22T19-57-19-deep'],
      confidence: 0.9,
      created_at: '2026-05-22T20:00:00Z',
      updated_at: '2026-05-23T08:00:00Z',
    };
    const e = normalizeLearningEntry(raw);
    expect(e.subject).toBe('Pinned artifact counts drift on catalog growth');
    expect(e.insight).toBe('Use floor/ceiling range assertions for dynamically-grown artifact sets');
    expect(e.evidence).toBe('main-2026-05-22T19-57-19-deep');
    expect(e.source_session).toBe('main-2026-05-22T19-57-19-deep');
    expect(() => generateLearningNote(e, 'test-slug')).not.toThrow();
  });

  it('normalizes the description/rationale/files/session_id producer shape', () => {
    const raw = {
      id: 'hook-batching',
      type: 'proven-pattern',
      description: 'Hook batching pattern',
      rationale: 'Batch PostToolUse signals to avoid per-call overhead',
      files: ['hooks/post-edit-validate.mjs', 'hooks/post-tool-batch-wave-signal.mjs'],
      session_id: 'main-2026-05-17-deep-1',
      confidence: 0.8,
      created_at: '2026-05-17T10:00:00Z',
      next_review: '2026-06-17',
    };
    const e = normalizeLearningEntry(raw);
    expect(e.insight).toBe('Batch PostToolUse signals to avoid per-call overhead');
    expect(e.subject).toBe('Hook batching pattern');
    expect(e.evidence).toBe('hooks/post-edit-validate.mjs, hooks/post-tool-batch-wave-signal.mjs');
    expect(e.source_session).toBe('main-2026-05-17-deep-1');
    expect(() => generateLearningNote(e, 'test-slug')).not.toThrow();
  });

  it('derives id from subject slug and source_session from _provenance when id is missing', () => {
    const raw = {
      type: 'anti-pattern',
      subject: 'Dead fallback removal when primary parser matures',
      insight: 'Remove the fallback once the primary path is proven',
      evidence: 'grep transcript',
      _provenance: 'agent-proposed@W3-H-deep-4',
      confidence: 0.7,
      created_at: '2026-05-23T10:00:00Z',
      expires_at: '2026-06-23T10:00:00Z',
    };
    const e = normalizeLearningEntry(raw);
    expect(e.id).toBe('dead-fallback-removal-when-primary-parser-matures');
    expect(e.source_session).toBe('agent-proposed@W3-H-deep-4');
    expect(() => generateLearningNote(e, 'test-slug')).not.toThrow();
  });

  it('normalizes body/evidence_sessions shape with "unknown" source fallback', () => {
    const raw = {
      id: 'some-id',
      type: 'process-pattern',
      subject: 'A subject',
      body: 'The insight lives in body',
      evidence_sessions: ['main-2026-05-22-082624-housekeeping'],
      occurrences: 3,
      status: 'active',
      confidence: 0.9,
      created_at: '2026-05-22T08:00:00Z',
      last_seen: '2026-05-30T08:00:00Z',
    };
    const e = normalizeLearningEntry(raw);
    expect(e.insight).toBe('The insight lives in body');
    expect(e.evidence).toBe('main-2026-05-22-082624-housekeeping');
    expect(e.source_session).toBe('unknown');
    expect(() => generateLearningNote(e, 'test-slug')).not.toThrow();
  });

  it('maps narrative to insight', () => {
    const raw = {
      id: 'x', type: 'workflow', subject: 'S', narrative: 'Narrative insight',
      evidence: 'E', confidence: 0.9, created_at: '2026-05-01T00:00:00Z',
    };
    expect(normalizeLearningEntry(raw).insight).toBe('Narrative insight');
  });

  it('maps name to subject and description to insight (name/description family)', () => {
    const raw = {
      id: 'x', type: 'general', name: 'Short name', description: 'Longer description text',
      confidence: 0.9, created_at: '2026-05-01T00:00:00Z',
    };
    const e = normalizeLearningEntry(raw);
    expect(e.subject).toBe('Short name');
    expect(e.insight).toBe('Longer description text');
  });

  it('maps title to subject and body to insight (body/title/how_to_apply family)', () => {
    const raw = {
      id: 'x', type: 'general', title: 'A title', body: 'Body text', how_to_apply: 'Apply it so',
      confidence: 0.9, created_at: '2026-05-01T00:00:00Z',
    };
    const e = normalizeLearningEntry(raw);
    expect(e.subject).toBe('A title');
    expect(e.insight).toBe('Body text');
  });

  it('derives subject by truncating insight when only content is present (content/sessions family)', () => {
    const raw = {
      id: 'x', type: 'general', content: 'Content-only insight text',
      sessions: ['s-1', 's-2'], confidence: 0.9, created_at: '2026-05-01T00:00:00Z',
    };
    const e = normalizeLearningEntry(raw);
    expect(e.insight).toBe('Content-only insight text');
    expect(e.subject).toBe('Content-only insight text');
    expect(e.evidence).toBe('s-1, s-2');
    expect(e.source_session).toBe('s-1');
  });

  it('falls back created_at from first_seen, then last_seen, then updated_at', () => {
    const base = { id: 'x', type: 't', subject: 'S', insight: 'I', evidence: 'E', confidence: 0.9 };
    expect(normalizeLearningEntry({ ...base, first_seen: 'A', last_seen: 'B', updated_at: 'C' }).created_at).toBe('A');
    expect(normalizeLearningEntry({ ...base, last_seen: 'B', updated_at: 'C' }).created_at).toBe('B');
    expect(normalizeLearningEntry({ ...base, updated_at: 'C' }).created_at).toBe('C');
  });

  it('passes a canonical v1 entry through unchanged', () => {
    const v1 = {
      id: 'a1b2c3d4-0001-4000-8000-000000000001',
      type: 'architectural',
      subject: 'cross-repo-deep-session',
      insight: 'Prefer explicit contracts',
      evidence: 'Three modules broke',
      confidence: 0.9,
      source_session: 'session-2026-04-13',
      created_at: '2026-04-13T10:00:00Z',
    };
    expect(normalizeLearningEntry(v1)).toEqual(v1);
  });

  it('returns v2 entries (text field) untouched by reference', () => {
    const v2 = { id: 's69-x', type: 'pattern', text: 'v2 insight', scope: 'repo', confidence: 0.8, first_seen: '2026-05-01' };
    expect(normalizeLearningEntry(v2)).toBe(v2);
  });

  it('does not mutate the input entry', () => {
    const raw = { id: 'x', type: 't', summary: 'S', detail: 'D', confidence: 0.9, created_at: '2026-05-01T00:00:00Z' };
    const frozen = JSON.parse(JSON.stringify(raw));
    normalizeLearningEntry(raw);
    expect(raw).toEqual(frozen);
  });

  it('leaves entries with no insight source incomplete (still rejected by the generator)', () => {
    const raw = { id: 'x', type: 't', confidence: 0.9, created_at: '2026-05-01T00:00:00Z' };
    const e = normalizeLearningEntry(raw);
    expect(() => generateLearningNote(e, 'test-slug')).toThrow(/missing required field/);
  });

  it('returns null/undefined input unchanged', () => {
    expect(normalizeLearningEntry(null)).toBe(null);
    expect(normalizeLearningEntry(undefined)).toBe(undefined);
  });
});

// ── bare-name wikilink invariant (Issue #700 W1-D4 regression guard) ──────────

describe('generateLearningNote bare-name wikilink invariant (#700 W1-D4)', () => {
  it('emits a bare-name source_session wikilink with NO folder prefix (survives folder relocation)', () => {
    // Obsidian resolves wikilinks by basename, so the source_session edge must
    // stay bare `[[id]]` — never `[[50-sessions/id]]` or `[[<repo>/id]]`. A future
    // change that path-qualifies the link would silently break on folder move.
    const out = generateLearningNote(makeV1Entry({ source_session: 'main-2026-04-13-session-1' }), 'my-slug');
    // Bare-name link present in both the frontmatter property and the body bullet.
    expect(out).toContain('source_session: "[[main-2026-04-13-session-1]]"');
    expect(out).toContain('**Source session:** [[main-2026-04-13-session-1]]');
    // No wikilink in the whole note carries a folder separator.
    const wikilinks = out.match(/\[\[[^\]]*\]\]/g) ?? [];
    expect(wikilinks).toEqual(['[[main-2026-04-13-session-1]]', '[[main-2026-04-13-session-1]]']);
    expect(out).not.toContain('[[40-learnings/');
    expect(out).not.toContain('[[50-sessions/');
  });
});

describe('normalizeLearningEntry evidence empty-string fold (#635 review)', () => {
  it('treats evidence:"" as missing and applies the alias fallback', () => {
    const e = normalizeLearningEntry({
      id: 'x', type: 't', subject: 'S', insight: 'I', evidence: '',
      sessions: ['s-1'], confidence: 0.9, created_at: '2026-06-01T00:00:00Z',
    });
    expect(e.evidence).toBe('s-1');
  });

  it('falls back to "(none recorded)" when evidence is "" and no alias exists', () => {
    const e = normalizeLearningEntry({
      id: 'x', type: 't', subject: 'S', insight: 'I', evidence: '',
      confidence: 0.9, created_at: '2026-06-01T00:00:00Z',
    });
    expect(e.evidence).toBe('(none recorded)');
  });
});

// ── existence-vs-format coverage (Issue #704, Task 3) ────────────────────────
//
// Three cases proving note-level link/plain behavior controlled by noteExists.

describe('generateLearningNote existence-vs-format coverage (Issue #704 Task 3)', () => {
  it('noteExists: () => false overrides format validity — emits plain text for a valid semantic id', () => {
    // 'main-2026-06-11-deep-1' would produce a link via format fallback alone.
    // Supplying noteExists=false makes existence authoritative → plain text.
    const out = generateLearningNote(
      makeV1Entry({ source_session: 'main-2026-06-11-deep-1' }),
      'my-slug',
      { noteExists: () => false },
    );
    const links = out.match(/\[\[[^\]]+\]\]/g) ?? [];
    expect(links).toHaveLength(0);
    expect(out).not.toContain('[[main-2026-06-11-deep-1]]');
    expect(out).toContain('source_session: main-2026-06-11-deep-1');
  });

  it('noteExists: () => true upgrades a legacy HHmm id to a wikilink', () => {
    // 'main-2026-04-23-1255' has no numeric mode-counter and returns null from
    // parseSessionId → no link via format fallback. noteExists=true overrides:
    // existence wins and the link IS emitted.
    const out = generateLearningNote(
      makeV1Entry({ source_session: 'main-2026-04-23-1255' }),
      'my-slug',
      { noteExists: () => true },
    );
    expect(out).toContain('source_session: "[[main-2026-04-23-1255]]"');
    expect(out).toContain('**Source session:** [[main-2026-04-23-1255]]');
  });

  it('2-arg generateLearningNote(entry, slug) still works — format fallback resolves semantic ids (back-compat)', () => {
    // Omitting opts entirely should not throw and should still produce a link
    // for a session id that matches the semantic format.
    const out = generateLearningNote(
      makeV1Entry({ source_session: 'main-2026-06-11-deep-1' }),
      'my-slug',
    );
    expect(out).toContain('source_session: "[[main-2026-06-11-deep-1]]"');
    expect(out).toContain('**Source session:** [[main-2026-06-11-deep-1]]');
  });
});

// ── bare-link lockdown guard (Issue #704, Task 2) ─────────────────────────────
//
// Asserts the canonical bare-basename link form so a future change that
// emits path-qualified [[folder/slug]] links fails this suite immediately.

describe('generateLearningNote bare-link lockdown guard (Issue #704 Task 2)', () => {
  it('emitted wikilinks match /^\\[\\[[^/\\]]+\\]\\]$/ — bare basename, no / inside brackets', () => {
    const out = generateLearningNote(
      makeV1Entry({ source_session: 'main-2026-06-11-deep-1' }),
      'my-slug',
    );
    // Two occurrences expected: one in YAML frontmatter, one in the body bullet.
    const links = out.match(/\[\[[^\]]+\]\]/g) ?? [];
    expect(links).toHaveLength(2);
    // /^\[\[[^/\]]+\]\]$/ ensures no / inside the brackets — a path-qualified
    // link like [[50-sessions/main-2026-06-11-deep-1]] would fail this match.
    expect(links[0]).toMatch(/^\[\[[^/\]]+\]\]$/);
    expect(links[1]).toMatch(/^\[\[[^/\]]+\]\]$/);
  });

  it('never emits [[50-sessions/...]] path-qualified links for a resolvable session', () => {
    const out = generateLearningNote(
      makeV1Entry({ source_session: 'main-2026-06-11-deep-1' }),
      'my-slug',
    );
    expect(out).not.toContain('[[50-sessions/');
  });

  it('never emits [[01-projects/...]] path-qualified links for a resolvable session', () => {
    const out = generateLearningNote(
      makeV1Entry({ source_session: 'main-2026-06-11-deep-1' }),
      'my-slug',
    );
    expect(out).not.toContain('[[01-projects/');
  });
});
