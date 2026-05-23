/**
 * memory.test.mjs — Unit tests for scripts/lib/config/memory.mjs
 *
 * Tolerant parser for the top-level `memory:` YAML block (issue #505).
 * Covers defaults, banner enabled flag flip, string/case coercion,
 * inline comment stripping, sub-block boundary detection, and
 * sibling top-level key isolation.
 *
 * Mirrors the style of tests/lib/config/cold-start.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseMemory } from '@lib/config/memory.mjs';

const DEFAULTS = { banner: { enabled: true } };

describe('_parseMemory', () => {
  describe('defaults (block absent or empty)', () => {
    it('returns default {banner:{enabled:true}} on empty string', () => {
      expect(_parseMemory('')).toEqual(DEFAULTS);
    });

    it('returns default when memory block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('returns default when memory block is present but has no banner sub-block', () => {
      const content = 'memory:\n\nnext-section:\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });

    it('returns default when memory block has other keys but no banner key', () => {
      const content = 'memory:\n  other-key: something\n';
      expect(_parseMemory(content)).toEqual(DEFAULTS);
    });
  });

  describe('banner.enabled flag flip', () => {
    it('returns enabled:true when explicitly set to true', () => {
      const content = 'memory:\n  banner:\n    enabled: true\n';
      expect(_parseMemory(content)).toEqual({ banner: { enabled: true } });
    });

    it('returns enabled:false when explicitly set to false', () => {
      const content = 'memory:\n  banner:\n    enabled: false\n';
      expect(_parseMemory(content)).toEqual({ banner: { enabled: false } });
    });

    it('keeps enabled:true when banner sub-block is present but enabled key is absent', () => {
      const content = 'memory:\n  banner:\n';
      expect(_parseMemory(content)).toEqual({ banner: { enabled: true } });
    });
  });

  describe('string and case coercion', () => {
    it('coerces quoted "true" string to enabled:true', () => {
      const content = 'memory:\n  banner:\n    enabled: "true"\n';
      expect(_parseMemory(content)).toEqual({ banner: { enabled: true } });
    });

    it('coerces quoted "false" string to enabled:false', () => {
      const content = 'memory:\n  banner:\n    enabled: "false"\n';
      expect(_parseMemory(content)).toEqual({ banner: { enabled: false } });
    });

    it('coerces uppercase FALSE to enabled:false', () => {
      const content = 'memory:\n  banner:\n    enabled: FALSE\n';
      expect(_parseMemory(content)).toEqual({ banner: { enabled: false } });
    });

    it('coerces any non-"false" value to enabled:true', () => {
      const content = 'memory:\n  banner:\n    enabled: anything-else\n';
      expect(_parseMemory(content)).toEqual({ banner: { enabled: true } });
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
      expect(_parseMemory(content)).toEqual({ banner: { enabled: true } });
    });

    it('strips inline YAML comment when value is false', () => {
      const content = [
        'memory:',
        '  banner:',
        '    enabled: false  # suppress banner',
        '',
      ].join('\n');
      expect(_parseMemory(content)).toEqual({ banner: { enabled: false } });
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
      expect(_parseMemory(content)).toEqual({ banner: { enabled: false } });
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
      expect(_parseMemory(content)).toEqual({ banner: { enabled: true } });
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
});
