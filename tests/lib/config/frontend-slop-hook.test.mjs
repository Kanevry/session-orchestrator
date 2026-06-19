/**
 * frontend-slop-hook.test.mjs — Unit tests for
 * scripts/lib/config/frontend-slop-hook.mjs
 *
 * Tolerant parser for the top-level `frontend-slop-hook:` YAML block (#684).
 * Drives the OPT-IN PostToolUse frontend-slop detector hook. Returns
 * `{ enabled }` with DEFAULT FALSE (opt-in) — the inverse of loop-guard's
 * default-on posture. Only an explicit `enabled: true` flips it on.
 *
 * Covers: default off, explicit true/false, garbage value, block-boundary
 * detection, indented look-alike rejection, quoted values + inline-comment
 * stripping, CRLF.
 *
 * Mirrors the style of tests/lib/config/loop-guard.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseFrontendSlopHook } from '@lib/config/frontend-slop-hook.mjs';

const DEFAULTS = { enabled: false };

describe('_parseFrontendSlopHook', () => {
  describe('defaults (block absent or empty) — OPT-IN means default off', () => {
    it('returns disabled on empty string', () => {
      expect(_parseFrontendSlopHook('')).toEqual(DEFAULTS);
    });

    it('returns disabled when the block is absent', () => {
      const content = 'persistence: true\nenforcement: warn\n';
      expect(_parseFrontendSlopHook(content)).toEqual(DEFAULTS);
    });

    it('returns disabled when the block is present but empty', () => {
      const content = 'frontend-slop-hook:\n\nnext-section:\n';
      expect(_parseFrontendSlopHook(content)).toEqual(DEFAULTS);
    });

    it('ignores an indented look-alike token (not a column-0 block start)', () => {
      const content = 'parent:\n  frontend-slop-hook:\n    enabled: true\n';
      expect(_parseFrontendSlopHook(content)).toEqual(DEFAULTS);
    });
  });

  describe('enabled flag', () => {
    it('flips enabled to true on explicit "true"', () => {
      const content = 'frontend-slop-hook:\n  enabled: true\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });

    it('keeps enabled false on explicit "false"', () => {
      const content = 'frontend-slop-hook:\n  enabled: false\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(false);
    });

    it('treats a garbage enabled value as disabled (only "true" enables)', () => {
      const content = 'frontend-slop-hook:\n  enabled: maybe\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(false);
    });

    it('keeps default enabled=false when the key is absent from a non-empty block', () => {
      const content = 'frontend-slop-hook:\n  other: 4\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(false);
    });
  });

  describe('quoted values + inline comment stripping', () => {
    it('strips surrounding double quotes from the value', () => {
      const content = 'frontend-slop-hook:\n  enabled: "true"\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });

    it('strips surrounding single quotes from the value', () => {
      const content = "frontend-slop-hook:\n  enabled: 'true'\n";
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });

    it('strips an inline YAML comment before parsing the flag', () => {
      const content = 'frontend-slop-hook:\n  enabled: true  # opt-in detector\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });

    it('handles CRLF line endings', () => {
      const content = 'frontend-slop-hook:\r\n  enabled: true\r\n';
      expect(_parseFrontendSlopHook(content)).toEqual({ enabled: true });
    });
  });

  describe('block boundary detection', () => {
    it('stops parsing at the next top-level key', () => {
      const content = [
        'frontend-slop-hook:',
        '  enabled: true',
        'other-section:',
        '  enabled: false',
        '',
      ].join('\n');
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });
  });

  describe('robustness edge cases', () => {
    it('honors the last enabled line when the key is repeated (false then true)', () => {
      const content = 'frontend-slop-hook:\n  enabled: false\n  enabled: true\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });

    it('honors the last enabled line when the key is repeated (true then false)', () => {
      const content = 'frontend-slop-hook:\n  enabled: true\n  enabled: false\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(false);
    });

    it('parses a deeply-indented (4-space) enabled value', () => {
      // The kv regex anchors on "one-or-more leading spaces" — any indent depth
      // under the column-0 block start is accepted.
      const content = 'frontend-slop-hook:\n    enabled: true\n';
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });

    it('a leading BOM on the block-start line defeats the match → stays disabled', () => {
      // The block-start regex is /^frontend-slop-hook:\s*$/. A U+FEFF byte glued
      // to the start of that line means it never matches → defaults (off). This
      // pins the (intentional) limitation rather than asserting BOM-stripping.
      const BOM = String.fromCharCode(0xfeff);
      const content = `${BOM}frontend-slop-hook:\n  enabled: true\n`;
      expect(_parseFrontendSlopHook(content).enabled).toBe(false);
    });

    it('a BOM on an EARLIER line does not affect a later block-start line', () => {
      const BOM = String.fromCharCode(0xfeff);
      const content = `${BOM}# Sandbox\n\nfrontend-slop-hook:\n  enabled: true\n`;
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });

    it('parses a block wrapped in a fenced code block — the parser is fence-unaware (documented limitation)', () => {
      // The parser does not understand markdown fences; a ```-wrapped block is
      // still parsed. Pinning this contract guards against a silent behavior
      // change if fence-awareness is ever added without updating callers.
      const fence = '```';
      const content = `${fence}\nfrontend-slop-hook:\n  enabled: true\n${fence}\n`;
      expect(_parseFrontendSlopHook(content).enabled).toBe(true);
    });
  });
});
