/**
 * tests/lib/owner-config/validate.test.mjs
 *
 * Behavioral tests for scripts/lib/owner-config/validate.mjs.
 * Covers all 7 section validators (schema-version, owner, tone, efficiency,
 * hardware-sharing, defaults, metadata) with happy + failure paths.
 * Tests never throw — validate() is defensive by contract.
 */

import { describe, it, expect } from 'vitest';

import { validate } from '@lib/owner-config/validate.mjs';

const HEX64 = 'a'.repeat(64);

function minimalValid(overrides = {}) {
  return {
    'schema-version': 1,
    owner: { name: 'Bernhard', language: 'de' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Non-object input
// ---------------------------------------------------------------------------

describe('validate() — non-object input guard', () => {
  it('rejects null with a single descriptive error', () => {
    const result = validate(null);
    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.errors).toEqual(['owner config must be an object']);
  });

  it('rejects array input', () => {
    const result = validate([]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('owner config must be an object');
  });

  it('rejects a string', () => {
    const result = validate('nope');
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['owner config must be an object']);
  });

  it('rejects undefined', () => {
    const result = validate(undefined);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['owner config must be an object']);
  });
});

// ---------------------------------------------------------------------------
// schema-version section
// ---------------------------------------------------------------------------

describe('validate() — schema-version section', () => {
  it('rejects a config with no schema-version', () => {
    const result = validate({ owner: { name: 'x', language: 'en' } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('schema-version is required');
  });

  it('rejects schema-version=null', () => {
    const result = validate({ 'schema-version': null, owner: { name: 'x', language: 'en' } });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('schema-version is required');
  });

  it('rejects schema-version=2 (future version not accepted)', () => {
    const result = validate({ 'schema-version': 2, owner: { name: 'x', language: 'en' } });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/schema-version must be 1/);
  });

  it('rejects schema-version=0', () => {
    const result = validate({ 'schema-version': 0, owner: { name: 'x', language: 'en' } });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/schema-version must be 1/);
  });

  it('accepts schema-version=1', () => {
    const result = validate(minimalValid());
    expect(result.ok).toBe(true);
    expect(result.value['schema-version']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// owner section
// ---------------------------------------------------------------------------

describe('validate() — owner section', () => {
  it('rejects when owner section is missing', () => {
    const result = validate({ 'schema-version': 1 });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('owner must be an object');
  });

  it('rejects when owner is not an object', () => {
    const result = validate({ 'schema-version': 1, owner: 'string' });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('owner must be an object');
  });

  it('rejects empty owner.name', () => {
    const result = validate({ 'schema-version': 1, owner: { name: '', language: 'en' } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.name'))).toBe(true);
  });

  it('rejects owner.name longer than 100 chars', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x'.repeat(101), language: 'en' } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.name'))).toBe(true);
  });

  it('accepts owner.name of exactly 100 chars', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x'.repeat(100), language: 'en' } });
    expect(result.ok).toBe(true);
  });

  it('rejects non-ISO-639-1 language code', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x', language: 'english' } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.language'))).toBe(true);
  });

  it('accepts two-letter lowercase language code', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x', language: 'de' } });
    expect(result.ok).toBe(true);
    expect(result.value.owner.language).toBe('de');
  });

  it('accepts region-suffixed language code like en-US', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x', language: 'en-US' } });
    expect(result.ok).toBe(true);
    expect(result.value.owner.language).toBe('en-US');
  });

  it('rejects malformed email-hash (too short)', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x', language: 'en', 'email-hash': 'abc' } });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.email-hash'))).toBe(true);
  });

  it('accepts a valid 64-char lowercase hex email-hash', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x', language: 'en', 'email-hash': HEX64 } });
    expect(result.ok).toBe(true);
    expect(result.value.owner['email-hash']).toBe(HEX64);
  });

  it('lowercases a mixed-case email-hash', () => {
    const mixedHex = 'A'.repeat(64);
    const result = validate({ 'schema-version': 1, owner: { name: 'x', language: 'en', 'email-hash': mixedHex } });
    expect(result.ok).toBe(true);
    expect(result.value.owner['email-hash']).toBe('a'.repeat(64));
  });

  it('accepts null email-hash (optional field)', () => {
    const result = validate({ 'schema-version': 1, owner: { name: 'x', language: 'en', 'email-hash': null } });
    expect(result.ok).toBe(true);
    expect(result.value.owner['email-hash']).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tone section
// ---------------------------------------------------------------------------

describe('validate() — tone section', () => {
  it('uses default tone values when tone section is absent', () => {
    const result = validate(minimalValid());
    expect(result.ok).toBe(true);
    expect(result.value.tone.style).toBe('neutral');
    expect(result.value.tone.tonality).toBeNull();
  });

  it('rejects tone when it is not an object', () => {
    const result = validate(minimalValid({ tone: 'loud' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('tone must be an object');
  });

  it('rejects invalid tone.style enum value', () => {
    const result = validate(minimalValid({ tone: { style: 'aggressive' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('tone.style'))).toBe(true);
  });

  it('accepts all three valid tone.style values', () => {
    for (const style of ['direct', 'neutral', 'friendly']) {
      const result = validate(minimalValid({ tone: { style } }));
      expect(result.ok).toBe(true);
      expect(result.value.tone.style).toBe(style);
    }
  });

  it('rejects tone.tonality longer than 200 chars', () => {
    const result = validate(minimalValid({ tone: { tonality: 'x'.repeat(201) } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('tone.tonality'))).toBe(true);
  });

  it('accepts a valid tonality string', () => {
    const result = validate(minimalValid({ tone: { tonality: 'austrian-pragmatic' } }));
    expect(result.ok).toBe(true);
    expect(result.value.tone.tonality).toBe('austrian-pragmatic');
  });
});

// ---------------------------------------------------------------------------
// efficiency section
// ---------------------------------------------------------------------------

describe('validate() — efficiency section', () => {
  it('uses defaults when efficiency section is absent', () => {
    const result = validate(minimalValid());
    expect(result.ok).toBe(true);
    expect(result.value.efficiency['output-level']).toBe('full');
    expect(result.value.efficiency.preamble).toBe('minimal');
    expect(result.value.efficiency['comments-in-code']).toBe('minimal');
  });

  it('rejects efficiency when it is not an object', () => {
    const result = validate(minimalValid({ efficiency: 42 }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('efficiency must be an object');
  });

  it('rejects invalid efficiency.output-level value', () => {
    const result = validate(minimalValid({ efficiency: { 'output-level': 'mega' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('efficiency.output-level'))).toBe(true);
  });

  it('rejects invalid efficiency.preamble value', () => {
    const result = validate(minimalValid({ efficiency: { preamble: 'extreme' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('efficiency.preamble'))).toBe(true);
  });

  it('rejects invalid efficiency.comments-in-code value', () => {
    const result = validate(minimalValid({ efficiency: { 'comments-in-code': 'none' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('efficiency.comments-in-code'))).toBe(true);
  });

  it('accepts all valid enum values for each efficiency field', () => {
    const result = validate(minimalValid({
      efficiency: { 'output-level': 'lite', preamble: 'verbose', 'comments-in-code': 'full' },
    }));
    expect(result.ok).toBe(true);
    expect(result.value.efficiency['output-level']).toBe('lite');
    expect(result.value.efficiency.preamble).toBe('verbose');
    expect(result.value.efficiency['comments-in-code']).toBe('full');
  });
});

// ---------------------------------------------------------------------------
// hardware-sharing section
// ---------------------------------------------------------------------------

describe('validate() — hardware-sharing section', () => {
  it('defaults hardware-sharing.enabled=false when section is absent', () => {
    const result = validate(minimalValid());
    expect(result.ok).toBe(true);
    expect(result.value['hardware-sharing'].enabled).toBe(false);
    expect(result.value['hardware-sharing']['hash-salt']).toBeNull();
  });

  it('rejects hardware-sharing when not an object', () => {
    const result = validate(minimalValid({ 'hardware-sharing': true }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('hardware-sharing must be an object');
  });

  it('rejects hardware-sharing.enabled when not boolean', () => {
    const result = validate(minimalValid({ 'hardware-sharing': { enabled: 'yes' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('hardware-sharing.enabled'))).toBe(true);
  });

  it('enforces privacy contract: enabled=true without hash-salt is rejected', () => {
    const result = validate(minimalValid({ 'hardware-sharing': { enabled: true } }));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes('hardware-sharing.enabled=true') && e.includes('hash-salt'))
    ).toBe(true);
  });

  it('accepts hardware-sharing.enabled=true when hash-salt is a valid 64-char hex', () => {
    const result = validate(minimalValid({ 'hardware-sharing': { enabled: true, 'hash-salt': HEX64 } }));
    expect(result.ok).toBe(true);
    expect(result.value['hardware-sharing'].enabled).toBe(true);
    expect(result.value['hardware-sharing']['hash-salt']).toBe(HEX64);
  });

  it('rejects malformed hash-salt (not 64-char hex)', () => {
    const result = validate(minimalValid({ 'hardware-sharing': { 'hash-salt': 'tooshort' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('hardware-sharing.hash-salt'))).toBe(true);
  });

  it('lowercases a valid hash-salt', () => {
    const result = validate(minimalValid({ 'hardware-sharing': { enabled: true, 'hash-salt': 'A'.repeat(64) } }));
    expect(result.ok).toBe(true);
    expect(result.value['hardware-sharing']['hash-salt']).toBe('a'.repeat(64));
  });
});

// ---------------------------------------------------------------------------
// defaults section
// ---------------------------------------------------------------------------

describe('validate() — defaults section', () => {
  it('returns null for optional defaults fields when section is absent', () => {
    const result = validate(minimalValid());
    expect(result.ok).toBe(true);
    expect(result.value.defaults['preferred-test-command']).toBeNull();
    expect(result.value.defaults['preferred-editor']).toBeNull();
  });

  it('rejects defaults when not an object', () => {
    const result = validate(minimalValid({ defaults: 'npm test' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('defaults must be an object');
  });

  it('rejects preferred-test-command longer than 200 chars', () => {
    const result = validate(minimalValid({ defaults: { 'preferred-test-command': 'x'.repeat(201) } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('defaults.preferred-test-command'))).toBe(true);
  });

  it('accepts a valid preferred-test-command string', () => {
    const result = validate(minimalValid({ defaults: { 'preferred-test-command': 'npm test' } }));
    expect(result.ok).toBe(true);
    expect(result.value.defaults['preferred-test-command']).toBe('npm test');
  });

  it('rejects preferred-editor longer than 50 chars', () => {
    const result = validate(minimalValid({ defaults: { 'preferred-editor': 'x'.repeat(51) } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('defaults.preferred-editor'))).toBe(true);
  });

  it('accepts a valid preferred-editor string', () => {
    const result = validate(minimalValid({ defaults: { 'preferred-editor': 'vim' } }));
    expect(result.ok).toBe(true);
    expect(result.value.defaults['preferred-editor']).toBe('vim');
  });
});

// ---------------------------------------------------------------------------
// metadata section
// ---------------------------------------------------------------------------

describe('validate() — metadata section', () => {
  it('returns null timestamps when metadata section is absent', () => {
    const result = validate(minimalValid());
    expect(result.ok).toBe(true);
    expect(result.value.metadata.created_at).toBeNull();
    expect(result.value.metadata.updated_at).toBeNull();
  });

  it('rejects metadata when not an object', () => {
    const result = validate(minimalValid({ metadata: 'yesterday' }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('metadata must be an object');
  });

  it('rejects metadata.created_at that cannot be parsed as ISO 8601', () => {
    const result = validate(minimalValid({ metadata: { created_at: 'not-a-date' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('metadata.created_at'))).toBe(true);
  });

  it('accepts a valid ISO 8601 timestamp for created_at', () => {
    const result = validate(minimalValid({ metadata: { created_at: '2026-04-28T12:00:00Z' } }));
    expect(result.ok).toBe(true);
    expect(result.value.metadata.created_at).toBe('2026-04-28T12:00:00Z');
  });

  it('rejects metadata.updated_at that cannot be parsed as ISO 8601', () => {
    const result = validate(minimalValid({ metadata: { updated_at: 'bad-ts' } }));
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('metadata.updated_at'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accumulation + closed contract
// ---------------------------------------------------------------------------

describe('validate() — error accumulation + closed contract', () => {
  it('accumulates errors from multiple sections in a single call', () => {
    const result = validate({
      'schema-version': 1,
      owner: { name: '', language: 'BOGUS' },
      tone: { style: 'snarky' },
      efficiency: { 'output-level': 'mega' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('drops unknown top-level sections from the output (closed contract)', () => {
    const result = validate({ ...minimalValid(), bogus: { a: 1 }, another: 'x' });
    expect(result.ok).toBe(true);
    expect(result.value).not.toHaveProperty('bogus');
    expect(result.value).not.toHaveProperty('another');
  });

  it('returns ok=true for a fully populated valid config', () => {
    const full = {
      'schema-version': 1,
      owner: { name: 'Test User', 'email-hash': HEX64, language: 'en-US' },
      tone: { style: 'direct', tonality: 'pragmatic' },
      efficiency: { 'output-level': 'lite', preamble: 'verbose', 'comments-in-code': 'full' },
      'hardware-sharing': { enabled: true, 'hash-salt': HEX64 },
      defaults: { 'preferred-test-command': 'npm test', 'preferred-editor': 'vim' },
      metadata: { created_at: '2026-04-28T12:00:00Z', updated_at: '2026-04-28T12:00:00Z' },
    };
    const result = validate(full);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
