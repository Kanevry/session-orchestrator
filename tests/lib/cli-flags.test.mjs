/**
 * cli-flags.test.mjs — behaviour contract for scripts/lib/cli-flags.mjs.
 *
 * Issue #510 acceptance contract:
 *   - parses known bool + string + multiple-string flags
 *   - hardcoded expected values (no tautological computation against the
 *     production formula — see .claude/rules/test-quality.md § Banned Anti-Patterns)
 *   - defaults flow through the post-parse `defaults` slot
 *   - unknown flag → throws CliFlagError (the test-equivalent of "exit 1")
 *
 * Issue #589 MED-1: the `onUnknown: 'ignore'` escape hatch was removed — it had
 * ZERO production callers (PSA-006 grep: all four scripts use the default
 * reject). The parser now unconditionally rejects unknown flags; the
 * unknown-flag-policy tests below cover that single behaviour.
 *
 * Coverage carries the migrated-script behavioural contract: the four scripts
 * each have their own end-to-end tests (tests/unit/vault-mirror.test.mjs,
 * tests/scripts/vault-mirror-entry-point.test.mjs, etc.) that exercise the
 * scripts through spawnSync. This suite stays focused on the helper.
 */

import { describe, it, expect } from 'vitest';

import { parseColumnFlags, CliFlagError } from '../../scripts/lib/cli-flags.mjs';

describe('parseColumnFlags — known flag parsing', () => {
  it('parses a bool flag (present) as true', () => {
    const { values } = parseColumnFlags({
      argv: ['--dry-run'],
      knownBool: { 'dry-run': false },
    });
    expect(values).toEqual({ 'dry-run': true });
  });

  it('parses an absent bool flag using its declared default (false)', () => {
    const { values } = parseColumnFlags({
      argv: [],
      knownBool: { 'dry-run': false, apply: false },
    });
    expect(values).toEqual({ 'dry-run': false, apply: false });
  });

  it('parses a string flag with --flag value form', () => {
    const { values } = parseColumnFlags({
      argv: ['--source', '/tmp/src.jsonl'],
      knownString: { source: null },
    });
    expect(values).toEqual({ source: '/tmp/src.jsonl' });
  });

  it('parses a string flag with --flag=value form', () => {
    const { values } = parseColumnFlags({
      argv: ['--source=/tmp/src.jsonl'],
      knownString: { source: null },
    });
    expect(values).toEqual({ source: '/tmp/src.jsonl' });
  });

  it('parses a short alias declared via { short }', () => {
    const { values } = parseColumnFlags({
      argv: ['-h'],
      knownBool: { help: { short: 'h', default: false } },
    });
    expect(values).toEqual({ help: true });
  });

  it('parses a string-multiple flag into an array (vault-consolidate --resolve)', () => {
    const { values } = parseColumnFlags({
      argv: [
        '--resolve', '50-sessions/foo.md=src',
        '--resolve', '01-projects/bar.md=dst',
      ],
      knownString: { resolve: { multiple: true, default: [] } },
    });
    expect(values).toEqual({
      resolve: ['50-sessions/foo.md=src', '01-projects/bar.md=dst'],
    });
  });

  it('parses a mixed bool + string + multiple combination', () => {
    const { values } = parseColumnFlags({
      argv: [
        '--apply',
        '--source', '/tmp/x.jsonl',
        '--resolve', 'a=src',
        '--resolve', 'b=dst',
        '--json',
      ],
      knownBool: { apply: false, json: false, 'dry-run': false },
      knownString: { source: null, resolve: { multiple: true, default: [] } },
    });
    expect(values).toEqual({
      apply: true,
      json: true,
      'dry-run': false,
      source: '/tmp/x.jsonl',
      resolve: ['a=src', 'b=dst'],
    });
  });

  it('treats a bare default value as the parseArgs default (vault-consolidate style)', () => {
    const { values } = parseColumnFlags({
      argv: [],
      knownBool: { apply: false, 'dry-run': false },
      knownString: { resolve: { multiple: true, default: [] } },
    });
    expect(values).toEqual({ apply: false, 'dry-run': false, resolve: [] });
  });
});

describe('parseColumnFlags — post-parse defaults slot', () => {
  it('fills undefined keys from defaults (string flag with no parseArgs default)', () => {
    const { values } = parseColumnFlags({
      argv: [],
      knownString: { source: null, canonical: null },
      defaults: { source: '~/Projects/vault', canonical: '~/Projects/Bernhard/vault' },
    });
    expect(values).toEqual({
      source: '~/Projects/vault',
      canonical: '~/Projects/Bernhard/vault',
    });
  });

  it('does NOT overwrite values explicitly supplied on argv', () => {
    const { values } = parseColumnFlags({
      argv: ['--source', '/custom/path'],
      knownString: { source: null },
      defaults: { source: '~/Projects/vault' },
    });
    expect(values).toEqual({ source: '/custom/path' });
  });
});

describe('parseColumnFlags — unknown-flag policy (reject = default)', () => {
  it('throws CliFlagError on an unknown long flag (#510 goal: exit 1)', () => {
    expect(() =>
      parseColumnFlags({
        argv: ['--unknown'],
        knownBool: { apply: false },
      }),
    ).toThrow(CliFlagError);
  });

  it('throws CliFlagError on a short alias that is not declared', () => {
    expect(() =>
      parseColumnFlags({
        argv: ['-x'],
        knownBool: { help: { short: 'h', default: false } },
      }),
    ).toThrow(CliFlagError);
  });

  it('throws CliFlagError when a string flag is given without its value', () => {
    // `--source` declared as string but followed by another flag → parseArgs
    // strict mode rejects this as a missing value. Wraps as CliFlagError.
    expect(() =>
      parseColumnFlags({
        argv: ['--source'],
        knownString: { source: null },
      }),
    ).toThrow(CliFlagError);
  });

  it('preserves the underlying parseArgs message on the thrown CliFlagError', () => {
    let thrown;
    try {
      parseColumnFlags({
        argv: ['--bogus'],
        knownBool: { apply: false },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliFlagError);
    expect(thrown.message).toContain('--bogus');
  });
});

describe('parseColumnFlags — unknown flags are always rejected (#589 MED-1)', () => {
  it('throws CliFlagError on an unknown flag mixed with a known one (no ignore escape hatch)', () => {
    // Regression guard for #589 MED-1: the removed onUnknown:'ignore' option
    // would have silently dropped `--this-is-not-known` and returned
    // { apply: true }. Post-removal the parser MUST throw — proving the dead
    // seam is gone, not merely defaulted off.
    expect(() =>
      parseColumnFlags({
        argv: ['--apply', '--this-is-not-known'],
        knownBool: { apply: false },
      }),
    ).toThrow(CliFlagError);
  });

  it('throws CliFlagError on a trailing unknown flag after a parsed string value', () => {
    expect(() =>
      parseColumnFlags({
        argv: ['--source', '/tmp/x.jsonl', '--bogus-extra'],
        knownString: { source: null },
      }),
    ).toThrow(CliFlagError);
  });
});

describe('parseColumnFlags — API edge errors', () => {
  it('returns positionals: [] when allowPositionals is off (strict mode)', () => {
    // Strict mode rejects positionals, so the only "no positionals" case is
    // when argv had no positionals to begin with. Confirms the shape contract.
    const { positionals } = parseColumnFlags({
      argv: ['--apply'],
      knownBool: { apply: false },
    });
    expect(positionals).toEqual([]);
  });
});
