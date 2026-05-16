/**
 * tests/lib/owner-config/defaults.test.mjs
 *
 * Behavioral tests for scripts/lib/owner-config/defaults.mjs.
 * Verifies shape, blank required fields, enum defaults, and return-value isolation.
 */

import { describe, it, expect } from 'vitest';

import { defaults } from '@lib/owner-config/defaults.mjs';

describe('defaults()', () => {
  it('returns schema-version 1', () => {
    expect(defaults()['schema-version']).toBe(1);
  });

  it('leaves owner.name blank (interview fills it)', () => {
    expect(defaults().owner.name).toBe('');
  });

  it('leaves owner.language blank (interview fills it)', () => {
    expect(defaults().owner.language).toBe('');
  });

  it('sets owner.email-hash to null', () => {
    expect(defaults().owner['email-hash']).toBeNull();
  });

  it('defaults tone.style to neutral', () => {
    expect(defaults().tone.style).toBe('neutral');
  });

  it('defaults tone.tonality to null', () => {
    expect(defaults().tone.tonality).toBeNull();
  });

  it('defaults efficiency.output-level to full', () => {
    expect(defaults().efficiency['output-level']).toBe('full');
  });

  it('defaults efficiency.preamble to minimal', () => {
    expect(defaults().efficiency.preamble).toBe('minimal');
  });

  it('defaults efficiency.comments-in-code to minimal', () => {
    expect(defaults().efficiency['comments-in-code']).toBe('minimal');
  });

  it('defaults hardware-sharing.enabled to false (consent gate)', () => {
    expect(defaults()['hardware-sharing'].enabled).toBe(false);
    expect(defaults()['hardware-sharing']['hash-salt']).toBeNull();
  });

  it('returns a fresh object on each call (no shared reference)', () => {
    const a = defaults();
    const b = defaults();
    a.owner.name = 'mutated';
    expect(b.owner.name).toBe('');
  });
});
