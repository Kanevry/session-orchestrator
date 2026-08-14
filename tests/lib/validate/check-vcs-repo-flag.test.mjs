/**
 * tests/lib/validate/check-vcs-repo-flag.test.mjs
 *
 * Tests for scripts/lib/validate/check-vcs-repo-flag.mjs (issue #971).
 *
 * The bug every case names is ONE bug in its variants: "a `gh`/`glab` call
 * resolves its target project from the ambient cwd remote instead of
 * `--repo`/`-R`, so it silently operates on the WRONG repository, and nothing
 * notices." The negative cases name the mirror bug: "the detector reports a
 * subcommand where `--repo` does not exist, or reports prose, and the resulting
 * noise gets the check switched off."
 *
 * Every fixture is synthetic and lives in $TMPDIR. The one test that touches the
 * real repo is read-only and asserts a floor/ceiling, never a pinned count
 * (`testing.md` § Dynamic Artifact Counts).
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { inspectVcsRepoFlag, runCheckVcsRepoFlag } from '@lib/validate/check-vcs-repo-flag.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-vcs-repo-flag.mjs');

/**
 * Build a throwaway plugin root containing the given relative files.
 *
 * @param {Record<string, string>} files relative path → content
 * @returns {string} absolute temp root
 */
function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'vcs-repo-flag-'));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
  }
  return root;
}

/** @param {string} body @returns {string} a bash fence wrapping `body` */
function bash(body) {
  return ['```bash', body, '```', ''].join('\n');
}

/**
 * Inspect a synthetic root and clean it up.
 *
 * @param {Record<string, string>} files
 * @returns {ReturnType<typeof inspectVcsRepoFlag>}
 */
function inspectFixture(files) {
  const root = makeRoot(files);
  try {
    return inspectVcsRepoFlag(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Positive detection ──────────────────────────────────────────────────────

describe('#971 — bare gh/glab invocations are reported', () => {
  // Bug: `glab issue list` in a runbook fence lists the issues of whatever repo
  // the coordinator's cwd happens to point at — a sibling worktree, an autopilot
  // child, a consumer repo. Nothing today notices the missing -R.
  it('reports a bare glab command inside a bash fence', () => {
    const result = inspectFixture({ 'skills/x/SKILL.md': bash('glab issue list --per-page 5') });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      kind: 'missing-repo-flag-doc',
      file: 'skills/x/SKILL.md',
      line: 2,
      cli: 'glab',
      command: 'glab issue list',
    });
    expect(result.ok).toBe(false);
  });

  // Bug: the gh half of the same defect — a GitHub-mirror runbook that opens a
  // PR against whatever `origin` resolves to.
  it('reports a bare gh command and names the subcommand pair', () => {
    const result = inspectFixture({ 'docs/a.md': bash('gh pr create --fill --draft') });
    expect(result.findings.map((f) => f.command)).toEqual(['gh pr create']);
  });

  // Bug: a multi-line command puts `-R` two lines below the CLI token, so a
  // line-at-a-time scanner both MISSES the flag (phantom finding) and mis-reads
  // the continuation line as its own command.
  it('joins \\-continuation lines before judging the flag', () => {
    const withFlag = inspectFixture({
      'docs/a.md': bash('glab issue create \\\n  --title "t" \\\n  -R group/project'),
    });
    expect(withFlag.findings).toEqual([]);
    expect(withFlag.summary.withFlag).toBe(1);

    const withoutFlag = inspectFixture({
      'docs/a.md': bash('glab issue create \\\n  --title "t" \\\n  --label bug'),
    });
    expect(withoutFlag.findings).toHaveLength(1);
    expect(withoutFlag.findings[0].line).toBe(2);
  });

  // Bug: `glab repo view` accepts -R (persistent root flag) while `gh repo view`
  // hard-rejects it — treating the two `repo` groups alike either loses a real
  // finding or manufactures an impossible one. Probed 2026-08-14 against
  // glab 1.91.0 / gh 2.86.0.
  it('reports glab repo view without -R but never gh repo view', () => {
    const result = inspectFixture({
      'docs/a.md': bash('glab repo view --output json\ngh repo view --json name'),
    });
    expect(result.findings.map((f) => f.command)).toEqual(['glab repo view']);
    expect(result.summary.notApplicable).toBe(1);
  });

  // Bug: a shell command handed to tmux/sh as a string literal is a real call
  // site, and it is invisible to every markdown-only scan.
  it('reports a shell command carried in a JS string literal', () => {
    const result = inspectFixture({
      'scripts/x.mjs': [
        'export const panes = [',
        "  '  glab ci status --output json 2>&1',",
        '];',
      ].join('\n'),
    });
    expect(result.findings).toMatchObject([
      { kind: 'missing-repo-flag-code', file: 'scripts/x.mjs', line: 2, command: 'glab ci status' },
    ]);
  });

  // Bug: a literal argv array is the production call shape; a line-grep for
  // `glab issue` never sees `['issue', 'list']`.
  it('reports a literal execFileSync argv array without --repo', () => {
    const result = inspectFixture({
      'scripts/x.mjs': "const r = spawnSync('glab', ['issue', 'list', '--per-page', '5']);\n",
    });
    expect(result.findings).toMatchObject([
      { kind: 'missing-repo-flag-code', command: 'glab issue list' },
    ]);
  });
});

// ─── Negative cases (the noise that would get the check switched off) ────────

describe('#971 — non-defects are not reported', () => {
  // Bug: `gh api` / `glab api` have no --repo at all (both document --hostname
  // instead). Reporting them makes 35 of the repo's matches pure noise.
  it('never reports gh api or glab api', () => {
    const result = inspectFixture({
      'docs/a.md': bash('gh api repos/o/r/issues\nglab api /projects/12/issues'),
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.notApplicable).toBe(2);
  });

  // Bug: auth/config are host- and client-scoped; `gh auth status -R x` errors
  // with "unknown shorthand flag: 'R'" (probed 2026-08-14).
  it('never reports auth/config subcommands', () => {
    const result = inspectFixture({
      'docs/a.md': bash('gh auth status\nglab auth status\ngh config list\nglab config get editor'),
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.notApplicable).toBe(4);
  });

  // Bug: 19 of 100 markdown matches in this repo are table cells, bullets and
  // running text. A fence-blind scanner is more than half noise.
  it('treats a prose line with no fence as prose', () => {
    const result = inspectFixture({
      'docs/a.md': 'Run `glab issue list` to see the backlog, then glab issue view 12.\n',
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.applicable).toBe(0);
  });

  // Bug: a non-shell fence is documentation of data, not a command.
  it('treats a non-shell fence as prose', () => {
    const result = inspectFixture({
      'docs/a.md': ['```js', "const cmd = 'glab issue list';", '```', ''].join('\n'),
    });
    expect(result.findings).toEqual([]);
  });

  // Bug: a `#` line inside a bash fence is a comment explaining the command
  // below it, not a second command.
  it('treats a shell comment inside a shell fence as prose', () => {
    const result = inspectFixture({
      'docs/a.md': bash('# glab issue list  <- do not do this\nglab issue list -R g/p'),
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.applicable).toBe(1);
    expect(result.summary.withFlag).toBe(1);
  });

  // Bug: a log-message template names a command it is REPORTING on. Four such
  // lines exist in scripts/; reporting them is a false accusation.
  it('treats an interpolated JS message template as prose', () => {
    const result = inspectFixture({
      'scripts/x.mjs': 'log(`glab issue list failed: ${err.message}`);\n',
    });
    expect(result.findings).toEqual([]);
  });

  // Bug: a JSDoc/line comment naming a command is documentation. 32 of 38
  // matches under scripts/+hooks/ are exactly this.
  it('treats a JS comment line as prose', () => {
    const result = inspectFixture({
      'scripts/x.mjs': ' * Runs `glab mr create --fill` for the caller.\n// glab issue list\n',
    });
    expect(result.findings).toEqual([]);
  });

  // Bug: `glab repo view group/project` already names its target; demanding -R
  // on top of an explicit positional is a false positive.
  it('accepts an explicit positional repo argument for glab repo', () => {
    const result = inspectFixture({ 'docs/a.md': bash('glab repo view group/project') });
    expect(result.findings).toEqual([]);
    expect(result.summary.explicitPositional).toBe(1);
  });

  // Bug: `glab exited`, `glab or gh`, `glab not found` are English sentences
  // that survive the fence filter when they sit in a fenced example block.
  it('drops a fenced line whose next token is not a real subcommand', () => {
    const result = inspectFixture({ 'docs/a.md': bash('glab exited with status 1') });
    expect(result.findings).toEqual([]);
    expect(result.summary.unknownSubcommand).toBe(1);
  });

  // Bug: `--repo=g/p` and `-R "$SPEC"` are the same fix in different spellings;
  // a naive ` -R ` substring test misses both.
  it('accepts --repo=, -R "$SPEC" and long --repo spellings', () => {
    const result = inspectFixture({
      'docs/a.md': bash(
        'glab issue list --repo=group/project\n' +
          'gh issue list -R "$SPEC"\n' +
          'glab mr list --repo group/project',
      ),
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.withFlag).toBe(3);
  });

  // Bug: a variable argv array cannot be judged from the call site — guessing
  // either way is wrong. It must be counted, not reported.
  it('counts a variable argv array as unresolved rather than reporting it', () => {
    const result = inspectFixture({
      'scripts/x.mjs': "const r = spawnSync('glab', glabArgs, { encoding: 'utf8' });\n",
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.unresolvedArgv).toBe(1);
  });

  // Bug: `gh pr checks -R o/r` with no positional is REJECTED by gh 2.86.0
  // ("argument required when using the `--repo` flag", probed 2026-08-14 from a
  // cwd with no git remote). Reporting the bare form tells a sweep to apply a
  // "fix" that breaks the call at runtime — and the tmux CI pane it hits must
  // stay positional-free to follow the operator's current branch. A rule derived
  // from `gh pr checks --help` would get this backwards: it lists `-R, --repo`
  // under INHERITED FLAGS with no caveat.
  it('never reports gh pr checks when no positional is present', () => {
    const result = inspectFixture({
      'scripts/x.mjs': "const pane = '  gh pr checks --watch 2>&1';\n",
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.positionalRequired).toBe(1);
    expect(result.summary.applicable).toBe(1);
  });

  // Bug: the mirror error — suppressing the whole subcommand instead of the
  // positional-free form. `gh pr checks 123` and `gh pr view 4711` DO accept -R
  // (measured: `gh pr checks -R cli/cli trunk` reaches the API and answers "no
  // pull requests found for branch"), so a bare one is a real finding. A
  // subcommand-blanket D-NA entry would lose it silently.
  it('still reports gh pr checks and gh pr view when a positional IS present', () => {
    const result = inspectFixture({ 'docs/a.md': bash('gh pr checks 123\ngh pr view 4711') });
    expect(result.findings.map((f) => f.command)).toEqual(['gh pr checks', 'gh pr view']);
    expect(result.findings.map((f) => f.message.includes('123') || f.message.includes('4711'))).toEqual([true, true]);
    expect(result.summary.positionalRequired).toBe(0);
  });

  // Bug: the positional can sit BEHIND the flag's own argument
  // (`gh pr merge -R o/r 123` puts it at token 4). A rule that only inspects the
  // slot right after the subcommand reads that as "no positional" and reclassifies
  // an already-correct call — which is how `withFlag` silently dropped 65 → 64 on
  // the first draft of this rule.
  it('leaves gh pr merge -R o/r 123 counted as withFlag, not positional-required', () => {
    const result = inspectFixture({ 'docs/a.md': bash('gh pr merge -R owner/repo 123') });
    expect(result.findings).toEqual([]);
    expect(result.summary.withFlag).toBe(1);
    expect(result.summary.positionalRequired).toBe(0);
  });

  // Bug: `2>&1` is a redirect, not a PR number. Reading it as a positional would
  // both disarm the rule above for `gh pr checks 2>&1` and manufacture a phantom
  // `explicitPositional` for `glab repo view 2>&1`.
  it('does not mistake a shell redirect for a positional argument', () => {
    const result = inspectFixture({
      'docs/a.md': bash('gh pr checks 2>&1\nglab repo view 2>&1'),
    });
    expect(result.summary.positionalRequired).toBe(1);
    expect(result.summary.explicitPositional).toBe(0);
    expect(result.findings.map((f) => f.command)).toEqual(['glab repo view']);
  });

  // Bug: tests/ holds command strings as ASSERTION DATA; scanning them adds 42
  // matches of pure noise to a sweep worklist.
  it('excludes tests/ from the corpus', () => {
    const result = inspectFixture({
      'scripts/tests/x.mjs': "run('  glab issue list');\n",
      'docs/a.md': bash('glab issue list'),
    });
    expect(result.findings.map((f) => f.file)).toEqual(['docs/a.md']);
  });
});

// ─── Command substitution: whose -R is it ────────────────────────────────────

describe('#971 — a -R inside a command substitution belongs to the inner command', () => {
  // Bug: the flag test ran against the WHOLE segment, so `grep -R` inside a
  // substitution (equally `cp -R`, `ls -R`, `rsync -R`, `chmod -R`) was credited
  // to the outer call. Measured pre-fix:
  //   extractBareInvocations('glab issue list $(grep -R pattern src)')
  //     → findings 0, withFlag 1
  // Every other gap this check names merely OMITS a call site. This one is the
  // opposite direction: it reports a BARE invocation as already hardened — and
  // the `0 bare` that produces is the number a sweep declares itself done on.
  it('reports a bare call whose only -R belongs to a grep inside $( )', () => {
    const result = inspectFixture({ 'docs/a.md': bash('glab issue list $(grep -R pattern src)') });
    expect(result.findings.map((f) => f.command)).toEqual(['glab issue list']);
    expect(result.summary.withFlag).toBe(0);
    expect(result.summary.applicable).toBe(1);
  });

  // Bug: the mirror error — reacting to `$(` as such. A substitution is a
  // perfectly ordinary way to COMPUTE the repo spec, and the `-R` that consumes
  // it sits outside the parens. Suppressing this call would delete a correct
  // call site from `withFlag` and, worse, teach the fix "never use $( ) near -R".
  it('still counts -R $(cat repo.txt) as a real repo flag', () => {
    const result = inspectFixture({ 'docs/a.md': bash('glab issue list -R $(cat repo.txt)') });
    expect(result.findings).toEqual([]);
    expect(result.summary.withFlag).toBe(1);
  });

  // Bug: backticks are the older spelling of the same substitution. A fix that
  // only knows `$(` leaves `` `grep -R x src` `` crediting its -R to the outer
  // call — the identical false "already hardened" verdict.
  it('treats a backtick substitution as an inner command too', () => {
    const bare = inspectFixture({ 'docs/a.md': bash('glab issue list `grep -R x src`') });
    expect(bare.findings.map((f) => f.command)).toEqual(['glab issue list']);
    expect(bare.summary.withFlag).toBe(0);

    const flagged = inspectFixture({ 'docs/a.md': bash('glab issue list `git rev-parse HEAD` -R g/p') });
    expect(flagged.findings).toEqual([]);
    expect(flagged.summary.withFlag).toBe(1);
  });

  // Bug: a BOOLEAN "inside a substitution" flag returns to depth 0 at the inner
  // `)`, so the tail of a nested substitution reads as the outer command's argv
  // again — and a `-R` sitting there would be miscredited exactly as before.
  // Depth must be a counter.
  it('keeps nested substitutions inner all the way out', () => {
    const result = inspectFixture({
      'docs/a.md': bash('glab issue list $(ls -R $(find . -name x)) --per-page 5'),
    });
    expect(result.findings.map((f) => f.command)).toEqual(['glab issue list']);
    expect(result.summary.withFlag).toBe(0);
  });

  // Bug: `${VAR}` is parameter expansion, not command substitution — no inner
  // command exists to own a flag. Treating `${` as an opener (it shares the `$`)
  // would swallow the rest of the line, hiding a real trailing -R and turning a
  // correct call site into a phantom finding.
  it('does not treat ${VAR} expansion as a substitution', () => {
    const flagged = inspectFixture({ 'docs/a.md': bash('glab issue list ${EXTRA_FLAGS} -R g/p') });
    expect(flagged.findings).toEqual([]);
    expect(flagged.summary.withFlag).toBe(1);

    const bare = inspectFixture({ 'docs/a.md': bash('glab mr list ${EXTRA_FLAGS}') });
    expect(bare.findings.map((f) => f.command)).toEqual(['glab mr list']);
    expect(bare.summary.withFlag).toBe(0);
  });

  // Bug: the other half of the same root cause — the segment used to stop at the
  // FIRST `)`, including the one that merely closes a substitution. Everything
  // past it, the real `-R` among it, was invisible, so an already-correct call
  // site was reported and the sweep would have "fixed" a flag that was there.
  it('reads a -R that follows a substitution instead of stopping at its )', () => {
    const result = inspectFixture({
      'docs/a.md': bash('glab issue create --title "$(date -u +%F)" -R group/project'),
    });
    expect(result.findings).toEqual([]);
    expect(result.summary.withFlag).toBe(1);
  });

  // Bug: making `)` non-terminal inside a substitution must not make it — or the
  // separators around it — non-terminal at depth 0. If the walk kept consuming
  // past the `;`, the second command would be swallowed into the first's segment
  // and never censused at all.
  it('still ends the command at a depth-0 separator after a substitution', () => {
    const result = inspectFixture({
      'docs/a.md': bash('glab issue list $(grep -R p src) ; gh pr create --fill'),
    });
    expect(result.findings.map((f) => f.command)).toEqual(['glab issue list', 'gh pr create']);
    expect(result.summary.applicable).toBe(2);
    expect(result.summary.withFlag).toBe(0);
  });
});

// ─── Fake-regression proof (the guard actually bites) ────────────────────────

describe('#971 — fake-regression: the guard flips on the defect', () => {
  // A green run is not evidence a guard bites. Same file, one edit apart:
  // WITHOUT -R it must warn, WITH -R the warning must disappear.
  it('warns on a bare glab issue list and goes silent once -R is added', () => {
    const before = inspectFixture({ 'docs/fake.md': bash('glab issue list') });
    expect(before.findings).toHaveLength(1);
    expect(before.findings[0].command).toBe('glab issue list');

    const after = inspectFixture({ 'docs/fake.md': bash('glab issue list -R foo/bar') });
    expect(after.findings).toEqual([]);
    expect(after.summary.withFlag).toBe(1);
  });
});

// ─── Runner + CLI contract ───────────────────────────────────────────────────

describe('#971 — WARN-only contract', () => {
  // Bug: validate-plugin.mjs tallies `^[ ]{2}FAIL:` from EVERY sub-check into a
  // module-wide counter and exits 1 on it — the sub-check's own exit code is
  // discarded. One FAIL: line here would red the whole validator plus three
  // CI-reachable test files. Findings must therefore print as WARN only.
  it('prints findings as two-space WARN lines and exactly one PASS, never FAIL', () => {
    const root = makeRoot({ 'docs/a.md': bash('glab issue list\ngh pr create --fill') });
    const printed = [];
    const original = console.log;
    console.log = (...args) => printed.push(args.join(' '));
    let code;
    try {
      code = runCheckVcsRepoFlag(root);
    } finally {
      console.log = original;
      rmSync(root, { recursive: true, force: true });
    }
    const output = printed.join('\n');
    expect(code).toBe(0);
    expect(output.match(/^ {2}WARN:/gm)).toHaveLength(2);
    expect(output.match(/^ {2}PASS:/gm)).toHaveLength(1);
    expect(output.match(/^ {2}FAIL:/gm)).toBeNull();
    expect(output).toContain('Results: 1 passed, 0 failed');
  });

  // Bug: a WARN-only check that exits non-zero on findings would still be
  // ignored by validate-plugin, but any direct caller (a hook, a CI job) would
  // read it as a hard failure. Exit 0 WITH findings present is the contract.
  it('exits 0 via the CLI even though the fixture has findings', () => {
    const root = makeRoot({ 'docs/a.md': bash('glab issue list') });
    try {
      const r = spawnSync('node', [SCRIPT, root], { encoding: 'utf8' });
      expect(r.stdout).toMatch(/^ {2}WARN: \[missing-repo-flag-doc]/m);
      expect(r.status).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Bug: an unrecognised flag that silently succeeds hides a typo'd invocation
  // in a CI script (cli-design.md exit-code contract).
  it('exits 1 on an unknown flag and 0 on --help', () => {
    const bogus = spawnSync('node', [SCRIPT, '--bogus'], { encoding: 'utf8' });
    expect(bogus.status).toBe(1);
    expect(bogus.stderr).toContain('Unknown flag(s): --bogus');

    const help = spawnSync('node', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('--json');
  });

  // Bug: `--json` piped into jq is the machine path; a non-JSON preamble or a
  // truncated envelope makes it unparseable.
  it('emits a single parseable JSON envelope under --json', () => {
    const root = makeRoot({ 'docs/a.md': bash('glab issue list') });
    try {
      const r = spawnSync('node', [SCRIPT, root, '--json'], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.toolError).toBe(false);
      expect(parsed.findings).toHaveLength(1);
      expect(parsed.summary.findings).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── Grounding against the real repo (floor/ceiling, never a pinned count) ───

describe('#971 — grounding against this repository', () => {
  const live = inspectVcsRepoFlag(REPO_ROOT);

  // Bug: a detector that scans the real tree and finds nothing — a corpus walk
  // that enumerates no files, a command regex that never fires, a flag branch
  // that never matches — reads exactly like a clean repo. Something must prove
  // the machine ran.
  //
  // `findings.length` is the WRONG size to prove it with, and the floor that
  // used to sit here (>= 20) was the inversion of `testing.md` § "Dynamic
  // Artifact Counts": that carve-out floors an artifact set that GROWS, so the
  // floor catches accidental deletion. `findings` is a DEFECT BACKLOG built in
  // the same session as the sweep that drains it — 0 is the target state, not a
  // broken detector. A floor there goes red on success and would have to be
  // lowered every time the sweep worked, which trains exactly the reflex that
  // makes a guard worthless.
  //
  // The three counters below survive a fully-swept codebase because a sweep
  // MOVES invocations between the classifier's exits, it does not remove them:
  // a fixed call site stays `applicable` and becomes `withFlag`. Each one dies
  // at a different defect — `filesScanned` at a dead walker, `withFlag` at a
  // dead REPO_FLAG_RE (findings would then absorb all 65, leaving every
  // count-based floor green), `applicable === <its four exits>` at a
  // classification leak where a newly added branch silently swallows a call
  // instead of routing it. The ceiling on `findings` stays: it is a runaway
  // guard against a regex that matches everything, and a ceiling is safe in the
  // direction this number actually moves.
  it('stays grounded in the real tree: walker, classifier and flag branch all fire', () => {
    expect(live.toolError).toBe(false);
    expect(live.summary.filesScanned).toBeGreaterThanOrEqual(200);
    expect(live.summary.withFlag).toBeGreaterThanOrEqual(20);
    expect(live.summary.applicable).toBe(
      live.summary.withFlag +
        live.summary.explicitPositional +
        live.summary.positionalRequired +
        live.findings.length,
    );
    expect(live.findings.length).toBeLessThanOrEqual(300);
  });

  // Bug: the D-NA table silently emptying (a typo in the key names) would flood
  // the sweep worklist with `gh api` calls that cannot take --repo.
  it('classifies a non-zero share of real matches as not-applicable', () => {
    expect(live.summary.notApplicable).toBeGreaterThanOrEqual(5);
    expect(live.summary.notApplicable).toBeLessThanOrEqual(200);
  });

  // Bug: findings must be addressable — a sweep cannot act on `file:0` or on an
  // absolute path that differs per machine.
  it('reports every finding with a repo-relative path and a 1-based line', () => {
    for (const finding of live.findings) {
      expect(finding.file.startsWith('/')).toBe(false);
      expect(finding.line).toBeGreaterThanOrEqual(1);
      expect(['missing-repo-flag-doc', 'missing-repo-flag-code']).toContain(finding.kind);
    }
  });
});
