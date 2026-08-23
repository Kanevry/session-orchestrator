/**
 * vcs-create-matcher.mjs — shared `gh` / `glab` create-command matcher for
 * PreToolUse Bash hooks.
 *
 * Extracted from `hooks/pre-bash-templates-first.mjs` (#519) so the
 * issue-budget hook (`hooks/pre-bash-issue-budget.mjs`) reuses the SAME
 * matcher + argument-boundary semantics instead of maintaining a second,
 * silently-diverging copy. Both hooks share the PreToolUse Bash matcher and
 * run sequentially, so a divergence here would mean one hook gates a command
 * the other waves through.
 *
 * ## Statement splitting (#1106) — why this is no longer a single regex
 *
 * Until #1106 the matcher was one regex anchored at the START of the whole
 * command string (`/^\s*(gh|glab)\s+(pr|mr|issue)\s+(create|new)\b/`). Every
 * shape that does not BEGIN with the CLI name was therefore invisible, and the
 * most common agent shape — a `cd` into the repo, then the create call — is
 * exactly such a shape. Measured 2026-08-23 in a live session: four issues were
 * created as `cd <repo>\nglab issue create …` and
 * `.orchestrator/runtime/issue-budget.json` recorded `count: 0`. The
 * `issue-budget` cap was not circumvented — for that command form it had never
 * existed.
 *
 * The fix is to split the command into SHELL STATEMENTS and test each one, so
 * a create call anywhere in a chain is seen. The hard part is not the splitting
 * but the false-positive edge: `echo "glab issue create"`, a `#`-comment, and
 * `grep -rn "glab issue create" docs/` all contain the literal words and must
 * still NOT match. Naive splitting on `\n` / `&&` / `;` / `||` gets those wrong
 * whenever a separator or a create-shaped line sits inside a quoted string or a
 * here-doc body.
 *
 * So the splitting is delegated to `scripts/lib/command-blocker.mjs`
 * (`tokenizeCommand` + `splitChainSegments`) — the lexer the destructive-command
 * guard already runs on every Bash call. It carries quote state, `#`-comments,
 * here-doc bodies, line continuations, arithmetic `<<`, and newline-as-separator,
 * each of which was a measured bypass of that guard at some point. Writing a
 * second shell splitter here would re-open every one of those holes in a file
 * whose entire reason to exist is "no second, silently-diverging copy".
 *
 * That import is a deliberate revision of this file's former "ZERO IMPORTS by
 * design" note: the leaf property bought nothing that a shared lexer does not,
 * and the cost is one `node:path`-only module (~2 ms import, no side effects).
 *
 * LOAD-BEARING semantics (contract):
 *   MATCH:    a SHELL STATEMENT whose first three tokens are `gh|glab` +
 *             `pr|mr|issue` + `create|new`, anywhere in the command chain.
 *             Statements are separated by unquoted `;` `&&` `||` `|` `&` and
 *             newline.
 *   NO MATCH: the words inside a quoted string, a `#` comment, or a here-doc
 *             body (they are data, not a command); a single token that merely
 *             CONTAINS the three words (`"glab issue create"` runs a binary of
 *             that literal name, it is not a create call); edit operations
 *             (`gh pr edit`) — deliberately out of scope per the #519 PRD § 2.
 *
 * ## Named ceilings (BV-004)
 *
 *   - A create call reached only through a command substitution
 *     (`x=$(glab issue create …)`) or a leading env assignment
 *     (`GITLAB_HOST=y glab issue create …`) is NOT matched: the segment's first
 *     token is not the CLI name. Both were already invisible before #1106, so
 *     this is an unchanged ceiling, not a regression. Revisit if either shape
 *     shows up in `.orchestrator/runtime/issue-budget.json` overflow triage or
 *     in a transcript census of real create calls.
 *   - Process wrappers (`sudo`, `env`, `xargs`) are not unwrapped here.
 *     `command-blocker.mjs` exports `resolveSegmentVerb` for that; wire it in
 *     only if a wrapped create call is actually observed.
 */

import { tokenizeCommand, splitChainSegments } from '../../scripts/lib/command-blocker.mjs';

/**
 * The accepted create shape, applied to the first THREE tokens of a shell
 * statement (joined by single spaces — the lexer has already stripped quoting
 * and collapsed whitespace).
 *
 * Kept as the single source of truth for the accepted vocabulary — the part
 * most likely to drift — rather than being spread across three token
 * comparisons. The leading `^\s*` and the trailing `\b` are retained so the
 * regex still describes the same shape it did before #1106 (`created` / `news`
 * do not match), and so a caller holding the old export still gets the old
 * single-statement behaviour.
 */
export const CREATE_REGEX = /^\s*(gh|glab)\s+(pr|mr|issue)\s+(create|new)\b/;

/**
 * Split a raw shell command into statements, each as a token array.
 *
 * Thin, named wrapper over the shared lexer so the two call sites below (and
 * any future one) cannot disagree about what "a statement" means.
 *
 * @param {string} command
 * @returns {Array<Array<{ text: string, quoted: boolean }>>}
 */
function statementsOf(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  try {
    return splitChainSegments(tokenizeCommand(command));
  } catch {
    // Fail OPEN, matching every other error path in the two consuming hooks:
    // a lexer that throws must not wedge every Bash call. Worst case is a
    // missed enforcement.
    return [];
  }
}

/**
 * Test one statement's token array against {@link CREATE_REGEX}.
 *
 * The three head tokens are checked for embedded whitespace first. Without
 * that guard, `"glab issue create" --title x` — ONE token that happens to
 * contain all three words, i.e. an attempt to run a binary literally named
 * `glab issue create` — would join back into a matching head. The lexer strips
 * quotes, so token boundaries are the only remaining evidence that the words
 * arrived as three separate arguments.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @returns {{ host: 'github'|'gitlab', kind: 'pr'|'mr'|'issue', verb: 'create'|'new' } | null}
 */
function matchStatement(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 3) return null;
  const head = tokens.slice(0, 3).map((t) => t.text);
  if (head.some((t) => typeof t !== 'string' || /\s/.test(t))) return null;
  const m = head.join(' ').match(CREATE_REGEX);
  if (!m) return null;
  return {
    host: m[1] === 'gh' ? 'github' : 'gitlab',
    kind: /** @type {'pr'|'mr'|'issue'} */ (m[2]),
    verb: /** @type {'create'|'new'} */ (m[3]),
  };
}

/**
 * Find the first statement in the command chain that is a VCS-create call.
 *
 * Returns the shape AND the statement's tokens, because `extractTitle` must
 * read `--title` off the SAME statement the gate fired on — reading it off the
 * whole command silently returns a neighbouring statement's title (e.g. the
 * `--title` of a preceding `glab issue list --search …`).
 *
 * @param {string} command
 * @returns {{ shape: { host: string, kind: string, verb: string },
 *             tokens: Array<{ text: string, quoted: boolean }> } | null}
 */
function findCreateStatement(command) {
  for (const tokens of statementsOf(command)) {
    const shape = matchStatement(tokens);
    if (shape) return { shape, tokens };
  }
  return null;
}

/**
 * Parse a shell command into its VCS-create shape.
 *
 * @param {string} command
 * @returns {{ host: 'github'|'gitlab', kind: 'pr'|'mr'|'issue', verb: 'create'|'new' } | null}
 *   `null` when no statement in the command is a `gh`/`glab` create/new call.
 */
export function matchVcsCreate(command) {
  return findCreateStatement(command)?.shape ?? null;
}

/**
 * Determine which host the command targets. `gh` → "github", `glab` → "gitlab".
 * Thin wrapper kept for call-site readability in pre-bash-templates-first.mjs.
 *
 * @param {string} command
 * @returns {"github"|"gitlab"|null}
 */
export function resolveHost(command) {
  return matchVcsCreate(command)?.host ?? null;
}

/**
 * True when the command creates an ISSUE specifically (not a PR/MR).
 * The issue-budget cap counts issues only — PR/MR creation is not the
 * runaway-volume problem the cap exists to bound.
 *
 * @param {string} command
 * @returns {boolean}
 */
export function isIssueCreate(command) {
  return matchVcsCreate(command)?.kind === 'issue';
}

/**
 * True when any STATEMENT in the command starts with one of the bypass
 * patterns.
 *
 * Comparison is token-prefix, not string-prefix: the pattern is lexed with the
 * same lexer as the command, and every one of its tokens must equal the
 * statement's token at the same index. That preserves the property the previous
 * string-prefix + boundary check existed for — a policy entry
 * `gh issue create --label bot` must not match `--label botanical`, because
 * `bot !== 'botanical'` as tokens — while dropping the hand-rolled boundary
 * scan and, incidentally, tolerating whitespace and quoting differences between
 * policy text and command text.
 *
 * Statement-scoped for the same reason the matcher is (#1106): after splitting,
 * `cd /repo && gh pr create --dry-run` is a gated create call, and the
 * operator's `gh pr create --dry-run` bypass entry must still exempt it.
 * Checking the bypass against the whole command string would leave that entry
 * dead exactly for the shapes the widening newly gates.
 *
 * @param {string} command
 * @param {string[]} bypassPatterns
 * @returns {boolean}
 */
export function matchesBypass(command, bypassPatterns) {
  if (typeof command !== 'string') return false;
  if (!Array.isArray(bypassPatterns) || bypassPatterns.length === 0) {
    return false;
  }

  const statements = statementsOf(command);
  if (statements.length === 0) return false;

  for (const pat of bypassPatterns) {
    if (typeof pat !== 'string' || pat.length === 0) continue;
    const patStatements = statementsOf(pat);
    // A pattern that lexes to nothing (whitespace-only, comment-only) would
    // prefix-match EVERY statement — treat it as no pattern at all.
    if (patStatements.length === 0) continue;
    const patTokens = patStatements[0].map((t) => t.text);
    if (patTokens.length === 0) continue;

    for (const tokens of statements) {
      if (tokens.length < patTokens.length) continue;
      if (patTokens.every((text, i) => tokens[i].text === text)) return true;
    }
  }
  return false;
}

/**
 * Best-effort extraction of the `--title` value from a create command, for
 * human-readable overflow bookkeeping. Handles `--title "x"`, `--title 'x'`,
 * `--title=x` and the bare unquoted form — uniformly, because the lexer has
 * already resolved quoting by the time this reads the tokens.
 *
 * Scoped to the create STATEMENT when there is one (#1106): reading `--title`
 * off the whole command picks up a neighbouring statement's flag and labels the
 * overflow record with the wrong title. Falls back to the whole token stream
 * when no statement is a create call, preserving the previous lenient behaviour
 * for callers that ask about a non-create command.
 *
 * Deliberately NOT a shell parser beyond that: the value is only ever used as a
 * display label in an overflow record, never re-executed.
 *
 * @param {string} command
 * @returns {string|null}
 */
export function extractTitle(command) {
  if (typeof command !== 'string' || command.length === 0) return null;

  const found = findCreateStatement(command);
  const tokens = found ? found.tokens : statementsOf(command).flat();

  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].text;
    if (text === '--title') {
      const value = tokens[i + 1]?.text;
      return typeof value === 'string' ? value.trim() || null : null;
    }
    if (text.startsWith('--title=')) {
      return text.slice('--title='.length).trim() || null;
    }
  }
  return null;
}
