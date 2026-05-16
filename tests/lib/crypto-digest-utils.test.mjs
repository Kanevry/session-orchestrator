/**
 * tests/lib/crypto-digest-utils.test.mjs
 *
 * Vitest suite for scripts/lib/crypto-digest-utils.mjs.
 *
 * Covers all 4 exports:
 *   digestSha256Short  — truncated hex (default 8 chars), length option, encoding option
 *   digestSha256       — full 64-char hex, encoding option, null/undefined coercion
 *   digestSha256WithSalt — salt+\x00+value pattern, TypeError guards
 *   digestMultiBufferSha256 — sequential multi-buffer update, TypeError guard, order-sensitivity
 *
 * Expected hash values are pre-computed externally and hardcoded as literals.
 * No computation mirrors production logic (test-quality.md anti-pattern #3).
 */

import { describe, it, expect } from 'vitest';
import {
  digestSha256Short,
  digestSha256,
  digestSha256WithSalt,
  digestMultiBufferSha256,
} from '@lib/crypto-digest-utils.mjs';

// ---------------------------------------------------------------------------
// digestSha256Short
// ---------------------------------------------------------------------------
describe('digestSha256Short', () => {
  it('returns an 8-character hex string for a simple string input', () => {
    expect(digestSha256Short('test')).toBe('9f86d081');
  });

  it('returns an 8-character hex string for another known input', () => {
    expect(digestSha256Short('hello')).toBe('2cf24dba');
  });

  it('coerces undefined to empty string and returns a stable 8-char hex', () => {
    // String(undefined ?? '') === '' — same hash as empty-string input
    expect(digestSha256Short(undefined)).toBe('e3b0c442');
  });

  it('coerces null to empty string and returns the same hash as undefined', () => {
    expect(digestSha256Short(null)).toBe('e3b0c442');
  });

  it('accepts a Buffer value and returns an 8-char hex (Buffer coerced via String())', () => {
    // String(Buffer.from('test')) === 'test' → same hash as the string 'test'
    expect(digestSha256Short(Buffer.from('test'))).toBe('9f86d081');
  });

  it('respects the length option — returns 4-char hex when length=4', () => {
    expect(digestSha256Short('test', { length: 4 })).toBe('9f86');
  });

  it('respects the length option — length=64 returns the full hex without truncation side-effects', () => {
    expect(digestSha256Short('test', { length: 64 })).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });

  it('respects the encoding option — base64 encoding with default length=8', () => {
    // SHA-256('test').digest('base64').slice(0,8) === 'n4bQgYhM'
    expect(digestSha256Short('test', { encoding: 'base64' })).toBe('n4bQgYhM');
  });
});

// ---------------------------------------------------------------------------
// digestSha256
// ---------------------------------------------------------------------------
describe('digestSha256', () => {
  it('returns the full 64-character lowercase hex digest for a known input', () => {
    expect(digestSha256('test')).toBe(
      '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    );
  });

  it('returns a 64-character string', () => {
    expect(digestSha256('hello')).toHaveLength(64);
  });

  it('coerces undefined to empty string — returns the well-known SHA-256 of empty input', () => {
    expect(digestSha256(undefined)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('returns a base64 string (~44 chars) when encoding=base64', () => {
    const result = digestSha256('hello', { encoding: 'base64' });
    expect(result).toBe('LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
  });

  it('produces a different digest for different inputs', () => {
    expect(digestSha256('test')).not.toBe(digestSha256('Test'));
  });
});

// ---------------------------------------------------------------------------
// digestSha256WithSalt
// ---------------------------------------------------------------------------
describe('digestSha256WithSalt', () => {
  it('returns a 64-char hex digest for a known salt+value pair', () => {
    expect(digestSha256WithSalt('host1', { salt: 'abc' })).toBe(
      '912a036eca5aa5a1516c7a7163335ed96ef87c4fb484c9516fd4d12d11b1ed1d',
    );
  });

  it('is deterministic — identical inputs always produce the same hash', () => {
    const first = digestSha256WithSalt('myvalue', { salt: 'mykey' });
    const second = digestSha256WithSalt('myvalue', { salt: 'mykey' });
    expect(first).toBe(second);
  });

  it('produces a different hash when the salt changes', () => {
    const hashAbc = digestSha256WithSalt('host1', { salt: 'abc' });
    const hashXyz = digestSha256WithSalt('host1', { salt: 'xyz' });
    expect(hashAbc).not.toBe(hashXyz);
  });

  it('coerces undefined value to empty string without throwing', () => {
    // String(undefined ?? '') === '' — should not throw
    const result = digestSha256WithSalt(undefined, { salt: 'abc' });
    expect(result).toBe(
      'dc1114cd074914bd872cc1f9a23ec910ea2203bc79779ab2e17da25782a624fc',
    );
  });

  it('throws TypeError when options argument is omitted entirely', () => {
    expect(() => digestSha256WithSalt('host1')).toThrow(TypeError);
    expect(() => digestSha256WithSalt('host1')).toThrow(
      'digestSha256WithSalt requires options.salt (string)',
    );
  });

  it('throws TypeError when options.salt is missing', () => {
    expect(() => digestSha256WithSalt('host1', {})).toThrow(TypeError);
  });

  it('throws TypeError when options.salt is a number, not a string', () => {
    expect(() => digestSha256WithSalt('host1', { salt: 42 })).toThrow(TypeError);
  });

  it('throws TypeError when options.salt is null', () => {
    expect(() => digestSha256WithSalt('host1', { salt: null })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// digestMultiBufferSha256
// ---------------------------------------------------------------------------
describe('digestMultiBufferSha256', () => {
  it('returns a 64-char hex digest for an array of two string buffers', () => {
    // SHA-256 of sequential .update('hello').update('world')
    expect(digestMultiBufferSha256(['hello', 'world'])).toBe(
      '936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af',
    );
  });

  it('returns the SHA-256 of empty input for an empty array', () => {
    // No updates → same as hashing ''
    expect(digestMultiBufferSha256([])).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('handles a mixed array of string and Buffer values', () => {
    // .update('hello').update(Buffer.from('world')) produces the same bytes as two strings
    expect(digestMultiBufferSha256(['hello', Buffer.from('world')])).toBe(
      '936a185caaa266bb9cbe981e9e05cb78cd732b0b3280eb944412bb6f8f8f07af',
    );
  });

  it('handles an array containing an empty Buffer without throwing', () => {
    // A single Buffer.alloc(0) contributes zero bytes — same as hashing ''
    expect(digestMultiBufferSha256([Buffer.alloc(0)])).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is sensitive to buffer order — reversing the array changes the digest', () => {
    const forwardHash = digestMultiBufferSha256(['hello', 'world']);
    const reverseHash = digestMultiBufferSha256(['world', 'hello']);
    expect(forwardHash).not.toBe(reverseHash);
    // Also verify the reversed hash is the known value
    expect(reverseHash).toBe(
      '8376118fc0230e6054e782fb31ae52ebcfd551342d8d026c209997e0127b6f74',
    );
  });

  it('throws TypeError when called with a string instead of an array', () => {
    expect(() => digestMultiBufferSha256('not-an-array')).toThrow(TypeError);
    expect(() => digestMultiBufferSha256('not-an-array')).toThrow(
      'digestMultiBufferSha256 requires buffers (array)',
    );
  });

  it('throws TypeError when called with undefined', () => {
    expect(() => digestMultiBufferSha256(undefined)).toThrow(TypeError);
  });

  it('throws TypeError when called with a plain object', () => {
    expect(() => digestMultiBufferSha256({ 0: 'hello' })).toThrow(TypeError);
  });
});
