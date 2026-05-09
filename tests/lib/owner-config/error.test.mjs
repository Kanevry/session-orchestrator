/**
 * tests/lib/owner-config/error.test.mjs
 *
 * Behavioral tests for scripts/lib/owner-config/error.mjs.
 * Verifies OwnerConfigError construction, prototype chain, and .errors attachment.
 */

import { describe, it, expect } from 'vitest';

import { OwnerConfigError } from '../../../scripts/lib/owner-config/error.mjs';

describe('OwnerConfigError', () => {
  it('is an instance of Error', () => {
    const err = new OwnerConfigError('something went wrong');
    expect(err).toBeInstanceOf(Error);
  });

  it('is an instance of OwnerConfigError', () => {
    const err = new OwnerConfigError('something went wrong');
    expect(err).toBeInstanceOf(OwnerConfigError);
  });

  it('sets name to OwnerConfigError', () => {
    const err = new OwnerConfigError('msg');
    expect(err.name).toBe('OwnerConfigError');
  });

  it('stores the message on .message', () => {
    const err = new OwnerConfigError('validation failed');
    expect(err.message).toBe('validation failed');
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
