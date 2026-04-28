/**
 * tests/scripts/owner-config.test.mjs
 *
 * Vitest suite for scripts/lib/owner-config.mjs — schema, validator, defaults
 * and merge. Pure-module tests (no I/O). The loader (`owner-config-loader.mjs`)
 * has its own suite at `owner-config-loader.test.mjs`.
 *
 * Issue #174 (D1 of Sub-Epic #161 — Owner Persona Layer).
 */

import { describe, it, expect } from 'vitest';

import {
  validate,
  coerce,
  defaults,
  merge,
  OwnerConfigError,
  CURRENT_OWNER_SCHEMA_VERSION,
  VALID_TONE_STYLES,
  VALID_OUTPUT_LEVELS,
} from '../../scripts/lib/owner-config.mjs';

const HEX64 = 'a'.repeat(64);

function minimalValid(overrides = {}) {
  return {
    'schema-version': 1,
    owner: { name: 'Bernhard', language: 'de' },
    ...overrides,
  };
}

describe('owner-config defaults()', () => {
  it('returns a config with schema-version 1', () => {
    const def = defaults();
    expect(def['schema-version']).toBe(1);
  });

  it('returns blank required user fields (interview will fill them)', () => {
    const def = defaults();
    expect(def.owner.name).toBe('');
    expect(def.owner.language).toBe('');
  });

  it('returns the canonical default enum values', () => {
    const def = defaults();
    expect(def.tone.style).toBe('neutral');
    expect(def.efficiency['output-level']).toBe('full');
    expect(def.efficiency.preamble).toBe('minimal');
    expect(def.efficiency['comments-in-code']).toBe('minimal');
  });

  it('returns hardware-sharing.enabled=false (consent gate off)', () => {
    const def = defaults();
    expect(def['hardware-sharing'].enabled).toBe(false);
    expect(def['hardware-sharing']['hash-salt']).toBeNull();
  });
});

describe('owner-config validate() — happy path', () => {
  it('accepts the minimal valid config and fills defaults', () => {
    const result = validate(minimalValid());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({
      'schema-version': 1,
      owner: { name: 'Bernhard', language: 'de', 'email-hash': null },
      tone: { style: 'neutral', tonality: null },
      efficiency: { 'output-level': 'full', preamble: 'minimal', 'comments-in-code': 'minimal' },
      'hardware-sharing': { enabled: false, 'hash-salt': null },
      defaults: { 'preferred-test-command': null, 'preferred-editor': null },
      metadata: { created_at: null, updated_at: null },
    });
  });

  it('accepts a fully-populated config (every field set)', () => {
    const full = {
      'schema-version': 1,
      owner: { name: 'Test User', 'email-hash': HEX64, language: 'en-US' },
      tone: { style: 'direct', tonality: 'austrian-pragmatic' },
      efficiency: { 'output-level': 'lite', preamble: 'verbose', 'comments-in-code': 'full' },
      'hardware-sharing': { enabled: true, 'hash-salt': HEX64 },
      defaults: { 'preferred-test-command': 'npm test', 'preferred-editor': 'vim' },
      metadata: { created_at: '2026-04-28T12:00:00Z', updated_at: '2026-04-28T12:00:00Z' },
    };
    const result = validate(full);
    expect(result.ok).toBe(true);
    expect(result.value.owner['email-hash']).toBe(HEX64);
    expect(result.value['hardware-sharing'].enabled).toBe(true);
    expect(result.value.defaults['preferred-test-command']).toBe('npm test');
  });

  it('drops unknown top-level sections (closed contract)', () => {
    const raw = { ...minimalValid(), bogus_section: { a: 1 }, another: 'x' };
    const result = validate(raw);
    expect(result.ok).toBe(true);
    expect(result.value).not.toHaveProperty('bogus_section');
    expect(result.value).not.toHaveProperty('another');
  });
});

describe('owner-config validate() — failure paths', () => {
  it('rejects non-object input', () => {
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

  it('rejects missing schema-version', () => {
    const raw = { owner: { name: 'x', language: 'en' } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('schema-version is required');
  });

  it('rejects schema-version mismatch (refuses future versions)', () => {
    const raw = { 'schema-version': 2, owner: { name: 'x', language: 'en' } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/schema-version must be 1/);
  });

  it('rejects empty owner.name', () => {
    const raw = { 'schema-version': 1, owner: { name: '', language: 'en' } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.name'))).toBe(true);
  });

  it('rejects owner.name > 100 chars', () => {
    const raw = { 'schema-version': 1, owner: { name: 'x'.repeat(101), language: 'en' } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.name'))).toBe(true);
  });

  it('rejects non-ISO-639-1 language', () => {
    const raw = { 'schema-version': 1, owner: { name: 'x', language: 'english' } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.language'))).toBe(true);
  });

  it('rejects malformed email-hash', () => {
    const raw = { 'schema-version': 1, owner: { name: 'x', language: 'en', 'email-hash': 'tooshort' } };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('owner.email-hash'))).toBe(true);
  });

  it('rejects invalid tone.style enum', () => {
    const raw = minimalValid({ tone: { style: 'snarky' } });
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('tone.style'))).toBe(true);
  });

  it('rejects invalid efficiency.output-level enum', () => {
    const raw = minimalValid({ efficiency: { 'output-level': 'mega' } });
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('efficiency.output-level'))).toBe(true);
  });

  it('enforces the privacy contract: enabled=true requires hash-salt', () => {
    const raw = minimalValid({ 'hardware-sharing': { enabled: true } });
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.includes('hardware-sharing.enabled=true') && e.includes('hash-salt')
      )
    ).toBe(true);
  });

  it('accepts hardware-sharing.enabled=true when hash-salt is present', () => {
    const raw = minimalValid({ 'hardware-sharing': { enabled: true, 'hash-salt': HEX64 } });
    const result = validate(raw);
    expect(result.ok).toBe(true);
    expect(result.value['hardware-sharing'].enabled).toBe(true);
  });

  it('accumulates multiple errors (does not bail on first failure)', () => {
    const raw = {
      'schema-version': 1,
      owner: { name: '', language: 'BOGUS' },
      tone: { style: 'snarky' },
      efficiency: { 'output-level': 'mega' },
    };
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });

  it('rejects metadata.created_at when not parsable as ISO timestamp', () => {
    const raw = minimalValid({ metadata: { created_at: 'not-a-date' } });
    const result = validate(raw);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes('metadata.created_at'))).toBe(true);
  });
});

describe('owner-config coerce()', () => {
  it('returns the normalized value on success', () => {
    const value = coerce(minimalValid());
    expect(value['schema-version']).toBe(CURRENT_OWNER_SCHEMA_VERSION);
    expect(value.owner.name).toBe('Bernhard');
    expect(value.tone.style).toBe('neutral');
  });

  it('throws OwnerConfigError with errors attached on failure', () => {
    expect.assertions(3);
    try {
      coerce({ 'schema-version': 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(OwnerConfigError);
      expect(err.errors.length).toBeGreaterThan(0);
      expect(err.message).toMatch(/owner config validation failed/);
    }
  });
});

describe('owner-config merge()', () => {
  it('returns a full default-filled config when both inputs are empty', () => {
    const out = merge({}, {});
    expect(out).toEqual(defaults());
  });

  it('treats null inputs as empty', () => {
    const out = merge(null, undefined);
    expect(out).toEqual(defaults());
  });

  it('lets override beat base on every defined leaf', () => {
    const base = { tone: { style: 'direct', tonality: 'austrian-pragmatic' } };
    const override = { tone: { style: 'friendly' } };
    const out = merge(base, override);
    expect(out.tone.style).toBe('friendly');
    // Tonality from base survives when override leaves it undefined.
    expect(out.tone.tonality).toBe('austrian-pragmatic');
  });

  it('preserves base values when override section is absent', () => {
    const base = { owner: { name: 'Alice', language: 'en' } };
    const out = merge(base, {});
    expect(out.owner.name).toBe('Alice');
    expect(out.owner.language).toBe('en');
  });

  it('always stamps schema-version=1 on the output (regardless of inputs)', () => {
    const out = merge({ 'schema-version': 99 }, { 'schema-version': 0 });
    expect(out['schema-version']).toBe(CURRENT_OWNER_SCHEMA_VERSION);
  });
});

describe('owner-config exported constants', () => {
  it('exposes the canonical tone-style enum', () => {
    expect(VALID_TONE_STYLES).toEqual(['direct', 'neutral', 'friendly']);
  });

  it('exposes the canonical output-level enum', () => {
    expect(VALID_OUTPUT_LEVELS).toEqual(['lite', 'full', 'ultra']);
  });
});
