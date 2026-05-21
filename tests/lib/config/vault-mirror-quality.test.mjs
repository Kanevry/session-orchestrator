/**
 * vault-mirror-quality.test.mjs — Unit tests for scripts/lib/config/vault-mirror-quality.mjs
 *
 * Tolerant parser for the top-level `vault-mirror:` YAML block, extracting the
 * nested `quality:` sub-block (PRD F1.2 / issue #504).
 *
 * Returns shape: `{ quality: { "min-narrative-chars": int, "min-confidence": float } }`.
 * Tolerant: malformed values silently fall back to defaults.
 *
 * Mirrors the style of tests/lib/config/vault-staleness.test.mjs and
 * tests/lib/config/events-rotation.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseVaultMirrorQuality } from '@lib/config/vault-mirror-quality.mjs';

const DEFAULTS = {
  quality: {
    'min-narrative-chars': 400,
    'min-confidence': 0.5,
  },
};

describe('_parseVaultMirrorQuality', () => {
  describe('defaults (block absent or empty)', () => {
    it('returns all defaults when vault-mirror block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseVaultMirrorQuality(content)).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty (heading-only)', () => {
      const content = 'vault-mirror:\n\nnext-section:\n';
      expect(_parseVaultMirrorQuality(content)).toEqual(DEFAULTS);
    });

    it('returns all defaults when block contains only unrelated keys', () => {
      const content = 'vault-mirror:\n  other-key: value\n';
      expect(_parseVaultMirrorQuality(content)).toEqual(DEFAULTS);
    });
  });

  describe('quality.min-confidence override', () => {
    it('parses min-confidence: 0.7 and overrides default', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 0.7',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(0.7);
    });

    it('keeps default min-narrative-chars when only min-confidence is given', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 0.7',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-narrative-chars']).toBe(400);
    });
  });

  describe('quality.min-narrative-chars override', () => {
    it('parses min-narrative-chars: 999 and overrides default', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-narrative-chars: 999',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-narrative-chars']).toBe(999);
    });

    it('keeps default min-confidence when only min-narrative-chars is given', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-narrative-chars: 999',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(0.5);
    });
  });

  describe('malformed values fall back to defaults', () => {
    it('falls back to default min-narrative-chars when value is non-numeric ("abc")', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-narrative-chars: abc',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-narrative-chars']).toBe(400);
    });

    it('falls back to default min-confidence when value is non-numeric ("xyz")', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: xyz',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(0.5);
    });
  });

  describe('min-confidence bounds [0.0, 1.0]', () => {
    it('falls back to default 0.5 when min-confidence is negative (-0.1)', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: -0.1',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(0.5);
    });

    it('falls back to default 0.5 when min-confidence exceeds 1.0 (2.0)', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 2.0',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(0.5);
    });

    it('accepts the boundary value 0.0', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 0.0',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(0.0);
    });

    it('accepts the boundary value 1.0', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 1.0',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(1.0);
    });
  });

  describe('block boundary detection', () => {
    it('stops parsing at the next top-level key', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 0.9',
        'next-section:',
        '  quality:',
        '    min-confidence: 0.1',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      // The first block's quality wins; second block is outside vault-mirror.
      expect(result.quality['min-confidence']).toBe(0.9);
    });
  });

  describe('inline comment stripping', () => {
    it('strips inline YAML comments from min-confidence', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-confidence: 0.5  # default',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-confidence']).toBe(0.5);
    });

    it('strips inline YAML comments from min-narrative-chars', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-narrative-chars: 600  # raised',
        '',
      ].join('\n');
      const result = _parseVaultMirrorQuality(content);
      expect(result.quality['min-narrative-chars']).toBe(600);
    });
  });

  describe('full block', () => {
    it('parses both fields together', () => {
      const content = [
        'vault-mirror:',
        '  quality:',
        '    min-narrative-chars: 500',
        '    min-confidence: 0.8',
        '',
      ].join('\n');
      expect(_parseVaultMirrorQuality(content)).toEqual({
        quality: {
          'min-narrative-chars': 500,
          'min-confidence': 0.8,
        },
      });
    });
  });
});
