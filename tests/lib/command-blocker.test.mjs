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
