#!/usr/bin/env node
/**
 * pre-bash-staging-fence.mjs — PreToolUse Bash hook
 *
 * PSA-004 sub-mode C — staging-fence intent log for cross-agent `git add` race
 * detection (issue #552). Companion to hooks/wave-scope-commit-guard.mjs
 * (sub-mode B). Together the two guards cover:
 *
 *   sub-mode B  — lint-staged sweep that re-stages files outside wave-scope
 *                 (the existing guard, caught at pre-commit time).
 *   sub-mode C  — concurrent `git add` from two wave-agents on the same repo
 *                 (this hook records intent; the commit-guard reconciles at
 *                 commit time).
 *
 * Fence file
 * ----------
 * Path:  .orchestrator/staging-fence/<agent-id>.json
 * Shape:
 *   {
 *     "agent_id":    "string",          // ${SO_WAVE_AGENT}-${pid}-${rnd}
 *     "pid":         12345,
 *     "host":        "string",
 *     "started_at":  "2026-05-23T21:30:00.000Z",
 *     "staged_paths": [
 *       { "paths": ["src/foo.ts"], "command_hash": "a635c66ec7e7bf56",
 *         "timestamp": "2026-…" },
 *       ...
 *     ]
 *   }
 *
 * The entry records the PATH OPERANDS, never the command text (#1404): a
 * staging command can carry a secret (`GIT_TOKEN=… git add x`), and the raw
 * string was persisted verbatim to disk — the same defect 8f15f77b removed
 * from hooks/enforce-commands.mjs. Paths are what the only reader
 * (hooks/wave-scope-commit-guard.mjs) actually needs; `command_hash` keeps
 * the entry countable and groupable without the text.
 *
 * `paths: ["*"]` means "stages a set no operand names" (`git add -A`, `.`,
 * `-u`) and overlaps EVERY staged path — the case the reader's old raw-text
 * regex could not see at all, because `-A` contains no path to match.
 *
 * Decision flow (G1-G6 early-return ladder):
 *   G1  tool filter — Bash and Monitor
 *   G2  command must be a non-empty string
 *   G3  cheap regex PRE-FILTER — skip the tokenizer for plainly unrelated
 *       commands (see mayStage; it does not decide the question)
 *   G4  context gate — isWaveAgentContext(); exit 0 immediately for
 *       coordinator/manual commits (AC5 safe-default no-op)
 *   G4b tokenize + extract path operands; exit 0 when no `git add` statement
 *       resolves (a pre-filter false positive writes nothing)
 *   G5  derive agent_id, build fence dir + path
 *   G6  read-modify-write the fence file (append the staging-intent entry).
 *       Errors are warned + swallowed — the hook NEVER blocks the Bash call.
 *
 * Bypass / disable
 * ----------------
 *   - SO_DISABLED_HOOKS=pre-bash-staging-fence  → exits 0 immediately
 *   - SO_HOOK_PROFILE=minimal|off               → exits 0 immediately
 *   - Coordinator-thread invocations            → exits 0 immediately (G4)
 *   - `git commit --no-verify`                  → bypasses the commit-guard
 *     entirely; sub-mode C reconciliation never runs (PSA-001/PSA-003 risk
 *     remains; the operator is opting out by name).
 *
 * Fail-safe posture: never blocks the Bash call, even on internal errors.
 * Worst case is a missed enforcement, not a wedged session.
 */

import { isShellCommandTool, readStdin, emitAllow, writeJsonAtomicSync } from '../scripts/lib/io.mjs';
import { isWaveAgentContext } from '../scripts/lib/wave-context.mjs';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { hashCommand as sharedHashCommand } from './_lib/command-hash.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { stableHostname } from '../scripts/lib/host-identity.mjs';
import { dotGitAncestor, launchDirFromEnv } from '../scripts/lib/platform.mjs';
import { execFileSync } from '../scripts/lib/native-command.mjs';
import { hookProgram } from '../scripts/lib/program-lookup.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Cheap PRE-FILTER for the staging-command gate (G3). It answers "is it worth
 * loading the tokenizer for this command?", never "is this a staging
 * command?" — since #1404 that verdict belongs to {@link extractStagedPaths},
 * which resolves the verb and subcommand properly.
 *
 * The words `git` and `add` must both occur — anywhere, in any order. Global
 * flags between them are therefore tolerated at any length: `git -C sub add x`
 * reaches the extractor, where `\bgit\s+add\b` used to drop it silently.
 * `\badd\b` keeps `git addremote` out.
 *
 * Why not "same statement, within N characters" (#1670 item 6): the previous
 * `\bgit\b[^;&|\n]{0,120}\badd\b` let `git -C <long path> -c k=v … add x`, a
 * quoted `;`/`&`/`|` in a `-c` value, and a `\`-newline continuation pass
 * UNFENCED — this pre-filter is the fence's only early exit, so every miss
 * fails OPEN. Dropping the bound (`[^;&|\n]*`) is not an option either: it
 * backtracks once per `git` occurrence, quadratic on attacker-influenced text
 * (measured 2026-10-18: 200 kB of `git ` → 6220 ms, past the 5 s hook budget;
 * two independent word tests → 0.16 ms). Two `\b` tests are linear.
 *
 * False positives are cheap AND inert: `git commit -m "add x"` matches here,
 * resolves to no `git add` statement, and writes nothing (G4b).
 *
 * `stage` is git's built-in synonym for `add` (#1671 item 5).
 *
 * NAMED CEILING (BV-004, #1671 item 5): a subcommand spelled with shell quoting
 * or escaping — `git a\dd x`, `git a''dd x` — misses both this pre-filter and
 * the extractor's unquoted-subcommand check, so that staging is not recorded.
 * The fence only RECORDS (it never blocks), so the loss is a collision entry,
 * not a bypassed denial. REVISIT TRIGGER: a wave agent observed staging with a
 * quoted/escaped subcommand, or the fence starting to block.
 *
 * @param {string} command
 * @returns {boolean}
 */
function mayStage(command) {
  // #2190 item 3: a word glued to a LITERAL backslash-n (`printf 'cd x\ngit add
  // b' | sh`) has no `\b` before it, so the `\n` the printf turns into a newline
  // hid the verb. `(?<=\\n)` admits that one escape; false positives stay inert.
  return /(?:\b|(?<=\\n))(?:add|stage)\b/.test(command) && /(?:\b|(?<=\\n))git\b/.test(command);
}

/**
 * Recorded in place of a path list when the staging command names NO explicit
 * path operand but stages a set we cannot enumerate — `git add -A`,
 * `git add .`, `git add -u`, `git add --pathspec-from-file=<f>`. The reader
 * (hooks/wave-scope-commit-guard.mjs) treats it as "overlaps every staged
 * path". This is the case the previous raw-command regex silently MISSED:
 * `-A` contains no path text, so `pathRegex(ours).test('git add -A')` was
 * always false and the widest staging command of all fenced nothing.
 */
const ALL_PATHS_MARKER = '*';

/** git GLOBAL flags (before the subcommand) that consume the NEXT token. */
const GIT_GLOBAL_VALUE_FLAGS = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
]);

/** `git add` and its built-in synonym `git stage` (#1671 item 5). */
const GIT_ADD_SUBCOMMANDS = new Set(['add', 'stage']);

/** `git add` flags that consume the NEXT token as their value. */
const GIT_ADD_VALUE_FLAGS = new Set(['--chmod']);

/** `git add` long flags that stage a set no path operand names. */
const GIT_ADD_ALL_FLAGS = new Set(['--all', '--no-ignore-removal', '--update']);

/**
 * Shells whose `-c <payload>` operand is a command line the shell EXECUTES, so
 * a `git add` inside it stages this working copy for real.
 *
 * DELIBERATE DUPLICATE of the `DASH_C_SHELLS` set and its loose `-…c` scan from
 * scripts/lib/command-blocker.mjs (the -c GRAMMAR is shared, see below) —
 * that module still does not export the set nor its internal `dashCPayloads`,
 * and #1404's own rule for this hook is to consume the tokenizer, not to edit
 * it. Change one, change both. What IS shared since #1833: the shell grammar
 * that reads WHICH word is the command string — {@link nestedShellPayloads}
 * calls the exported `shellCommandString` over `argvWordsWithoutRedirects`,
 * the same call shape as `dashCPayloads`.
 */
const DASH_C_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'su', 'runuser', 'sg']);

/**
 * The su-like verbs of DASH_C_SHELLS, read by the blocker's su grammar
 * (`suCommandStrings(words, verb)`) and never by the shell grammar. Same
 * DELIBERATE-DUPLICATE contract as the set above: `SU_LIKE_SHELLS` in
 * scripts/lib/command-blocker.mjs is not exported. `fish` is routed to the
 * same export (its own `-c`/`--command` grammar) AND keeps the shell grammar,
 * as `dashCPayloads` does (#1944 sister gap).
 */
const SU_LIKE_SHELLS = new Set(['su', 'runuser', 'sg']);
// NAMED CEILING (BV-004, #2190 item 2): a su-like program fed through xargs
// argv (`printf '%s\n' root -c 'git add b' | xargs su`) is not recorded — the
// set above is deliberately kept out of the xargs reader's shell argv (#2013).
// The fence only records, so the loss is a missing collision entry. REVISIT
// TRIGGER: #2013 acceptance 2 (su-like programs in the xargs reader), or a wave
// agent seen staging through that shape.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * sha256(command) truncated to 16 hex chars.
 *
 * DELIBERATE DUPLICATE of hooks/enforce-commands.mjs (itself a copy of
 * hooks/pre-bash-destructive-guard.mjs) — see the 8f15f77b commit message:
 * the three guards stay import-free of each other on purpose, so a shared
 * helper is NOT introduced. The hash keeps a fence entry COUNTABLE and
 * GROUPABLE without persisting command text that may carry a secret
 * (`GIT_TOKEN=… git add x`) — issue #1404.
 *
 * @param {string} command
 * @returns {string}
 */
function hashCommand(command) {
  // Keyed host-local HMAC since #1880 (was unsalted sha256) — see hooks/_lib/command-hash.mjs.
  return sharedHashCommand(command);
}

/**
 * Normalise a path token so writer and reader compare the same spelling.
 *
 * DELIBERATE DUPLICATE of the identically-named function in
 * hooks/wave-scope-commit-guard.mjs — the reader is a husky pre-commit hook
 * outside the Claude-Code hook import set, and the two must agree byte for
 * byte. Change one, change both.
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeStagedPath(raw) {
  let p = String(raw).trim();
  while (p.startsWith('./')) p = p.slice(2);
  p = p.replace(/\/{2,}/g, '/');
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Extract the PATH OPERANDS of every `git add` statement in a Bash command.
 *
 * Reuses the repo's own shell tokenizer (scripts/lib/command-blocker.mjs) —
 * no second shell grammar is invented here. The import is LAZY: this hook
 * runs on every Bash call of every session, and only a `git add` command
 * (G3) ever reaches this function, so the tokenizer's module graph must not
 * be paid for by the other 99% of calls.
 *
 * Handled: `git add -- a b`, quoted operands with spaces, `git -C <dir> add x`
 * (relative `-C` is prefixed onto the operand), chained statements
 * (`cd x && git add y` — each statement is its own segment), leading env
 * assignments, and the enumerate-nothing flags that yield ALL_PATHS_MARKER.
 *
 * NAMED CEILINGS (BV-004):
 *  - Operands are recorded as WRITTEN, relative to the invoking cwd. A
 *    `cd subdir && git add foo.ts` records `foo.ts` while the staged path is
 *    `subdir/foo.ts` → a miss. This is exactly the pre-#1404 behaviour (the
 *    raw-command regex missed it too), not a new gap; revisit if a wave agent
 *    is ever observed staging from a subdirectory.
 *  - An ABSOLUTE operand (or an absolute `-C`) is recorded verbatim and will
 *    not match a repo-relative staged path. Same ceiling, same trigger.
 *  - A command the tokenizer resolves to no `git add` statement (`echo "git
 *    add x"` — G3's documented, tolerated false positive) yields an EMPTY
 *    list, never the marker: over-reporting here would turn a log line into a
 *    blocked commit, which the hook's fail-safe posture forbids. This is also
 *    why a blanket "pre-filter hit but nothing resolved → `paths: ['*']`"
 *    floor was REJECTED at the 2026-09-20 fix: `git commit -m "add x"` matches
 *    {@link mayStage}, and the marker overlaps EVERY staged path, so that
 *    floor manufactures a collision for a command that stages nothing.
 *  - A staging command a shell never executes locally is not recorded, and
 *    should not be: `ssh host 'git add x'` stages a REMOTE index, and
 *    `git submodule foreach "git add x"` stages the SUBMODULE's — neither can
 *    collide with a sibling agent in this working copy.
 *    REVISIT TRIGGER: if the commit-guard ever reconciles submodule indexes.
 *
 * @param {string} command
 * @returns {Promise<{ recognised: boolean, paths: string[] }>}
 */
async function extractStagedPaths(command) {
  let lib;
  try {
    lib = await import('../scripts/lib/command-blocker.mjs');
  } catch {
    return { recognised: false, paths: [] };
  }

  // #2032: a line past the blocker's size bound is not split. It may stage
  // anything, so it is recorded as the marker that overlaps every path (the
  // fence's fail-closed reading); the fence still never blocks.
  if (lib.oversizedCommand(command) !== null) return { recognised: true, paths: ['*'] };
  const paths = new Set();
  const state = { recognised: false };
  scanForStagedPaths(command, lib, paths, state, 'command');
  return { recognised: state.recognised, paths: [...paths] };
}

/**
 * Collect the command lines a shell nested in this segment will EXECUTE.
 *
 * Two sources, unioned:
 *  - wrapper payloads `resolveSegmentVerb` already reports (`env -S '…'`),
 *    across both readings of an ambiguous dual parse (#1000);
 *  - a `-c`-style operand following a {@link DASH_C_SHELLS} token ANYWHERE in
 *    the segment, not only in resolved-verb position. The wider scan is what
 *    covers `xargs -I{} sh -c "git add x"` and `find … -exec sh -c "…" \;`,
 *    whose resolved verb is `xargs`/`find`; keying on the shell TOKEN instead
 *    of the verb also keeps `grep -c <pattern>` out, because `grep` is not a
 *    shell name. Per shell token the loose `-…c` + next-word scan is UNIONED
 *    with command-blocker's shell grammar (`shellCommandString`, both the
 *    bash and the zsh redirect view; `su`/`runuser`/`sg`/`fish` through `suCommandStrings(words, verb)` as `dashCPayloads` reads them, #1944):
 *    `bash +c '…'`, `bash -ce '…'`, `bash -c -e '…'` and `bash -c -- '…'`
 *    gave the loose scan the wrong word or none (#1833). Union, never replace;
 *    without the two exports (a degraded load) the loose scan still runs.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {{ payloads: string[], alt?: { payloads: string[] } }} resolved
 * @param {{ shellCommandString?: Function, suCommandStrings?: Function, argvWordsWithoutRedirects?: Function }} lib
 * @returns {string[]} distinct payload strings
 */
function nestedShellPayloads(segment, resolved, lib) {
  const grammar =
    typeof lib.shellCommandString === 'function' && typeof lib.argvWordsWithoutRedirects === 'function';
  const out = new Set();
  for (const reading of [resolved, resolved.alt]) {
    if (!reading) continue;
    for (const p of reading.payloads) out.add(p);
  }
  // #2190 item 1: every shell token used to re-walk the whole rest of the
  // segment (the loose `-c` scan, and `argvWordsWithoutRedirects` once per
  // view), so a line of N shell words cost O(N^2) — 90 kB ran 8.4 s against
  // the 5 s hook budget and a timeout loses the record. Both are computed
  // once per segment, on first use, and shared by every token.
  let nextC = null;
  let views = null;
  for (let i = 0; i < segment.length - 1; i++) {
    const tok = segment[i];
    const shell = tok.quoted ? null : path.basename(tok.text);
    if (shell === null || !DASH_C_SHELLS.has(shell)) continue;
    if (nextC === null) nextC = nextDashCIndex(segment);
    if (nextC[i + 1] !== -1) out.add(segment[nextC[i + 1] + 1].text);
    // #1944: su (and runuser/sg) run `-c S` behind a user name and in glued or
    // `--command=` spellings the loose scan above misses (`sg GROUP S` even
    // without `-c`); the blocker's su grammar reads them with the REAL verb.
    // NAMED CEILING (BV-004, #2190): su/runuser/sg/fish still re-walk the rest
    // of the segment per token (`suCommandStrings` is position-free), so a
    // line made of thousands of those words stays quadratic; the sh/bash/zsh
    // path below is linear. REVISIT TRIGGER: a command of this shape seen
    // near the hook budget, or `suCommandStrings` taking a precomputed suffix.
    const suLike = SU_LIKE_SHELLS.has(shell);
    if ((suLike || shell === 'fish') && typeof lib.suCommandStrings === 'function' && typeof lib.argvWordsWithoutRedirects === 'function') {
      for (const payload of lib.suCommandStrings(lib.argvWordsWithoutRedirects(segment, i + 1), shell)) out.add(payload);
    }
    if (grammar && !suLike) {
      if (views === null) views = [true, false].map((bash) => argvSuffixes(segment, lib, bash));
      for (const [bash, view] of [[true, views[0]], [false, views[1]]]) {
        // A redirect token carrying a shell name starts a span the suffix
        // map cannot place: read that one token the long way.
        const words = segment[i].redirect
          ? lib.argvWordsWithoutRedirects(segment, i + 1, { bash })
          : view.from(i + 1);
        const payload = lib.shellCommandString(words, {
          zsh: shell === 'zsh',
          ksh: shell === 'ksh',
        });
        if (payload !== null) out.add(payload);
      }
    }
  }
  return [...out];
}

/**
 * `next[k]` = the first index `j >= k` whose word is a `-…c` option with a
 * following word (`j < segment.length - 1`), or -1. One backward pass, so the
 * loose `-c` scan of {@link nestedShellPayloads} is O(1) per shell token.
 *
 * @param {Array<{ text: string }>} segment
 * @returns {Int32Array}
 */
function nextDashCIndex(segment) {
  const next = new Int32Array(segment.length + 1).fill(-1);
  for (let k = segment.length - 2; k >= 0; k--) {
    next[k] = /^-[A-Za-z]*c$/.test(segment[k].text) ? k : next[k + 1];
  }
  return next;
}

/**
 * The argv words of the WHOLE segment in one `argvWordsWithoutRedirects` pass,
 * plus `from(k)`: the same words `argvWordsWithoutRedirects(segment, k, view)`
 * would return, as a no-copy view. Valid for every `k` that is a loop index of
 * the full pass — `k = i + 1` for a non-redirect token `i` always is (a redirect
 * span ends before a fresh word starts) — which is why the caller falls back
 * to the direct call for a redirect token.
 *
 * The words are the segment's own token objects (or a redirect's
 * `bashArgvWord`), so a Map from word to position places each segment index
 * without re-implementing the blocker's redirect-span rule.
 *
 * @param {Array<{ text: string, redirect?: object, bashArgvWord?: object }>} segment
 * @param {{ argvWordsWithoutRedirects: Function }} lib
 * @param {boolean} bash
 * @returns {{ from: (k: number) => Array<{ text: string, quoted: boolean }> }}
 */
function argvSuffixes(segment, lib, bash) {
  const words = lib.argvWordsWithoutRedirects(segment, 0, { bash });
  const position = new Map();
  for (let w = 0; w < words.length; w++) position.set(words[w], w);
  const starts = new Array(segment.length + 1);
  starts[segment.length] = words.length;
  for (let k = segment.length - 1; k >= 0; k--) {
    const tok = segment[k];
    const word = tok.redirect ? tok.bashArgvWord : tok;
    starts[k] = word !== undefined && position.has(word) ? position.get(word) : starts[k + 1];
  }
  return {
    from(k) {
      const start = starts[k];
      if (start === 0) return words;
      const length = words.length - start;
      // Index-and-length view: `shellCommandString` stops at the first
      // deciding word, so a copy of the suffix per token would bring the
      // quadratic back.
      return new Proxy([], {
        get(target, key) {
          if (key === 'length') return length;
          if (typeof key === 'string' && /^\d+$/.test(key)) return Number(key) < length ? words[start + Number(key)] : undefined;
          return Reflect.get(target, key);
        },
        has(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) return Number(key) < length;
          return Reflect.has(target, key);
        },
      });
    },
  };
}

/**
 * The command lines a stdin-reading shell runs from literal data in this
 * segment (#1999 finding 6): `printf 'git add x' | sh`, `sh <<< 'git add x'`,
 * a here-doc or `<(echo …)` into a shell, and `printf '"git add x"' | xargs
 * sh -c` — read by the blocker's exported `pipedShellData`, whose pipe-read
 * context `splitChainSegments` already attached to the segment.
 *
 * Data the blocker marks `unreadable` is handled as the fence handles an
 * unparseable command: what was read is recorded, the rest is not, and no
 * marker is invented (the fence only records; see extractStagedPaths'
 * ceilings). A throw records nothing for this segment, for the same reason.
 *
 * For xargs, `pipedShellData` calls the blocker's `xargsCommandLines` reader.
 * It builds commands for direct git invocations, wrappers such as `xargs env`,
 * and shells taking `-c` and its script from the input items (#2013). The
 * last form needs one shell-argv reading after the reader splits the items,
 * taken only when the xargs segment has no fixed `-c` script.
 *
 * Named ceiling (BV-004): the fence inherits the deny-side over-read of
 * `xargsCommandLines` (every item window is read, #2006), so
 * `printf '%s\n' x -c 'git add b' | xargs -d '\n' -n 2 sh` records `b` though
 * nothing is staged. A false record can stop a sibling's commit at the
 * commit guard. REVISIT: a reported false cross-agent overlap.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {{ pipedShellData?: Function }} lib
 * @returns {string[]}
 */
function pipedShellLines(segment, lib) {
  if (typeof lib.pipedShellData !== 'function') return [];
  try {
    return [...lib.pipedShellData(segment)];
  } catch {
    return [];
  }
}

/**
 * One tokenize + per-segment pass of {@link extractStagedPaths}. An outer
 * command can supply a payload directly or via argv built by xargs. A payload
 * is scanned for staging only. A shell nested inside a payload, or inside the
 * data of a fixed xargs `-c` script, is not read again: a named ceiling
 * (BV-004); revisit if observed in a wave transcript.
 *
 * Accumulates into the caller's `paths` set and `state.recognised` flag rather
 * than returning, so a nested hit and a top-level hit compose:
 * `git add a && bash -c "git add b"` records BOTH.
 *
 * @param {string} command
 * @param {typeof import('../scripts/lib/command-blocker.mjs')} lib
 * @param {Set<string>} paths - OUT
 * @param {{ recognised: boolean }} state - OUT
 * @param {'command'|'xargs'|'payload'} source
 * @returns {void}
 */
function scanForStagedPaths(command, lib, paths, state, source) {
  let segments;
  try {
    segments = lib.splitChainSegments(lib.tokenizeCommand(command));
  } catch {
    return;
  }

  function scanPayload(payload, nextSource) {
    if (typeof payload === 'string' && mayStage(payload)) {
      scanForStagedPaths(payload, lib, paths, state, nextSource);
    }
  }

  for (const segment of segments) {
    const resolved = lib.resolveSegmentVerb(segment);
    const { verb, index } = resolved;

    // A staging command nested in `bash -c "…"` resolves to the verb `bash`,
    // so the loop below never sees it. Before #1404 the raw-text regex matched
    // it INSIDE the quotes and the reader's path regex found the collision;
    // the tokenizer rewrite dropped the whole class silently (measured
    // 2026-09-20: `bash -c "git add src/foo.ts"` → no fence file at all). The
    // fence is cross-agent collision detection, so a miss is silent in BOTH
    // directions — re-enter the same extraction on the payload.
    if (source === 'command') {
      const fixed = nestedShellPayloads(segment, resolved, lib);
      for (const payload of fixed) scanPayload(payload, 'payload');
      // The shell-argv reading applies only without a fixed `-c`: then the reader builds
      // shell argv lines; with one, the items are data the fixed script may never run.
      for (const line of pipedShellLines(segment, lib)) {
        scanPayload(line, verb === 'xargs' && fixed.length === 0 ? 'xargs' : 'payload');
      }
    } else if (source === 'xargs' && DASH_C_SHELLS.has(verb) && !SU_LIKE_SHELLS.has(verb)) {
      // #2013: read the resolved shell's argv. A later `-c` following a
      // script filename or passed to another program is just an argument.
      const words = lib.argvWordsWithoutRedirects(segment, index + 1);
      scanPayload(lib.shellCommandString(words, { zsh: verb === 'zsh', ksh: verb === 'ksh' }), 'payload');
    }

    if (verb !== 'git' || index < 0) continue;

    let i = index + 1;
    let chdir = null;

    // git GLOBAL flags sit between `git` and the subcommand.
    while (i < segment.length) {
      const tok = segment[i];
      if (tok.quoted || !tok.text.startsWith('-') || tok.text === '-') break;
      if (GIT_GLOBAL_VALUE_FLAGS.has(tok.text)) {
        if (tok.text === '-C' && i + 1 < segment.length) chdir = segment[i + 1].text;
        i += 2;
        continue;
      }
      i += 1; // boolean global flag, or attached `--git-dir=<p>`
    }

    if (i >= segment.length || segment[i].quoted || !GIT_ADD_SUBCOMMANDS.has(segment[i].text)) continue;
    state.recognised = true;
    i += 1;

    let endOfFlags = false;
    let stagesAll = false;

    // #2031 item 6: git receives the argv the shell leaves AFTER removing
    // redirects, so `git add a >/dev/null` has the operand `a` only. The
    // blocker's own grammar (`argvWordsWithoutRedirects`, redirectSpanEnd's
    // rule) drops each redirect token with the word it owns; a here-doc body
    // arrives as a quoted word marked `heredocBody` and is data, not a path.
    // A quoted `'>'` is an ordinary word (no `redirect` field) and stays.
    const words = lib.argvWordsWithoutRedirects(segment, i).filter((t) => !t.heredocBody);

    for (let w = 0; w < words.length; w++) {
      const tok = words[w];
      const text = tok.text;

      if (!endOfFlags && !tok.quoted && text.startsWith('-') && text !== '-') {
        if (text === '--') { endOfFlags = true; continue; }
        if (GIT_ADD_VALUE_FLAGS.has(text)) { w += 1; continue; }
        if (text === '--pathspec-from-file' || text.startsWith('--pathspec-from-file=')) {
          stagesAll = true;
          if (text === '--pathspec-from-file') w += 1;
          continue;
        }
        if (GIT_ADD_ALL_FLAGS.has(text)) { stagesAll = true; continue; }
        // Short-flag cluster: `-A`, `-u`, `-An`, `-vu` all stage a set no
        // operand names.
        if (!text.startsWith('--') && /[Au]/.test(text.slice(1))) stagesAll = true;
        continue;
      }

      if (text === '.' || text === './') { stagesAll = true; continue; }
      const operand = chdir && !chdir.startsWith('/') ? `${chdir}/${text}` : text;
      const normalised = normalizeStagedPath(operand);
      if (normalised.length > 0) paths.add(normalised);
    }

    if (stagesAll) paths.add(ALL_PATHS_MARKER);
  }
}

/**
 * Derive a per-agent identifier for the fence filename.
 *
 * Composition: `${SO_WAVE_AGENT}-${pid}-${rnd6hex}`.
 * - SO_WAVE_AGENT is always "1" inside a wave-agent context (per
 *   wave-context.mjs strict-equality contract), so the prefix is fixed.
 * - PID disambiguates concurrent agents on the same host.
 * - 6 hex chars (24 bits) defends against PID reuse within a long-running
 *   session, even though that race is vanishingly rare.
 *
 * The same PID may invoke `git add` repeatedly in one wave; the hook reads
 * the existing fence file (matched by composing the same agent_id), appends,
 * and rewrites. The random suffix is therefore frozen per process via
 * lazy-init: the first call computes it; subsequent calls reuse it.
 *
 * NOTE: Because each hook subprocess is a fresh Node process, the random
 * suffix is unique per `git add` invocation — there is no in-process cache
 * to reuse. We accept N fence files per agent (one per `git add` call) and
 * the commit-guard scans ALL fence files at commit time.
 *
 * @returns {string}
 */
function deriveAgentId() {
  const waveAgent = process.env.SO_WAVE_AGENT ?? '1';
  const pid = process.pid;
  const rnd = crypto.randomBytes(3).toString('hex');
  return `${waveAgent}-${pid}-${rnd}`;
}

/**
 * The repo whose fence directory this `git add` is recorded in — the SAME root
 * the reader uses (#1504 point 4). The only reader, `hooks/wave-scope-commit-guard.mjs`,
 * runs as git's pre-commit hook and walks `<git rev-parse --show-toplevel>/.orchestrator/staging-fence/`,
 * i.e. the work-tree root the commit is made in. `dotGitAncestor(cwd)` is that
 * root without a spawn: the nearest `.git` entry at or above the payload `cwd` —
 * the worktree root for a session that entered a worktree (measured 2026-10-03:
 * launch dir `<main>`, cwd `<worktree>/sub` → `<worktree>`, git toplevel
 * `<worktree>`), the repo root for a launch in a repo SUBDIRECTORY. The launch
 * dir (`$CLAUDE_PROJECT_DIR`) was wrong in both: the fence landed where no
 * commit guard looked, and every cross-agent overlap passed.
 *
 * Deliberately NOT `resolveSessionRoot()`: its clamp answers the launch
 * SUBDIRECTORY of a monorepo package, while git's toplevel is the repo root.
 *
 * Fallback when the payload carries no `cwd`, or `cwd` is in no repo (where no
 * commit can read a fence anyway): the launch dir from env, then `process.cwd()`.
 *
 * NAMED CEILING (BV-004): the root follows the payload `cwd`, not the command —
 * `git -C <other-tree> add` or `cd <other-tree> && git add` records the intent
 * in the CURRENT tree's fence dir while the commit in `<other-tree>` reads its
 * own, so that overlap stays unseen (as before). Revisit if a fence miss is
 * ever traced to a redirected `git add`; the fix then is to resolve the root
 * from the tokenized command's `-C` / leading `cd`.
 *
 * @param {object|null} input  the hook payload
 * @returns {string}
 */
function resolveFenceRoot(input) {
  const cwd = typeof input?.cwd === 'string' ? input.cwd.trim() : '';
  return (cwd !== '' && dotGitAncestor(cwd)) || launchDirFromEnv() || process.cwd();
}

/**
 * Append a staging-intent entry to the fence file. Reads the existing file
 * (if any), appends the entry, and rewrites atomically via the shared
 * {@link writeJsonAtomicSync} helper from scripts/lib/io.mjs (extracted in
 * #558 M1). The first call for a given agent_id creates the file with a
 * fresh body.
 *
 * @param {{ fenceFile: string, agentId: string, command: string, paths: string[] }} args
 * @returns {{ ok: true } | { ok: false, reason: 'fs-error', error: string }}
 */
function appendIntent({ fenceFile, agentId, command, paths }) {
  const timestamp = new Date().toISOString();

  let body;
  if (existsSync(fenceFile)) {
    try {
      const raw = readFileSync(fenceFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.staged_paths)) {
        body = parsed;
      }
    } catch {
      // Malformed existing fence file — overwrite with a fresh one.
      body = undefined;
    }
  }

  if (!body) {
    body = {
      agent_id: agentId,
      pid: process.pid,
      // `host` raw + `host_id` normalised (#1072 — os.hostname() flips spelling
      // on a single machine, so a raw value is not comparable across writes).
      host: os.hostname(),
      host_id: stableHostname(),
      started_at: timestamp,
      staged_paths: [],
    };
  }

  // #1404 — persist what the READER needs (path operands), never the command
  // text: a staging command can carry a secret in a leading env assignment.
  // The hash keeps the entry countable/groupable, mirroring enforce-commands.
  body.staged_paths.push({
    paths,
    command_hash: hashCommand(command),
    timestamp,
  });

  return writeJsonAtomicSync(fenceFile, body, { tmpPrefix: '.fence.tmp' });
}

// ---------------------------------------------------------------------------
// Work-tree recorder (#1659)
// ---------------------------------------------------------------------------

/**
 * Cheap PRE-FILTER for the work-tree recorder — same shape and same role as
 * {@link mayStage}, for the same reasons (#1670 item 6: a bounded lookahead
 * silently skipped `git -C <long path> -c … commit`): only a hit pays for the
 * tokenizer and a git spawn. False positives (`echo "git commit"`) resolve to
 * no commit statement and record nothing.
 *
 * @param {string} command
 * @returns {boolean}
 */
function mayCommit(command) {
  return /\bcommit\b/.test(command) && /\bgit\b/.test(command);
}

/** Timeout for the one `git rev-parse` per commit tree (hook budget is 5 s). */
const RECORDER_GIT_TIMEOUT_MS = 2000;

/** Directory-changing verbs whose effect the walker does not model (#1659). */
const DIR_UNKNOWN_VERBS = new Set(['pushd', 'popd', 'chdir']);
/** Builtins that change the directory when invoked as `builtin <name>` (#1659). */
const DIR_CHANGE_BUILTINS = new Set(['cd', 'pushd', 'popd', 'chdir']);

/**
 * Expand a `cd`/`-C` operand against the current directory. Returns null when
 * the operand cannot be resolved without a shell (`$VAR`, `~user`, `-`), so
 * the caller records nothing rather than a guessed tree.
 *
 * @param {string} base - absolute current directory
 * @param {string} operand
 * @returns {string|null}
 */
function resolveDirOperand(base, operand) {
  if (operand === '~') return os.homedir();
  if (operand.startsWith('~/')) return path.join(os.homedir(), operand.slice(2));
  if (operand === '-' || operand.startsWith('~') || operand.includes('$') || operand.includes('`')) return null;
  return path.resolve(base, operand);
}

/**
 * Effective directories of every `git commit` statement in a command.
 *
 * Walks the chain segments in order, tracking the directory the shell would be
 * in: a `cd <dir>` statement moves it (relative to the previous one), and each
 * `-C <dir>` global flag of the commit statement composes on top, as git does.
 * A `cd` whose operand is unresolvable (`cd "$WT"`) makes the directory
 * UNKNOWN for the rest of the command — later commits are not recorded rather
 * than misattributed to the launch tree. So does any directory change the
 * walker does not model (`pushd`, `popd`, `chdir`, `builtin cd`).
 *
 * NAMED CEILINGS (BV-004): subshell scope is not modelled — `(cd x && git
 * commit); git commit` attributes the second commit to `x` too; a commit nested
 * in `bash -c "…"` is not recorded. REVISIT if a session's commits are found
 * missing from `orchestrator.session.work_tree` for one of these shapes.
 *
 * @param {string} command
 * @param {string} startDir - absolute directory the command starts in
 * @param {{ tokenizeCommand: Function, splitChainSegments: Function,
 *           resolveSegmentVerb: Function }} lib
 * @returns {string[]} distinct absolute directories
 */
function commitDirs(command, startDir, lib) {
  const out = new Set();
  let cwd = startDir;
  const tokens = lib.tokenizeCommand(command);
  // No paren stripping here: since #1667 the shared tokenizer turns subshell
  // parens into statement breaks and appends `$( )`/backtick bodies as their
  // own statements. A hand strip on top only ever changed `((git commit))`
  // — arithmetic, not a commit — into a recorded commit (#1670).
  //
  // Those hoisted bodies sit AFTER every outer statement, behind the first
  // `operator: 'substitution'` separator, so walking them in stream order would
  // judge `cd sub && echo $(git commit); cd ../other` against `other`. Walk the
  // outer statements first; the bodies then run in the start directory only
  // when no outer statement moved it, and in an UNKNOWN directory otherwise
  // (not recorded rather than misattributed).
  const cut = tokens.findIndex((t) => t.operator === 'substitution');
  const outer = cut < 0 ? tokens : tokens.slice(0, cut);
  const hoistedSegments = cut < 0 ? [] : lib.splitChainSegments(tokens.slice(cut));
  const outerSegments = lib.splitChainSegments(outer);
  let moved = false;
  const segments = [...outerSegments, null, ...hoistedSegments];
  for (const segment of segments) {
    if (segment === null) {
      // Boundary between the outer statements and the hoisted bodies.
      cwd = moved ? null : startDir;
      continue;
    }
    if (segment.length === 0) continue;
    const { verb, index } = lib.resolveSegmentVerb(segment);
    if (index < 0) continue;

    // A directory change the walker does not model (`pushd`, `popd`, zsh's
    // `chdir`, `builtin cd …`) makes the directory UNKNOWN, like an
    // unresolvable `cd` operand — never misattributed to the old tree (#1659).
    if (!segment[index].quoted && (DIR_UNKNOWN_VERBS.has(verb)
      || (verb === 'builtin' && index + 1 < segment.length && DIR_CHANGE_BUILTINS.has(segment[index + 1].text)))) {
      cwd = null;
      moved = true;
      continue;
    }

    if (verb === 'cd' && !segment[index].quoted) {
      moved = true;
      if (cwd === null) continue;
      let operand = null;
      for (let j = index + 1; j < segment.length; j++) {
        const t = segment[j];
        if (!t.quoted && t.text.startsWith('-') && t.text !== '-') continue; // -P / -L
        operand = t.text;
        break;
      }
      cwd = operand === null ? os.homedir() : resolveDirOperand(cwd, operand);
      continue;
    }

    if (verb !== 'git' || cwd === null) continue;
    let dir = cwd;
    let i = index + 1;
    while (i < segment.length) {
      const tok = segment[i];
      if (tok.quoted || !tok.text.startsWith('-') || tok.text === '-') break;
      if (GIT_GLOBAL_VALUE_FLAGS.has(tok.text)) {
        if (tok.text === '-C' && i + 1 < segment.length && dir !== null) {
          dir = resolveDirOperand(dir, segment[i + 1].text);
        }
        i += 2;
        continue;
      }
      i += 1;
    }
    if (i < segment.length && !segment[i].quoted && segment[i].text === 'commit' && dir !== null) {
      out.add(dir);
    }
  }
  return [...out];
}

/**
 * Record `(tree, start_ref)` for every tree a `git commit` in this command
 * targets, as an `orchestrator.session.work_tree` event (#1659).
 *
 * Runs for EVERY session context (coordinator and wave agents alike), before
 * the fence gates. Best-effort and side-effect-only: it never throws, never
 * blocks, and never touches the hook's decision — the caller emits the same
 * allow either way. One record per commit; the READER dedupes (first record
 * per tree wins), so no ledger read happens on this path.
 *
 * Cost on a command without a commit: one or two linear word tests.
 *
 * @param {object} input - the hook payload
 * @param {string} command
 * @returns {Promise<void>}
 */
async function recordWorkTrees(input, command) {
  try {
    if (!mayCommit(command)) return;
    const sessionId = typeof input?.session_id === 'string' ? input.session_id.trim() : '';
    if (sessionId === '') return;
    const payloadCwd = typeof input?.cwd === 'string' ? input.cwd.trim() : '';
    const startDir = path.isAbsolute(payloadCwd) ? payloadCwd : process.cwd();

    const lib = await import('../scripts/lib/command-blocker.mjs');
    // #2032: a line past the size bound is not split; no tree is recorded.
    if (lib.oversizedCommand(command) !== null) return;
    const dirs = commitDirs(command, startDir, lib);
    if (dirs.length === 0) return;

    const pairs = new Map();
    for (const dir of dirs) {
      let lines;
      try {
        lines = execFileSync(hookProgram('git', dir), ['-C', dir, 'rev-parse', '--show-toplevel', 'HEAD'], {
          encoding: 'utf8',
          timeout: RECORDER_GIT_TIMEOUT_MS,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).split('\n');
      } catch {
        continue; // not a repo, dir gone, or unborn HEAD — nothing to anchor on
      }
      const top = (lines[0] || '').trim();
      const head = (lines[1] || '').trim();
      if (top === '' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head)) continue;
      let tree = top;
      try { tree = realpathSync(top); } catch { /* keep git's spelling */ }
      if (!pairs.has(tree)) pairs.set(tree, head);
    }
    if (pairs.size === 0) return;

    const { emitEvent } = await import('../scripts/lib/events.mjs');
    const { SESSION_WORK_TREE_EVENT } = await import('../scripts/lib/events-schema.mjs');
    for (const [tree, startRef] of pairs) {
      try {
        await emitEvent(SESSION_WORK_TREE_EVENT, {
          session_id: sessionId,
          tree,
          start_ref: startRef,
        });
      } catch (err) {
        process.stderr.write(
          `⚠ pre-bash-staging-fence: work-tree record not written — ${err?.message || err}\n`,
        );
      }
    }
  } catch (err) {
    process.stderr.write(
      `⚠ pre-bash-staging-fence: work-tree recorder failed — ${err?.message || err}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — Bash and Monitor are gated.
  if (!isShellCommandTool(input.tool_name)) return emitAllow();

  // G2 — command must be a non-empty string.
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // #1659 — record (tree, start_ref) before any `git commit`, in every session
  // context. Side effect only: it cannot change the decision below.
  await recordWorkTrees(input, command);

  // G3 — cheap regex PRE-FILTER. Commands that cannot possibly be a staging
  // command pass through without loading the tokenizer.
  if (!mayStage(command)) return emitAllow();

  // G4 — context gate. Coordinator/manual commits are not fenced.
  if (!isWaveAgentContext()) return emitAllow();

  // G4b — the PRECISE gate (#1404). The tokenizer, not the regex, decides
  // whether this command really stages anything: a pre-filter hit with no
  // resolvable `git add` statement (`git commit -m "add x"`) writes NO fence
  // file, where the pre-#1404 hook logged its raw text.
  const { recognised, paths } = await extractStagedPaths(command);
  if (!recognised) return emitAllow();

  // G5 — derive paths.
  const projectDir = resolveFenceRoot(input);
  const agentId = deriveAgentId();
  const fenceFile = path.join(
    projectDir,
    '.orchestrator',
    'staging-fence',
    `${agentId}.json`,
  );

  // G6 — append intent. Never blocks the Bash call on failure.
  const result = appendIntent({ fenceFile, agentId, command, paths });
  if (!result.ok) {
    process.stderr.write(
      `⚠ pre-bash-staging-fence: failed to write fence file — ${result.error}\n`,
    );
  }

  return emitAllow();
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook('pre-bash-staging-fence')) process.exit(0);

  // Top-level error handler — never let exit 1 leak. Fail-open on internal
  // errors on purpose (#1679 point 3): this hook only LOGS staging intent and
  // never blocks (G6); the commit guard reconciles. Unlike the destructive
  // guard, which denies on an internal error since #1671, a deny here would turn
  // the logger into a gate. Revisit if a fence record is missed because of one.
  main().catch((e) => {
    process.stderr.write(
      `⚠ pre-bash-staging-fence: internal error — ${e?.message || e}\n`,
    );
    process.exit(0);
  });
}
