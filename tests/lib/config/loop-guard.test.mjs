/**
 * loop-guard.test.mjs — Unit tests for scripts/lib/config/loop-guard.mjs
 *
 * Tolerant parser for the top-level `loop-guard:` YAML block (ecc-analysis /
 * #619). Drives the PostToolUse runaway-loop detector. Returns
 * `{ enabled, threshold, window }`. `parseBoundedInt` is a private helper — its
 * clamping behaviour is exercised through `_parseLoopGuard`'s `threshold` /
 * `window` keys (the public contract), not directly.
 *
 * Covers: defaults, enabled flip, bounded-int clamping (below min, negative,
 * zero, garbage, quoted, inline-comment), block-boundary detection, and the
 * #628 `threshold > window` self-heal clamp.
 *
 * Mirrors the style of tests/lib/config/cold-start.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseLoopGuard } from '@lib/config/loop-guard.mjs';

const DEFAULTS = { enabled: true, threshold: 3, window: 5 };

describe('_parseLoopGuard', () => {
  describe('defaults (block absent or empty)', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseLoopGuard('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when loop-guard block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseLoopGuard(content)).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'loop-guard:\n\nnext-section:\n';
      expect(_parseLoopGuard(content)).toEqual(DEFAULTS);
    });

    it('ignores an indented loop-guard-like token (not a column-0 block start)', () => {
      const content = 'parent:\n  loop-guard:\n    threshold: 99\n';
      expect(_parseLoopGuard(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('flips enabled to false on explicit "false"', () => {
      const content = 'loop-guard:\n  enabled: false\n';
      expect(_parseLoopGuard(content).enabled).toBe(false);
    });

    it('keeps enabled true on explicit "true"', () => {
      const content = 'loop-guard:\n  enabled: true\n';
      expect(_parseLoopGuard(content).enabled).toBe(true);
    });

    it('treats a garbage enabled value as enabled (default true, only "false" disables)', () => {
      const content = 'loop-guard:\n  enabled: maybe\n';
      expect(_parseLoopGuard(content).enabled).toBe(true);
    });

    it('keeps default enabled=true when key absent from a non-empty block', () => {
      const content = 'loop-guard:\n  threshold: 4\n';
      expect(_parseLoopGuard(content).enabled).toBe(true);
    });
  });

  describe('threshold bounded-int clamping (min 2, default 3)', () => {
    it('parses a valid in-range threshold override', () => {
      const content = 'loop-guard:\n  threshold: 4\n';
      expect(_parseLoopGuard(content).threshold).toBe(4);
    });

    it('falls back to default 3 when threshold is below the minimum (1)', () => {
      const content = 'loop-guard:\n  threshold: 1\n';
      expect(_parseLoopGuard(content).threshold).toBe(3);
    });

    it('falls back to default 3 when threshold is negative', () => {
      const content = 'loop-guard:\n  threshold: -4\n';
      expect(_parseLoopGuard(content).threshold).toBe(3);
    });

    it('falls back to default 3 when threshold is zero', () => {
      const content = 'loop-guard:\n  threshold: 0\n';
      expect(_parseLoopGuard(content).threshold).toBe(3);
    });

    it('falls back to default 3 when threshold is non-numeric garbage', () => {
      const content = 'loop-guard:\n  threshold: abc\n';
      expect(_parseLoopGuard(content).threshold).toBe(3);
    });

    it('accepts a large in-range threshold (no upper bound, window clamps up)', () => {
      const content = 'loop-guard:\n  threshold: 99\n  window: 99\n';
      const result = _parseLoopGuard(content);
      expect(result.threshold).toBe(99);
      expect(result.window).toBe(99);
    });
  });

  describe('window bounded-int clamping (min 2, default 5)', () => {
    it('parses a valid in-range window override', () => {
      const content = 'loop-guard:\n  threshold: 2\n  window: 8\n';
      expect(_parseLoopGuard(content).window).toBe(8);
    });

    it('falls back to default 5 when window is below the minimum (1)', () => {
      const content = 'loop-guard:\n  window: 1\n';
      expect(_parseLoopGuard(content).window).toBe(5);
    });

    it('falls back to default 5 when window is zero', () => {
      const content = 'loop-guard:\n  window: 0\n';
      expect(_parseLoopGuard(content).window).toBe(5);
    });

    it('falls back to default 5 when window is non-numeric garbage', () => {
      const content = 'loop-guard:\n  window: nope\n';
      expect(_parseLoopGuard(content).window).toBe(5);
    });
  });

  describe('quoted values + inline comment stripping', () => {
    it('strips surrounding double quotes from a numeric value', () => {
      const content = 'loop-guard:\n  threshold: "4"\n';
      expect(_parseLoopGuard(content).threshold).toBe(4);
    });

    it('strips surrounding single quotes from a numeric value', () => {
      const content = "loop-guard:\n  window: '6'\n";
      expect(_parseLoopGuard(content).window).toBe(6);
    });

    it('strips an inline YAML comment before parsing the integer', () => {
      const content = 'loop-guard:\n  threshold: 7  # detect tight loops\n  window: 9\n';
      const result = _parseLoopGuard(content);
      expect(result.threshold).toBe(7);
      expect(result.window).toBe(9);
    });

    it('handles CRLF line endings', () => {
      const content = 'loop-guard:\r\n  enabled: false\r\n  threshold: 4\r\n  window: 6\r\n';
      expect(_parseLoopGuard(content)).toEqual({ enabled: false, threshold: 4, window: 6 });
    });
  });

  describe('block boundary detection', () => {
    it('stops parsing at the next top-level key', () => {
      const content = [
        'loop-guard:',
        '  threshold: 4',
        'other-section:',
        '  threshold: 99',
        '',
      ].join('\n');
      expect(_parseLoopGuard(content).threshold).toBe(4);
    });
  });

  describe('threshold > window clamp (#628 self-heal)', () => {
    it('widens window up to threshold when threshold > window (5 > 3 → window 5)', () => {
      const content = 'loop-guard:\n  threshold: 5\n  window: 3\n';
      expect(_parseLoopGuard(content)).toEqual({ enabled: true, threshold: 5, window: 5 });
    });

    it('leaves window unchanged when threshold < window (3 < 5 → window 5)', () => {
      const content = 'loop-guard:\n  threshold: 3\n  window: 5\n';
      expect(_parseLoopGuard(content).window).toBe(5);
    });

    it('leaves window unchanged when threshold == window (4 == 4 → window 4)', () => {
      const content = 'loop-guard:\n  threshold: 4\n  window: 4\n';
      expect(_parseLoopGuard(content).window).toBe(4);
    });

    it('clamps the default window up when only a high threshold is set (6 > default 5 → window 6)', () => {
      const content = 'loop-guard:\n  threshold: 6\n';
      expect(_parseLoopGuard(content)).toEqual({ enabled: true, threshold: 6, window: 6 });
    });
  });
});
