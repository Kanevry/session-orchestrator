import { describe, it, expect } from 'vitest';
import { DEFAULT_MODE, ALL_MODES, TIER_MODE_MAP } from '@lib/mode-selector/constants.mjs';

describe('constants — DEFAULT_MODE', () => {
  it('DEFAULT_MODE is the string "feature"', () => {
    expect(DEFAULT_MODE).toBe('feature');
  });

  it('DEFAULT_MODE is a string', () => {
    expect(typeof DEFAULT_MODE).toBe('string');
  });
});

describe('constants — ALL_MODES', () => {
  it('ALL_MODES contains exactly 6 entries', () => {
    expect(ALL_MODES).toHaveLength(6);
  });

  it('ALL_MODES contains "housekeeping"', () => {
    expect(ALL_MODES).toContain('housekeeping');
  });

  it('ALL_MODES contains "feature"', () => {
    expect(ALL_MODES).toContain('feature');
  });

  it('ALL_MODES contains "deep"', () => {
    expect(ALL_MODES).toContain('deep');
  });

  it('ALL_MODES contains "discovery"', () => {
    expect(ALL_MODES).toContain('discovery');
  });

  it('ALL_MODES contains "evolve"', () => {
    expect(ALL_MODES).toContain('evolve');
  });

  it('ALL_MODES contains "plan-retro"', () => {
    expect(ALL_MODES).toContain('plan-retro');
  });

  it('ALL_MODES is frozen (immutable)', () => {
    expect(Object.isFrozen(ALL_MODES)).toBe(true);
  });
});

describe('constants — TIER_MODE_MAP', () => {
  it('TIER_MODE_MAP maps "fast" → "housekeeping"', () => {
    expect(TIER_MODE_MAP['fast']).toBe('housekeeping');
  });

  it('TIER_MODE_MAP maps "standard" → "feature"', () => {
    expect(TIER_MODE_MAP['standard']).toBe('feature');
  });

  it('TIER_MODE_MAP maps "deep" → "deep"', () => {
    expect(TIER_MODE_MAP['deep']).toBe('deep');
  });

  it('TIER_MODE_MAP is frozen (immutable)', () => {
    expect(Object.isFrozen(TIER_MODE_MAP)).toBe(true);
  });

  it('TIER_MODE_MAP has exactly 3 keys', () => {
    expect(Object.keys(TIER_MODE_MAP)).toHaveLength(3);
  });
});
