/**
 * docs-orchestrator.test.mjs — Unit tests for scripts/lib/config/docs-orchestrator.mjs
 *
 * Tolerant parser: no throws. Covers defaults, enabled flag, mode, audiences
 * (block list and inline list), invalid audiences silently dropped,
 * CRLF, inline comments, block boundary.
 */

import { describe, it, expect } from 'vitest';
import { _parseDocsOrchestrator } from '@lib/config/docs-orchestrator.mjs';

const DEFAULTS = {
  enabled: false,
  audiences: ['user', 'dev', 'vault'],
  mode: 'warn',
};

describe('_parseDocsOrchestrator', () => {
  describe('empty and missing block', () => {
    it('returns all defaults on empty string', () => {
      expect(_parseDocsOrchestrator('')).toEqual(DEFAULTS);
    });

    it('returns all defaults when docs-orchestrator block is absent', () => {
      expect(_parseDocsOrchestrator('persistence: true\n')).toEqual(DEFAULTS);
    });

    it('returns all defaults when block is present but empty', () => {
      const content = 'docs-orchestrator:\n\nnext-section:\n';
      expect(_parseDocsOrchestrator(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('parses enabled: true', () => {
      const content = 'docs-orchestrator:\n  enabled: true\n';
      expect(_parseDocsOrchestrator(content).enabled).toBe(true);
    });

    it('parses enabled: false', () => {
      const content = 'docs-orchestrator:\n  enabled: false\n';
      expect(_parseDocsOrchestrator(content).enabled).toBe(false);
    });

    it('defaults to false when enabled is absent from block', () => {
      const content = 'docs-orchestrator:\n  mode: strict\n';
      expect(_parseDocsOrchestrator(content).enabled).toBe(false);
    });
  });

  describe('mode', () => {
    it('parses mode: strict', () => {
      const content = 'docs-orchestrator:\n  mode: strict\n';
      expect(_parseDocsOrchestrator(content).mode).toBe('strict');
    });

    it('parses mode: off', () => {
      const content = 'docs-orchestrator:\n  mode: off\n';
      expect(_parseDocsOrchestrator(content).mode).toBe('off');
    });

    it('silently defaults to "warn" on invalid mode', () => {
      const content = 'docs-orchestrator:\n  mode: garbage\n';
      expect(_parseDocsOrchestrator(content).mode).toBe('warn');
    });
  });

  describe('audiences — block list', () => {
    it('parses all three valid audiences as block list', () => {
      const content =
        'docs-orchestrator:\n  audiences:\n    - user\n    - dev\n    - vault\n';
      expect(_parseDocsOrchestrator(content).audiences).toEqual(['user', 'dev', 'vault']);
    });

    it('parses a subset of audiences', () => {
      const content = 'docs-orchestrator:\n  audiences:\n    - user\n    - dev\n';
      expect(_parseDocsOrchestrator(content).audiences).toEqual(['user', 'dev']);
    });

    it('silently drops invalid audience values from block list', () => {
      const content =
        'docs-orchestrator:\n  audiences:\n    - user\n    - invalid-audience\n    - vault\n';
      expect(_parseDocsOrchestrator(content).audiences).toEqual(['user', 'vault']);
    });

    it('strips surrounding double quotes from audience list items', () => {
      const content = 'docs-orchestrator:\n  audiences:\n    - "user"\n    - "dev"\n';
      expect(_parseDocsOrchestrator(content).audiences).toEqual(['user', 'dev']);
    });
  });

  describe('audiences — inline list', () => {
    it('parses inline audiences: [user, dev, vault]', () => {
      const content = 'docs-orchestrator:\n  audiences: [user, dev, vault]\n';
      expect(_parseDocsOrchestrator(content).audiences).toEqual(['user', 'dev', 'vault']);
    });

    it('silently drops invalid values from inline list', () => {
      const content = 'docs-orchestrator:\n  audiences: [user, bad, vault]\n';
      expect(_parseDocsOrchestrator(content).audiences).toEqual(['user', 'vault']);
    });
  });

  describe('fallback to default audiences', () => {
    it('returns default audiences when block is present but audiences absent', () => {
      const content = 'docs-orchestrator:\n  enabled: true\n';
      expect(_parseDocsOrchestrator(content).audiences).toEqual(['user', 'dev', 'vault']);
    });
  });

  describe('CRLF tolerance and inline comments', () => {
    it('handles CRLF line endings', () => {
      const content = 'docs-orchestrator:\r\n  enabled: true\r\n  mode: strict\r\n';
      const result = _parseDocsOrchestrator(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('strict');
    });

    it('strips inline YAML comments', () => {
      const content =
        'docs-orchestrator:\n  enabled: true  # opt-in\n  mode: warn  # default\n';
      const result = _parseDocsOrchestrator(content);
      expect(result.enabled).toBe(true);
      expect(result.mode).toBe('warn');
    });
  });

  describe('block boundary', () => {
    it('stops parsing at next top-level key', () => {
      const content =
        'docs-orchestrator:\n  enabled: true\nother-section:\n  enabled: false\n';
      expect(_parseDocsOrchestrator(content).enabled).toBe(true);
    });
  });
});
