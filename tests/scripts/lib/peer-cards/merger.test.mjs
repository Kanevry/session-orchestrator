/**
 * tests/scripts/lib/peer-cards/merger.test.mjs — Unit tests for #503 merger.mjs.
 *
 * Pure-function tests — no fs. Verifies AC2 (hand-edits preserved across merges),
 * conflict surfacing for duplicate-section + orphan-begin, idempotency, and
 * round-trip parse/serialize equality for well-formed input.
 */

import { describe, it, expect } from 'vitest';

import {
  parseSections,
  serializeSections,
  mergePeerCard,
} from '@lib/peer-cards/merger.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const HAND_ONLY = `## Hand notes\n\nWritten by the user.\n`;

const WITH_ONE_MANAGED = `## Hand notes

Written by the user.

<!-- BEGIN MANAGED: preferences -->
- Tone: direct
- Output: lite
<!-- END MANAGED: preferences -->

Trailing hand text.
`;

const WITH_TWO_MANAGED = `## Hand notes

User text.

<!-- BEGIN MANAGED: preferences -->
- Tone: direct
<!-- END MANAGED: preferences -->

Middle hand text.

<!-- BEGIN MANAGED: tags -->
tags: a, b
<!-- END MANAGED: tags -->
`;

const WITH_DUPLICATE_MANAGED = `Hand A.
<!-- BEGIN MANAGED: preferences -->
first
<!-- END MANAGED: preferences -->
Middle hand.
<!-- BEGIN MANAGED: preferences -->
second
<!-- END MANAGED: preferences -->
`;

const WITH_ORPHAN_BEGIN = `Hand A.
<!-- BEGIN MANAGED: orphan -->
content with no end marker
`;

// ─── parseSections ───────────────────────────────────────────────────────────

describe('parseSections', () => {
  it('returns a single hand section for body with no sentinels', () => {
    const { sections } = parseSections(HAND_ONLY);
    expect(sections).toHaveLength(1);
    expect(sections[0].type).toBe('hand');
    expect(sections[0].content).toBe(HAND_ONLY);
  });

  it('splits hand + managed + hand for a single sentinel pair', () => {
    const { sections } = parseSections(WITH_ONE_MANAGED);
    expect(sections).toHaveLength(3);
    expect(sections[0].type).toBe('hand');
    expect(sections[0].content).toContain('## Hand notes');
    expect(sections[1].type).toBe('managed');
    expect(sections[1].name).toBe('preferences');
    expect(sections[1].content).toContain('Tone: direct');
    expect(sections[2].type).toBe('hand');
    expect(sections[2].content).toContain('Trailing hand text.');
  });

  it('returns 5 sections (hand, managed, hand, managed, hand) for two sentinels', () => {
    const { sections } = parseSections(WITH_TWO_MANAGED);
    const types = sections.map((s) => s.type);
    expect(types).toEqual(['hand', 'managed', 'hand', 'managed', 'hand']);
    const names = sections.filter((s) => s.type === 'managed').map((s) => s.name);
    expect(names).toEqual(['preferences', 'tags']);
  });

  it('treats orphan BEGIN as hand text (defensive)', () => {
    const { sections } = parseSections(WITH_ORPHAN_BEGIN);
    // No managed section should be produced
    expect(sections.every((s) => s.type === 'hand')).toBe(true);
  });

  it('throws when body is not a string', () => {
    expect(() => parseSections(null)).toThrow(/body must be string/);
    expect(() => parseSections(42)).toThrow(/body must be string/);
  });

  it('returns empty sections for empty string', () => {
    const { sections } = parseSections('');
    expect(sections).toEqual([]);
  });
});

// ─── serializeSections ───────────────────────────────────────────────────────

describe('serializeSections', () => {
  it('round-trips: serialize(parse(body)) equals body for well-formed input', () => {
    const { sections } = parseSections(WITH_ONE_MANAGED);
    expect(serializeSections(sections)).toBe(WITH_ONE_MANAGED);
  });

  it('round-trips well-formed body with two managed sections', () => {
    const { sections } = parseSections(WITH_TWO_MANAGED);
    expect(serializeSections(sections)).toBe(WITH_TWO_MANAGED);
  });

  it('round-trips hand-only body byte-equivalent', () => {
    const { sections } = parseSections(HAND_ONLY);
    expect(serializeSections(sections)).toBe(HAND_ONLY);
  });

  it('throws on non-array input', () => {
    expect(() => serializeSections(null)).toThrow(/sections must be array/);
    expect(() => serializeSections('not an array')).toThrow(/sections must be array/);
  });

  it('throws on unknown section type', () => {
    expect(() =>
      serializeSections([{ type: 'unknown', content: 'x' }]),
    ).toThrow(/unknown section type/);
  });
});

// ─── mergePeerCard — AC2 + idempotency ───────────────────────────────────────

describe('mergePeerCard — AC2 hand-edit preservation', () => {
  it('AC2: replaces managed section, preserves hand text verbatim', () => {
    const result = mergePeerCard(WITH_ONE_MANAGED, {
      preferences: '- Tone: friendly\n- Output: full',
    });

    expect(result.conflicts).toEqual([]);
    expect(result.stats.replaced).toBe(1);
    expect(result.body).toContain('## Hand notes');
    expect(result.body).toContain('Written by the user.');
    expect(result.body).toContain('Trailing hand text.');
    expect(result.body).toContain('- Tone: friendly');
    expect(result.body).toContain('- Output: full');
    expect(result.body).not.toContain('- Tone: direct');
  });

  it('AC2: hand sections in between two managed sections are preserved', () => {
    const result = mergePeerCard(WITH_TWO_MANAGED, {
      preferences: 'updated prefs',
    });
    expect(result.body).toContain('Middle hand text.');
    expect(result.body).toContain('User text.');
    expect(result.body).toContain('updated prefs');
    // tags section was not in updates — must be kept as-is
    expect(result.body).toContain('tags: a, b');
    expect(result.stats.replaced).toBe(1);
  });

  it('idempotent: empty updates returns body equivalent + no conflicts + replaced=0', () => {
    const result = mergePeerCard(WITH_ONE_MANAGED, {});
    expect(result.conflicts).toEqual([]);
    expect(result.stats.replaced).toBe(0);
    expect(result.stats.appended).toBe(0);
    // Round-trip through parse/serialize is byte-equivalent for well-formed input
    expect(result.body).toBe(WITH_ONE_MANAGED);
  });

  it('appends new managed section when not present in existing body', () => {
    const result = mergePeerCard(HAND_ONLY, {
      preferences: '- new section content',
    });
    expect(result.stats.appended).toBe(1);
    expect(result.stats.replaced).toBe(0);
    expect(result.body).toContain('<!-- BEGIN MANAGED: preferences -->');
    expect(result.body).toContain('- new section content');
    expect(result.body).toContain('<!-- END MANAGED: preferences -->');
    // Original hand text still there
    expect(result.body).toContain('## Hand notes');
    expect(result.body).toContain('Written by the user.');
  });
});

// ─── mergePeerCard — conflict surfacing ──────────────────────────────────────

describe('mergePeerCard — conflict surfacing', () => {
  it('surfaces duplicate-section conflict when same managed name appears twice', () => {
    const result = mergePeerCard(WITH_DUPLICATE_MANAGED, {});
    expect(result.conflicts).toContainEqual({
      type: 'duplicate-section',
      name: 'preferences',
    });
  });

  it('surfaces orphan-begin conflict when BEGIN has no matching END', () => {
    const result = mergePeerCard(WITH_ORPHAN_BEGIN, {});
    expect(result.conflicts).toContainEqual({
      type: 'orphan-begin',
      name: 'orphan',
    });
  });

  it('returns no conflicts for clean well-formed body', () => {
    const result = mergePeerCard(WITH_ONE_MANAGED, {});
    expect(result.conflicts).toEqual([]);
  });
});

// ─── mergePeerCard — input validation ────────────────────────────────────────

describe('mergePeerCard — input validation', () => {
  it('throws when existingBody is not a string', () => {
    expect(() => mergePeerCard(null, {})).toThrow(/existingBody must be string/);
    expect(() => mergePeerCard(42, {})).toThrow(/existingBody must be string/);
  });

  it('throws when managedUpdates is null', () => {
    expect(() => mergePeerCard('body', null)).toThrow(/managedUpdates must be a plain object/);
  });

  it('throws when managedUpdates is an array', () => {
    expect(() => mergePeerCard('body', [])).toThrow(/managedUpdates must be a plain object/);
  });

  it('throws on invalid section name (contains space)', () => {
    expect(() =>
      mergePeerCard('body', { 'bad name': 'x' }),
    ).toThrow(/invalid section name/);
  });

  it('throws when update value is not a string', () => {
    expect(() =>
      mergePeerCard('body', { preferences: 42 }),
    ).toThrow(/must be a string/);
  });
});

// ─── mergePeerCard — stats ───────────────────────────────────────────────────

describe('mergePeerCard — stats counters', () => {
  it('counts preserved hand sections', () => {
    // WITH_ONE_MANAGED parses to: hand, managed, hand → 2 hand sections
    const result = mergePeerCard(WITH_ONE_MANAGED, {});
    expect(result.stats.preserved).toBe(2);
  });

  it('reports appended=1 when adding a new section to hand-only body', () => {
    const result = mergePeerCard(HAND_ONLY, { newone: 'content' });
    expect(result.stats.appended).toBe(1);
    expect(result.stats.replaced).toBe(0);
  });

  it('reports both appended and replaced when mixed', () => {
    const result = mergePeerCard(WITH_ONE_MANAGED, {
      preferences: 'updated',
      newone: 'content',
    });
    expect(result.stats.replaced).toBe(1);
    expect(result.stats.appended).toBe(1);
  });
});
