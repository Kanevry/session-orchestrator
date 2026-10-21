#!/usr/bin/env node
/**
 * check-vcs-repo-flag.mjs — census of `gh`/`glab` invocations that omit `--repo`/`-R`.
 *
 * ## The defect class (issue #971)
 *
 * `gh` and `glab` resolve their target repository from the AMBIENT git remote of
 * the process's cwd whenever `--repo`/`-R` is absent. That is invisible and
 * correct in an operator's own checkout, and wrong everywhere the cwd is not the
 * repo the command means: a sibling worktree, an `/autopilot` child process, a
 * dispatched wave-agent, a consumer repo that copied a template, or any host
 * whose `origin` points at a fork. The failure is silent — the command succeeds
 * against the WRONG project. `scripts/lib/vcs-repo-spec.mjs` exists precisely to
 * produce the spec such a call site should pass; this check finds the call sites
 * that never learned to.
 *
 * ## Mode: WARN, never blocking
 *
 * Findings print as `WARN:` and the runner returns 0. `FAIL:` is reserved for
 * the tool-error path (an unreadable tree). This is load-bearing, not
 * stylistic: `scripts/validate-plugin.mjs` tallies `^[ ]{2}FAIL:` lines from
 * EVERY sub-check into a module-wide counter and exits 1 if that counter is
 * non-zero — the sub-check's own exit code is deliberately discarded for
 * WARN-only checks. A single `FAIL:` line here would therefore red the whole
 * validator (and with it three CI-reachable test files) on a census that was
 * ~40 findings on the day it landed. Warn first, ratchet later once the Wave-3
 * sweep has drained the backlog.
 *
 * ## Classification, and why the naive grep is >50% noise
 *
 * A broad `grep -n 'gh\|glab'` over this repo returns ~244 line matches; only a
 * minority are invocations. Four filters do the separating, each measured:
 *
 *  1. **Markdown: a fence, or it is prose.** A CommonMark fence state machine
 *     (both ``` and ~~~, nesting-aware via marker length) gates every markdown
 *     match. Only ```bash / ```sh / ```shell / ```console fences are candidates.
 *     A match with no fence at all — a table cell, a bullet, running text — is
 *     prose. A non-shell fence (```js, ```yaml) is prose.
 *  2. **Shell comments inside a shell fence are prose** (`^\s*#`).
 *  3. **JS/MJS: comment lines are prose** (`^\s*(//|/*|*)`), and a match inside
 *     a string literal counts only when the command STARTS the literal (after
 *     optional whitespace) AND the literal carries no `${` interpolation. That
 *     second half is what separates
 *     `'  glab ci status --branch main'` (a real command handed to a
 *     shell) from `` `glab note add spawn error: ${err}` `` (a log message).
 *  4. **The first token after the CLI must be a REAL top-level subcommand** of
 *     that CLI, measured from `gh --help` / `glab --help` (gh 2.86.0,
 *     glab 1.91.0, probed 2026-08-14). This alone kills the prose residue that
 *     survives filters 1–3 — `glab or gh`, `glab output could`, `glab exited`,
 *     `glab not found`, `glab is`, `glab then` were all live matches in the raw
 *     census.
 *
 * ## D-NA — where `--repo` does not exist, so its absence is not a defect
 *
 * Every entry below was probed against the installed binaries on 2026-08-14
 * (gh 2.86.0, glab 1.91.0) by grepping the subcommand's own `--help` for
 * `-R,? --repo` and, for the disputed cases, by executing the flag:
 *
 *  - `gh api` / `glab api` — neither documents `--repo`; both document
 *    `--hostname`. `gh api -R x /user` → `unknown shorthand flag: 'R'`.
 *    `glab` accepts `-R` here only because it is an inherited root flag, and it
 *    changes nothing: the endpoint path IS the target. The instrument for these
 *    is `resolveRepoHost()` — see `scripts/lib/vcs-repo-spec.mjs` § hostname.
 *  - `gh repo <*>` — `gh repo view -R cli/cli` → `unknown shorthand flag: 'R'`.
 *    The `repo` group takes a POSITIONAL `[<repository>]`.
 *  - `gh auth`/`gh config`/`gh extension`/`gh alias`/`gh completion`/`gh status`
 *    and `glab auth`/`glab config`/`glab group`/`glab completion`/`glab alias`/
 *    `glab check-update`/`glab version`/`glab help` — host- or client-scoped,
 *    no repo concept (`gh auth status -R x` → `unknown shorthand flag: 'R'`).
 *
 * **`glab repo <*>` is deliberately NOT D-NA, and the asymmetry with `gh repo`
 * is real.** `glab repo view -R gitlab-org/cli` is ACCEPTED (it produced a
 * `404 Not Found` from the configured host, i.e. the flag resolved the target)
 * because `-R/--repo` is a persistent root flag on `glab` — it does not appear
 * in `glab repo view --help`'s own FLAGS block, so a help-text-only census
 * would get this backwards.
 *
 * ## Conditional `--repo` — where the flag exists but REQUIRES a positional
 *
 * A third class sits between "applicable" and D-NA: subcommands whose positional
 * is OPTIONAL (it defaults to the current branch's PR) but becomes MANDATORY the
 * moment `-R` appears. Adding `-R` to such a call without also pinning a
 * PR/branch does not harden it — it BREAKS it at runtime. Reporting these is
 * therefore worse than useless: the "fix" is the regression.
 *
 * Measured 2026-08-14 against gh 2.86.0, one probe per subcommand, `cwd=/tmp`
 * (no git remote, so nothing ambient can mask the result):
 *
 *   gh pr checks  -R cli/cli        → argument required when using the `--repo` flag
 *   gh pr checks  -R cli/cli trunk  → no pull requests found for branch "trunk"  (flag accepted)
 *   gh pr view    -R cli/cli        → argument required when using the --repo flag
 *   gh pr diff    -R cli/cli        → argument required when using the `--repo` flag
 *   gh pr ready   -R cli/cli        → argument required when using the --repo flag
 *   gh pr merge   -R cli/cli        → argument required when using the --repo flag
 *   gh pr comment -R cli/cli        → argument required when using the --repo flag
 *
 * The rule is POSITIONAL-DEPENDENT, never subcommand-blanket: `gh pr checks 123`
 * and `gh pr view 4711` both accept `-R` happily, so a bare one of those is
 * still a genuine finding. Only the no-positional form is excluded.
 *
 * Three neighbouring shapes were probed and deliberately EXCLUDED from the table
 * because their error is Cobra arity, not a `--repo` interaction — the positional
 * is mandatory there with or without the flag, so no `-R` advice is being
 * suppressed: `gh pr close`/`reopen` (`cannot close pull request: number, url,
 * or branch required` / `accepts 1 arg(s), received 0`), every `gh issue <*>`
 * (`gh issue view -R cli/cli` → `accepts 1 arg(s), received 0`), and
 * `gh release delete`/`edit` (same arity message). `gh pr list`, `gh pr status`,
 * `gh issue list` and `gh release view`/`list` all RAN against `cli/cli` with
 * `-R` and no positional — those stay fully applicable.
 *
 * **The glab side of this table is empty by measurement, not by omission.**
 * `glab mr view -R gitlab-org/cli` and `glab ci status -R gitlab-org/cli` (no
 * positional, glab 1.91.0, 2026-08-14) were both ACCEPTED by the CLI and failed
 * downstream at the configured host (exit 1, `ERROR` block), never at flag
 * parsing. glab has no equivalent of gh's conditional-positional check.
 *
 * Note what a help-text-derived rule would have concluded here: `gh pr checks
 * --help` lists `-R, --repo` under INHERITED FLAGS with no caveat whatsoever.
 * Reading the help would have marked this call site as a plain finding. Only
 * executing the binary shows the constraint — same lesson as the `glab repo`
 * asymmetry above, in the opposite direction.
 *
 * ## Rejected flags (issue #1024)
 *
 * `check-vcs-repo-flag-positional.mjs` uses the same scan engine in rejected
 * mode, with its own finding kind and advice: name the PR or drop the flag.
 * The default census still reports only missing repo flags.
 *
 * ## Named coverage gaps (v1) — read these before quoting the count
 *
 *  - **Variable argv arrays are not resolved.** `spawnSync('glab', glabArgs)`
 *    cannot be judged from the call site; only a LITERAL array is inspected.
 *    Measured 2026-08-14: 5 direct `execFile*`/`spawn*` sites naming `gh`/`glab`
 *    in `scripts/`+`hooks/`, 4 of them variable-args. The count is reported as
 *    `unresolvedArgv` in the summary so the hole is visible in the output, not
 *    only in this comment.
 *  - **Interpolated command templates are skipped** (filter 3). A genuine
 *    `` `glab issue view ${n}` `` is invisible. The alternative — treating every
 *    interpolated string as a command — readmits the four log-message templates
 *    this repo actually has, which is the worse trade at v1. The mirror hole:
 *    an INTERPOLATION-FREE log string that happens to open with a real
 *    subcommand (`log('glab issue list failed')`) would be reported as a call
 *    site. This repo has none today; filter 4 catches the common shapes
 *    (`glab note add …` is not a real subcommand).
 *  - **Backtick-command bullets in skill prose are classified as prose**, per
 *    filter 1. `skills/discovery/SKILL.md` and `skills/plan/SKILL.md` both carry
 *    list items whose inline-code command the coordinator copies verbatim —
 *    formally prose, operationally an instruction. Calling them prose is a
 *    DELIBERATE choice: the alternative (treating inline code as a command)
 *    matched every `` `glab` `` mention in every rule file. The Wave-3 sweep
 *    should read those two files by hand.
 *  - **A shell fence NESTED inside a wider (4+ backtick) fence is content, not a
 *    fence** — CommonMark-correct, but it means its commands are invisible.
 *    Measured 2026-08-14: `grep -rn '^\s*\x60\x60\x60\x60' skills docs agents
 *    commands .claude templates` → 0 matches, so the gap is inert today.
 *  - **`tests/` is excluded from the corpus.** A test that asserts on a command
 *    string is not a sweep target; including them added 42 raw matches of pure
 *    noise.
 *  - **Only `.md` and `.mjs`/`.js`/`.cjs` are scanned.** `.sh`, `.yml`, and
 *    `.gitlab-ci.yml` are outside v1 (raw census: 0 matches there today).
 *  - **A leading flag before the subcommand is not resolved.** `glab -R x issue
 *    list` yields no subcommand token and is counted as `skippedLeadingFlag`,
 *    never as a finding. Measured 0 occurrences in this repo.
 *  - Files are read with `readFileSync`, never a `grep` spawn: one NUL byte
 *    makes a text file invisible to grep-based audits (see
 *    `.claude/rules/anti-pattern-a-nul-byte-in-a-tracked-production-file-...md`),
 *    which would silently drop call sites and understate the census.
 *
 * Import-safety: importing this module exposes the inspector and runner only;
 * the CLI path is guarded at the bottom of the file.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SHELL_LANGS, forEachLine } from './markdown-fences.mjs';
import { isMainModule } from '../is-main-module.mjs';
import { tokenizeCommand, redirectSpanEnd } from '../command-blocker.mjs';

/** Directories whose content is scanned. Root-level `*.md` is added separately. */
const SCAN_DIRS = Object.freeze([
  '.claude',
  'agents',
  'commands',
  'docs',
  'hooks',
  'scripts',
  'skills',
  'templates',
]);

/** Directory names excluded at any depth. `tests` — see § Named coverage gaps. */
const EXCLUDED_DIRS = Object.freeze([
  'node_modules',
  '.git',
  'tests',
  'test',
  '__tests__',
  'coverage',
  'dist',
]);

/** Markdown extensions (fence state machine applies). */
const DOC_EXTENSIONS = Object.freeze(['.md']);

/** Code extensions (comment + string-literal rules apply). */
const CODE_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs']);

/**
 * Real top-level subcommands, harvested from `gh --help` / `glab --help`
 * (gh 2.86.0 / glab 1.91.0, 2026-08-14). Filter 4: a token that is not in this
 * set is prose, not a subcommand.
 */
const SUBCOMMANDS = Object.freeze({
  gh: Object.freeze(
    new Set([
      'actions', 'agent-task', 'alias', 'api', 'attestation', 'auth', 'browse', 'cache',
      'codespace', 'completion', 'config', 'copilot', 'environment', 'extension', 'gist',
      'gpg-key', 'issue', 'label', 'org', 'pr', 'project', 'release', 'repo', 'ruleset',
      'run', 'search', 'secret', 'ssh-key', 'status', 'variable', 'workflow',
    ]),
  ),
  glab: Object.freeze(
    new Set([
      'alias', 'api', 'attestation', 'auth', 'changelog', 'check-update', 'ci', 'cluster',
      'completion', 'config', 'deploy-key', 'duo', 'gpg-key', 'help', 'incident', 'issue',
      'iteration', 'job', 'label', 'mcp', 'milestone', 'mr', 'opentofu', 'pipeline',
      'release', 'repo', 'runner', 'runner-controller', 'schedule', 'securefile', 'snippet',
      'ssh-key', 'stack', 'token', 'user', 'variable', 'version', 'work-items',
    ]),
  ),
});

/**
 * Subcommand groups where `--repo`/`-R` does not apply. See § D-NA in the header
 * for the per-entry probe evidence. Keyed on the FIRST subcommand token.
 */
const NOT_APPLICABLE = Object.freeze({
  gh: Object.freeze(
    new Set(['api', 'repo', 'auth', 'config', 'extension', 'alias', 'completion', 'status']),
  ),
  glab: Object.freeze(
    new Set(['api', 'auth', 'config', 'group', 'completion', 'alias', 'check-update', 'version', 'help']),
  ),
});

/**
 * Subcommand groups whose SECOND positional argument IS the repository, so an
 * explicit positional makes the invocation unambiguous without `--repo`.
 * `glab repo view group/project` is as explicit as `glab repo view -R
 * group/project`; `glab repo view --output json` is not. (`gh repo` is D-NA —
 * it has no `-R` at all — so this table only ever needs the glab side.)
 */
const POSITIONAL_REPO_GROUPS = Object.freeze({
  gh: Object.freeze(new Set()),
  glab: Object.freeze(new Set(['repo'])),
});

/**
 * `<group> <subcommand>` pairs where `--repo`/`-R` is CONDITIONAL: legal with a
 * positional, rejected without one. Keyed `cli → group → Set(subcommand)`. See
 * § Conditional `--repo` in the header for the per-entry probe transcript; the
 * glab side is empty by measurement.
 */
const REPO_FLAG_NEEDS_POSITIONAL = Object.freeze({
  gh: Object.freeze({
    pr: Object.freeze(new Set(['checks', 'view', 'diff', 'ready', 'merge', 'comment'])),
  }),
  glab: Object.freeze({}),
});

/**
 * Does this token stand in for a positional argument? A flag does not, and
 * neither does a shell redirect — `gh pr checks 2>&1` names no PR, so reading
 * `2>&1` as one would both hide a real finding here and manufacture a phantom
 * `explicitPositional` for `glab repo view 2>&1`.
 *
 * @param {string | undefined} token
 * @returns {boolean}
 */
function looksPositional(token) {
  return Boolean(token) && !token.startsWith('-') && !/^\d*[<>]/.test(token);
}

/**
 * Is `-R` unavailable here because the conditional-positional rule bites — i.e.
 * would adding the flag BREAK this call rather than harden it?
 *
 * Two deliberate conservatisms, both erring toward reporting rather than
 * silence, because a wrongly-suppressed call site is invisible forever while a
 * wrongly-reported one is one sweep read away:
 *
 *  1. The bare census consults this AFTER the repo-flag branch. The separate
 *     rejected-flag check first removes option values from the token stream.
 *  2. ANY positional-looking token past the subcommand disarms the rule. A flag
 *     VALUE (`--json state` → `state`) can be mistaken for a positional; that
 *     mistake yields a finding, never a suppression.
 *
 * @param {'gh'|'glab'} cli
 * @param {string} group first subcommand token (`pr`)
 * @param {string | undefined} sub second token (`checks`)
 * @param {string[]} rest every token past the subcommand pair
 * @returns {boolean}
 */
function repoFlagBlockedByMissingPositional(cli, group, sub, rest) {
  const subs = REPO_FLAG_NEEDS_POSITIONAL[cli][group];
  if (!subs || !sub || !subs.has(sub)) return false;
  return !rest.some(looksPositional);
}

/**
 * Known value-taking options of the six conditional gh pr subcommands.
 * Unknown options retain the census's conservative positional heuristic;
 * revisit this list when gh adds a value-taking option to these commands.
 */
const PR_VALUE_FLAGS = new Set([
  '-R', '--repo', '--json', '-q', '--jq', '-t', '--template', '-i', '--interval',
  '--color', '-A', '--author-email', '-b', '--body', '-F', '--body-file',
  '--subject', '--match-head-commit',
]);

/** @param {string[]} args @returns {boolean} a repo option, not another option's value */
function repoFlagPresent(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') break;
    if (arg === '-R' || arg === '--repo' || arg.startsWith('--repo=') || /^-R.+/.test(arg)) return true;
    if (PR_VALUE_FLAGS.has(arg)) index += 1;
  }
  return false;
}

/** @param {string[]} args @returns {string[]} args without option values */
function withoutOptionValues(args) {
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') return rest.concat(args.slice(index + 1));
    if (PR_VALUE_FLAGS.has(arg)) index += 1;
    else if (!arg.startsWith('-')) rest.push(arg);
  }
  return rest;
}

/** Strip shell comments at word boundaries, retaining quoted/escaped hashes.
 * @param {string} text @returns {string}
 */
function stripShellComment(text) {
  let quote = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && quote !== "'") { index += 1; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '#' && (index === 0 || /[\s;|&()]/.test(text[index - 1]))) return text.slice(0, index);
  }
  return text;
}

/**
 * A `--repo`/`-R` occurrence. `--repo=x`, `-R x` and `-R"$SPEC"` all count;
 * `--repository` does not (the `\b` blocks it) and neither does a `-R` glued to
 * a bare word (`-Rfoo`), which no call site in this repo uses.
 */
const REPO_FLAG_RE = /(?<![\w-])(?:--repo\b|--repo=|-R\b|-R(?=["'$]))/;

/**
 * Command position: start of line, or after a shell separator / substitution
 * opener, optionally preceded by `VAR=value` assignments.
 */
const COMMAND_RE = /(?:^|[|;&(]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(gh|glab)(?=\s)/g;

/**
 * Slice the text following a matched `gh`/`glab` token into this invocation's
 * segment, and project out the part that is the OUTER command's own argv.
 *
 * Two jobs in one walk, because they share the concept a character-class stop
 * regex cannot express — where a COMMAND SUBSTITUTION begins and ends:
 *
 *  1. **Where the invocation ends.** `|`, `;`, `||`, `&&` and `)` end a command
 *     only at substitution depth 0 (`&` alone never does — `2>&1`). A `)`-blind
 *     stop cuts `glab issue create --title "$(date)" -R g/p` before its flag and
 *     reports an already-correct call site.
 *  2. **Whose `-R` is this.** Everything inside `$( … )` or backticks is a
 *     DIFFERENT command's argv. `glab issue list $(grep -R pattern src)` carries
 *     no repo flag at all — the `-R` is grep's (`cp`, `ls`, `rsync`, `chmod`
 *     spell it the same way). Crediting it to the outer call is the one failure
 *     direction this census must not have: unlike every gap named in the header,
 *     which merely omits a call site, this reports a BARE invocation as already
 *     hardened — and the `0 bare` that results is the number a sweep declares
 *     itself finished on. A `-R` that sits OUTSIDE the substitution is still the
 *     outer command's own, substitution-valued or not: `-R $(cat repo.txt)`
 *     counts.
 *
 * The outer projection replaces each substitution with an opaque argument
 * placeholder. Only placeholders in possible PR positions suppress a finding;
 * option values and redirect operands are removed first. Quote and
 * escape state are evaluated before command separators can end the segment.
 *
 * @param {string} rest text following the matched CLI token
 * @returns {{segment: string, outer: string, unresolved: boolean}} full segment, and its depth-0 projection
 */
function sliceInvocation(rest) {
  let segment = '';
  let outer = '';
  let depth = 0;
  let inBacktick = false;
  let quote = '';
  let unresolved = false;

  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    const pair = rest.slice(index, index + 2);

    if (depth === 0 && !inBacktick) {
      if (char === '\\' && quote !== "'") {
        segment += rest.slice(index, index + 2);
        outer += rest.slice(index, index + 2);
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = '';
        segment += char;
        outer += char;
        continue;
      }
      if (!quote && (char === '"' || char === "'")) {
        quote = char;
        segment += char;
        outer += char;
        continue;
      }
      if (!quote && (pair === '||' || pair === '&&' ||
        (char === '|' && rest[index - 1] !== '>') || char === ';' || char === ')')) break;
      if (quote !== "'" && pair === '$(') {
        unresolved = true;
        depth = 1;
        segment += pair;
        outer += '__SO_UNRESOLVED__';
        index += 1;
        continue;
      }
      if (quote !== "'" && char === '`') {
        unresolved = true;
        inBacktick = true;
        segment += char;
        outer += '__SO_UNRESOLVED__';
        continue;
      }
      segment += char;
      outer += char;
      continue;
    }

    segment += char;
    if (inBacktick) {
      if (char === '`') inBacktick = false;
      continue;
    }
    if (pair === '$(') {
      depth += 1;
      segment += '(';
      index += 1;
      continue;
    }
    if (char === ')') depth -= 1;
  }

  return { segment, outer, unresolved };
}

/** Snippet budget — see § stdout budget at the CLI guard. */
const SNIPPET_MAX = 200;

/**
 * @typedef {{
 *   kind: 'missing-repo-flag-doc' | 'missing-repo-flag-code' | 'repo-flag-missing-positional' | 'tool-error',
 *   file: string,
 *   line: number,
 *   cli: 'gh' | 'glab' | '-',
 *   command: string,
 *   message: string,
 * }} Finding
 */

/**
 * @typedef {{
 *   applicable: number,
 *   notApplicable: number,
 *   positionalRequired: number,
 *   withFlag: number,
 *   explicitPositional: number,
 *   unknownSubcommand: number,
 *   skippedLeadingFlag: number,
 * }} Tally
 */

/**
 * Recursively collect scannable files, skipping symlinks and excluded dirs.
 *
 * @param {string} directory absolute directory path
 * @param {string[]} [acc]
 * @returns {string[]} absolute file paths
 */
function walk(directory, acc = []) {
  if (!existsSync(directory)) return acc;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (EXCLUDED_DIRS.includes(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, acc);
      continue;
    }
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name);
    if (DOC_EXTENSIONS.includes(extension) || CODE_EXTENSIONS.includes(extension)) acc.push(fullPath);
  }
  return acc;
}

/** @param {string} text @returns {string} clamped, single-line snippet */
function clampSnippet(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1)}…` : flat;
}

/**
 * Extract every `gh`/`glab` invocation from one logical (continuation-joined)
 * command line, classifying each against the subcommand + D-NA tables.
 *
 * @param {string} text the logical command line
 * @param {Tally} tally mutated in place
 * @param {boolean} [rejected] collect rejected flags instead of missing flags
 * @returns {{cli: 'gh'|'glab', command: string, segment: string}[]} findings-worthy invocations
 */
export function extractBareInvocations(text, tally, rejected = false) {
  text = stripShellComment(text);
  /** @type {{cli: 'gh'|'glab', command: string, segment: string}[]} */
  const bare = [];
  COMMAND_RE.lastIndex = 0;
  /** @type {RegExpExecArray | null} */
  let matched;
  while ((matched = COMMAND_RE.exec(text)) !== null) {
    const cli = /** @type {'gh'|'glab'} */ (matched[1]);
    const { segment, outer } = sliceInvocation(text.slice(matched.index + matched[0].length));

    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    if (tokens[0].startsWith('-')) {
      tally.skippedLeadingFlag += 1;
      continue;
    }
    const head = tokens[0];
    if (!SUBCOMMANDS[cli].has(head)) {
      tally.unknownSubcommand += 1;
      continue;
    }
    if (NOT_APPLICABLE[cli].has(head)) {
      tally.notApplicable += 1;
      continue;
    }

    tally.applicable += 1;
    // `outer`, never `segment`: a `-R` inside a command substitution belongs to
    // the inner command — see `sliceInvocation` job 2.
    const argv = rejected ? tokenizeCommand(outer) : [];
    const args = [];
    for (let index = 0; index < argv.length; index += 1) {
      if (argv[index].redirect) index = redirectSpanEnd(argv, index);
      else args.push(argv[index].text);
    }
    if (rejected ? repoFlagPresent(args.slice(2)) : REPO_FLAG_RE.test(outer)) {
      tally.withFlag += 1;
      if (rejected && repoFlagBlockedByMissingPositional(cli, head, tokens[1], withoutOptionValues(args.slice(2)))) {
        bare.push({ cli, command: `${cli} ${head} ${tokens[1]}`, segment });
      }
      continue;
    }
    if (rejected) continue;
    if (repoFlagBlockedByMissingPositional(cli, head, tokens[1], tokens.slice(2))) {
      tally.positionalRequired += 1;
      continue;
    }
    if (POSITIONAL_REPO_GROUPS[cli].has(head) && looksPositional(tokens[2])) {
      tally.explicitPositional += 1;
      continue;
    }
    const second = tokens[1] && !tokens[1].startsWith('-') ? ` ${tokens[1]}` : '';
    bare.push({ cli, command: `${cli} ${head}${second}`, segment });
  }
  return bare;
}

/**
 * Join `\`-continuation lines into logical lines, keeping the START line number.
 *
 * @param {{line: number, text: string}[]} entries
 * @returns {{line: number, text: string}[]}
 */
function joinContinuations(entries) {
  /** @type {{line: number, text: string}[]} */
  const joined = [];
  for (let index = 0; index < entries.length; index += 1) {
    const { line } = entries[index];
    let { text } = entries[index];
    while (/\\\s*$/.test(text) && index + 1 < entries.length && entries[index + 1].line === entries[index].line + 1) {
      index += 1;
      text = `${text.replace(/\\\s*$/, '')} ${entries[index].text.trim()}`;
    }
    joined.push({ line, text });
  }
  return joined;
}

/**
 * Read the heredoc delimiter word starting at `start` and apply shell quote
 * removal: `\EOF`, `'EOF'`, `"EOF"` and `E"O"F` all name the terminator `EOF`.
 * @param {string} text @param {number} start
 * @returns {{word: string, end: number}} `end` = index after the word
 */
function readDelimiterWord(text, start) {
  let word = '';
  let index = start;
  for (; index < text.length; index += 1) {
    const char = text[index];
    if (/[\s;|&<>()]/.test(char)) break;
    if (char === '\\') { index += 1; word += text[index] ?? ''; continue; }
    if (char === "'" || char === '"') {
      const close = text.indexOf(char, index + 1);
      const stop = close === -1 ? text.length : close;
      const quoted = text.slice(index + 1, stop);
      word += char === '"' ? quoted.replace(/\\([\\"$`])/g, '$1') : quoted;
      index = stop;
      continue;
    }
    word += char;
  }
  return { word, end: index };
}

/**
 * Index just past the `))` closing the arithmetic `((` at `start`, so a shift
 * operator inside `$(( ))` / `(( ))` is never read as a heredoc.
 * @param {string} text @param {number} start @returns {number}
 */
function arithmeticEnd(text, start) {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')' && --depth === 0) return index + 1;
  }
  return text.length;
}

/**
 * Find heredoc delimiters outside quoted/escaped shell text and arithmetic.
 * Their bodies are unresolved data for the positional check, including an
 * unterminated body.
 * @param {string} text
 * @returns {{word: string, stripTabs: boolean}[]}
 */
function heredocDelimiters(text) {
  const delimiters = [];
  let quote = '';
  text = stripShellComment(text);
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\' && quote !== "'") { index += 1; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (text.startsWith('((', index)) { index = arithmeticEnd(text, index) - 1; continue; }
    if (text.startsWith('<<<', index)) { index += 2; continue; }
    if (!text.startsWith('<<', index)) continue;
    const head = /^<<(-?)[ \t]*/.exec(text.slice(index));
    const { word, end } = readDelimiterWord(text, index + head[0].length);
    if (word) delimiters.push({ word, stripTabs: head[1] === '-' });
    index = Math.max(index + 1, end - 1);
  }
  return delimiters;
}

/**
 * Scan a markdown file: fence state machine → shell fences only → drop shell
 * comments → join continuations → classify.
 *
 * @param {string} relative repo-relative path
 * @param {string} body file content
 * @param {Tally} tally mutated in place
 * @param {boolean} [rejected] collect rejected flags instead of missing flags
 * @returns {Finding[]}
 */
export function scanMarkdown(relative, body, tally, rejected = false) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{line: number, text: string}[]} */
  const shellLines = [];
  /** @type {{word: string, stripTabs: boolean}[]} */
  let pendingHeredocs = [];
  // Delimiters of the logical line still being continued: a body starts only
  // after the line that ends the `\`-continued command (same test as joinContinuations).
  /** @type {{word: string, stripTabs: boolean}[]} */
  let lineHeredocs = [];
  let previousLine = 0;

  forEachLine(body, (raw, { lineNumber, inFence, lang }) => {
    if (!inFence || !SHELL_LANGS.has(lang)) return;
    // Fence markers are omitted by forEachLine; a gap resets shell context.
    if (lineNumber !== previousLine + 1) { pendingHeredocs = []; lineHeredocs = []; }
    previousLine = lineNumber;
    if (rejected && pendingHeredocs.length) {
      const pending = pendingHeredocs[0];
      if ((pending.stripTabs ? raw.replace(/^\t+/, '') : raw) === pending.word) pendingHeredocs.shift();
      return;
    }
    const stripped = raw.replace(/^\s*[$❯>]\s+/, '');
    if (/^\s*#/.test(stripped)) return;
    if (rejected) {
      lineHeredocs.push(...heredocDelimiters(stripped));
      if (!/\\\s*$/.test(stripped)) { pendingHeredocs = lineHeredocs; lineHeredocs = []; }
    }
    shellLines.push({ line: lineNumber, text: stripped });
  });

  for (const entry of joinContinuations(shellLines)) {
    for (const hit of extractBareInvocations(entry.text, tally, rejected)) {
      findings.push({
        kind: rejected ? 'repo-flag-missing-positional' : 'missing-repo-flag-doc',
        file: relative,
        line: entry.line,
        cli: hit.cli,
        command: hit.command,
        message: rejected ? rejectedFlagMessage(hit.command) :
          `\`${hit.command}\` runs without --repo/-R — the target project comes from the ambient ` +
          `cwd remote: ${clampSnippet(`${hit.cli}${hit.segment}`)}`,
      });
    }
  }
  return findings;
}

/**
 * A `gh`/`glab` token that OPENS a string literal (quote, optional whitespace,
 * then the CLI name). Filter 3: only such a literal is a shell command handed to
 * something; a CLI name in the middle of a string is a message about a command.
 */
const CODE_STRING_CMD_RE = /(['"`])\s*(?=(?:gh|glab)\s)/g;

/**
 * Scan a literal `execFile*`/`spawn*` argv array. A non-literal args argument is
 * counted as `unresolvedArgv` and never judged.
 *
 * @param {string} body file content
 * @returns {{literals: {index: number, cli: 'gh'|'glab', args: string[]}[], unresolved: number}}
 */
export function scanArgvCalls(body) {
  const callRe = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*['"](gh|glab)['"]\s*,\s*/g;
  /** @type {{index: number, cli: 'gh'|'glab', args: string[]}[]} */
  const literals = [];
  let unresolved = 0;
  /** @type {RegExpExecArray | null} */
  let matched;
  while ((matched = callRe.exec(body)) !== null) {
    const after = body.slice(matched.index + matched[0].length);
    if (!after.startsWith('[')) {
      unresolved += 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    let quote = '';
    let uncommented = '';
    for (let index = 0; index < after.length; index += 1) {
      const char = after[index];
      if (quote) {
        uncommented += char;
        if (char === '\\') { uncommented += after[index + 1] ?? ''; index += 1; }
        else if (char === quote) quote = '';
        continue;
      }
      if (after.startsWith('//', index)) {
        const newline = after.indexOf('\n', index + 2);
        if (newline === -1) break;
        uncommented += ' ';
        index = newline;
        continue;
      }
      if (after.startsWith('/*', index)) {
        const close = after.indexOf('*/', index + 2);
        if (close === -1) break;
        uncommented += ' ';
        index = close + 1;
        continue;
      }
      uncommented += char;
      if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
      if (char === '[') depth += 1;
      else if (char === ']') {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    if (end === -1) {
      unresolved += 1;
      continue;
    }
    const inner = uncommented.slice(1, -1);
    if (inner.includes('...') || /\$\{/.test(inner)) {
      unresolved += 1;
      continue;
    }
    // Consume the entire array, never just its quoted fragments. Escaped or
    // computed strings are deliberately unresolved rather than partly decoded.
    const literal = /\s*(?:'([^'\\]*)'|"([^"\\]*)")\s*(?:,|$)/gy;
    const args = [];
    let consumed = 0;
    let item;
    while ((item = literal.exec(inner)) !== null) {
      args.push(item[1] ?? item[2]);
      consumed = literal.lastIndex;
    }
    if (inner.slice(consumed).trim()) {
      unresolved += 1;
      continue;
    }
    literals.push({ index: matched.index, cli: /** @type {'gh'|'glab'} */ (matched[1]), args });
  }
  return { literals, unresolved };
}

/**
 * Scan a JS/MJS file: comment lines are prose; a match counts only when it
 * starts an interpolation-free string literal. Literal argv arrays are judged
 * separately.
 *
 * @param {string} relative repo-relative path
 * @param {string} body file content
 * @param {Tally} tally mutated in place
 * @param {boolean} [rejected] collect rejected flags instead of missing flags
 * @returns {{findings: Finding[], unresolvedArgv: number}}
 */
export function scanCode(relative, body, tally, rejected = false) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = body.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    if (/^\s*(\/\/|\/\*|\*)/.test(raw)) continue;
    CODE_STRING_CMD_RE.lastIndex = 0;
    /** @type {RegExpExecArray | null} */
    let matched;
    while ((matched = CODE_STRING_CMD_RE.exec(raw)) !== null) {
      const quote = matched[1];
      const contentStart = matched.index + matched[0].length;
      const closeAt = raw.indexOf(quote, contentStart);
      const literal = closeAt === -1 ? raw.slice(contentStart) : raw.slice(contentStart, closeAt);
      if (literal.includes('${')) continue;
      for (const hit of extractBareInvocations(literal.trim(), tally, rejected)) {
        findings.push({
          kind: rejected ? 'repo-flag-missing-positional' : 'missing-repo-flag-code',
          file: relative,
          line: index + 1,
          cli: hit.cli,
          command: hit.command,
          message: rejected ? rejectedFlagMessage(hit.command) :
            `\`${hit.command}\` in a shell-command string runs without --repo/-R — the target project ` +
            `comes from the ambient cwd remote: ${clampSnippet(`${hit.cli}${hit.segment}`)}`,
        });
      }
    }
  }

  const { literals, unresolved } = scanArgvCalls(body);
  for (const call of literals) {
    const head = call.args[0];
    if (!head || head.startsWith('-')) {
      tally.skippedLeadingFlag += 1;
      continue;
    }
    if (!SUBCOMMANDS[call.cli].has(head)) {
      tally.unknownSubcommand += 1;
      continue;
    }
    if (NOT_APPLICABLE[call.cli].has(head)) {
      tally.notApplicable += 1;
      continue;
    }
    tally.applicable += 1;
    const hasRepoFlag = rejected ? repoFlagPresent(call.args.slice(2)) :
      call.args.some((arg) => arg === '--repo' || arg === '-R' || arg.startsWith('--repo='));
    if (hasRepoFlag) tally.withFlag += 1;
    if (rejected) {
      if (!hasRepoFlag || !repoFlagBlockedByMissingPositional(call.cli, head, call.args[1], withoutOptionValues(call.args.slice(2)))) continue;
    } else if (hasRepoFlag) continue;
    if (!rejected && repoFlagBlockedByMissingPositional(call.cli, head, call.args[1], call.args.slice(2))) {
      tally.positionalRequired += 1;
      continue;
    }
    if (POSITIONAL_REPO_GROUPS[call.cli].has(head) && looksPositional(call.args[2])) {
      tally.explicitPositional += 1;
      continue;
    }
    const line = body.slice(0, call.index).split('\n').length;
    const second = call.args[1] && !call.args[1].startsWith('-') ? ` ${call.args[1]}` : '';
    findings.push({
      kind: rejected ? 'repo-flag-missing-positional' : 'missing-repo-flag-code',
      file: relative,
      line,
      cli: call.cli,
      command: `${call.cli} ${head}${second}`,
      message: rejected ? rejectedFlagMessage(`${call.cli} ${head}${second}`) :
        `\`${call.cli} ${head}${second}\` argv array carries no --repo/-R — the target project comes ` +
        `from the ambient cwd remote: ${clampSnippet(call.args.join(' '))}`,
    });
  }

  return { findings, unresolvedArgv: unresolved };
}

/** @param {string} command @returns {string} */
function rejectedFlagMessage(command) {
  return `\`${command}\`: --repo/-R breaks this call — name the PR positional or drop the flag`;
}

/**
 * Run the full census.
 *
 * @param {string} pluginRoot absolute plugin root
 * @param {{rejected?: boolean}} [options] separate rejected-flag classification
 * @returns {{
 *   ok: boolean,
 *   summary: {
 *     filesScanned: number, docFiles: number, codeFiles: number,
 *     applicable: number, notApplicable: number, positionalRequired: number, withFlag: number,
 *     explicitPositional: number, unknownSubcommand: number, skippedLeadingFlag: number,
 *     unresolvedArgv: number, findings: number,
 *     byKind: Record<string, number>,
 *   },
 *   findings: Finding[],
 *   toolError: boolean,
 * }}
 */
export function inspectVcsRepoFlag(pluginRoot, { rejected = false } = {}) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {Tally} */
  const tally = {
    applicable: 0,
    notApplicable: 0,
    positionalRequired: 0,
    withFlag: 0,
    explicitPositional: 0,
    unknownSubcommand: 0,
    skippedLeadingFlag: 0,
  };
  const result = {
    ok: false,
    summary: {
      filesScanned: 0,
      docFiles: 0,
      codeFiles: 0,
      ...tally,
      unresolvedArgv: 0,
      findings: 0,
      /** @type {Record<string, number>} */
      byKind: {},
    },
    findings,
    toolError: false,
  };

  /** @type {string[]} */
  let files;
  try {
    files = SCAN_DIRS.flatMap((dir) => walk(path.join(pluginRoot, dir)));
    for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
      if (entry.isFile() && DOC_EXTENSIONS.includes(path.extname(entry.name))) {
        files.push(path.join(pluginRoot, entry.name));
      }
    }
    files.sort();
  } catch (error) {
    result.toolError = true;
    findings.push({
      kind: 'tool-error',
      file: '-',
      line: 0,
      cli: '-',
      command: '-',
      message: `cannot enumerate the scan corpus: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }

  let unresolvedArgv = 0;
  let docFiles = 0;
  let codeFiles = 0;

  for (const absolute of files) {
    const relative = path.relative(pluginRoot, absolute);
    /** @type {string} */
    let body;
    try {
      body = readFileSync(absolute, 'utf8');
    } catch (error) {
      result.toolError = true;
      findings.push({
        kind: 'tool-error',
        file: relative,
        line: 0,
        cli: '-',
        command: '-',
        message: `cannot read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return result;
    }
    if (!/\b(?:gh|glab)\b/.test(body)) {
      if (DOC_EXTENSIONS.includes(path.extname(absolute))) docFiles += 1;
      else codeFiles += 1;
      continue;
    }
    if (DOC_EXTENSIONS.includes(path.extname(absolute))) {
      docFiles += 1;
      findings.push(...scanMarkdown(relative, body, tally, rejected));
    } else {
      codeFiles += 1;
      const scanned = scanCode(relative, body, tally, rejected);
      findings.push(...scanned.findings);
      unresolvedArgv += scanned.unresolvedArgv;
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  /** @type {Record<string, number>} */
  const byKind = {};
  for (const item of findings) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;

  result.summary = {
    filesScanned: files.length,
    docFiles,
    codeFiles,
    ...tally,
    unresolvedArgv,
    findings: findings.length,
    byKind,
  };
  result.ok = findings.length === 0;
  return result;
}

/**
 * Run the human-readable validator CLI.
 *
 * WARN-ONLY: findings print as WARN and still return 0. `FAIL:` is emitted only
 * on the tool-error path — see § Mode in the header for why a single stray
 * `FAIL:` line would red the whole `validate-plugin.mjs` gate.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = census completed (with or without findings), 2 = tool error
 */
export function runCheckVcsRepoFlag(pluginRoot) {
  console.log('--- Check: gh/glab invocations without --repo/-R (WARN-only) ---');
  const inspection = inspectVcsRepoFlag(pluginRoot);

  if (inspection.toolError) {
    for (const item of inspection.findings) console.log(`  FAIL: ${item.file} — ${item.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${inspection.findings.length} failed`);
    return 2;
  }

  for (const item of inspection.findings) {
    console.log(`  WARN: [${item.kind}] ${item.file}:${item.line} — ${item.message}`);
  }

  const s = inspection.summary;
  console.log(
    `  PASS: censused ${s.filesScanned} file(s) (${s.docFiles} doc + ${s.codeFiles} code) — ` +
      `${s.applicable} repo-scoped invocation(s), ${s.withFlag} already pass --repo/-R, ` +
      `${s.explicitPositional} name the repo positionally, ${s.findings} bare; ` +
      `${s.notApplicable} where --repo does not apply, ${s.positionalRequired} where --repo needs a ` +
      `positional the call omits, ${s.unknownSubcommand} prose match(es) dropped, ` +
      `${s.unresolvedArgv} variable argv array(s) unjudged`,
  );
  console.log('');
  console.log('Results: 1 passed, 0 failed');
  return 0;
}

const isMain =isMainModule(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const usage =
    'Usage: check-vcs-repo-flag.mjs [<plugin-root>] [--json]\n' +
    '  --json  emit the inspection envelope as a single JSON object on stdout\n' +
    'Exit: 0 census completed (findings are WARN-only) · 1 usage error · 2 tool error';

  if (flags.has('--help')) {
    console.log(usage);
    process.exitCode = 0;
  } else {
    const unknown = [...flags].filter((f) => f !== '--json' && f !== '--help');
    if (unknown.length > 0) {
      console.error(`Unknown flag(s): ${unknown.join(', ')}\n${usage}`);
      process.exitCode = 1;
    } else {
      const pluginRoot = path.resolve(positional[0] ?? process.cwd());
      if (flags.has('--json')) {
        const inspection = inspectVcsRepoFlag(pluginRoot);
        // Data on stdout, diagnostics on stderr (cli-design.md).
        console.log(JSON.stringify(inspection, null, 2));
        process.exitCode = inspection.toolError ? 2 : 0;
      } else {
        process.exitCode = runCheckVcsRepoFlag(pluginRoot);
      }
    }
  }
  // Deliberately NOT `process.exit()`: on a pipe, exiting discards stdout writes
  // still queued in the async write buffer, and the `--json` envelope of this
  // census can outgrow the ~64 KiB pipe capacity. Setting exitCode lets the
  // writes drain first. Snippets are clamped to SNIPPET_MAX for the same reason.
}
