/**
 * discovery-validator.test.mjs — Unit tests for
 * scripts/lib/config/discovery-validator.mjs (PSA-006 / issue #567).
 *
 * Tolerant parser for the top-level `discovery-validator:` YAML block.
 * Default ON (enabled: true). Only literal `true` (case-insensitive, after quote
 * unwrap and inline-comment strip) keeps `enabled` true; any other explicit value → false.
 *
 * Covers TASK A (#581 Item 1, 16 unit cases) + TASK B (#581 Item 2,
 * 2 integration cases through parseSessionConfig).
 *
 * Mirrors the style of tests/lib/config/auto-dream.test.mjs and the inline-
 * string fixture pattern from tests/unit/slopcheck.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import { _parseDiscoveryValidator } from '@lib/config/discovery-validator.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

const DEFAULTS = { enabled: true };

// ---------------------------------------------------------------------------
// TASK A — _parseDiscoveryValidator unit tests
// ---------------------------------------------------------------------------

describe('_parseDiscoveryValidator — defaults', () => {
  it('returns { enabled: true } when the discovery-validator block is absent', () => {
    const content = [
      'persistence: true',
      'enforcement: warn',
      'agents-per-wave: 6',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual(DEFAULTS);
  });

  it('returns { enabled: true } for empty content', () => {
    expect(_parseDiscoveryValidator('')).toEqual(DEFAULTS);
  });
});

describe('_parseDiscoveryValidator — enabled coercion', () => {
  it('returns enabled:true on explicit "enabled: true"', () => {
    const content = [
      'discovery-validator:',
      '  enabled: true',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });

  it('returns enabled:false on "enabled: false"', () => {
    const content = [
      'discovery-validator:',
      '  enabled: false',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: false });
  });

  it('coerces "enabled: maybe" to false (tolerant fallback)', () => {
    const content = [
      'discovery-validator:',
      '  enabled: maybe',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: false });
  });

  it('coerces "enabled: yes" to false (only literal true flips)', () => {
    const content = [
      'discovery-validator:',
      '  enabled: yes',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: false });
  });

  it('is case-insensitive: "enabled: TRUE" → true', () => {
    const content = [
      'discovery-validator:',
      '  enabled: TRUE',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });
});

describe('_parseDiscoveryValidator — quoted-value unwrap', () => {
  it('unwraps double-quoted "true" → enabled:true', () => {
    const content = [
      'discovery-validator:',
      '  enabled: "true"',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });

  it("unwraps single-quoted 'true' → enabled:true", () => {
    const content = [
      'discovery-validator:',
      "  enabled: 'true'",
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });
});

describe('_parseDiscoveryValidator — comment + whitespace handling', () => {
  it('strips an inline # comment after the value', () => {
    const content = [
      'discovery-validator:',
      '  enabled: true   # PSA-006 mechanical enforcement',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });

  it('tolerates trailing whitespace after the value', () => {
    const content = [
      'discovery-validator:',
      '  enabled: true   ',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });
});

describe('_parseDiscoveryValidator — block-boundary detection', () => {
  it('ends the block at a sibling non-indented key', () => {
    // The block ends BEFORE the next top-level key, so the `enabled: true`
    // inside the discovery-validator block is parsed normally.
    const content = [
      'discovery-validator:',
      '  enabled: true',
      'persistence: true',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });

  it('ignores an enabled: line that appears AFTER a sibling top-level key (outside the block)', () => {
    // After `persistence:` the parser is no longer inside the discovery-validator
    // block, so the bare top-level `enabled: true` (no parent) must NOT flip the flag.
    // The block is empty → defaults returned ({ enabled: true }).
    const content = [
      'discovery-validator:',
      'persistence: true',
      'enabled: true',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });

  it('tolerates blank lines inside the block', () => {
    const content = [
      'discovery-validator:',
      '',
      '  enabled: true',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });
});

describe('_parseDiscoveryValidator — malformed / unknown', () => {
  it('ignores unknown keys inside the block (e.g. mode: hard)', () => {
    const content = [
      'discovery-validator:',
      '  mode: hard',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: false });
  });

  it('ignores a non-indented "discovery-validator:" with trailing junk on the same line', () => {
    // The block-open regex requires `discovery-validator:` followed only by
    // optional whitespace. Anything after the colon → not recognised as a block
    // open → defaults returned (enabled: true).
    const content = [
      'discovery-validator: junk',
      '  enabled: true',
      '',
    ].join('\n');
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });
});

describe('_parseDiscoveryValidator — CRLF tolerance', () => {
  it('handles CRLF line endings', () => {
    const content = 'discovery-validator:\r\n  enabled: true\r\n';
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });
});

describe('_parseDiscoveryValidator — tab-indented child line', () => {
  it('parses tab-indented "enabled: true" as true (^\\ s+ regex accepts tabs)', () => {
    // The block-key regex (/^\s+([a-zA-Z_-]+):\s*(.*)/) uses \s+ which matches
    // a TAB character. This test pins that behaviour so a future tightening to
    // /^ +/ (spaces-only) would break loudly.
    const content = 'discovery-validator:\n\tenabled: true\n';
    expect(_parseDiscoveryValidator(content)).toEqual({ enabled: true });
  });
});

// ---------------------------------------------------------------------------
// TASK B — parseSessionConfig integration
// ---------------------------------------------------------------------------

describe('parseSessionConfig integration', () => {
  it('parseSessionConfig returns discovery-validator: { enabled: true } when the block enables it', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      'discovery-validator:',
      '  enabled: true',
      '',
    ].join('\n');
    const result = parseSessionConfig(content);
    expect(result['discovery-validator']).toEqual({ enabled: true });
  });

  it('parseSessionConfig returns discovery-validator: { enabled: true } when the block is absent', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
    ].join('\n');
    const result = parseSessionConfig(content);
    expect(result['discovery-validator']).toEqual({ enabled: true });
  });
});
