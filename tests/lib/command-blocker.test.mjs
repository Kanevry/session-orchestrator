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
  extractRedirectTargets,
  redirectRuleMatches,
} from '@lib/command-blocker.mjs';

describe('command-blocker.mjs (direct import)', () => {
  // A single barrel-wiring smoke: full behavioural coverage of tokenizeCommand
  // (whitespace splitting, empty input, operators, quoting, escapes) lives in
  // hardening-tokenize.test.mjs against the direct scripts/lib/hardening.mjs
  // path. This test's job is different — it would catch the barrel
  // (@lib/command-blocker.mjs) failing to re-export tokenizeCommand correctly,
  // a defect the direct-path test cannot see.
  it('tokenizeCommand resolves through the barrel path and behaves as a real tokenizer', () => {
    expect(tokenizeCommand('rm -rf src/')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: 'src/', quoted: false },
    ]);
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

// ---------------------------------------------------------------------------
// #982 — wrapper unwrap + `-c` payload recursion
// ---------------------------------------------------------------------------

describe('commandMatchesBlocked — wrapper unwrap (#982)', () => {
  // The bug: verb resolution only unwrapped `env` (VAR=val forms) and
  // `command`, so wrapping an interpreter in sudo / env-with-flags / nohup /
  // timeout / nice / stdbuf hid the quoted destructive payload from the guard.
  // Each of these was measured `false` at c5252e6.
  it.each([
    ["sudo bash -c 'rm -rf /'"],
    ["sudo -u root bash -c 'rm -rf /'"],
    ["env -u FOO bash -c 'rm -rf /'"],
    ["env -i bash -c 'rm -rf /'"],
    ["nohup bash -c 'rm -rf /'"],
    ["timeout 5 bash -c 'rm -rf /'"],
    ["nice -n 10 bash -c 'rm -rf /'"],
    ["stdbuf -o0 bash -c 'rm -rf /'"],
  ])('blocks the wrapper-obscured shell payload: %s', (command) => {
    expect(commandMatchesBlocked(command, 'rm -rf')).toBe(true);
  });

  // Non-regression pins: these were `true` before #982 and must stay true —
  // the resolver rewrite (matchSegments extraction) could have broken any of
  // them. Quoted-containment (`echo "rm -rf is dangerous"`) is the case that
  // would silently flip if recursion ever REPLACED the quoted-token check
  // instead of adding to it.
  it.each([
    ["bash -c 'rm -rf /'"],
    ["env FOO=1 bash -c 'rm -rf /'"],
    ["command bash -c 'rm -rf /'"],
    ["/usr/bin/env bash -c 'rm -rf /'"],
    ['sudo rm -rf /'],
    [`bash -c "bash -c 'rm -rf /'"`],
    [`bash -c 'echo "rm -rf is dangerous"'`],
    ["bash -c 'rm${IFS}-rf /'"],
  ])('keeps blocking the established form: %s', (command) => {
    expect(commandMatchesBlocked(command, 'rm -rf')).toBe(true);
  });

  it('resolves sudo -s / sudo -i to a synthetic shell verb so the quoted payload is executed, not inert', () => {
    expect(commandMatchesBlocked("sudo -s 'rm -rf /'", 'rm -rf')).toBe(true);
    expect(commandMatchesBlocked("sudo -i 'rm -rf /'", 'rm -rf')).toBe(true);
  });

  it("treats su as an interpreter — su -c 'payload' executes its quoted payload", () => {
    expect(commandMatchesBlocked("su -c 'rm -rf /'", 'rm -rf')).toBe(true);
    expect(commandMatchesBlocked("su root -c 'rm -rf /'", 'rm -rf')).toBe(true);
  });

  it('unwrapping does NOT over-block: a quoted pattern under a wrapped non-interpreter verb stays inert', () => {
    expect(commandMatchesBlocked('sudo echo "rm -rf /"', 'rm -rf')).toBe(false);
    expect(commandMatchesBlocked('nice -n 10 echo "rm -rf /"', 'rm -rf')).toBe(false);
  });
});

describe('commandMatchesBlocked — -c payload recursion (#982)', () => {
  // env -S wraps its whole string argument as a command line; without payload
  // recursion the resolved verb is null (nothing follows -S) and the guard saw
  // nothing executable — measured `false` before #982.
  it('evaluates an env -S string as a command line (recursion into the payload)', () => {
    expect(commandMatchesBlocked(`env -S 'bash -c "rm -rf /"'`, 'rm -rf')).toBe(true);
    expect(commandMatchesBlocked("env -S 'rm -rf /'", 'rm -rf')).toBe(true);
  });

  it('matches a wrapper inside a -c payload (bash -c with sudo inside)', () => {
    expect(commandMatchesBlocked("bash -c 'sudo rm -rf /'", 'rm -rf')).toBe(true);
  });

  // The bug the cap prevents: unbounded payload recursion on a hostile
  // deeply-nested command would turn the hook hot-path into an amplification
  // vector. Depth 3 is the entry-checked ceiling: a triple-nested env -S chain
  // still resolves (depth 1→2→3), a quadruple-nested one returns false instead
  // of recursing further.
  it('payload recursion is depth-capped at 3: triple nesting matches, quadruple returns false', () => {
    const wrap = (cmd) => cmd.includes("'")
      ? `env -S "${cmd.replace(/[\\"]/g, (m) => '\\' + m)}"`
      : `env -S '${cmd}'`;
    const triple = wrap(wrap(wrap('rm -rf /')));
    const quadruple = wrap(triple);
    expect(commandMatchesBlocked(triple, 'rm -rf')).toBe(true);
    expect(commandMatchesBlocked(quadruple, 'rm -rf')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #983 — redirect token class in the lexer
// ---------------------------------------------------------------------------

describe('tokenizeCommand — redirect tokens (#983)', () => {
  // THE bug: `&>` lexed as chain-operator `&` + word `>`, so
  // `rm -rf /tmp/ok &> CLAUDE.md` split into two segments, the rm targets
  // were ["/tmp/ok"] (allowlisted) and the guard ALLOWED a command that
  // silently truncates CLAUDE.md. Measured at c5252e6.
  // Fake-regression run (documented): with the `&>` longest-match branch
  // temporarily removed from tokenizeCommand, this test goes RED
  // (`&` operator + `>` redirect instead of one `&>` token) — reverted green.
  it('lexes &> as ONE truncate-redirect token, never as & operator + > word (longest-match-first)', () => {
    expect(tokenizeCommand('rm -rf /tmp/ok &> CLAUDE.md')).toEqual([
      { text: 'rm', quoted: false },
      { text: '-rf', quoted: false },
      { text: '/tmp/ok', quoted: false },
      { text: '&>', quoted: false, redirect: { fd: null, mode: 'truncate' } },
      { text: 'CLAUDE.md', quoted: false },
    ]);
  });

  // THE other direction of the bug: `2>/dev/null` lexed as ONE glued token, so
  // fd-redirects were invisible; and `> out.log` fed ">" + "out.log" into
  // downstream target parsing as if they were command arguments (FP-block).
  it('splits the glued fd form 2>/dev/null into an fd-2 redirect + operand', () => {
    expect(tokenizeCommand('cmd 2>/dev/null')).toEqual([
      { text: 'cmd', quoted: false },
      { text: '2>', quoted: false, redirect: { fd: 2, mode: 'truncate' } },
      { text: '/dev/null', quoted: false },
    ]);
  });

  it('distinguishes >> (append) from > (truncate)', () => {
    expect(tokenizeCommand('cmd >> log')).toEqual([
      { text: 'cmd', quoted: false },
      { text: '>>', quoted: false, redirect: { fd: null, mode: 'append' } },
      { text: 'log', quoted: false },
    ]);
    expect(tokenizeCommand('cmd > log')).toEqual([
      { text: 'cmd', quoted: false },
      { text: '>', quoted: false, redirect: { fd: null, mode: 'truncate' } },
      { text: 'log', quoted: false },
    ]);
  });

  it('lexes heredoc << as a heredoc-mode redirect; the delimiter is consumed as syntax', () => {
    // Merged #965/#970 machinery: the delimiter word never becomes a token of
    // its own (bash reads it as syntax), and the body — when one follows a
    // newline — arrives as ONE quoted token (see hardening-tokenize.test.mjs).
    expect(tokenizeCommand('cat <<EOF')).toEqual([
      { text: 'cat', quoted: false },
      { text: '<<', quoted: false, redirect: { fd: null, mode: 'heredoc' } },
    ]);
  });

  it('lexes N>&M as a dup-mode redirect with the fd consumed from the digits', () => {
    expect(tokenizeCommand('cmd > /dev/null 2>&1')).toEqual([
      { text: 'cmd', quoted: false },
      { text: '>', quoted: false, redirect: { fd: null, mode: 'truncate' } },
      { text: '/dev/null', quoted: false },
      { text: '2>&1', quoted: false, redirect: { fd: 2, mode: 'dup' } },
    ]);
  });

  it('redirect chars inside quotes stay literal text (no redirect field on ordinary tokens)', () => {
    expect(tokenizeCommand('echo "a > b"')).toEqual([
      { text: 'echo', quoted: false },
      { text: 'a > b', quoted: true },
    ]);
  });
});

describe('extractRedirectTargets (#983)', () => {
  it('extracts a simple truncate target', () => {
    expect(extractRedirectTargets('echo x > out.log')).toEqual([
      { target: 'out.log', mode: 'truncate', fd: null },
    ]);
  });

  it('extracts the fd form with its fd number', () => {
    expect(extractRedirectTargets('cmd 2>/dev/null')).toEqual([
      { target: '/dev/null', mode: 'truncate', fd: 2 },
    ]);
  });

  it('finds a redirect inside a -c payload (recursion via the existing payload mechanics)', () => {
    expect(extractRedirectTargets("bash -c 'echo x > CLAUDE.md'")).toEqual([
      { target: 'CLAUDE.md', mode: 'truncate', fd: null },
    ]);
  });

  it('reports variable-indirection targets as unresolved (fail-visible, no guessing)', () => {
    expect(extractRedirectTargets('echo x > "$X"')).toEqual([
      { target: null, mode: 'truncate', fd: null, unresolved: true },
    ]);
  });

  it('strips quotes from a quoted target', () => {
    expect(extractRedirectTargets('echo x > "out file.log"')).toEqual([
      { target: 'out file.log', mode: 'truncate', fd: null },
    ]);
  });

  it('omits dup redirects (2>&1 names an fd, not a file)', () => {
    expect(extractRedirectTargets('cmd 2>&1')).toEqual([]);
  });
});

describe('redirectRuleMatches (#983 — denylist polarity)', () => {
  const RULE = {
    id: 'redirect-truncate-protected',
    type: 'redirect-truncate',
    severity: 'block',
    modes: ['truncate'],
    'target-denylist': [
      'CLAUDE.md', 'AGENTS.md', '.claude/rules/**', '.orchestrator/policy/**',
      '.orchestrator/metrics/*.jsonl', '.git/**', 'SECURITY.md',
    ],
  };

  it('matches a truncating redirect onto CLAUDE.md (the #983 incident shape)', () => {
    expect(redirectRuleMatches(RULE, 'rm -rf /tmp/ok &> CLAUDE.md')).toBe(true);
    expect(redirectRuleMatches(RULE, 'echo x > CLAUDE.md')).toBe(true);
  });

  it('does NOT match an unprotected target (out.log)', () => {
    expect(redirectRuleMatches(RULE, 'rm -rf /tmp/ok > out.log')).toBe(false);
  });

  it('does NOT match append >> onto a protected target (append stays allowed by design)', () => {
    expect(redirectRuleMatches(RULE, 'echo note >> CLAUDE.md')).toBe(false);
  });

  it('matches a ** denylist glob (.orchestrator/policy/blocked-commands.json)', () => {
    expect(redirectRuleMatches(RULE, 'echo {} > .orchestrator/policy/blocked-commands.json')).toBe(true);
  });

  it('does NOT match unresolved variable targets (deliberate #641-class FP boundary)', () => {
    expect(redirectRuleMatches(RULE, 'echo x > "$X"')).toBe(false);
  });

  it('normalizes a leading ./ before denylist matching', () => {
    expect(redirectRuleMatches(RULE, 'echo x > ./CLAUDE.md')).toBe(true);
  });

  // W4 F1a — bug each assert catches: without path.posix.normalize the
  // non-canonical spellings `.//CLAUDE.md` and `./sub/../CLAUDE.md` fail the
  // denylist glob and the truncation is SILENTLY ALLOWED (probe-measured
  // false pre-fix). Absolute/`~` spellings are a separate follow-up issue.
  it('normalizes `.//` and `sub/..` spellings before denylist matching (W4 F1a)', () => {
    expect(redirectRuleMatches(RULE, 'echo x > .//CLAUDE.md')).toBe(true);
    expect(redirectRuleMatches(RULE, 'echo x > ./sub/../CLAUDE.md')).toBe(true);
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
