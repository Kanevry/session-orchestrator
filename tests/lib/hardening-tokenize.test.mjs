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
// The barrel deliberately re-exports only the three public lexer/matcher
// entries; splitChainSegments (#982/#983) lives on the source module.
import { splitChainSegments } from '../../scripts/lib/command-blocker.mjs';

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

  // NOTE: longest-match (`&&`/`||` as ONE token, not two) and the single-`&`
  // case are pinned by the table above — it contains `a&&b||c|d&e;f`, i.e. every
  // operator in both its long and short form with no surrounding whitespace.
  // Three separate `true && false` / `a || b` / `a&b` cases were strict subsets
  // of that assertion and were consolidated away (TV-002b).
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

// ---------------------------------------------------------------------------
// #965 — comments, here-doc bodies, ANSI-C quoting, redirect operators
//
// The bug these pin: the lexer knew none of the four, so ONE unbalanced
// apostrophe from ordinary English prose (`# don't`) left it stuck in the
// 'single' state for the rest of the input. Everything downstream collapsed
// into a single `quoted: true` token whose verb resolved to `#`, and no policy
// rule could match — a measured, complete bypass of 8 of the 9 block-severity
// rules in .orchestrator/policy/blocked-commands.json.
// ---------------------------------------------------------------------------

describe('tokenizeCommand — shell comments (#965)', () => {
  it('drops a leading comment line and lexes the REAL command that follows', () => {
    // The exact bypass: `# don't` used to swallow `rm -rf src/` into one quoted token.
    // The leading separator is the comment's own end-of-line (#981): the comment
    // branch deliberately leaves the newline for the separator branch, and
    // splitChainSegments drops the resulting empty leading segment.
    expect(tokenizeCommand("# don't\nrm -rf src/")).toEqual([
      { text: ';', quoted: false, operator: 'newline' },
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
  });

  it.each([
    ['trailing comment on a command line', 'ls -la # rm -rf src/', [
      { text: 'ls', quoted: false },
      { text: '-la', quoted: false },
    ]],
    ['comment directly after an operator', 'ls;# rm -rf /', [
      { text: 'ls', quoted: false },
      { text: ';', quoted: false },
    ]],
    // A `#` that does NOT start a word is an ordinary character (bash agrees:
    // `echo a#b` prints `a#b`). Treating it as a comment would silently drop
    // command text — the permissive direction, in the guard's blind spot.
    ['mid-word # is a literal character', 'echo a#b', [
      { text: 'echo', quoted: false },
      { text: 'a#b', quoted: false },
    ]],
    ['# inside quotes is a literal character', "echo '# rm -rf /'", [
      { text: 'echo', quoted: false },
      { text: '# rm -rf /', quoted: true },
    ]],
  ])('%s', (_name, command, expected) => {
    expect(tokenizeCommand(command)).toEqual(expected);
  });
});

describe('tokenizeCommand — here-doc bodies (#965)', () => {
  it('emits the here-doc body as ONE quoted token, not as command words', () => {
    // `quoted: true` routes the body into the existing #641 quoted-payload guard
    // (inert for `cat`, still matched for `bash`) instead of a second rule.
    expect(tokenizeCommand("cat <<'EOF' > /tmp/n\nit's fine\nEOF")).toEqual([
      { text: 'cat', quoted: false },
      { text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
      { text: '>', quoted: false, redirect: { fd: null, mode: 'truncate' } },
      { text: '/tmp/n', quoted: false },
      { text: "it's fine", quoted: true },
    ]);
  });

  it('lexes a command that FOLLOWS a here-doc terminator as real command words', () => {
    // The B5 bypass: the apostrophe in the body hid the trailing real command.
    expect(tokenizeCommand("cat <<'EOF' > /tmp/n\nit's fine\nEOF\nrm -rf src/")).toEqual([
      { text: 'cat', quoted: false },
      { text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
      { text: '>', quoted: false, redirect: { fd: null, mode: 'truncate' } },
      { text: '/tmp/n', quoted: false },
      { text: "it's fine", quoted: true },
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
  });

  it('strips leading tabs for the <<- form and still finds the terminator', () => {
    expect(tokenizeCommand('cat <<-EOF\n\tbody\n\tEOF\nls')).toEqual([
      { text: 'cat', quoted: false },
      { text: '<<-', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
      { text: 'body', quoted: true },
      { text: 'ls', quoted: false },
    ]);
  });

  it('treats <<< as a here-STRING operator, not a here-doc delimiter', () => {
    expect(tokenizeCommand('cat <<< word')).toEqual([
      { text: 'cat', quoted: false },
      { text: '<<<', quoted: false, redirect: { fd: null, mode: 'herestring' } },
      { text: 'word', quoted: false },
    ]);
  });
});

describe('tokenizeCommand — here-doc operator position and terminator (#970)', () => {
  // Bug: the here-doc branch fired on ANY unquoted `<<`, so an arithmetic left
  // shift opened a PHANTOM here-doc whose delimiter was the fragment `2`. The
  // body then ran to end-of-input and every following command collapsed into
  // ONE `{quoted: true}` token under the verb `echo` — inert, i.e. `rm -rf src/`
  // on line 2 stopped matching. Asserting `quoted: false` on those words is the
  // load-bearing half: a quoted token here is exactly the swallow.
  it('does not open a here-doc on an arithmetic left shift', () => {
    expect(tokenizeCommand('echo $((1<<2))\nrm -rf src/')).toEqual([
      { text: 'echo', quoted: false },
      // Merged gate 1 (#970/#983): inside $(( )) the shift chars append
      // verbatim, so the expression survives as ONE intact token.
      { text: '$((1<<2))', quoted: false },
      // No here-doc is pending, so the newline is a plain separator (#981).
      { text: ';', quoted: false, operator: 'newline' },
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
  });

  // Same bug, no parentheses for the arithmetic-depth counter to see: `let`
  // takes a bare expression, so only the terminator gate catches this one.
  it('does not swallow the next line for a `let` left shift', () => {
    expect(tokenizeCommand('let x=1<<2\nrm -rf src/')).toEqual([
      { text: 'let', quoted: false },
      { text: 'x=1', quoted: false },
      { text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
  });

  // Bug: a CORRECTLY-opened here-doc whose terminator never matches byte-for-byte
  // (an indented `EOF` without `<<-`) hit the same collapse. An unterminated body
  // is not data — lexing resumes inside it so the text is read as the commands
  // it is. Conservative on purpose; the unterminated-QUOTE path still fails open.
  it('lexes an unterminated here-doc body as commands, not as one inert token', () => {
    // Only the FIRST newline is consumed by the here-doc branch (it opened the
    // body that turned out unterminated); once the pending list is abandoned the
    // remaining newlines are ordinary separators (#981).
    expect(tokenizeCommand('cat <<EOF\nbody\n  EOF\nrm -rf src/')).toEqual([
      { text: 'cat', quoted: false },
      { text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
      { text: 'body', quoted: false },
      { text: ';', quoted: false, operator: 'newline' },
      { text: 'EOF', quoted: false },
      { text: ';', quoted: false, operator: 'newline' },
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
  });

  // The over-tightening direction: `<<` needs no preceding whitespace to be a
  // redirect. If the operator-position gate ever grows a "must not follow a
  // word" rule, this body stops being inert data and `cat<<EOF` starts denying.
  it('still treats `cat<<EOF` (no whitespace) as a here-doc', () => {
    expect(tokenizeCommand('cat<<EOF\nbody\nEOF\nls')).toEqual([
      { text: 'cat', quoted: false },
      { text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
      { text: 'body', quoted: true },
      { text: 'ls', quoted: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #981 — line continuation is not an escape, newline is not whitespace
//
// Two defects in one branch. `\` + newline was appended as literal text, so the
// guard saw a PHANTOM `"\n"` token bash never produces; and a real newline was
// treated as ordinary whitespace, so every line of a multi-line command landed
// in ONE segment under the FIRST line's verb.
//
// Measured consequences (both directions wrong, both against `bash -c 'set --
// …'` as the reference argv):
//   - `git push \<LF>--force origin main` → token `"\n--force"`, so the
//     `git push --force` rule matched nothing: ALLOWED, while bash force-pushes.
//   - `rm -rf \<LF> /tmp/ok` → the phantom `"\n"` read as a second, non-
//     allowlisted rm target: DENIED, while bash's argv is the allowlisted
//     `rm -rf /tmp/ok`.
//   - `echo hi<LF>bash <<EOF<LF>rm -rf /<LF>EOF` → verb resolved to `echo`, so
//     the here-doc body stayed inert: ALLOWED, while bash feeds it to `bash`.
// ---------------------------------------------------------------------------

describe('tokenizeCommand — line continuation and newline separators (#981)', () => {
  const word = (text) => ({ text, quoted: false });
  const nl = { text: ';', quoted: false, operator: 'newline' };

  // A continuation must leave NO trace: the token stream has to equal what bash
  // passes as argv. Each row was cross-checked against `bash -c 'set -- …'`.
  it.each([
    ['continuation between two operands', 'rm -rf /tmp/a \\\n src/',
      [word('rm'), word('-rf'), word('/tmp/a'), word('src/')]],
    ['continuation before a flag — the git-push-force bypass', 'git push \\\n--force origin main',
      [word('git'), word('push'), word('--force'), word('origin'), word('main')]],
    ['continuation with nothing after it on the line', 'rm -rf \\\n /tmp/ok',
      [word('rm'), word('-rf'), word('/tmp/ok')]],
    ['continuation INSIDE a word joins it — bash argv is [-rf]', 'rm -r\\\nf /tmp/ok',
      [word('rm'), word('-rf'), word('/tmp/ok')]],
    // The over-elision direction: a backslash before any OTHER character keeps
    // its historical escape behaviour, so a quoted-by-backslash space still
    // yields ONE token.
    ['backslash before a space is still an escape', 'rm -rf /tmp/my\\ dir',
      [word('rm'), word('-rf'), word('/tmp/my dir')]],
    // A trailing continuation must not flush a phantom EMPTY token.
    ['trailing continuation at end of input', 'ls \\\n', [word('ls')]],
  ])('%s', (_name, command, expected) => {
    expect(tokenizeCommand(command)).toEqual(expected);
  });

  it('emits a real newline as a separator token, not as whitespace', () => {
    expect(tokenizeCommand('echo hi\nrm -rf /')).toEqual([
      word('echo'), word('hi'), nl, word('rm'), word('-rf'), word('/'),
    ]);
  });

  // The load-bearing ordering: the separator branch sits BELOW the pending-
  // here-doc branch, so a body line can never become a segment boundary. If the
  // two were swapped, the body of `cat <<EOF` would split into commands and the
  // #965/#970 inert-data contract would collapse.
  it('never emits a separator inside a here-doc body', () => {
    expect(tokenizeCommand('cat <<EOF\nrm -rf /\nEOF')).toEqual([
      word('cat'),
      { text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
      { text: 'rm -rf /', quoted: true },
    ]);
  });

  // The separator is CONSUMED by splitChainSegments, which is what keeps every
  // per-segment operand loop (parseRmTargets in the destructive guard) free of
  // a token it would otherwise read as a filename.
  it('splitChainSegments consumes the newline separator instead of yielding it', () => {
    const segments = splitChainSegments(tokenizeCommand('echo hi\nbash <<EOF\nrm -rf /\nEOF'));
    expect(segments.map((s) => s.map((t) => t.text))).toEqual([
      ['echo', 'hi'],
      ['bash', '<<', 'rm -rf /'],
    ]);
    expect(segments.flat().some((t) => t.operator === 'newline')).toBe(false);
  });
});

describe('tokenizeCommand — ANSI-C quoting (#965)', () => {
  it("keeps $'a\\'b' as ONE token — the escaped quote does not end the run", () => {
    expect(tokenizeCommand("echo $'a\\'b'; rm -rf /")).toEqual([
      { text: 'echo', quoted: false },
      { text: "a'b", quoted: true },
      { text: ';', quoted: false },
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: '/', quoted: false },
    ]);
  });

  it('flushes an unterminated ANSI-C quote as a quoted token (conservative, fail-open)', () => {
    expect(tokenizeCommand("echo $'abc")).toEqual([
      { text: 'echo', quoted: false },
      { text: 'abc', quoted: true },
    ]);
  });
});

describe('tokenizeCommand — redirect operators (#965/#983 merged token class)', () => {
  // Redirect operators carry the #983 `redirect` discriminator ({fd, mode}) —
  // the merged shape of the two 2026-08-03 guard sessions. Only redirect
  // tokens carry the field; ordinary tokens keep the two-property shape.
  const rtok = (text, fd, mode) => ({ text, quoted: false, redirect: { fd, mode } });
  const word = (text) => ({ text, quoted: false });
  it.each([
    ['> without surrounding whitespace', 'ls>a', [word('ls'), rtok('>', null, 'truncate'), word('a')]],
    ['>> append', 'ls >> a', [word('ls'), rtok('>>', null, 'append'), word('a')]],
    ['>| noclobber override is ONE token', 'ls >| a', [word('ls'), rtok('>|', null, 'truncate'), word('a')]],
    ['N> keeps the fd with the operator', 'ls 2> /dev/null', [word('ls'), rtok('2>', 2, 'truncate'), word('/dev/null')]],
    ['N> without whitespace', 'ls 2>/dev/null', [word('ls'), rtok('2>', 2, 'truncate'), word('/dev/null')]],
    ['< input redirect', 'sort < a', [word('sort'), rtok('<', null, 'read'), word('a')]],
  ])('%s', (_name, command, expected) => {
    expect(tokenizeCommand(command)).toEqual(expected);
  });

  it('lexes &> as ONE truncate-mode redirect token (#983 supersedes the old & split)', () => {
    // The pre-#983 lexer split `&>` into the chain operator `&` + `>`, which
    // made `echo x &> CLAUDE.md` a silent truncation (measured, W1-D2). The
    // merged token class closes that; `rm -rf /tmp/x &> /tmp/out.log` stays
    // ALLOWED because the write target clears the rm allowlist, not because
    // the redirect was invisible.
    expect(tokenizeCommand('rm -rf /tmp/x &> /tmp/out.log')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: '/tmp/x', quoted: false },
      rtok('&>', null, 'truncate'),
      { text: '/tmp/out.log', quoted: false },
    ]);
  });

  it('lexes 2>&1 as ONE dup-mode redirect token (fd target is inline, no operand word)', () => {
    expect(tokenizeCommand('ls 2>&1')).toEqual([
      { text: 'ls', quoted: false },
      rtok('2>&1', 2, 'dup'),
    ]);
  });
});
