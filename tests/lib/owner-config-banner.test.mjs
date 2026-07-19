/**
 * tests/lib/owner-config-banner.test.mjs
 *
 * Unit tests for scripts/lib/owner-config-banner.mjs (#820).
 *
 * The SUT takes an injectable `loader` — a fake function returning the shape
 * `loadOwnerConfig()` produces — so no filesystem access is needed here at
 * all. Mirrors the DI pattern used by tests/lib/ci-status-banner.test.mjs
 * (injectable dependency, no real I/O).
 */

import { describe, it, expect } from 'vitest';
import { checkOwnerConfig } from '@lib/owner-config-banner.mjs';

describe('checkOwnerConfig — clean load (no banner)', () => {
  it('returns null when source is "file" with no drops or warnings', () => {
    const loader = () => ({ source: 'file', errors: [] });
    expect(checkOwnerConfig({ loader })).toBe(null);
  });
});

describe('checkOwnerConfig — file absent (no banner)', () => {
  it('returns null when source is "defaults" and errors is empty (file simply absent)', () => {
    const loader = () => ({ source: 'defaults', errors: [] });
    expect(checkOwnerConfig({ loader })).toBe(null);
  });
});

describe('checkOwnerConfig — droppedSections present (warn)', () => {
  it('returns a warn finding naming the dropped section', () => {
    const loader = () => ({
      source: 'partial',
      errors: [],
      droppedSections: [{ section: 'paths', errors: ['paths must be an object when present'] }],
    });
    const result = checkOwnerConfig({ loader });
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('"paths"');
    expect(result.droppedSections).toEqual([
      { section: 'paths', errors: ['paths must be an object when present'] },
    ]);
  });
});

describe('checkOwnerConfig — whole-file discard (warn, discarded flag)', () => {
  it('returns a warn finding with discarded:true when a REQUIRED section was invalid', () => {
    const loader = () => ({
      source: 'defaults',
      errors: ['tone.style must be one of direct, neutral, friendly, got: "nonsense"'],
    });
    const result = checkOwnerConfig({ loader });
    expect(result.severity).toBe('warn');
    expect(result.discarded).toBe(true);
    expect(result.message).toContain('entire file was');
  });
});

describe('checkOwnerConfig — sectionWarnings only (warn)', () => {
  it('returns a warn finding naming the section with invalid list entries', () => {
    const loader = () => ({
      source: 'file',
      errors: [],
      sectionWarnings: [{ section: 'baselines', errors: ['baselines[0].match must be an object'] }],
    });
    const result = checkOwnerConfig({ loader });
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('"baselines"');
    expect(result.sectionWarnings).toEqual([
      { section: 'baselines', errors: ['baselines[0].match must be an object'] },
    ]);
  });
});

describe('checkOwnerConfig — throwing loader (never throws)', () => {
  it('returns null when the loader throws', () => {
    const loader = () => {
      throw new Error('boom');
    };
    expect(() => checkOwnerConfig({ loader })).not.toThrow();
    expect(checkOwnerConfig({ loader })).toBe(null);
  });
});
