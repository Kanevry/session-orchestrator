/**
 * tests/lib/owner-config/merge.test.mjs
 *
 * Behavioral tests for scripts/lib/owner-config/merge.mjs.
 * Verifies precedence rules, null/undefined input handling, per-section merging,
 * and the schema-version stamping invariant.
 */

import { describe, it, expect } from 'vitest';

import { merge } from '@lib/owner-config/merge.mjs';
import { defaults } from '@lib/owner-config/defaults.mjs';
import { CURRENT_OWNER_SCHEMA_VERSION } from '@lib/owner-config/constants.mjs';

describe('merge() — null/undefined/empty inputs', () => {
  it('returns the canonical defaults when both inputs are empty objects', () => {
    expect(merge({}, {})).toEqual(defaults());
  });

  it('treats null base as empty object', () => {
    expect(merge(null, {})).toEqual(defaults());
  });

  it('treats undefined base as empty object', () => {
    expect(merge(undefined, {})).toEqual(defaults());
  });

  it('treats null override as empty object', () => {
    expect(merge({}, null)).toEqual(defaults());
  });

  it('treats undefined override as empty object', () => {
    expect(merge({}, undefined)).toEqual(defaults());
  });

  it('returns defaults when both inputs are null', () => {
    expect(merge(null, null)).toEqual(defaults());
  });
});

describe('merge() — schema-version stamping', () => {
  it('always stamps the current schema-version regardless of inputs', () => {
    const out = merge({ 'schema-version': 99 }, { 'schema-version': 0 });
    expect(out['schema-version']).toBe(CURRENT_OWNER_SCHEMA_VERSION);
  });
});

describe('merge() — override precedence', () => {
  it('override wins on leaf keys that are explicitly set', () => {
    const base = { tone: { style: 'direct' } };
    const override = { tone: { style: 'friendly' } };
    const out = merge(base, override);
    expect(out.tone.style).toBe('friendly');
  });

  it('base value survives when override omits the key', () => {
    const base = { tone: { style: 'direct', tonality: 'pragmatic' } };
    const override = { tone: { style: 'friendly' } };
    const out = merge(base, override);
    expect(out.tone.style).toBe('friendly');
    expect(out.tone.tonality).toBe('pragmatic');
  });

  it('override does not apply undefined values (undefined is skipped)', () => {
    const base = { tone: { style: 'direct' } };
    const override = { tone: { style: undefined } };
    const out = merge(base, override);
    // undefined entry is skipped — base value is preserved
    expect(out.tone.style).toBe('direct');
  });

  it('override null value wins over base non-null value', () => {
    const base = { tone: { tonality: 'pragmatic' } };
    const override = { tone: { tonality: null } };
    const out = merge(base, override);
    expect(out.tone.tonality).toBeNull();
  });
});

describe('merge() — per-section behavior', () => {
  it('preserves base owner fields when override has no owner section', () => {
    const base = { owner: { name: 'Alice', language: 'en' } };
    const out = merge(base, {});
    expect(out.owner.name).toBe('Alice');
    expect(out.owner.language).toBe('en');
  });

  it('override owner fields win over base', () => {
    const base = { owner: { name: 'Alice', language: 'en' } };
    const override = { owner: { name: 'Bob' } };
    const out = merge(base, override);
    expect(out.owner.name).toBe('Bob');
    // language from base survives since override does not set it
    expect(out.owner.language).toBe('en');
  });

  it('hardware-sharing section merges correctly', () => {
    const base = { 'hardware-sharing': { enabled: false, 'hash-salt': null } };
    const override = { 'hardware-sharing': { enabled: true, 'hash-salt': 'f'.repeat(64) } };
    const out = merge(base, override);
    expect(out['hardware-sharing'].enabled).toBe(true);
    expect(out['hardware-sharing']['hash-salt']).toBe('f'.repeat(64));
  });

  it('fills missing sections from defaults', () => {
    const out = merge({ owner: { name: 'X', language: 'en' } }, {});
    expect(out.efficiency['output-level']).toBe('full');
    expect(out.tone.style).toBe('neutral');
    expect(out.metadata.created_at).toBeNull();
  });

  it('returns a fresh object on each call (no shared section reference)', () => {
    const a = merge({}, {});
    const b = merge({}, {});
    a.owner.name = 'mutated';
    expect(b.owner.name).toBe('');
  });
});
