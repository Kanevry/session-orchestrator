/**
 * Unit tests for scripts/lib/vault-mirror/render-learnings.mjs
 * Focus: detectLearningSchema, generateLearningNote, generateLearningNoteV2
 */

import { describe, it, expect } from 'vitest';
import {
  detectLearningSchema,
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
});
