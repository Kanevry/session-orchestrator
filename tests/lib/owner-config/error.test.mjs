/**
 * tests/lib/owner-config/error.test.mjs
 *
 * Behavioral tests for scripts/lib/owner-config/error.mjs.
 * Verifies OwnerConfigError construction, prototype chain, and .errors attachment.
 */

import { describe, it, expect } from 'vitest';

import { OwnerConfigError } from '@lib/owner-config/error.mjs';
import { assertErrorShape } from '../../_helpers/assert-error-shape.mjs';

describe('OwnerConfigError', () => {
  it('carries the Error prototype chain, its own prototype, .name and .message', () => {
    assertErrorShape(new OwnerConfigError('validation failed'), {
      ctor: OwnerConfigError,
      name: 'OwnerConfigError',
      message: 'validation failed',
    });
  });

  it('defaults .errors to empty array when not provided', () => {
    const err = new OwnerConfigError('msg');
    expect(err.errors).toEqual([]);
  });

  it('attaches the provided errors array to .errors', () => {
    const errs = ['owner.name is required', 'owner.language is required'];
    const err = new OwnerConfigError('2 errors', errs);
    expect(err.errors).toEqual(['owner.name is required', 'owner.language is required']);
  });

  it('preserves reference identity of the passed errors array', () => {
    const errs = ['err1'];
    const err = new OwnerConfigError('msg', errs);
    expect(err.errors).toBe(errs);
  });

  it('has a stack trace (is a real Error)', () => {
    const err = new OwnerConfigError('msg');
    expect(typeof err.stack).toBe('string');
    expect(err.stack.length).toBeGreaterThan(0);
  });
});
