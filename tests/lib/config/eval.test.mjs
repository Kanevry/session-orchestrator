/**
 * eval.test.mjs — Unit tests for scripts/lib/config/eval.mjs (#809, Epic #803)
 *
 * Covers:
 *   _parseEval — tolerant top-level `eval:` block parser:
 *     - absent block ⇒ defaults
 *     - full explicit block ⇒ every field parsed
 *     - each enum violation (mode/judge/report) ⇒ throw with a speaking message
 *     - enabled parsing: true/false/garbage
 *     - handle: set / empty / absent
 *     - inline comment on a SUB-key line ⇒ stripped, value still parses
 *     - inline comment on the `eval:` KEY line itself ⇒ block never entered,
 *       ALL defaults apply silently (pins the parser gotcha empirically —
 *       PSA-006-adjacent: this is the regression the gotcha note warns about)
 *     - non-indented follow-up line ends the block scan
 *
 *   parseSessionConfig integration:
 *     - surfaces cfg['eval'] end-to-end through the full Session Config parser,
 *       using a hermetic hostPaths ctx (#783 discipline) so the host's real
 *       owner.yaml cannot bleed into committed-value assertions.
 *
 * IN-PROCESS ONLY per PSA-006 / the validate-config-exit-code learning
 * (confidence 0.9): under `enforcement: warn` a CLI exit code is NOT a schema
 * gate, so every assertion below calls `_parseEval` / `parseSessionConfig`
 * directly — never a CLI subprocess exit code.
 */

import { describe, it, expect } from 'vitest';
import { _parseEval } from '@lib/config/eval.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

// Hermetic ctx (issue #783): the default hostPaths tier reads the REAL
// owner.yaml on this host — injecting an empty ctx pins the COMMITTED
// default/fixture values for parseSessionConfig integration assertions.
const hermetic = { hostPaths: { env: {}, ownerConfig: undefined } };

const DEFAULTS = Object.freeze({
  enabled: false,
  mode: 'warn',
  judge: 'off',
  report: 'html',
  handle: null,
});

// ---------------------------------------------------------------------------
// absent block
// ---------------------------------------------------------------------------

describe('_parseEval — absent block', () => {
  it('returns the documented defaults when the eval: block is completely absent', () => {
    expect(_parseEval('')).toEqual(DEFAULTS);
  });

  it('returns the documented defaults when only other blocks are present', () => {
    const content = ['persistence: true', 'vcs: gitlab', ''].join('\n');
    expect(_parseEval(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// full explicit block
// ---------------------------------------------------------------------------

describe('_parseEval — full explicit block', () => {
  it('parses every field from a complete block', () => {
    const content = [
      'eval:',
      '  enabled: true',
      '  mode: off',
      '  judge: haiku',
      '  report: none',
      '  handle: my-eval-handle',
      '',
    ].join('\n');
    expect(_parseEval(content)).toEqual({
      enabled: true,
      mode: 'off',
      judge: 'haiku',
      report: 'none',
      handle: 'my-eval-handle',
    });
  });
});

// ---------------------------------------------------------------------------
// enum violations — one throw per enum field
// ---------------------------------------------------------------------------

describe('_parseEval — enum violations fail fast', () => {
  it('throws a speaking error when mode is not warn|off', () => {
    const content = ['eval:', '  mode: strict', ''].join('\n');
    expect(() => _parseEval(content)).toThrowError("eval.mode must be warn|off, got 'strict'");
  });

  it('throws a speaking error when judge is not off|haiku|sonnet', () => {
    const content = ['eval:', '  judge: opus', ''].join('\n');
    expect(() => _parseEval(content)).toThrowError(
      "eval.judge must be off|haiku|sonnet, got 'opus'"
    );
  });

  it('throws a speaking error when report is not html|none', () => {
    const content = ['eval:', '  report: pdf', ''].join('\n');
    expect(() => _parseEval(content)).toThrowError("eval.report must be html|none, got 'pdf'");
  });
});

// ---------------------------------------------------------------------------
// enabled parsing — true / false / garbage
// ---------------------------------------------------------------------------

describe('_parseEval — enabled parsing', () => {
  it('parses enabled: true', () => {
    const content = ['eval:', '  enabled: true', ''].join('\n');
    expect(_parseEval(content).enabled).toBe(true);
  });

  it('parses enabled: false explicitly', () => {
    const content = ['eval:', '  enabled: false', ''].join('\n');
    expect(_parseEval(content).enabled).toBe(false);
  });

  it('silently defaults enabled to false on a garbage value — no throw', () => {
    const content = ['eval:', '  enabled: sure-why-not', ''].join('\n');
    expect(() => _parseEval(content)).not.toThrow();
    expect(_parseEval(content).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handle — set / empty / absent
// ---------------------------------------------------------------------------

describe('_parseEval — handle', () => {
  it('parses a set handle string', () => {
    const content = ['eval:', '  handle: aiat-llm-eval', ''].join('\n');
    expect(_parseEval(content).handle).toBe('aiat-llm-eval');
  });

  it('collapses an empty handle value to null', () => {
    const content = ['eval:', '  handle: ', ''].join('\n');
    expect(_parseEval(content).handle).toBeNull();
  });

  it('defaults handle to null when the key is absent from the block', () => {
    const content = ['eval:', '  enabled: true', ''].join('\n');
    expect(_parseEval(content).handle).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatting tolerance — sub-key inline comments stripped
// ---------------------------------------------------------------------------

describe('_parseEval — sub-key inline comment tolerance', () => {
  it('strips an inline comment on a sub-key line and still parses the value', () => {
    const content = ['eval:', '  mode: off       # opt-out of the harness entirely', ''].join(
      '\n'
    );
    expect(_parseEval(content).mode).toBe('off');
  });

  it('strips an inline comment on the enabled: sub-key line', () => {
    const content = ['eval:', '  enabled: true    # opt-in', ''].join('\n');
    expect(_parseEval(content).enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PARSER GOTCHA — inline comment on the `eval:` KEY line itself
// ---------------------------------------------------------------------------

describe('_parseEval — inline comment on the eval: key line disables the whole block', () => {
  it('never enters the block when eval: carries a trailing comment — defaults apply silently', () => {
    const content = [
      'eval:  # opt-in Standard v1 harness',
      '  enabled: true',
      '  mode: off',
      '  judge: haiku',
      '  report: none',
      '  handle: should-be-ignored',
      '',
    ].join('\n');
    // The strict /^eval:\s*$/ regex does not match "eval:  # ...", so inBlock
    // never flips true and every sub-key line below is skipped wholesale.
    expect(_parseEval(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// formatting tolerance — non-indented follow-up line ends the block
// ---------------------------------------------------------------------------

describe('_parseEval — formatting tolerance', () => {
  it('stops scanning at the next top-level (non-indented) key', () => {
    const content = ['eval:', '  enabled: true', 'persistence: true', ''].join('\n');
    expect(_parseEval(content)).toEqual({ ...DEFAULTS, enabled: true });
  });
});

// ---------------------------------------------------------------------------
// parseSessionConfig integration
// ---------------------------------------------------------------------------

describe('parseSessionConfig integration', () => {
  it('surfaces cfg["eval"] with explicit overrides from the full document', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
      'eval:',
      '  enabled: true',
      '  mode: off',
      '  judge: sonnet',
      '  report: none',
      '  handle: acme-eval',
      '',
    ].join('\n');
    const config = parseSessionConfig(content, hermetic);
    expect(config['eval']).toEqual({
      enabled: true,
      mode: 'off',
      judge: 'sonnet',
      report: 'none',
      handle: 'acme-eval',
    });
  });

  it('defaults cfg["eval"] when the block is absent from the document', () => {
    const content = ['# Project', '', '## Session Config', '', 'persistence: true', ''].join(
      '\n'
    );
    const config = parseSessionConfig(content, hermetic);
    expect(config['eval']).toEqual(DEFAULTS);
  });
});
