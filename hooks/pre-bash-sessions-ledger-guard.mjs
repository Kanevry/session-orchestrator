#!/usr/bin/env node
/**
 * pre-bash-sessions-ledger-guard.mjs — PreToolUse Bash hook: blocks a DIRECT
 * shell write into the sessions ledger (`.orchestrator/metrics/sessions.jsonl`).
 *
 * ## Why this exists (GitLab #958, finding 3)
 *
 * W1/D4 proved the root cause of the malformed ledger record: it was composed
 * by the coordinator from a Markdown template and appended straight to
 * `sessions.jsonl`, bypassing `scripts/emit-session.mjs` — the validating
 * writer that would have refused it. Piping that record into emit-session.mjs
 * exits 1 and leaves the file untouched, so it cannot have taken the sanctioned
 * path.
 *
 * `skills/session-end/session-metrics-write.md` already says, in prose:
 * "Hand-composing JSON and appending it directly to `sessions.jsonl` is
 * forbidden." A prose prohibition did not stop it. This hook is the mechanism.
 *
 * ## What is ALLOWED, and why it needs no name allowlist
 *
 * The guard fires on WRITE INTENT (`>`/`>>`, `tee`, `dd of=`, `cp`/`mv`
 * destination), not on command names. The three sanctioned writers —
 * `scripts/emit-session.mjs`, `scripts/backfill-sessions.mjs`,
 * `scripts/migrate-sessions-jsonl.mjs`, `scripts/backfill-abandoned-sessions.mjs`
 * — all open the file from inside Node (append / atomic tmp+rename); none of
 * them is invoked through a shell redirect into the ledger. They are therefore
 * allowed STRUCTURALLY: their command strings contain no ledger write-intent
 * for the matcher to see.
 *
 * That is a deliberate design choice over a script-name allowlist. A name
 * allowlist in a shell string is trivially spoofable — the name can sit in a
 * comment (`echo '…' >> ledger # emit-session.mjs`), in an unrelated argument
 * (`echo emit-session.mjs >> ledger`), or inside the quoted payload being
 * appended. "Does this command redirect bytes into the ledger" is a property of
 * the command's STRUCTURE that no amount of name-dropping can fake, and that
 * the sanctioned writers structurally never have. There is nothing to spoof
 * because there is no name being matched.
 *
 * The one true positive this costs is `node scripts/emit-session.mjs … >> …
 * sessions.jsonl` — piping the writer's `{"action":"appended"}` receipt INTO
 * the ledger. That is a bug, and denying it is correct.
 *
 * ## Path scope
 *
 * A write target counts as the ledger when its BASENAME is `sessions.jsonl`,
 * in any directory — including a tmp-repo fixture. Not "every .jsonl": exactly
 * the ledger's own filename. Matching the basename rather than the full
 * `.orchestrator/metrics/sessions.jsonl` suffix closes the
 * `cd .orchestrator/metrics && echo … >> sessions.jsonl` hole. Tmp ledgers are
 * guarded too, at no cost: test fixtures write them from Node (`writeFileSync`),
 * which this Bash-only hook never sees.
 *
 * ## How the command is read (GitLab #958 follow-up, security review 2×MED)
 *
 * The first cut used a redirect REGEX over the raw string plus a per-character
 * "is this index quoted?" mask. Both halves leaked, and both leaks were
 * demonstrated to write the ledger:
 *
 *   - MED-1 — the mask modelled only `'…'` and `"…"`. One apostrophe from a
 *     shell COMMENT (`# don't forget the record`), a HERE-DOC body (`it's
 *     fine`) or an ANSI-C literal (`$'a\'b'`) left it stuck in "single" for the
 *     rest of the command, and the real `>>` after it was skipped. English
 *     prose is full of apostrophes, so `# don't …` is the EXPECTED shape of the
 *     accident this guard exists to catch, not an adversarial construction.
 *   - MED-2 — the regex captured ONE quoting run, so a target assembled from
 *     several (`"$PWD"/…/sessions.jsonl`, `.orchestrator/metrics/"sessions.jsonl"`,
 *     `My\ Repo/…/sessions.jsonl`, `"."/…/sessions.jsonl`) was captured wrong
 *     and its tail never examined. Two of those four contain no variable at all.
 *
 * Both classes are STATICALLY resolvable, so "a PreToolUse hook cannot know the
 * target" never covered them. The regex + mask are gone. {@link scanCommand} is
 * a single quote-aware pass that understands comments, here-doc bodies,
 * `$'…'` / `$"…"`, backslash escapes, fd duplication (`2>&1` contributes no
 * target) and multi-run words — it returns the RESOLVED redirect targets, so
 * all four MED-2 forms reduce to the same basename. The same pass emits a
 * sanitized command (comments and here-doc bodies removed, `$'…'` folded to a
 * plain literal, redirect operators AND their targets elided) for the
 * `tee`/`dd`/`cp`/`mv` matcher.
 *
 * ## Why this scanner is NOT redundant with `tokenizeCommand` (#965 follow-up)
 *
 * #965 taught the shared lexer comments, here-doc bodies and `$'…'`, which
 * removes the ORIGINAL reason this pass existed. It is kept anyway, because two
 * things it produces are structurally absent from `tokenizeCommand` — measured,
 * not assumed:
 *
 *   1. **The `balanced` flag.** `tokenizeCommand('echo "x')` returns tokens
 *      shaped `{text, quoted}` — there is no third field, and its unterminated-
 *      quote path deliberately fails OPEN (flush + mark quoted) so a wedged
 *      lexer cannot block every Bash call. That is right for a lexer serving
 *      nine rules; it is wrong here, where `findLedgerWrite` must fail CLOSED.
 *      The signal is destroyed inside the lexer, so no consumer can recover it.
 *   2. **Redirect-target elision.** `tokenizeCommand` emits the redirect TARGET
 *      as an ordinary token by design (its docblock: dropping it "would have
 *      silently changed rm-allowlist verdicts"). Feeding the raw command to the
 *      `cp`/`mv` branch therefore picks the wrong destination:
 *      `cp foo …/sessions.jsonl > /dev/null` resolves dest=`/dev/null` and
 *      ALLOWS, where the sanitized form resolves dest=`…/sessions.jsonl` and
 *      denies. Deleting the sanitizer re-opens a proven ledger write path.
 *
 * ## Wrapper + segment parsing is the LIB's, not a local copy (#991)
 *
 * This module used to carry three near-twins of shared machinery: a local
 * `splitSegments`, a local `resolveVerb`, and a FLAGBLIND `VERB_PREFIXES` set.
 * The copies drifted, and the drift was fail-OPEN: `VERB_PREFIXES` skipped only
 * the wrapper WORD and never its arguments, so `sudo -u root tee -a <ledger>`
 * resolved to the verb `-u`, `tee` was never in verb position, and the write
 * was ALLOWED. All fourteen wrapper spellings in the test table were measured
 * ALLOW before this change — the guard reported a safety it did not provide.
 *
 * They are gone. `splitChainSegments` and `resolveSegmentVerb` now come from
 * `scripts/lib/command-blocker.mjs` — the same primitives
 * hooks/pre-bash-destructive-guard.mjs consumes, imported DIRECTLY from the
 * source module for the reason stated there: the `hardening.mjs` barrel
 * deliberately does not re-export the #982/#983 primitives, and one import edge
 * keeps this hook's dependency graph unambiguous. The deleted `VERB_PREFIXES`
 * was a strict SUBSET of the lib's `WRAPPER_UNWRAP` table (6 ⊂ 9), so the
 * switch ADDS `doas`/`timeout`/`stdbuf` plus flag-awareness and removes nothing.
 *
 * `resolveSegmentVerb` additionally reports `wrapperArgs` — the value-taking
 * wrapper flags consumed on the way to the verb. One of those operands is
 * itself a WRITE: `/usr/bin/time -o <file>` TRUNCATES `<file>` (BSD time(1):
 * "If file exists and the -a flag is not specified, the file will be
 * overwritten"), while the verb is whatever `time` goes on to run. The target
 * is therefore invisible in both `verb` and `args`, which is why
 * `/usr/bin/time -o <ledger> npm test` was allowed and now denies.
 * `resolveSegmentVerb` itself supplies the file-vs-option semantics: each
 * write-destination operand is flagged `writesFile: true` from its per-wrapper
 * `fileArgFlags` table (#996.1), so this guard keys on that flag directly and no
 * longer keeps a local `<wrapper>:<flag>` pair list that had to track the lexer's
 * grammar by hand. The bash
 * KEYWORD `time` is unaffected: it rejects the flag outright
 * (`bash -c 'time -o x echo hi'` → "-o: command not found"), so only
 * `/usr/bin/time`, `command time` and `env time` can carry it at all.
 *
 * Fail-CLOSED on an unbalanced quote: if the scan ends mid-quote the command is
 * one bash itself would reject with a syntax error, so denying it when it
 * mentions the ledger costs ~0 in false positives and removes "leave the lexer
 * confused" as a bypass strategy. This is the one place the guard is closed
 * rather than open, and it is closed because the alternative is a silent skip.
 *
 * ## What this does NOT catch (stated plainly — the bounds are the contract)
 *
 *   - Indirection through a variable: `>> "$LEDGER"`, `tee "$LEDGER"`,
 *     `exec 3>"$LEDGER"; echo x >&3`. A PreToolUse hook sees the unexpanded
 *     string; the target is genuinely unknowable here.
 *   - A target whose BASENAME only exists after expansion:
 *     `>> $(echo sessions.jsonl)`, `>> "$dir/$name"`, a glob or brace form.
 *     What matters is whether the literal `sessions.jsonl` survives in the
 *     command string — the DIRECTORY half may expand freely and is still
 *     denied (`"$PWD"/…/sessions.jsonl`, `$HOME/…/sessions.jsonl`,
 *     `"$(pwd)/…/sessions.jsonl"` and `exec 3> …/sessions.jsonl` all deny;
 *     verified, not assumed).
 *   - A redirect nested inside a DOUBLE-QUOTED command substitution or a
 *     backtick run: `echo "$(echo x >> …/sessions.jsonl)"` allows, while the
 *     unquoted `echo $(echo x >> …/sessions.jsonl)` denies. The scanner
 *     consumes a quoted run whole and does not recurse into it. Verified, and
 *     left uncaught deliberately: recursing costs lexer surface, and a redirect
 *     buried in a quoted substitution is not the accident shape this guard is
 *     for — it is the "determined circumvention" line below.
 *   - In-place editors: `sed -i`, `perl -i`, `ed`, an interactive editor.
 *   - A write performed inside an interpreter: `node -e`, `python -c`,
 *     `bash -c '… >> …/sessions.jsonl'`, or any script the command invokes that
 *     appends the ledger itself. The one exception is a WRAPPER payload —
 *     `env -S 'tee -a …/sessions.jsonl'` — which `resolveSegmentVerb` reports
 *     as a payload and which this matcher re-enters (to MAX_PAYLOAD_DEPTH).
 *     Interpreter `-c` payloads are a larger surface and stay out of scope.
 *   - Obfuscation: `eval`, `base64 -d | sh`, a here-doc-fed shell. Here-doc
 *     BODIES are skipped as the data they are — `bash <<EOF … EOF` therefore
 *     hides its payload from this matcher by construction.
 *   - `sponge`, `install`, `rsync`, `awk > file` and other less common write
 *     verbs (a redirect inside an `awk` program string is quoted data here).
 *   - The Write/Edit tools — a different PreToolUse matcher entirely
 *     (`hooks/enforce-scope.mjs` territory), not this hook's surface.
 *
 * This is a guard against the accident that actually happened, not a
 * containment boundary. Determined circumvention is out of scope by design.
 *
 * ## Fail-open on internal error
 *
 * A crash allows the command (exit 0, empty stdout) and warns on stderr,
 * matching every sibling Bash guard in this repo. This is a nudge on a
 * developer machine, not a security boundary: a wedged guard that blocks every
 * Bash call is strictly worse than a missed enforcement, and the visibility
 * half of #958 (the session-start ledger-integrity banner) catches what slips
 * through. Under the #906 exit-0 protocol, "fail-open" is literally exit 0 with
 * no stdout envelope — the harness reads no decision and proceeds.
 *
 * A LOAD failure is a distinct class since #993: the repo dependencies (`io.mjs`,
 * `command-blocker.mjs`) are bound LATE (dynamic `import()` in `bootstrap()`), so
 * a link-time SyntaxError in either becomes a catchable runtime error that
 * banners GUARD INACTIVE on stderr instead of the pre-#993 exit-1 / 0-byte crash
 * that disarmed the guard invisibly under the exit-0 protocol. The
 * `command-blocker` half additionally recovers its COMMITTED source via
 * `git show HEAD:` (banner: DEGRADED, guard still armed against HEAD) — the whole
 * mechanism lives in `_lib/guard-source-loader.mjs` (`armGuard`).
 *
 * ## Override
 *
 *   SO_DISABLED_HOOKS=pre-bash-sessions-ledger-guard   (session-level)
 *   SO_HOOK_PROFILE=minimal|off
 *
 * Deliberately session-level and not in-command: an in-command escape hatch
 * would be one more string for a hurried agent to paste, i.e. the discipline
 * failure this hook exists to replace.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { shouldRunHook } from './_lib/profile-gate.mjs';
// #211: exit 0 immediately (silent allow) when this hook is disabled via profile/env
if (!shouldRunHook('pre-bash-sessions-ledger-guard')) process.exit(0);

// ---------------------------------------------------------------------------
// #993 — late-bound repo dependencies
//
// `io.mjs` (readStdin/emitAllow/emitDeny) and `command-blocker.mjs`
// (tokenizeCommand/resolveSegmentVerb/splitChainSegments) used to be STATIC
// imports. A SyntaxError in either failed at ESM LINK time, before the first
// statement here ran: node exited 1 with 0 bytes on stdout, and the
// `main().catch(...)` handler at the bottom of this file was structurally
// unreachable. Under the exit-0 PreToolUse protocol (#906) that crash is, on the
// only decision-bearing channel, INDISTINGUISHABLE from an explicit
// `emitAllow()` — the guard failed open and silently.
//
// This hook is fail-open BY DESIGN (a nudge, not a boundary — see the module
// docblock), so a silent disarm is a smaller loss here than in the
// destructive-guard. It is still a loss: the #958 corruption class stops being
// caught with no sign it stopped. Binding these late (dynamic `import()` inside
// `bootstrap()`) turns the link-time crash into a catchable runtime error, which
// is what makes the GUARD INACTIVE banner in `_lib/guard-source-loader.mjs`
// reachable at all.
//
// `command-blocker.mjs` is held as a NAMESPACE object (`blocker.*`) rather than
// three destructured bindings on purpose: the required-export list then exists in
// exactly one place — the `requires` array on the `blocker` spec passed to
// `armGuard` — which validates BOTH the working-tree copy and the HEAD copy
// against it, so a partial namespace banners GUARD INACTIVE instead of arming a
// guard that fails open per command.
//
// `profile-gate.mjs` stays static on purpose — it has ZERO imports of its own and
// gates whether this hook runs at all.
// ---------------------------------------------------------------------------
/** @type {typeof import('../scripts/lib/io.mjs').readStdin} */ let readStdin;
/** @type {typeof import('../scripts/lib/io.mjs').emitAllow} */ let emitAllow;
/** @type {typeof import('../scripts/lib/io.mjs').emitDeny} */ let emitDeny;
/**
 * The whole `command-blocker.mjs` namespace (#991: one direct import path, not
 * via the hardening.mjs barrel, which deliberately does NOT re-export the
 * #982/#983 primitives). Held as ONE object rather than destructured so the
 * required-export set lives only on the `blocker` spec's `requires` array (#993).
 *
 * @type {Record<string, Function>|null}
 */
let blocker = null;

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/** This hook's name — threaded into the guard banners (#993: no hard-wired literal). */
const HOOK_NAME = 'pre-bash-sessions-ledger-guard';

/**
 * Consequence prose spliced VERBATIM into the DEGRADED and GUARD INACTIVE banners
 * (#993). This hook is fail-open by design, so the `inactive` text says so plainly
 * rather than borrowing the destructive-guard's "do not route around it" framing.
 */
const GUARD_CONSEQUENCE = {
  degraded: [
    '    Consequence: ledger-write enforcement IS still armed, but it is evaluating the',
    '    COMMITTED (HEAD) command lexer — any uncommitted change to that file is NOT in effect.',
  ],
  inactive: [
    '    Consequence: a direct shell write into .orchestrator/metrics/sessions.jsonl',
    '    (>, >>, tee, dd of=, cp/mv destination) is NOT being blocked. This hook is a',
    '    fail-open nudge, not a security boundary — but repair it so the #958 corruption',
    '    class stays caught.',
  ],
};

/**
 * Project dir for banner keying, resolved WITHOUT any repo module — those are the
 * ones that may have failed to load.
 *
 * @returns {string}
 */
function bannerProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Bind every repo dependency. Throws on any load failure; the caller banners.
 *
 * `io` gets NO HEAD fallback (a missing export surfaces as a plain TypeError at
 * its single call site — no half-armed guard to protect against). `blocker` opts
 * into the `git show HEAD:` recovery (it is dependency-free — its only import is
 * `node:path`) and carries the COMPLETE required-export set, so a partial
 * namespace banners GUARD INACTIVE rather than arming a guard that fails open per
 * command.
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  const lib = (...seg) => pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', ...seg)).href;

  const { armGuard } = await import('./_lib/guard-source-loader.mjs');
  const { modules } = await armGuard(
    {
      io: { specifier: lib('io.mjs') },
      blocker: {
        specifier: lib('command-blocker.mjs'),
        headFallback: true,
        requires: ['tokenizeCommand', 'resolveSegmentVerb', 'splitChainSegments'],
      },
    },
    {
      hookName: HOOK_NAME,
      repoRoot: PLUGIN_ROOT,
      projectDir: bannerProjectDir(),
      consequence: GUARD_CONSEQUENCE,
    }
  );

  ({ readStdin, emitAllow, emitDeny } = modules.io);
  blocker = modules.blocker;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The ledger's filename. A write target matches on basename equality. */
const LEDGER_BASENAME = 'sessions.jsonl';

/**
 * How much of the offending target may appear in the deny reason.
 *
 * Load-bearing, not cosmetic. `emitDeny` clamps the whole reason to
 * DENY_REASON_MAX (#906) — so an unbounded target on the FIRST line pushes the
 * `emit-session.mjs` route, the override and the issue reference off the end,
 * and the operator gets a wall of characters with no instruction. Bounding the
 * target keeps the reason short enough that the actionable half always survives.
 */
const TARGET_ECHO_MAX = 200;

/** Verbs whose LAST non-flag argument is a write destination. */
const DEST_LAST_VERBS = new Set(['cp', 'mv']);

/**
 * How deep to follow a wrapper's command-string payload (`env -S '…'`).
 *
 * Payloads are the only recursion source here, and two levels covers every
 * shape a hurried agent produces while keeping the work bounded — a cap that
 * cannot be exhausted into a bypass because the OUTER command is still matched
 * on its own terms.
 */
const MAX_PAYLOAD_DEPTH = 2;

/** Unquoted characters that end a shell WORD. */
const WORD_END = new Set([';', '|', '&', '<', '>', '(', ')', '\n']);

/** `>&1`, `>&2`, `>&-`, `>&3-` duplicate a descriptor — no file target. */
const FD_DUP_RE = /^(?:\d+-?|-)$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Does this path string name the sessions ledger?
 *
 * Basename equality, so `.orchestrator/metrics/sessions.jsonl`,
 * `/tmp/x/.orchestrator/metrics/sessions.jsonl` and a bare `sessions.jsonl`
 * (after a `cd`) all match, while `sessions.jsonl.bak`, `learnings.jsonl` and
 * `events.jsonl` do not.
 *
 * @param {string} target
 * @returns {boolean}
 */
function refersToLedger(target) {
  if (typeof target !== 'string' || target.length === 0) return false;
  // Normalise Windows-style separators before taking the basename so a
  // backslash-spelled path is not read as one long filename.
  const normalized = target.replace(/\\/g, '/');
  return path.posix.basename(normalized) === LEDGER_BASENAME;
}

/**
 * Skip a quoted run that OPENS at `open`.
 *
 * @param {string} command
 * @param {number} open - index of the opening quote character
 * @param {boolean} escapes - true when `\` escapes the next char (double / ANSI-C)
 * @returns {number} index just past the closing quote, or -1 when never closed
 */
function skipQuotedRun(command, open, escapes) {
  const quote = command[open];
  for (let i = open + 1; i < command.length; i++) {
    const ch = command[i];
    if (escapes && ch === '\\' && i + 1 < command.length) { i++; continue; }
    if (ch === quote) return i + 1;
  }
  return -1;
}

/**
 * Read ONE shell word starting at `i`, resolving quoting and escapes to the
 * logical value bash would pass as an argument.
 *
 * This is the MED-2 fix: a word is a sequence of runs, not a single one, so
 * `"$PWD"/.orchestrator/metrics/sessions.jsonl`,
 * `.orchestrator/metrics/"sessions.jsonl"`, `My\ Repo/…/sessions.jsonl` and
 * `"."/…/sessions.jsonl` all resolve to a value whose basename is the ledger.
 *
 * @param {string} command
 * @param {number} i
 * @returns {{ value: string, end: number, balanced: boolean }}
 */
function readWord(command, i) {
  let value = '';
  let state = 'normal';
  while (i < command.length) {
    const ch = command[i];

    if (state === 'single') {
      if (ch === "'") { state = 'normal'; i++; continue; }
      value += ch; i++; continue;
    }
    if (state === 'double' || state === 'ansi') {
      if (ch === (state === 'double' ? '"' : "'")) { state = 'normal'; i++; continue; }
      if (ch === '\\' && i + 1 < command.length) { value += command[i + 1]; i += 2; continue; }
      value += ch; i++; continue;
    }

    if (/\s/.test(ch) || WORD_END.has(ch)) break;
    if (ch === '\\' && i + 1 < command.length) { value += command[i + 1]; i += 2; continue; }
    if (ch === "'") { state = 'single'; i++; continue; }
    if (ch === '"') { state = 'double'; i++; continue; }
    if (ch === '$' && command[i + 1] === "'") { state = 'ansi'; i += 2; continue; }
    if (ch === '$' && command[i + 1] === '"') { state = 'double'; i += 2; continue; }
    value += ch; i++;
  }
  return { value, end: i, balanced: state === 'normal' };
}

/**
 * Skip a here-doc body starting at `from`, returning the index just past the
 * terminator line (or the end of input when the terminator never arrives).
 *
 * @param {string} command
 * @param {number} from
 * @param {string} delim
 * @param {boolean} stripTabs - `<<-` form: leading tabs on the terminator ignored
 * @returns {number}
 */
function skipHeredocBody(command, from, delim, stripTabs) {
  let i = from;
  while (i < command.length) {
    let lineEnd = command.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = command.length;
    const raw = command.slice(i, lineEnd);
    const line = stripTabs ? raw.replace(/^\t+/, '') : raw;
    i = lineEnd + 1;
    if (line === delim) return Math.min(i, command.length);
  }
  return command.length;
}

/**
 * One quote-aware pass over the command.
 *
 * Returns every RESOLVED redirect target, plus a sanitized command for the
 * write-verb matcher: comments and here-doc bodies removed, `$'…'` folded to a
 * plain single-quoted literal, redirect operators and their targets elided.
 * `balanced` is false when the scan ended inside an unterminated quote — a
 * command bash would reject, and the fail-closed trigger (see docblock).
 *
 * @param {string} command
 * @returns {{ targets: string[], sanitized: string, balanced: boolean }}
 */
function scanCommand(command) {
  const targets = [];
  const heredocs = [];
  let out = '';
  let i = 0;

  const atWordStart = (idx) => idx === 0 || /[\s;|&()<>]/.test(command[idx - 1]);

  while (i < command.length) {
    const ch = command[i];

    // A `#` in word position comments out the rest of the LINE. Without this,
    // one apostrophe in English prose desynced the whole scan (MED-1).
    if (ch === '#' && atWordStart(i)) {
      while (i < command.length && command[i] !== '\n') i++;
      continue;
    }

    if (ch === '\n') {
      out += '\n';
      i++;
      while (heredocs.length) {
        const { delim, stripTabs } = heredocs.shift();
        i = skipHeredocBody(command, i, delim, stripTabs);
      }
      continue;
    }

    if (ch === '\\' && i + 1 < command.length) { out += ch + command[i + 1]; i += 2; continue; }

    // ANSI-C `$'…'`: a backslash escapes the closing quote, which the old mask
    // did not know (MED-1). Folded to a plain literal for the write-verb lexer.
    if (ch === '$' && command[i + 1] === "'") {
      const end = skipQuotedRun(command, i + 1, true);
      if (end === -1) return { targets, sanitized: out, balanced: false };
      const literal = command.slice(i + 2, end - 1).replace(/\\(.)/g, '$1').replace(/'/g, '');
      out += `'${literal}'`;
      i = end;
      continue;
    }
    if (ch === '$' && command[i + 1] === '"') {
      const end = skipQuotedRun(command, i + 1, true);
      if (end === -1) return { targets, sanitized: out, balanced: false };
      out += command.slice(i + 1, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = skipQuotedRun(command, i, ch === '"');
      if (end === -1) return { targets, sanitized: out, balanced: false };
      out += command.slice(i, end);
      i = end;
      continue;
    }

    // Here-doc: remember the delimiter now, skip the body at the next newline.
    // `<<<` is a here-STRING, not a here-doc, and needs no body skipping.
    if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      let j = i + 2;
      let stripTabs = false;
      if (command[j] === '-') { stripTabs = true; j++; }
      while (command[j] === ' ' || command[j] === '\t') j++;
      const w = readWord(command, j);
      if (!w.balanced) return { targets, sanitized: out, balanced: false };
      if (w.value) heredocs.push({ delim: w.value, stripTabs });
      out += ' ';
      i = Math.max(w.end, i + 2);
      continue;
    }

    // Redirection: `>` `>>` `>|` `N>` `&>` `&>>`. The optional leading fd digits
    // are ordinary characters we already copied; only the operator matters.
    if (ch === '>' || (ch === '&' && command[i + 1] === '>')) {
      let j = ch === '&' ? i + 2 : i + 1;
      if (command[j] === '>') j++;
      if (command[j] === '|') j++;
      if (command[j] === '&') {
        const dup = readWord(command, j + 1);
        if (FD_DUP_RE.test(dup.value)) { out += ' '; i = Math.max(dup.end, j + 1); continue; }
        j += 1;
      }
      while (command[j] === ' ' || command[j] === '\t') j++;
      const w = readWord(command, j);
      if (!w.balanced) return { targets, sanitized: out, balanced: false };
      if (w.value) targets.push(w.value);
      out += ' ';
      i = Math.max(w.end, j, i + 1);
      continue;
    }

    out += ch;
    i++;
  }

  return { targets, sanitized: out, balanced: true };
}

/**
 * Find a non-redirect write verb (`tee`, `dd of=`, `cp`/`mv` destination)
 * whose target is the ledger.
 *
 * Runs on the TOKENIZED command, so quoting is handled by the lexer: a
 * `tee '.orchestrator/metrics/sessions.jsonl'` target is still seen, while a
 * `tee` appearing only inside a quoted payload is not in verb position.
 *
 * Takes the SANITIZED command from {@link scanCommand}, not the raw one. Since
 * #965 the reason is no longer comments/here-docs/`$'…'` — the shared lexer
 * handles those now — but REDIRECT ELISION: `tokenizeCommand` emits a redirect
 * target as an ordinary token, so on the raw string
 * `cp foo …/sessions.jsonl > /dev/null` resolves its destination to
 * `/dev/null` and allows. Measured; see the module docblock.
 *
 * Verb resolution is `resolveSegmentVerb`'s (#991) — flag-aware, so a wrapper's
 * OPTIONS are consumed with it and `sudo -u root tee -a <ledger>` reaches the
 * real verb instead of stopping at `-u`.
 *
 * @param {string} command - sanitized command
 * @param {number} [depth] - payload recursion level (see MAX_PAYLOAD_DEPTH)
 * @returns {string|null} the offending target, or null
 */
function findWriteVerbTarget(command, depth = 0) {
  for (const segment of blocker.splitChainSegments(blocker.tokenizeCommand(command))) {
    const { verb, index, payloads, wrapperArgs } = blocker.resolveSegmentVerb(segment);

    // A wrapper can write a file WITHOUT being the verb: `/usr/bin/time -o F`
    // truncates F while the verb is whatever time runs. Checked before the verb
    // dispatch because `time -o <ledger>` alone resolves to verb null. The
    // file-vs-option distinction is the LEXER's now (#996.1): resolveSegmentVerb
    // marks a write-destination operand `writesFile: true` from its per-wrapper
    // `fileArgFlags` table (command-blocker.mjs — the writesFile contract, the
    // `resolveSegmentVerb` return docblock), so a local `<wrapper>:<flag>` pair
    // list here is gone. The rationale it encoded — `stdbuf -o` is a BUFFERING
    // MODE, not a file, and `time -o` is the only wrapper flag that opens one —
    // lives beside that table (command-blocker.mjs, the WRAPPER_UNWRAP docblock).
    for (const wa of wrapperArgs) {
      if (wa.writesFile !== true) continue;
      if (typeof wa.value === 'string' && refersToLedger(wa.value)) return wa.value;
    }

    // `env -S 'tee -a <ledger>'` hides a whole command line in one operand.
    // Recurse on the payload with the SAME matcher rather than a second,
    // weaker one — bounded by MAX_PAYLOAD_DEPTH.
    if (depth < MAX_PAYLOAD_DEPTH) {
      for (const payload of payloads) {
        const hit = findLedgerWrite(payload, depth + 1);
        if (hit) return hit;
      }
    }

    if (!verb) continue;
    const args = segment.slice(index + 1);

    if (verb === 'tee') {
      for (const arg of args) {
        if (!arg.quoted && arg.text.startsWith('-')) continue;
        if (refersToLedger(arg.text)) return arg.text;
      }
      continue;
    }

    if (verb === 'dd') {
      for (const arg of args) {
        const m = /^of=(.*)$/.exec(arg.text);
        if (m && refersToLedger(m[1])) return m[1];
      }
      continue;
    }

    if (DEST_LAST_VERBS.has(verb)) {
      const operands = args.filter((a) => a.quoted || !a.text.startsWith('-'));
      // `cp a b` writes b; `cp ledger backup` READS the ledger and must pass.
      const dest = operands.length >= 2 ? operands[operands.length - 1] : null;
      if (dest && refersToLedger(dest.text)) return dest.text;
    }
  }
  return null;
}

/**
 * The single matcher seam. Returns the offending write target, or null when the
 * command carries no direct ledger write.
 *
 * Deliberately NOT exported: this module runs `main()` on import, so a test that
 * imported the matcher would block on stdin. The fake-regression proof
 * neutralises this function in place and re-runs the spawned-hook tests.
 *
 * @param {string} command
 * @param {number} [depth] - payload recursion level (see MAX_PAYLOAD_DEPTH)
 * @returns {string|null}
 */
function findLedgerWrite(command, depth = 0) {
  if (typeof command !== 'string' || command.length === 0) return null;
  // Cheap pre-filter: no mention of the filename at all → nothing to analyse.
  if (!command.includes(LEDGER_BASENAME)) return null;

  const scan = scanCommand(command);
  for (const target of scan.targets) {
    if (refersToLedger(target)) return target;
  }
  // Fail-CLOSED on an unbalanced quote (see docblock): the scan could not be
  // trusted past the break, and the command mentions the ledger. Bash would
  // reject it with a syntax error anyway, so the false-positive cost is ~0
  // while "confuse the lexer" stops being a bypass.
  if (!scan.balanced) {
    return `${LEDGER_BASENAME} (unbalanced quote — command not parseable, denied fail-closed)`;
  }
  return findWriteVerbTarget(scan.sanitized, depth);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash is gated.
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string.
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // G3 — matcher. No direct ledger write → allow.
  const target = findLedgerWrite(command);
  if (!target) return emitAllow();

  // G4 — deny. emitDeny writes the envelope with fs.writeSync (#906/#914): a
  // console.log here would be dropped above the 64 KiB pipe buffer, and a
  // dropped envelope on this protocol reads as NO decision, i.e. fail-OPEN.
  const shown = target.length > TARGET_ECHO_MAX
    ? `${target.slice(0, TARGET_ECHO_MAX)}… (${target.length} chars)`
    : target;

  emitDeny(
    [
      `Direct write to the sessions ledger blocked: '${shown}'`,
      `The ledger is append-only through its validating writer:`,
      `  node scripts/emit-session.mjs --entry '<json>'    (or pipe the JSON on stdin)`,
      `Hand-composing a record and appending it with a shell redirect skips schema`,
      `validation — that is exactly how the malformed record in GitLab #958 landed.`,
      `Override (intentional maintenance only): run the session with`,
      `SO_DISABLED_HOOKS=pre-bash-sessions-ledger-guard`,
      `See: GitLab #958, skills/session-end/session-metrics-write.md`,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Entry point (#993)
//
// TWO distinct failure classes, two distinct handlers — do not merge them:
//   1. LOAD failure (`bootstrap()` throws): the guard never armed, nothing was
//      evaluated. This used to be a bare exit-1 crash with 0 bytes of stdout —
//      indistinguishable from an allow, and therefore invisible. Now it exits 0
//      (still fail-open, so a broken module cannot brick the session) but SAYS SO
//      via the GUARD INACTIVE banner, once loud on stderr.
//   2. RUNTIME failure inside `main()`: pre-existing fail-open behaviour,
//      unchanged (this hook is fail-open by design — see the module docblock).
// ---------------------------------------------------------------------------
try {
  await bootstrap();
} catch (loadError) {
  try {
    const { emitGuardInactiveBanner } = await import('./_lib/guard-source-loader.mjs');
    // hookName is threaded explicitly (#993 — no hard-wired literal in the loader).
    emitGuardInactiveBanner({ hookName: HOOK_NAME, error: loadError, consequence: GUARD_CONSEQUENCE });
  } catch {
    // Last resort: even the banner helper failed to load. Emit unconditionally —
    // repeated noise beats a silent disarm.
    process.stderr.write(
      '🚨 pre-bash-sessions-ledger-guard: GUARD INACTIVE — module load failed ' +
        `(${String(loadError?.message || loadError).split('\n')[0]}). ` +
        'Direct shell writes to the sessions ledger are NOT being blocked. See issue #992.\n'
    );
  }
  process.exit(0); // fail-open, but no longer fail-silent
}

// Top-level error handler — fail-OPEN (see the module docblock). Never let a
// non-zero exit leak: on this protocol exit 0 + empty stdout is "no decision".
main().catch((e) => {
  process.stderr.write(
    `⚠ pre-bash-sessions-ledger-guard: internal error — ${e?.message || e}\n`,
  );
  process.exit(0);
});
