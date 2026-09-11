/**
 * tests/scripts/lib/peer-cards/merger.test.mjs — Unit tests for #503 merger.mjs.
 *
 * Pure-function tests — no fs. Verifies AC2 (hand-edits preserved across merges),
 * conflict surfacing for duplicate-section + orphan-begin, idempotency, and
 * round-trip parse/serialize equality for well-formed input.
 */

import { describe, it, expect } from 'vitest';

import { mergePeerCard, deriveManagedUpdates, mergeDerivedBody } from '@lib/peer-cards/merger.mjs';

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

// ─── #1310 — deriver body-string → section-map adapter ───────────────────────
//
// Bug these catch: the dialectic-deriver emits a FULL BODY STRING, mergePeerCard
// consumes a SECTION MAP. Before the adapter, `/evolve dialectic --apply` had no
// translation at all. The subtler bug is the naive fix: re-slugifying each heading
// produces `guard-and-protocol-migration-discipline` where the live card says
// `guard-and-protocol-migration`, so the "update" APPENDS a second copy of the
// section instead of replacing it — the card silently grows duplicate headings.

const DERIVER_EXISTING = [
  'Hand-owned intro.\n\n',
  '<!-- BEGIN MANAGED: guard-and-protocol-migration -->\n',
  '## Guard and protocol-migration discipline\n\n- old guard note\n',
  '<!-- END MANAGED: guard-and-protocol-migration -->\n\n',
  '<!-- BEGIN MANAGED: wave-execution -->\n',
  '## Wave execution\n\n- old wave note\n',
  '<!-- END MANAGED: wave-execution -->\n\nHand-owned footer.\n',
].join('');

const DERIVER_PROPOSED = [
  '## Guard and protocol-migration discipline\n\n- new guard note\n\n',
  '## Wave execution\n\n- new wave note\n\n',
  '## Remote dispatch\n\n- one job, one log\n',
].join('');

describe('deriveManagedUpdates — heading → sentinel mapping (#1310)', () => {
  it('reuses the EXISTING section name even when it is not the heading slug', () => {
    const { mapping } = deriveManagedUpdates(DERIVER_PROPOSED, DERIVER_EXISTING);
    const guard = mapping.find(m => m.heading.startsWith('Guard and'));
    expect(guard.section).toBe('guard-and-protocol-migration');
    expect(guard.origin).toBe('existing');
  });

  it('slugifies a heading that has no existing section, marking it new', () => {
    const { mapping, managedUpdates } = deriveManagedUpdates(DERIVER_PROPOSED, DERIVER_EXISTING);
    const fresh = mapping.find(m => m.heading === 'Remote dispatch');
    expect(fresh).toEqual({ heading: 'Remote dispatch', section: 'remote-dispatch', origin: 'new' });
    expect(managedUpdates['remote-dispatch']).toContain('one job, one log');
  });

  it('keeps each heading line inside its own section content', () => {
    const { managedUpdates } = deriveManagedUpdates(DERIVER_PROPOSED, DERIVER_EXISTING);
    expect(managedUpdates['wave-execution']).toBe('## Wave execution\n\n- new wave note');
  });

  it('returns text before the first heading as preamble instead of dropping it', () => {
    const { preamble, managedUpdates } = deriveManagedUpdates(
      'Here is my proposal:\n\n## Wave execution\n\n- x\n',
      DERIVER_EXISTING,
    );
    expect(preamble).toBe('Here is my proposal:');
    expect(Object.keys(managedUpdates)).toEqual(['wave-execution']);
  });

  it('every section name it emits satisfies the mergePeerCard grammar', () => {
    const { managedUpdates } = deriveManagedUpdates(
      '## CI / verification (2026!)\n\n- x\n',
      '',
    );
    for (const name of Object.keys(managedUpdates)) expect(name).toMatch(/^[\w-]+$/);
  });

  it('rejects a non-string proposed body', () => {
    expect(() => deriveManagedUpdates(null, '')).toThrow(/proposedBody must be string/);
  });
});

describe('mergeDerivedBody — full-body apply seam (#1310)', () => {
  it('replaces existing sections, appends new ones, preserves hand text', () => {
    const result = mergeDerivedBody(DERIVER_EXISTING, DERIVER_PROPOSED);
    expect(result.stats.replaced).toBe(2);
    expect(result.stats.appended).toBe(1);
    expect(result.body).toContain('Hand-owned intro.');
    expect(result.body).toContain('Hand-owned footer.');
    expect(result.body).toContain('- new guard note');
    expect(result.body).not.toContain('- old guard note');
  });

  it('does not duplicate a heading whose section name is not its slug', () => {
    const result = mergeDerivedBody(DERIVER_EXISTING, DERIVER_PROPOSED);
    const occurrences = result.body.split('## Guard and protocol-migration discipline').length - 1;
    expect(occurrences).toBe(1);
    expect(result.body).not.toContain('guard-and-protocol-migration-discipline');
  });

  it('surfaces unmapped preamble as a conflict rather than dropping it silently', () => {
    const result = mergeDerivedBody(DERIVER_EXISTING, 'Chatter.\n\n## Wave execution\n\n- x\n');
    expect(result.conflicts).toContainEqual({ type: 'unmapped-preamble', content: 'Chatter.' });
  });

  it('is idempotent — applying the same proposal twice is byte-stable', () => {
    const once = mergeDerivedBody(DERIVER_EXISTING, DERIVER_PROPOSED).body;
    const twice = mergeDerivedBody(once, DERIVER_PROPOSED).body;
    expect(twice).toBe(once);
  });
});
