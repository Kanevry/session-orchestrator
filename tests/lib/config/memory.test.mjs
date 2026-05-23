/**
 * memory.test.mjs — Unit tests for scripts/lib/config/memory.mjs
 *
 * Tolerant parser for the top-level `memory:` YAML block.
 * Covers two sub-blocks:
 *   - banner   (issue #505 — opt-out for session-start memory banner)
 *   - proposals (issue #501, F2.1 — agent-writable memory tool quotas)
 *
 * Tests cover defaults, sub-block flag flips, string/case coercion,
 * inline comment stripping, sub-block boundary detection, sibling top-level
 * key isolation, and the proposals quota / confidence-floor validation.
 *
 * Mirrors the style of tests/lib/config/cold-start.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseMemory } from '@lib/config/memory.mjs';

const DEFAULTS = {
  banner: { enabled: true },
  proposals: {
    enabled: true,
    'quota-per-wave': 5,
    'confidence-floor': 0.5,
  },
};

describe('_parseMemory', () => {
  describe('defaults (block absent or empty)', () => {
    it('returns default shape on empty string', () => {
      expect(_parseMemory('')).toEqual(DEFAULTS);
    });

    it('returns default when memory block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('returns default when memory block is present but has no sub-blocks', () => {
      const content = 'memory:\n\nnext-section:\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('returns default when memory block has other keys but no recognised sub-blocks', () => {
      const content = 'memory:\n  other-key: something\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });
  });

  describe('banner.enabled flag flip', () => {
    it('returns enabled:true when explicitly set to true', () => {
      const content = 'memory:\n  banner:\n    enabled: true\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('returns enabled:false when explicitly set to false', () => {
      const content = 'memory:\n  banner:\n    enabled: false\n';
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: false },
        proposals: { enabled: true, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
      });
    });

    it('keeps enabled:true when banner sub-block is present but enabled key is absent', () => {
      const content = 'memory:\n  banner:\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });
  });

  describe('string and case coercion (banner)', () => {
    it('coerces quoted "true" string to enabled:true', () => {
      const content = 'memory:\n  banner:\n    enabled: "true"\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('coerces quoted "false" string to enabled:false', () => {
      const content = 'memory:\n  banner:\n    enabled: "false"\n';
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: false },
        proposals: { enabled: true, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
      });
    });

    it('coerces uppercase FALSE to enabled:false', () => {
      const content = 'memory:\n  banner:\n    enabled: FALSE\n';
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: false },
        proposals: { enabled: true, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
      });
    });

    it('coerces any non-"false" value to enabled:true', () => {
      const content = 'memory:\n  banner:\n    enabled: anything-else\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    // #541 G5 — single-quote stripping. Without the single-quote strip at
    // memory.mjs:110, the literal value `'false'` (with apostrophes) would
    // not equal the lowercased `'false'`, so `bannerEnabled = v.toLowerCase() !== 'false'`
    // would resolve to `true` (wrong). The negative case below is the falsifying assertion.
    it("strips single quotes from 'false' to enabled:false (#541 G5)", () => {
      const content = "memory:\n  banner:\n    enabled: 'false'\n";
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: false },
        proposals: { enabled: true, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
      });
    });

    it("strips single quotes from 'true' to enabled:true (#541 G5 symmetric positive)", () => {
      const content = "memory:\n  banner:\n    enabled: 'true'\n";
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });
  });

  describe('inline comments', () => {
    it('strips inline YAML comments and returns correct value', () => {
      const content = [
        'memory:',
        '  banner:',
        '    enabled: true  # show memory banner',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('strips inline YAML comment when value is false', () => {
      const content = [
        'memory:',
        '  banner:',
        '    enabled: false  # suppress banner',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: false },
        proposals: { enabled: true, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
      });
    });
  });

  describe('block boundary detection', () => {
    it('stops parsing memory block at the next top-level key', () => {
      // The `enabled: true` inside `cold-start:` must NOT bleed back into memory.
      const content = [
        'memory:',
        '  banner:',
        '    enabled: false',
        'cold-start:',
        '  enabled: true',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: false },
        proposals: { enabled: true, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
      });
    });

    it('exits banner sub-block when a sibling key appears inside memory block', () => {
      // A second 2-space-indented key after `banner:` should end the banner block.
      // The `enabled: false` on the sibling must NOT influence banner.enabled.
      const content = [
        'memory:',
        '  banner:',
        '    enabled: true',
        '  other-setting:',
        '    enabled: false',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('ignores memory-like content that is not at column 0', () => {
      // An indented `memory:` key does not start the block.
      const content = [
        'persistence: true',
        '  memory: false',
        'enforcement: warn',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });
  });

  describe('proposals sub-block (issue #501)', () => {
    it('returns default proposals shape when memory block is absent', () => {
      const content = 'persistence: true\n';
      expect(_parseMemory(content).proposals).toEqual({
        enabled: true,
        'quota-per-wave': 5,
        'confidence-floor': 0.5,
      });
    });

    it('returns proposals.enabled=false when explicitly set to false', () => {
      const content = [
        'memory:',
        '  proposals:',
        '    enabled: false',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: true },
        proposals: { enabled: false, 'quota-per-wave': 5, 'confidence-floor': 0.5 },
      });
    });

    it('returns proposals fields verbatim when all explicitly configured', () => {
      const content = [
        'memory:',
        '  proposals:',
        '    enabled: true',
        '    quota-per-wave: 10',
        '    confidence-floor: 0.7',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: true },
        proposals: { enabled: true, 'quota-per-wave': 10, 'confidence-floor': 0.7 },
      });
    });

    it('falls back to quota-per-wave=5 when value is negative', () => {
      const content = [
        'memory:',
        '  proposals:',
        '    quota-per-wave: -3',
        '',
      ].join('\n');
      expect(_parseMemory(content).proposals['quota-per-wave']).toBe(5);
    });

    it('parses banner and proposals sub-blocks together without crosstalk', () => {
      const content = [
        'memory:',
        '  banner:',
        '    enabled: false',
        '  proposals:',
        '    enabled: true',
        '    quota-per-wave: 8',
        '    confidence-floor: 0.6',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual({
        banner: { enabled: false },
        proposals: { enabled: true, 'quota-per-wave': 8, 'confidence-floor': 0.6 },
      });
    });
  });

  // Issue #549 G5 — `confidence-floor` range guard (memory.mjs:131-135)
  // Range check is `f >= 0.0 && f <= 1.0`. Out-of-range values fall through to default 0.5.
  // Boundary values 0.0 and 1.0 must be RETAINED, not rejected.
  describe('confidence-floor range guard (#549 G5)', () => {
    it('falls back to default 0.5 when confidence-floor is negative (-0.1)', () => {
      const content = [
        'memory:',
        '  proposals:',
        '    confidence-floor: -0.1',
        '',
      ].join('\n');
      expect(_parseMemory(content).proposals['confidence-floor']).toBe(0.5);
    });

    it('falls back to default 0.5 when confidence-floor is >1.0 (1.5)', () => {
      const content = [
        'memory:',
        '  proposals:',
        '    confidence-floor: 1.5',
        '',
      ].join('\n');
      expect(_parseMemory(content).proposals['confidence-floor']).toBe(0.5);
    });

    it('retains confidence-floor at boundary 0.0 (accept-everything)', () => {
      const content = [
        'memory:',
        '  proposals:',
        '    confidence-floor: 0.0',
        '',
      ].join('\n');
      expect(_parseMemory(content).proposals['confidence-floor']).toBe(0.0);
    });

    it('retains confidence-floor at boundary 1.0 (only-perfect-confidence)', () => {
      const content = [
        'memory:',
        '  proposals:',
        '    confidence-floor: 1.0',
        '',
      ].join('\n');
      expect(_parseMemory(content).proposals['confidence-floor']).toBe(1.0);
    });
  });

  // Issue #549 G6 — sub-block order independence (memory.mjs:80-138)
  // `inBannerBlock` / `inProposalsBlock` flags are mutually-exclusive (lines 87, 94).
  // Reverse order MUST produce identical parsed output.
  describe('sub-block order independence (#549 G6)', () => {
    it('produces identical output when proposals comes before banner vs reverse', () => {
      const proposalsFirst = [
        'memory:',
        '  proposals:',
        '    enabled: true',
        '    quota-per-wave: 5',
        '    confidence-floor: 0.5',
        '  banner:',
        '    enabled: true',
        '',
      ].join('\n');
      const bannerFirst = [
        'memory:',
        '  banner:',
        '    enabled: true',
        '  proposals:',
        '    enabled: true',
        '    quota-per-wave: 5',
        '    confidence-floor: 0.5',
        '',
      ].join('\n');
      const parsedA = _parseMemory(proposalsFirst);
      const parsedB = _parseMemory(bannerFirst);
      expect(parsedA).toEqual(parsedB);
    });
  });
});
