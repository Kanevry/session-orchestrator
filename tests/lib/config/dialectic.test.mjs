/**
 * dialectic.test.mjs — Unit tests for scripts/lib/config/dialectic.mjs (#816, W4-review leftover)
 *
 * Covers:
 *   _parseDialectic — tolerant top-level `dialectic:` block parser:
 *     - absent block ⇒ defaults
 *     - full explicit block ⇒ every field parsed
 *     - cadence: 0 kill-switch round-trips as 0 (valid per /^\d+$/ + n >= 0 —
 *       NOT defaulted; this edge case has no eval.mjs analogue since eval has
 *       no integer kill-switch field)
 *     - unknown model ⇒ throw with a speaking message
 *     - budget-tokens garbage/negative ⇒ silently defaults to 8000, no throw
 *     - quoted values stripped (double + single quote forms)
 *     - non-indented follow-up line ends the block scan
 *     - inline comment on the `dialectic:` KEY line itself ⇒ block never
 *       entered, ALL defaults apply silently (pins the parser gotcha
 *       empirically — mirrors the eval.mjs / cold-start.mjs precedent)
 *
 *   parseSessionConfig integration:
 *     - surfaces cfg['dialectic'] end-to-end through the full Session Config
 *       parser, using a hermetic hostPaths ctx (#783 discipline) so the
 *       host's real owner.yaml cannot bleed into committed-value assertions.
 *
 * IN-PROCESS ONLY per PSA-006 / the validate-config-exit-code learning
 * (confidence 0.9): under `enforcement: warn` a CLI exit code is NOT a schema
 * gate, so every assertion below calls `_parseDialectic` / `parseSessionConfig`
 * directly — never a CLI subprocess exit code.
 */

import { describe, it, expect } from 'vitest';
import { _parseDialectic } from '@lib/config/dialectic.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

// Hermetic ctx (issue #783): the default hostPaths tier reads the REAL
// owner.yaml on this host — injecting an empty ctx pins the COMMITTED
// default/fixture values for parseSessionConfig integration assertions.
const hermetic = { hostPaths: { env: {}, ownerConfig: undefined } };

const DEFAULTS = Object.freeze({
  cadence: 5,
  model: 'haiku',
  'budget-tokens': 8000,
});

// ---------------------------------------------------------------------------
// absent block
// ---------------------------------------------------------------------------

describe('_parseDialectic — absent block', () => {
  it('returns the documented defaults when the dialectic: block is completely absent', () => {
    expect(_parseDialectic('')).toEqual(DEFAULTS);
  });

  it('returns the documented defaults when only other blocks are present', () => {
    const content = ['persistence: true', 'vcs: gitlab', ''].join('\n');
    expect(_parseDialectic(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// full explicit block
// ---------------------------------------------------------------------------

describe('_parseDialectic — full explicit block', () => {
  it('parses every field from a complete block', () => {
    const content = [
      'dialectic:',
      '  cadence: 10',
      '  model: sonnet',
      '  budget-tokens: 16000',
      '',
    ].join('\n');
    expect(_parseDialectic(content)).toEqual({
      cadence: 10,
      model: 'sonnet',
      'budget-tokens': 16000,
    });
  });
});

// ---------------------------------------------------------------------------
// cadence: 0 kill-switch — round-trips as 0, not defaulted
// ---------------------------------------------------------------------------

describe('_parseDialectic — cadence: 0 kill-switch', () => {
  it('parses cadence: 0 verbatim rather than falling back to the default of 5', () => {
    const content = ['dialectic:', '  cadence: 0', ''].join('\n');
    expect(_parseDialectic(content).cadence).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// unknown model — fail fast
// ---------------------------------------------------------------------------

describe('_parseDialectic — unknown model fails fast', () => {
  it('throws a speaking error when model is not haiku|sonnet|opus', () => {
    const content = ['dialectic:', '  model: gpt5', ''].join('\n');
    expect(() => _parseDialectic(content)).toThrowError(
      "dialectic.model must be haiku|sonnet|opus, got 'gpt5'"
    );
  });
});

// ---------------------------------------------------------------------------
// budget-tokens — garbage/negative silently defaults, no throw
// ---------------------------------------------------------------------------

describe('_parseDialectic — budget-tokens silently defaults on garbage', () => {
  it.each([
    ['a negative value', '-100'],
    ['non-numeric garbage', 'lots'],
  ])('defaults budget-tokens to 8000 when the value is %s', (_label, value) => {
    const content = ['dialectic:', `  budget-tokens: ${value}`, ''].join('\n');
    expect(() => _parseDialectic(content)).not.toThrow();
    expect(_parseDialectic(content)['budget-tokens']).toBe(8000);
  });
});

// ---------------------------------------------------------------------------
// cadence — invalid shapes (negative, decimal, garbage) silently default
// ---------------------------------------------------------------------------

describe('_parseDialectic — cadence: invalid values silently default (LOW batch)', () => {
  it.each([
    ['a negative value', '-3'],
    ['a decimal value', '2.5'],
    ['non-numeric garbage', 'lots'],
  ])('defaults cadence to 5 when the value is %s', (_label, value) => {
    const content = ['dialectic:', `  cadence: ${value}`, ''].join('\n');
    expect(_parseDialectic(content).cadence).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// model — uppercase is accepted (toLowerCase runs BEFORE the enum check)
// ---------------------------------------------------------------------------

describe('_parseDialectic — model case-insensitivity (LOW batch)', () => {
  it('accepts an uppercase model value and lowercases it to the canonical enum', () => {
    const content = ['dialectic:', '  model: HAIKU', ''].join('\n');
    expect(_parseDialectic(content).model).toBe('haiku');
  });
});

// ---------------------------------------------------------------------------
// model — empty value after quote-strip throws with an empty got-value
// ---------------------------------------------------------------------------

describe('_parseDialectic — empty model value throws (LOW batch)', () => {
  it('throws with an empty-string got value when model is a quoted empty string', () => {
    const content = ['dialectic:', '  model: ""', ''].join('\n');
    expect(() => _parseDialectic(content)).toThrowError(
      "dialectic.model must be haiku|sonnet|opus, got ''"
    );
  });
});

// ---------------------------------------------------------------------------
// budget-tokens: 0 — mirrors the cadence: 0 kill-switch round-trip
// ---------------------------------------------------------------------------

describe('_parseDialectic — budget-tokens: 0 kill-switch (LOW batch)', () => {
  it('parses budget-tokens: 0 verbatim rather than falling back to the default of 8000', () => {
    const content = ['dialectic:', '  budget-tokens: 0', ''].join('\n');
    expect(_parseDialectic(content)['budget-tokens']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatting tolerance — quoted values stripped
// ---------------------------------------------------------------------------

describe('_parseDialectic — quoted value tolerance', () => {
  it('strips a double-quoted model value and parses the underlying enum', () => {
    const content = ['dialectic:', '  model: "opus"', ''].join('\n');
    expect(_parseDialectic(content).model).toBe('opus');
  });

  it('strips a single-quoted numeric cadence value and parses it as an integer', () => {
    const content = ['dialectic:', "  cadence: '10'", ''].join('\n');
    expect(_parseDialectic(content).cadence).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// formatting tolerance — non-indented follow-up line ends the block
// ---------------------------------------------------------------------------

describe('_parseDialectic — formatting tolerance', () => {
  it('stops scanning at the next top-level (non-indented) key', () => {
    const content = ['dialectic:', '  cadence: 3', 'persistence: true', ''].join('\n');
    expect(_parseDialectic(content)).toEqual({ ...DEFAULTS, cadence: 3 });
  });
});

// ---------------------------------------------------------------------------
// PARSER GOTCHA — inline comment on the `dialectic:` KEY line itself
// ---------------------------------------------------------------------------

describe('_parseDialectic — inline comment on the dialectic: key line disables the whole block', () => {
  it('never enters the block when dialectic: carries a trailing comment — defaults apply silently', () => {
    const content = [
      'dialectic:  # auto-run cadence for the Dialectic-Deriver',
      '  cadence: 10',
      '  model: sonnet',
      '  budget-tokens: 16000',
      '',
    ].join('\n');
    // The strict /^dialectic:\s*$/ regex does not match "dialectic:  # ...",
    // so inBlock never flips true and every sub-key line below is skipped
    // wholesale.
    expect(_parseDialectic(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// parseSessionConfig integration
// ---------------------------------------------------------------------------

describe('parseSessionConfig integration', () => {
  it('surfaces cfg["dialectic"] with explicit overrides from the full document', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
      'dialectic:',
      '  cadence: 3',
      '  model: opus',
      '  budget-tokens: 20000',
      '',
    ].join('\n');
    const config = parseSessionConfig(content, hermetic);
    expect(config['dialectic']).toEqual({
      cadence: 3,
      model: 'opus',
      'budget-tokens': 20000,
    });
  });

  it('defaults cfg["dialectic"] when the block is absent from the document', () => {
    const content = ['# Project', '', '## Session Config', '', 'persistence: true', ''].join(
      '\n'
    );
    const config = parseSessionConfig(content, hermetic);
    expect(config['dialectic']).toEqual(DEFAULTS);
  });
});
