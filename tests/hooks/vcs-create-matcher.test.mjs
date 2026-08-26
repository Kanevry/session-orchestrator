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
  matchesBypass,
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
