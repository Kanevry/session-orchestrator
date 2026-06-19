/**
 * dispatcher-autonomy.test.mjs — Unit tests for
 * scripts/lib/config/dispatcher-autonomy.mjs (Epic #673, issue #679).
 *
 * Mirrors the style of tests/lib/config/skill-evolution.test.mjs (parser) and
 * tests/lib/config/host-paths.test.mjs (precedence resolver).
 *
 * Covers:
 *  - _parseDispatcherAutonomy: fail-closed defaults, full valid block, every
 *    enum value, invalid enum → 'off', case-insensitivity, confidence-floor
 *    validation + boundaries, inline-comment stripping, quoted values,
 *    indent-break block termination, garbage-input safety.
 *  - resolveDispatcherAutonomy: env > ownerConfig > committed > 'off'
 *    precedence, per-tier enum validation + fall-through, owner-config safety,
 *    fail-closed floor. Every test passes an explicit `env` object so no test
 *    reads or mutates process.env.
 */

import { describe, it, expect } from 'vitest';

import {
  _parseDispatcherAutonomy,
  resolveDispatcherAutonomy,
} from '../../../scripts/lib/config/dispatcher-autonomy.mjs';

const DEFAULTS = {
  autonomy: 'off',
  'confidence-floor': 0.5,
};

// ---------------------------------------------------------------------------
// Unit: _parseDispatcherAutonomy — defaults (block absent or empty)
// ---------------------------------------------------------------------------

describe('_parseDispatcherAutonomy — defaults (block absent or empty)', () => {
  it('returns fail-closed defaults on empty string', () => {
    expect(_parseDispatcherAutonomy('')).toEqual(DEFAULTS);
  });

  it('returns defaults when the dispatcher-autonomy block is absent', () => {
    const content = 'persistence: true\nenforcement: warn\nwaves: 5\n';
    expect(_parseDispatcherAutonomy(content)).toEqual(DEFAULTS);
  });

  it('returns defaults when block header exists but has no key-value lines', () => {
    const content = 'dispatcher-autonomy:\n\n\nnext-section:\n';
    expect(_parseDispatcherAutonomy(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Unit: _parseDispatcherAutonomy — valid full block + enum values
// ---------------------------------------------------------------------------

describe('_parseDispatcherAutonomy — valid full block', () => {
  it('parses both keys from a fully specified block', () => {
    const content = [
      'dispatcher-autonomy:',
      '  autonomy: autonomous-gated',
      '  confidence-floor: 0.7',
      '',
    ].join('\n');
    expect(_parseDispatcherAutonomy(content)).toEqual({
      autonomy: 'autonomous-gated',
      'confidence-floor': 0.7,
    });
  });

  it('parses autonomy: off', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: off\n';
    expect(_parseDispatcherAutonomy(content)).toEqual({
      autonomy: 'off',
      'confidence-floor': 0.5,
    });
  });

  it('parses autonomy: advisory', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: advisory\n';
    expect(_parseDispatcherAutonomy(content)).toEqual({
      autonomy: 'advisory',
      'confidence-floor': 0.5,
    });
  });

  it('parses autonomy: autonomous-gated', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: autonomous-gated\n';
    expect(_parseDispatcherAutonomy(content)).toEqual({
      autonomy: 'autonomous-gated',
      'confidence-floor': 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
// Unit: _parseDispatcherAutonomy — invalid / case / fail-closed
// ---------------------------------------------------------------------------

describe('_parseDispatcherAutonomy — autonomy validation', () => {
  it('falls back to off on an unknown enum value', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: banana\n';
    expect(_parseDispatcherAutonomy(content).autonomy).toBe('off');
  });

  it('lowercases an uppercase enum value (ADVISORY → advisory)', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: ADVISORY\n';
    expect(_parseDispatcherAutonomy(content).autonomy).toBe('advisory');
  });

  it('lowercases a mixed-case enum value (Autonomous-Gated → autonomous-gated)', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: Autonomous-Gated\n';
    expect(_parseDispatcherAutonomy(content).autonomy).toBe('autonomous-gated');
  });
});

// ---------------------------------------------------------------------------
// Unit: _parseDispatcherAutonomy — confidence-floor validation + boundaries
// ---------------------------------------------------------------------------

describe('_parseDispatcherAutonomy — confidence-floor validation', () => {
  it('falls back to 0.5 on an out-of-range integer (9)', () => {
    const content = 'dispatcher-autonomy:\n  confidence-floor: 9\n';
    expect(_parseDispatcherAutonomy(content)['confidence-floor']).toBe(0.5);
  });

  it('falls back to 0.5 on a negative value (-1)', () => {
    const content = 'dispatcher-autonomy:\n  confidence-floor: -1\n';
    expect(_parseDispatcherAutonomy(content)['confidence-floor']).toBe(0.5);
  });

  it('falls back to 0.5 on a non-numeric value (abc)', () => {
    const content = 'dispatcher-autonomy:\n  confidence-floor: abc\n';
    expect(_parseDispatcherAutonomy(content)['confidence-floor']).toBe(0.5);
  });

  it('accepts the lower boundary 0.0', () => {
    const content = 'dispatcher-autonomy:\n  confidence-floor: 0.0\n';
    expect(_parseDispatcherAutonomy(content)['confidence-floor']).toBe(0.0);
  });

  it('accepts the upper boundary 1.0', () => {
    const content = 'dispatcher-autonomy:\n  confidence-floor: 1.0\n';
    expect(_parseDispatcherAutonomy(content)['confidence-floor']).toBe(1.0);
  });

  it('accepts an in-range fractional value (0.3)', () => {
    const content = 'dispatcher-autonomy:\n  confidence-floor: 0.3\n';
    expect(_parseDispatcherAutonomy(content)['confidence-floor']).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Unit: _parseDispatcherAutonomy — formatting tolerance
// ---------------------------------------------------------------------------

describe('_parseDispatcherAutonomy — formatting tolerance', () => {
  it('strips an inline comment after the value', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: advisory   # note\n';
    expect(_parseDispatcherAutonomy(content).autonomy).toBe('advisory');
  });

  it('strips surrounding double quotes from the value', () => {
    const content = 'dispatcher-autonomy:\n  autonomy: "advisory"\n';
    expect(_parseDispatcherAutonomy(content).autonomy).toBe('advisory');
  });

  it('strips surrounding single quotes from the value', () => {
    const content = "dispatcher-autonomy:\n  autonomy: 'autonomous-gated'\n";
    expect(_parseDispatcherAutonomy(content).autonomy).toBe('autonomous-gated');
  });

  it('tolerates CRLF line endings', () => {
    const content = 'dispatcher-autonomy:\r\n  autonomy: advisory\r\n  confidence-floor: 0.8\r\n';
    expect(_parseDispatcherAutonomy(content)).toEqual({
      autonomy: 'advisory',
      'confidence-floor': 0.8,
    });
  });
});

// ---------------------------------------------------------------------------
// Unit: _parseDispatcherAutonomy — block-boundary detection
// ---------------------------------------------------------------------------

describe('_parseDispatcherAutonomy — block boundary', () => {
  it('does NOT consume a following top-level (column-0) key', () => {
    const content = [
      'dispatcher-autonomy:',
      '  autonomy: advisory',
      'evolve:',
      '  autonomy: autonomous-gated',
      '',
    ].join('\n');
    expect(_parseDispatcherAutonomy(content)).toEqual({
      autonomy: 'advisory',
      'confidence-floor': 0.5,
    });
  });

  it('ignores indented keys belonging to a later restart of the block scope', () => {
    // After the column-0 break, the indented `confidence-floor` belongs to
    // another top-level block and must NOT leak into the parsed result.
    const content = [
      'dispatcher-autonomy:',
      '  autonomy: advisory',
      'other-block:',
      '  confidence-floor: 0.9',
      '',
    ].join('\n');
    expect(_parseDispatcherAutonomy(content)).toEqual({
      autonomy: 'advisory',
      'confidence-floor': 0.5,
    });
  });
});

// ---------------------------------------------------------------------------
// Unit: _parseDispatcherAutonomy — robustness
// ---------------------------------------------------------------------------

describe('_parseDispatcherAutonomy — never throws on garbage', () => {
  it('returns defaults on binary-ish / control-character garbage with no block', () => {
    const content = ' �\x1b[31m garbage \t\n random :::: bytes';
    expect(_parseDispatcherAutonomy(content)).toEqual(DEFAULTS);
  });

  it('returns defaults when the header lacks the trailing colon requirement', () => {
    // `dispatcher-autonomy: advisory` (value on the header line) is not the
    // recognised block header (which requires a bare `dispatcher-autonomy:`).
    const content = 'dispatcher-autonomy: advisory\n';
    expect(_parseDispatcherAutonomy(content)).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveDispatcherAutonomy — precedence
// ---------------------------------------------------------------------------

describe('resolveDispatcherAutonomy — precedence', () => {
  it('env wins over committed', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'off',
      env: { SO_DISPATCHER_AUTONOMY: 'autonomous-gated' },
    });
    expect(result).toBe('autonomous-gated');
  });

  it('ownerConfig wins over committed when no env is set', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'off',
      env: {},
      ownerConfig: { dispatcher: { autonomy: 'advisory' } },
    });
    expect(result).toBe('advisory');
  });

  it('env wins over ownerConfig', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'off',
      env: { SO_DISPATCHER_AUTONOMY: 'autonomous-gated' },
      ownerConfig: { dispatcher: { autonomy: 'advisory' } },
    });
    expect(result).toBe('autonomous-gated');
  });

  it('committed wins when no env and no ownerConfig override', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: {},
    });
    expect(result).toBe('advisory');
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveDispatcherAutonomy — per-tier validation / fall-through
// ---------------------------------------------------------------------------

describe('resolveDispatcherAutonomy — invalid tiers fall through', () => {
  it('falls through an invalid env value to committed', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: { SO_DISPATCHER_AUTONOMY: 'banana' },
    });
    expect(result).toBe('advisory');
  });

  it('falls through an empty-string env value to committed', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: { SO_DISPATCHER_AUTONOMY: '' },
    });
    expect(result).toBe('advisory');
  });

  it('falls through a whitespace-only env value to committed', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: { SO_DISPATCHER_AUTONOMY: '  ' },
    });
    expect(result).toBe('advisory');
  });

  it('falls through an invalid ownerConfig override to committed', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'autonomous-gated',
      env: {},
      ownerConfig: { dispatcher: { autonomy: 'nope' } },
    });
    expect(result).toBe('autonomous-gated');
  });

  it('lowercases an uppercase env value (ADVISORY → advisory)', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'off',
      env: { SO_DISPATCHER_AUTONOMY: 'ADVISORY' },
    });
    expect(result).toBe('advisory');
  });
});

// ---------------------------------------------------------------------------
// Unit: resolveDispatcherAutonomy — fail-closed floor + safety
// ---------------------------------------------------------------------------

describe('resolveDispatcherAutonomy — fail-closed floor', () => {
  it('returns off when committed is undefined and env is empty', () => {
    const result = resolveDispatcherAutonomy({ committed: undefined, env: {} });
    expect(result).toBe('off');
  });

  it('returns off when committed is off and env is empty', () => {
    const result = resolveDispatcherAutonomy({ committed: 'off', env: {} });
    expect(result).toBe('off');
  });

  it('returns off when committed is invalid and all higher tiers unset', () => {
    const result = resolveDispatcherAutonomy({ committed: 'banana', env: {} });
    expect(result).toBe('off');
  });

  it('returns off when invoked with no arguments at all', () => {
    const result = resolveDispatcherAutonomy();
    expect(result).toBe('off');
  });
});

describe('resolveDispatcherAutonomy — ownerConfig safety', () => {
  it('does not throw and uses committed when ownerConfig is undefined', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: {},
      ownerConfig: undefined,
    });
    expect(result).toBe('advisory');
  });

  it('does not throw and uses committed when ownerConfig is null', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: {},
      ownerConfig: null,
    });
    expect(result).toBe('advisory');
  });

  it('does not throw and uses committed when ownerConfig lacks a dispatcher key', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: {},
      ownerConfig: { paths: {} },
    });
    expect(result).toBe('advisory');
  });

  it('does not throw and uses committed when ownerConfig.dispatcher lacks autonomy', () => {
    const result = resolveDispatcherAutonomy({
      committed: 'advisory',
      env: {},
      ownerConfig: { dispatcher: {} },
    });
    expect(result).toBe('advisory');
  });
});
