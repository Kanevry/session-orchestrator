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

  it('commandMatchesBlocked sees through a leading comment (#965 bypass)', () => {
    // A single apostrophe in `# don't` used to leave the lexer stuck in the
    // 'single' quote state, collapsing the whole command into one quoted token
    // with verb `#` — 8 of 9 block-severity rules allowed their own pattern.
    expect(commandMatchesBlocked("# don't\nrm -rf src/", 'rm -rf')).toBe(true);
  });

  it('suggestForCommandBlock returns the tailored hint for rm -rf', () => {
    expect(suggestForCommandBlock('rm -rf')).toContain('Destructive deletion is blocked');
  });
});

describe('commandMatchesBlocked — here-doc re-opened the #965 bypass (#970 HIGH-1)', () => {
  // Every row below was MEASURED as deny at 730ee9d and allow after #965: a
  // `<<` that is not a redirect (arithmetic shift, `let`) or a here-doc whose
  // terminator never matches opened a body that ran to end-of-input, collapsing
  // the REAL commands after it into one inert quoted token under a harmless verb.
  it.each([
    ['arithmetic shift then rm -rf', 'echo $((1<<2))\nrm -rf src/', 'rm -rf'],
    ['arithmetic shift then git reset', 'echo $((1<<2))\ngit reset --hard', 'git reset --hard'],
    ['arithmetic assignment then force-push', 'x=$((n<<3))\ngit push --force', 'git push --force'],
    ['spaced arithmetic', 'echo $(( 1 << 2 ))\nrm -rf src/', 'rm -rf'],
    ['(( )) arithmetic command', '((n<<3))\nrm -rf src/', 'rm -rf'],
    ['let expression, no parentheses', 'let x=1<<2\nrm -rf src/', 'rm -rf'],
    ['indented terminator without <<-', 'cat <<EOF\nbody\n  EOF\nrm -rf src/', 'rm -rf'],
    ['terminator never arrives', 'cat <<EOF\nrm -rf src/', 'rm -rf'],
    // The one row the terminator gate CANNOT catch: the phantom delimiter `2`
    // does appear as a later line, so the body terminates cleanly and only the
    // operator-position gate keeps `rm -rf src/` from becoming inert data.
    ['phantom delimiter that is later matched', 'echo $((1<<2))\nrm -rf src/\n2', 'rm -rf'],
  ])('%s', (_name, command, pattern) => {
    expect(commandMatchesBlocked(command, pattern)).toBe(true);
  });

  it.each([
    ['a real here-doc body stays inert for a non-interpreter verb', 'cat <<EOF\nrm -rf /\nEOF'],
    ['a trailing comment is not command text', 'ls -la # rm -rf src/'],
    ['plain arithmetic carries no blocked pattern', 'echo $((1<<2))'],
  ])('control: %s', (_name, command) => {
    expect(commandMatchesBlocked(command, 'rm -rf')).toBe(false);
  });
});

describe('commandMatchesBlocked — wrapper prefixes hid the interpreter (#970 HIGH-2)', () => {
  // The here-doc design's safety argument is that a body fed to an interpreter
  // still matches, because `bash` is in SHELL_EXEC_INTERPRETERS. That holds only
  // when `bash` is the RESOLVED verb — so before this fix `sudo bash <<EOF`
  // allowed exactly what `env bash <<EOF` denied (measured, both directions).
  it.each([
    ['sudo', 'sudo bash <<EOF\nrm -rf /\nEOF'],
    ['nohup', 'nohup bash <<EOF\nrm -rf /\nEOF'],
    ['timeout with its duration operand', 'timeout 5 bash <<EOF\nrm -rf /\nEOF'],
    ['nice', 'nice bash <<EOF\nrm -rf /\nEOF'],
    ['time', 'time bash <<EOF\nrm -rf /\nEOF'],
    ['sudo with a quoted -c payload', 'sudo bash -c "rm -rf /"'],
    ['env (control — already unwrapped before #970)', 'env bash <<EOF\nrm -rf /\nEOF'],
  ])('resolves the interpreter behind `%s`', (_name, command) => {
    expect(commandMatchesBlocked(command, 'rm -rf')).toBe(true);
  });

  it('control: a wrapper in front of a NON-interpreter leaves the payload inert', () => {
    // Widening verb resolution must not invent matches: `echo` is not an
    // interpreter, so its quoted argument stays literal text behind `sudo` too.
    expect(commandMatchesBlocked('sudo echo "rm -rf /"', 'rm -rf')).toBe(false);
  });
});
