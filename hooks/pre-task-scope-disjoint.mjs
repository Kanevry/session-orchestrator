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
 *      notification 14:24:39.360, ten minutes later). Any TERMINAL status
 *      finishes the id, not only `completed` — see {@link TERMINAL_STATUS_RE}.
 *      #1455: a 429'd agent notified `failed`, was resumed via SendMessage
 *      (new tool-use-id), and its original id never finished → permanent deny.
 *      Only a HARNESS-WRITTEN carrier record counts (#1459 Pkt 2 Rest,
 *      {@link notificationCarrierText}): a complete block inside a `tool_result`
 *      (a `Read` of a fixture), assistant text or a typed prompt is a forgery
 *      that would false-ALLOW an overlap with a still-running agent.
 *   c) EXACT ID, POSITIVE PROOF, RESUME (#1480, #1459 P1). A ledger entry keeps
 *      its dispatch's PreToolUse `tool_use_id` as `useId`, and liveness is
 *      looked up by THAT id; the description is only the fallback for entries
 *      without one, the ledger `id` never (B3). A dispatch finishes only on
 *      positive evidence — a terminal carrier, `is_error`, or a result in
 *      {@link RESULT_COMPLETION_FORMS}; any other result form is "unknown",
 *      i.e. no evidence (B2, row 13). A `SendMessage` to the dispatch's task id
 *      re-opens it until a terminal carrier for the dispatch, that SendMessage or
 *      the task id follows — a resumed agent is running, not done (#1459 P1;
 *      {@link buildLivenessIndex}).
 *
 * COST CONTAINMENT: the transcript is read ONLY when a collision has already
 * been found — i.e. on the path that is about to deny. The 99 % no-collision
 * path pays nothing. Worst measured transcript in this project is 70 MB and
 * costs 78 ms to read + 129 ms to scan; a typical one is 1–5 MB.
 *
 * BLIND FALLBACK + ITS CEILING (BV-004): when the transcript is unavailable or
 * carries no positive evidence for that agent (no record, or only an unknown
 * result form), liveness falls back to the ledger entry's own age, with
 * `IN_FLIGHT_TTL_MS` = 30 min. Named ceiling: the largest
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
 * outage), while a false negative of the COLLISION check is a double-assignment
 * that three later gates still catch (`validate-wave-scope.mjs`,
 * `enforce-scope.mjs` at write time, and the W5 verification pass). The #1485
 * stale-base check (row 15) has no such later gate — a missed stale base is an
 * agent editing old code — so it is kept fail-open by a different rule: it
 * denies only on a MEASUREMENT, and every unknown is ALLOW plus a record.
 * Fail-closed is right for a WRITE guard; it is wrong here. Each row below is a
 * deliberate choice, not an oversight:
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
 *   | 8 | `git ls-files` failed, or the shared git budget (`GIT_BUDGET_MS`) ran out | ALLOW (degraded) + `known_files_skipped` in the record | glob-vs-glob expansion degrades, concrete collisions are still found. A git outage is not a scope violation. #1489 Pkt 7: a HANGING git used to outlive the 5 s harness timeout, which killed the hook — the verdict lost with no record |
 *   | 9 | `findScopeCollisions` → not evaluable   | WARN + ALLOW        | the library says "not evaluable". Denying on a verdict with no witness is an assertion without evidence |
 *   |10 | same agent id re-dispatched         | ALLOW; predecessor pruned only when FINISHED | a retry after a failed agent is legitimate (a failed agent is finished), so the guard must not self-lock. #1480 B4: an unfinished predecessor is KEPT as a claim — a third agent hitting only its scope still collides. With distinct `tool_use_id`s on both it is an ordinary partner (row 11); without them it never collides with its own retry. Replaced WITHOUT a probe only where no claim is lost: the same `tool_use_id` (the same dispatch evaluated again), or — neither carrying an id — a predecessor wholly covered by the retry's scope |
 *   |10a| collision, but EVERY colliding prior agent has FINISHED (positive evidence) | ALLOW (+ prune) | the sequential repair pass. Its ledger records are pruned, so the state cannot re-block the next one either |
 *   |11 | collision with a prior agent still IN FLIGHT | **DENY**       | the case this hook was built for (#1020) |
 *   |12 | unexpected throw                       | ALLOW + stderr      | as row 2 |
 *   |13 | liveness probe throws / no positive evidence (no record, unknown result form) | treat as IN FLIGHT | keeps row 11 biting; the blind case is bounded by `IN_FLIGHT_TTL_MS`, never unbounded. A dispatch re-opened by a SendMessage with no completion after it is in flight outright, without TTL |
 *   |14 | ledger lock not acquirable in `LEDGER_LOCK_TIMEOUT_MS` | run UNLOCKED (degraded) | the lock removes the read-modify-write race (below); failing to take it must not deny, so the cycle degrades to the pre-lock behaviour |
 *   |15 | `isolation: "worktree"`, `worktree.baseRef` not `"head"`, `merge-base --is-ancestor HEAD origin/HEAD` exits 1 in a full-history repo whose FETCH_HEAD is < 24 h old | **DENY**, no ledger write | #1485: the agent would branch from a base missing commits of HEAD and edit OLD code. Every non-measurement — no origin/HEAD, shallow, `stale-remote-ref`, git error, git budget spent (`git-budget`) — is ALLOW + a `skipped` record. No ledger write, so the in-place re-dispatch the deny advises meets no phantom claim. A collision DENY (row 11) wins the terminal emit; this one then goes to stderr. Otherwise the `scope_checked` record carries `ledger_result: 'deny-stale-base'`, never the collision verdict's allow (#1489 Pkt 8) |
 *
 * Every row that reaches a verdict from `decide()` — 5–11 and 13–14 — also
 * leaves an event record (§ Observability), so "which row fired" is answerable
 * after the fact and not only in the moment. Row 15 is decided outside
 * `decide()` and leaves its own `worktree_base_checked` record for EVERY
 * worktree dispatch, allow and skip included. Rows 1–4 emit nothing (no decision
 * was made), and neither do the two crash rows 2 and 12: a hook that fell over
 * cannot describe itself, which is precisely why the GUARD INACTIVE banner on
 * stderr is the signal there.
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
 * ## Observability — the ledger half of #1092
 *
 * Every dispatch DECISION also appends one `orchestrator.wave_dispatch.scope_checked`
 * record to `<session root>/.orchestrator/metrics/events.jsonl` — the root
 * `resolveSessionRoot()` resolves (`scripts/lib/platform.mjs`: the git toplevel
 * of the payload `cwd` — its nearest `.git` ancestor when git cannot answer — so
 * neither the subdirectory a `cd` moved to, #1489 Pkt 6, nor the launch dir a
 * worktree session left), which is
 * also where the ledger and its lock live. The reason it
 * exists is matrix rows 5/6: the no-signal ALLOW used to be byte-identical to
 * "the guard never ran", and the in-ledger counter added first is a WAVE tally —
 * it cannot say WHICH dispatch carried a scope. Payload: `wave` (omitted, never
 * `0`, when unknown), `agent_id`, `declared_path_count`, `injected`, `shape`,
 * `signal`, `ledger_result`, `collision_count`, `hook`, `known_files_skipped`
 * (only when the tracked-file listing degraded, matrix row 8), `collision_result`
 * (only beside `ledger_result: 'deny-stale-base'` — the collision verdict it
 * replaced), plus `session_id` / `semantic_session_id` when a session lock is
 * readable.
 *
 * WHAT IT PROVES: this hook SAW (or did not see) a `FILE-SCOPE` declaration in
 * the prompt the coordinator handed to the dispatch tool, and what the guard
 * then decided. WHAT IT DOES NOT PROVE: that the block reached the agent's
 * context, or that the agent read it. That is a RECEIVE-side question and the
 * platform exposes no prompt-assembly boundary to answer it — the open half of
 * #1092, with its revisit trigger in `docs/scope-collision-guard.md` § 4.2.
 * NOTHING derived from the prompt BODY is in the payload: counts and enums
 * only, no paths (#1092 acceptance criterion 3).
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
import { homedir } from 'node:os';

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
/** @type {typeof import('../scripts/lib/scope-echo.mjs').scopeDigest} */ let scopeDigest;
/** @type {typeof import('../scripts/lib/platform.mjs').resolveSessionRoot} */ let resolveSessionRoot;
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

/**
 * ONE deadline for ALL git work of one hook fire (#1489 Pkt 7). Every spawn
 * gets at most what is LEFT of it, so the git work as a whole — never a single
 * call — is what is bounded.
 *
 * The number is arithmetic, not taste: `hooks/hooks.json` gives this hook
 * `"timeout": 5` (seconds) for the WHOLE process. The git work runs first; after
 * it the ledger lock may wait up to `LEDGER_LOCK_TIMEOUT_MS` (2000). 5000 − 2000
 * − 1500 leaves 1500 ms for node start, the late-bound imports, the transcript
 * scan (≤ ~210 ms at the largest measured 70 MB) and the two awaited event
 * appends — ~20× the 69 ms full path measured idle (§ Measured cost). The git
 * work itself measured 27.8 ms together with lock, ledger and compare, so 1500
 * binds only a git that hangs (a stuck lock file, a network-backed `HEAD`, a
 * frozen filesystem). Before, each worktree call had its own 5 s and
 * `listTrackedFiles` none: one hanging git outlived the harness, which killed
 * the hook — a silent fail-open with no record of the lost verdict.
 *
 * Revisit-Trigger: a change of this hook's `timeout` in `hooks/hooks.json` or of
 * `LEDGER_LOCK_TIMEOUT_MS` — the three numbers must keep summing below 5000.
 */
const GIT_BUDGET_MS = 1500;

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
 * Which declaration SHAPE produced the extracted paths (#1092). `none` means no
 * shape yielded a path — the `marker-absent` AND the `unparseable` case alike,
 * which is why the event carries `signal` beside `shape`: `shape` says which
 * parser won, `signal` says whether a declaration was there at all.
 */
const SHAPE_FENCED = 'fenced';
const SHAPE_INLINE = 'inline';
const SHAPE_NONE = 'none';

/** The per-dispatch observability record (#1092) — see § Observability. */
const SCOPE_EVENT = 'orchestrator.wave_dispatch.scope_checked';

/**
 * The worktree-base observability record (#1413; carries the #1485 `decision`).
 *
 * Same `wave_dispatch` domain and same `_checked` verb as `SCOPE_EVENT`, and
 * written for EVERY `isolation: "worktree"` dispatch rather than only the
 * alarming one. That is HR-105 applied at the source: a numerator-only stream
 * cannot tell "genuinely rare" from "silently broken", and the firing rate of
 * the #1485 deny is then unfalsifiable. With every outcome in one stream the
 * rate is `decision:"deny" / all records of this name`.
 *
 * #1424 widened "every outcome" from two to three: the `stale: true|false`
 * split was already covered, but each NON-measurement (peer STATE.md, no
 * STATE.md, no `session-start-ref`, a git failure) returned early and emitted
 * nothing — so the gate in front of the split reproduced exactly the
 * zero-records ambiguity the split had removed. Those now carry
 * `stale: null` plus a `skipped` reason, and only `isolation !== "worktree"`
 * stays silent (HR-101: it is ~90% of all dispatches).
 */
const WORKTREE_BASE_EVENT = 'orchestrator.wave_dispatch.worktree_base_checked';

/**
 * The receive-side instruction line `renderScopeEchoInstruction()` renders and
 * the coordinator appends immediately after the fenced block
 * (`wave-loop-dispatch.md` § Pre-Dispatch: File-Scope Injection).
 *
 * Matching it HERE, in the same prompt, is what makes the agent-A-block-with-
 * agent-B-line mix-up catchable without a single filesystem read: the block and
 * the line must come from the same `$AGENT_FILESCOPE_JSON`, so their digests
 * must agree (`digest_consistent`). The marker half stays case-sensitive for the
 * same reason `scope-echo.mjs` keeps it so — a lowercase lookalike is not the
 * line; the HEX half is read case-insensitively and normalised to lowercase.
 * Non-global on purpose: a `g` regex carries `lastIndex` between calls.
 */
const ECHO_INSTRUCTION_RE =
  /End your final report with the line:[ \t]*`{0,3}SCOPE-DIGEST:[ \t]*`{0,3}([0-9a-fA-F]{8})(?![0-9a-fA-F])/;

/** Shape of a well-formed digest, used to reject anything a broken digest fn returns. */
const DIGEST_RE = /^[0-9a-f]{8}$/;

/**
 * Clamp for the one free-form string the event carries (`agent_id`, built from
 * the coordinator's own `description`). A dispatch description is a label, but
 * nothing enforces that, so the ledger line is bounded like every other payload
 * in this file (§ stdout discipline).
 */
const MAX_AGENT_ID_CHARS = 120;

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
 *
 * Recognised only as the PREFIX of the result text (after trimStart): a finished
 * sync report that merely QUOTES this sentence is not a launch receipt, and read
 * as one it stayed "running" without TTL (R1 LOW). Census 2026-09-30, 5,881
 * local transcripts: 4,684 of 4,684 ACK results begin with it, also in their
 * first content part.
 */
const ASYNC_LAUNCH_ACK = 'Async agent launched successfully';

/**
 * The `tool_result` forms that PROVE a dispatch finished (#1480 B2), one line
 * per form. A result matching none of them is NOT a completion but "no
 * evidence" — the entry falls back to the TTL rule (matrix row 13). `is_error`
 * is handled beside this list (the dispatch never ran), and the ACK is tested
 * FIRST, so a launch receipt can never read as a completion.
 *
 * Census 2026-09-30 (local transcripts, 14 days, counts only), Agent
 * tool_results: ACK 4,730; sync completion carrying the `<usage>`/`total_tokens`
 * trailer and `agentId:` 690 (690/690); `is_error` 37; neither 38. Of those 38,
 * "This agent's report was delivered…" is a completion (35/35 without a
 * terminal carrier before or after, 2026-09-30), "Fork started — processing in
 * b…" is not (a start receipt without the ACK wording — before this list it was
 * read as a completion: the B2 fail-open).
 *
 * Named ceiling (BV-004): any other wording reads as "unknown", so a fresh entry
 * binds for up to IN_FLIGHT_TTL_MS although its agent may be done — a bounded
 * false-DENY, never a false-ALLOW. Revisit-Trigger: a census re-run finds an
 * Agent tool_result wording in neither this list nor ASYNC_LAUNCH_ACK — classify
 * it, then add ONE line here.
 */
const RESULT_COMPLETION_FORMS = Object.freeze([
  Object.freeze({ at: 'anywhere', text: '<usage>' }),                        // sync trailer, 690/690
  Object.freeze({ at: 'anywhere', text: 'total_tokens' }),                   // sync trailer, 690/690
  Object.freeze({ at: 'start', text: "This agent's report was delivered" }), // 35/35 without carrier
]);

/** The tool that addresses — and can RESUME — an already-dispatched agent (#1459 P1). */
const SEND_MESSAGE_TOOL = 'SendMessage';

/**
 * A `SendMessage` result that reached nobody (`{"success":false,…"No agent
 * named…"}`, census 2026-09-30): such a send activates nothing.
 */
const SEND_NO_EFFECT = '"success":false';

/**
 * The harness's `agentId:` line in an Agent tool_result (ACK or sync trailer) —
 * the task id a `SendMessage` addresses. Only a line that BEGINS with it, id on
 * the same line, read as the LAST match over the content parts joined with
 * `\n`: a sync result embeds the agent's own report ahead of the harness
 * trailer, and a report ending in `agentId:` must not swallow the trailer's
 * line (R1 MEDIUM — a wrong task id let a resumed agent read as finished).
 * Census 2026-09-30, 5,881 local transcripts: in 5,375 of 5,375 Agent results
 * carrying `agentId:`, the last one starts a line and sits in the last part.
 */
const AGENT_ID_LINE_RE = /^agentId:[ \t]*([A-Za-z0-9_-]+)/gm;

/** Per-dispatch liveness states — see {@link buildLivenessIndex}. */
const LIVE_FINISHED = 'finished';
const LIVE_RUNNING = 'running';
const LIVE_UNKNOWN = 'unknown';

/**
 * `<task-notification>` statuses that mean the task is NO LONGER RUNNING (#1455).
 * Enumerated from evidence, not guessed — census 2026-09-25 over the operator's
 * local Claude Code transcripts (`rg "<tool-use-id>…<status>X</status>"` on
 * `*.jsonl`): completed, failed 1430 lines, killed 609, stopped 28.
 * `running` is deliberately absent — it is the one non-terminal spelling.
 */
const TERMINAL_STATUS_RE = /<status>(?:completed|failed|killed|stopped)<\/status>/;

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
      // ONE normalization for the digest, shared with the receive side (#1092):
      // `scope-echo.mjs` is pure (stdlib + `crypto-digest-utils.mjs`) and its
      // `scopeDigest` is what `--verify` joins the two halves on. A second
      // implementation here would let the halves disagree while both looked
      // right — the class `guard-design.md` § "zero-import predicate module"
      // names. Late-bound like every other repo module so a load failure
      // banners instead of disarming the guard silently (#993).
      scopeEcho: { specifier: lib('scope-echo.mjs') },
      // #1492: ONE session-root resolver for every hook that reads the
      // session's control files — this ledger, and `wave-scope.json` in
      // enforce-scope / enforce-commands / post-bash-write-verify.
      platform: { specifier: lib('platform.mjs') },
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
  ({ scopeDigest } = modules.scopeEcho);
  ({ resolveSessionRoot } = modules.platform);
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
 *
 * ## The marker vocabulary is CASE-SENSITIVE, and that is a measurement (#1092)
 *
 * Until 2026-09-16 both shapes carried the `i` flag, so the term `FILE SCOPE`
 * also matched ordinary lowercase prose. The Learnings-Index header this repo
 * injects into every agent prompt —
 * `## Learnings Index (selected for your file scope) — …` — therefore matched
 * the marker at column ~38 of a line-leading window, and the FIRST fenced block
 * anywhere after it (a verification command, a report template) decided the
 * class: no path survived, so the dispatch was recorded `unparseable`, i.e.
 * matrix row 6 — "a declaration is present but the parser gave up".
 *
 * MEASURED in this session's own wave 1 (`.orchestrator/wave-dispatch-scopes.json`,
 * waveKey `5de6560c-…|w1|Discovery`): `unparseable: 5, extracted: 0` for FIVE
 * Discovery dispatches that carried no `FILE-SCOPE` block at all. Host-wide the
 * same confusion accounts for the 52 historical `unparseable` records.
 *
 * Every DOCUMENTED marker is upper-case (`wave-loop-dispatch.md` § Pre-Dispatch:
 * File-Scope Injection writes `FILE-SCOPE — exactly these:`), while every
 * measured false positive is prose in sentence case — so dropping `i` separates
 * them without narrowing the search window, which the § above showed recovers
 * nothing.
 *
 * ## What dropping `i` costs, stated honestly (corrected 2026-09-16)
 *
 * The first cut of this note claimed the change "moves a CLASSIFICATION and
 * never a decision", on the grounds that `marker-absent` and `unparseable` both
 * resolve to ALLOW. That is only true for a declaration the parser would have
 * given up on anyway. A MIXED-CASE declaration that WOULD have yielded paths
 * (`File-Scope:` followed by a fenced path list) now matches nothing, so
 * `extractScopeFromPrompt` returns `[]`, `findScopeCollisions` never runs, and
 * the dispatch is ALLOWED unconditionally — a lost DENY capability for that
 * spelling, i.e. a decision change, not a reclassification.
 *
 * It is safe today because every LIVE injector writes the upper-case canonical
 * marker: `skills/wave-executor/references/wave-loop-dispatch.md`
 * § Pre-Dispatch: File-Scope Injection documents `FILE-SCOPE — exactly these:`,
 * and the repo-wide census (2026-09-16) finds the mixed-case spellings only in
 * prose, never in an injected block. That is a property of the injectors, not of
 * this regex, so it is PINNED rather than assumed:
 * `tests/skills/wave-loop-scope-marker.test.mjs` asserts the documented marker
 * line is upper-case and matches {@link SCOPE_MARKER}, so a future template edit
 * to `File-Scope:` goes red instead of silently disarming the guard.
 */
export const SCOPE_MARKER = new RegExp(`^.{0,80}(${SCOPE_TERMS})`, 'm');

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
const INLINE_SCOPE_DECL = new RegExp(`(${SCOPE_TERMS})`, 'g');
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
 * `shape` names the parser that WON — `fenced` (SHAPE 1), `inline` (SHAPE 2), or
 * `none` when neither produced a path. It is deliberately NOT a second spelling
 * of `status`: a prompt carrying a fenced block whose lines are prose is
 * `{status: 'unparseable', shape: 'none'}`, and collapsing the two would lose
 * exactly the row-5/row-6 distinction the counter exists for.
 *
 * @param {string} prompt
 * @returns {{status: 'marker-absent'|'unparseable'|'extracted',
 *            shape: 'fenced'|'inline'|'none', files: string[]}}
 */
export function extractScopeSignal(prompt) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { status: SIGNAL_MARKER_ABSENT, shape: SHAPE_NONE, files: [] };
  }

  const markerMatch = SCOPE_MARKER.exec(prompt);
  if (markerMatch !== null) {
    const after = prompt.slice(markerMatch.index + markerMatch[0].length);
    // First fenced block after the marker. Non-greedy body; tolerates a language tag.
    const fence = /```[^\n]*\n([\s\S]*?)```/.exec(after);
    if (fence !== null) {
      const files = collectScopePaths(fence[1].split('\n'));
      if (files.length > 0) return { status: SIGNAL_EXTRACTED, shape: SHAPE_FENCED, files };
    }
  }

  const inline = extractInlineScopeDeclaration(prompt);
  if (inline.files.length > 0) return { status: SIGNAL_EXTRACTED, shape: SHAPE_INLINE, files: inline.files };
  return {
    status: markerMatch !== null || inline.seen ? SIGNAL_UNPARSEABLE : SIGNAL_MARKER_ABSENT,
    shape: SHAPE_NONE,
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
 * against the transcript's `tool_use` blocks when an entry carries no exact
 * `useId` (present in 147/147 measured payloads).
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

/**
 * A dispatch's EXACT identity (#1480 A): the PreToolUse payload's `tool_use_id`,
 * or a ledger entry's stored `useId`. On Claude Code it equals the transcript's
 * `tool_use` id, so liveness becomes a lookup instead of a description match;
 * other harnesses may omit it, and `''` then means "no exact id". Taken
 * verbatim, never re-spelled — and dropped rather than clipped past
 * MAX_AGENT_ID_CHARS: a clipped id could never match, two clipped ids could
 * match wrongly.
 *
 * @param {unknown} value
 * @returns {string}
 */
function exactUseId(value) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_AGENT_ID_CHARS ? value : '';
}

// ---------------------------------------------------------------------------
// Liveness — has an already-recorded agent FINISHED? (§ Liveness)
// ---------------------------------------------------------------------------

const NOTIFICATION_OPEN = '<task-notification>';
const NOTIFICATION_CLOSE = '</task-notification>';

/**
 * A notification head in the harness's own tag order: `<task-id>`,
 * `<tool-use-id>`, optional `<output-file>`, `<status>` — anchored at the opener.
 * Group 1 is the task id (the resume key, #1459 P1), group 2 the tool-use id,
 * group 3 the whole `<status>` element.
 */
const NOTIFICATION_HEAD_RE = /^<task-notification>\s*<task-id>([^<]*)<\/task-id>\s*<tool-use-id>([^<]+)<\/tool-use-id>\s*(?:<output-file>[^<]*<\/output-file>\s*)?(<status>[^<]*<\/status>)/;

/** `origin.kind` / `commandMode` value the harness stamps on a notification carrier. */
const CARRIER_KIND = 'task-notification';

/** `queue-operation` operations measured to carry a notification (dequeue carries no content). */
const CARRIER_QUEUE_OPS = new Set(['enqueue', 'remove']);

/** First line of the harness preamble some `user` carriers put before the block. */
const SYSTEM_NOTIFICATION_MARK = '[SYSTEM NOTIFICATION - NOT USER INPUT]\n';

/**
 * The notification text of a HARNESS-WRITTEN carrier record, or `null` for any
 * other record (#1459 Pkt 2 Rest). Census 2026-09-28 over the operator's local
 * transcripts (11,005 files, 2026-08-06 → 2026-09-28): every terminal id the
 * pre-fix raw-line match accepted from a real carrier came from exactly one of
 * three record forms, each of which carries ids the other two do not:
 *   - `user` with STRING `message.content` and `origin.kind: 'task-notification'`
 *     (a typed prompt carries `origin.kind: 'human'`). The text begins with the
 *     opener, or with the harness preamble ({@link SYSTEM_NOTIFICATION_MARK},
 *     tag-free, ending in a blank line) directly followed by the opener;
 *   - `queue-operation` with `operation` `enqueue`/`remove` and string `content`;
 *   - `attachment` of type `queued_command` with `commandMode: 'task-notification'`.
 * Everything else — `tool_result` content, assistant text, tool inputs, typed
 * prompts — is a quote or a forgery and yields `null`, i.e. no finished id.
 *
 * The guard on the `user` form is `origin.kind`, which only the harness sets; the
 * preamble rule merely strips a tag-free prefix and is no control on its own.
 *
 * Named residual (BV-004): a `queue-operation` record has no field that tells a
 * harness notification from an operator prompt typed while the agent was busy,
 * so an OPERATOR could forge through that one channel. An agent cannot through
 * the one producer censused: text a subagent or peer delivers via `SendMessage`
 * arrives wrapped by the harness, so it never begins with the opener. Measured
 * 2026-09-28 in a second run (count only, 11,008 transcript files, three more
 * than the census above): 7,131 records carry such a message, 1,801 of them as
 * `queue-operation`, 2,486 as `queued_command` with `commandMode: 'prompt'`;
 * 0 of the 7,131 begin with `<task-notification>`. Other queue producers
 * (scheduled wake-ups, a `/loop` body) were not censused. Revisit if the harness
 * adds a discriminator here (like `commandMode` on the attachment) or stops
 * wrapping.
 *
 * @param {any} rec — one parsed transcript record
 * @returns {string|null}
 */
function notificationCarrierText(rec) {
  if (rec?.type === 'user' && rec?.origin?.kind === CARRIER_KIND && typeof rec?.message?.content === 'string') {
    const text = rec.message.content;
    if (!text.startsWith(SYSTEM_NOTIFICATION_MARK)) return text;
    const open = text.indexOf('<');
    return open !== -1 && text.startsWith(`\n\n${NOTIFICATION_OPEN}`, open - 2) ? text.slice(open) : null;
  }
  if (rec?.type === 'queue-operation' && CARRIER_QUEUE_OPS.has(rec?.operation) && typeof rec?.content === 'string') {
    return rec.content;
  }
  const att = rec?.type === 'attachment' ? rec?.attachment : undefined;
  if (att?.type === 'queued_command' && att?.commandMode === CARRIER_KIND && typeof att?.prompt === 'string') {
    return att.prompt;
  }
  return null;
}

/**
 * The HEAD of a carrier text's FIRST `<task-notification>` block (#1459 Pkt 2) —
 * its task id, its tool-use id and whether its status is TERMINAL; at most one
 * head per carrier. Only a terminal head finishes an id; a non-terminal one only
 * contributes the task id (#1459 P1), which can open a dispatch, never close it.
 * (Named `finishedNotificationIds` until #1480; the ceiling below is unchanged.)
 *
 * The text must BEGIN with the opener (a block further in is a quote) and its
 * head must follow the harness tag order ({@link NOTIFICATION_HEAD_RE}).
 * `<summary>` and `<result>` carry free text that can QUOTE another
 * notification's `<tool-use-id>` and `<status>`, or even forge a whole block
 * (R2 F1: a summary that closes itself and opens a complete fake block defeated
 * the earlier cut-then-split approach). So nothing past the block's HEAD is read:
 * the head runs from the opener to the earliest `<summary>`, `<result>` or
 * `</task-notification>`. Fail-closed — the deny stays — when the text is not a
 * carrier's, does not begin with the opener, has no closing tag (truncated
 * block), or its head is out of order or carries no terminal status.
 *
 * Named ceiling (BV-004, #1467): a batch of several DIFFERENT notifications in
 * one carrier reports only the first as finished (the rest stay running, the
 * safe direction but a false-DENY source). Census 2026-09-30 over the operator's
 * local transcripts of all repos (11,684 files, 2026-08-06 → 2026-09-30, at
 * f58480e5): 23 preamble-form `user` carriers hold 2+ distinct terminal ids; 108
 * non-first ids are finished by no other carrier, and 0 of them is an `Agent`
 * dispatch id (105 Bash, 3 Monitor) — the only ids this index resolves, so no
 * Agent liveness is lost today. The 2026-09-28 figures (31 / 155) were not
 * reproduced. No split is built: it would gain nothing, and its safety is
 * unproven. `origin` has no per-block discriminator, so a split is safe only if
 * the harness escapes `<` in `<summary>`/`<result>` — unescaped, a block forged
 * there is byte-identical to a genuine `\n\n`-joined batch. The census suggests
 * escaping (12,039 of 25,031 results carry `&lt;`, 3 a raw `<` + letter) but
 * does not establish it for every harness version. Revisit-Trigger: a re-run
 * census finds a non-first terminal id that is an `Agent` dispatch id finished
 * by no other carrier or `tool_result`; a split then needs escaping proven first.
 *
 * @param {string|null} text — a carrier's text from {@link notificationCarrierText}
 * @returns {{taskId: string, toolUseId: string, terminal: boolean}|null}
 */
function notificationHead(text) {
  if (typeof text !== 'string' || !text.startsWith(NOTIFICATION_OPEN)) return null;
  const close = text.indexOf(NOTIFICATION_CLOSE);
  if (close === -1) return null;
  let headEnd = close;
  for (const tag of ['<summary>', '<result>']) {
    const at = text.indexOf(tag);
    if (at !== -1 && at < headEnd) headEnd = at;
  }
  const head = text.slice(0, headEnd).match(NOTIFICATION_HEAD_RE);
  if (head === null) return null;
  return { taskId: head[1].trim(), toolUseId: head[2], terminal: TERMINAL_STATUS_RE.test(head[3]) };
}

/**
 * Classify an Agent dispatch's OWN `tool_result` (#1480 B2): `done` only on
 * positive evidence (`is_error`, or one of {@link RESULT_COMPLETION_FORMS}),
 * `ack` for the launch acknowledgement (a text PREFIX, see
 * {@link ASYNC_LAUNCH_ACK}), `unknown` for everything else. The ACK is tested
 * before the forms, so no ACK wording can ever read as a completion.
 *
 * @param {{is_error?: unknown}} block
 * @param {string} text — {@link resultTextOf}(block)
 * @returns {'done'|'ack'|'unknown'}
 */
function dispatchResultForm(block, text) {
  if (block?.is_error === true) return 'done';
  const lead = text.trimStart();
  if (lead.startsWith(ASYNC_LAUNCH_ACK)) return 'ack';
  for (const form of RESULT_COMPLETION_FORMS) {
    if (form.at === 'start' ? lead.startsWith(form.text) : text.includes(form.text)) return 'done';
  }
  return 'unknown';
}

/**
 * The LAST line-leading `agentId:` a harness-written dispatch result names, or
 * `''` — see {@link AGENT_ID_LINE_RE}. Parts are joined with `\n` HERE (unlike
 * {@link resultTextOf}), so a part boundary is a line boundary and report text
 * cannot run into the trailer's line.
 *
 * @param {{content?: unknown}} block
 * @returns {string}
 */
function lastAgentIdIn(block) {
  const c = block?.content;
  const text = typeof c === 'string'
    ? c
    : Array.isArray(c) ? c.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n') : '';
  let last = '';
  for (const m of text.matchAll(AGENT_ID_LINE_RE)) last = m[1];
  return last;
}

/**
 * Append `value` to the array stored under `key`.
 *
 * @template T
 * @param {Map<string, T[]>} map
 * @param {string} key
 * @param {T} value
 */
function pushTo(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * Index a session transcript by DISPATCH tool-use id → liveness state, plus
 * description → dispatch ids for ledger entries that carry no exact id.
 *
 * Record shapes read, all measured (census 2026-09-30 for the SendMessage half):
 *   - `tool_use` `{name:'Agent', id, input.description}` — the dispatch U.
 *   - `tool_use` `{name:'SendMessage', id, input.to}` — addresses a dispatch by
 *     its task id T(U) (= agentId); 1,055 via a notification task id, 33 via the
 *     ACK's agentId, 0 via the description.
 *   - `tool_result` for U — classified by {@link dispatchResultForm}; for a
 *     SendMessage only whether it reached nobody ({@link SEND_NO_EFFECT} or
 *     `is_error`).
 *   - a `<task-notification>` CARRIER record — only a harness-written carrier
 *     ({@link notificationCarrierText}), only its first block's head
 *     ({@link notificationHead}); a terminal `<status>` finishes (#1455: `failed`
 *     too).
 *
 * T(U) is the last line-leading `agentId:` ({@link lastAgentIdIn}) of U's own
 * ACK or positive result, else the task
 * id of the first carrier head carrying U's tool-use id.
 *
 * RESUME (#1459 P1). U is ACTIVATED by its dispatch and by every SendMessage
 * with `to === T(U)` whose result is not a no-effect (a send without a result
 * yet counts — the safe direction). U is FINISHED when a completion lies AFTER
 * its last activation, by transcript line position: a terminal carrier with
 * tool-use id U, with the id of an activating SendMessage, or with task id T(U);
 * when the dispatch itself is the last activation, also U's own positive
 * result. Measured 2026-09-30: a resumed agent completes under the
 * SendMessage's id and the same task id, never again under U (455 cases); a
 * message queued to a running agent completes under U with the same task id
 * (566). Activations only OPEN; closing still needs a carrier or U's own
 * harness-written result.
 *
 * States: `finished`; `running` — no result, an ACK, or a SendMessage as last
 * activation with no completion after it (no TTL); `unknown` — only a result
 * form without positive evidence, which the probe treats as no evidence (TTL).
 * A repeated `tool_use` record (same Agent or SendMessage id) is the SAME event,
 * not a new activation: its position is the FIRST occurrence, so a copy after
 * the completion cannot re-open a finished agent (R1 D4, a false-DENY). A
 * repeated carrier still closes. Hardening without a measured case: census
 * 2026-09-30 (5,881 local transcripts) found 0 repeated Agent and 0 repeated
 * SendMessage `tool_use` records.
 *
 * Named ceiling (BV-004): `to` is matched against T(U) only — a SendMessage that
 * addresses the agent by name or description re-opens nothing (0 of ~6,200
 * measured 2026-09-30). Revisit-Trigger: a census re-run finds a SendMessage to
 * a dispatch whose `to` is not its task id.
 *
 * Pure and total — a malformed line is skipped, never thrown on.
 *
 * @param {string} raw — the transcript's JSONL text
 * @returns {{states: Map<string, 'finished'|'running'|'unknown'>,
 *            idsByDesc: Map<string, string[]>}}
 */
function buildLivenessIndex(raw) {
  const states = new Map();
  const idsByDesc = new Map();
  if (typeof raw !== 'string' || raw.length === 0) return { states, idsByDesc };

  const dispatchPos = new Map();     // U → FIRST line position of its tool_use
  const results = new Map();         // U → [{pos, form, agentId}]
  const sendsByTo = new Map();       // SendMessage `to` → [{id, pos}]
  const sendIds = new Set();
  const sendNoEffect = new Set();    // SendMessage ids whose result reached nobody
  const headsByUse = new Map();      // carrier tool-use id → [{pos, taskId, terminal}]
  const terminalByTask = new Map();  // carrier task id → [pos] of terminal heads

  const lines = raw.split('\n');
  for (let pos = 0; pos < lines.length; pos++) {
    const line = lines[pos];
    if (line.length < 24) continue;
    // Substring prefilter only — the verdict needs the PARSED record: a raw-line
    // match let a forged block in any record finish an id (#1459 Pkt 2 Rest).
    const hasNotification = line.includes('task-notification');
    const hasToolRow = line.includes('"tool_use"') || line.includes('tool_use_id');
    if (!hasNotification && !hasToolRow) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }

    // Completion (and the task id) — only from a harness-written carrier record.
    if (hasNotification) {
      const head = notificationHead(notificationCarrierText(rec));
      if (head !== null) {
        pushTo(headsByUse, head.toolUseId, { pos, taskId: head.taskId, terminal: head.terminal });
        if (head.terminal && head.taskId !== '') pushTo(terminalByTask, head.taskId, pos);
      }
    }

    if (!hasToolRow) continue;
    const content = rec?.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block?.id === 'string') {
        if (block.name === DISPATCH_TOOL) {
          if (!results.has(block.id)) {   // first occurrence only — see D4 above
            results.set(block.id, []);
            dispatchPos.set(block.id, pos);
            const desc = typeof block?.input?.description === 'string' ? block.input.description.trim() : '';
            if (desc !== '') pushTo(idsByDesc, desc, block.id);
          }
        } else if (block.name === SEND_MESSAGE_TOOL && typeof block?.input?.to === 'string' && block.input.to !== ''
          && !sendIds.has(block.id)) {
          sendIds.add(block.id);
          pushTo(sendsByTo, block.input.to, { id: block.id, pos });
        }
        continue;
      }
      if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string') {
        const own = results.get(block.tool_use_id);
        if (own !== undefined) {
          const text = resultTextOf(block);
          const form = dispatchResultForm(block, text);
          // An error text is not a harness trailer — learn T(U) from ACK/completion only.
          const agentId = form === 'ack' || (form === 'done' && block.is_error !== true) ? lastAgentIdIn(block) : '';
          own.push({ pos, form, agentId });
        } else if (sendIds.has(block.tool_use_id)
          && (block.is_error === true || resultTextOf(block).includes(SEND_NO_EFFECT))) {
          sendNoEffect.add(block.tool_use_id);
        }
      }
    }
  }

  for (const [useId, pos] of dispatchPos) {
    const own = results.get(useId) ?? [];
    const taskId = own.find((r) => r.agentId !== '')?.agentId
      ?? (headsByUse.get(useId) ?? []).find((h) => h.taskId !== '')?.taskId
      ?? '';

    let lastPos = pos;
    let lastIsSend = false;
    const closers = [useId];
    if (taskId !== '') {
      for (const send of sendsByTo.get(taskId) ?? []) {
        if (sendNoEffect.has(send.id)) continue;
        closers.push(send.id);
        if (send.pos > lastPos) { lastPos = send.pos; lastIsSend = true; }
      }
    }

    const closedAfter = closers.some((id) => (headsByUse.get(id) ?? []).some((h) => h.terminal && h.pos > lastPos))
      || (taskId !== '' && (terminalByTask.get(taskId) ?? []).some((p) => p > lastPos))
      || (!lastIsSend && own.some((r) => r.form === 'done' && r.pos > lastPos));

    let state;
    if (closedAfter) state = LIVE_FINISHED;
    else if (lastIsSend || own.length === 0 || own.some((r) => r.form === 'ack')) state = LIVE_RUNNING;
    else state = LIVE_UNKNOWN;
    states.set(useId, state);
  }
  return { states, idsByDesc };
}

/**
 * Description-level verdict for a ledger entry WITHOUT an exact id: `false` if
 * any of the description's dispatches is running, `true` only if every one is
 * finished, `undefined` (no evidence → TTL) otherwise. `excludeUseId` drops the
 * CURRENT dispatch, whose `tool_use` may already sit in the transcript at
 * PreToolUse time and would make a finished same-named predecessor look alive.
 *
 * @param {{states: Map<string, string>, idsByDesc: Map<string, string[]>}} index
 * @param {string} desc
 * @param {string} excludeUseId
 * @returns {boolean|undefined}
 */
function descFinished(index, desc, excludeUseId) {
  let seen = false;
  let unknown = false;
  for (const useId of index.idsByDesc.get(desc) ?? []) {
    if (useId === excludeUseId) continue;
    seen = true;
    const state = index.states.get(useId);
    if (state === LIVE_RUNNING) return false;
    if (state !== LIVE_FINISHED) unknown = true;
  }
  return seen && !unknown ? true : undefined;
}

/**
 * Index a session transcript by agent DESCRIPTION → completion state — the
 * description view of {@link buildLivenessIndex}.
 *
 * A description dispatched N times counts as finished only when EVERY one of its
 * tool_use ids is finished, and as running as soon as one is. Conservative on
 * purpose: one outstanding run of the same agent keeps the deny alive. A
 * description with no running run but an `unknown` one is absent (no evidence).
 *
 * @param {string} raw — the transcript's JSONL text
 * @returns {Map<string, boolean>} description → finished? (absent = no evidence)
 */
export function buildTranscriptIndex(raw) {
  const index = buildLivenessIndex(raw);
  const out = new Map();
  for (const desc of index.idsByDesc.keys()) {
    const finished = descFinished(index, desc, '');
    if (finished !== undefined) out.set(desc, finished);
  }
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
 * Resolution order per ledger entry (#1480 A):
 *   1. an entry WITH `useId` → that exact dispatch's state: finished / running
 *      are definitive, `unknown` or no record is no evidence;
 *   2. an entry WITHOUT `useId` (legacy, or a harness sending no `tool_use_id`)
 *      → its non-empty description via {@link descFinished}, the current
 *      dispatch (`selfUseId`) excluded. Never the ledger `id` — a
 *      `desc (type)` string or a bare subagent type, which matched unrelated
 *      dispatches (B3);
 *   3. no evidence → the entry's own age against `IN_FLIGHT_TTL_MS`;
 *   4. no usable timestamp either → NOT finished (matrix row 13 — keeps the
 *      deny biting rather than inventing a completion).
 *
 * @param {object} params
 * @param {string|undefined} params.transcriptPath
 * @param {number} [params.now]
 * @param {number} [params.ttlMs]
 * @param {(p: string, enc: string) => string} [params.readFn]
 * @param {string} [params.selfUseId] the CURRENT dispatch's `tool_use_id`
 * @returns {(entry: {id: string, desc?: string, at?: string, useId?: string}) => boolean}
 */
export function makeFinishedProbe({
  transcriptPath, now = Date.now(), ttlMs = IN_FLIGHT_TTL_MS, readFn = readFileSync, selfUseId,
} = {}) {
  const excludeUseId = exactUseId(selfUseId);
  let index; // undefined = not loaded yet, null = unavailable
  const load = () => {
    if (index !== undefined) return index;
    index = null;
    try {
      if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
        if (statSync(transcriptPath).size <= MAX_TRANSCRIPT_BYTES) {
          index = buildLivenessIndex(readFn(transcriptPath, 'utf8'));
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
      if (idx !== null) {
        const useId = exactUseId(entry?.useId);
        if (useId !== '') {
          const state = idx.states.get(useId);
          if (state === LIVE_FINISHED) return true;
          if (state === LIVE_RUNNING) return false;
        } else {
          const desc = typeof entry?.desc === 'string' ? entry.desc.trim() : '';
          const finished = desc === '' ? undefined : descFinished(idx, desc, excludeUseId);
          if (finished !== undefined) return finished;
        }
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
 * The wave NUMBER out of a `waveKeyOf()` key, for the telemetry record (#1092).
 *
 * Returns `null` — never `0` — when the key carries the `w?` fallback or a
 * non-positive value, so the caller can OMIT the field. `.claude/rules/host-
 * resources.md` § HR-105 in one line: an invented `wave: 0` would read as a real
 * wave in every later query, exactly like the `wave_number` contract the
 * quality-gate event already follows (`docs/events-schema.md`).
 *
 * @param {string} waveKey
 * @returns {number|null}
 */
function waveNumberOf(waveKey) {
  if (typeof waveKey !== 'string') return null;
  const seg = waveKey.split('|')[1];
  if (typeof seg !== 'string' || !seg.startsWith('w')) return null;
  const n = Number(seg.slice(1));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Thrown instead of spawning once the shared git deadline has passed. */
class GitBudgetExhausted extends Error {
  /** @param {string} subcommand */
  constructor(subcommand) {
    super(`git ${subcommand}: shared git budget (${GIT_BUDGET_MS} ms) exhausted`);
    this.name = 'GitBudgetExhausted';
  }
}

/**
 * A git runner bound to ONE deadline shared by every call of this hook fire
 * (see `GIT_BUDGET_MS`). Each call gets `timeout` = what is left; once nothing
 * is left it throws without spawning. `exhausted()` turns sticky the moment a
 * call is refused or timed out, so a caller can tell "git said no" from "git
 * never got to answer" — the second is a skip, never evidence (§ matrix rows 8,
 * 15). `SIGKILL`, not the default SIGTERM: a child that ignores SIGTERM keeps
 * `execFileSync` blocked past its timeout. Safe here — every call is read-only
 * plumbing that takes no index lock (§ PSA).
 *
 * @param {number} deadline — epoch ms
 * @returns {{run: (args: string[], cwd: string, opts?: {maxBuffer?: number}) => string,
 *   exhausted: () => boolean}}
 */
function makeGitRunner(deadline) {
  let exhausted = false;
  const run = (args, cwd, { maxBuffer } = {}) => {
    const remaining = Math.floor(deadline - Date.now());
    if (remaining <= 0) {
      exhausted = true;
      throw new GitBudgetExhausted(args[0]);
    }
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: remaining,
        killSignal: 'SIGKILL',
        ...(maxBuffer === undefined ? {} : { maxBuffer }),
      });
    } catch (e) {
      if (e?.code === 'ETIMEDOUT') exhausted = true;
      throw e;
    }
  };
  return { run, exhausted: () => exhausted };
}

/**
 * `git rev-parse --show-toplevel` of `cwd`, or `''` when git cannot say.
 *
 * @param {string} cwd
 * @param {ReturnType<typeof makeGitRunner>} git
 * @returns {string}
 */
function gitToplevel(cwd, git) {
  try {
    return git.run(['rev-parse', '--show-toplevel'], cwd).trim();
  } catch {
    return '';
  }
}

/**
 * Tracked files of the repo rooted at `root`, plus WHY the list is empty when
 * it had to be (matrix row 8 — degrade, never deny, but leave a reason).
 *
 * @param {string} root — a git toplevel, or `''` when none could be resolved
 * @param {ReturnType<typeof makeGitRunner>} git
 * @returns {{files: string[], skipped?: 'budget-exhausted'|'git-error'}}
 */
function trackedFilesIn(root, git) {
  const failed = () => ({ files: [], skipped: git.exhausted() ? 'budget-exhausted' : 'git-error' });
  if (root === '') return failed();
  try {
    const stdout = git.run(['ls-files', '-z'], root, { maxBuffer: 32 * 1024 * 1024 });
    return { files: stdout.split('\0').filter((f) => f.length > 0) };
  } catch {
    return failed();
  }
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
 * Standalone entry with its own `GIT_BUDGET_MS`; `main()` composes the same two
 * steps under the deadline it shares with the worktree-base check.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function listTrackedFiles(cwd) {
  const git = makeGitRunner(Date.now() + GIT_BUDGET_MS);
  return trackedFilesIn(gitToplevel(cwd, git), git).files;
}

/*
 * The SESSION ROOT (#1489 Pkt 6) — where this session's own state lives: the
 * scope ledger and its lock, the `wave-scope.json` the wave key is read from,
 * the event records and their session attribution. NOT where project settings
 * are read — that is `settingsRootOf()`, a different directory on purpose.
 * Resolved by `resolveSessionRoot(cwd, cwdToplevel)` in
 * `scripts/lib/platform.mjs` — ONE resolver shared with every hook that reads
 * the session's control files (#1492). Why each rung is where it is:
 *
 * NOT the payload `cwd`: that one follows the session's `cd` (docs/en/hooks
 * § "cwd follows Claude"). Keyed on it, a dispatch made after `cd sub` read and
 * wrote `<root>/sub/.orchestrator/wave-dispatch-scopes.json` — a second, empty
 * ledger holding none of the wave's earlier claims — so its collision with an
 * agent dispatched before the `cd` was ALLOWED, and its records left the
 * session's `events.jsonl`. The git toplevel of `cwd` undoes exactly that `cd`.
 *
 * NOT `$CLAUDE_PROJECT_DIR` first either: it stays on the LAUNCH dir after the
 * session enters a worktree (docs/en/hooks § "Worktrees are different"), while
 * the coordinator writes `wave-scope.json` into the worktree and
 * `scope-echo --verify` reads that worktree's `events.jsonl`. Preferred here, it
 * (measured on be6a2e3e) dropped every wave key to `w?`, left the worktree's
 * records empty, and gave every worktree session of one launch dir ONE shared
 * ledger — where a peer session's dispatch wipes this session's claims and lets
 * the collision through. It is the fallback only when `cwd` is in no repo.
 *
 * NOR `$CLAUDE_PROJECT_DIR` merely because GIT could not answer (review MED on
 * 63f35e8c): `gitToplevel()` returns `''` on ANY error, and the toplevel lookup
 * is the first spawn against the shared `GIT_BUDGET_MS` — one `rev-parse`
 * hanging past it sent a worktree session's dispatch back to the launch-root
 * ledger, the exact bug above narrowed to the timeout. The resolver's `.git`
 * ancestor walk answers the same question without a spawn, so no budget can
 * cut it.
 *
 * Precedence: the git toplevel of `cwd`, else the nearest `.git` ancestor of
 * `cwd` — either one lifted to the coordinator's root when it is a harness
 * subagent worktree `<root>/.claude/worktrees/agent-<hex>` (#1492) — else the
 * launch dir from env, else `cwd`.
 *
 * Remaining limit (not a regression — main keyed state on `cwd` itself): a `cd`
 * into a NESTED toplevel that is not a harness agent worktree — a worktree the
 * session entered under `.claude/worktrees/<name>`, a submodule, a nested repo —
 * gets that toplevel's own ledger, by either rung, because it IS a repo root of
 * its own.
 */

/**
 * The SETTINGS ROOT (#1485) — where `harnessBaseRef()` reads the project's
 * `.claude/settings{,.local}.json`: `$CLAUDE_PROJECT_DIR`, else the git toplevel
 * of `cwd`, else `cwd`. The launch dir FIRST, unlike `resolveSessionRoot()`: it is the
 * root the harness applies project settings from, and after entering a worktree
 * the gitignored `settings.local.json` exists only there.
 *
 * @param {string} cwd — the payload `cwd`
 * @param {string} cwdToplevel — `gitToplevel(cwd)`, `''` when git could not say
 * @returns {string}
 */
function settingsRootOf(cwd, cwdToplevel) {
  return (process.env.CLAUDE_PROJECT_DIR || '').trim() || cwdToplevel || cwd;
}

// ---------------------------------------------------------------------------
// Stale worktree base (#1413 → #1485) — a MEASURED mismatch DENIES the dispatch
//
// `isolation: "worktree"` makes the HARNESS create `<repo>/.claude/worktrees/
// agent-<hex>`; no code in this repo creates it and the `Agent` payload carries
// no base-ref field (the 147-dispatch key census in the module docblock). Which
// commit it branches from is documented harness behaviour (code.claude.com/docs
// /en/worktrees § "Choose the base branch", read 2026-10-02): "Subagent worktrees
// use the same base branch as `--worktree`, so they branch from your repository's
// default branch unless `worktree.baseRef` is set to `"head"`" — `"fresh"` (the
// default) is `origin/HEAD`, `"head"` is the current local HEAD.
//
// That REPLACES the #1413 model ("the base is the session-start commit"): it fit
// s18 only because that session ran on `main`, where origin/main WAS the start
// commit. #1485 measured the general case on a feature branch — agent worktrees
// stood on `main` (`0efb3e97`), six commits behind the branch HEAD (`47c49652`),
// so the agents silently edited old code. Owner decision 2026-10-02, option (a):
// check with `git merge-base --is-ancestor` before dispatch and stop on mismatch.
//
// ONLY A MEASURED MISMATCH DENIES (`is-ancestor` exit 1 in a full-history repo,
// against a cached origin ref the harness will branch from as-is). Every
// non-measurement — no origin/HEAD, a shallow clone, a cached ref the harness
// refetches first (`stale-remote-ref`), a git failure, an exit code other than
// 0/1, a throw — is `stale: null` + `skipped`, recorded and ALLOWED: unknown is
// not mismatch, and this hook guards the dispatch path, where a wrong deny is a
// session outage (§ the fail-open note at the bottom of this file).
//
// Where the hook's base and the harness's can still DIVERGE (Claude Code
// 2.1.287 bundle, read 2026-10-02):
//   - a settings layer this hook cannot read (`harnessBaseRef()`) — either way,
//     wrong deny or missed mismatch, from any `base_ref_source`;
//   - no `refs/remotes/origin/HEAD` symref: the harness falls back to
//     `origin/main|master`, the hook skips `no-origin-head` — a missed mismatch
//     only, never a wrong deny (measured 2026-10-02: 0 of 28 local repos lack
//     the symref);
//   - a stale FETCH_HEAD whose refetch then FAILS (offline): the harness keeps
//     the cached ref, so the skipped deny would have been right — the price of
//     not knowing in advance whether a fetch will succeed.
// ---------------------------------------------------------------------------

/** `worktree.baseRef` values the docs define; anything else sets nothing here. */
const BASE_REF_VALUES = new Set(['head', 'fresh']);

/**
 * The harness refetches origin before branching a `"fresh"` worktree when
 * FETCH_HEAD is older than this (Claude Code 2.1.287 bundle, read 2026-10-02:
 * `Date.now() - mtimeMs > 86400000`, then `git fetch origin <default>` with a
 * 5 s timeout). Revisit when the harness changes that constant — a mismatch
 * either skips a real deny or lets a refetched base be denied again.
 */
const FETCH_REFRESH_MS = 24 * 60 * 60 * 1000;

/**
 * The harness's effective `worktree.baseRef`, as far as this hook can see it,
 * and WHICH layer decided it — read in the documented precedence order (code.
 * claude.com/docs/en/settings § "Settings precedence", read 2026-10-02): local
 * → project → user, the FIRST file that sets the key to a defined value wins.
 * No file sets it → `'fresh'` from `'default'`.
 *
 * `settingsRoot` is the SESSION ROOT, not the hook payload's `cwd`: that `cwd`
 * follows the session's `cd` (docs/en/hooks § "cwd follows Claude"), while the
 * project settings the harness applies belong to the root it started in.
 *
 * Read only on the rare `worktree` branch (14 of 147 measured dispatches carried
 * `isolation` at all), so the hot dispatch path never pays these reads.
 *
 * NAMED CEILING (BV-004): blind to the two layers ABOVE local — managed settings
 * and the `--settings` CLI flag. The error points BOTH ways: a `"head"` there
 * with no visible file setting the key reads as `default` → `fresh` → a WRONG
 * DENY when HEAD is ahead of origin/HEAD; a `"fresh"` there shadowing a visible
 * `"head"` → a MISSED mismatch. Not read on purpose: `--settings` reaches no
 * hook, and managed settings arrive through several delivery mechanisms (a
 * `managed-settings.json` in a system dir, MDM/OS policy, server-managed settings
 * from the claude.ai console, an embedding host's SDK option — docs settings
 * § "Managed settings"), combined by their own intra-tier rules; reading the one
 * file among them would turn an honest "invisible" into a partial view that
 * still decides. The wrong-deny population is countable instead (HR-105): a
 * hidden `"head"` with no visible file setting the key yields `decision:"deny"`
 * records with `base_ref_source:"default"`; a hidden `"head"` shadowed by a
 * visible `"fresh"` yields them under that file's source instead. Revisit if
 * such a deny is reported in a session whose `/status` names a managed or
 * `--settings` source carrying `worktree.baseRef`.
 *
 * @param {string} settingsRoot
 * @returns {{baseRef: 'head'|'fresh', source: 'local'|'project'|'user'|'default'}}
 */
function harnessBaseRef(settingsRoot) {
  const userDir = (process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(homedir(), '.claude');
  for (const [source, file] of [
    ['local', path.join(settingsRoot, '.claude', 'settings.local.json')],
    ['project', path.join(settingsRoot, '.claude', 'settings.json')],
    ['user', path.join(userDir, 'settings.json')],
  ]) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'))?.worktree?.baseRef;
      if (BASE_REF_VALUES.has(value)) return { baseRef: value, source };
    } catch { /* absent or unparseable — the next layer decides */ }
  }
  return { baseRef: 'fresh', source: 'default' };
}

/** Where each `base_ref_source` lives, for the operator-facing deny text. */
const BASE_REF_SOURCE_LABEL = {
  local: '.claude/settings.local.json',
  project: '.claude/settings.json',
  user: 'user settings.json',
  default: 'the default — no settings file this hook can read sets it',
};

/**
 * Facts for the worktree-base check, as a DISCRIMINATED record with three
 * outcomes rather than two (#1424):
 *
 *   - `{stale: true|false, head, base, base_ref, base_ref_source, missing_commits?,
 *     subagent_type?}` — measured. `stale` means "the worktree would MISS commits
 *     of HEAD": `git merge-base --is-ancestor HEAD <base>` exited 1 in a repo
 *     with full history and a FETCH_HEAD younger than `FETCH_REFRESH_MS` (so
 *     the harness branches from that cached ref without refetching it first).
 *     A base AHEAD of HEAD (origin moved on, HEAD contained)
 *     is not stale — nothing of HEAD is lost. `base_ref_source` names the
 *     settings layer that decided `base_ref` (`harnessBaseRef()`), so a wrong
 *     deny from a layer this hook cannot read stays countable (HR-105).
 *   - `{stale: null, skipped: <reason>}` — the dispatch WAS on the `worktree`
 *     branch, but the question could not be answered honestly. Still emitted,
 *     because HR-105 needs the denominator, and never denied (unknown ≠ mismatch).
 *   - `null` — `isolation !== 'worktree'`. SILENT by construction: recording the
 *     other ~90% of dispatches would put the denominator on the hot path (HR-101).
 *
 * TWO DIRECTORIES, deliberately different: git measures in `cwd` (the payload's,
 * which follows the session's `cd` — git finds the enclosing repo from any
 * subdirectory, and inside an entered worktree `"head"` means THAT worktree's
 * HEAD); settings are read at `settingsRoot` (`settingsRootOf()` — the root the
 * harness applies project settings from, which is NOT where the record lands:
 * that is `resolveSessionRoot()`).
 *
 * Every git call draws on the hook fire's ONE shared deadline (`GIT_BUDGET_MS`).
 * A call the budget cut short is no measurement: each skip then reads
 * `git-budget`, whichever reason the cut call would otherwise have produced — a
 * timed-out `origin/HEAD` lookup is not evidence that there is none.
 *
 * @param {{tool_input?: unknown}} input — the raw hook payload
 * @param {string} cwd — the hook payload's `cwd`
 * @param {string} settingsRoot — `settingsRootOf()`
 * @param {ReturnType<typeof makeGitRunner>} gitRunner — the fire's shared runner
 * @returns {{head: string, base: string, base_ref: 'head'|'fresh',
 *   base_ref_source: 'local'|'project'|'user'|'default', stale: boolean,
 *   missing_commits?: number, subagent_type?: string}|{stale: null, skipped: string}|null}
 */
function worktreeBaseFacts(input, cwd, settingsRoot, gitRunner) {
  // The applicability gate sits OUTSIDE the try on purpose: everything below it
  // resolves to a `skipped` RECORD, so a throw here must not be able to mint one
  // for a dispatch that was never on the `worktree` branch at all.
  const toolInput = input?.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return null;
  if (toolInput.isolation !== 'worktree') return null;

  /** @param {string} reason */
  const skip = (reason) => ({ stale: null, skipped: gitRunner.exhausted() ? 'git-budget' : reason });
  try {
    /** @param {string[]} args */
    const git = (args) => gitRunner.run(args, cwd).trim();

    let head = '';
    try { head = git(['rev-parse', '--verify', 'HEAD^{commit}']); } catch { /* below */ }
    if (head === '') return skip('git-error');

    const { baseRef, source } = harnessBaseRef(settingsRoot);
    const facts = { head, base_ref: baseRef, base_ref_source: source };
    if (typeof toolInput.subagent_type === 'string' && toolInput.subagent_type !== '') {
      facts.subagent_type = toolInput.subagent_type;
    }
    // `"head"` inside a worktree resolves to THAT worktree's HEAD (docs, same
    // section) — the very `git rev-parse HEAD` above, run in `cwd`.
    if (baseRef === 'head') return { ...facts, base: head, stale: false };

    // `"fresh"`: origin/HEAD. Not cached locally → the harness fetches, or
    // falls back to HEAD; neither outcome is knowable here → skip, not deny.
    let base = '';
    try { base = git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/HEAD^{commit}']); } catch { /* below */ }
    if (base === '') return skip('no-origin-head');
    if (base === head) return { ...facts, base, stale: false };

    try {
      git(['merge-base', '--is-ancestor', head, base]);
      return { ...facts, base, stale: false };
    } catch (e) {
      // Exit 1 is the ONE candidate "no"; 128 (bad object), a timeout or a
      // signal is a non-measurement and must not accuse anybody.
      if (e?.status !== 1) return skip('git-error');
    }
    // ...and exit 1 is a MEASUREMENT only over full history. A shallow clone's
    // cut-off graph answers "no" for a HEAD that IS an ancestor (measured
    // 2026-10-02: `clone --depth 1` + `fetch --depth 1` → exit 1, the full source
    // → exit 0). Probed only here, on the rare "no": an exit 0, which no missing
    // history can fake, never pays for it. A failed probe cannot rule shallow
    // out, so it skips as well. ONE spawn answers both questions below (two
    // lines, in argument order) — the deny path is the one that must finish
    // inside the shared budget.
    let shallow = '';
    let fetchHeadPath = '';
    try {
      [shallow = '', fetchHeadPath = ''] = git(['rev-parse', '--is-shallow-repository', '--git-path', 'FETCH_HEAD'])
        .split('\n')
        .map((line) => line.trim());
    } catch { /* below */ }
    if (shallow !== 'false') return skip(shallow === 'true' ? 'shallow' : 'git-error');

    // ...and only over a ref the harness will actually branch from. With
    // FETCH_HEAD older than `FETCH_REFRESH_MS` (or absent — the harness reads
    // that as mtime 0) it first fetches origin and branches from the FETCHED
    // tip, which may well contain HEAD by now; this hook never fetches (network
    // inside a 5 s PreToolUse budget), so the cached ref decides nothing here.
    let fetchedMs = 0;
    try { if (fetchHeadPath !== '') fetchedMs = statSync(path.resolve(cwd, fetchHeadPath)).mtimeMs; } catch { /* absent → stale */ }
    if (Date.now() - fetchedMs > FETCH_REFRESH_MS) return { stale: null, skipped: 'stale-remote-ref' };

    let missing = Number.NaN;
    try { missing = Number.parseInt(git(['rev-list', '--count', `${base}..${head}`]), 10); } catch { /* optional */ }
    return { ...facts, base, stale: true, ...(Number.isInteger(missing) ? { missing_commits: missing } : {}) };
  } catch {
    // Total by construction. Still a RECORD rather than silence (#1424 / HR-105).
    return { stale: null, skipped: 'probe-error' };
  }
}

/**
 * The deny reason + suggestion for a measured stale base. Names the ACTION, not
 * just the condition (HR-106), and the settings layer that chose `"fresh"`: an
 * operator whose `"head"` lives where this hook cannot read (managed settings,
 * `--settings`) then reads "the default" and knows the deny rests on that blind
 * spot. The reason stays ONE line: `emitDeny` lifts the first line into the
 * operator-visible `systemMessage` headline.
 *
 * @param {{head: string, base: string, base_ref_source?: string, missing_commits?: number}} facts
 * @returns {{reason: string, suggestion: string}}
 */
function staleWorktreeDeny(facts) {
  const missing = Number.isInteger(facts.missing_commits)
    ? `${facts.missing_commits} commit(s)`
    : 'commits';
  const from = BASE_REF_SOURCE_LABEL[facts.base_ref_source] ?? BASE_REF_SOURCE_LABEL.default;
  return {
    reason:
      `${HOOK_NAME}: STALE WORKTREE BASE (#1485) — isolation: "worktree" would branch this `
      + `agent from origin/HEAD ${facts.base.slice(0, 12)} (worktree.baseRef "fresh" from ${from}), `
      + `which is missing ${missing} of HEAD ${facts.head.slice(0, 12)}; the agent would silently edit OLD code.`,
    suggestion: [
      'DO ONE OF:',
      '  1. re-dispatch IN-PLACE — omit `isolation` (isolation "none");',
      '  2. set `"worktree": {"baseRef": "head"}` in .claude/settings.json so agent',
      '     worktrees branch from your local HEAD (code.claude.com/docs/en/worktrees) —',
      '     a higher layer setting "fresh" (local settings, --settings, managed) overrides it;',
      '  3. get HEAD into the default branch on origin and fetch, then re-dispatch.',
      'Uncommitted changes reach no worktree under any base — commit first or go in-place.',
    ].join('\n'),
  };
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
 * The digest half of the per-dispatch record (#1092) — the field set that makes
 * the SEND side joinable to the RECEIVE side.
 *
 * Four facts, all derived from the PROMPT alone, none of them a path:
 *
 *   `scope_digest`            — `scopeDigest()` over the paths extracted FROM THE
 *                               PROMPT. This is the join key `scope-echo --verify`
 *                               uses; `agent_id` cannot be one, because the two
 *                               halves spell it differently (measured 2026-09-16:
 *                               609 send-side vs 51 receive-side records, agent-id
 *                               overlap ZERO — send writes
 *                               `"i-3 #1353 … (session-orchestrator:code-implementer)"`,
 *                               receive writes `"i-3"`).
 *   `echo_instruction_present`— the coordinator appended the echo line at all.
 *   `instructed_digest`       — the digest THAT LINE names.
 *   `digest_consistent`       — the two agree. `false` is agent A's fenced block
 *                               beside agent B's echo line, caught at dispatch
 *                               time with no filesystem read.
 *
 * ABSENT IS NOT ZERO, in both directions (`docs/events-schema.md`):
 * `scope_digest` is OMITTED for an empty scope — never the digest of the empty
 * string, which is a real 8-hex value and would join marker-absent Discovery
 * dispatches to each other. `instructed_digest` is omitted when no line was
 * found, and `digest_consistent` unless BOTH are present.
 *
 * TOTAL by construction: every branch is wrapped, because this runs on the
 * decision path of a deny-capable hook. A throwing digest function must cost the
 * FIELD, never the verdict — same discipline as the awaited-and-caught emit.
 *
 * @param {string[]} files      paths extracted from the prompt
 * @param {unknown} prompt      the dispatch prompt
 * @param {((paths: string[]) => string)} [digestFn] injectable for tests; defaults
 *   to the late-bound `scopeDigest` (undefined when `bootstrap()` has not run,
 *   which this function treats exactly like a throwing one — the field is omitted)
 * @returns {{scope_digest?: string, echo_instruction_present: boolean,
 *            instructed_digest?: string, digest_consistent?: boolean}}
 */
export function scopeDigestFields(files, prompt, digestFn) {
  /** @type {Record<string, unknown>} */
  const out = {};
  try {
    const fn = typeof digestFn === 'function' ? digestFn : scopeDigest;
    if (typeof fn === 'function' && Array.isArray(files) && files.length > 0) {
      const digest = fn(files);
      if (typeof digest === 'string' && DIGEST_RE.test(digest)) out.scope_digest = digest;
    }
  } catch { /* a broken digest costs the field, never the decision */ }

  let instructed = null;
  try {
    const match = typeof prompt === 'string' ? ECHO_INSTRUCTION_RE.exec(prompt) : null;
    if (match !== null) instructed = match[1].toLowerCase();
  } catch { instructed = null; }

  out.echo_instruction_present = instructed !== null;
  if (instructed !== null) out.instructed_digest = instructed;
  if (typeof out.scope_digest === 'string' && instructed !== null) {
    out.digest_consistent = out.scope_digest === instructed;
  }
  return /** @type {any} */ (out);
}

/**
 * @typedef {{action: 'allow'|'deny'|'warn', reason?: string, suggestion?: string,
 *            ledger?: object|null, note?: string, telemetry?: object}} Verdict
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
 * @param {(paths: string[]) => string} [params.digestFn] scope-digest function
 *   (injected for testability; defaults to the late-bound `scopeDigest`)
 * @returns {Verdict}
 */
export function decide({ input, ledger, ledgerCorrupt, waveKey, knownFiles, collide, isFinished, nowIso, digestFn }) {
  const toolName = input?.tool_name;
  // Row 4: not our tool.
  if (toolName !== DISPATCH_TOOL) return { action: 'allow' };

  const toolInput = input?.tool_input;
  if (toolInput === null || typeof toolInput !== 'object') return { action: 'allow' };

  const at = typeof nowIso === 'string' ? nowIso : new Date().toISOString();

  const signal = extractScopeSignal(toolInput.prompt);
  const files = signal.files;
  const id = agentIdOf(toolInput);
  const priorAgents = (ledger !== null && ledger?.waveKey === waveKey && Array.isArray(ledger.agents))
    ? ledger.agents
    : [];

  // #1092 — the observability record this dispatch will leave in the ledger.
  // BUILT here, EMITTED by the caller: `decide()` is a pure function (§ stdout
  // discipline), and an `await` inside it would put an I/O failure on the
  // decision path. Counter-shaped by construction — a count, three enums and the
  // agent id, never a path, never a byte of the prompt (issue #1092 acceptance
  // criterion 3). `wave` is omitted rather than zeroed when unknown.
  const wave = waveNumberOf(waveKey);
  const digestFields = scopeDigestFields(files, toolInput.prompt, digestFn);
  const telemetryFor = (ledgerResult, collisionCount = 0) => ({
    ...(wave === null ? {} : { wave }),
    agent_id: id.slice(0, MAX_AGENT_ID_CHARS),
    declared_path_count: files.length,
    injected: files.length > 0,
    // `marker_found` is NOT a second spelling of `injected`: a fenced block whose
    // lines are prose is `marker_found: true, injected: false` (matrix row 6),
    // which is the row-5-vs-row-6 split expressed as a boolean a query can group by.
    marker_found: signal.status !== SIGNAL_MARKER_ABSENT,
    shape: signal.shape,
    signal: signal.status,
    ...digestFields,
    ledger_result: ledgerResult,
    collision_count: collisionCount,
  });

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
      telemetry: telemetryFor('no-scope'),
      ledger: {
        waveKey,
        updated: at,
        agents: priorAgents,
        scopeSignals: bumpSignalCounter(ledger, waveKey, signal.status),
      },
    };
  }

  const desc = agentDescOf(toolInput);
  // #1480 A: the exact dispatch id travels with the entry, so liveness is never
  // guessed from a description when the harness names the dispatch itself.
  const useId = exactUseId(input?.tool_use_id);
  const self = useId === '' ? { id, desc, files, at } : { id, desc, files, at, useId };

  // Row 7: ledger existed but was unparseable. Terminal warn — decided here and
  // returned, never emitted mid-flow. SELF-HEALING since the review: the verdict
  // carries a FRESH ledger, so the corruption is repaired by this dispatch
  // instead of disabling the guard for the rest of the wave.
  if (ledgerCorrupt) {
    return {
      action: 'warn',
      telemetry: telemetryFor('warn-ledger-corrupt'),
      ledger: { waveKey, updated: at, agents: [self], scopeSignals: bumpSignalCounter(null, waveKey, signal.status) },
      note:
        `${HOOK_NAME}: wave dispatch ledger was unreadable — scope-disjointness NOT checked for ` +
        `"${id}"; the ledger has been reset, so the next dispatch is checked again.`,
    };
  }

  const prior = (ledger !== null && ledger?.waveKey === waveKey && Array.isArray(ledger.agents))
    ? ledger.agents.filter((a) => a !== null && typeof a === 'object' && typeof a.id === 'string')
    : [];

  // Row 10 (#1480 B4): a predecessor with the SAME agent id is no longer dropped
  // before the check. Dropping it unconditionally erased the claim of a still
  // RUNNING agent: [a,b] running, re-dispatched as [b,c], and a third agent on
  // `a` was allowed while the first run still wrote it. Now:
  //   - the same `tool_use_id` → the same dispatch evaluated again → replaced;
  //   - FINISHED (probe true) → pruned below, so a retry after a failed agent
  //     stays allowed — a failed agent finishes via its `failed` carrier,
  //     `is_error` or its report;
  //   - both dispatches carry distinct exact ids and the predecessor is NOT
  //     finished → an ordinary collision partner (row 11);
  //   - otherwise no exact statement is possible → it stays as a CLAIM (a third
  //     agent hitting only its scope still collides) but never collides with
  //     this retry.
  // Named ceiling (BV-004): without exact ids a same-id retry cannot tell "my
  // earlier run is still going" from "it failed", so the retry is allowed while
  // the earlier claim is kept — the pre-#1480 behaviour for the retry itself,
  // and a claim a third agent can hit until the earlier run finishes or its TTL
  // lapses. Revisit-Trigger: a harness without `tool_use_id` in the PreToolUse
  // payload dispatches a measurable share of this repo's waves.
  // A predecessor wholly covered by this retry's scope, neither carrying an
  // exact id, adds nothing but ledger growth — both are resolved through the
  // same description and this entry is the younger one — so it is superseded.
  const superseded = (a) => a.id === id && (
    (useId !== '' && exactUseId(a.useId) === useId)
    || (useId === '' && exactUseId(a.useId) === '' && desc !== '' && a.desc === desc
      && Array.isArray(a.files) && a.files.every((f) => files.includes(f)))
  );
  const others = prior.filter((a) => !superseded(a));

  // One comparison key per record, unique by construction: several records may
  // share an agent id now, and `findScopeCollisions` reports equal ids as
  // duplicates rather than comparing them. The readable id stays the key where
  // it is unique, so the deny text and every single-record wave are unchanged.
  const used = new Set([id]);
  const partners = others.map((entry) => {
    let key = entry.id;
    for (let n = 2; used.has(key); n++) key = `${entry.id} #${n}`;
    used.add(key);
    const selfClaim = entry.id === id && !(useId !== '' && exactUseId(entry.useId) !== '');
    return { key, entry, selfClaim };
  });

  const known = new Set(Array.isArray(knownFiles) ? knownFiles : []);
  const agentScopes = [
    ...partners.map((p) => ({ id: p.key, files: promoteDirEntries(p.entry.files, known) })),
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
      telemetry: telemetryFor('warn-not-evaluable'),
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

  if (mine.length === 0) return { action: 'allow', telemetry: telemetryFor('allow'), ledger: nextLedger };

  // § Liveness — the review's HIGH finding. A collision with an agent that has
  // ALREADY FINISHED is a sequential repair pass, not a race. The probe is called
  // ONLY here, so the transcript is read only on the path that would deny.
  const byKey = new Map(partners.map((p) => [p.key, p]));
  const probe = typeof isFinished === 'function' ? isFinished : () => false;
  const finishedKeys = new Set();
  const live = [];
  let selfClaims = 0;
  for (const c of mine) {
    const otherKey = c.a === id ? c.b : c.a;
    const partner = byKey.get(otherKey);
    if (partner !== undefined && probe(partner.entry)) {
      finishedKeys.add(otherKey);
      continue;
    }
    // Row 10: an unfinished same-id claim without exact ids is kept, not collided with.
    if (partner?.selfClaim === true) {
      selfClaims++;
      continue;
    }
    live.push(c);
  }
  const counted = mine.length - selfClaims;

  // Row 10a: every colliding prior agent has finished. Allow AND prune their
  // records — leaving them would make the NEXT repair pass pay the transcript
  // scan again for a question already answered.
  if (live.length === 0) {
    const kept = partners.filter((p) => !finishedKeys.has(p.key)).map((p) => p.entry);
    return {
      action: 'allow',
      telemetry: finishedKeys.size > 0 ? telemetryFor('allow-finished', counted) : telemetryFor('allow'),
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
    const otherKey = c.a === id ? c.b : c.a;
    const other = byKey.get(otherKey)?.entry.id ?? otherKey;
    const earlier = other === id ? ' (an earlier dispatch of the same agent)' : '';
    const ev = Array.isArray(c.evidence) ? c.evidence : [];
    const evShown = ev.slice(0, MAX_EVIDENCE_PER_COLLISION).map(clipPath).join(', ');
    const more = ev.length > MAX_EVIDENCE_PER_COLLISION
      ? ` (+${ev.length - MAX_EVIDENCE_PER_COLLISION} more)`
      : '';
    return `  • "${id}" ↔ "${other}"${earlier} [${c.kind}]: ${evShown}${more}`;
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
  return { action: 'deny', telemetry: telemetryFor('deny', counted), reason, suggestion };
}

// ---------------------------------------------------------------------------
// Entry point — exactly ONE terminal emit
// ---------------------------------------------------------------------------

async function main() {
  // Row 3: no input is not a real hook call.
  const input = await readStdin();
  if (!input) return emitAllow();

  // The payload `cwd` follows the session's `cd`; it names the repo git measures
  // in, and only through its git toplevel where this session's state lives
  // (`resolveSessionRoot()`) — a `cd sub` must not move the ledger.
  const cwd = typeof input.cwd === 'string' && input.cwd !== ''
    ? input.cwd
    : bannerProjectDir();
  const sessionId = typeof input.session_id === 'string' ? input.session_id : 'no-session';

  // Cheap pre-check: skip all I/O for the overwhelmingly common non-dispatch call.
  if (input.tool_name !== DISPATCH_TOOL) return emitAllow();

  // ONE git deadline for this whole fire (`GIT_BUDGET_MS`). Worst case 7 spawns
  // against it: the toplevel below, up to 5 in `worktreeBaseFacts` (HEAD,
  // origin/HEAD, is-ancestor, shallow+FETCH_HEAD, rev-list) and `ls-files`.
  const git = makeGitRunner(Date.now() + GIT_BUDGET_MS);
  const cwdToplevel = gitToplevel(cwd, git);
  const sessionRoot = resolveSessionRoot(cwd, cwdToplevel);

  const waveKey = waveKeyOf(sessionRoot, sessionId, readFileSync);
  // `selfUseId`: this dispatch's own tool_use may already stand in the transcript
  // and must not make a finished same-named predecessor look alive (#1480 A).
  const isFinished = makeFinishedProbe({ transcriptPath: input.transcript_path, selfUseId: input.tool_use_id });
  const ledgerPath = path.join(sessionRoot, LEDGER_REL);

  // #1485 — the stale-worktree-base verdict, computed BEFORE the ledger cycle
  // (and outside the lock: its git spawns hold nobody up there). It never
  // reads the collision verdict and a collision DENY always wins; on its own it
  // denies ONLY a measured mismatch (`stale === true`). Every skip is allowed.
  // It must be known before the cycle because a dispatch this check will deny
  // never happens, so the cycle must not persist it: a phantom claim would make
  // the deny's own remedy — the same agent re-dispatched in place under a new
  // tool_use_id — collide with it for up to `IN_FLIGHT_TTL_MS`.
  //
  // It draws on the shared budget BEFORE the tracked-file listing: a missed
  // stale base has no later gate (matrix row 15), a missed listing only
  // degrades glob expansion, and three later gates still see a collision.
  const worktreeBase = worktreeBaseFacts(input, cwd, settingsRootOf(cwd, cwdToplevel), git);
  const staleDeny = worktreeBase?.stale === true ? staleWorktreeDeny(worktreeBase) : null;

  // Listed at `cwd`'s toplevel ONLY: the declared paths are repo-relative to the
  // repo the agents edit, which is the one the session works in (after entering
  // a worktree: that worktree). Whenever git resolved it, it IS `sessionRoot` —
  // except inside a harness agent worktree, which `sessionRoot` lifts to its
  // parent (#1492) and which lists the same repo's files from its own HEAD;
  // when git could not, `sessionRoot` falls back to a `.git` ancestor (git just
  // failed there), `$CLAUDE_PROJECT_DIR` or a bare `cwd` — another repo, or a
  // subdirectory from which `ls-files` answers subdir-relative (the review-MED
  // class above) — so the listing degrades (matrix row 8) instead of following
  // it there.
  const known = trackedFilesIn(cwdToplevel, git);
  const knownFiles = known.files;

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

    // Not on a stale-base deny — the same rule as the collision deny path
    // (`decide()`, "Deliberately NOT persisting the ledger on deny").
    if (verdict.ledger && staleDeny === null) {
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
  const lockPath = path.join(sessionRoot, LEDGER_LOCK_REL);
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

  // #1092 — one ledger line per dispatch DECISION, awaited BEFORE the terminal
  // emit: `emitAllow`/`emitDeny`/`emitWarn` all call `process.exit()`, which
  // discards a pending append (the same ordering `hooks/enforce-scope.mjs`
  // documents at its own event site). Best-effort in BOTH directions — the
  // import is dynamic so a checkout without `scripts/lib/events.mjs` degrades to
  // silence instead of crashing (§ Import safety), and the catch guarantees a
  // failed write cannot change the verdict or the exit code.
  //
  // `decide()` never sees the stale-base check, so its `ledger_result` describes
  // the COLLISION verdict alone. When the stale base is what actually blocks the
  // dispatch (no collision deny beside it — that one keeps `deny`), the record
  // says so (#1489 Pkt 8): recorded as `allow`, a refused dispatch counted as a
  // dispatched one in every later query. The replaced value survives as
  // `collision_result`, so a `warn-ledger-corrupt` / `warn-not-evaluable` behind
  // a stale-base deny is not reported on stderr alone.
  if (verdict.telemetry) {
    const telemetry = {
      ...verdict.telemetry,
      ...(staleDeny !== null && verdict.action !== 'deny'
        ? { ledger_result: 'deny-stale-base', collision_result: verdict.telemetry.ledger_result }
        : {}),
      ...(known.skipped === undefined ? {} : { known_files_skipped: known.skipped }),
    };
    try {
      const { emitEvent, sessionAttribution } = await import(
        pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'events.mjs')).href
      );
      await emitEvent(
        SCOPE_EVENT,
        { hook: HOOK_NAME, ...telemetry, ...sessionAttribution(sessionRoot) },
        { repoRoot: sessionRoot }
      );
    } catch { /* observability is best-effort — it never blocks the decision */ }
  }

  // #1485 — the stale-worktree-base record (verdict computed above, before the
  // cycle), awaited BEFORE the terminal emit for the same process.exit() reason
  // as the block above.
  //
  // `null` here means "not a worktree dispatch" and stays silent; ANY other
  // shape is emitted, including the `{stale: null, skipped: …}` non-measurements
  // (#1424), with this check's own `decision` folded into the SAME record
  // rather than a second event.
  if (worktreeBase !== null) {
    try {
      const { emitEvent, sessionAttribution } = await import(
        pathToFileURL(path.join(PLUGIN_ROOT, 'scripts', 'lib', 'events.mjs')).href
      );
      await emitEvent(
        WORKTREE_BASE_EVENT,
        {
          hook: HOOK_NAME,
          ...worktreeBase,
          decision: staleDeny === null ? 'allow' : 'deny',
          ...sessionAttribution(sessionRoot),
        },
        { repoRoot: sessionRoot }
      );
    } catch { /* observability is best-effort — it never blocks the decision */ }
  }

  // ONE terminal emit. A collision DENY keeps its own reason — the dispatch is
  // blocked either way — and the stale base goes to the debug channel beside it.
  if (verdict.action === 'deny') {
    if (staleDeny !== null) {
      try { console.error(`⚠ ${staleDeny.reason}`); } catch { /* stderr may be closed */ }
    }
    return emitDeny(verdict.reason, verdict.suggestion);
  }
  if (staleDeny !== null) {
    if (verdict.action === 'warn') {
      try { console.error(`⚠ ${verdict.note}`); } catch { /* stderr may be closed */ }
    }
    return emitDeny(staleDeny.reason, staleDeny.suggestion);
  }
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
//
// NAMED CEILING (BV-004): kept inline rather than imported — hooks avoid
// importing `scripts/lib` on the hot path, where every added module is paid on
// every dispatch. The canonical predicate is `scripts/lib/is-main-module.mjs`;
// revisit if this hook ever imports that tree for another reason, at which
// point the copy costs more than the import saves.
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
  //      is a session outage). A hidden COLLISION is caught downstream by
  //      `validate-wave-scope.mjs` and by `enforce-scope` at write time; a
  //      hidden #1485 stale base is not (matrix row 15) — the accepted cost of
  //      the same asymmetry; a wrongly-denied dispatch is caught by nothing.
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
