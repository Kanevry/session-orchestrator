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

describe('checkOwnerConfig — whole-file discard with a survived optional section (#1244 Q3 MED)', () => {
  // Bug this catches: owner-yaml.mjs's #1244 MERGE RULE keeps a VALID optional
  // section (paths/dispatcher) alive through a whole-file discard — merged
  // onto its default in `result.config` — but the banner (pre-fix) rendered
  // "the entire file was discarded" regardless, because its discard branch
  // never looked at `result.config` at all. Fake-regression: reverting the
  // fix to the OLD literal (unconditional "is invalid (...) — the entire file
  // was discarded...") makes this test's `toContain('"paths"')` and
  // `.not.toContain('entire file was')` assertions fail while the sibling test
  // below (no config field at all, nothing survived) stays green either way —
  // which is exactly the false confidence Q3 measured against a real tmp
  // owner.yaml (invalid `owner.name`, valid `paths.confidential-names-file`).
  it('names the survived "paths" section instead of claiming a full discard', () => {
    const loader = () => ({
      config: {
        owner: { name: '', language: 'en' }, // discarded — replaced by default
        paths: {
          'vault-dir': '',
          'baseline-path': '',
          'namespace-map-path': '',
          'confidential-names-file': '/tmp/does-not-matter/names.json',
        },
      },
      source: 'defaults',
      errors: ['owner.name is required and must be a non-empty string'],
    });
    const result = checkOwnerConfig({ loader });
    expect(result.severity).toBe('warn');
    expect(result.discarded).toBe(true);
    expect(result.message).toContain('"paths"');
    expect(result.message).toContain('kept');
    expect(result.message).not.toContain('entire file was');
  });

  it('still renders the existing full-discard text when NOTHING survived (all-invalid control)', () => {
    // Same discard branch, but `result.config` (when present) is byte-identical
    // to getDefaults() for every optional section — nothing to name as kept.
    const loader = () => ({
      config: {
        owner: { name: '', language: 'en' },
        paths: { 'vault-dir': '', 'baseline-path': '', 'namespace-map-path': '', 'confidential-names-file': '' },
        dispatcher: { autonomy: '' },
      },
      source: 'defaults',
      errors: ['owner.name is required and must be a non-empty string'],
    });
    const result = checkOwnerConfig({ loader });
    expect(result.severity).toBe('warn');
    expect(result.discarded).toBe(true);
    expect(result.message).toContain('entire file was');
    expect(result.message).not.toContain('kept');
  });

  it('renders droppedSections on the discard branch when an optional section was ALSO malformed', () => {
    const loader = () => ({
      config: {
        owner: { name: '', language: 'en' },
        paths: { 'vault-dir': '', 'baseline-path': '', 'namespace-map-path': '', 'confidential-names-file': '' },
      },
      source: 'defaults',
      errors: ['owner.name is required and must be a non-empty string'],
      droppedSections: [{ section: 'dispatcher', errors: ['dispatcher must be an object when present'] }],
    });
    const result = checkOwnerConfig({ loader });
    expect(result.droppedSections).toEqual([
      { section: 'dispatcher', errors: ['dispatcher must be an object when present'] },
    ]);
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
