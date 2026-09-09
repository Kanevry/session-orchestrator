# Wave Loop — Dispatch (Steps 0 → 1)
> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../../_shared/instruction-file-resolution.md). Wherever this file mentions a project's `CLAUDE.md`, the alias rule applies.

> Reference of the wave-executor skill, split out of `wave-loop.md` (#1157). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`, `circuit-breaker.md` → `../circuit-breaker.md`, `../_shared/…` → `../../_shared/…`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.
> **Mandatory before every dispatch:** run `wave-loop-scope-manifest.md` § Scope Manifest 3.1/3.2 FIRST, then § 1. Dispatch Agents below, then § Started-Set Verification below — an agent counts as started on its `meta.json` sidecar, never on the launch ack.
> After the batch completes, continue in `wave-loop-review.md`.

## Wave Execution Loop

### 0. Wave-Executor Self-Report (C4 — #724)

Run this ONCE at the start of wave execution (before the first wave — not per-wave). The `PreToolUse` skill-invocation matcher does NOT fire for prose-invoked skills, so `wave-executor` is under-counted in `skill-invocations.jsonl` (verified gap: 0 `wave-executor` rows despite a 25-agent session). Emit one `selected` record here so telemetry reflects reality. Best-effort — a write failure NEVER blocks dispatch.

```js
import { appendSkillInvocation } from '$PLUGIN_ROOT/scripts/lib/skill-invocations-schema.mjs';
import path from 'node:path';
try {
  await appendSkillInvocation(
    path.join(process.cwd(), '.orchestrator/metrics/skill-invocations.jsonl'),
    { timestamp: new Date().toISOString(), event: 'selected', skill: 'session-orchestrator:wave-executor', session_id: '<session_id>', phase: 'wave-execution' },
  );
} catch { /* telemetry is best-effort — swallow and continue to dispatch */ }
```

For each wave, resolve its assigned role(s) from the session plan's role-to-wave mapping:

**Empty waves:** If the session plan shows a wave with 0 agents (role had no tasks), skip it entirely:
1. Log in progress update: `## Wave [N] ([Role]) — Skipped (no tasks)`
2. Update STATE.md: increment `current-wave`, add to Wave History: `### Wave N — [Role] (skipped, no tasks)`
3. Proceed to next wave immediately
4. Do NOT write wave-scope.json for skipped waves

### 0a. Scope Baseline Freeze (S2 — #896)

Run this ONCE, immediately after the Self-Report above and before Wave 1 dispatches — never per-wave, same "before the first wave" anchor as the empty-waves rule above. Freezes the session's scope baseline into STATE.md frontmatter so the drift tripwire in `wave-loop-scope-manifest.md` step 7a has a denominator to compare the rest of the session against.

```js
import { writeBaseline } from '$PLUGIN_ROOT/scripts/lib/scope-baseline.mjs';

const result = await writeBaseline({
  repoRoot: process.cwd(),
  intent: '<one-line session intent, from the agreed session plan>',
  ownerBoundary: '<the plan\'s file-scope boundary, e.g. the union of declared agent file scopes>',
  plannedFiles: <the RAW array of declared agent file-scope paths, unfiltered
    — the UNION of every wave's per-agent "Files:" specs. Pass the array as-is;
    `writeBaseline()` filters it internally via `DRIFT_EXCLUDE_PATTERNS`
    (the same `filterExcluded()` helper the S2 drift tripwire's numerator
    uses in step 7 below), so both sides of the ratio are produced by ONE
    code path (#894 review finding F1 — the coordinator no longer has to
    remember to pre-filter in prose). MUST be an array — issue #903 removed
    the previously-accepted plain pre-counted-number call shape (it was an
    unverified re-entry vector for the same F1 filter-bypass bug); anything
    else is rejected up front with `reason: 'invalid-planned-files'`.>,
});
```

Best-effort — never blocks Wave 1 from dispatching. `result.written === false` with `reason: 'already-frozen'` is expected and silent (a prior wave-executor pass in this same session already froze the baseline — do not re-freeze, do not log). Log any OTHER `reason` (`invalid-planned-files`, `no-state-md`, `unreadable-state-md`, `lock-timeout`, `lock-fs-error`, `unexpected-error`, `size-ceiling`, `frontmatter-unsafe`) as an informational note in the wave progress update — none of these block dispatch.

Skip entirely when `persistence: false` in Session Config (no STATE.md exists in that mode).

### 0.5. Pre-Dispatch Resource Gate (#193)

Before dispatching agents, the coordinator runs a resource gate to decide whether the wave should proceed as planned, reduce its agent count, or escalate to coordinator-direct. Gated on `$CONFIG["resource-awareness"]` (default: true).

```js
import {evaluateWaveResourceGate, formatGateReport} from "scripts/lib/wave-resource-gate.mjs";

const gate = await evaluateWaveResourceGate({
  config: $CONFIG,
  plannedAgents: <wave's planned agent count>,
  waveRole: "<Discovery|Impl-Core|Impl-Polish|Quality|Finalization>"
});
```

**Act on the decision:**

| Decision | Coordinator action |
|----------|---------------------|
| `proceed` | Dispatch at `gate.agents` (= `plannedAgents`). Include `gate.reasons` in the wave progress update (informational). |
| `reduce` | Dispatch at `gate.agents` (< `plannedAgents`). Log the reduction as a deviation in STATE.md. Include `gate.reasons` in the wave progress update. |
| `coordinator-direct` | Do NOT dispatch subagents. Coordinator executes the wave's tasks directly. Log as a deviation in STATE.md. Continue to `### 1. Dispatch Agents` only for stagnation-pattern detection wording — the section's execution is skipped. |
| `offload` (#1160) | The envelope carries `host` — `{ decision: 'offload', agents, host, reasons }`. Dispatch the offloadable roles to that alias via `dispatchRemote()` (`### Agent-Type Resolution`, `ssh:<alias>` branch) and the remaining roles locally at `gate.agents`. Placement, not reduction: log it in the wave progress update with the host named, since a wave that silently ran elsewhere is unreadable afterwards. |

**The offload witness is supplied, never probed (#1160).** The gate's own JSDoc states it: `@param {Record<string, boolean>} [opts.remoteReady] — #1160 readiness witness per declared host alias. The gate never probes the network itself; without a witness no host counts as ready and the decision stays local.` So an `offload` decision is impossible unless the coordinator passes one of two things alongside `config`/`plannedAgents`/`waveRole`:

- `remoteReady: { '<alias>': true }` — built from the SessionStart banner line `Offload <alias>: ready=yes`, which was measured at session start and needs no new network call here; or
- `probeFn: remoteReadyProbe` from `scripts/lib/wave-executor/remote-dispatch.mjs` — `@param {(alias: string) => Promise<boolean>} [opts.probeFn] — optional async witness, consulted only for aliases absent from `remoteReady`. Default null.` Use it when the banner is stale or absent; it costs a live probe per alias.

Passing neither is a valid choice, not a bug: the gate then behaves exactly as it did before #1160 and reduces locally.

Reasons MUST appear in the wave's progress update under a "Resource gate:" bullet. Measurements (RAM free GB, CPU %, concurrent sessions) appear verbatim so the user can trust the decision.

Probe failures never block a wave — the gate returns `proceed` with a "probe failed (ignored)" reason and the wave continues at the planned count. A config without `resource-thresholds` (legacy pre-#166) returns `proceed` with `"resource-thresholds missing from config — gate skipped"` — a defensive fallback so the gate never crashes the dispatch loop.

**STATE.md deviation contract (#193):** when the gate returns `reduce` or `coordinator-direct`, append a single timestamped entry to `## Deviations` in `<state-dir>/STATE.md`. Use this exact format so future sessions and the evolve skill can mine for hardware-pattern learnings:

```
- [<ISO 8601 UTC>] Wave N resource-gate <reduce|coordinator-direct>: <gate.reasons[0]>. Measurements: ramFreeGb=<N>, cpuLoadPct=<N>, concurrentSessions=<N>. Planned agents=<M>, dispatched=<gate.agents>.
```

Skip the deviation entry on `proceed`, even when `concurrentSessions` warns — informational reasons belong in the wave progress update, not in deviations.

---

### 1. Dispatch Agents

When `worker-pool.enabled: true` in Session Config, dispatch via `runWavePool()` from `scripts/lib/wave-executor/pool.mjs` with `maxParallel = worker-pool.max-parallel || agents-per-wave` — the bounded cursor is the opt-in alternative that supersedes manual batching. Else fall back to the small-batch Agent() dispatch described below (3–4 calls per message, cumulative up to the wave's `agents-per-wave` cap).

**Worker-pool and background dispatch compose — neither replaces the other.** The pool is the opt-in for bounded-concurrency *pull* (how many agents may be in flight at once); background dispatch is the default *transport* (whether the coordinator's turn returns before an agent finishes). Pool workers may themselves background-dispatch. Adopting either removes no mechanism from the other, and neither adds a second mechanism to maintain.

**Worker-pool timing note:** when `worker-pool.enabled: true`, per-agent start and end times are recorded individually in subagents.jsonl as workers pull from the cursor at different moments. Wave-level timings (for progress updates and metrics) are computed as first-worker-start to last-worker-finish, not as a uniform fan-out timestamp.

Use the **Agent tool** to dispatch this wave's agents. **`run_in_background: true` is the PLATFORM DEFAULT for wave dispatch, not a deviation of ours** — since Claude Code **2.1.232**, non-teammate agent spawns default to background in interactive sessions. Our own measurement 2026-08-22 (v2.1.239) is why that default is the right one for a wave: under blocking dispatch the coordinator was 143 s incapable of acting between an agent's mid-run escalation and its own next turn — escalation latency equals the batch's remaining runtime. Background dispatch returns turns to the coordinator between agent completions; a running agent received a queued message mid-run and answered ~9 min before its final report.

Dispatch in **SMALL BATCHES of 3–4 Agent() calls per message** (cumulative up to the wave's `agents-per-wave` cap). Large single-message fan-outs (>4 Agent() calls in one message) remain **FORBIDDEN** — fleet evidence (conf 1.0, 5 sessions) shows they drop Agent() calls SILENTLY (the coordinator receives fewer results than it dispatched, with no error), whereas serial / small-batch dispatch held 13/13 and 8/8. That evidence PREDATES backgrounding and is untouched by it; what backgrounding changes is the *cost* of batching, which is now near zero — a background batch returns its launch acks immediately, so batches no longer serialize the wave. Dispatch a batch, let its acks return, then dispatch the next, until every planned agent is started; then run **Started-Set Verification** below. The archived, private spec `docs/specs/2026-07-02-fleet-mining-followup-grill.md` (C4) records the batching-policy rationale. The `worker-pool.enabled: true` path (above) is the mechanised opt-in alternative to manual batching. <!-- path-check: historical -->

**What is NOT the reason for 3–4 (platform caps, as of Claude Code 2.1.232).** The batch size defends against the SILENT DROP measured above. It is not, and never was, a workaround for a platform concurrency limit — and the upstream numbers no longer permit reading it as one: **2.1.217** set the concurrent-subagent cap to **20** (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`), **2.1.219** set subagent nesting depth to **3**, **2.1.224** REMOVED the former 200-spawn-per-session cap, and **2.1.232** made background the spawn default (above). So neither 3–4, nor `agents-per-wave: 6`, nor `deep: 18` sits anywhere near a platform ceiling; the only ceiling a wave can actually reach is the concurrency cap of 20, and only through the worker-pool `maxParallel` path. The rule stays at 3–4 because the drop evidence is about how many `Agent()` calls survive ONE assistant message — a question no version bump has addressed. **Revisit-Trigger:** a measurement showing a >4-call single message delivering 100% of its calls. A raised cap is not that measurement. Version provenance: `docs/audits/2026-09-06-360-audit/w1/d9-claude-code-fable.md` (FA-6, 2026-09-06).

Read each wave's dispatch metadata from the session plan header (e.g., `(4 agents, parallel, isolation: worktree)`). When the plan specifies `isolation`, use it verbatim. When the plan does not specify, resolve the effective value via `resolveIsolation({ agentCount, sessionType, collisionRisk, configIsolation })` from `scripts/lib/wave-sizing.mjs` — the graduated default (#194) replaces the previous session-type-only switch. Pass the resolved value to each Agent() tool call per `circuit-breaker.md` (omit the parameter when resolved to `none`).

After resolving `isolation`, compute the wave's enforcement via `resolveEnforcement({ isolation, configEnforcement })` (same module) and write it into `wave-scope.json` under `enforcement`. When isolation resolves to `none`, enforcement auto-promotes from `warn` → `strict` unless the user explicitly set `off` — this ensures the scope hook is hard, not informational, when worktree-level isolation is absent.

Before dispatching, verify the wave's agent count does not exceed `$CONFIG.agents-per-wave` — if it does, warn the user and request plan revision.

`sessionType` for `resolveIsolation` is the session type the shape was resolved for, and the wave's `coordinatorDirect` and `writes` flags are READ FROM the shape's wave entry (`scripts/session-shape.mjs` → `waves[]`) rather than inferred from the role name. The dispatch-side marker is unchanged: the coordinator still keys the table below on `coordinator-direct: true` in the wave-plan item — the shape says which waves are expected to carry it, the plan item is what the coordinator acts on.

**Coordinator-direct waves (`coordinator-direct: true`) dispatch NOTHING — and that is not a silent drop.** Keyed on the marker, never on a profile name (`skills/session-plan/SKILL.md` keys its matching empty-role exception the same way), so any future coordinator-direct wave inherits this:

| Step | Behaviour when the wave-plan item carries `coordinator-direct: true` |
|---|---|
| `Agent()` calls | NONE. Make no dispatch at all for this wave. |
| Scope manifest | SKIP materialization — no per-agent scope files, no per-wave union. There are no agents to constrain; the coordinator's own edits stay governed by its `coordinator.json` record. |
| § Started-Set Verification | Expected set is EMPTY. `planned = started = completed = 0` is the CORRECT reading, never `never-started` — do NOT re-dispatch. |
| Advancing to the next wave | BLOCKS on the wave's AskUserQuestion. This is the one wave whose purpose is to stop; never auto-advance past it. |
| STATE.md Wave History (§ 3a in `wave-loop-review.md`) | Record the wave with its role and `agents: 0`, so the wave count stays honest. |

Rationale and the first consumer (the ultradeep profile's wave 2, "Synthesis-Gate"): `docs/prd/2026-09-06-ultradeep-session-profile.md`. Not restated here.

#### Contract-Lock Serialization (Pattern A, #730/H1)

When the session plan marks a wave task `contract-lock: true` (session-plan Step 3.5 step 6), dispatch that single agent ALONE as the first batch and WAIT for its **task-notification** (`<status>completed</status>`) before dispatching the disjoint fan-out batches — NOT for its tool-result, which under background dispatch is the immediate launch ack and would release the fan-out against an unfrozen contract (§ Started-Set Verification). The lock agent freezes the shared contract (interfaces/schemas/shared types/constants) so the N follow-on agents build against a fixed surface instead of racing to invent it. Never place the contract-lock agent in the same batch as the impl agents — its output is an input to theirs. The contract file MUST NOT appear in any follow-on agent's allowedPaths (read-only reference). If the lock agent reports STATUS: partial/failed, PAUSE the fan-out and surface the choice via AskUserQuestion (proceed with partial contract / re-dispatch lock / abort wave).

#### Started-Set Verification (fail-loud — #724, #1115)

Once all batches for the wave have been dispatched, verify the **started set** against the planned agent list (the agents named in the session plan for this wave). This closes the silent-drop failure class that motivated the small-batch default above (a large fan-out drops calls with no error).

**Never count launch acks.** Under background dispatch every Agent() call returns an immediate `Async agent launched successfully` ack. Counting acks against the plan would report full success with zero work done — a fail-silent hole inside the fail-loud check. Two distinct signals, each with its own source:

- **STARTED** — the agent's `agent-<id>.meta.json` sidecar exists under `~/.claude/projects/<encoded-repo-path>/<session-uuid>/subagents/`. The harness writes it at spawn, carrying `toolUseId` + `description` (measured 2026-08-25). Same substrate the tailer reads — see the header of `scripts/lib/wave-transcript-tail.mjs`. The `subagents/` directory does not exist until the first spawn of the session.
- **COMPLETED** — the agent's task-notification carrying its `<tool-use-id>` and `<status>completed</status>`. NEVER the launch ack. `hooks/pre-task-scope-disjoint.mjs` (`ASYNC_LAUNCH_ACK` constant + `buildTranscriptIndex()`) already implements exactly this ack-vs-completion distinction across both the sync and async record shapes — **cite it as the reference implementation; do not restate its logic here and do not fork a second one.**

Three distinguishable states, each with its own action:

| State | Signal | Action |
|---|---|---|
| **never-started** | no `meta.json` sidecar after the batch's acks returned | Silent drop. **Re-dispatch ONLY the missing agents in a fresh batch** (3–4 per message) before proceeding to Review. Do NOT re-dispatch agents that already started — that would duplicate their file writes. **Before dispatching any re-dispatch (or fix-pass) batch, re-run the Pre-Dispatch Scope-Union Assertion (`wave-loop-scope-manifest.md` § Scope Manifest #3, #796) for each re-dispatched agent** — `allowedPaths` MUST NOT shrink while sibling agents of this wave are still running, or the re-dispatched agent's legitimate writes will be denied by Gate 7. |
| **started-but-never-returned** | sidecar present, no task-notification | The tailer's territory (step 2.0-bis). Do NOT re-dispatch blindly — the agent may be inside one long tool call (transcripts flush per turn, so it is invisible meanwhile), and a second copy would race it on the same file scope. Inspect its `agent-<id>.jsonl` transcript, then decide. |
| **completed** | task-notification with `<status>completed</status>` | Proceed to `### 2. Review Agent Outputs`. |

- Record `agent_count_planned` (from the plan), `agent_count_started` (distinct agents with a `meta.json` sidecar, after any re-dispatch) and `agent_count_completed` (distinct agents whose task-notification arrived) in the wave metrics (see § Capture wave metrics). A persistent `planned > started` gap after re-dispatch is a silent drop; a `started > completed` gap at wave end is an agent that never returned. Both are deviations — log them to STATE.md `## Deviations`.

#### Pre-Dispatch New-Directory Detection (#243)

> **Motivation:** Claude Code's worktree merge-back fails silently when an agent creates a new directory inside the worktree — the new directory is not copied back to the coordinator's working tree (learning `agent-tool-worktree-no-sync-regression`, conf 0.90, 3rd-consecutive observation). The fix is to detect this condition BEFORE resolving isolation and force `isolation: 'none'` so worktree is never used for those agents, eliminating the regression rather than trying to recover from it (learning `wave3-isolation-none-dispatch`, conf 0.75, proven-pattern).

Run this step only when `configIsolation` (read from the Execution Config or `$CONFIG.isolation`) is `'auto'`. If the user explicitly set `configIsolation: 'none'`, skip entirely — user override already achieves the desired outcome. If the user explicitly set `configIsolation: 'worktree'`, honour it but emit an ⚠ warning (see branch 4 below).

```js
import fs from 'fs';
import path from 'path';

// configIsolation: resolved from Execution Config or $CONFIG.isolation (default 'auto')
// agentSpecs: array of agent specifications from the session plan for this wave
//   Each spec has: { subagent_type, fileScope: string[] }  (fileScope = "Files:" entries)

function detectNewDirAgents(agentSpecs, repoRoot) {
  // Returns the count of agents whose scope includes at least one new (non-existent) directory.
  let newDirCount = 0;
  for (const agent of agentSpecs) {
    const willCreateNewDir = (agent.fileScope ?? []).some((scopePath) => {
      // Resolve relative to repo root; handle globs by taking the literal dirname.
      const resolved = path.resolve(repoRoot, scopePath);
      const dir = path.dirname(resolved);
      return !fs.existsSync(dir);
    });
    if (willCreateNewDir) newDirCount++;
  }
  return newDirCount;
}

const repoRoot = process.cwd(); // coordinator CWD restored by Step 2.0 before this wave
const newDirAgentCount = detectNewDirAgents(agentSpecs, repoRoot);

// Branch 1 — no new directories detected, configIsolation: 'auto' → normal resolution path
if (newDirAgentCount === 0 && configIsolation === 'auto') {
  // Proceed to resolveIsolation() unchanged.
}

// Branch 2 — new directories detected, configIsolation: 'auto' → force isolation to 'none'
if (newDirAgentCount > 0 && configIsolation === 'auto') {
  configIsolation = 'none'; // override BEFORE calling resolveIsolation()
  console.warn(
    `⚠ Pre-dispatch: ${newDirAgentCount} agent(s) in this wave will create new directories ` +
    `— isolation forced to 'none' per learning agent-tool-worktree-no-sync-regression (conf 0.90). ` +
    `Reason: Claude Code worktree merge-back fails on new directories (issue #243).`
  );
  // NOTE: resolveEnforcement() will auto-promote 'warn' → 'strict' because isolation resolves
  // to 'none'. The scope hook therefore becomes a hard barrier (not informational) for this wave —
  // document this in the wave progress update so the operator understands enforcement escalated.
}

// Branch 3 — configIsolation: 'none' set explicitly by user → skip detection entirely
if (configIsolation === 'none') {
  // User override respected. No change needed.
}

// Branch 4 — configIsolation: 'worktree' set explicitly by user → honour but warn if new dirs exist
if (configIsolation === 'worktree' && newDirAgentCount > 0) {
  console.warn(
    `⚠ Pre-dispatch: ${newDirAgentCount} agent(s) will create new directories AND ` +
    `isolation is explicitly set to 'worktree'. ` +
    `Known regression: Claude Code merge-back silently drops new directories (issue #243). ` +
    `Override configIsolation to 'none' to avoid data loss.`
  );
  // Proceed with worktree as requested — user accepted the risk.
}

// Branch 5 — configIsolation: 'auto', newDirAgentCount === 0 → no-op (same as Branch 1)
// Explicit for clarity; covered by Branch 1 above.
```

After running this detection block, call `resolveIsolation({ agentCount, sessionType, collisionRisk, configIsolation })` with the (possibly overridden) `configIsolation`. Then call `resolveEnforcement({ isolation, configEnforcement })` as normal — when isolation resolved to `'none'` via Branch 2, enforcement auto-promotes `warn` → `strict`, which MUST be noted explicitly in the wave progress update.

#### Pre-Dispatch: Path-Cousin-Guard Injection (#730.3)

Before dispatching each agent whose fileScope contains a NEW (non-existent) file target, check for existing "cousin" files with a similar basename elsewhere in the repo — prevents the framing-wrong class where an agent creates `scripts/lib/foo/bar.mjs` while `scripts/lib/bar.mjs` already exists and serves the same purpose. <!-- path-check: example -->

**Detection (mechanical, reuses the new-file scan from #243 above):** for each not-yet-existing file target `<newPath>` in an agent's fileScope, take `basename(<newPath>)` minus extension; skip generic basenames (`index`, `utils`, `main`, `config`, or length ≤ 3 chars — false-positive control). Then:

    git ls-files | grep -iE "(^|/)<basename>\.[a-z]+$"

**If ≥1 candidate found**, prepend to the agent's prompt:

    <PATH-COUSIN-GUARD>
    Before creating <newPath>, verify it does not duplicate existing functionality — candidate file(s) with a similar name exist: <candidates>. Read each candidate first. If one already serves this purpose, extend/reuse it instead. Only proceed with the new file if you can state why the existing candidate(s) don't fit.
    </PATH-COUSIN-GUARD>

**If 0 candidates:** dispatch unchanged — same silent-no-op convention as Grounding Injection / Frontmatter-Guard above. Never blocks dispatch.

#### Pre-Dispatch: Fact-Staleness Annotation (#908)

Facts an earlier wave measured get quoted into this wave's prompts as briefing truth — and they decay. In the #908 incident the impl agents found 14 commits where the brief said 9, a clean tree where it said 5 dirty, 92 learnings where it said 40, a file that no longer existed, and a closed epic briefed as critical-open; the worst class was line numbers, which drifted three times and forced 225 citations onto symbol+grep form. Annotating a fact costs one prompt line. Re-briefing a wave on wrong numbers costs the wave.

**What is a fact here:** any repo-state value carried from an earlier wave's report into this prompt — counts (commits, files, tests, issues, learnings), line numbers, file existence, "session X is running", issue/epic open-closed state. NOT design decisions, task assignments, or judgements: those do not decay.

**Trigger — annotate when ANY of these holds (no judgement call):**

1. `now − measured_at ≥ 5 min`
2. `measured_at` is absent
3. the peer probe below reported `live: true` for the repo the fact is about

Threshold derived from `.orchestrator/metrics/subagents.jsonl` (n=340 wave boundaries, agent runtime median 3.5 min): a fact's age at its FIRST cross-wave citation brackets [median 2.5 min, median 9.9 min] depending on where in the producing agent's run it was measured. 5 min sits at the conservative end of that bracket; the cost asymmetry breaks the tie downward. **Corollary: a fact from an earlier wave almost always trips rule 1 — when in doubt, annotate.** `measured_at` comes from the producing agent's report, which `hooks/post-subagent-discovery-validator.mjs` already asks for (PSA-006 point 4).

**Peer signal — once per wave, plus once per distinct foreign repo cited:**

```bash
node "$PLUGIN_ROOT/scripts/lib/peer-discovery.mjs" --check-live "<repoRoot>" --json
# → {"live":false,"reason":"no-lock","probe":"lock-only","peerCount":0,"peer":null}
```

Read `live` from the payload; the exit code reports whether the probe RAN (`0` verdict produced, `1` usage error, `2` internal failure), never the verdict itself. Probe selection is automatic and needs no flag: the coordinator's own working copy takes the `full` probe (worktrees + registry + STATE.md), any other repo takes `lock-only` (two sync calls, no git). Own-vs-foreign is decided by repo IDENTITY, not path nesting — a parent directory that is itself a repo (`~/Projects/<workspace>`) is foreign, not "mine".

Call it for the coordinator's own repo even when every cited fact is about that repo — the own-repo probe self-excludes this session and answers "is another operator session writing into my working copy right now", which is exactly the #908 "14 vs 9 commits" class. `live: true` sets the threshold to **0** for that repo: every state fact about it is asserted, never established, however fresh. The probe is fail-safe (unmeasurable ⇒ `live: true`, including `probe: "full-degraded"` when the peer surfaces returned demonstrably incomplete data), so a probe failure annotates more, never less — and so does a non-zero exit: treat exit `1`/`2` as `live: true`.

**Annotation format** — in the agent prompt, replace the bare value with:

    ASSERTED (age <N> min, source W<k>/<agent>): <value>. Verify command: <cmd>. Run it before relying on this.

**When no measurement command can be named** (rule 2, and the case the validator is meant to catch upstream), do not restate the value at all — a number nobody can re-derive is not a fact:

    UNVERIFIED (no measurement command, source W<k>/<agent>): <claim>. Establish it yourself before relying on this.

**Worked examples:**

| Fact | Decision |
|---|---|
| "13 broken paths", W1-D2, `measured_at` 10:35, cited at 11:20 | Rule 1 (45 min ≥ 5) → `ASSERTED (age 45 min, source W1/D2): 13 broken paths. Verify command: <the grep D2 ran>. Run it before relying on this.` |
| "the coordinator mis-measured 4 numbers" — no measurement command | Rule 2 → `UNVERIFIED` form; the value is dropped, the claim becomes the agent's own task |
| Any count about a foreign repo whose peer probe reports `live: true` | Rule 3 → annotate regardless of age; age may still be printed but is not the reason |

**Never blocks dispatch** — same silent-no-op convention as the injectors above. When facts cannot be annotated for any reason, dispatch proceeds; annotating more is always the safe direction.

#### Agent-Type Resolution

Each agent in the session plan specifies a `subagent_type`. Use that value directly when dispatching:

```
For each agent in this wave:
  Agent({
    description: "<3-5 word summary>",
    prompt: "<COMPLETE task context including:
      - What to do (specific, measurable)
      - Which files to read/modify (exact paths)
      - Acceptance criteria (how to verify done)
      - Relevant patterns — injected automatically as the <APPLICABLE-RULES> block (see Pre-Dispatch: Glob-Scoped Rule Injection below)
      - Relevant past learnings — injected automatically as the <LEARNINGS-INDEX> block, computed PER AGENT from its file scope (see Pre-Dispatch: Learnings-Index Injection below)
      - Any repo-state fact carried from an earlier wave: in the ASSERTED/UNVERIFIED form, never as a bare value (see Pre-Dispatch: Fact-Staleness Annotation above)
      - VCS issue reference if applicable
      - What NOT to touch (other agents' files)
      >",
    subagent_type: "<from session plan>",   // resolved agent type
    run_in_background: true   // RECOMMENDED — verify the started set via meta.json sidecars, never via the launch ack (§ Started-Set Verification)
  })
      - Turn budget and status reporting: "You have a maximum of [maxTurns] turns for this task. If you cannot complete within this budget, report STATUS: partial with what was accomplished and what remains. At the end of your work, report STATUS: done (all acceptance criteria met) or STATUS: partial (some criteria unmet — list which ones)."
      - Optional open-questions reporting (Close Handover-Alignment-Gate, PRD 2026-07-07): "If you encountered a genuinely unresolved, user-facing question you could not answer within your task scope, report it as an additional line: OPEN-QUESTIONS: <question> | context: <one-line why this is unresolved> | candidates: <opt A / opt B>. This line is optional — omit it entirely when you have no such question. Do not use it for questions you could resolve yourself by reading more code."
```

##### Third branch: foreign-model dispatch (`cursor:<model>` — #1150)

The colon heuristic (§ "How to detect project agents") has **three** readings, not two: no colon = project agent, `session-orchestrator:<agent>` = plugin agent, and `cursor:<model>` = **foreign channel**. When the session plan or `agent-mapping` resolves an agent to `cursor:<model>` (e.g. `impl: cursor:composer-2.5`), do NOT call the Agent tool. Dispatch **coordinator-direct** via `dispatchForeign({ model, prompt, repoRoot, role, runId, timeoutSec })` from `scripts/lib/wave-executor/foreign-dispatch.mjs`. Contract, in the order it binds:

1. **`never_foreign` gate first.** `isNeverForeignRole(role)` returns `{ok:false, reason:'never-foreign-role'}` before any worktree or spawn. `NEVER_FOREIGN_ROLES` (impl-core, security-review, migration, release, secrets, incident, refactor-crosscut) is hand-copied from the operator's model-routing SSOT (ADR-002); `dispatch-cursor.sh` enforces none of it, so **this adapter is the only gate** — never route around it with a shell call.
2. **Detached worktree**, `<tmpdir>/so-foreign/<runId>` by default, `git worktree add --detach`. Never under `.claude/worktrees/` — eight readdir scanners in this repo read that path. The stream log is KEPT beside it (`<runId>.log.jsonl`), not trap-deleted.
3. **Verdict measured at the filesystem, never from the model's prose.** `ok` is true only on exit 0 + no timeout + a non-empty changed set (`git diff --name-only` ∪ `ls-files --others`, since a diff alone is blind to new files). **An empty diff is a failure regardless of what the report says.**
4. **MANDATORY Claude diff-review gate.** Read `result.diff` and judge it SEMANTICALLY before any merge-back — test-green is not the bar (measured counterexample: the foreign #1149 solution was test-green and semantically wrong). The **coordinator** applies (`git apply`) and commits; the foreign model never touches this repo's index or worktree (PSA-007). On review failure, discard the diff. **`result.hookTampering === true` invalidates the run regardless of `ok`**: the child repointed or rewrote the shared `.git` hooks path (a linked worktree isolates the tree, not `core.hooksPath`), and that write is invisible in `result.diff` — discard and do not merge. `null` means the fingerprint could not be read (not measured), never "clean".
5. **`removeForeignWorktree({ repoRoot, worktreePath })` after the review** — never before, because a failed run must stay inspectable. It **refuses a `worktreePath` outside `<tmpdir>/so-foreign*`** (returns `{ok:false, reason:'unsafe-...'}` and makes no git call), so it cannot `--force`-remove a sibling session's worktree.

**Trust boundary.** A foreign run bypasses the ENTIRE hook chain — no `PreToolUse:Agent`, no scope enforcement, no `SubagentStop` telemetry (verified against `hooks/hooks.json`, W1/D4). Everything inside the detached worktree is **untrusted** until a Claude coordinator has read the diff and applied it. The replacement ledger record is the `orchestrator.foreign_dispatch.completed` event the adapter emits (payload in `docs/events-schema.md`), which fires on refusals too — a blocked dispatch is a record, not a silence.

**Composition.** A foreign run is a background Bash task, so it composes with background `Agent()` dispatch in the same wave. It is **NOT** part of § Started-Set Verification: no `meta.json` sidecar exists for it and no task-notification arrives. Its lifecycle is the adapter's return value — do not count it as planned/started/completed, and do not read its absence from the started set as a drop.

**Model selection** is not decided here: the operator's model-routing SSOT (ADR-002) owns it. Working defaults: `composer-2.5` for foreign impl; `cursor-grok-4.6-high` for review / test-writing / judgment roles, at `timeoutSec ≥ 900`. Dogfood evidence (2026-08-25): `composer-2.5` on issue #1105 — 165 s, 2 files, +93 lines, mandatory review passed, merged only after independent test verification.

**Timeout.** `maxTurns` does not exist on this channel — see the § Platform-Specific Dispatch timeout note. The wall-clock SIGTERM (`DEFAULT_TIMEOUT_SEC = 900`, defined in `scripts/lib/wave-executor/dispatch-common.mjs`, a floor) is the only circuit breaker.

##### Fourth branch: remote-host dispatch (`ssh:<alias>` — #1160)

A fourth colon reading, beside the `cursor:<model>` branch above: `ssh:<alias>` routes the role to a declared offload host. Reached either from an `offload` resource-gate decision (§ 0.5) or from an explicit `agent-mapping` entry. Do NOT call the Agent tool — dispatch coordinator-direct via `dispatchRemote()` from `scripts/lib/wave-executor/remote-dispatch.mjs`:

```js
import { dispatchRemote } from "scripts/lib/wave-executor/remote-dispatch.mjs";
// task fields, per the adapter's own JSDoc:
//   host (offload alias, `-H`), repo, prompt (STDIN, never argv), role,
//   runId (becomes `--job`), timeoutSec?, model?, patchPath?
const result = await dispatchRemote(
  { host, repo, prompt, role, runId, timeoutSec, model, patchPath },
  { repoRoot },
);
```

The contract mirrors the `cursor:` branch and differs in exactly one place — the artefact is a PATCH, not a worktree:

1. **`never_foreign` gate first**, same `NEVER_FOREIGN_ROLES` lock, refused before any spawn; a refusal is a ledger record, not a silence.
2. **The prompt goes on STDIN**, never into argv.
3. **Verdict = exit 0 AND a non-empty patch.** The adapter's own words: *"`ok` is false unless the child exited 0 AND left a non-empty patch."* A green-sounding remote report with an empty patch is a failure.
4. **The coordinator reads and reviews the patch, then applies it with `git apply`.** The remote never touches this repo — same PSA-007 boundary as the foreign branch, and the same semantic-review bar (test-green is not the bar).
5. **Telemetry:** `orchestrator.remote_dispatch.completed`, emitted on refusals too.
6. **Not part of § Started-Set Verification** — no `meta.json` sidecar, no task notification, exactly as for the `cursor:` branch. Its lifecycle is the adapter's return value.

#### Pre-Dispatch Grounding Injection (#85)

Before dispatching each agent, prepend a line-numbered GROUNDING block to its prompt for any file in the agent's scope that has recent edit-format-friction history. This helps the agent reference edits by line number instead of re-matching exact character spans, reducing Edit-tool retry loops.

**Gate:** `$CONFIG."grounding-injection-max-files" > 0` AND `$CONFIG.persistence == true`. When either condition is false, skip the entire step.

**Per-agent scope** (not per-wave): each agent's file scope comes from its specification in the session plan — the same source used for computing the wave's `allowedPaths` union (see `## Scope Manifest` § 3). An agent with narrow scope gets grounding only for files it will touch.

**Invocation:** for each agent about to be dispatched, call:

    AGENT_FILES="$(printf '%s\n' "${agent_file_scope[@]}")" \
    SESSIONS_JSONL=".orchestrator/metrics/sessions.jsonl" \
    EVENTS_JSONL=".orchestrator/metrics/events.jsonl" \
    MAX_FILES="$(echo "$CONFIG" | jq -r '."grounding-injection-max-files"')" \
    SESSION_ID="<session_id>" WAVE="$wave_num" AGENT_TYPE="<subagent_type>" \
    PERSISTENCE="$(echo "$CONFIG" | jq -r '.persistence')" \
    bash "$PLUGIN_ROOT/scripts/compute-grounding-injection.sh"

Capture stdout as `$GROUNDING_BLOCK`. If empty, dispatch the agent unchanged (legacy behavior).

**Prompt assembly:** when `$GROUNDING_BLOCK` is non-empty, prepend to the agent prompt:

    <GROUNDING_BLOCK>

    Use line numbers above to describe edits precisely instead of re-matching character spans. If a line has changed since this snapshot, re-read the file before editing.

    ---

    <original prompt>

The helper emits one `orchestrator.grounding.injected` event per injected file to `.orchestrator/metrics/events.jsonl` (routed through `scripts/emit-event.mjs` → the canonical `emitEvent()` path). The helper never returns non-zero; any failure (missing jq, missing events.jsonl, unreadable file) results in silent no-op so wave dispatch is never blocked.

**Fallback for agents without explicit file scope:** if the session plan's agent specification does not list a "Files:" scope for an agent, fall back to the wave-level `allowedPaths` (from `wave-scope.json`). If that is also empty, skip injection for that agent.

**Relationship to `### 3c. File-level grounding`:** this pre-dispatch feature is DIFFERENT from the post-wave file-level grounding check. Pre-dispatch grounding injects file content into agent prompts (prevents friction). Post-wave grounding verifies agents stayed within their planned scope (detects scope creep). The two features share no code and run at different times.

#### Pre-Dispatch Untracked-Overlap Check (#180)

Claude Code's Agent tool with `isolation: "worktree"` syncs the agent's worktree back into the coordinator's working tree on completion. If the coordinator holds untracked files inside the agent's scope, the sync silently overwrites them — observed as data loss in the 2026-04-19 deep-drift-check session (4 files, ~700 LoC wiped). See issue #180.

**Apply this check only when dispatching with `isolation: "worktree"`.** For `isolation: "none"` or coordinator-direct execution, skip — there is no merge-back to worry about.

For each worktree-isolated agent about to be dispatched:

```js
import { checkUntrackedOverlap } from '$PLUGIN_ROOT/scripts/lib/pre-dispatch-check.mjs';

const result = checkUntrackedOverlap({
  scope: agentFileScope,        // same array used for `allowedPaths`
  cwd: process.cwd(),
  mode: 'warn',                 // 'warn' (default) | 'block' | 'off'
});

if (result.decision === 'block') {
  // Refuse dispatch. Report result.message to the user.
  // Ask: commit the files, stash them, or rerun with mode=warn to acknowledge.
} else if (result.decision === 'warn') {
  // Print result.message to the wave progress update.
  // Dispatch proceeds, but the coordinator has an audit trail if data loss occurs.
}
```

The helper is stdlib-only and cross-platform. `mode=block` is recommended when the coordinator holds uncommitted work of non-trivial size in the agent's scope — it trades a friction prompt for the guarantee that the merge-back cannot silently overwrite. `mode=warn` keeps the historical behavior and simply records the risk. `mode=off` short-circuits entirely.

This is a downstream backstop: the underlying worktree merge-back strategy lives in the Claude Code harness and is outside this plugin's control. The correct fix (preserve untracked coordinator files during merge-back) must come upstream. Until then, this check is the only defense.

#### Pre-Dispatch Coordinator Snapshot (#196)

Before dispatching agents for this wave, checkpoint any uncommitted coordinator work as a git stash snapshot. This is a backup — it does NOT touch the working tree and does NOT block dispatch on failure.

**Gate:** `$CONFIG.persistence == true`. When `persistence: false`, skip this step entirely.

```js
import { saveSnapshot } from '$PLUGIN_ROOT/scripts/lib/coordinator-snapshot.mjs';

const snap = await saveSnapshot({
  sessionId: '<session_id>',
  waveN: <wave_num>,
  label: 'pre-dispatch',
});

if (!snap.ok) {
  // Non-fatal — log the error in the wave progress update but do not block.
  console.warn(`coordinator-snapshot: snapshot failed (non-fatal): ${snap.error}`);
}
// snap.skipped === true when the working tree is clean; also fine, dispatch continues.
```

The snapshot is stored under `refs/so-snapshots/<sessionId>/wave-<N>-pre-dispatch`. It survives Claude process termination (unlike memory-only state) and is cleaned up by session-end on clean close (see session-end/SKILL.md). Orphaned snapshots from crashed sessions are reclaimed by `gcSnapshots({olderThanDays: 14})`.

See issue #196 for the full rationale. This is complementary to the untracked-overlap check above (#180 is scope-level detection; this is working-tree-level backup).

#### Pre-Dispatch: Frontmatter-Guard Injection (#328)

Before constructing each agent's prompt, decide if the schema snippet must be injected:

1. Compute task vault-scope: `import { detectVaultTaskScope } from 'scripts/lib/frontmatter-guard.mjs'`. Pass the agent's task description + file scope (paths the agent is allowed to write).
2. **If vault-scoped (returns `true`):**
   a. Call `readVaultSchema()` from the same module.
   b. If the schema read returned non-null, call `generateFrontmatterSnippet(schema)` to get a Markdown block.
   c. Prepend the block to the agent's prompt under a clear separator:

      ```
      <FRONTMATTER-GUARD>
      <generated snippet>
      </FRONTMATTER-GUARD>

      <original prompt>
      ```
   d. If `readVaultSchema()` returned `null` (schema source absent), emit stderr WARN `Frontmatter-guard: schema source missing at <path> — agent prompts will not include schema enums`. Continue dispatch without injection (do NOT block).
3. **If not vault-scoped:** dispatch as today, no injection.

Performance note: `readVaultSchema()` caches by file mtime, so repeated calls within a wave are free. The schema read happens at most once per wave-executor run.

Behaviour change: agents writing vault notes now receive the canonical schema enums + per-type examples directly in their prompt context. This eliminates the agent-guessing failure class documented in #328.

#### Pre-Dispatch: Glob-Scoped Rule Injection (#336/#694)

After `wave-scope.json` is written for this wave and before assembling the `Agent()` prompt, inject the wave's applicable rule set into each dispatched agent's prompt. This wires the `loadApplicableRules()` loader (`scripts/lib/rule-loader.mjs`) — dormant since #336 — into the live per-wave prompt assembly via the thin CLI `scripts/print-applicable-rules.mjs`.

> **⚠ Measure before you inject — on Claude Code this step is usually a NET LOSS (#931b).** `docs/instruction-delivery.md` measured the delivery path on 2026-07-30: every `.claude/rules/*.md` already reaches a dispatched agent through Claude Code's **native project-instruction loading**, so a `$RULES_BLOCK` prepended on top arrives a *second* time. Measured on a real wave: the scoped block was 122,875 B against a 169,961 B corpus — glob scoping saved **4.0%**, of which 85.5% came from the tier axis alone, while injecting alongside undiminished native delivery cost **+72%** (292,836 B). The coordinator SHOULD therefore check the block's size before prepending it, and MAY skip the injection with a logged Deviation when the harness already delivers the corpus natively — that is not a shortcut, it is the measured decision. Inject unconditionally only on a harness that does NOT auto-load `.claude/rules/` (Codex CLI, Pi, Cursor), where this block is the sole delivery path and the saving is real. See `docs/instruction-delivery.md` §1.2 and §5.

**Gate:** runs when `.claude/rules/` exists. When it does not, the CLI prints nothing and exits 0 — zero behaviour change. This step never blocks dispatch: any non-zero exit or empty output means "inject nothing, continue" (same best-effort framing as Pre-Dispatch Grounding Injection above).

**Per-wave scoping (not per-agent):** the rule set is computed ONCE per wave from the wave's `allowedPaths` union (the same `wave-scope.json` source used elsewhere), not per agent. The CLI resolves `scopePaths` from `allowedPaths`, `mode` from the `session-type:` frontmatter in the active harness's `STATE.md`, and `hostClass` from `.orchestrator/host.json` — all overridable, all degrading to "no gating" when unreadable. Default state and scope paths resolve independently: state-directory override first, then active-harness and legacy fallback.

**Invocation:** once per wave, run from the repo root and capture stdout as `$RULES_BLOCK`:

    RULES_BLOCK="$(node "$PLUGIN_ROOT/scripts/print-applicable-rules.mjs" --context wave 2>/dev/null)"

`--context wave` (issue #692) excludes `tier: coordinator-only` rules (owner-persona, lsp, mvp-scope, loop-and-monitor) from the wave-agent prompt — those are operator/coordinator-context rules a wave implementation agent does not need. `tier: always` and `tier: wave-only` rules are unaffected; omitting the flag (or passing `--context coordinator`) disables wave-tier exclusion. Use `--wave-scope <path>` only if `wave-scope.json` is not at the default `.claude/wave-scope.json`. The CLI returns:
- a Markdown block (header `## Applicable Rules (scoped to this wave)`, a preamble naming the block's fence token, then each matching rule's raw content wrapped in `<rule-<token> index="i/N" src="<repo-relative path>">` … `</rule-<token>>`) when one or more rules apply, OR
- empty output (exit 0) when no rules match — in which case prepend nothing.

**Prompt assembly:** when `$RULES_BLOCK` is non-empty, prepend it to EACH agent's prompt in this wave under a clear separator:

    <APPLICABLE-RULES>
    $RULES_BLOCK
    </APPLICABLE-RULES>

    <original prompt>

When `$RULES_BLOCK` is empty (no `.claude/rules/`, no matching rules, or any CLI failure), dispatch the agent unchanged. Because the block is computed once per wave, the same `$RULES_BLOCK` is reused for every agent dispatched in this wave — narrow waves (e.g. only `scripts/**` or only `tests/**` files) receive a smaller rule set, which is the #336 token-reduction payoff.

This replaces the older prose slot "Relevant patterns from `<state-dir>/rules/`" in the `Agent()` template above: the `<APPLICABLE-RULES>` block IS that injection, now mechanically scoped to the wave instead of left to the coordinator's judgement.

#### Pre-Dispatch: Learnings-Index Injection (#1014)

> **Read this first — it is computed PER AGENT, unlike the block directly above.** The rule injection you just read states "Per-wave scoping (not per-agent): the rule set is computed ONCE per wave". This step is the opposite: **run the CLI once for EACH agent**, because per-agent differentiation IS the acceptance criterion — an agent scoped to `scripts/lib/learnings/**` must receive different entries than its sibling scoped to `skills/**`. Model it on **Pre-Dispatch Grounding Injection (#85)** above, not on its immediate neighbour. Computing it once and reusing it across the wave silently reduces this feature to a worse version of the coordinator banner that already exists.

89 learnings have accumulated across 233 sessions, and a dispatched wave agent receives **zero** of them: the only read paths are a coordinator banner, an autopilot call, and a nudge banner — none reaches an agent prompt. This step closes that loop by prepending a compact, relevance-ranked INDEX of learnings to each agent's prompt.

**Why this does not repeat the #931b mistake.** `docs/instruction-delivery.md` measured that adding a SECOND delivery path alongside Claude Code's native project-instruction loading costs **+72%** (292,836 B vs 169,961 B) — which is why the rule block above carries a "measure before you inject" warning. That warning does **not** transfer here, and not as a matter of argument: learnings have no native delivery path to duplicate. `learnings.jsonl` lives under `.orchestrator/metrics/`, is not a project-instruction file, is not `@`-imported from CLAUDE.md, and reaches nothing agent-facing today. This is the FIRST path, and it rides the dispatch-prompt channel this repo already owns and writes itself — no new mechanism is introduced. It is also bounded by a code constant (`LEARNINGS_INDEX_MAX_CHARS = 2000`, ~1.1% of the measured 178,095 B per-agent prompt baseline) with no `0 = unlimited` sentinel, so it cannot grow into the corpus it indexes.

**An INDEX, not a corpus.** One line per learning plus a retrieval pointer; an agent that needs a full entry greps it by subject. Measured: 12 entries in this form = 1,469 B.

**Gate:** runs when `.orchestrator/metrics/learnings.jsonl` exists. When it does not — or when nothing clears the confidence floor, or the corpus is unreadable — the CLI prints nothing and exits 0. Same best-effort convention as every injector above (Grounding `:307`, Frontmatter-Guard `:386`, Path-Cousin-Guard `:208`): silent no-op on any failure, **never blocks dispatch**. Any non-zero exit means "inject nothing, continue".

**Zero new coordinator obligations.** The per-agent file scope this needs is the SAME `$AGENT_FILESCOPE_JSON` — `<state-dir>/filescopes/wave-<N>/<agent-id>.json` — that `wave-loop-scope-manifest.md` § Scope Manifest 3.1 already requires you to write for every agent, and that the Scope-Union Assertion (#796) then consumes. Reuse that file — do not write a second one, and never a temp copy.

**Invocation:** once per agent, immediately after that agent's `$AGENT_FILESCOPE_JSON` is written, capture stdout as `$LEARNINGS_INDEX`:

    LEARNINGS_INDEX="$(node "$PLUGIN_ROOT/scripts/print-learnings-index.mjs" \
      --file-scope "$AGENT_FILESCOPE_JSON" \
      --task-text "<the agent's task title / one-line description>" 2>/dev/null)"

`--task-text` is optional and feeds the token axis of the affinity primitive; omitting it yields path-only ranking. **Resolution ladder** (mirrors Grounding Injection `:309`): the agent's own `--file-scope` → the wave-level `allowedPaths` from `.claude/wave-scope.json` (automatic fallback when the agent has no declared "Files:" scope) → empty scope, in which case only the general tier is selected. Caps are `--max-scoped` (default 8) and `--max-global` (default 4) — **split, never shared**, so the general tier can never crowd out the per-agent signal.

**Prompt assembly:** when `$LEARNINGS_INDEX` is non-empty, prepend it to THAT agent's prompt:

    <LEARNINGS-INDEX>
    $LEARNINGS_INDEX
    </LEARNINGS-INDEX>

    <original prompt>

When it is empty (no corpus, no qualifying entries, or any CLI failure), dispatch that agent unchanged — the prompt is then byte-identical to the legacy one.

**Instrumentation (why this one is measurable and its neighbours are not).** The rule injection above is a SHOULD and emits no signal either way, so "did the coordinator actually inject?" has been unanswerable after the fact — a gap the #1014 discovery wave had to leave open. This CLI emits `orchestrator.learnings.index.injected` to `.orchestrator/metrics/events.jsonl` (via `scripts/emit-event.mjs`, the canonical `emitEvent()` path — the same route `scripts/compute-grounding-injection.sh` uses for `orchestrator.grounding.injected`), carrying `count`, `scope_matched`, `global_count`, `candidates`, `truncated`, `bytes`, and `scope_source`. The before/after measurement is therefore a fact in the event log, not a matter of prose compliance. Emission is best-effort and suppressible with `--no-event`; a failed emit never blocks dispatch.

#### Pre-Dispatch: File-Scope Injection (#1020)

> **Read this first — this block is PER AGENT, unlike `#### Pre-Dispatch: Glob-Scoped Rule Injection (#336/#694)` above, which states "Per-wave scoping (not per-agent): the rule set is computed ONCE per wave".** Model it on **Pre-Dispatch Grounding Injection (#85)** — same cadence, same per-agent source. This injector legitimately has BOTH cadences (per-agent for the brief, per-wave for the `wave-loop-scope-manifest.md` § Scope Manifest union), which is exactly what makes the collapse tempting: reuse ONE agent's block for the whole batch and every agent reads the territory of every OTHER agent as its own. Deconfliction would then be **lifted rather than enforced**, and the double assignment `wave-loop-scope-manifest.md` § Scope Manifest 3.2 exists to catch becomes invisible in the one channel where an agent could still notice it.

**Invocation:** for each agent, read `<state-dir>/filescopes/wave-<N>/<agent-id>.json` (= `$AGENT_FILESCOPE_JSON`) — the SAME file written in `wave-loop-scope-manifest.md` § Scope Manifest 3.1, not a re-derivation from the session plan and not a temp copy — and prepend its entries to that agent's prompt, one path per line:

    FILE-SCOPE — exactly these:
    ```
    <one path or glob per line, verbatim from that agent's scope file>
    ```

Marker line plus fenced block, in that order: `hooks/pre-task-scope-disjoint.mjs` extracts the scope from the prompt by finding the marker and taking the FIRST fenced block after it, so this shape is what makes an agent's declared territory machine-readable at dispatch time. An unparseable or absent block resolves to ALLOW there, so a malformed injection degrades to today's behaviour rather than blocking dispatch. When the scope file is missing or empty (Discovery waves), inject nothing and dispatch unchanged.

> **Registration note.** That hook was armed in `hooks/hooks.json` on 2026-08-14, after a green Full Gate. Its `PreToolUse` matcher is **`Agent`** — measured over 12 archived transcripts of this repo, `Agent` accounts for 147 of 147 dispatch `tool_use` blocks. A `Task` matcher would hit the unrelated todo family (`TaskCreate`/`TaskUpdate`/`TaskGet`/…) and never once fire on a dispatch: armed and inert, the failure mode that reads as done. It is deliberately absent from `hooks-codex.json` / `hooks-cursor.json` / `hooks-pi.json` — those platforms have no `Agent` dispatch tool, so the asymmetry is registered in `DOCUMENTED_ASYMMETRIES` rather than papered over with a matcher that can never fire.

#### Structured Reasoning (STATE:/PLAN:) — opt-in via `reasoning-output: true` (#79)

When `$CONFIG.reasoning-output` is `true`, append the following block to every agent prompt. The pattern is adapted from the BitGN PAC Agent's Soft-SGR: short structured transparency lines before tool invocations, without forcing structured output. Leave the block OUT when the flag is `false` (default) — this preserves exact legacy prompt behavior.

```
## Reasoning format

Before every meaningful tool call, emit two single-line markers so the coordinator can trace your thinking:

  STATE: <one-line summary of what you currently know about the task — files read, constraints, blockers>
  PLAN:  <one-line summary of what you are about to do and why>

Rules:
- Keep each line under ~160 characters. Do not nest markdown or code blocks inside these lines.
- Emit them together, STATE first then PLAN, immediately before the tool call they describe.
- Skip them for trivial read-back tool calls (e.g., re-reading a file you just wrote). Do not spam them.
- These markers DO NOT replace your normal text output — they supplement it. Continue writing normal progress updates.
```

**Resolution chain** (if the plan does not specify `subagent_type` for an agent):

1. **Discovery waves** → `"Explore"` (always, read-only)
2. **Quality review** → `"session-orchestrator:session-reviewer"` (always)
3. **Impl-Core / Impl-Polish / Quality (test-writing)** → check in order:
   a. Project agent matching the task domain (e.g., `"database-architect"` for DB tasks)
   b. Plugin agent (e.g., `"session-orchestrator:code-implementer"`)
   c. `"general-purpose"` (final fallback)

   > **Docs-role dispatch (A3):** `docs-writer` is the canonical first-class agent for Docs-role tasks (audience-split documentation generation per `skills/docs-orchestrator/SKILL.md`). It flows through step 3a naturally: when the session plan specifies `subagent_type: "docs-writer"` (project-level) or `subagent_type: "session-orchestrator:docs-writer"` (plugin-level), the resolution chain matches at step 3a without a separate branch. Cross-reference: `agents/docs-writer.md` (agent definition), `skills/docs-orchestrator/SKILL.md` (execution protocol and hook points). No new resolution branch is required — 3a handles it.

4. **Finalization** → direct execution (no subagent needed)

> **How to detect project agents:** The session plan's "Agent Registry" section lists all discovered agents. If an agent name does NOT contain a colon (`:`), it's a project-level agent. If it contains `session-orchestrator:`, it's a plugin agent. If it contains `cursor:` (e.g. `cursor:composer-2.5`), it is a **foreign-channel dispatch**, not an Agent-tool dispatch at all — see § Third branch: foreign-model dispatch. Any other prefix is rejected at parse time by `scripts/lib/config.mjs` (known channels: `cursor`, `session-orchestrator`), so an unroutable value never reaches this chain.

**`run_in_background: true` is the platform default since Claude Code 2.1.232 — see § 1. Dispatch Agents for the caps.** Measured 2026-08-22 (v2.1.239): under blocking dispatch the coordinator was 143 s incapable of acting between an agent's mid-run escalation and its own next turn — escalation latency equals the batch's remaining runtime. Background dispatch returns turns to the coordinator between agent completions; a running agent received a queued message mid-run and answered ~9 min before its final report. Still dispatch in small batches of 3–4 Agent() calls per message (never a large single-message fan-out — see § Dispatch Agents; large fan-outs drop calls silently, conf 1.0), then run **Started-Set Verification** — an agent counts as started on its `meta.json` sidecar and as completed on its task-notification, never on the launch ack.

#### Platform-Specific Dispatch

**Claude Code:** Use the `Agent` tool as shown above. Agent types follow the resolution chain above.

**Codex CLI:** Codex uses typed agent roles defined in `.codex-plugin/agents/`. Map wave roles to Codex agents:
- **Discovery** waves → `explorer` agent (read-only)
- **Impl-Core / Impl-Polish** waves → `wave-worker` agent (workspace-write), or project-specific agents if defined in the platform's agents directory (`.claude/agents/`, `.codex/agents/`, or `.cursor/agents/`)
- **Quality** review → `session-reviewer` agent (read-only)
- **Finalization** → direct execution (no subagent needed)

Dispatch via Codex's multi-agent system — describe the task and specify the agent role. The prompts remain identical across platforms.

**Cursor IDE:** No Agent() tool available. Execute wave tasks sequentially within the current Composer session:
1. For each task in the wave, implement it fully (you are both coordinator AND implementer)
2. After completing each task, report status inline
3. Run incremental quality checks after all tasks in the wave complete
4. Proceed to the next wave

The `agents-per-wave` config is ignored on Cursor — all work is sequential. Session-reviewer dispatch is deferred to session-end (Phase 1.8).

> **Timeout note:** Agent timeout is controlled by `maxTurns` from `circuit-breaker.md`, not by a time-based timeout. Claude Code's built-in turn limit provides the safety net. There is no need to set explicit time-based timeouts on agent dispatch.
>
> **Foreign-dispatch exception (#1150):** this is FALSE for a `cursor:<model>` dispatch. `cursor-agent` has no `maxTurns` and no turn limit of any kind, so a wall-clock SIGTERM is the **only** circuit breaker there — `timeoutSec` (default `DEFAULT_TIMEOUT_SEC = 900`, defined in `scripts/lib/wave-executor/dispatch-common.mjs`, a measured floor, not a suggestion: `cursor-grok-4.6-high` ran 2 of 3 hard-test tasks past a 540 s cap). Lowering it manufactures timeouts that read as model failure. See § Third branch: foreign-model dispatch.
