/**
 * tests/lib/command-blocker.test.mjs
 *
 * Smoke-level direct unit tests for scripts/lib/command-blocker.mjs (A4 barrel
 * split). Verifies the new module path resolves and the security-sensitive
 * destructive-command guard behaves. Behaviour parity with the barrel is
 * covered exhaustively in hardening.test.mjs / hardening-tokenize.test.mjs;
 * this file is a direct-path smoke net.
 */

import { describe, it, expect } from 'vitest';
import {
  tokenizeCommand,
  commandMatchesBlocked,
  suggestForCommandBlock,
} from '@lib/command-blocker.mjs';

describe('command-blocker.mjs (direct import)', () => {
  it('tokenizeCommand splits a simple command on unquoted whitespace', () => {
    expect(tokenizeCommand('rm -rf src/')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
  });

  it('tokenizeCommand returns [] for empty input', () => {
    expect(tokenizeCommand('')).toEqual([]);
  });

  it('commandMatchesBlocked matches an unquoted destructive pattern across an operator', () => {
    expect(commandMatchesBlocked('ls;rm -rf /', 'rm -rf')).toBe(true);
  });

  it('commandMatchesBlocked treats a quoted pattern as inert for a non-interpreter verb', () => {
    expect(commandMatchesBlocked('echo "rm -rf /"', 'rm -rf')).toBe(false);
  });

  it('commandMatchesBlocked matches a quoted pattern when the verb is a shell interpreter', () => {
    expect(commandMatchesBlocked('bash -c "rm -rf /"', 'rm -rf')).toBe(true);
  });

  it('suggestForCommandBlock returns the tailored hint for rm -rf', () => {
    expect(suggestForCommandBlock('rm -rf')).toContain('Destructive deletion is blocked');
  });
});
