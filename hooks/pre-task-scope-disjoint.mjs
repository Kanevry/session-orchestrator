#!/usr/bin/env node
/**
 * pre-task-scope-disjoint.mjs — PreToolUse hook on the subagent-dispatch tool.
 *
 * Blocks a wave from handing the SAME file to two agents, at the moment of
 * dispatch, before either agent has written a byte (issue #1020).
 *
 * ## The measurement that shaped this hook (2026-08-14, this repo)
 *
 * The obvious design — "read the batch of sibling agents out of the payload and
 * compare their file scopes" — is NOT implementable. Three findings, each
 * measured against the 12 most recent archived transcripts of this project
 * (147 dispatch tool_use blocks, 51 batches):
 *
 *   1. THE TOOL IS CALLED `Agent`, NOT `Task`.
 *      `jq … select(.type=="tool_use") | .name | sort | uniq -c` over those
 *      transcripts: `Agent` 147. There is a separate, unrelated `Task*` family
 *      (`TaskCreate` 13, `TaskUpdate` 37, `TaskGet` 27, `TaskList` 6,
 *      `TaskStop` 5, `TaskOutput` 54) which is the todo/task surface, not the
 *      subagent dispatch. A `hooks.json` matcher of `Task` would therefore fire
 *      on the todo tools and NEVER on a dispatch. The matcher must be `Agent`.
 *
 *   2. THE PAYLOAD CARRIES NO STRUCTURED FILE SCOPE.
 *      Observed `tool_input` key sets, all 147 blocks:
 *        `description,model,prompt,subagent_type`                      (97)
 *        `description,model,prompt,run_in_background,subagent_type`    (35)
 *        `description,isolation,model,prompt,run_in_background,…`      (14)
 *        `description,prompt,subagent_type`                            (1)
 *      `has("files") , has("file_scope") , has("scope")` → 441 × false
 *      (3 probes × 147 blocks, zero hits). The file scope exists only as PROSE
 *      inside `prompt`. That is the only channel available, so this hook parses
 *      it — conservatively, and every parse failure resolves to ALLOW.
 *
 *   3. THE SIBLINGS ARE NOT VISIBLE YET AT DISPATCH TIME.
 *      Parallel dispatch is real: grouping blocks by `message.id` gives batches
 *      of 1 (13×), 2 (6×), 3 (16×), 4 (8×), 5 (6×) and 6 (2×) agents — so the
 *      naive per-line count of "1 agent per assistant row" is a measurement
 *      artifact of streaming, not the truth. But the agents of a batch land on
 *      CONSECUTIVE transcript rows and their results arrive minutes later, so
 *      reading `transcript_path` at dispatch time yields ZERO not-yet-dispatched
 *      siblings. (What it DOES yield — the state of the ALREADY-dispatched ones
 *      — is the liveness signal in § Liveness below.)
 *
 * Conclusion: the only mechanically decidable construction is a LEDGER — carry
 * state across the dispatches of one wave. Each dispatch records its scope; the
 * next dispatch is checked against everything already recorded for that wave.
 * That is what this hook does. The comparison itself is delegated to
 * `findScopeCollisions()` (scripts/lib/scope-gate.mjs); this hook only supplies
 * the three things a pure library cannot: the ledger, `knownFiles` from
 * `git ls-files`, and the liveness probe below.
 *
 * ## Liveness — the ledger has to know that an agent FINISHED (review HIGH)
 *
 * A ledger without a completion notion denies the wrong thing. Measured over 38
 * archived transcripts of this project (346 `Agent` dispatch blocks): 0 of 4
 * same-batch overlaps and 2 of 2 CROSS-dispatch overlaps would have been denied
 * — and both cross-dispatch pairs were legitimate SEQUENTIAL repair passes
 * ("L2 extract redactSpans primitive" 14:14:26 ←→ its fix 14:50:33;
 * "C2 vcs repo-flag checker" 14:28:35 ←→ its fix 15:17:27). Blocking a repair
 * pass is precisely the session outage the matrix below calls the reason this
 * guard is not fail-closed, and because a deny deliberately does not persist the
 * ledger, the re-dispatch met the same stale record — a PERMANENT block.
 *
 * The discriminator is therefore not time and not the agent's name: it is
 * whether the already-recorded agent is STILL IN FLIGHT. Two transcript shapes
 * carry that, both measured in this repo's own transcripts:
 *
 *   a) SYNCHRONOUS dispatch — the `tool_result` for the dispatch's `tool_use`
 *      id arrives when the agent is done. Batch `msg…`/2026-08-06T07:07:39:
 *      five `Agent` rows within 0.44 s, their five results 5–11 MINUTES later.
 *      At agent #5's PreToolUse none of #1…#4 has a result → all IN FLIGHT →
 *      a real same-batch overlap still DENIES.
 *   b) ASYNCHRONOUS dispatch — the `tool_result` arrives in 0.2 s and reads
 *      `"Async agent launched successfully"`. That text is a LAUNCH
 *      ACKNOWLEDGEMENT, not a completion; treating it as one would let every
 *      real background-batch collision through. Completion arrives later as a
 *      `<task-notification>` record carrying `<tool-use-id>toolu_…</tool-use-id>`
 *      and `<status>completed</status>` (measured: launch 14:14:26.768 →
 *      notification 14:24:39.360, ten minutes later).
 *
 * COST CONTAINMENT: the transcript is read ONLY when a collision has already
 * been found — i.e. on the path that is about to deny. The 99 % no-collision
 * path pays nothing. Worst measured transcript in this project is 70 MB and
 * costs 78 ms to read + 129 ms to scan; a typical one is 1–5 MB.
 *
 * BLIND FALLBACK + ITS CEILING (BV-004): when the transcript is unavailable or
 * carries no record of that agent at all, liveness falls back to the ledger
 * entry's own age, with `IN_FLIGHT_TTL_MS` = 30 min. Named ceiling: the largest
 * MEASURED same-batch dispatch spread is 95.7 s, so 30 min is ~19× headroom
 * against the false-ALLOW direction, while both measured sequential repair gaps
 * (36 min, 49 min) sit above it. Revisit trigger: a same-batch spread above
 * ~5 min in `.orchestrator/metrics/`, or a harness change that stops writing
 * `transcript_path` — either invalidates the headroom this number rests on.
 *
 * ## Error-class matrix — why this guard is deliberately NOT fail-closed
 *
 * A deny-capable hook on the DISPATCH path has an asymmetric blast radius: a
 * false positive blocks every agent of the session (the guard becomes a session
 * outage), while a false negative is a double-assignment that three later gates
 * still catch (`validate-wave-scope.mjs`, `enforce-scope.mjs` at write time, and
 * the W5 verification pass). Fail-closed is right for a WRITE guard; it is wrong
 * here. Each row below is a deliberate choice, not an oversight:
 *
 *   | # | Condition                              | Decision            | Why |
 *   |---|----------------------------------------|---------------------|-----|
 *   | 1 | disabled via profile/env               | exit 0, silent      | repo convention (`shouldRunHook`); not a decision at all |
 *   | 2 | repo module failed to load             | ALLOW + GUARD INACTIVE on stderr | #992/#993: a broken module must never brick the session — but never SILENTLY, or a crash is indistinguishable from `emitAllow` |
 *   | 3 | stdin empty / not JSON                 | ALLOW               | not a real hook call; denying here blocks every dispatch on a harness quirk |
 *   | 4 | `tool_name` is not the dispatch tool   | ALLOW               | not our tool |
 *   | 5 | prompt carries no scope marker         | ALLOW + COUNT       | 105 of 147 real prompts (71.4 %) have none. Non-extractable ≠ violation; denying these would deny 7 dispatches in 10. #1092: the allow now carries a counter-only record, so it is no longer byte-identical to "the guard never ran" |
 *   | 6 | scope block present but unparseable    | ALLOW + COUNT       | same reason as 5 — the parser is the fragile part, so its failures must resolve to the harmless side. Counted under a DISTINCT class from row 5 |
 *   | 7 | ledger unreadable / corrupt            | WARN + ALLOW + SELF-HEAL | loss of state is not evidence of a violation; loud so it gets noticed. The verdict now CARRIES a fresh ledger, so the corruption is repaired on the spot — without it the guard stayed OFF for the whole remaining wave, visible only in one `systemMessage` |
 *   | 8 | `git ls-files` failed                  | ALLOW (degraded)    | glob-vs-glob expansion degrades, concrete collisions are still found. A git outage is not a scope violation |
 *   | 9 | `findScopeCollisions` → not evaluable   | WARN + ALLOW        | the library says "not evaluable". Denying on a verdict with no witness is an assertion without evidence |
 *   |10 | same agent id re-dispatched, same scope| ALLOW (ledger replace) | a retry after a failed agent is legitimate; treating it as a duplicate would make the guard block every retry — a self-lock vector |
 *   |10a| collision, but EVERY colliding prior agent has FINISHED | ALLOW (+ prune) | the sequential repair pass. Its ledger records are pruned, so the state cannot re-block the next one either |
 *   |11 | collision with a prior agent still IN FLIGHT | **DENY**       | the one case this hook exists for |
 *   |12 | unexpected throw                       | ALLOW + stderr      | as row 2 |
 *   |13 | liveness probe throws / no evidence at all | treat as IN FLIGHT | keeps row 11 biting; the blind case is bounded by `IN_FLIGHT_TTL_MS`, never unbounded |
 *   |14 | ledger lock not acquirable in `LEDGER_LOCK_TIMEOUT_MS` | run UNLOCKED (degraded) | the lock removes the read-modify-write race (below); failing to take it must not deny, so the cycle degrades to the pre-lock behaviour |
 *
 * Rows 7 and 9 use `emitWarn`, which calls `process.exit(0)` and NEVER RETURNS.
 * That is why `decide()` below is a PURE function returning a verdict object and
 * this module emits exactly ONCE, at the end. Warning from inside the checking
 * flow would terminate the process before a later collision could be denied —
 * the recorded failure mode "an inline @returns-never warn helper at a rule-loop
 * warn site flips a later block to ALLOW". The same reason forbids emitting from
 * inside the ledger lock: `process.exit()` skips the release `finally`.
 *
 * ## Ledger concurrency
 *
 * `read → decide → write` is a read-modify-write cycle. `writeJsonAtomicSync`
 * makes the WRITE atomic, never the CYCLE: two dispatches starting together read
 * the same state and the first one's record is lost, so a third dispatch never
 * sees it — a MISSED collision. The cycle therefore runs inside
 * `withFileLock()` (`scripts/lib/file-lock.mjs`, the same primitive behind the
 * PSA-005 STATE.md lock), with a dead-PID stale override and a short timeout;
 * on timeout it degrades to the unlocked cycle (row 14) rather than denying.
 *
 * ## stdout discipline
 *
 * Under the exit-0 protocol (#906, ADR-0011) allow and deny share exit code 0 —
 * the decision lives only in the stdout JSON, so a truncated envelope reads as
 * no-decision and the dispatch PROCEEDS. The reason names agents, paths and
 * witnesses, so it can genuinely grow past the 65 536-byte kernel pipe buffer.
 * Both bounds apply, as required: this module clamps its own payload
 * (`MAX_REPORTED_COLLISIONS` / `MAX_EVIDENCE_PER_COLLISION` / `MAX_PATH_CHARS`),
 * and `emitDeny` writes through `writeStdoutLineSync` (`fs.writeSync(1, …)` with
 * an EAGAIN retry loop) and clamps again. This module never calls `console.log`
 * followed by `process.exit()`.
 *
 * ## Import safety
 *
 * Everything with an effect — the profile gate, `bootstrap()`, `main()` — runs
 * ONLY under {@link invokedAsScript}. Without that guard an `import` of this
 * module executed `main()`, blocked 5 s on stdin and terminated the IMPORTING
 * process with `exit 0`, which under ADR-0011 is itself an ALLOW; the exports
 * below were unimportable in practice. Same precedent as
 * `hooks/post-bash-write-verify.mjs` and `hooks/skill-invocation-telemetry.mjs`.
 *
 * ## Measured cost (2026-08-14, this repo, 1581 tracked files, back-to-back runs)
 *
 *   full hook path, per dispatch      69.0 ms   (20 runs / 1.380 s wall)
 *     ├─ bare node start               41.2 ms   (20 runs / 0.824 s — every hook pays this)
 *     └─ marginal cost added here      27.8 ms   (git rev-parse + ls-files + lock + ledger + compare)
 *
 *   same 20 runs with the lock and the rev-parse REMOVED: 1.375 s — so the
 *   repairs in this file cost +0.25 ms per dispatch, inside the run-to-run noise.
 *
 * The marginal cost is paid once per dispatch, i.e. ≤ 6× per wave. The transcript
 * scan is NOT in it — it runs only when a collision was already found.
 *
 * ## PSA
 *
 * `git ls-files` / `git rev-parse` only — read-only plumbing that takes no index
 * lock. No git-write command is ever issued (PSA-007).
 *
 * hooks.json registration is deliberately NOT part of this file's change set —
 * arming a PreToolUse hook on the dispatch path affects the very session that
 * builds it, so it is a separate, verified step (W5).
 */

import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';

import { shouldRunHook } from './_lib/profile-gate.mjs';

// ---------------------------------------------------------------------------
// #993 — late-bound repo dependencies
//
// Static imports fail at ESM LINK time: node exits 1 with 0 bytes on stdout,
// and under the exit-0 protocol that crash is indistinguishable from an
// explicit allow — the guard would fail open AND silently. Binding late turns
// the link-time crash into a catchable runtime error, which is what makes the
// GUARD INACTIVE banner reachable at all. `profile-gate.mjs` and `node:*`
// builtins stay static — they cannot be the broken repo module.
// ---------------------------------------------------------------------------
/** @type {typeof import('../scripts/lib/io.mjs').readStdin} */ let readStdin;
/** @type {typeof import('../scripts/lib/io.mjs').emitAllow} */ let emitAllow;
/** @type {typeof import('../scripts/lib/io.mjs').emitDeny} */ let emitDeny;
/** @type {typeof import('../scripts/lib/io.mjs').emitWarn} */ let emitWarn;
/** @type {typeof import('../scripts/lib/io.mjs').writeJsonAtomicSync} */ let writeJsonAtomicSync;
/** @type {typeof import('../scripts/lib/file-lock.mjs').withFileLock} */ let withFileLock;
let findScopeCollisions;

const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

/** This hook's name — threaded into the guard banner (#993: no hard-wired literal). */
const HOOK_NAME = 'pre-task-scope-disjoint';

/**
 * The dispatch tool's name. MEASURED, not assumed: 147/147 dispatch blocks in
 * the archived transcripts carry `"name":"Agent"`. `Task` is a different tool
 * family (TaskCreate/TaskUpdate/…) — see the header measurement #1.
 */
const DISPATCH_TOOL = 'Agent';

/** Ledger location, relative to the project dir. */
const LEDGER_REL = path.join('.orchestrator', 'wave-dispatch-scopes.json');

/** Mutex for the ledger's read-modify-write cycle — see § Ledger concurrency. */
const LEDGER_LOCK_REL = path.join('.orchestrator', 'wave-dispatch-scopes.lock');

/**
 * Ledger-lock budget. Short on purpose: the whole locked region is a read, a
 * pure comparison and one atomic write (~2 ms measured), so anything near this
 * bound is a dead holder, not contention. On expiry the cycle runs UNLOCKED
 * (matrix row 14) — the lock closes a race, it must never become a new outage.
 */
const LEDGER_LOCK_TIMEOUT_MS = 2000;
const LEDGER_LOCK_POLL_MS = 25;

/** Payload bounds — see § stdout discipline. */
const MAX_REPORTED_COLLISIONS = 5;
const MAX_EVIDENCE_PER_COLLISION = 4;
const MAX_PATH_CHARS = 120;

/** Ledger bound: a wave dispatching more than this is pathological; drop oldest. */
const MAX_LEDGER_AGENTS = 64;

/**
 * Scope-signal classes (#1092). Counter-only — see {@link bumpSignalCounter}.
 */
const SIGNAL_MARKER_ABSENT = 'marker-absent';
const SIGNAL_UNPARSEABLE = 'unparseable';
const SIGNAL_EXTRACTED = 'extracted';

/**
 * Blind-fallback liveness bound — see § Liveness for the measurement, the named
 * ceiling and the revisit trigger. Only reached when the transcript carries NO
 * evidence for that agent.
 */
const IN_FLIGHT_TTL_MS = 30 * 60 * 1000;

/**
 * Transcript-size ceiling for the liveness probe. The largest transcript
 * measured in this project is 70 MB (78 ms read); 256 MiB is ~3.6× that and
 * still far below V8's string limit. A larger file is treated as NO EVIDENCE
 * (→ TTL fallback), never as a completion.
 */
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;

/**
 * The launch acknowledgement an ASYNC dispatch returns within ~0.2 s. It is NOT
 * a completion — see § Liveness (b). Reading it as one would let every real
 * background-batch collision through, which is the one direction this repair
 * must not take.
 */
const ASYNC_LAUNCH_ACK = 'Async agent launched successfully';

/**
 * The consequence block spliced VERBATIM into the GUARD INACTIVE banner (#993),
 * naming the enforcement this hook's outage stops applying.
 */
const GUARD_CONSEQUENCE = {
  inactive: [
    '    Consequence: pre-dispatch scope-disjointness checking is OFF — two',
    '    agents in the same wave CAN now be handed the same file without the',
    '    dispatch being blocked. This is a BROKEN GUARD, not a policy decision —',
    '    do not route around it, repair it.',
  ],
};

/**
 * Project dir for banner keying, resolved WITHOUT `platform.mjs` — that module
 * is one of the ones that may have failed to load.
 *
 * @returns {string}
 */
function bannerProjectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * Bind every repo dependency late, making a load failure VISIBLE (GUARD INACTIVE
 * banner) instead of a silent exit-1 / 0-byte disarm. Throws on any load failure;
 * the entry-point catch banners. Banner-only: this hook consumes no
 * command-blocker symbol, so no module opts into the `git show HEAD:` fallback.
 *
 * @returns {Promise<void>}
 */
async function bootstrap() {
  const lib = (...seg) => pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', ...seg)).href;

  const { armGuard } = await import('./_lib/guard-source-loader.mjs');
  const { modules } = await armGuard(
    {
      io: { specifier: lib('io.mjs') },
      scopeGate: { specifier: lib('scope-gate.mjs') },
      fileLock: { specifier: lib('file-lock.mjs') },
    },
    {
      hookName: HOOK_NAME,
      repoRoot: PLUGIN_ROOT,
      projectDir: bannerProjectDir(),
      consequence: GUARD_CONSEQUENCE,
    }
  );

  ({ readStdin, emitAllow, emitDeny, emitWarn, writeJsonAtomicSync } = modules.io);
  ({ findScopeCollisions } = modules.scopeGate);
  ({ withFileLock } = modules.fileLock);
}

// ---------------------------------------------------------------------------
// Scope extraction — the fragile part, so every failure resolves to ALLOW
// ---------------------------------------------------------------------------

/** The marker vocabulary, shared by both declaration shapes below. */
const SCOPE_TERMS = 'DATEI[- ]SCOPE|FILE[- ]SCOPE|FILE SCOPE|DEIN SCOPE|SCOPE \\(|FILES? IN SCOPE';

/**
 * SHAPE 1 (highest precedence) — a marker near the START of a line, followed by
 * a fenced block. This is the form `skills/wave-executor/wave-loop.md` § Scope
 * Manifest specifies. Measured coverage: 42 of 147 archived prompts (28.6 %)
 * carry one of these; the other 71.4 % are matrix row 5 — allowed, not denied.
 *
 * ## The 80-char window is NOT widened, and that is a measurement (#1092)
 *
 * The obvious repair for "the marker sits at column 210…506 of its line" is to
 * widen the window. Measured 2026-08-26 over 4452 real first-record subagent
 * prompts under `~/.claude/projects/ * / * /subagents/agent-*.jsonl` (709 of them
 * this repo's own), comparing this regex against `^.{0,600}`:
 *
 *   window 80  → 701 marker hits, 267 prompts yield ≥1 extracted path
 *   window 600 → 810 marker hits, 267 prompts yield ≥1 extracted path
 *   of the 102 prompts the wider window newly matches, 12 have any fenced block
 *   after the marker at all, and 0 yield a single path. In THIS repo: +34 newly
 *   matched, 0 with a fence, 0 paths.
 *
 * So widening recovers NOTHING and costs something real: it reclassifies 102
 * prompts from "no marker" to "marker present but unparseable", which is
 * precisely the distinction the signal counter below exists to record. Worse,
 * most of what it newly matches is a CITATION, not a declaration — "quote the
 * exact command, the file scope, the result", "outside your file scope",
 * "File-Scope-Disjunktheit". A citation is not a declaration; reading the first
 * hit in a region as one is the recorded failure of `parseEpicRef` (#1112).
 *
 * The real miss class is a different SHAPE, handled by {@link INLINE_SCOPE_DECL}.
 */
const SCOPE_MARKER = new RegExp(`^.{0,80}(${SCOPE_TERMS})`, 'im');

/**
 * SHAPE 2 (lower precedence) — the measured miss class: a declaration written
 * INLINE, mid-sentence, with its paths comma-separated on the same line rather
 * than in a fenced block:
 *
 *   "…Max 25 turns. Edit ONLY your FILE-SCOPE: scripts/a.mjs, scripts/b.mjs"
 *
 * What separates this from a citation is not WHERE it sits but that it
 * INTRODUCES something — the marker is followed by an optional short qualifier
 * and/or parenthetical and then a declaration operator (`:` or an em/en dash).
 * A bare hyphen is deliberately NOT an operator: it would admit
 * "File-Scope-Planung". Anchored declaration shapes with precedence, rather than
 * a narrower search space, is the fix #1112's learning prescribes.
 *
 * The tail window before the operator is 2 characters, and that is measured
 * too: at 24 it admitted \`File-Scope-Disjunktheit: a.mjs, b.mjs\` — a compound
 * NOUN reading as a declaration. A dash-introduced qualifier
 * (\`FILE-SCOPE — exactly these:\`) is allowed explicitly instead of by window
 * width, so widening the window is never the way to admit one.
 *
 * Measured 2026-08-26 on this repo's 709 subagent prompts: 136 yield paths
 * today; this shape recovers 9 more, all of them genuine wave file scopes.
 * Host-wide the same operator test admits 41 additional marker hits and its
 * one false extraction (`[".filter"]`) is a prose fragment, which is why the
 * fenced shape keeps precedence and this one runs only when that found nothing.
 */
const INLINE_SCOPE_DECL = new RegExp(`(${SCOPE_TERMS})`, 'ig');
const INLINE_DECL_OPERATOR = /^[^\n(:—–]{0,2}(\([^)\n]{0,80}\))?\s*(?:[—–][^\n:]{0,30})?\s*(:|—|–)/;

/** Separators a coordinator uses between paths in an inline declaration. */
const INLINE_SCOPE_SEPARATOR = /[,;·]| und | and | sowie /;

/** Bound the inline scan; a prompt naming the vocabulary this often is prose. */
const MAX_INLINE_MARKER_SCANS = 8;

/**
 * A plausible repo-relative path. Deliberately strict — a false ACCEPT here
 * invents scope entries that could deny a legitimate dispatch, which is the one
 * direction this hook must not fail in. Rejects: absolute paths, `..` escapes,
 * embedded whitespace, bare prose words with no `/` and no extension.
 *
 * @param {string} s
 * @returns {boolean}
 */
function looksLikeRepoPath(s) {
  if (typeof s !== 'string') return false;
  if (s.length === 0 || s.length > 200) return false;
  if (/\s/.test(s)) return false;
  if (s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s)) return false;
  if (s.split('/').includes('..')) return false;
  if (!s.includes('/') && !/\.[A-Za-z0-9]{1,8}$/.test(s)) return false;
  return /^[A-Za-z0-9._*/-]+$/.test(s);
}

/**
 * Strip the decorations a coordinator writes around a scope entry — a trailing
 * `(neu)` / `(new)` annotation, list bullets, backticks, quotes, commas.
 *
 * @param {string} line
 * @returns {string}
 */
function cleanScopeLine(line) {
  return String(line)
    .replace(/\(.*?\)\s*$/, '')       // trailing annotation: "(neu)", "(new, W2)"
    .replace(/^[-*+\s]+/, '')          // list bullet
    .replace(/[`'"]/g, '')             // code/quote decoration
    .replace(/[,;]\s*$/, '')           // trailing separator
    .trim();
}

/**
 * Canonicalise a scope entry's SPELLING so two agents writing the same file two
 * ways are not read as disjoint (review LOW). Measured before this existed:
 * `['./scripts/lib/foo.mjs']` vs `['scripts/lib/foo.mjs']` compared `ok: true`
 * — the hook extracts from PROSE, and `looksLikeRepoPath` admits a `./` prefix,
 * so both spellings reach the comparison verbatim.
 *
 * Purely syntactic and meaning-preserving: `./` prefixes, `/./` segments and
 * duplicated slashes are removed. A TRAILING slash is deliberately kept — it is
 * the directory-prefix operator of `pathMatchesPattern`, so stripping it would
 * silently narrow a scope. The `dir` ↔ `dir/` case is handled by
 * {@link promoteDirEntries}, which decides it on evidence rather than guessing.
 *
 * `scope-gate.mjs` is a hook-safe pure library and out of this change's scope,
 * so the normalisation lives on THIS side of the call, applied to both sides of
 * every comparison.
 *
 * @param {string} entry
 * @returns {string}
 */
export function normalizeScopeEntry(entry) {
  if (typeof entry !== 'string') return '';
  let s = entry.trim();
  if (s === '') return '';
  s = s.replace(/\/{2,}/g, '/');       // `a//b` → `a/b`
  s = s.replace(/(?:^|\/)\.\//g, (m) => (m.startsWith('/') ? '/' : '')); // `./a`, `a/./b`
  while (s.startsWith('./')) s = s.slice(2);
  return s;
}

/**
 * Promote an entry that names a DIRECTORY to its `dir/` prefix form, on
 * evidence. `scripts/lib` and `scripts/lib/` are the same claim, but
 * `pathMatchesPattern` reads only the second as a prefix — measured `ok: true`
 * (disjoint) for that pair before this existed.
 *
 * The promotion is never a guess: an entry is rewritten only when it is NOT a
 * tracked file itself AND at least one tracked file lives beneath it. With no
 * `knownFiles` (git unavailable — matrix row 8) nothing is promoted, which is
 * exactly the pre-existing behaviour rather than a new failure mode.
 *
 * Comparison-only: the ledger stores the unpromoted form, because `knownFiles`
 * can differ between two dispatches and a stored promotion would outlive its
 * evidence.
 *
 * @param {string[]} files
 * @param {Set<string>} known — tracked files
 * @returns {string[]}
 */
export function promoteDirEntries(files, known) {
  if (!Array.isArray(files) || !(known instanceof Set) || known.size === 0) {
    return Array.isArray(files) ? files : [];
  }
  return files.map((f) => {
    if (typeof f !== 'string' || f === '') return f;
    if (f.includes('*') || f.endsWith('/')) return f;   // already a pattern/prefix
    if (known.has(f)) return f;                          // it IS a tracked file
    const prefix = `${f}/`;
    for (const k of known) if (k.startsWith(prefix)) return prefix;
    return f;
  });
}

/**
 * Accept the segments that survive `looksLikeRepoPath`, normalised and deduped
 * with order preserved. Shared by both declaration shapes.
 *
 * @param {string[]} segments
 * @returns {string[]}
 */
function collectScopePaths(segments) {
  const out = [];
  const seen = new Set();
  for (const raw of segments) {
    // A trailing sentence period is punctuation, never part of a path
    // (measured: "docs/events-schema.md." at the end of an inline declaration).
    const cleaned = normalizeScopeEntry(cleanScopeLine(raw).replace(/\.$/, ''));
    if (!looksLikeRepoPath(cleaned)) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

/**
 * SHAPE 2 extraction — see {@link INLINE_SCOPE_DECL}. Reports whether a
 * DECLARATION (not a citation) was seen at all, so the caller can tell matrix
 * row 5 from row 6 even when no path survives.
 *
 * @param {string} prompt
 * @returns {{seen: boolean, files: string[]}}
 */
function extractInlineScopeDeclaration(prompt) {
  INLINE_SCOPE_DECL.lastIndex = 0;
  let seen = false;
  let match;
  let scans = 0;
  while ((match = INLINE_SCOPE_DECL.exec(prompt)) !== null && scans < MAX_INLINE_MARKER_SCANS) {
    scans++;
    const after = prompt.slice(match.index + match[0].length);
    const operator = INLINE_DECL_OPERATOR.exec(after);
    if (operator === null) continue;   // a citation, not a declaration
    seen = true;
    const line = after.slice(operator[0].length).split('\n')[0];
    const files = collectScopePaths(line.split(INLINE_SCOPE_SEPARATOR));
    if (files.length > 0) return { seen: true, files };
  }
  return { seen, files: [] };
}

/**
 * Classify the scope signal a dispatch prompt carries, and extract it.
 *
 * Precedence, deliberately: SHAPE 1 (line-leading marker + fenced block, the
 * documented form) first; SHAPE 2 (inline comma-separated declaration) only
 * when SHAPE 1 produced nothing. The status is what makes a no-signal ALLOW
 * distinguishable after the fact:
 *
 *   `marker-absent`  — no declaration of any recognised shape (matrix row 5)
 *   `unparseable`    — a declaration is present but no path survived (row 6)
 *   `extracted`      — `files` is non-empty
 *
 * @param {string} prompt
 * @returns {{status: 'marker-absent'|'unparseable'|'extracted', files: string[]}}
 */
export function extractScopeSignal(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) return { status: SIGNAL_MARKER_ABSENT, files: [] };

  const markerMatch = SCOPE_MARKER.exec(prompt);
  if (markerMatch !== null) {
    const after = prompt.slice(markerMatch.index + markerMatch[0].length);
    // First fenced block after the marker. Non-greedy body; tolerates a language tag.
    const fence = /```[^\n]*\n([\s\S]*?)```/.exec(after);
    if (fence !== null) {
      const files = collectScopePaths(fence[1].split('\n'));
      if (files.length > 0) return { status: SIGNAL_EXTRACTED, files };
    }
  }

  const inline = extractInlineScopeDeclaration(prompt);
  if (inline.files.length > 0) return { status: SIGNAL_EXTRACTED, files: inline.files };
  return {
    status: markerMatch !== null || inline.seen ? SIGNAL_UNPARSEABLE : SIGNAL_MARKER_ABSENT,
    files: [],
  };
}

/**
 * Extract the declared file scope from a dispatch prompt. Returns `[]` when
 * nothing is confidently extractable — which the caller treats as ALLOW (matrix
 * rows 5 and 6), never as an empty scope that could collide.
 *
 * Thin wrapper over {@link extractScopeSignal}: callers that only need the paths
 * (and the tests that pin them) keep the original signature.
 *
 * @param {string} prompt
 * @returns {string[]} repo-relative paths/globs, normalised, deduped, order preserved
 */
export function extractScopeFromPrompt(prompt) {
  return extractScopeSignal(prompt).files;
}

/**
 * The dispatch's human description — the field the liveness probe matches
 * against the transcript's `tool_use` blocks (present in 147/147 measured
 * payloads).
 *
 * @param {{description?: unknown}} toolInput
 * @returns {string}
 */
export function agentDescOf(toolInput) {
  return typeof toolInput?.description === 'string' ? toolInput.description.trim() : '';
}

/**
 * Stable agent identity for the ledger. `description` is present in 147/147
 * measured payloads and is what a coordinator uses to name the agent; the
 * subagent_type disambiguates two same-named dispatches of different roles.
 *
 * @param {{description?: unknown, subagent_type?: unknown}} toolInput
 * @returns {string}
 */
export function agentIdOf(toolInput) {
  const desc = agentDescOf(toolInput);
  const type = typeof toolInput?.subagent_type === 'string' ? toolInput.subagent_type.trim() : '';
  if (desc !== '' && type !== '') return `${desc} (${type})`;
  if (desc !== '') return desc;
  if (type !== '') return type;
  return 'unnamed-agent';
}

// ---------------------------------------------------------------------------
// Liveness — has an already-recorded agent FINISHED? (§ Liveness)
// ---------------------------------------------------------------------------

/**
 * Index a session transcript by agent DESCRIPTION → completion state.
 *
 * Three record shapes are read, all measured in this repo's own transcripts:
 *   - `tool_use` `{name:'Agent', id, input.description}` — the dispatch.
 *   - `tool_result` `{tool_use_id, content}` — a completion for the SYNCHRONOUS
 *     shape, but only when its text is not the {@link ASYNC_LAUNCH_ACK}.
 *   - a `<task-notification>` record carrying `<tool-use-id>` and
 *     `<status>completed</status>` — the ASYNC shape's completion.
 *
 * A description dispatched N times counts as finished only when EVERY one of its
 * tool_use ids is finished. Conservative on purpose: one outstanding run of the
 * same agent keeps the deny alive.
 *
 * Pure and total — a malformed line is skipped, never thrown on.
 *
 * @param {string} raw — the transcript's JSONL text
 * @returns {Map<string, boolean>} description → finished?
 */
export function buildTranscriptIndex(raw) {
  const out = new Map();
  if (typeof raw !== 'string' || raw.length === 0) return out;

  const dispatched = new Map(); // description → tool_use ids
  const finishedIds = new Set();

  for (const line of raw.split('\n')) {
    if (line.length < 24) continue;

    // ASYNC completion — matched on the RAW line: the tags are plain text inside
    // a JSON string, so no parse is needed and the `queue-operation` carrier
    // record (which has no `message.content`) is covered too.
    if (line.includes('task-notification') && line.includes('<status>completed</status>')) {
      for (const m of line.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) finishedIds.add(m[1]);
    }

    if (!line.includes('"tool_use"') && !line.includes('tool_use_id')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type === 'tool_use' && block?.name === DISPATCH_TOOL && typeof block?.id === 'string') {
        const desc = typeof block?.input?.description === 'string' ? block.input.description.trim() : '';
        if (desc === '') continue;
        const ids = dispatched.get(desc) ?? [];
        ids.push(block.id);
        dispatched.set(desc, ids);
        continue;
      }
      if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string') {
        // The launch ACK is not a completion — see § Liveness (b).
        if (!resultTextOf(block).includes(ASYNC_LAUNCH_ACK)) finishedIds.add(block.tool_use_id);
      }
    }
  }

  for (const [desc, ids] of dispatched) out.set(desc, ids.every((id) => finishedIds.has(id)));
  return out;
}

/**
 * Flatten a `tool_result` block's content to text. The field is a string in some
 * records and an array of `{type:'text', text}` parts in others.
 *
 * @param {{content?: unknown}} block
 * @returns {string}
 */
function resultTextOf(block) {
  const c = block?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  let s = '';
  for (const part of c) if (typeof part?.text === 'string') s += part.text;
  return s;
}

/**
 * Build the liveness probe injected into {@link decide}.
 *
 * LAZY: the transcript is read on the FIRST call, i.e. only once a collision has
 * been found. The no-collision path — the overwhelming majority — never touches
 * the file (§ Liveness, cost containment).
 *
 * Resolution order per ledger entry:
 *   1. transcript evidence for its description → definitive;
 *   2. no evidence → the entry's own age against `IN_FLIGHT_TTL_MS`;
 *   3. no usable timestamp either → NOT finished (matrix row 13 — keeps the
 *      deny biting rather than inventing a completion).
 *
 * @param {object} params
 * @param {string|undefined} params.transcriptPath
 * @param {number} [params.now]
 * @param {number} [params.ttlMs]
 * @param {(p: string, enc: string) => string} [params.readFn]
 * @returns {(entry: {id: string, desc?: string, at?: string}) => boolean}
 */
export function makeFinishedProbe({ transcriptPath, now = Date.now(), ttlMs = IN_FLIGHT_TTL_MS, readFn = readFileSync } = {}) {
  let index; // undefined = not loaded yet, null = unavailable
  const load = () => {
    if (index !== undefined) return index;
    index = null;
    try {
      if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
        if (statSync(transcriptPath).size <= MAX_TRANSCRIPT_BYTES) {
          index = buildTranscriptIndex(readFn(transcriptPath, 'utf8'));
        }
      }
    } catch {
      index = null; // absent / unreadable / oversized → blind, never "finished"
    }
    return index;
  };

  return (entry) => {
    try {
      const idx = load();
      const desc = typeof entry?.desc === 'string' && entry.desc !== '' ? entry.desc : entry?.id;
      if (idx !== null && typeof desc === 'string') {
        const finished = idx.get(desc);
        if (finished !== undefined) return finished;
      }
      const at = Date.parse(entry?.at ?? '');
      if (Number.isFinite(at)) return now - at > ttlMs;
      return false;
    } catch {
      return false; // row 13
    }
  };
}

// ---------------------------------------------------------------------------
// Wave identity + ledger
// ---------------------------------------------------------------------------

/**
 * Identify the wave this dispatch belongs to. Derived from the coordinator's
 * own scope file so a wave transition resets the ledger without anyone having to
 * remember to clear it.
 *
 * FALLBACK, stated honestly (review MED): with no readable `wave-scope.json` the
 * key degrades to `<session>|w?|?`, so the ledger spans the whole SESSION and a
 * wave-3 dispatch is compared against wave-1 records. Before the liveness probe
 * existed that was a genuine over-report — a wave-1 agent that had long finished
 * blocked a wave-3 agent, and the doc comment claiming it "over-reports nothing"
 * was wrong. It is now bounded rather than papered over: a prior record only
 * binds while its agent is still IN FLIGHT (§ Liveness), and an agent still
 * running across a wave boundary is a real race, not an artefact of the key.
 * What remains is the blind case (no transcript), bounded by `IN_FLIGHT_TTL_MS`.
 *
 * @param {string} projectDir
 * @param {string} sessionId
 * @param {(p: string, enc: string) => string} readFn — injected `readFileSync`
 *   (the module is late-bound, so it cannot be imported at the top level here)
 * @returns {string}
 */
export function waveKeyOf(projectDir, sessionId, readFn) {
  for (const dir of ['.pi', '.cursor', '.codex', '.claude']) {
    try {
      const raw = readFn(path.join(projectDir, dir, 'wave-scope.json'), 'utf8');
      const data = JSON.parse(raw);
      const wave = data?.wave ?? '?';
      const role = data?.role ?? '?';
      return `${sessionId}|w${wave}|${role}`;
    } catch { /* try next location */ }
  }
  return `${sessionId}|w?|?`;
}

/**
 * Tracked files, for glob expansion inside `findScopeCollisions`. The library is
 * pure and must not spawn — supplying this is precisely the hook's job.
 * Returns `[]` on any git failure (matrix row 8: degrade, never deny).
 *
 * ALIGNED WITH THE CLI (review MED): `scripts/validate-wave-scope.mjs`
 * `knownRepoFiles()` resolves `git rev-parse --show-toplevel` FIRST and lists
 * from there. Without that step a session whose cwd is a SUBDIRECTORY got
 * subdir-relative paths here while the CLI got repo-relative ones — stage 3a
 * then found no witness and the hook ALLOWED what the CLI called a collision.
 * That is the dangerous direction, because the hook is the last gate before the
 * write.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function listTrackedFiles(cwd) {
  const opts = {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  };
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], opts).trim();
    if (!root) return [];
    const stdout = execFileSync('git', ['ls-files', '-z'], { ...opts, cwd: root });
    return stdout.split('\0').filter((f) => f.length > 0);
  } catch {
    return [];
  }
}

/**
 * Clip a path for the deny reason without losing the discriminating tail.
 *
 * @param {string} p
 * @returns {string}
 */
function clipPath(p) {
  const s = String(p);
  if (s.length <= MAX_PATH_CHARS) return s;
  return `…${s.slice(-(MAX_PATH_CHARS - 1))}`;
}

// ---------------------------------------------------------------------------
// Decision — PURE. Returns a verdict; emits nothing, exits nothing.
//
// This purity is load-bearing, not stylistic: `emitWarn` and `emitDeny` both
// call `process.exit()` and never return, so any emit reached from inside the
// checking flow would terminate before a later collision could be denied — and,
// since #1020's lock landed, would also skip the lock's release `finally`.
// ---------------------------------------------------------------------------

/**
 * Record that ONE dispatch carried a given scope-signal class (#1092).
 *
 * ## Why this exists
 *
 * The no-signal path returned `{action: 'allow'}` with no `ledger` field, and
 * the caller only writes `if (verdict.ledger)` — so nothing was written
 * anywhere. Correct operation ("this agent legitimately has no scope") and total
 * absence ("the coordinator injected nothing, or the marker never matched")
 * produced BYTE-IDENTICAL evidence. Measured 2026-08-26 over 709 of this repo's
 * subagent prompts: 136 yield paths, 47 carry a line-leading marker with no
 * fenced block, 59 carry marker + fence but no surviving path. Without a counter
 * none of those three classes is distinguishable from "the guard never ran".
 *
 * ## What it is NOT
 *
 * This is a SEND-SIDE counter. It observes what the COORDINATOR PUT IN THE
 * PROMPT at dispatch time — never what the agent received, parsed, or obeyed. A
 * non-zero `extracted` proves a scope was written into the prompt; it proves
 * nothing about delivery or about the agent honouring it. Whether the injected
 * block actually reached the agent's context is a RECEIVE-side question that
 * only the subagent transcript can answer, and no number here may be read as
 * that proof.
 *
 * Counter ONLY: no prompt text, no paths, no agent ids. The ledger is a shared
 * working-copy artefact, and a scope-signal tally must not become a second,
 * unreviewed copy of prompt content.
 *
 * Scoped to the wave, like `agents`: a new `waveKey` starts a fresh tally
 * rather than accumulating across waves.
 *
 * @param {object|null} ledger    previously recorded wave state
 * @param {string} waveKey
 * @param {'marker-absent'|'unparseable'|'extracted'} status
 * @returns {{'marker-absent': number, unparseable: number, extracted: number}}
 */
export function bumpSignalCounter(ledger, waveKey, status) {
  const carried = (ledger !== null && ledger?.waveKey === waveKey && ledger.scopeSignals !== null
    && typeof ledger.scopeSignals === 'object' && !Array.isArray(ledger.scopeSignals))
    ? ledger.scopeSignals
    : {};
  const next = {};
  for (const key of [SIGNAL_MARKER_ABSENT, SIGNAL_UNPARSEABLE, SIGNAL_EXTRACTED]) {
    const prior = carried[key];
    next[key] = Number.isSafeInteger(prior) && prior >= 0 ? prior : 0;
  }
  next[status] += 1;
  return next;
}

/**
 * @typedef {{action: 'allow'|'deny'|'warn', reason?: string, suggestion?: string,
 *            ledger?: object|null, note?: string}} Verdict
 */

/**
 * Decide whether this dispatch may proceed.
 *
 * @param {object} params
 * @param {object} params.input               parsed PreToolUse payload
 * @param {object|null} params.ledger         previously recorded wave state (null = unreadable)
 * @param {boolean} params.ledgerCorrupt      true when the ledger existed but could not be parsed
 * @param {string} params.waveKey             current wave identity
 * @param {string[]} params.knownFiles        tracked files for glob expansion
 * @param {Function} params.collide           `findScopeCollisions` (injected for testability)
 * @param {(entry: object) => boolean} [params.isFinished] liveness probe (§ Liveness)
 * @param {string} [params.nowIso]            dispatch timestamp recorded on the entry
 * @returns {Verdict}
 */
export function decide({ input, ledger, ledgerCorrupt, waveKey, knownFiles, collide, isFinished, nowIso }) {
  const toolName = input?.tool_name;
  // Row 4: not our tool.
  if (toolName !== DISPATCH_TOOL) return { action: 'allow' };

  const toolInput = input?.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return { action: 'allow' };

  const at = typeof nowIso === 'string' ? nowIso : new Date().toISOString();

  const signal = extractScopeSignal(toolInput.prompt);
  const files = signal.files;
  const priorAgents = (ledger !== null && ledger?.waveKey === waveKey && Array.isArray(ledger.agents))
    ? ledger.agents
    : [];

  // Rows 5 + 6: nothing confidently extractable → allow. Non-extractable is not
  // a violation, and denying here would deny ~7 dispatches in 10.
  //
  // #1092: the ALLOW now CARRIES a counter so it leaves a trace. Before this,
  // "no scope in the prompt" and "the guard never ran" were indistinguishable
  // after the fact. `agents` is carried through UNCHANGED — this dispatch
  // declared no scope, so it adds no scope claim to the wave.
  if (files.length === 0) {
    return {
      action: 'allow',
      ledger: {
        waveKey,
        updated: at,
        agents: priorAgents,
        scopeSignals: bumpSignalCounter(ledger, waveKey, signal.status),
      },
    };
  }

  const id = agentIdOf(toolInput);
  const desc = agentDescOf(toolInput);
  const self = { id, desc, files, at };

  // Row 7: ledger existed but was unparseable. Terminal warn — decided here and
  // returned, never emitted mid-flow. SELF-HEALING since the review: the verdict
  // carries a FRESH ledger, so the corruption is repaired by this dispatch
  // instead of disabling the guard for the rest of the wave.
  if (ledgerCorrupt) {
    return {
      action: 'warn',
      ledger: { waveKey, updated: at, agents: [self], scopeSignals: bumpSignalCounter(null, waveKey, signal.status) },
      note:
        `${HOOK_NAME}: wave dispatch ledger was unreadable — scope-disjointness NOT checked for ` +
        `"${id}"; the ledger has been reset, so the next dispatch is checked again.`,
    };
  }

  const prior = (ledger !== null && ledger?.waveKey === waveKey && Array.isArray(ledger.agents))
    ? ledger.agents.filter((a) => a !== null && typeof a === 'object' && typeof a.id === 'string')
    : [];

  // Row 10: same agent re-dispatched (a retry after a failed agent is legitimate).
  // Replace its record instead of letting it collide with its own earlier self.
  const others = prior.filter((a) => a.id !== id);

  const known = new Set(Array.isArray(knownFiles) ? knownFiles : []);
  const agentScopes = [
    ...others.map((a) => ({ id: a.id, files: promoteDirEntries(a.files, known) })),
    { id, files: promoteDirEntries(files, known) },
  ];

  let verdictLib;
  try {
    verdictLib = collide(agentScopes, { knownFiles });
  } catch {
    verdictLib = { ok: false, collisions: [], duplicateIds: [] };
  }

  const nextLedger = {
    waveKey,
    updated: at,
    agents: [...others, self].slice(-MAX_LEDGER_AGENTS),
    scopeSignals: bumpSignalCounter(ledger, waveKey, signal.status),
  };

  const collisions = Array.isArray(verdictLib?.collisions) ? verdictLib.collisions : [];
  const duplicateIds = Array.isArray(verdictLib?.duplicateIds) ? verdictLib.duplicateIds : [];

  // Row 9: "not evaluable" — the library's fail-closed shape. The discriminator
  // is NOT `ok !== true`: `ok` means DISJOINT (`collisions.length === 0 &&
  // duplicateIds.length === 0`), so `ok === false` is the NORMAL result of a
  // real collision. Reading `ok` as evaluability turns every genuine collision
  // into a warn — i.e. an ALLOW — which is the exact fail-open this hook exists
  // to prevent. Not-evaluable is `ok === false` with BOTH arrays empty.
  if (verdictLib?.ok !== true && collisions.length === 0 && duplicateIds.length === 0) {
    return {
      action: 'warn',
      ledger: nextLedger,
      note:
        `${HOOK_NAME}: scope collision check not evaluable for "${id}" — dispatch allowed, ` +
        'disjointness UNVERIFIED.',
    };
  }

  // Only collisions involving THIS dispatch are actionable here: a pair among
  // already-dispatched agents was either denied at its own dispatch or predates
  // this guard, and re-denying it would block an innocent third agent.
  const mine = collisions.filter((c) => c?.a === id || c?.b === id);

  if (mine.length === 0) return { action: 'allow', ledger: nextLedger };

  // § Liveness — the review's HIGH finding. A collision with an agent that has
  // ALREADY FINISHED is a sequential repair pass, not a race. The probe is called
  // ONLY here, so the transcript is read only on the path that would deny.
  const byId = new Map(others.map((a) => [a.id, a]));
  const probe = typeof isFinished === 'function' ? isFinished : () => false;
  const finishedIds = new Set();
  const live = [];
  for (const c of mine) {
    const otherId = c.a === id ? c.b : c.a;
    const entry = byId.get(otherId);
    if (entry !== undefined && probe(entry)) {
      finishedIds.add(otherId);
      continue;
    }
    live.push(c);
  }

  // Row 10a: every colliding prior agent has finished. Allow AND prune their
  // records — leaving them would make the NEXT repair pass pay the transcript
  // scan again for a question already answered.
  if (live.length === 0) {
    const kept = others.filter((a) => !finishedIds.has(a.id));
    return {
      action: 'allow',
      ledger: {
        waveKey,
        updated: at,
        agents: [...kept, self].slice(-MAX_LEDGER_AGENTS),
        scopeSignals: nextLedger.scopeSignals,
      },
    };
  }

  // Row 11: the one case this hook exists for.
  const shown = live.slice(0, MAX_REPORTED_COLLISIONS);
  const lines = shown.map((c) => {
    const other = c.a === id ? c.b : c.a;
    const ev = Array.isArray(c.evidence) ? c.evidence : [];
    const evShown = ev.slice(0, MAX_EVIDENCE_PER_COLLISION).map(clipPath).join(', ');
    const more = ev.length > MAX_EVIDENCE_PER_COLLISION
      ? ` (+${ev.length - MAX_EVIDENCE_PER_COLLISION} more)`
      : '';
    return `  • "${id}" ↔ "${other}" [${c.kind}]: ${evShown}${more}`;
  });
  const omitted = live.length > shown.length ? `\n  (+${live.length - shown.length} further collisions)` : '';

  const reason =
    `File-scope collision: this dispatch overlaps ${live.length} STILL-RUNNING ` +
    `agent(s) of the same wave.\n${lines.join('\n')}${omitted}`;
  // The old suggestion said "dispatch them in different waves", which is wrong
  // advice for the case that actually fires: a still-running sibling. A finished
  // agent no longer blocks anything (§ Liveness), so the remedy is ownership or
  // sequencing — never a wave split.
  const suggestion =
    'Two agents editing one file at the same time race each other (PSA-002). ' +
    'Give the file exactly ONE owner in the wave plan, or wait for the named ' +
    `agent(s) to finish and re-dispatch — a finished agent no longer blocks. ` +
    `If the ledger is stale, delete ${LEDGER_REL}.`;

  // Deliberately NOT persisting the ledger on deny: the dispatch did not happen,
  // so recording it would make the retry-after-fix look like a duplicate.
  return { action: 'deny', reason, suggestion };
}

// ---------------------------------------------------------------------------
// Entry point — exactly ONE terminal emit
// ---------------------------------------------------------------------------

async function main() {
  // Row 3: no input is not a real hook call.
  const input = await readStdin();
  if (!input) return emitAllow();

  const projectDir = typeof input.cwd === 'string' && input.cwd !== ''
    ? input.cwd
    : bannerProjectDir();
  const sessionId = typeof input.session_id === 'string' ? input.session_id : 'no-session';

  // Cheap pre-check: skip all I/O for the overwhelmingly common non-dispatch call.
  if (input.tool_name !== DISPATCH_TOOL) return emitAllow();

  const waveKey = waveKeyOf(projectDir, sessionId, readFileSync);
  const knownFiles = listTrackedFiles(projectDir);
  const isFinished = makeFinishedProbe({ transcriptPath: input.transcript_path });
  const ledgerPath = path.join(projectDir, LEDGER_REL);

  // The read-modify-write CYCLE, run under the ledger lock below. Everything
  // inside is synchronous and emits NOTHING — an emit here would `process.exit()`
  // past the lock's release `finally` and leave a lock file behind.
  const cycle = () => {
    let ledger = null;
    let ledgerCorrupt = false;
    try {
      ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      if (ledger === null || typeof ledger !== 'object') { ledger = null; ledgerCorrupt = true; }
    } catch (err) {
      // Absent ledger is the normal first-dispatch case, NOT corruption (row 7
      // must not fire on every wave's first agent).
      if (err?.code !== 'ENOENT') ledgerCorrupt = true;
    }

    const verdict = decide({
      input,
      ledger,
      ledgerCorrupt,
      waveKey,
      knownFiles,
      collide: findScopeCollisions,
      isFinished,
    });

    if (verdict.ledger) {
      try {
        writeJsonAtomicSync(ledgerPath, verdict.ledger);
      } catch {
        // Ledger persistence is best-effort. Failing to record must not turn an
        // allow into a deny — the next dispatch simply sees less history.
      }
    }
    return verdict;
  };

  let verdict;
  const lockPath = path.join(projectDir, LEDGER_LOCK_REL);
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch { /* the unlocked fallback below still works */ }
  let locked;
  try {
    locked = await withFileLock(lockPath, cycle, {
      timeoutMs: LEDGER_LOCK_TIMEOUT_MS,
      pollMs: LEDGER_LOCK_POLL_MS,
      staleCheck: 'pid',
      holder: HOOK_NAME,
      tmpPrefix: '.wave-dispatch-scopes.lock',
      warn: () => { /* a stale-lock override is bookkeeping, not an operator decision */ },
    });
  } catch {
    locked = { ok: false, reason: 'fs-error' };
  }
  if (locked?.ok === true) {
    verdict = locked.value;
  } else {
    // Row 14: lock unavailable → run the cycle UNLOCKED rather than deny. The
    // race window returns, which is exactly the pre-lock behaviour — strictly
    // better than blocking the dispatch on a lock-file problem.
    verdict = cycle();
  }

  if (verdict.action === 'deny') return emitDeny(verdict.reason, verdict.suggestion);
  if (verdict.action === 'warn') return emitWarn(verdict.note);
  return emitAllow();
}

// ---------------------------------------------------------------------------
// Self-execution guard (§ Import safety).
//
// `process.argv[1]` carries the path as passed (symlink-bearing under a
// symlinked plugin install) while `import.meta.url` is realpath-resolved by
// node's default loader, so BOTH sides are realpath'd — the same comparison
// `hooks/post-bash-write-verify.mjs` documents (#938 MED-2).
// ---------------------------------------------------------------------------
function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    // argv[1] unresolvable (deleted/renamed mid-run) — best-effort raw compare.
    return entry === self;
  }
}

if (invokedAsScript()) {
  // Row 1 of the matrix: exit 0 immediately (silent no-op) when disabled (#211).
  if (!shouldRunHook(HOOK_NAME)) process.exit(0);

  // -------------------------------------------------------------------------
  // TWO distinct failure classes, two distinct handlers — do NOT merge them:
  //
  //   1. LOAD failure (`bootstrap()` throws — matrix row 2): the guard never
  //      armed. Under the exit-0 protocol a bare exit-1 crash with 0 bytes of
  //      stdout is, on the only decision-bearing channel, indistinguishable from
  //      an allow. Exit 0 (still fail-OPEN — a broken module must not brick the
  //      session, and `emitAllow` itself may be the symbol that failed to load)
  //      but SAY SO: GUARD INACTIVE. Banner-only — no headFallback module here.
  //   2. RUNTIME failure inside `main()` (matrix row 12): the guard armed and then
  //      tripped. This hook fails OPEN here, which is the deliberate INVERSION of
  //      `enforce-scope`'s fail-closed handler — and the reason is the asymmetry
  //      named in the matrix header: enforce-scope guards a WRITE (denying one
  //      write is cheap), this guards the DISPATCH path (denying every dispatch
  //      is a session outage). The bug this could hide is caught downstream by
  //      `validate-wave-scope.mjs` and by `enforce-scope` at write time; a
  //      wrongly-denied dispatch is caught by nothing.
  // -------------------------------------------------------------------------
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
        `🚨 ${HOOK_NAME}: GUARD INACTIVE — module load failed ` +
          `(${String(loadError?.message || loadError).split('\n')[0]}). ` +
          'Pre-dispatch scope-disjointness checking is OFF. See issue #993.\n'
      );
    }
    process.exit(0); // fail-open, but no longer fail-silent
  }

  main().catch((e) => {
    try {
      process.stderr.write(
        `⚠ ${HOOK_NAME}: internal hook error — dispatch ALLOWED unchecked ` +
          `(${String(e?.message ?? e).split('\n')[0]})\n`
      );
    } catch { /* stderr may be closed; the allow below is the decision */ }
    emitAllow();
  });
}
