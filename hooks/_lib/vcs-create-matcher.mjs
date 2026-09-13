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
 * created as `cd <repo>\nglab issue create …` and the session's issue-budget
 * counter file recorded `count: 0` (then the flat
 * `.orchestrator/runtime/issue-budget.json`; one file per session under
 * `.orchestrator/runtime/issue-budget/<hash>.json` since #1141). The
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
 *   MATCH:    a SHELL STATEMENT whose RESOLVED VERB is `gh|glab` and whose two
 *             following tokens are `pr|mr|issue` + `create|new`, anywhere in
 *             the command chain. Statements are separated by unquoted `;` `&&`
 *             `||` `|` `&` and newline, and their command-position reserved
 *             words (`do`, `then`, `{`, …) are stripped by the lexer (#1145),
 *             so a create inside a loop body, a brace group, an `if` branch or
 *             a spaced subshell is a statement like any other. "Resolved verb"
 *             means: after leading `VAR=value` assignments, after transparent
 *             process wrappers (`nohup`, `command`, `sudo`, `env`, `timeout`,
 *             `exec`), and basename-normalised, so an absolute path
 *             (`/opt/homebrew/bin/glab`) resolves to `glab` (#1145). `xargs` is
 *             NOT one of those wrappers — see the named ceiling below.
 *   NO MATCH: the words inside a quoted string, a `#` comment, or a here-doc
 *             body (they are data, not a command); a single token that merely
 *             CONTAINS the three words (`"glab issue create"` runs a binary of
 *             that literal name, it is not a create call); edit operations
 *             (`gh pr edit`) — deliberately out of scope per the #519 PRD § 2;
 *             a create statement carrying `--help`, which prints help and
 *             creates nothing (#1145 — see {@link hasHelpFlag}).
 *
 * ## Verb resolution (#1145) — why the head is no longer `tokens.slice(0, 3)`
 *
 * #1106 made the matcher see every STATEMENT; it still read each statement's
 * head as the raw first three tokens. So a statement whose first token is not
 * literally `gh`/`glab` stayed invisible even when the shell would run exactly
 * that binary. Measured 2026-08-26 against this file on `main`:
 *
 *     nohup glab issue create --title g          → isIssueCreate false
 *     /opt/homebrew/bin/glab issue create …      → isIssueCreate false
 *     GITLAB_HOST=y glab issue create …          → isIssueCreate false
 *
 * None of those is a segmentation defect — `splitChainSegments` already yields
 * the whole statement, and `resolveSegmentVerb` already resolves all three
 * (`nohup`/`command`/`sudo`/`env` are transparent wrappers in `WRAPPER_UNWRAP`,
 * an absolute path is basename-normalised, and leading `VAR=value` assignments
 * are skipped). The matcher simply never asked. It now does, via the same call
 * shape the two sibling consumers use — `hooks/pre-bash-destructive-guard.mjs`
 * (`parseRmTargets`, `commandHasRecursiveForceRm`) and
 * `scripts/lib/scope-gate.mjs` (`extractBashWriteTargets`): split, then
 * `resolveSegmentVerb`, then read the head at the RESOLVED index.
 *
 * ## Named ceilings (BV-004)
 *
 *   - A create call reached only through a command substitution
 *     (`x=$(glab issue create …)`) is NOT matched: the substitution body never
 *     becomes a segment of its own. Unchanged since before #1106. Likewise a
 *     create carried as an interpreter PAYLOAD (`bash -c 'glab issue create'`)
 *     — `resolveSegmentVerb` reports the payload string, but this matcher does
 *     not recurse into it. Revisit either if the shape shows up in the overflow
 *     triage of a per-session counter file
 *     (`.orchestrator/runtime/issue-budget/<hash>.json`, #1141) or in a
 *     transcript census of real create calls.
 *   - An `xargs`-driven create is NOT matched, and `xargs` is deliberately not
 *     a transparent wrapper: `command-blocker.mjs` classes it as an INTERPRETER
 *     (`SHELL_EXEC_INTERPRETERS`), because unwrapping it there would LOOSEN the
 *     destructive-command guard that shares this lexer. Measured 2026-09-09
 *     against this file — all four shapes yield 0 statements, so neither the
 *     cap nor the loop-deny sees them:
 *
 *         xargs glab issue create --title X                          → 0
 *         echo X | xargs -I% glab issue create --title %             → 0
 *         seq 1 50 | xargs -I% gh api -X POST …/issues -f title=%    → 0
 *         xargs -n1 glab issue create                                → 0
 *
 *     Widening this one shape means changing what `resolveSegmentVerb` reports
 *     for `xargs` — read by the four OTHER consumers of that resolver
 *     (`grep -rln resolveSegmentVerb scripts/ hooks/`, 2026-09-09:
 *     `scripts/lib/project-hygiene.mjs`, `scripts/lib/scope-gate.mjs`,
 *     `hooks/pre-bash-sessions-ledger-guard.mjs`,
 *     `hooks/pre-bash-destructive-guard.mjs`) — so it is a deliberate
 *     cross-consumer change, never a local patch here.
 *     Pinned by `tests/hooks/vcs-create-matcher.test.mjs`. Revisit when an
 *     `xargs`-driven create shows up in a transcript census or in the overflow
 *     triage of a per-session counter file.
 *   - A paren glued to the verb (`(glab issue create …)`) is not reached: it
 *     lexes as the single word `(glab`. This is `command-blocker.mjs`'s own
 *     named ceiling on `COMMAND_POSITION_KEYWORDS` (#1145), inherited here
 *     rather than re-patched — peeling the paren belongs in the lexer, whose
 *     tokens five consumers read positionally.
 *   - {@link matchesBypass} still compares from token index 0, NOT from the
 *     resolved verb index. So a wrapped create (`nohup gh pr create --dry-run`)
 *     is gated even when `gh pr create --dry-run` is a bypass entry. That is
 *     the fail-CLOSED direction of this widening and is deliberate: making an
 *     operator escape hatch reachable through a wrapper is the one change here
 *     that would LOOSEN a gate. Revisit only if an operator reports a live
 *     bypass entry going dead on a wrapped command.
 */

import {
  tokenizeCommand,
  splitChainSegments,
  resolveSegmentVerb,
} from '../../scripts/lib/command-blocker.mjs';

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
 * `--help` short-circuits a cobra command (both `gh` and `glab` are cobra
 * CLIs): the help text is printed and the command body never runs, so
 * `glab issue create --help` — the exact call an agent makes to discover the
 * flag names BEFORE filing — creates nothing. Counting it charged the session
 * cap for a non-creation and, at the boundary, denied the next real issue.
 * This is the narrowing that pairs with the #1145 widening.
 *
 * NAMED CEILING (BV-004): only the LONG form is honoured. `-h` is cobra's
 * DEFAULT help shorthand but a subcommand may rebind it, and a rebound `-h`
 * would turn this narrowing into a cap bypass on a command that really does
 * create. `--help` is reserved by cobra and cannot be rebound, so it is safe
 * where `-h` is not. Revisit if `gh`/`glab` ever ship a create subcommand
 * whose `--help` is not the help flag.
 *
 * Quoted tokens do not count: `--title "run with --help"` is a title.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @param {number} from — first index AFTER the three head words
 * @returns {boolean}
 */
function hasHelpFlag(tokens, from) {
  for (let i = from; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.quoted && t.text === '--help') return true;
  }
  return false;
}

/**
 * Test one READING of a statement (a resolved verb plus the two tokens that
 * follow it) against {@link CREATE_REGEX}.
 *
 * The three head words are checked for embedded whitespace first. Without that
 * guard, `"glab issue create" --title x` — ONE token that happens to contain
 * all three words, i.e. an attempt to run a binary literally named
 * `glab issue create` — would join back into a matching head. The lexer strips
 * quotes, so token boundaries are the only remaining evidence that the words
 * arrived as three separate arguments.
 *
 * @param {string} verb — basename-normalised verb from resolveSegmentVerb
 * @param {Array<{ text: string, quoted: boolean }>} tokens — the whole statement
 * @param {number} index — token index the verb resolved to
 * @returns {{ host: 'github'|'gitlab', kind: 'pr'|'mr'|'issue', verb: 'create'|'new' } | null}
 */
function matchReading(verb, tokens, index) {
  const head = [verb, tokens[index + 1]?.text, tokens[index + 2]?.text];
  if (head.some((t) => typeof t !== 'string' || /\s/.test(t))) return null;
  const m = head.join(' ').match(CREATE_REGEX);
  if (!m) return null;
  if (hasHelpFlag(tokens, index + 3)) return null;
  return {
    host: m[1] === 'gh' ? 'github' : 'gitlab',
    kind: /** @type {'pr'|'mr'|'issue'} */ (m[2]),
    verb: /** @type {'create'|'new'} */ (m[3]),
    via: /** @type {'cli'} */ ('cli'),
  };
}

/**
 * A REST path whose LAST segment is `issues` — the issue COLLECTION endpoint,
 * which is the only one a POST creates an issue on.
 *
 * Deliberately anchored at the end (`?` allowed for a query string): the
 * sub-resources `.../issues/12/notes` and `.../issues/12` are a comment and an
 * update, neither of which creates an issue. Matching them would charge the cap
 * for a note.
 */
const ISSUE_COLLECTION_PATH = /(^|\/)issues(\?|$)/;

/** `-f` / `-F` / `--field` / `--raw-field` — the payload flags both CLIs take. */
const FIELD_FLAGS = new Set(['-f', '-F', '--field', '--raw-field']);

/**
 * Recognise the REST-API route to issue creation: `gh api` / `glab api`
 * against an `/issues` collection path (#1163 BUG-2).
 *
 * ## Why this is not an optional extra
 *
 * Measured 2026-09-09 over a 13-shape census of the matcher: every `api` form
 * was a MISS, i.e. a COMPLETE silent bypass of the issue-budget cap and of the
 * templates-first gate —
 *
 *     glab api --method POST projects/1/issues -f title=X   → isIssueCreate false
 *     gh api repos/o/r/issues -f title=X                     → isIssueCreate false
 *     gh api -X POST repos/o/r/issues -f title=X             → isIssueCreate false
 *
 * All three file a real issue. The subcommand route (`glab issue create`) was
 * gated from the start, so an agent that hit the cap could reach the same
 * effect through `api` with no counter moving at all.
 *
 * ## The narrow shape (guard-design: widen the matcher, not the bypass)
 *
 * A LIST call must not match — `gh api repos/o/r/issues` is the single most
 * common read in this repo's own tooling, and charging it would make the cap
 * fire on reads. So the accepted shape is: verb `gh`/`glab`, next token `api`,
 * an `/issues` COLLECTION path somewhere in the argument list, AND either
 *   - an explicit POST method (`--method POST`, `--method=POST`, `-X POST`,
 *     `-XPOST`), or
 *   - a `title=` payload field (`-f title=…`), which only a create carries.
 * An explicit NON-POST method (`--method GET`, `-X PATCH`) is a hard NO-MATCH
 * even when a `title=` field is present: an update is not a creation.
 *
 * `--help` short-circuits here exactly as it does for the subcommand route.
 *
 * NAMED CEILING (BV-004): the payload flags are read as `-f title=…` token
 * pairs and `--field=title=…` is NOT recognised (neither CLI accepts that
 * spelling today). A create whose whole body arrives via `--input -` on stdin
 * matches only through the explicit POST method, which is the shape both CLIs
 * require for that form. Revisit if a census of real create calls shows an
 * `api` shape reaching neither condition.
 *
 * @param {string} verb — basename-normalised verb from resolveSegmentVerb
 * @param {Array<{ text: string, quoted: boolean }>} tokens — the whole statement
 * @param {number} index — token index the verb resolved to
 * @returns {{ host: 'github'|'gitlab', kind: 'issue', verb: 'create', via: 'api' } | null}
 */
function matchApiReading(verb, tokens, index) {
  if (verb !== 'gh' && verb !== 'glab') return null;
  const sub = tokens[index + 1];
  if (!sub || sub.quoted || sub.text !== 'api') return null;

  let method = null;
  let hasTitleField = false;
  let issuePath = false;

  for (let i = index + 2; i < tokens.length; i++) {
    const tok = tokens[i];
    const text = tok.text;
    if (!tok.quoted && text === '--help') return null;
    if (!tok.quoted && (text === '--method' || text === '-X')) {
      method = tokens[i + 1]?.text ?? '';
      i += 1;
      continue;
    }
    if (!tok.quoted && text.startsWith('--method=')) {
      method = text.slice('--method='.length);
      continue;
    }
    if (!tok.quoted && text.startsWith('-X') && text.length > 2) {
      method = text.slice(2);
      continue;
    }
    if (!tok.quoted && FIELD_FLAGS.has(text)) {
      const value = tokens[i + 1]?.text ?? '';
      if (value.startsWith('title=')) hasTitleField = true;
      i += 1;
      continue;
    }
    // A path is an operand, quoted or not — `gh api "repos/o/r/issues"` is the
    // same call as the bare form, and quoting an operand is not concealment the
    // way quoting a whole COMMAND is.
    if (ISSUE_COLLECTION_PATH.test(text)) issuePath = true;
  }

  if (!issuePath) return null;
  if (method !== null) {
    if (!/^post$/i.test(method)) return null;
  } else if (!hasTitleField) {
    return null;
  }
  return { host: verb === 'gh' ? 'github' : 'gitlab', kind: 'issue', verb: 'create', via: 'api' };
}

/**
 * Test one statement's token array against {@link CREATE_REGEX}, reading the
 * head at the RESOLVED verb index rather than at token 0 (#1145).
 *
 * BOTH readings of an ambiguous segment are judged. `resolveSegmentVerb`
 * returns an `alt` reading whenever it skipped an unknown wrapper dash-flag
 * that might have taken a value (`env -Q x glab issue create` — is `x` the
 * verb, or `-Q`'s operand?). Its own contract tells consumers that JUDGE
 * (as opposed to consumers that walk operands positionally) to consider both;
 * matching in either reading is the fail-CLOSED direction for a gate, since a
 * match means "count it / require a template", never "let it through".
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @returns {{ host: 'github'|'gitlab', kind: 'pr'|'mr'|'issue', verb: 'create'|'new' } | null}
 */
function matchStatement(tokens) {
  if (!Array.isArray(tokens) || tokens.length < 3) return null;
  let resolved;
  try {
    resolved = resolveSegmentVerb(tokens);
  } catch {
    return null; // fail OPEN, same posture as statementsOf
  }
  for (const reading of [resolved, resolved.alt]) {
    if (!reading || typeof reading.verb !== 'string' || reading.index < 0) continue;
    const shape =
      matchReading(reading.verb, tokens, reading.index) ??
      matchApiReading(reading.verb, tokens, reading.index);
    if (shape) return shape;
  }
  return null;
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
  const shape = findCreateStatement(command)?.shape;
  if (!shape) return null;
  // The `via` marker is deliberately NOT part of THIS return shape: the sibling
  // suite `tests/unit/hook-issue-budget.test.mjs` pins it by `toEqual` on the
  // exact three keys, and a fourth key would fail those assertions without any
  // behaviour changing. Consumers that need the route ask
  // {@link findIssueCreateStatements}, which carries it.
  return { host: shape.host, kind: shape.kind, verb: shape.verb };
}

/**
 * Read the `--title` (subcommand route) or `-f title=…` (api route) value off
 * ONE statement's tokens.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @returns {string|null}
 */
function titleFromTokens(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].text;
    if (text === '--title') {
      const value = tokens[i + 1]?.text;
      return typeof value === 'string' ? value.trim() || null : null;
    }
    if (text.startsWith('--title=')) {
      return text.slice('--title='.length).trim() || null;
    }
    if (FIELD_FLAGS.has(text)) {
      const value = tokens[i + 1]?.text ?? '';
      if (value.startsWith('title=')) return value.slice('title='.length).trim() || null;
      i += 1;
    }
  }
  return null;
}

/**
 * Per-host CLI flag names for the non-title fields of an issue-create
 * statement (#1314). Verified against the CLIs' own `--help` (2026-09-12):
 *   glab issue create: `-t --title`, `-d --description`, `--description-file`, `-R --repo`
 *   gh issue create:   `-t, --title`, `-b, --body`, `-F, --body-file`, `-R, --repo`
 * Read only on the subcommand route — on the api route `-F` is a field flag.
 */
const CLI_FLAGS = {
  gitlab: { description: ['-d', '--description'], descriptionFile: ['--description-file'], repo: ['-R', '--repo'] },
  github: { description: ['-b', '--body'], descriptionFile: ['-F', '--body-file'], repo: ['-R', '--repo'] },
};

/** `$(cat <path>)` as ONE value — the only command substitution resolved. */
const CAT_SUBST_RE = /^\$\(cat\s+(\S+)\)$/;

/**
 * Read the value of a flag in `names` (`--x v`, `--x=v`, `-x v`). When the flag
 * repeats, the LAST value wins — the pflag semantics `gh`/`glab` apply.
 * An UNQUOTED `$(cat p)` is split by the lexer into `$(cat` + `p)`; that pair is
 * rejoined so the substitution survives, in both the `--x $(cat p)` and the
 * `--x=$(cat p)` spelling.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @param {string[]} names
 * @returns {string|null}
 */
function flagValue(tokens, names) {
  let found = null;
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].text;
    for (const name of names) {
      let value;
      if (text === name) {
        value = tokens[i + 1]?.text;
        if (typeof value !== 'string') return found;
        i += 1;
      } else if (name.startsWith('--') && text.startsWith(`${name}=`)) {
        value = text.slice(name.length + 1);
      } else {
        continue;
      }
      if (value === '$(cat' && typeof tokens[i + 1]?.text === 'string') {
        value = `$(cat ${tokens[i + 1].text}`;
        i += 1;
      }
      found = value;
      break;
    }
  }
  return found;
}

/**
 * The paths of every `$(cat <path>)` that sits inside SINGLE quotes in the RAW
 * command. The lexer marks single- and double-quoted tokens alike, but only
 * the double-quoted (or bare) form is expanded by the shell — inside single
 * quotes `gh`/`glab` receive the literal text, so reading that file would park
 * content the CLI never saw (`-d '$(cat .env)'`).
 *
 * @param {string} command — the raw command, quotes intact
 * @returns {Set<string>}
 */
function singleQuotedCatPaths(command) {
  const out = new Set();
  let quote = null;
  let span = '';
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") {
        for (const m of span.matchAll(/\$\(cat\s+(\S+)\)/g)) out.add(m[1]);
        quote = null;
        span = '';
      } else {
        span += c;
      }
    } else if (c === '\\') {
      i += 1; // an escaped char opens no quote
    } else if (quote === '"') {
      if (c === '"') quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    }
  }
  return out;
}

/**
 * Title, description, description file and target repo of ONE create
 * statement (#1314) — what a parked overflow record needs to be re-filed.
 * Additive to {@link titleFromTokens}: its `--title` / `-f title=` reading is
 * kept verbatim; `-t` is added on the subcommand route only.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @param {{ host: string, via: string }} shape
 * @param {Set<string>} literalCatPaths — from {@link singleQuotedCatPaths}
 * @returns {{ title: string|null, description: string|null,
 *             descriptionFile: string|null, repo: string|null }}
 */
function fieldsFromTokens(tokens, shape, literalCatPaths) {
  let title = titleFromTokens(tokens);
  const flags = shape.via === 'cli' ? CLI_FLAGS[shape.host] : undefined;
  if (!flags) return { title, description: null, descriptionFile: null, repo: null };
  if (title === null) title = flagValue(tokens, ['-t'])?.trim() || null;
  let description = flagValue(tokens, flags.description);
  let descriptionFile = flagValue(tokens, flags.descriptionFile);
  // `-` means stdin (or an editor for glab -d) — nothing a later read can reach.
  if (descriptionFile === '-') descriptionFile = null;
  if (description === '-') description = null;
  // A single-quoted `$(cat p)` stays the literal text the CLI files.
  const subst = typeof description === 'string' ? CAT_SUBST_RE.exec(description) : null;
  if (subst && !literalCatPaths.has(subst[1])) {
    description = null;
    descriptionFile ??= subst[1];
  }
  const fileSubst = typeof descriptionFile === 'string' ? CAT_SUBST_RE.exec(descriptionFile) : null;
  if (fileSubst) descriptionFile = literalCatPaths.has(fileSubst[1]) ? null : fileSubst[1];
  return { title, description, descriptionFile, repo: flagValue(tokens, flags.repo) };
}

/**
 * EVERY issue-create statement in the command chain, in source order (#1163
 * BUG-1).
 *
 * ## Why the callers cannot keep using {@link isIssueCreate} alone
 *
 * `isIssueCreate` answers "does this command create an issue?" — a BOOLEAN,
 * which is exactly one issue short of what a QUANTITY gate needs. Measured
 * 2026-09-09 against `hooks/pre-bash-issue-budget.mjs` before this change:
 * `glab issue create --title A && glab issue create --title B` charged the cap
 * ONCE for TWO issues, because the hook called `chargeIssueBudget` once per
 * Bash tool call with the whole command string. The segmentation to answer it
 * correctly was already here — nothing consumed it per statement.
 *
 * Each record carries the tokens the caller must judge (never the whole
 * command): a chain may mix an exempt create with a chargeable one, and
 * classifying the exemption on the joined command text would exempt BOTH —
 * the same class of hole as the bypass-scoping regression documented on
 * {@link matchesBypass}.
 *
 * `text` is the statement rebuilt from its tokens (quotes already resolved by
 * the lexer, arguments joined by single spaces). It is a CLASSIFICATION INPUT
 * for `classifyExemption`, never something to re-execute.
 *
 * `cwdChanged` is true when an EARLIER statement of the same chain is a
 * `cd`/`pushd`/`popd`: a relative description-file path is then relative to a
 * directory this hook cannot know, so `buildOverflowRecord` must not resolve it.
 *
 * @param {string} command
 * @returns {Array<{ shape: { host: string, kind: string, verb: string, via: string },
 *                   tokens: Array<{ text: string, quoted: boolean }>,
 *                   text: string,
 *                   title: string|null,
 *                   description: string|null,
 *                   descriptionFile: string|null,
 *                   repo: string|null,
 *                   cwdChanged: boolean }>}
 */
export function findIssueCreateStatements(command) {
  const out = [];
  let literalCatPaths = null;
  let cwdChanged = false;
  for (const tokens of statementsOf(command)) {
    const shape = matchStatement(tokens);
    if (!shape || shape.kind !== 'issue') {
      if (!cwdChanged && tokens.length > 0) {
        try {
          cwdChanged = CWD_VERBS.has(resolveSegmentVerb(tokens).verb);
        } catch {
          cwdChanged = true; // unknown → do not trust a relative path
        }
      }
      continue;
    }
    literalCatPaths ??= singleQuotedCatPaths(command);
    out.push({
      shape,
      tokens,
      text: tokens.map((t) => t.text).join(' '),
      ...fieldsFromTokens(tokens, shape, literalCatPaths),
      cwdChanged,
    });
  }
  return out;
}

/** Builtins that move the shell's working directory for later statements. */
const CWD_VERBS = new Set(['cd', 'pushd', 'popd']);

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
 * True when the matched issue-create statement sits inside a LOOP BODY, i.e.
 * the command creates an unknown number of issues (#1145).
 *
 * ## Why this is a separate question from {@link isIssueCreate}
 *
 * `for t in a b c; do glab issue create --title $t; done` is textually ONE
 * create statement that files THREE issues. Since #1145 the segmenter strips
 * `do`, so the statement is finally visible to the cap — but charging it `1`
 * would be a worse failure than the pre-#1145 miss: the ledger would then carry
 * a number it KNOWS is wrong, and `for i in $(seq 1 50)` would file 50 issues
 * against a count of 1. The true multiplicity is not computable at hook time
 * (`$(cat list)`, `"$@"`, a glob) — so this function reports the FACT and the
 * hook decides the POLICY (`hooks/pre-bash-issue-budget.mjs` G3b denies in
 * `strict`, warns in `warn`).
 *
 * ## Mechanism — derived from the lexer, not re-derived here
 *
 * `do` and `done` open and close every bash loop body (`for`, `while`,
 * `until`, `select` all use them) and both are in `command-blocker.mjs`'s
 * `COMMAND_POSITION_KEYWORDS`. A token disappears between `tokenizeCommand`
 * and `splitChainSegments` for exactly two reasons: it was a chain SEPARATOR,
 * or it was a reserved word in COMMAND POSITION. `do`/`done` are not
 * separators — so a `do` that is absent from the segments is provably a
 * command-position `do`, and `echo do` / `--title done` (kept, because they
 * are ordinary arguments) are provably not. Identity is object identity: the
 * splitter pushes the very token objects the tokenizer produced.
 *
 * That is why this does not re-implement the separator scan: re-deriving
 * command position here would be the second, silently-diverging shell parser
 * this whole file exists to prevent.
 *
 * Depth is counted so a create AFTER a loop is not implicated:
 * `while x; do echo a; done; glab issue create` → depth 0 at the create.
 *
 * NAMED CEILING (BV-004): this is coupled to `do`/`done` remaining in
 * `COMMAND_POSITION_KEYWORDS`. If either is removed there, the token stops
 * disappearing and this silently returns `false` — an under-report, i.e. back
 * to charging 1 for N. The unit test `tests/hooks/vcs-create-matcher.test.mjs`
 * pins the coupling directly. Revisit if that set is ever narrowed.
 *
 * @param {string} command
 * @returns {boolean} false when the command has no issue-create statement at all
 */
export function isLoopedIssueCreate(command) {
  if (typeof command !== 'string' || command.length === 0) return false;

  let tokens;
  let segments;
  try {
    tokens = tokenizeCommand(command);
    segments = splitChainSegments(tokens);
  } catch {
    return false; // fail OPEN, same posture as statementsOf
  }

  // The create statement's HEAD token, by object identity — the position in the
  // raw stream at which the loop depth must be read.
  //
  // Deliberately the FIRST create statement of any kind, then a kind check —
  // exactly what isIssueCreate() does via matchVcsCreate(). Searching for the
  // first ISSUE create instead would diverge on `glab mr create … ; glab issue
  // create …`: the hook's G3 would look at the mr, this at the issue, and the
  // two would disagree about which statement they are judging.
  let headTok = null;
  for (const seg of segments) {
    const shape = matchStatement(seg);
    if (!shape) continue;
    if (shape.kind === 'issue') headTok = seg[0];
    break;
  }
  if (!headTok) return false;

  const kept = new Set(segments.flat());
  let depth = 0;
  for (const tok of tokens) {
    if (tok === headTok) return depth > 0;
    if (tok.quoted || kept.has(tok)) continue; // an argument, or a separator
    if (tok.text === 'do') depth += 1;
    else if (tok.text === 'done' && depth > 0) depth -= 1;
  }
  return false;
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

  // The bypass is checked against THE CREATE STATEMENT, never against any
  // statement in the chain. Getting this wrong is a security regression, and it
  // was one: scoping the MATCH to statements while leaving the BYPASS a boolean
  // over the whole command let an appended decoy lift the gate for a real call.
  // Reproduced 2026-08-23 against the live policy (`glab issue create --label ci`
  // is a real bypass_patterns entry):
  //   "glab issue create --title A"                                  -> DENY
  //   "glab issue create --title REAL; glab issue create --label ci" -> ALLOW
  // The second one creates an untemplated issue titled REAL. The pre-#1106 code
  // was not vulnerable here — it prefix-matched the whole command, so a TRAILING
  // pattern could not match. Widening the matcher without narrowing this opened it.
  //
  // The documented intent still holds: `cd /repo && gh pr create --dry-run` must
  // remain exempt when `gh pr create --dry-run` is a bypass entry — that is the
  // create statement itself, so it matches.
  const create = findCreateStatement(command);
  if (!create) return false;
  const tokens = create.tokens;

  for (const pat of bypassPatterns) {
    if (typeof pat !== 'string' || pat.length === 0) continue;
    const patStatements = statementsOf(pat);
    // A pattern that lexes to nothing (whitespace-only, comment-only) would
    // prefix-match EVERY statement — treat it as no pattern at all.
    if (patStatements.length === 0) continue;
    const patTokens = patStatements[0].map((t) => t.text);
    if (patTokens.length === 0) continue;

    if (tokens.length < patTokens.length) continue;
    if (patTokens.every((text, i) => tokens[i].text === text)) return true;
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
  return titleFromTokens(tokens);
}
