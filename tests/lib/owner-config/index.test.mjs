/**
 * tests/lib/owner-config/index.test.mjs
 *
 * Smoke tests for scripts/lib/owner-config/index.mjs.
 * Verifies that all 10 public symbols are present, correctly typed, and
 * functionally routed (not stale re-exports).
 */

import { describe, it, expect } from 'vitest';

import * as ownerConfigIndex from '../../../scripts/lib/owner-config/index.mjs';

describe('owner-config/index.mjs — all 10 public symbols present', () => {
  it('exports CURRENT_OWNER_SCHEMA_VERSION as an integer', () => {
    expect(typeof ownerConfigIndex.CURRENT_OWNER_SCHEMA_VERSION).toBe('number');
    expect(ownerConfigIndex.CURRENT_OWNER_SCHEMA_VERSION).toBe(1);
  });

  it('exports VALID_TONE_STYLES as a frozen array', () => {
    expect(Array.isArray(ownerConfigIndex.VALID_TONE_STYLES)).toBe(true);
    expect(Object.isFrozen(ownerConfigIndex.VALID_TONE_STYLES)).toBe(true);
  });

  it('exports VALID_OUTPUT_LEVELS as a frozen array', () => {
    expect(Array.isArray(ownerConfigIndex.VALID_OUTPUT_LEVELS)).toBe(true);
    expect(Object.isFrozen(ownerConfigIndex.VALID_OUTPUT_LEVELS)).toBe(true);
  });

  it('exports VALID_PREAMBLE_LEVELS as a frozen array', () => {
    expect(Array.isArray(ownerConfigIndex.VALID_PREAMBLE_LEVELS)).toBe(true);
    expect(Object.isFrozen(ownerConfigIndex.VALID_PREAMBLE_LEVELS)).toBe(true);
  });

  it('exports VALID_COMMENTS_LEVELS as a frozen array', () => {
    expect(Array.isArray(ownerConfigIndex.VALID_COMMENTS_LEVELS)).toBe(true);
    expect(Object.isFrozen(ownerConfigIndex.VALID_COMMENTS_LEVELS)).toBe(true);
  });

  it('exports OwnerConfigError as a constructor that extends Error', () => {
    const { OwnerConfigError } = ownerConfigIndex;
    expect(typeof OwnerConfigError).toBe('function');
    const err = new OwnerConfigError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OwnerConfigError');
  });

  it('exports defaults as a function returning a full config object', () => {
    expect(typeof ownerConfigIndex.defaults).toBe('function');
    const def = ownerConfigIndex.defaults();
    expect(def['schema-version']).toBe(1);
    expect(def.owner).toBeDefined();
  });

  it('exports validate as a function returning {ok, value, errors}', () => {
    expect(typeof ownerConfigIndex.validate).toBe('function');
    const result = ownerConfigIndex.validate(null);
    expect(result).toHaveProperty('ok', false);
    expect(result).toHaveProperty('errors');
    expect(result).toHaveProperty('value');
  });

  it('exports coerce as a function that throws on invalid input', () => {
    expect(typeof ownerConfigIndex.coerce).toBe('function');
    expect(() => ownerConfigIndex.coerce(null)).toThrow(ownerConfigIndex.OwnerConfigError);
  });

  it('exports merge as a function returning a full config', () => {
    expect(typeof ownerConfigIndex.merge).toBe('function');
    const out = ownerConfigIndex.merge({}, {});
    expect(out['schema-version']).toBe(1);
    expect(out.owner).toBeDefined();
  });
});
