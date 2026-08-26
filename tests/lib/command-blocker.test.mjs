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
  redirectSpanEnd,
  resolveSegmentVerb,
  splitChainSegments,
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
  // Consolidated from 6 single-assert `it` blocks — same shape throughout
  // (command in, entry list out), so the table costs one row per case.
  it.each([
    ['simple truncate target', 'echo x > out.log',
      [{ target: 'out.log', mode: 'truncate', fd: null }]],
    ['fd form carries its fd number', 'cmd 2>/dev/null',
      [{ target: '/dev/null', mode: 'truncate', fd: 2 }]],
    ['redirect inside a -c payload (recursion via the payload mechanics)', "bash -c 'echo x > CLAUDE.md'",
      [{ target: 'CLAUDE.md', mode: 'truncate', fd: null }]],
    ['variable indirection is unresolved, never guessed', 'echo x > "$X"',
      [{ target: null, mode: 'truncate', fd: null, unresolved: true }]],
    ['quotes are stripped from the target', 'echo x > "out file.log"',
      [{ target: 'out file.log', mode: 'truncate', fd: null }]],
    ['dup redirect names an fd, not a file', 'cmd 2>&1', []],
  ])('%s', (_label, command, expected) => {
    expect(extractRedirectTargets(command)).toEqual(expected);
  });

  // #988 T2 — the bug: both recursion cut-offs dropped the un-walked subtree
  // SILENTLY, so a DoS ceiling doubled as a full bypass. Measured at 8cdb434:
  // the budget command below returned `[]` — an empty list is indistinguishable
  // from "this command redirects nowhere", and the guard allowed it.
  it('marks a budget-exhausted payload subtree instead of dropping it silently', () => {
    const filler = Array.from({ length: 32 }, (_, i) => `-c 'echo f${i}'`).join(' ');
    expect(extractRedirectTargets(`bash ${filler} -c 'echo x > CLAUDE.md'`)).toEqual([
      { target: null, mode: null, fd: null, unresolved: true, reason: 'budget-exhausted' },
    ]);
  });

  it('marks a depth-exceeded payload subtree, and still walks one within the cap', () => {
    const nest = (n) => {
      let s = 'echo x > CLAUDE.md';
      for (let d = 0; d < n; d++) s = `bash -c "${s.replace(/(["\\])/g, '\\$1')}"`;
      return s;
    };
    // The ceiling itself is unchanged — depth 3 still resolves the target.
    expect(extractRedirectTargets(nest(3))).toEqual([
      { target: 'CLAUDE.md', mode: 'truncate', fd: null },
    ]);
    expect(extractRedirectTargets(nest(4))).toEqual([
      { target: null, mode: null, fd: null, unresolved: true, reason: 'depth-exceeded' },
    ]);
  });
});

describe('resolveSegmentVerb — `time` argFlags + wrapperArgs (#988 T3)', () => {
  const resolve = (cmd) => resolveSegmentVerb(splitChainSegments(tokenizeCommand(cmd))[0]);

  // The bug: `time` sat in WRAPPER_UNWRAP with an EMPTY spec, so `-o`'s operand
  // was read as the verb. Measured at 8cdb434:
  //   `/usr/bin/time -o /tmp/log tee -a LEDGER`            → verb "log"
  //   `/usr/bin/time -o .orchestrator/metrics/sessions.jsonl …` → verb "sessions.jsonl"
  // i.e. the wrapper HID the real write verb behind its own report file.
  it('resolves past `time -o FILE` to the real verb', () => {
    expect(resolve('/usr/bin/time -o /tmp/log tee -a LEDGER').verb).toBe('tee');
    expect(resolve('/usr/bin/time -a -o /tmp/log rm -rf /x').verb).toBe('rm');
  });

  // The operand `time` writes is a truncating file target invisible in
  // `verb`/`payloads` — `time -o <ledger> npm test` empties <ledger> while the
  // verb is `npm`. A2 (#991) judges these; without wrapperArgs they were
  // discarded at the `i += 2` skip and unrecoverable downstream.
  it('returns the consumed wrapper operands in both spellings', () => {
    expect(resolve('/usr/bin/time -o /tmp/log tee -a LEDGER').wrapperArgs).toEqual([
      { wrapper: 'time', flag: '-o', value: '/tmp/log', writesFile: true },
    ]);
    expect(resolve('/usr/bin/time --output=.orchestrator/metrics/sessions.jsonl npm test').wrapperArgs).toEqual([
      { wrapper: 'time', flag: '--output', value: '.orchestrator/metrics/sessions.jsonl', writesFile: true },
    ]);
    // Additive contract: shapes without a value-taking wrapper flag report [].
    expect(resolve('time npm test')).toEqual({
      verb: 'npm', index: 1, payloads: [], wrapperArgs: [],
    });
  });

  // Direction guard: unwrapping further must never LOSE a block. Each row was
  // re-measured after the flip — all still match the rm -rf pattern.
  it.each([
    ['unquoted rm behind time -o', '/usr/bin/time -o /tmp/log rm -rf /'],
    ['quoted payload behind time -o (the shape argFlags rescues)', "/usr/bin/time -o /tmp/log bash -c 'rm -rf /'"],
    ['bare keyword-shaped time is untouched', "time bash -c 'rm -rf /'"],
    ['boolean -p flag is untouched', "/usr/bin/time -p bash -c 'rm -rf /'"],
  ])('still blocks: %s', (_label, command) => {
    expect(commandMatchesBlocked(command, 'rm -rf')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #992 — value-taking wrapper flags that were missing from WRAPPER_UNWRAP, and
// the `writesFile` half of the wrapperArgs contract.
// ---------------------------------------------------------------------------
describe('WRAPPER_UNWRAP completeness — missing value-taking flags (#992)', () => {
  const resolve = (cmd) => resolveSegmentVerb(splitChainSegments(tokenizeCommand(cmd))[0]);

  // The bug: BSD/macOS `env -P altpath` (env(1): "Search the set of directories
  // as specified by altpath to locate the specified utility program") was not
  // in env's argFlags. It was skipped as a one-token boolean and its PATH
  // operand landed in verb position. Measured at 718042c:
  //   `env -P /bin:/usr/bin bash -c 'rm -rf /etc'`      → verb "bin", ALLOW
  //   `env -P /bin:/usr/bin psql -c 'DROP TABLE users'` → ALLOW
  // Executability was confirmed — `env -P /bin:/usr/bin bash -c '…'` runs.
  it('resolves past `env -P altpath` to the real interpreter', () => {
    expect(resolve("env -P /bin:/usr/bin bash -c 'rm -rf /etc'").verb).toBe('bash');
    expect(commandMatchesBlocked("env -P /bin:/usr/bin bash -c 'rm -rf /etc'", 'rm -rf')).toBe(true);
    expect(commandMatchesBlocked("env -P /bin:/usr/bin psql -c 'DROP TABLE users'", 'DROP TABLE')).toBe(true);
  });

  // Same class, GNU time(1) `-f FORMAT` / `--format FORMAT` (not on BSD/macOS,
  // so this row is Linux-CI-relevant only). Measured at 718042c: verb `%e`.
  it('resolves past GNU `time -f FORMAT` to the real verb', () => {
    expect(resolve('/usr/bin/time -f %e npm test').verb).toBe('npm');
    expect(commandMatchesBlocked("/usr/bin/time --format=%e bash -c 'rm -rf /'", 'rm -rf')).toBe(true);
  });

  // `-P` is value-taking for `env` and BOOLEAN for `sudo` (--preserve-groups,
  // per `sudo -h`). A per-wrapper table is the only thing that can hold both;
  // this row fails the moment someone hoists `-P` into a shared flag set.
  it('keeps `-P` per-wrapper: value-taking for env, boolean for sudo', () => {
    expect(resolve('sudo -P rm -rf /').verb).toBe('rm');
    expect(resolve('env -P /bin rm -rf /').verb).toBe('rm');
  });
});

describe('wrapperArgs.writesFile + wrapper file targets (#992)', () => {
  const resolve = (cmd) => resolveSegmentVerb(splitChainSegments(tokenizeCommand(cmd))[0]);

  // The precision this replaces a second table with: `argFlags` membership says
  // "this flag takes a value", NOT "that value is a file". All three rows below
  // carry an argFlag operand that is not a filesystem target — a blanket rule
  // would report every one of them and block `stdbuf -o 0 tee x`.
  it.each([
    ['sudo -u root — a user name', 'sudo -u root tee f'],
    ['stdbuf -o 0 — a BUFFERING MODE', 'stdbuf -o 0 tee f'],
    ['nice -n 10 — a priority', 'nice -n 10 tee f'],
    ['time -f %e — a format string', '/usr/bin/time -f %e npm test'],
  ])('does NOT mark %s as a write target', (_label, command) => {
    for (const wa of resolve(command).wrapperArgs) {
      expect(wa.writesFile).toBeUndefined();
    }
    expect(extractRedirectTargets(command)).toEqual([]);
  });

  // `/usr/bin/time -o FILE` truncates FILE (BSD time(1)) while the verb is
  // whatever time runs — no redirect operator anywhere, so the pre-#992
  // traversal reported nothing. Measured at 718042c against the real 14-rule
  // policy: `> CLAUDE.md` DENY, `/usr/bin/time -o CLAUDE.md npm test` ALLOW.
  it.each([
    ['separated -o', '/usr/bin/time -o CLAUDE.md npm test'],
    ['attached --output=', '/usr/bin/time --output=CLAUDE.md npm test'],
  ])('reports the %s operand as a truncate target', (_label, command) => {
    expect(extractRedirectTargets(command)).toEqual([
      { target: 'CLAUDE.md', mode: 'truncate', fd: null },
    ]);
  });

  // Same #641 fail-visible rule the redirect operands follow: a variable or a
  // command substitution is surfaced, never guessed at, never matched.
  it('reports a variable operand as unresolved rather than guessing', () => {
    expect(extractRedirectTargets('/usr/bin/time -o "$OUT" npm test')).toEqual([
      { target: null, mode: 'truncate', fd: null, unresolved: true },
    ]);
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

  // One table, one shape: command in, verdict out. Consolidated from 7
  // near-identical single-assert `it` blocks — each row still names the bug it
  // catches, and a new spelling is now one row rather than one more block.
  const ROOT = '/repo';
  const HOME = '/home/op';
  it.each([
    // [label, command, opts, expected]
    ['&> onto CLAUDE.md — the #983 incident shape', 'rm -rf /tmp/ok &> CLAUDE.md', {}, true],
    ['plain > onto CLAUDE.md', 'echo x > CLAUDE.md', {}, true],
    ['unprotected target stays allowed', 'rm -rf /tmp/ok > out.log', {}, false],
    ['append >> stays allowed by design', 'echo note >> CLAUDE.md', {}, false],
    ['** glob under .orchestrator/policy', 'echo {} > .orchestrator/policy/blocked-commands.json', {}, true],
    // #641 FP boundary: blocking on a guessed variable value reintroduces the
    // false-positive class #641 removed.
    ['variable target is never a match candidate', 'echo x > "$X"', {}, false],
    ['leading ./ is stripped', 'echo x > ./CLAUDE.md', {}, true],
    // W4 F1a — without path.posix.normalize these non-canonical spellings fail
    // the glob and the truncation is SILENTLY ALLOWED (probe-measured false).
    ['.// spelling normalizes', 'echo x > .//CLAUDE.md', {}, true],
    ['sub/.. spelling normalizes', 'echo x > ./sub/../CLAUDE.md', {}, true],

    // #992 — a wrapper file flag truncates without any redirect operator. The
    // rule sees it only because extractRedirectTargets now emits it; measured
    // ALLOW against the real 14-rule policy before the fix.
    ['time -o onto CLAUDE.md', '/usr/bin/time -o CLAUDE.md npm test', {}, true],
    ['time --output= onto CLAUDE.md', '/usr/bin/time --output=CLAUDE.md npm test', {}, true],
    // The precision boundary: an argFlag operand that is not a file must not
    // become a target, or `stdbuf -o 0` / `nice -n 10` / `sudo -u root` block.
    ['stdbuf -o 0 is a buffering mode, not a file', 'stdbuf -o 0 tee CLAUDE.md', {}, false],
    ['nice -n 10 is a priority, not a file', 'nice -n 10 tee CLAUDE.md', {}, false],
    ['sudo -u root is a user, not a file', 'sudo -u root tee CLAUDE.md', {}, false],
    ['a time report outside the repo is not judgeable', '/usr/bin/time -o /tmp/log npm test', {}, false],

    // #988 T1 — the denylist globs are repo-relative, so before repoRoot
    // resolution an ABSOLUTE or `~` spelling of the very same file matched
    // NOTHING and was silently allowed (probe-measured at 8cdb434:
    // `rule abs: false` / `rule tilde: false` beside `rule rel: true`).
    ['absolute in-repo target', `echo x > ${ROOT}/CLAUDE.md`, { repoRoot: ROOT }, true],
    ['absolute in-repo ** glob', `echo x > ${ROOT}/.git/HEAD`, { repoRoot: ROOT }, true],
    ['~ target', 'echo x > ~/repo/CLAUDE.md', { repoRoot: `${HOME}/repo`, home: HOME }, true],
    ['bare ~ is not a file target', 'echo x > ~', { repoRoot: HOME, home: HOME }, false],
    ['~user is another account, never this repo', 'echo x > ~other/repo/CLAUDE.md', { repoRoot: `${HOME}/repo`, home: HOME }, false],
    // Direction guard: absolute resolution must not turn every foreign
    // CLAUDE.md on the machine into a block.
    ['absolute target OUTSIDE the repo', 'echo x > /etc/CLAUDE.md', { repoRoot: ROOT }, false],
    ['sibling repo outside the root', 'echo x > /other/CLAUDE.md', { repoRoot: ROOT }, false],
    // Without repoRoot the pre-#988 contract stands verbatim — existing
    // callers that pass no options keep their exact behaviour.
    ['absolute target WITHOUT repoRoot keeps the old no-match contract', `echo x > ${ROOT}/CLAUDE.md`, {}, false],
    // macOS /private alias: /tmp and /private/tmp are one location with two
    // spellings. A repo under /tmp (CI runners, worktrees) would otherwise not
    // recognise its own root when the command spells it the other way.
    ['/private/tmp target vs /tmp root', 'echo x > /private/tmp/r/CLAUDE.md', { repoRoot: '/tmp/r' }, true],
    ['/tmp target vs /private/tmp root', 'echo x > /tmp/r/CLAUDE.md', { repoRoot: '/private/tmp/r' }, true],
    ['/privatefoo is NOT the alias prefix', 'echo x > /privatefoo/CLAUDE.md', { repoRoot: '/foo' }, false],

    // #994 R1 — a RELATIVE target is repo-root-relative, not shell-cwd-relative.
    // A `..` that climbs out and lands BACK inside the root (worktree-sibling
    // spellings) was silently allowed before, because the relative branch never
    // resolved against repoRoot.
    ['relative ../repo climbs back into the root', `echo x > ../repo/CLAUDE.md`, { repoRoot: ROOT }, true],
    ['relative ../repo into a ** glob', `echo x > ../repo/.orchestrator/policy/blocked-commands.json`, { repoRoot: ROOT }, true],
    ['relative ./a/../../repo normalizes back in', `echo x > ./a/../../repo/CLAUDE.md`, { repoRoot: ROOT }, true],
    // Direction guards: a `..` that lands OUTSIDE the root is not judgeable.
    ['relative ../other lands outside the root', `echo x > ../other/CLAUDE.md`, { repoRoot: ROOT }, false],
    ['relative ../../etc lands outside the root', `echo x > ../../etc/CLAUDE.md`, { repoRoot: ROOT }, false],
    ['relative ../repo WITHOUT repoRoot keeps the lexical no-match', `echo x > ../repo/CLAUDE.md`, {}, false],

    // #994 R2 — the denylist globs are case-insensitive (`i` flag). On a
    // case-insensitive volume `> claude.md` is the same inode as CLAUDE.md, so
    // the lowercase / mixed-case spelling that used to slip past now denies.
    ['lowercase claude.md matches CLAUDE.md', 'echo x > claude.md', {}, true],
    ['mixed-case Claude.md matches CLAUDE.md', 'echo x > Claude.md', {}, true],
    ['mixed-case .claude/Rules/ matches .claude/rules/**', 'echo x > .claude/Rules/security.md', {}, true],
    ['lowercase security.md matches SECURITY.md', 'echo x > security.md', {}, true],
    ['absolute lowercase claude.md matches', `echo x > ${ROOT}/claude.md`, { repoRoot: ROOT }, true],
    // Direction guard: an unrelated name is not dragged in by the `i` flag.
    ['OUT.LOG is not a denylisted target', 'echo x > OUT.LOG', {}, false],

    // #994 R3 — alias/root-boundary spellings collapse to the same inode.
    // Case-folded containment: /REPO vs /repo is one directory on APFS.
    ['case-folded /REPO vs /repo root', 'echo x > /REPO/CLAUDE.md', { repoRoot: '/repo' }, true],
    // /private/etc alias joins /private/{tmp,var}.
    ['/etc alias vs /private/etc root', 'echo x > /etc/r/CLAUDE.md', { repoRoot: '/private/etc/r' }, true],
    // /System/Volumes/Data firmlink strips to the same root on either side.
    ['Data-volume target vs bare root', 'echo x > /System/Volumes/Data/repo/CLAUDE.md', { repoRoot: '/repo' }, true],
    ['bare target vs Data-volume root', 'echo x > /repo/CLAUDE.md', { repoRoot: '/System/Volumes/Data/repo' }, true],
    // Direction guard: a DIFFERENT firmlink volume is not the Data alias.
    ['/System/Volumes/Other is not the Data alias', 'echo x > /System/Volumes/Other/repo/CLAUDE.md', { repoRoot: ROOT }, false],
  ])('%s', (_label, command, opts, expected) => {
    expect(redirectRuleMatches(RULE, command, opts)).toBe(expected);
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

describe('splitChainSegments — newline after a here-doc terminator is a separator (#999)', () => {
  // FP regression. `readHeredocBody` returns `end` PAST the terminator's closing
  // newline, so the lexer resumed one char too late and that newline never
  // reached the separator branch: `cat <<EOF\nbody\nEOF\nrm -rf /tmp/ok` stayed
  // ONE segment under the verb `cat`. The rm-rf rule still MATCHED the glued
  // text, but parseRmTargets (hooks/pre-bash-destructive-guard.mjs) iterates
  // segments and collects targets only from a segment whose verb resolves to
  // `rm` — the cat-verb segment yielded none, so the allowlisted /tmp/ok target
  // failed CLOSED and an allowed command was DENIED.
  it('isolates the post-terminator command into its own rm-verb segment (was glued into `cat`)', () => {
    const segments = splitChainSegments(
      tokenizeCommand('cat <<EOF\nbody\nEOF\nrm -rf /tmp/ok'),
    );
    // Two segments: the here-doc `cat` and the standalone `rm`. Before the fix
    // this was a single `cat`-verb segment with the rm tokens glued on.
    expect(segments).toHaveLength(2);
    expect(resolveSegmentVerb(segments[0]).verb).toBe('cat');

    const rmSegment = segments[1];
    expect(resolveSegmentVerb(rmSegment).verb).toBe('rm');
    // The allowlistable target is now reachable to a per-segment rm parser that
    // gates on `verb === 'rm'`, so /tmp/ok can be allowlisted instead of denied.
    expect(rmSegment.map((t) => t.text)).toEqual(['rm', '-rf', '/tmp/ok']);
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

// ---------------------------------------------------------------------------
// #1000 — dual parse for UNKNOWN value-taking wrapper flags
// ---------------------------------------------------------------------------

describe('resolveSegmentVerb — dual parse for unknown value-taking flags (#1000)', () => {
  const resolve = (cmd) => resolveSegmentVerb(splitChainSegments(tokenizeCommand(cmd))[0]);

  // The bug class: WRAPPER_UNWRAP can only enumerate the flags it KNOWS. Any
  // value-taking flag missing from the table (a platform variant, a new
  // release, a wrapper flag nobody measured) is skipped as a boolean and its
  // OPERAND lands in verb position — the exact shape #992 had to patch twice
  // by hand (`env -P`, GNU `time -f`). `-Q` stands in for the unenumerable
  // rest: parse A reads the verb as `bin` (basename of the path operand), the
  // segment stops being an interpreter, and the quoted payload goes inert.
  it('blocks the interpreter that an unknown value-taking flag hid', () => {
    expect(commandMatchesBlocked("env -Q /bin:/usr/bin bash -c 'rm -rf /etc'", 'rm -rf')).toBe(true);
  });

  // Fail-closed direction: parse B must never CANCEL parse A. Roughly a dozen
  // real wrapper flags are booleans (`sudo -n`, `-H`, `-E`, `time -p`, …); if
  // the value-taking reading replaced the boolean one instead of joining it,
  // every one of them would start swallowing the interpreter.
  it('keeps blocking when the unknown flag really is a boolean', () => {
    expect(commandMatchesBlocked("sudo -n bash -c 'rm -rf /'", 'rm -rf')).toBe(true);
  });

  // Over-block direction: the second reading must not invent an interpreter.
  // Here parse B swallows `grep` as `-n`'s operand and resolves the quoted
  // pattern itself as the verb — a non-interpreter, so the quoted argument
  // stays inert exactly as in parse A.
  it('does NOT over-block: a benign wrapped non-interpreter stays allowed', () => {
    expect(commandMatchesBlocked("sudo -n grep 'rm -rf' file", 'rm -rf')).toBe(false);
  });

  // Shape contract. `alt` must be OMITTED — not null, not undefined-valued —
  // when the segment is unambiguous, or every strict `toEqual` on a resolution
  // (e.g. the `time npm test` pin above) breaks on a key that carries no
  // information. And it must never nest: `alt.alt` would mean the second
  // reading was itself re-read, doubling the parse count per nesting level.
  it('reports the second reading as `alt` only when the readings disagree', () => {
    const ambiguous = resolve("env -Q /bin:/usr/bin bash -c 'rm -rf /etc'");
    expect(ambiguous.verb).toBe('bin'); // parse A unchanged — still primary
    expect(ambiguous.alt).toEqual({ verb: 'bash', index: 3, payloads: [], wrapperArgs: [] });
    expect('alt' in ambiguous.alt).toBe(false);

    const unambiguous = resolve('time npm test');
    expect('alt' in unambiguous).toBe(false);
  });
});

describe('extractRedirectTargets — wrapper targets across both readings (#1000)', () => {
  // Parse A reads `x` as the verb and never reaches `time -o`, so the file the
  // wrapper truncates was invisible to the redirect denylist — the #992 bypass
  // re-opened through an unknown flag instead of a missing table row.
  it('recovers a wrapper write target that only the value-taking reading sees', () => {
    expect(extractRedirectTargets('env -Q x /usr/bin/time -o CLAUDE.md npm test')).toEqual([
      { target: 'CLAUDE.md', mode: 'truncate', fd: null },
    ]);
  });

  // The mirror case, and the reason the two readings are UNIONED rather than
  // one replacing the other: here it is parse B that loses the operand
  // (`/usr/bin/time` is swallowed as `-n`'s value, so `-o` is never parsed as
  // time's flag) while parse A reports it.
  it('keeps a wrapper write target that only the boolean reading sees', () => {
    expect(extractRedirectTargets('sudo -n /usr/bin/time -o report.txt npm test')).toEqual([
      { target: 'report.txt', mode: 'truncate', fd: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// #1002 — the redirect operand-span rule, converged into one export
// ---------------------------------------------------------------------------

describe('redirectSpanEnd — one operand-span rule for all modes (#1002)', () => {
  // The rule ("a redirect owns its next operand word, except dup/heredoc") was
  // coded three times independently. These rows pin the MODE CLASSES, so a
  // regression in the shared implementation cannot silently diverge one copy:
  // a dup/heredoc that starts eating a word swallows the next real command,
  // and a herestring/truncate that stops eating one feeds its operand back
  // into the command surface as if it were an argument.
  it.each([
    ['dup owns nothing — its target is inline', 'cmd 2>&1 rest', 1, 1],
    ['heredoc owns nothing — its delimiter is syntax', 'cat <<EOF rm', 1, 1],
    ['herestring owns its word — inline data, not an rm operand', 'rm -rf /tmp/x <<< /etc/passwd', 3, 4],
    ['truncate owns its word', 'cmd > log', 1, 2],
    ['a dangling redirect owns nothing when the next token is a redirect', 'cmd > >> log', 1, 1],
  ])('%s', (_label, command, i, expected) => {
    expect(redirectSpanEnd(tokenizeCommand(command), i)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// #1000 dual-parse hardening REGRESSIONS — budget starvation + redirect union
// ---------------------------------------------------------------------------

describe('commandMatchesBlocked — budget-starvation deny-loss (HIGH-1)', () => {
  // The #1000 union added the alt reading's payloads to the SHARED 32-eval
  // budget: `env -Q x sh -c 'echo N'` resolves to the non-interpreter `x` in
  // parse A (zero payloads pre-#1000) but its parse-B `sh -c` reading now
  // charges ONE. An attacker prepends exactly 32 such inert fillers to exhaust
  // the budget, so the real deny-capable `env -S 'rm -rf …'` arrives after the
  // cut-off. Before the fix the exhausted cut-off was a silent `break` → the
  // matcher returned false → ALLOW. The fix makes it fail-VISIBLE: an unjudged
  // deny-capable payload is treated as a match. Falsification: restore the
  // `break` and this assertion flips to false (allow) — the self-inflicted
  // deny-loss the coordinator measured against 1be450a.
  it('denies a real payload starved behind 32 inert budget-filler segments', () => {
    const fillers = Array.from({ length: 32 }, () => "env -Q x sh -c 'echo hi'").join(' ; ');
    const attack = `${fillers} ; env -S 'rm -rf /tmp/victim'`;
    expect(commandMatchesBlocked(attack, 'rm -rf')).toBe(true);
  });

  // No-over-block guard. A realistic benign command is depth-bounded (payload
  // recursion caps at 3) and never approaches the 32-eval budget, so the
  // fail-visible cut-off never fires. This one carries the blocked string as
  // INERT data under a non-interpreter verb (fast-path passes, then each
  // segment is judged) plus a handful of benign `sh -c` payloads — well under
  // budget — and MUST still be allowed. If the fix over-reached (e.g. denied on
  // any pending payload rather than only on true exhaustion) this flips to true.
  it('still allows a benign under-budget command that mentions the pattern inertly', () => {
    const benign = "echo 'rm -rf placeholder' ; sh -c 'echo a' ; sh -c 'echo b' ; sh -c 'echo c'";
    expect(commandMatchesBlocked(benign, 'rm -rf')).toBe(false);
  });

  // A long benign command with NO blocked pattern is short-circuited by the
  // fast path and never enters the budgeted recursion — length alone is never a
  // reason to deny.
  it('allows a long benign command with no blocked pattern regardless of width', () => {
    const wide = Array.from({ length: 40 }, (_, i) => `sh -c 'echo ${i}'`).join(' ; ');
    expect(commandMatchesBlocked(wide, 'rm -rf')).toBe(false);
  });
});

describe('extractRedirectTargets — redirect union walks both readings (HIGH-2)', () => {
  // The payload recursion in collectRedirectTargets walked parse A only, so
  // `env -Q x bash -c 'echo pwned > CLAUDE.md'` — which resolves to the
  // non-interpreter `x` in parse A — never re-tokenized the `bash -c` payload
  // and the `> CLAUDE.md` truncate target came back as []. That is a redirect
  // denylist bypass onto protected artefacts (the policy file itself).
  // Falsification: revert the union back to `resolved.payloads` only and this
  // returns [] (bypass).
  it('recovers a redirect target hidden behind an ambiguous wrapper flag', () => {
    expect(extractRedirectTargets("env -Q x bash -c 'echo pwned > CLAUDE.md'")).toEqual([
      { target: 'CLAUDE.md', mode: 'truncate', fd: null },
    ]);
  });

  // Direction guard: the pre-existing wrapperArgs union (parse B recovers the
  // `time -o` operand) must not regress when the payload union is added.
  it('keeps a wrapperArgs write target that only the value-taking reading sees', () => {
    expect(extractRedirectTargets('env -Q x /usr/bin/time -o report.txt npm test')).toEqual([
      { target: 'report.txt', mode: 'truncate', fd: null },
    ]);
  });
});

describe('splitChainSegments — compound statements hid the command verb (#1145)', () => {
  /** Token texts of the first segment whose resolved verb is `want`, else null. */
  const headOf = (command, want) => {
    for (const seg of splitChainSegments(tokenizeCommand(command))) {
      if (resolveSegmentVerb(seg).verb === want) return seg.map((t) => t.text);
    }
    return null;
  };

  // THE BUG. `splitSegments` split on `; && || | & \n` but not on shell keywords,
  // so the first token of a `do …` / `then …` / `{ …` / `( …` statement was the
  // KEYWORD and never the command. Measured 2026-08-23 against the live
  // issue-budget guard (`max-per-session: 1, mode: strict`): the plain form
  // denied at 1/1 while `for … do glab issue create … done` and
  // `{ glab issue create …; }` were allowed with NO accounting at all — the cap
  // had never existed for the form actually typed for bulk creation.
  //
  // Asserted on the TOKEN HEAD, not only on the resolved verb: the vcs-create
  // matcher keys on `tokens.slice(0, 3)`, so a fix that moved only the verb
  // would leave that consumer exactly as blind as before.
  it.each([
    ['for-loop body', 'for t in a b c; do glab issue create --title $t; done'],
    ['brace group', '{ glab issue create --title d; }'],
    ['if/then branch', 'if true; then glab issue create --title e; fi'],
    ['else branch', 'if false; then true; else glab issue create --title e2; fi'],
    ['subshell', '( glab issue create --title f )'],
    ['while body', 'while read t; do glab issue create --title $t; done'],
  ])('exposes the create verb at the segment head — %s', (_label, command) => {
    const head = headOf(command, 'glab');
    expect(head).not.toBeNull();
    expect(head.slice(0, 3)).toEqual(['glab', 'issue', 'create']);
  });

  // Position gate. bash recognises a reserved word ONLY in command position;
  // everywhere else it is an ordinary argument. A blanket text filter would eat
  // it — silently deleting an rm operand named `do`, a `--title` value, or a
  // commit message word, which reaches consumers as a WRONG argument list
  // rather than as a parse failure.
  it('keeps a keyword that is an ARGUMENT, not a command-position reserved word', () => {
    const segs = splitChainSegments(tokenizeCommand('git commit -m do && echo then'));
    expect(segs.map((s) => s.map((t) => t.text))).toEqual([
      ['git', 'commit', '-m', 'do'],
      ['echo', 'then'],
    ]);
  });

  // Quoting gate, mirroring the vcs-create matcher's own `"glab issue create"`
  // precedent: `"do" glab issue create` runs a binary literally NAMED `do`. If
  // the drop ignored `quoted`, that segment's head would become
  // `glab issue create` and the issue-budget cap would count — and deny — a
  // command that creates no issue at all.
  it('does not drop a QUOTED keyword in command position', () => {
    const segs = splitChainSegments(tokenizeCommand('"do" glab issue create'));
    expect(segs).toHaveLength(1);
    expect(segs[0].map((t) => t.text)).toEqual(['do', 'glab', 'issue', 'create']);
  });

  // `exec cmd` REPLACES the shell with cmd — a transparent wrapper by the #982
  // classification, so it belongs in WRAPPER_UNWRAP. Without the row the verb
  // stays `exec` and every verb-keyed consumer is blind to the real command.
  it('unwraps `exec` to the real verb', () => {
    expect(resolveSegmentVerb(tokenizeCommand('exec glab issue create --title i')).verb)
      .toBe('glab');
  });

  // The OTHER half of that classification, and the reason `exec` is not in
  // SHELL_EXEC_INTERPRETERS: it execs an argv, it never executes a command
  // STRING. Listing it as an interpreter would turn this inert quoted literal
  // into a match — the exact wrapper-vs-interpreter error the #982 learning
  // names (`su` is an interpreter for the opposite reason).
  it('treats `exec` as a wrapper, not an interpreter — a quoted literal stays inert', () => {
    expect(commandMatchesBlocked('exec "rm -rf /etc"', 'rm -rf')).toBe(false);
  });
});

describe('splitChainSegments — destructive-guard direction (#1145)', () => {
  // STRICTER direction. `parseRmTargets` / `commandHasRecursiveForceRm` in
  // hooks/pre-bash-destructive-guard.mjs skip any segment whose verb is not
  // `rm`, so a loop-hidden `rm -rf` contributed NO operands at all: the guard
  // never judged the paths, it only fell back to its unparseable-command
  // fail-closed. Now the operands are visible and the path allowlist decides,
  // exactly as it does for the plain form.
  it.each([
    ['for-loop body', 'for f in a; do rm -rf /etc/passwd; done'],
    ['brace group', '{ rm -rf /etc/passwd; }'],
    ['if/then branch', 'if true; then rm -rf /etc/passwd; fi'],
    ['exec wrapper', 'exec rm -rf /etc/passwd'],
  ])('makes a compound-hidden rm and its operands visible — %s', (_label, command) => {
    const rmSegs = splitChainSegments(tokenizeCommand(command))
      .filter((s) => resolveSegmentVerb(s).verb === 'rm');
    expect(rmSegs).toHaveLength(1);
    const { index } = resolveSegmentVerb(rmSegs[0]);
    expect(rmSegs[0].slice(index + 1).map((t) => t.text)).toEqual(['-rf', '/etc/passwd']);
  });

  // NO-LOSS direction — the load-bearing half. Dropping a token REMOVES it from
  // the skeleton `unquotedSegmentMatch` tests, so a blocked pattern that used to
  // match across the keyword would silently stop matching and the rule would
  // never fire at all. Verified against every pattern class in
  // .orchestrator/policy/blocked-commands.json that a compound form can carry.
  it.each([
    ['rm -rf', 'for f in a; do rm -rf /etc/passwd; done'],
    ['rm -rf', '{ rm -rf /etc/passwd; }'],
    ['rm -rf', '( rm -rf /etc/passwd )'],
    ['rm -rf', 'while read x; do rm -rf /etc/passwd; done'],
    ['git push --force', 'for b in main; do git push --force; done'],
    ['git reset --hard', '{ git reset --hard; }'],
    ['git clean -fd', 'if true; then git clean -fd; fi'],
    ['git checkout --', 'for f in a; do git checkout -- src/; done'],
    ['git stash', '{ git stash; }'],
  ])('still matches %s inside a compound statement', (pattern, command) => {
    expect(commandMatchesBlocked(command, pattern)).toBe(true);
  });

  // Deliberately NOT in the no-loss table above: the fake-regression run showed
  // this row going RED with the keyword drop disabled, i.e. it was never a
  // preserved match — it is a NEWLY caught one, and the fix is what catches it.
  // The quoted-payload guard only fires when the segment VERB is an interpreter;
  // with the head token stuck at `then`, `psql` never reached verb position and
  // the SQL rules had no reach into any compound statement at all.
  // (`eine Fake-Regression beweist nichts, wenn die Mutation die benannte
  // Verteidigung verfehlt` — the mutation bit, so the name had to change.)
  it('newly reaches an interpreter payload hidden in a compound statement', () => {
    expect(commandMatchesBlocked('if true; then psql -c "DROP TABLE users"; fi', 'DROP TABLE'))
      .toBe(true);
  });

  // Direction guard for the false-positive side: a keyword-looking word inside
  // QUOTED data is not a command, and stripping must not have turned it into
  // one. `echo "… rm -rf …"` was allowed before and must stay allowed.
  it('keeps an inert quoted destructive literal inert', () => {
    expect(commandMatchesBlocked('echo "rm -rf /etc"; echo done', 'rm -rf')).toBe(false);
  });
});
