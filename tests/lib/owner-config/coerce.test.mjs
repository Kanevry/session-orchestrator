/**
 * tests/lib/owner-config/coerce.test.mjs
 *
 * Behavioral tests for scripts/lib/owner-config/coerce.mjs.
 * Verifies success path returns normalized value, failure path throws
 * OwnerConfigError with the full error list, and singular/plural message form.
 */

import { describe, it, expect } from 'vitest';

import { coerce } from '../../../scripts/lib/owner-config/coerce.mjs';
import { OwnerConfigError } from '../../../scripts/lib/owner-config/error.mjs';

const HEX64 = 'b'.repeat(64);

function minimalValid(overrides = {}) {
  return {
    'schema-version': 1,
    owner: { name: 'Ada', language: 'en' },
    ...overrides,
  };
}

describe('coerce() — success path', () => {
  it('returns the normalized value for a minimal valid config', () => {
    const value = coerce(minimalValid());
    expect(value['schema-version']).toBe(1);
    expect(value.owner.name).toBe('Ada');
    expect(value.owner.language).toBe('en');
  });

  it('fills in default tone.style when not provided', () => {
    const value = coerce(minimalValid());
    expect(value.tone.style).toBe('neutral');
  });

  it('fills in default efficiency.output-level when not provided', () => {
    const value = coerce(minimalValid());
    expect(value.efficiency['output-level']).toBe('full');
  });

  it('returns supplied optional fields when present', () => {
    const value = coerce(minimalValid({
      tone: { style: 'direct', tonality: 'pragmatic' },
      'hardware-sharing': { enabled: true, 'hash-salt': HEX64 },
    }));
    expect(value.tone.style).toBe('direct');
    expect(value.tone.tonality).toBe('pragmatic');
    expect(value['hardware-sharing'].enabled).toBe(true);
  });
});

describe('coerce() — failure path', () => {
  it('throws OwnerConfigError when input is null', () => {
    expect(() => coerce(null)).toThrow(OwnerConfigError);
  });

  it('throws OwnerConfigError when schema-version is missing', () => {
    expect(() => coerce({ owner: { name: 'x', language: 'en' } })).toThrow(OwnerConfigError);
  });

  it('attaches all validation errors to .errors on the thrown exception', () => {
    let caught;
    try {
      coerce({
        'schema-version': 1,
        owner: { name: '', language: 'INVALID' },
        tone: { style: 'snarky' },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OwnerConfigError);
    expect(caught.errors.length).toBeGreaterThanOrEqual(3);
  });

  it('uses plural "errors" in message when multiple validation failures occur', () => {
    let caught;
    try {
      coerce({ 'schema-version': 1, owner: { name: '', language: 'BAD' } });
    } catch (err) {
      caught = err;
    }
    expect(caught.message).toMatch(/errors/);
  });

  it('uses singular "error" in message when exactly one validation failure occurs', () => {
    // Only owner.name is invalid — owner section present but name is empty
    let caught;
    try {
      coerce({ 'schema-version': 1, owner: { name: '', language: 'en' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(OwnerConfigError);
    // single error → "1 error" (no trailing 's')
    expect(caught.message).toMatch(/1 error[^s]/);
  });

  it('error list propagates the exact messages from validate()', () => {
    let caught;
    try {
      coerce({ 'schema-version': 1, owner: { name: '', language: 'en' } });
    } catch (err) {
      caught = err;
    }
    expect(caught.errors.some((e) => e.includes('owner.name'))).toBe(true);
  });
});
