/**
 * tests/lib/owner-config/constants.test.mjs
 *
 * Behavioral tests for scripts/lib/owner-config/constants.mjs.
 * Verifies enum values, counts, frozen identity, and the schema version constant.
 */

import { describe, it, expect } from 'vitest';

import {
  CURRENT_OWNER_SCHEMA_VERSION,
  VALID_TONE_STYLES,
  VALID_OUTPUT_LEVELS,
  VALID_PREAMBLE_LEVELS,
  VALID_COMMENTS_LEVELS,
} from '@lib/owner-config/constants.mjs';

describe('constants — CURRENT_OWNER_SCHEMA_VERSION', () => {
  it('is the integer 1', () => {
    expect(CURRENT_OWNER_SCHEMA_VERSION).toBe(1);
  });
});

describe('constants — VALID_TONE_STYLES', () => {
  it('contains the three canonical tone values', () => {
    expect(VALID_TONE_STYLES).toEqual(['direct', 'neutral', 'friendly']);
  });

  it('has exactly 3 entries', () => {
    expect(VALID_TONE_STYLES).toHaveLength(3);
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(VALID_TONE_STYLES)).toBe(true);
  });
});

describe('constants — VALID_OUTPUT_LEVELS', () => {
  it('contains the three canonical output-level values', () => {
    expect(VALID_OUTPUT_LEVELS).toEqual(['lite', 'full', 'ultra']);
  });

  it('has exactly 3 entries', () => {
    expect(VALID_OUTPUT_LEVELS).toHaveLength(3);
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(VALID_OUTPUT_LEVELS)).toBe(true);
  });
});

describe('constants — VALID_PREAMBLE_LEVELS', () => {
  it('contains the two canonical preamble values', () => {
    expect(VALID_PREAMBLE_LEVELS).toEqual(['minimal', 'verbose']);
  });

  it('has exactly 2 entries', () => {
    expect(VALID_PREAMBLE_LEVELS).toHaveLength(2);
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(VALID_PREAMBLE_LEVELS)).toBe(true);
  });
});

describe('constants — VALID_COMMENTS_LEVELS', () => {
  it('contains the two canonical comments-in-code values', () => {
    expect(VALID_COMMENTS_LEVELS).toEqual(['minimal', 'full']);
  });

  it('has exactly 2 entries', () => {
    expect(VALID_COMMENTS_LEVELS).toHaveLength(2);
  });

  it('is frozen (cannot be mutated)', () => {
    expect(Object.isFrozen(VALID_COMMENTS_LEVELS)).toBe(true);
  });
});
