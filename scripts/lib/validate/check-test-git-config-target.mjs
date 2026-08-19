#!/usr/bin/env node
/**
 * check-test-git-config-target.mjs — census of state-MUTATING `git` invocations
 * in `tests/**` that name no explicit target.
 *
 * ## The defect class (2026-08-19 incident)
 *
 * A `git` command that mutates repository state and passes neither `-C <path>`
 * nor a `cwd:` option resolves its target from AMBIENT state: the process's
 * working directory, or an inherited `GIT_DIR`/`GIT_WORK_TREE`. In a test that
 * is invisible and usually harmless — vitest's cwd is the repo root, so the
 * fixture "just works" — right up until the mutation lands in the developer's
 * REAL repository.
 *
 * That happened. A coordinator exported `GIT_DIR="$PWD/.git"` for a hook
 * diagnostic; the export survived into the test run, and because `GIT_DIR`
 * outranks `-C`, fixture helpers retargeted at the real repo: a detached HEAD,
 * three fixture commits, and three entries in `.git/config` (a fixture remote,
 * a fixture `user.email`/`user.name`, `commit.gpgsign=false`). The config
 * entries are invisible to `git status`; two commits reached GitLab AND the
 * public GitHub mirror with the wrong author before anyone noticed.
 *
 * `scripts/lib/git-config-drift.mjs` is the runtime symptom probe for that
 * incident. THIS check is the static half: it finds the call sites where a
 * mutation's destination is decided by ambient state rather than by the call.
 *
 * ## What it does NOT catch — read before quoting a clean run
 *
 * **The incident's own two call sites pass this check.** Measured
 * 2026-08-19: `tests/skills/claude-md-drift-check/checker.test.mjs:355` and
 * `:399` run `spawnSync('git', ['remote','add','gitlab', <fixture url>], { cwd: vault })`
 * — an explicit, correct `cwd`. They still wrote into the real repository,
 * because an inherited `GIT_DIR` beats `cwd` and `-C` alike.
 *
 * So this check addresses a REAL but DIFFERENT subclass (a mutation with no
 * declared destination at all) and is not, on its own, the root-cause gate for
 * the incident. The root-cause gate for the `GIT_DIR` half is environmental —
 * scrubbing `GIT_DIR`/`GIT_WORK_TREE` once, centrally, before any test runs —
 * and lives outside this file. The `gitDirInheritable` counter in the summary
 * measures that second population so the gap is visible in the OUTPUT, not
 * only in this comment.
 *
 * Further named gaps:
 *  - **A non-literal argv array is never judged.** `execFileSync('git', args, …)`
 *    cannot be classified from the call site; counted as `unresolvedArgv`.
 *  - **A spread before the subcommand** (`['-C', dir, ...args]`) leaves the
 *    subcommand unknown; the target IS resolvable, so such sites are simply
 *    not findings.
 *  - **The options object is matched textually** inside the call expression: a
 *    `cwd:` anywhere in it counts as an explicit target. A `cwd` passed as an
 *    opaque variable (`execFileSync('git', [...], opts)`) is counted as
 *    `unresolvedOptions` and never reported.
 *  - **Only `.mjs`/`.js`/`.cjs` under `tests/` are scanned**, and files are
 *    read with `readFileSync`, never a `grep` spawn — one NUL byte makes a
 *    text file invisible to grep-based audits (see
 *    `.claude/rules/anti-pattern-a-nul-byte-in-a-tracked-production-file-....md`).
 *  - **Comment lines are skipped**, so a documented counter-example in a
 *    docblock is not a finding.
 *  - **A match inside a string literal is fixture TEXT, not a call site.**
 *    Without that filter this check reported 8 findings in its OWN test file,
 *    whose positive cases are the anti-pattern written as strings; 23 such
 *    matches exist across `tests/` (2026-08-19). See {@link insideStringLiteral}
 *    for the residual multi-line-template limit.
 *
 * ## Mode: WARN, never blocking
 *
 * Findings print as `WARN:` and the runner returns 0. `FAIL:` is reserved for
 * the tool-error path. This is load-bearing, not stylistic:
 * `scripts/validate-plugin.mjs` tallies `^[ ]{2}FAIL:` lines from EVERY
 * sub-check into a module-wide counter and exits 1 when it is non-zero — the
 * sub-check's own exit code is discarded for WARN-only checks. A single
 * `FAIL:` line here would red the whole validator, and with it the spawner
 * tests that run it. Same posture, and same reason, as
 * `check-vcs-repo-flag.mjs` and `check-unwired-features.mjs`.
 *
 * Import-safety: importing this module exposes the inspector and runner only;
 * the CLI path is guarded at the bottom of the file.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Only this directory is scanned — a mutation in `scripts/` is production intent. */
const SCAN_DIR = 'tests';

/** Extensions scanned. `.md` fixtures under tests/ are prose, not call sites. */
const CODE_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs']);

/**
 * Subcommands that MUTATE repository state, and the argument shapes that make
 * an otherwise-mutating subcommand read-only.
 *
 * The set is the one named in the incident report — `config`, `remote`,
 * `init`, `commit`, `checkout`, `reset`, `add`, `tag` — plus the four that
 * mutate through the same door and appear in this repo's fixtures (`rm`, `mv`,
 * `stash`, `branch`). It is deliberately NOT every mutating git subcommand:
 * a wider set buys no additional true positive here (measured: the same
 * finding list) and each extra entry is an extra false-positive surface.
 *
 * `readOnlyWhen` is consulted against the argv AFTER the subcommand.
 *
 * @type {ReadonlyMap<string, {readOnlyWhen?: RegExp[]}>}
 */
const MUTATING_SUBCOMMANDS = new Map([
  // `git config --get/--list/--get-all/--get-regexp` reads; anything else writes.
  ['config', { readOnlyWhen: [/^--(get|get-all|get-regexp|get-urlmatch|list|l)$/, /^-l$/] }],
  // `git remote` alone (or `-v`/`show`/`get-url`) reads; add/set-url/remove/rename write.
  ['remote', { readOnlyWhen: [/^(-v|--verbose|show|get-url)$/] }],
  ['init', {}],
  ['commit', {}],
  ['checkout', {}],
  ['reset', {}],
  ['add', {}],
  // `git tag -l/--list` reads.
  ['tag', { readOnlyWhen: [/^(-l|--list|--contains|--points-at)$/] }],
  ['rm', {}],
  ['mv', {}],
  ['stash', {}],
  // `git branch` alone / `-l` / `--list` / `-a` reads; -d/-D/-m/-M/<name> writes.
  ['branch', { readOnlyWhen: [/^(-l|--list|-a|--all|-r|--remotes|--show-current|-v|--verbose)$/] }],
]);

/**
 * Subcommands whose own POSITIONAL argument names the repository, so the call
 * is explicitly targeted without `-C` or `cwd:`.
 *
 * This is not a refinement invented at the desk — it is the entire first
 * measurement. The v1 rule (no `-C`, no `cwd:`) reported **11 findings against
 * `tests/` on 2026-08-19, and all 11 were `git init [-q] <dir>`**: a 100%
 * false-positive rate on a shape that is not merely acceptable but the
 * canonical way to create a fixture repo.
 *
 * `clone` is deliberately ABSENT: it creates a new repository rather than
 * mutating an existing one, so it is not in {@link MUTATING_SUBCOMMANDS} to
 * begin with.
 *
 * Maps the subcommand to the flags that CONSUME the following token, so
 * `git init -b main` does not read `main` as the target directory.
 *
 * @type {ReadonlyMap<string, string[]>}
 */
const POSITIONAL_TARGET_SUBCOMMANDS = new Map([
  ['init', ['-b', '--initial-branch', '--template', '--separate-git-dir', '--object-format', '--ref-format', '--shared']],
]);

/**
 * `git config` scope flags that move the write OFF the repository entirely.
 * `--global` writes `~/.gitconfig`, `--system` the machine config, `--file`
 * a named file — none of them needs a repo target, so none is a finding.
 */
const CONFIG_NON_REPO_SCOPES = Object.freeze(['--global', '--system', '--file', '--blob']);

/**
 * `git` global options that consume the NEXT argv token. Needed so the
 * subcommand scan does not mistake an option's VALUE for the subcommand.
 */
const VALUE_TAKING_GLOBALS = Object.freeze(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/** `git` global options that declare an explicit repository target. */
const TARGET_DECLARING_GLOBALS = Object.freeze(['-C', '--git-dir', '--work-tree']);

/** Call shapes that hand an argv ARRAY to a `git` binary. */
const ARGV_CALL_RE = /\b(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*['"]git['"]\s*,\s*/g;

/** Call shapes that hand a SHELL STRING opening with `git` to a shell. */
const SHELL_CALL_RE = /\b(?:execSync|exec)\s*\(\s*(['"`])\s*git\s/g;

/** Matches a `cwd:` property in an options object. */
const CWD_OPTION_RE = /\bcwd\s*:/;

/** Matches a `GIT_DIR`/`GIT_WORK_TREE` mention (an explicit env target). */
const GIT_ENV_TARGET_RE = /\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)\b/;

/**
 * Matches an options-object argument that is an opaque identifier rather than
 * a literal — `execFileSync('git', [...], opts)`. Such a call cannot be judged.
 */
const OPAQUE_OPTIONS_RE = /^\s*,\s*[A-Za-z_$][\w$]*\s*\)/;

/**
 * Recursively collect scannable files under `dir`. Returns `[]` for a missing
 * directory (the caller reports that as a tool error via an empty corpus).
 *
 * @param {string} dir
 * @returns {string[]}
 */
export function walk(dir) {
  /** @type {string[]} */
  const out = [];
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && CODE_EXTENSIONS.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

/**
 * Slice the balanced-bracket region starting at `open` in `text`.
 *
 * @param {string} text
 * @param {number} open index of the opening bracket
 * @param {string} openChar
 * @param {string} closeChar
 * @returns {number} index of the matching close bracket, or -1
 */
function matchBracket(text, open, openChar, closeChar) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === openChar) depth += 1;
    else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * @typedef {{t:'lit', v:string} | {t:'spread'} | {t:'expr'}} ArgvToken
 *   `lit` a string literal · `spread` a `...rest` element · `expr` any other
 *   expression (an identifier, a member access, an interpolated template).
 *
 * The `spread`/`expr` split is load-bearing, not cosmetic: `['init','-q',dir]`
 * carries its target in an `expr` positional, while `['-C',dir,...args]`
 * carries an unknowable tail in a `spread`. Folding both to "opaque" is what
 * produced the first measurement's 11 false positives.
 */

/**
 * Tokenize a literal argv array body into ordered tokens.
 *
 * @param {string} inner text between `[` and `]`
 * @returns {ArgvToken[]}
 */
export function tokenizeArgv(inner) {
  /** @type {ArgvToken[]} */
  const tokens = [];
  const re = /(['"])((?:\\.|(?!\1)[^\\])*)\1|`([^`$]*)`|(\.\.\.)[\w$.[\]]*|([A-Za-z_$][\w$.[\]]*|`[^`]*`)/g;
  /** @type {RegExpExecArray|null} */
  let m;
  while ((m = re.exec(inner)) !== null) {
    if (m[2] !== undefined) tokens.push({ t: 'lit', v: m[2] });
    else if (m[3] !== undefined) tokens.push({ t: 'lit', v: m[3] });
    else if (m[4] !== undefined) tokens.push({ t: 'spread' });
    else tokens.push({ t: 'expr' });
  }
  return tokens;
}

/**
 * Classify a tokenized `git` argv.
 *
 * @param {ArgvToken[]} tokens argv AFTER the `git` binary name
 * @returns {{hasArgvTarget: boolean, subcommand: string|null, rest: ArgvToken[]}}
 */
export function classifyArgv(tokens) {
  let hasArgvTarget = false;
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    // A non-literal in leading-flag position makes the subcommand unknowable;
    // never guess past it.
    if (token.t !== 'lit') return { hasArgvTarget, subcommand: null, rest: [] };
    if (!token.v.startsWith('-')) break;

    const eq = token.v.indexOf('=');
    const bare = eq === -1 ? token.v : token.v.slice(0, eq);
    if (TARGET_DECLARING_GLOBALS.includes(bare)) hasArgvTarget = true;
    if (eq === -1 && VALUE_TAKING_GLOBALS.includes(bare)) index += 2;
    else index += 1;
  }
  if (index >= tokens.length) return { hasArgvTarget, subcommand: null, rest: [] };
  const head = tokens[index];
  return {
    hasArgvTarget,
    subcommand: head.t === 'lit' ? head.v : null,
    rest: tokens.slice(index + 1),
  };
}

/**
 * Decide whether the subcommand's OWN arguments already name the destination:
 * a `git init <dir>` positional, or a `git config --global|--system|--file`
 * scope that does not touch the repository at all.
 *
 * @param {string} subcommand
 * @param {ArgvToken[]} rest argv after the subcommand
 * @returns {boolean}
 */
export function hasSubcommandTarget(subcommand, rest) {
  if (subcommand === 'config') {
    return rest.some((token) => {
      if (token.t !== 'lit') return false;
      const eq = token.v.indexOf('=');
      return CONFIG_NON_REPO_SCOPES.includes(eq === -1 ? token.v : token.v.slice(0, eq));
    });
  }
  const valueFlags = POSITIONAL_TARGET_SUBCOMMANDS.get(subcommand);
  if (!valueFlags) return false;
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    // A spread hides an unknown number of elements — refuse to guess.
    if (token.t === 'spread') return false;
    // An `expr` in positional position is the target directory variable, the
    // dominant fixture shape (`git init -q dir`).
    if (token.t === 'expr') return true;
    if (!token.v.startsWith('-')) return true;
    if (token.v.indexOf('=') === -1 && valueFlags.includes(token.v)) index += 1;
  }
  return false;
}

/**
 * @param {string|null} subcommand
 * @param {ArgvToken[]} rest argv after the subcommand
 * @returns {boolean} true when this invocation mutates repository state
 */
export function isMutating(subcommand, rest) {
  if (typeof subcommand !== 'string') return false;
  const spec = MUTATING_SUBCOMMANDS.get(subcommand);
  if (!spec) return false;
  if (!spec.readOnlyWhen) return true;
  // `git remote` / `git branch` / `git tag` with NO further argument is a
  // listing form, which is read-only.
  const args = rest.filter((token) => token.t === 'lit').map((token) => token.v);
  if (subcommand !== 'config' && args.length === 0) return false;
  return !args.some((arg) => spec.readOnlyWhen.some((re) => re.test(arg)));
}

/**
 * Split a shell command string into tokens, dropping interpolation holes.
 * `git add ${JSON.stringify(rel)}` → `['git','add']` — enough to resolve the
 * subcommand, which is all this check needs.
 *
 * @param {string} command
 * @returns {string[]}
 */
export function tokenizeShellCommand(command) {
  return String(command ?? '')
    .replace(/\$\{[^}]*\}/g, ' ')
    .split(/\s+/)
    .filter((token) => token !== '')
    .map((token) => token.replace(/^['"]|['"]$/g, ''));
}

/**
 * Compute the 1-based line number of `index` in `body`.
 *
 * @param {string} body
 * @param {number} index
 * @returns {number}
 */
function lineOf(body, index) {
  let line = 1;
  for (let i = 0; i < index && i < body.length; i += 1) if (body[i] === '\n') line += 1;
  return line;
}

/**
 * @param {string} body
 * @param {number} index
 * @returns {boolean} true when the line containing `index` is a comment line
 */
function inCommentLine(body, index) {
  const start = body.lastIndexOf('\n', index) + 1;
  return /^\s*(\/\/|\/\*|\*)/.test(body.slice(start, index + 1));
}

/**
 * True when `index` falls INSIDE a string literal on its own line.
 *
 * Necessary, not defensive: a test that documents this very anti-pattern
 * writes the offending call as a STRING (`"execFileSync('git', ['config', …])"`),
 * and without this scanner the check reports its own fixtures — 8 findings in
 * its own test file, measured 2026-08-19. A check that is red on its own
 * regression suite is the shape that gets switched off.
 *
 * A per-line scanner (rather than whole-file) because a multi-line template
 * literal would otherwise poison every subsequent line's quote state, and a
 * call is always matched at the token that OPENS it — which is on one line.
 *
 * Known limit: a template literal that spans lines and contains a `git` call is
 * judged by the line it sits on, so an interpolated multi-line command string
 * can be judged as code. Measured 0 occurrences in `tests/` on 2026-08-19.
 *
 * @param {string} body
 * @param {number} index
 * @returns {boolean}
 */
export function insideStringLiteral(body, index) {
  const start = body.lastIndexOf('\n', index) + 1;
  /** @type {string|null} */
  let quote = null;
  for (let i = start; i < index; i += 1) {
    const ch = body[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (quote === null) {
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    } else if (ch === quote) {
      quote = null;
    }
  }
  return quote !== null;
}

/**
 * Scan one file for `git` invocations.
 *
 * @param {string} relative repo-relative path
 * @param {string} body file content
 * @param {{applicable: number, targeted: number, readOnly: number, unresolvedArgv: number, unresolvedOptions: number, gitDirInheritable: number, insideStringLiteral: number}} tally mutated in place
 * @returns {Array<{kind: string, file: string, line: number, form: string, command: string, message: string}>}
 */
export function scanFile(relative, body, tally) {
  /** @type {Array<{kind: string, file: string, line: number, form: string, command: string, message: string}>} */
  const findings = [];

  /** @type {Array<{index: number, form: 'argv'|'shell', tokens: Array<string|null>, tail: string}>} */
  const calls = [];

  ARGV_CALL_RE.lastIndex = 0;
  /** @type {RegExpExecArray|null} */
  let m;
  while ((m = ARGV_CALL_RE.exec(body)) !== null) {
    const afterIndex = m.index + m[0].length;
    const after = body.slice(afterIndex);
    if (!after.startsWith('[')) {
      tally.unresolvedArgv += 1;
      continue;
    }
    const close = matchBracket(after, 0, '[', ']');
    if (close === -1) {
      tally.unresolvedArgv += 1;
      continue;
    }
    calls.push({
      index: m.index,
      form: 'argv',
      tokens: tokenizeArgv(after.slice(1, close)),
      tail: after.slice(close + 1),
    });
  }

  SHELL_CALL_RE.lastIndex = 0;
  while ((m = SHELL_CALL_RE.exec(body)) !== null) {
    const quote = m[1];
    const openIndex = body.indexOf(quote, m.index);
    const closeIndex = body.indexOf(quote, openIndex + 1);
    if (closeIndex === -1) continue;
    const command = body.slice(openIndex + 1, closeIndex);
    const tokens = tokenizeShellCommand(command);
    calls.push({
      index: m.index,
      form: 'shell',
      // Drop the leading `git`, then lift every word into the `ArgvToken`
      // shape so both forms share `classifyArgv`. An interpolation hole was
      // already erased by `tokenizeShellCommand`, so what survives is literal.
      tokens: tokens.slice(1).map((v) => ({ t: /** @type {const} */ ('lit'), v })),
      tail: body.slice(closeIndex + 1),
    });
  }

  for (const call of calls) {
    if (inCommentLine(body, call.index)) continue;
    if (insideStringLiteral(body, call.index)) {
      tally.insideStringLiteral += 1;
      continue;
    }

    const { hasArgvTarget, subcommand, rest } = classifyArgv(call.tokens);
    if (!isMutating(subcommand, rest)) {
      if (subcommand !== null) tally.readOnly += 1;
      continue;
    }
    tally.applicable += 1;

    // The options object: everything up to the end of the call expression.
    const callEnd = matchBracket(call.tail, call.tail.indexOf('('), '(', ')');
    const optionsText = callEnd === -1 ? call.tail.slice(0, 400) : call.tail.slice(0, callEnd);
    const opaqueOptions = OPAQUE_OPTIONS_RE.test(call.tail);
    const hasCwd = CWD_OPTION_RE.test(optionsText);
    const hasEnvTarget = GIT_ENV_TARGET_RE.test(optionsText);
    const hasTarget =
      hasArgvTarget || hasCwd || hasEnvTarget || hasSubcommandTarget(subcommand, rest);

    if (hasTarget) {
      tally.targeted += 1;
      // The second, larger population: a correct target that an inherited
      // GIT_DIR still outranks. Counted, never reported per-site — see header.
      if (!hasEnvTarget) tally.gitDirInheritable += 1;
      continue;
    }
    if (opaqueOptions) {
      tally.unresolvedOptions += 1;
      continue;
    }

    const printable = [subcommand, ...rest.map((t) => (t.t === 'lit' ? t.v : '<expr>'))]
      .slice(0, 4)
      .join(' ');
    findings.push({
      kind: 'no-target',
      file: relative,
      line: lineOf(body, call.index),
      form: call.form,
      command: `git ${printable}`,
      message:
        `\`git ${printable}\` mutiert Repo-Zustand ohne explizites Ziel ` +
        `(weder \`-C <pfad>\` noch \`cwd:\`) — das Ziel entscheidet die ambiente cwd.`,
    });
  }

  return findings;
}

/**
 * Run the full census.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {{ok: boolean, summary: {filesScanned: number, applicable: number, targeted: number, readOnly: number, unresolvedArgv: number, unresolvedOptions: number, gitDirInheritable: number, insideStringLiteral: number, findings: number}, findings: Array<object>, toolError: boolean}}
 */
export function inspectTestGitConfigTarget(pluginRoot) {
  const tally = {
    applicable: 0,
    targeted: 0,
    readOnly: 0,
    unresolvedArgv: 0,
    unresolvedOptions: 0,
    gitDirInheritable: 0,
    insideStringLiteral: 0,
  };
  /** @type {Array<object>} */
  const findings = [];
  const result = {
    ok: false,
    summary: { filesScanned: 0, ...tally, findings: 0 },
    findings,
    toolError: false,
  };

  const scanRoot = path.join(pluginRoot, SCAN_DIR);
  try {
    statSync(scanRoot);
  } catch (error) {
    result.toolError = true;
    findings.push({
      kind: 'tool-error',
      file: SCAN_DIR,
      line: 0,
      message: `cannot stat the scan root: ${error instanceof Error ? error.message : String(error)}`,
    });
    return result;
  }

  const files = walk(scanRoot).sort();
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
        message: `cannot read: ${error instanceof Error ? error.message : String(error)}`,
      });
      return result;
    }
    if (!/['"`]\s*git[\s'"`]/.test(body)) continue;
    findings.push(...scanFile(relative, body, tally));
  }

  findings.sort((a, b) => String(a.file).localeCompare(String(b.file)) || Number(a.line) - Number(b.line));
  result.summary = { filesScanned: files.length, ...tally, findings: findings.length };
  result.ok = findings.length === 0;
  return result;
}

/**
 * Run the human-readable validator CLI.
 *
 * WARN-ONLY: findings print as WARN and still return 0. `FAIL:` is emitted
 * only on the tool-error path — see § Mode in the header.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = census completed, 2 = tool error
 */
export function runCheckTestGitConfigTarget(pluginRoot) {
  console.log('--- Check: state-mutating git calls in tests/ without an explicit target (WARN-only) ---');
  const inspection = inspectTestGitConfigTarget(pluginRoot);

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
    `  PASS: censused ${s.filesScanned} test file(s) — ${s.applicable} state-mutating git ` +
      `invocation(s), ${s.targeted} name an explicit target, ${s.findings} do not; ` +
      `${s.readOnly} read-only invocation(s) skipped, ${s.unresolvedArgv} variable argv ` +
      `array(s) and ${s.unresolvedOptions} opaque options object(s) unjudged; ` +
      `${s.gitDirInheritable} targeted call(s) would still be outranked by an inherited GIT_DIR; ` +
      `${s.insideStringLiteral} match(es) inside a string literal treated as fixture text`,
  );
  console.log('');
  console.log('Results: 1 passed, 0 failed');
  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const positional = argv.filter((a) => !a.startsWith('--'));
  const usage =
    'Usage: check-test-git-config-target.mjs [<plugin-root>] [--json]\n' +
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
        const inspection = inspectTestGitConfigTarget(pluginRoot);
        console.log(JSON.stringify(inspection, null, 2));
        process.exitCode = inspection.toolError ? 2 : 0;
      } else {
        process.exitCode = runCheckTestGitConfigTarget(pluginRoot);
      }
    }
  }
  // Deliberately NOT `process.exit()`: on a pipe, exiting discards stdout
  // writes still queued in the async write buffer (see
  // `.claude/rules/anti-pattern-console-log-process-exit-drops-stdout-....md`).
}
