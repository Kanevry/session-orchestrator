/**
 * drift-check.test.mjs — Unit tests for scripts/lib/config/drift-check.mjs
 *
 * Tolerant parser: no throws — all cases either return defaults or parsed values.
 * Covers: empty input, missing block, full block, invalid mode, CRLF, inline comments,
 * include-paths list parsing, per-check flag toggling.
 */

import { describe, it, expect } from 'vitest';
import { _parseDriftCheck } from '../../../scripts/lib/config/drift-check.mjs';

const DEFAULTS = {
  enabled: false,
  mode: 'warn',
  'include-paths': ['CLAUDE.md', 'AGENTS.md', '_meta/**/*.md'],
  'check-path-resolver': true,
  'check-project-count-sync': true,
  'check-issue-reference-freshness': true,
  'check-session-file-existence': true,
};

describe('_parseDriftCheck', () => {
  describe('empty and missing block', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseDriftCheck('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when drift-check block is absent', () => {
      expect(_parseDriftCheck('some: other\ncontent: here\n')).toEqual(DEFAULTS);
    });

    it('returns all defaults when drift-check block is present but empty', () => {
      const content = 'drift-check:\n\nnext-section:\n';
      expect(_parseDriftCheck(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('parses enabled: true', () => {
      const content = 'drift-check:\n  enabled: true\n';
      expect(_parseDriftCheck(content).enabled).toBe(true);
    });

    it('parses enabled: false', () => {
      const content = 'drift-check:\n  enabled: false\n';
      expect(_parseDriftCheck(content).enabled).toBe(false);
    });

    it('defaults enabled to false when not specified', () => {
      const content = 'drift-check:\n  mode: strict\n';
      expect(_parseDriftCheck(content).enabled).toBe(false);
    });
  });

  describe('mode', () => {
    it('parses mode: strict', () => {
      const content = 'drift-check:\n  enabled: true\n  mode: strict\n';
      expect(_parseDriftCheck(content).mode).toBe('strict');
    });

    it('parses mode: off', () => {
      const content = 'drift-check:\n  mode: off\n';
      expect(_parseDriftCheck(content).mode).toBe('off');
    });

    it('silently defaults to "warn" on invalid mode', () => {
      const content = 'drift-check:\n  mode: invalid-mode\n';
      expect(_parseDriftCheck(content).mode).toBe('warn');
    });
  });

  describe('include-paths list', () => {
    it('uses default include-paths when not specified', () => {
      const content = 'drift-check:\n  enabled: true\n';
      expect(_parseDriftCheck(content)['include-paths']).toEqual([
        'CLAUDE.md',
        'AGENTS.md',
        '_meta/**/*.md',
      ]);
    });

    it('parses include-paths list items', () => {
      const content =
        'drift-check:\n  include-paths:\n    - CLAUDE.md\n    - README.md\n';
      expect(_parseDriftCheck(content)['include-paths']).toEqual(['CLAUDE.md', 'README.md']);
    });

    it('strips surrounding double quotes from list items', () => {
      const content = 'drift-check:\n  include-paths:\n    - "CLAUDE.md"\n';
      expect(_parseDriftCheck(content)['include-paths']).toEqual(['CLAUDE.md']);
    });

    it('strips surrounding single quotes from list items', () => {
      const content = "drift-check:\n  include-paths:\n    - 'AGENTS.md'\n";
      expect(_parseDriftCheck(content)['include-paths']).toEqual(['AGENTS.md']);
    });
  });

  describe('per-check flags', () => {
    it('parses check-path-resolver: false', () => {
      const content = 'drift-check:\n  check-path-resolver: false\n';
      expect(_parseDriftCheck(content)['check-path-resolver']).toBe(false);
    });

    it('parses check-project-count-sync: false', () => {
      const content = 'drift-check:\n  check-project-count-sync: false\n';
      expect(_parseDriftCheck(content)['check-project-count-sync']).toBe(false);
    });

    it('parses check-issue-reference-freshness: false', () => {
      const content = 'drift-check:\n  check-issue-reference-freshness: false\n';
      expect(_parseDriftCheck(content)['check-issue-reference-freshness']).toBe(false);
    });

    it('parses check-session-file-existence: false', () => {
      const content = 'drift-check:\n  check-session-file-existence: false\n';
      expect(_parseDriftCheck(content)['check-session-file-existence']).toBe(false);
    });

    it('per-check flags default to true when block is present but flags absent', () => {
      const content = 'drift-check:\n  enabled: true\n';
      const result = _parseDriftCheck(content);
      expect(result['check-path-resolver']).toBe(true);
      expect(result['check-project-count-sync']).toBe(true);
      expect(result['check-issue-reference-freshness']).toBe(true);
      expect(result['check-session-file-existence']).toBe(true);
    });
  });

  describe('CRLF tolerance and inline comments', () => {
    it('handles CRLF line endings', () => {
      const content = 'drift-check:\r\n  enabled: true\r\n  mode: strict\r\n';
      const result = _parseDriftCheck(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('strict');
    });

    it('strips inline YAML comments', () => {
      const content = 'drift-check:\n  enabled: true  # opt-in\n  mode: warn  # default\n';
      const result = _parseDriftCheck(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('warn');
    });
  });

  describe('block boundary', () => {
    it('stops parsing at next top-level key', () => {
      const content =
        'drift-check:\n  enabled: true\nother-section:\n  enabled: false\n';
      const result = _parseDriftCheck(content);
      expect(result.enabled).toBe(true);
    });
  });
});
