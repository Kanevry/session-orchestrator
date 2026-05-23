/**
 * tests/scripts/lib/peer-cards/merger.test.mjs — Unit tests for #503 merger.mjs.
 *
 * Pure-function tests — no fs. Verifies AC2 (hand-edits preserved across merges),
 * conflict surfacing for duplicate-section + orphan-begin, idempotency, and
 * round-trip parse/serialize equality for well-formed input.
 */

import { describe, it, expect } from 'vitest';

import { mergePeerCard } from '@lib/peer-cards/merger.mjs';

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

// ─── mergePeerCard — round-trip invariants (via empty-updates merge) ────────
//
// parseSections + serializeSections are module-private (#533 Y-2); their
// round-trip invariants are exercised here through mergePeerCard(body, {}),
// which internally parses + serialises and must therefore preserve byte-equality
// for well-formed input.

describe('mergePeerCard — round-trip invariants', () => {
  it('round-trips hand-only body byte-equivalent (no sentinels)', () => {
    expect(mergePeerCard(HAND_ONLY, {}).body).toBe(HAND_ONLY);
  });

  it('round-trips well-formed body with two managed sections byte-equivalent', () => {
    expect(mergePeerCard(WITH_TWO_MANAGED, {}).body).toBe(WITH_TWO_MANAGED);
  });

  it('accepts empty body without throwing (parse returns no sections)', () => {
    const result = mergePeerCard('', {});
    expect(result.body).toBe('');
    expect(result.conflicts).toEqual([]);
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

  it('appends managed sections when body is empty (append-only mode)', () => {
    const result = mergePeerCard('', { preferences: '- a preference' });

    expect(result.conflicts).toEqual([]);
    expect(result.stats.appended).toBe(1);
    expect(result.stats.replaced).toBe(0);
    expect(result.body).toContain('<!-- BEGIN MANAGED: preferences -->');
    expect(result.body).toContain('- a preference');
    expect(result.body).toContain('<!-- END MANAGED: preferences -->');
  });

  it('preserves managed sections when body has zero hand text between them', () => {
    const existingBody =
      '<!-- BEGIN MANAGED: section1 -->\n- a\n<!-- END MANAGED: section1 -->' +
      '<!-- BEGIN MANAGED: section2 -->\n- b\n<!-- END MANAGED: section2 -->';

    const result = mergePeerCard(existingBody, { section1: '- a-updated', section3: '- new section c' });

    // section1 is replaced with the update
    expect(result.body).toContain('- a-updated');
    expect(result.body).not.toContain('\n- a\n');
    // section2 is kept verbatim (not in updates)
    expect(result.body).toContain('- b');
    // section3 is appended as a new managed section
    expect(result.body).toContain('- new section c');
    expect(result.body).toContain('<!-- BEGIN MANAGED: section3 -->');
    expect(result.body).toContain('<!-- END MANAGED: section3 -->');
    // Stats reflect what happened
    expect(result.stats.replaced).toBe(1);
    expect(result.stats.appended).toBe(1);
    expect(result.conflicts).toEqual([]);
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
