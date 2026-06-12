/**
 * tests/lib/hardening-tokenize.test.mjs
 *
 * Direct unit tests for tokenizeCommand (scripts/lib/hardening.mjs).
 *
 * tokenizeCommand is the quote-aware lexer that EVERY destructive-guard decision
 * depends on: the quoted-payload guard, parseRmTargets, and
 * commandHasRecursiveForceRm all consume its output. It is otherwise only
 * covered transitively via guard exit codes — a silent lexer regression would
 * de-fang all three at once. These tests pin the exact token shape and the
 * operator-/quote-/escape-splitting rules.
 *
 * Return shape (verified against the function source): an array of
 * `{ text: string, quoted: boolean }` tokens. Shell control operators
 * (`;`, `&&`, `||`, `|`, `&`) are emitted as standalone tokens with
 * `quoted: false` when they appear UNQUOTED; longest-match applies
 * (`&&` is one token, not two `&`). Quote/backslash characters are consumed.
 */

import { describe, it, expect } from 'vitest';
import { tokenizeCommand } from '../../scripts/lib/hardening.mjs';

describe('tokenizeCommand — unquoted whitespace splitting', () => {
  it('splits an unquoted command into one token per whitespace-delimited word', () => {
    expect(tokenizeCommand('rm -rf src/')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
  });

  it('collapses runs of whitespace and does not emit empty tokens', () => {
    expect(tokenizeCommand('  ls    -la  ')).toEqual([
      { text: 'ls', quoted: false },
      { text: '-la', quoted: false },
    ]);
  });

  it('splits known IFS obfuscations before command detection', () => {
    expect(tokenizeCommand('rm${IFS}-rf /data')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: '/data', quoted: false },
    ]);
    expect(tokenizeCommand('rm$IFS-rf /data')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: '/data', quoted: false },
    ]);
    expect(tokenizeCommand('rm${IFS:- }-rf /data')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: '/data', quoted: false },
    ]);
  });

  it('splits ANSI-C whitespace quotes before command detection', () => {
    expect(tokenizeCommand("rm$'\\t'-rf /data")).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: '/data', quoted: false },
    ]);
  });
});

describe('tokenizeCommand — operator splitting', () => {
  it('emits ;, &&, ||, |, & as standalone operator tokens even without surrounding whitespace', () => {
    expect(tokenizeCommand('a&&b||c|d&e;f')).toEqual([
      { text: 'a', quoted: false },
      { text: '&&', quoted: false },
      { text: 'b', quoted: false },
      { text: '||', quoted: false },
      { text: 'c', quoted: false },
      { text: '|', quoted: false },
      { text: 'd', quoted: false },
      { text: '&', quoted: false },
      { text: 'e', quoted: false },
      { text: ';', quoted: false },
      { text: 'f', quoted: false },
    ]);
  });

  it('uses longest-match for && (one token, not two & tokens)', () => {
    expect(tokenizeCommand('true && false')).toEqual([
      { text: 'true', quoted: false },
      { text: '&&', quoted: false },
      { text: 'false', quoted: false },
    ]);
  });

  it('uses longest-match for || (one token, not two | tokens)', () => {
    expect(tokenizeCommand('a || b')).toEqual([
      { text: 'a', quoted: false },
      { text: '||', quoted: false },
      { text: 'b', quoted: false },
    ]);
  });

  it('emits a single & as a standalone token', () => {
    expect(tokenizeCommand('a&b')).toEqual([
      { text: 'a', quoted: false },
      { text: '&', quoted: false },
      { text: 'b', quoted: false },
    ]);
  });
});

describe('tokenizeCommand — quoted spans', () => {
  it('keeps a quoted shell operator inside its token (operator does not split)', () => {
    expect(tokenizeCommand("echo 'a;b'")).toEqual([
      { text: 'echo', quoted: false },
      { text: 'a;b', quoted: true },
    ]);
  });

  it('keeps an && inside double quotes as part of one quoted token', () => {
    expect(tokenizeCommand('echo "a&&b"')).toEqual([
      { text: 'echo', quoted: false },
      { text: 'a&&b', quoted: true },
    ]);
  });

  it('preserves internal spaces inside single- and double-quote spans as one token each', () => {
    expect(tokenizeCommand("echo 'a b' \"c d\"")).toEqual([
      { text: 'echo', quoted: false },
      { text: 'a b', quoted: true },
      { text: 'c d', quoted: true },
    ]);
  });

  it('marks quoted tokens with quoted:true and unquoted tokens with quoted:false', () => {
    expect(tokenizeCommand("plain 'q'")).toEqual([
      { text: 'plain', quoted: false },
      { text: 'q', quoted: true },
    ]);
  });
});

describe('tokenizeCommand — backslash escapes', () => {
  it('joins a backslash-escaped space into one token, NOT marked quoted', () => {
    expect(tokenizeCommand('rm foo\\ bar')).toEqual([
      { text: 'rm', quoted: false },
      { text: 'foo bar', quoted: false },
    ]);
  });
});

describe('tokenizeCommand — boundary cases', () => {
  it('still emits a token for an unterminated single quote, marked quoted', () => {
    expect(tokenizeCommand("echo 'unterminated")).toEqual([
      { text: 'echo', quoted: false },
      { text: 'unterminated', quoted: true },
    ]);
  });

  it('still emits a token for an unterminated double quote, marked quoted', () => {
    expect(tokenizeCommand('echo "open')).toEqual([
      { text: 'echo', quoted: false },
      { text: 'open', quoted: true },
    ]);
  });

  it('returns an empty token list for the empty string', () => {
    expect(tokenizeCommand('')).toEqual([]);
  });
});
