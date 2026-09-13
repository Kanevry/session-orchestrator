/**
 * tests/hooks/vcs-create-matcher.test.mjs
 *
 * Unit tests for hooks/_lib/vcs-create-matcher.mjs — the shared `gh`/`glab`
 * create matcher both PreToolUse Bash hooks (issue-budget, templates-first)
 * consume.
 *
 * WHY A SECOND FILE (TV-004). tests/unit/hook-issue-budget.test.mjs already
 * imports the matcher, but every case there is scoped to what the ISSUE-BUDGET
 * hook does with it. The matcher is shared, and its widening in #1145 changes
 * templates-first too; the widening/narrowing contract therefore needs a home
 * that is not named after one of its two consumers. The e2e accounting
 * assertions stay in the hook file — they are a different question.
 *
 * THE BUG THESE CATCH (#1145, TV-001). Until #1145 the matcher read a
 * statement's head as raw `tokens.slice(0, 3)`, so any statement whose FIRST
 * token is not literally `gh`/`glab` was invisible even when the shell would
 * run exactly that binary. Measured against the pre-fix file:
 *
 *     nohup glab issue create --title g      → isIssueCreate false
 *     /opt/homebrew/bin/glab issue create …  → isIssueCreate false
 *     GITLAB_HOST=y glab issue create …      → isIssueCreate false
 *
 * Each of those files a real issue against a cap that never sees it. The fix
 * reads the head at the index `resolveSegmentVerb` resolves.
 */

import { describe, it, expect } from 'vitest';

import {
  matchVcsCreate,
  isIssueCreate,
  isLoopedIssueCreate,
  extractTitle,
  findIssueCreateStatements,
  matchesBypass,
  statementsCoverWholeCommand,
} from '../../hooks/_lib/vcs-create-matcher.mjs';
import { tokenizeCommand, splitChainSegments } from '@lib/command-blocker.mjs';

describe('vcs-create-matcher — verb resolution (#1145)', () => {
  // The four widened shapes. Each was measured false before the fix; each
  // creates a real issue when run.
  it('sees a create whose statement head is not the CLI name', () => {
    expect(isIssueCreate('nohup glab issue create --title g')).toBe(true);
    expect(isIssueCreate('command glab issue create --title g')).toBe(true);
    expect(isIssueCreate('/opt/homebrew/bin/glab issue create --title h')).toBe(true);
    expect(isIssueCreate('GITLAB_HOST=y glab issue create --title i')).toBe(true);
    expect(isIssueCreate('sudo -u ci gh issue create --title j')).toBe(true);
  });

  it('reports the resolved shape, not a wrapper-shifted one', () => {
    expect(matchVcsCreate('nohup gh pr create --title x')).toEqual({
      host: 'github', kind: 'pr', verb: 'create',
    });
    expect(matchVcsCreate('/usr/local/bin/glab mr new --title x')).toEqual({
      host: 'gitlab', kind: 'mr', verb: 'new',
    });
  });

  // A wrapper must not shift the KIND read either: `nohup glab mr create` is
  // still an MR and must stay out of the issue cap. Without the head being read
  // at the resolved index, `tokens.slice(0,3)` here is `nohup glab mr` — which
  // matches nothing, so the pre-fix code got the right answer for the wrong
  // reason and would have started counting MRs the moment it was widened naively.
  it('a wrapped create keeps its kind — mr/pr stay out of the issue cap', () => {
    expect(isIssueCreate('nohup glab mr create --title x')).toBe(false);
    expect(isIssueCreate('/opt/homebrew/bin/gh pr create --title x')).toBe(false);
  });

  it('the compound-statement shapes L2 unblocked stay matched end-to-end', () => {
    expect(isIssueCreate('for t in a b c; do glab issue create --title "$t"; done')).toBe(true);
    expect(isIssueCreate('{ glab issue create --title d; }')).toBe(true);
    expect(isIssueCreate('if true; then glab issue create --title e; fi')).toBe(true);
    expect(isIssueCreate('( glab issue create --title f )')).toBe(true);
  });
});

describe('vcs-create-matcher — the narrowing that pairs with the widening (#1145)', () => {
  // `--help` short-circuits a cobra command, so `glab issue create --help` —
  // the exact call an agent makes to discover the flag names BEFORE filing —
  // creates nothing. It was counted; at the cap boundary that denies the next
  // REAL issue on the strength of a help screen.
  it('a create statement carrying --help creates nothing and is not matched', () => {
    expect(isIssueCreate('glab issue create --help')).toBe(false);
    expect(isIssueCreate('gh issue create --title x --help')).toBe(false);
    expect(matchVcsCreate('gh pr create --help')).toBeNull();
    expect(isIssueCreate('nohup glab issue create --help')).toBe(false);
  });

  // The narrowing must be a FLAG check, not a substring one: a title that
  // mentions --help is a real creation.
  it('--help inside a quoted value is data, not the help flag', () => {
    expect(isIssueCreate('glab issue create --title "document --help output"')).toBe(true);
    expect(isIssueCreate("glab issue create --title 'fix --help crash'")).toBe(true);
  });

  // The pre-#1145 near-misses must stay near-misses: widening the head read
  // must not start matching non-creating or data-only commands.
  it('near-miss commands are still not creates', () => {
    expect(isIssueCreate('glab issue list')).toBe(false);
    expect(isIssueCreate('glab issue note 5 -m x')).toBe(false);
    expect(isIssueCreate('gh issue edit 12 --add-label x')).toBe(false);
    expect(isIssueCreate('glab issue created')).toBe(false);
    expect(isIssueCreate('echo "glab issue create"')).toBe(false);
    expect(isIssueCreate('grep -rn "glab issue create" docs/')).toBe(false);
    expect(isIssueCreate('# glab issue create')).toBe(false);
    // ONE token containing all three words runs a binary of that literal name.
    // Verb resolution basename-normalises, so this is the reading that could
    // have regressed: the whitespace guard is what keeps it out.
    expect(isIssueCreate('"glab issue create" --title x')).toBe(false);
    expect(isIssueCreate('"/usr/bin/glab issue create" --title x')).toBe(false);
  });

  // Named ceiling, pinned so a future reader sees it is a decision, not a gap.
  it('a paren glued to the verb is the inherited lexer ceiling, still unmatched', () => {
    expect(isIssueCreate('(glab issue create --title f)')).toBe(false);
  });
});

describe('vcs-create-matcher — loop multiplicity fact (#1145)', () => {
  // The bug: `for t in a b c; do glab issue create; done` is ONE statement that
  // files THREE issues. Charging it 1 leaves the cap nominally armed and
  // actually uncapped. isLoopedIssueCreate reports the FACT; the hook decides.
  it('reports a create inside a loop body', () => {
    expect(isLoopedIssueCreate('for t in a b c; do glab issue create --title "$t"; done')).toBe(true);
    expect(isLoopedIssueCreate('while read t; do glab issue create --title "$t"; done < list')).toBe(true);
    expect(isLoopedIssueCreate('until done_flag; do glab issue create --title x; done')).toBe(true);
    expect(isLoopedIssueCreate('for a in 1; do for b in 2; do glab issue create --title x; done; done')).toBe(true);
  });

  // Depth-counting, not mere presence. Without it, a create AFTER a finished
  // loop would be denied — a usability regression on a command that files
  // exactly one issue.
  it('a create AFTER the loop closes is not implicated', () => {
    expect(isLoopedIssueCreate('while true; do echo a; done; glab issue create --title z')).toBe(false);
    expect(isLoopedIssueCreate('for f in *; do echo "$f"; done && glab issue create --title z')).toBe(false);
  });

  it('non-loop compound forms are single creates', () => {
    expect(isLoopedIssueCreate('{ glab issue create --title d; }')).toBe(false);
    expect(isLoopedIssueCreate('if true; then glab issue create --title e; fi')).toBe(false);
    expect(isLoopedIssueCreate('glab issue create --title a')).toBe(false);
    expect(isLoopedIssueCreate('glab issue create --title a && glab issue create --title b')).toBe(false);
  });

  // `do`/`done` are ordinary WORDS outside command position. A text-only scan
  // would deny both of these, each of which files exactly one issue.
  it('do/done as ordinary arguments are not a loop', () => {
    expect(isLoopedIssueCreate('echo do && glab issue create --title q')).toBe(false);
    expect(isLoopedIssueCreate('glab issue create --title done')).toBe(false);
    expect(isLoopedIssueCreate('glab issue create --title "do the thing" --label done')).toBe(false);
  });

  it('is false when the command has no issue-create statement at all', () => {
    expect(isLoopedIssueCreate('for t in a b; do echo "$t"; done')).toBe(false);
    expect(isLoopedIssueCreate('for t in a b; do glab mr create --title "$t"; done')).toBe(false);
    expect(isLoopedIssueCreate('')).toBe(false);
    expect(isLoopedIssueCreate(null)).toBe(false);
  });

  // NAMED-CEILING CANARY. isLoopedIssueCreate infers "command position" from
  // the fact that command-blocker.mjs's splitter DROPS `do`/`done` there. If
  // either is ever removed from COMMAND_POSITION_KEYWORDS, the token stops
  // disappearing, loop detection silently returns false, and a bulk create is
  // charged 1 again — with no test failing anywhere near the change. This
  // asserts the coupling at its source so that edit fails HERE.
  it('the lexer still drops do/done in command position (coupling canary)', () => {
    const cmd = 'for t in a b; do glab issue create --title "$t"; done';
    const raw = tokenizeCommand(cmd).filter((t) => !t.quoted).map((t) => t.text);
    const kept = splitChainSegments(tokenizeCommand(cmd)).flat().map((t) => t.text);
    expect(raw).toContain('do');
    expect(raw).toContain('done');
    expect(kept).not.toContain('do');
    expect(kept).not.toContain('done');
  });
});

describe('vcs-create-matcher — unchanged surfaces after the widening', () => {
  it('extractTitle still reads the title off the create statement', () => {
    expect(extractTitle('nohup glab issue create --title "real"')).toBe('real');
    expect(extractTitle('cd /r && glab issue create --title=short')).toBe('short');
    expect(extractTitle('glab issue list --search "--title decoy"; glab issue create --title real'))
      .toBe('real');
  });

  // The fail-CLOSED half of the ceiling: matchesBypass still compares from
  // token index 0, so a wrapped create is NOT exempted by an unwrapped bypass
  // entry. Pinned deliberately — the alternative (comparing from the resolved
  // verb) is the one change in #1145 that would LOOSEN a gate.
  it('matchesBypass stays anchored at token 0 — a wrapper does not lift the gate', () => {
    expect(matchesBypass('cd /r && gh pr create --dry-run', ['gh pr create --dry-run'])).toBe(true);
    expect(matchesBypass('nohup gh pr create --dry-run', ['gh pr create --dry-run'])).toBe(false);
    expect(matchesBypass('gh issue create --label botanical', ['gh issue create --label bot'])).toBe(false);
  });
});

describe('vcs-create-matcher — the REST-API route (#1163 BUG-2)', () => {
  // THE BUG (TV-001): every `api` shape was a MISS, i.e. a complete silent
  // bypass of both consumers. Measured 2026-09-09 against the pre-fix file:
  // all three of these returned false while each files a real issue.
  it('matches glab api --method POST …/issues and gh api …/issues', () => {
    expect(isIssueCreate('glab api --method POST projects/1/issues -f title=X')).toBe(true);
    expect(isIssueCreate('gh api repos/o/r/issues -f title=X')).toBe(true);
    expect(isIssueCreate('gh api -X POST repos/o/r/issues -f title=X')).toBe(true);
    expect(isIssueCreate('gh api -XPOST repos/o/r/issues')).toBe(true);
    expect(isIssueCreate('glab api --method=POST projects/1/issues')).toBe(true);
  });

  it('marks the route via: api and keeps matchVcsCreate at its three-key shape', () => {
    const [stmt] = findIssueCreateStatements('glab api --method POST projects/1/issues -f title=X');
    expect(stmt.shape).toEqual({ host: 'gitlab', kind: 'issue', verb: 'create', via: 'api' });
    // The sibling suite pins matchVcsCreate by equality on three keys; adding a
    // fourth there would break assertions no behaviour change justifies.
    expect(matchVcsCreate('glab issue create --title x')).toEqual({
      host: 'gitlab', kind: 'issue', verb: 'create',
    });
  });

  it('does not match glab api GET …/issues — a list is not a creation', () => {
    expect(isIssueCreate('gh api repos/o/r/issues')).toBe(false);
    expect(isIssueCreate('gh api repos/o/r/issues?state=open')).toBe(false);
    expect(isIssueCreate('glab api --method GET projects/1/issues')).toBe(false);
    // An explicit non-POST method wins even over a title payload: an update is
    // not a creation.
    expect(isIssueCreate('gh api -X PATCH repos/o/r/issues -f title=X')).toBe(false);
    // A sub-resource is a comment/update endpoint, never the issue collection.
    expect(isIssueCreate('gh api --method POST repos/o/r/issues/12/comments -f body=x')).toBe(false);
    // Unrelated API calls stay invisible.
    expect(isIssueCreate('gh api --method POST repos/o/r/labels -f name=x')).toBe(false);
    expect(isIssueCreate('glab api --method POST projects/1/issues --help')).toBe(false);
  });

  it('extracts the -f title= payload as the overflow label', () => {
    expect(
      extractTitle('glab api --method POST projects/1/issues -f "title=Broken parser"'),
    ).toBe('Broken parser');
    expect(extractTitle('gh api repos/o/r/issues --field title=X')).toBe('X');
  });

  // NAMED CEILINGS (BV-004). Pinned so the widening above stays DELIBERATE: if
  // one of these ever starts matching, it happened by accident and this test
  // says so rather than the behaviour changing silently.
  it('keeps bash -c / $( ) / xargs as documented misses', () => {
    expect(isIssueCreate("bash -c 'glab api --method POST projects/1/issues -f title=X'")).toBe(
      false,
    );
    expect(isIssueCreate('x=$(gh api repos/o/r/issues -f title=X)')).toBe(false);
    expect(isIssueCreate("bash -c 'glab issue create --title X'")).toBe(false);
  });

  // `xargs` was listed in this file's header as a TRANSPARENT WRAPPER it
  // unwraps — measured 2026-09-09, it is not: `command-blocker.mjs` classes it
  // as an interpreter (`SHELL_EXEC_INTERPRETERS`), so every xargs-driven create
  // is a total miss — 0 statements, hence no charge AND no loop-deny either.
  // The header now says so; this test keeps the documented ceiling honest, so a
  // future widening (which would have to change what `resolveSegmentVerb`
  // reports for `xargs` for four other consumers too) is deliberate.
  it('xargs-driven create is a documented miss (named ceiling) — 0 statements, no loop-deny', () => {
    const shapes = [
      'xargs glab issue create --title X',
      'echo X | xargs -I% glab issue create --title %',
      'seq 1 50 | xargs -I% gh api -X POST repos/o/r/issues -f title=%',
      'xargs -n1 glab issue create',
    ];
    for (const cmd of shapes) {
      expect(findIssueCreateStatements(cmd)).toEqual([]);
      expect(isIssueCreate(cmd)).toBe(false);
      expect(isLoopedIssueCreate(cmd)).toBe(false);
    }
  });
});

describe('vcs-create-matcher — per-statement enumeration (#1163 BUG-1)', () => {
  // THE BUG (TV-001): the hook charged ONCE per Bash call because the matcher
  // only ever answered a boolean. Measured 2026-09-09: `A && B` charged 1 for 2.
  it('returns one record per issue-create statement in the chain', () => {
    const found = findIssueCreateStatements(
      'glab issue create --title A\nglab issue create --title B',
    );
    expect(found).toHaveLength(2);
    expect(found.map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('scopes each statement text so an exempt neighbour cannot cover a real create', () => {
    const found = findIssueCreateStatements(
      'glab issue create --title REAL && glab issue create --label carryover --title X',
    );
    expect(found).toHaveLength(2);
    expect(found[0].text).not.toContain('carryover');
    expect(found[1].text).toContain('carryover');
  });

  it('counts pr/mr creates out and mixes the api route in', () => {
    const found = findIssueCreateStatements(
      'gh pr create --title p; glab issue create --title A; gh api repos/o/r/issues -f title=B',
    );
    expect(found.map((s) => s.shape.via)).toEqual(['cli', 'api']);
    expect(found.map((s) => s.title)).toEqual(['A', 'B']);
  });

  it('is empty for a non-create command', () => {
    expect(findIssueCreateStatements('ls -la')).toEqual([]);
    expect(findIssueCreateStatements('echo "glab issue create"')).toEqual([]);
  });
});

describe('vcs-create-matcher — re-fileable fields for the overflow park (#1314)', () => {
  // THE BUG (TV-001): the park stored only the raw command, so `$(cat /tmp/x.md)`
  // stayed a literal, `-R grp/other` was never read, and `gh … -t T` had title null.
  it.each([
    ['glab $(cat) unquoted', 'glab issue create --title A -d $(cat /tmp/x.md)', { title: 'A', description: null, descriptionFile: '/tmp/x.md', repo: null }],
    ['gh $(cat) quoted', 'gh issue create -t T --body "$(cat /tmp/y.md)"', { title: 'T', description: null, descriptionFile: '/tmp/y.md', repo: null }],
    ['glab file flag', 'glab issue create --title A --description-file d.md', { title: 'A', description: null, descriptionFile: 'd.md', repo: null }],
    ['gh file flag -F', 'gh issue create --title A -F d.md', { title: 'A', description: null, descriptionFile: 'd.md', repo: null }],
    ['glab -R + -d value', 'glab issue create --title A -d "body text" -R grp/other', { title: 'A', description: 'body text', descriptionFile: null, repo: 'grp/other' }],
    ['gh -t title (was null)', 'gh issue create -t T --repo o/r', { title: 'T', description: null, descriptionFile: null, repo: 'o/r' }],
    // Fix pass f-1: single quotes suppress the substitution — glab files the literal, so nothing may be read.
    ["'$(cat X)' single-quoted is a literal", "glab issue create --title A -d '$(cat .env)'", { title: 'A', description: '$(cat .env)', descriptionFile: null, repo: null }],
    ['--description=$(cat p) unquoted', 'glab issue create --title T --description=$(cat /tmp/x.md)', { title: 'T', description: null, descriptionFile: '/tmp/x.md', repo: null }],
    ['repeated -b: last value wins (pflag)', 'gh issue create -t T -b "a" -b "b"', { title: 'T', description: 'b', descriptionFile: null, repo: null }],
  ])('%s', (_label, cmd, expected) => {
    const [stmt] = findIssueCreateStatements(cmd);
    expect({
      title: stmt.title,
      description: stmt.description,
      descriptionFile: stmt.descriptionFile,
      repo: stmt.repo,
    }).toEqual(expected);
  });

  it('keeps -F a field flag on the api route, never a body file', () => {
    const [stmt] = findIssueCreateStatements('gh api repos/o/r/issues -F title=X');
    expect(stmt.title).toBe('X');
    expect(stmt.descriptionFile).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// statementsCoverWholeCommand (#1347)
// ---------------------------------------------------------------------------
//
// TV-001 bug this catches: the refund hook gives a budget slot back on ONE exit
// code for the WHOLE Bash call. Measured 2026-09-13 against its first cut,
// `glab issue create --title X && false` files the issue, exits 1, and one slot
// was refunded — a cap drain reachable from any agent. This predicate is the
// attribution gate; a `true` for a mixed chain re-opens that hole.

describe('vcs-create-matcher — refund attribution (#1347)', () => {
  it.each([
    ['a single create is the whole command', 'glab issue create --title A', true],
    ['two chained creates are the whole command', 'glab issue create --title A && gh issue create --title B', true],
    ['a create with an appended failing statement is NOT', 'glab issue create --title A && false', false],
    ['a create with a leading cd is NOT (named ceiling)', 'cd /repo && glab issue create --title A', false],
    ['a create followed by an echo is NOT', 'glab issue create --title A; echo done', false],
    ['a pr create is not an issue create', 'glab mr create --title A', false],
    ['no create at all', 'echo "glab issue create"', false],
    ['the api route counts as a create', 'gh api -X POST repos/o/r/issues -f title=X', true],
  ])('%s', (_label, command, expected) => {
    expect(statementsCoverWholeCommand(command)).toBe(expected);
  });
});
