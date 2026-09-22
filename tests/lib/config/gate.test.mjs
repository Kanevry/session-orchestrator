/**
 * tests/lib/config/gate.test.mjs
 *
 * Tests for scripts/lib/config/gate.mjs (`_parseGate`, #1425 A3 / #1432).
 */

import { describe, it, expect } from 'vitest';

import { _parseGate } from '../../../scripts/lib/config/gate.mjs';

describe('_parseGate', () => {
  it('defaults to 900 000 ms when no gate block is present', () => {
    // Bug: a missing block yielding NaN/undefined would reach runCheck as an
    // explicit `timeoutMs`, disabling the fallback instead of using it.
    expect(_parseGate('# nothing here\n')).toEqual({ 'timeout-path-b-ms': 900_000 });
  });

  it('reads a configured value', () => {
    expect(_parseGate('gate:\n  timeout-path-b-ms: 60000\n')['timeout-path-b-ms']).toBe(60_000);
  });

  it('strips inline comments and quotes', () => {
    expect(_parseGate('gate:\n  timeout-path-b-ms: "120000"  # 2 min\n')['timeout-path-b-ms'])
      .toBe(120_000);
  });

  it.each(['0', '-1', 'abc', '15.5', ''])('rejects %s and keeps the default', (raw) => {
    // Bug: a zero or negative ceiling kills every gate command instantly — a
    // worse failure than the uncapped state this key exists to fix.
    expect(_parseGate(`gate:\n  timeout-path-b-ms: ${raw}\n`)['timeout-path-b-ms'])
      .toBe(900_000);
  });

  it('finds the block OUTSIDE the ## Session Config section', () => {
    const md = [
      '## Session Config',
      'test-command: npm test',
      '',
      '## Notes',
      '',
      'gate:',
      '  timeout-path-b-ms: 42000',
      '',
    ].join('\n');
    expect(_parseGate(md)['timeout-path-b-ms']).toBe(42_000);
  });

  it('stops at the next unindented line', () => {
    const md = 'gate:\n  timeout-path-b-ms: 1000\nreaper:\n  timeout-path-b-ms: 2\n';
    expect(_parseGate(md)['timeout-path-b-ms']).toBe(1000);
  });

  it('ignores unknown keys inside the block', () => {
    expect(_parseGate('gate:\n  bogus: 1\n')['timeout-path-b-ms']).toBe(900_000);
  });
});
