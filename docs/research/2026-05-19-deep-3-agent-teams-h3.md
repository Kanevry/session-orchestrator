# Agent Teams H3 Hook-Seam Test — Empirical Research Note

> Status: **PENDING-EMPIRICAL** · session main-2026-05-19-deep-3 · issue #484
> ADR reference: `docs/adr/0002-agent-teams-substrate.md`
> Test harness: `hooks/agent-teams-h3-test.sh`
> Results log: `.orchestrator/research/h3-hook-seam-test-template.jsonl`

---

## Background

### ADR 0002 Adapter Verdict

ADR 0002 (`docs/adr/0002-agent-teams-substrate.md`, issue #437, session deep-2 2026-05-19) resolved the question "Should the `wave-executor` waves abstraction migrate onto Agent Teams primitives?" with verdict **Adapter** — not Adopt, not Stay.

The rationale in brief: Agent Teams supplies exactly **one** capability the plugin lacks (peer-to-peer teammate messaging via the `SendMessage` mailbox) and is missing **eleven** load-bearing capabilities the plugin has (all 10 kill-switches, the spiral/stagnation taxonomy, the inter-wave quality-gate ladder, STATE.md resumable ownership, the automated file-scope deconfliction algorithm, the session lock). Adopting Agent Teams as the wave substrate would forfeit the entire autonomy-safety surface to gain one feature from an explicitly experimental, disabled-by-default primitive.

**Adopt is refuted on evidence. Stay is rejected as premature.** Adapter is the falsifiable middle: keep `wave-executor` as orchestration brain; add a thin, flag-gated Agent Teams backend scoped narrowly to the waves where the messaging benefit is concentrated (parallel review and competing-hypothesis debug, per the official docs' own "when to use" guidance).

### H3 as the Hard Precondition

The Adapter verdict is conditioned on a single falsifiable empirical test, designated **H3** in ADR 0002:

> "If a `TaskCompleted` exit-2 hook cannot reliably enforce a quality gate without the coordinator across 3 repeat runs, the spike is closed won't-do and this ADR collapses to Stay with the gap matrix as the standing public rationale."

H3 is the hard precondition because the entire value proposition of the Adapter lane rests on using the three team hook seams (`TeammateIdle`, `TaskCreated`, `TaskCompleted`) to carry the quality-gate ladder. If the `TaskCompleted` seam is unreliable — if the documented "lagging task status" limitation means a teammate can observe the hook's exit-2 feedback but still race to mark the task complete — then the gate cannot be trusted, and the Adapter collapses.

The specific failure mode to test: the official docs note verbatim that "Task status can lag — teammates sometimes fail to mark tasks complete, silently blocking dependents." H3 tests the inverse: that a deliberate exit-2 from the hook **reliably** blocks a task that should complete, rather than being lost to a lagging-status race.

### ADR-364 Telemetry Precedent

`docs/adr/2026-05-10-364-remote-agent-substrate.md` (evaluating Symphony / VibeTunnel as an external substrate) established the graduated-adoption discipline that all subsequent substrate ADRs inherit: ship behind a flag, prove on telemetry, promote to default-eligible only after N≥3 quiet deep sessions. The Agent Teams Adapter inherits this discipline verbatim — the spike must remain default-off and behind a Session Config key until the telemetry-promotion criteria are met (see § Spike Scope IF H3 Passes below).

---

## Preconditions Verified at W1 D2

The following preconditions were verified empirically during session 2026-05-19-deep-2, Wave 1, Discovery probes D2 and D6:

**Binary version.** `claude --version` returned `2.1.144 (Claude Code)`. This is well above the ≥ v2.1.32 minimum stated in the official Agent Teams documentation. The version gate is met.

**Experimental flag in binary.** `strings "$(command -v claude)" | grep -i 'EXPERIMENTAL_AGENT\|agentTeam\|agent_team'` returned multiple hits including `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (appearing twice), `waitForTeammatesToBecomeIdle`, `runWithTeammateContext`, `isTeammate`, `isTeamLead`, `createTeammatePaneInSwarmView`. The full teammate machinery is compiled into the binary. The feature is present but disabled by default; enabling via `export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is the documented activation path.

**No prior team runs on this host.** `~/.claude/teams/` did not exist at D2 verification time. This confirms the H3 test runs on a clean slate — no residual team state that could interfere with the hook-seam test.

**TypeScript project present.** `npm run typecheck` is defined in the project's `package.json` and runs `tsgo --noEmit` per `.claude/rules/development.md` (TS-001). The command can be used as the TaskCompleted hook's gate action.

---

## Empirical Hypothesis

> **H3:** A `TaskCompleted` hook running `npm run typecheck` with exit code 2 on failure will reliably block teammate task-completion and deliver the typecheck error message as feedback to the teammate, across 3 repeat runs, demonstrating that the lagging-task-status race described in the Agent Teams documentation does not prevent the hook seam from carrying a quality gate.

**Success definition (H3 PASS):** All 3 runs show:
- `hook_exit_code = 2` when the task includes a deliberate TypeScript error
- `blocked = true` (task remains in non-completed state after the hook fires)
- `feedback_delivered = true` (teammate receives the typecheck error output as actionable feedback)
- `teammate_retried = true` (teammate reads feedback, corrects the error, and retries successfully)

**Failure definition (H3 FAIL):** Any of the 3 runs shows `blocked = false` or `feedback_delivered = false`. A single failure invalidates the seam as a quality-gate carrier — the gate must be deterministic to be trustworthy.

---

## Test Plan

### Overview

The test uses a minimal, controlled setup: one team lead, one teammate (`impl-agent`), one task containing a deliberate TypeScript error, one TaskCompleted hook running `npm run typecheck`. The hook is expected to exit 2 (typecheck fails), blocking the task and delivering the compiler error to the teammate. The teammate corrects the error, retries, the hook exits 0, and the task completes.

This is run 3 times independently. Each run starts with the same TypeScript error in place. Results are logged to `.orchestrator/research/h3-hook-seam-test-template.jsonl`.

### Pre-run Setup (Once)

Run `hooks/agent-teams-h3-test.sh` to verify preconditions and scaffold the team directory:

```bash
bash hooks/agent-teams-h3-test.sh
```

If exit 0: scaffold is at `~/.claude/teams/h3-test-deep3/` and the log template is at `.orchestrator/research/h3-hook-seam-test-template.jsonl`. Proceed to per-run steps.

If exit 1: preconditions not met — review output and resolve (typically: upgrade claude-code or confirm PATH).

If exit 2: scaffold creation failed — check permissions on `~/.claude/`.

Create the deliberate TypeScript error file:

```bash
mkdir -p src/scratch
echo 'const x: number = "not-a-number";' > src/scratch/h3-test.ts
```

Confirm the error is present:

```bash
npm run typecheck 2>&1 | grep -i 'h3-test\|error'
# Expected: error TS2322 or similar on src/scratch/h3-test.ts
```

### Per-Run Procedure (Repeat 3 Times)

**Step 1: Set the Agent Teams flag.**

```bash
export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
```

Confirm the env-var is set:

```bash
echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS   # should print: 1
```

**Step 2: Launch Claude Code and configure the team.**

Start an interactive Claude Code session (`claude`). Use the in-session team UI (Shift+Down navigation or `/team` command) to:
- Set team name: `h3-test-deep3`
- Spawn 1 teammate named `impl-agent`
- Attach the TaskCompleted hook: command = `npm run typecheck` (exit 2 blocks)

Reference config: `~/.claude/teams/h3-test-deep3/hooks.json` (created by the harness script).

**Step 3: Assign the test task to the teammate.**

From the team lead, assign `impl-agent` a task:

> "Implement `src/scratch/h3-test.ts` — it currently has a TypeScript error. The task is complete when `npm run typecheck` passes with zero errors. Fix the type error and mark the task done."

**Step 4: Observe hook behavior on the teammate's first TaskCompleted signal.**

Watch the task list and teammate output for:
- Hook fires and runs `npm run typecheck`
- Hook exits 2 (typecheck failure on the deliberate error)
- Task status: does it show `blocked` or does it race to `completed`?
- Feedback: does the teammate's context include the compiler error message?

Record observed values in the JSONL log.

**Step 5: Observe teammate correction and retry.**

After the block + feedback:
- Does `impl-agent` read the typecheck output and identify the type error?
- Does it correct `src/scratch/h3-test.ts` (fix the `string` assigned to `number`)?
- Does it mark the task done again?
- Does the hook fire again and exit 0 this time?
- Does the task reach `completed` status?

Record in the JSONL log.

**Step 6: Reset for next run.**

```bash
echo 'const x: number = "not-a-number";' > src/scratch/h3-test.ts
```

End or reset the Claude Code session (do not resume the same team for the next run — start fresh to test for session-state independence).

### Post-Run Cleanup

After all 3 runs:

```bash
rm -f src/scratch/h3-test.ts
# Optional: remove scratch dir if empty
rmdir src/scratch 2>/dev/null || true
# Leave ~/.claude/teams/h3-test-deep3/ in place for H4 config-overwrite test
```

---

## Promotion Criteria (from ADR 0002)

The gate is binary. From ADR 0002 § Follow-ups:

**H3 PASS:** All 3 runs show consistent block (`blocked=true`) + feedback delivery (`feedback_delivered=true`). The lagging-task-status race does not prevent the exit-2 seam from carrying a quality gate.

**Consequence of PASS:** The Agent Teams backend spike proceeds (#484 impl). A default-off Session Config key (`agent-teams: { enabled: false }`) is added. Wave types `parallel-review` and `competing-hypothesis-debug` are wired to spawn teammates instead of subagents when the flag is enabled. ADR-364 graduated-adoption gate applies: telemetry collection begins, promotion to default-eligible requires N≥3 quiet deep sessions with positive signal.

**H3 FAIL:** Any run shows `blocked=false` OR `feedback_delivered=false`.

**Consequence of FAIL:** The spike (#484 impl) is closed won't-do. ADR 0002 collapses to Stay. The gap matrix (`docs/research/2026-05-19-agent-teams-evaluation.md` § Feature Parity) becomes the standing public rationale against Agent Teams as a wave substrate. No further Agent Teams integration work is planned unless the official limitation is resolved in a future claude-code release. The ADR status changes from ACCEPTED (Adapter) to ACCEPTED (Stay) with a dated amendment.

---

## H4 Follow-up: Config-Overwrite Verification

H4 is a separate, independent test that may run in parallel with or after H3. It is NOT a gating precondition for H3.

**H4 hypothesis:** The `~/.claude/teams/{team-name}/config.json` file is machine-owned and overwritten on the next teammate state update, making it structurally incompatible with STATE.md (which is branch-scoped, human-auditable, and resumable).

**H4 procedure:**
1. Start a team session (can reuse the H3 team).
2. Once the team is running, hand-edit `~/.claude/teams/h3-test-deep3/config.json` to insert a sentinel key (`"_h4_sentinel": "test"`).
3. Trigger a teammate state update (e.g., have the teammate complete or start a task).
4. Check whether `config.json` still contains `_h4_sentinel`.

**Expected result (confirming ADR 0002 structural-incompatibility claim):** `_h4_sentinel` is absent after the state update — config.json was overwritten.

Document H4 results in a separate research note or append to this file as an addendum.

---

## Spike Scope IF H3 Passes

The Agent Teams backend spike is explicitly bounded. From ADR 0002 § Consequences and § Follow-ups:

**What the spike adds:**
- A new Session Config key (default `false`, per `docs/session-config-template.md` key-parity enforcement): `agent-teams: { enabled: false, waves: [parallel-review, competing-hypothesis-debug] }`
- When `agent-teams.enabled: true`, wave-executor spawns teammates instead of subagents for the named wave types
- Teammate mailbox messaging (`SendMessage`) is available within those waves
- All other wave types (Impl-Core, Impl-Polish, dependency-ordered waves) continue to use the existing subagent dispatch path

**What the spike does NOT change:**
- All 10 kill-switches remain wired to the `runLoop` coordinator path
- STATE.md single-writer ownership is unchanged (teammates do not write STATE.md)
- File-scope deconfliction Step 3.5 runs before any teammate spawn (the pre-spawn task-partitioner becomes more essential, not less, when teammates are active)
- The spiral/stagnation taxonomy and MaxTurns circuit-breaker remain coordinator-side logic
- The session lock remains per-repo (Agent Teams' one-team-per-session is per-process, not per-repo)
- MODE-SELECTOR output continues to drive the pre-team plan with persisted rationale

**ADR-364 graduated-adoption gate (mirroring the precedent):**
- The flag ships default-off
- Telemetry collection: token delta vs subagent baseline, messaging-benefit signal on review-wave quality, hook-gate reliability rate
- Promotion from spike to default-eligible requires N≥3 quiet deep sessions with positive signal on all three metrics
- No default flip without that empirical evidence plus telemetry

**Composition constraint (from ADR 0003 / Routines interaction):** An Agent-Teams-backed review wave may run inside a single Routine fire, but must remain one bounded session. It must not iterate into a cloud loop. The two Adapter lanes (Agent Teams and Routines) are orthogonal off the same `wave-executor`/`runLoop` core, never stacked into a multi-iteration loop.

---

## Results

### Run 1

| Field | Value |
|---|---|
| timestamp | TBD |
| hook_exit_code | TBD |
| task_status | TBD |
| blocked | TBD |
| feedback_delivered | TBD |
| teammate_retried | TBD |
| notes | PENDING — fill after manual execution |

### Run 2

| Field | Value |
|---|---|
| timestamp | TBD |
| hook_exit_code | TBD |
| task_status | TBD |
| blocked | TBD |
| feedback_delivered | TBD |
| teammate_retried | TBD |
| notes | PENDING — fill after manual execution |

### Run 3

| Field | Value |
|---|---|
| timestamp | TBD |
| hook_exit_code | TBD |
| task_status | TBD |
| blocked | TBD |
| feedback_delivered | TBD |
| teammate_retried | TBD |
| notes | PENDING — fill after manual execution |

---

## Status

**PENDING-EMPIRICAL**

All 3 runs pending manual execution. Update this section and the Results tables above after completing the 3-run procedure. Set status to one of:

- `PASS` — 3/3 runs with `blocked=true` and `feedback_delivered=true` → spike proceeds
- `FAIL` — any run with `blocked=false` or `feedback_delivered=false` → spike closed, ADR collapses to Stay

After updating status, file a comment on issue #484 with the verdict and a link to the completed JSONL log at `.orchestrator/research/h3-hook-seam-test-template.jsonl`.

---

## H4 — `config.json` Overwrite Verification

### Background

ADR 0002 (`docs/adr/0002-agent-teams-substrate.md`) advances a structural-incompatibility claim against using `~/.claude/teams/{team-name}/config.json` as a STATE.md substitute: the file is **machine-owned**, **hand-edit-forbidden per Anthropic docs**, and **overwritten on the next teammate state update**. This claim is one of the load-bearing reasons the ADR rejects Adopt and lands on Adapter — STATE.md's auditable, branch-scoped, human-resumable contract cannot live inside a machine-overwritten file.

H4 is the empirical verification of that overwrite behaviour. It is a tighter, instrumented version of the brief "H4 Follow-up" sketch at lines 185-199 above, with explicit baseline-checksum capture, sentinel-marker payload, and a deterministic verdict matrix. Per ADR 0002 (Adapter verdict, line 69 referencing the default-off `agent-teams:` Session Config key), H4 must run alongside H3 before any Session Config wiring ships.

H4 does NOT gate H3. The two are independent hypotheses. However, the **combined** outcome (H3 PASS + H4 CONFIRMED) is what unlocks the W3+ spike-design follow-up. Either hypothesis returning a non-PASS verdict collapses the Adapter design surface.

### Test Procedure

**Prerequisite:** H3 setup is live. The team `h3-test-deep3` exists at `~/.claude/teams/h3-test-deep3/` (created by `hooks/agent-teams-h3-test.sh` during H3's pre-run setup). H4 reuses this team — do NOT delete `~/.claude/teams/h3-test-deep3/` between H3 runs and H4.

**Step 1: Capture baseline.**

```bash
cp ~/.claude/teams/h3-test-deep3/config.json ~/.claude/teams/h3-test-deep3/config.json.before
md5 ~/.claude/teams/h3-test-deep3/config.json.before
# Record the printed MD5 hash as: baseline_md5
```

**Step 2: Manual hand-edit.**

Open `~/.claude/teams/h3-test-deep3/config.json` in a text editor and insert a non-critical sentinel key at the top level of the JSON object:

```json
{
  ...existing keys...,
  "h4_test_marker": "manual-edit-2026-05-19"
}
```

Save the file. Confirm the marker is present:

```bash
grep h4_test_marker ~/.claude/teams/h3-test-deep3/config.json
# Expected: "h4_test_marker": "manual-edit-2026-05-19"
```

**Step 3: Trigger a state update.**

With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` still exported from H3, launch claude-code and:
- Open the `h3-test-deep3` team (in-session UI or `/team` command)
- Assign the teammate (`impl-agent`) any tool-invoking task that produces a state change. The simplest reliable trigger: assign a one-line task ("List the files in `src/scratch/`") and observe the teammate's task-start → task-complete cycle. Both transitions should cause the team state to be persisted.

**Step 4: Observe.**

```bash
md5 ~/.claude/teams/h3-test-deep3/config.json
# Record as: post_md5

grep h4_test_marker ~/.claude/teams/h3-test-deep3/config.json && echo MARKER_PRESENT || echo MARKER_ABSENT
```

**Step 5: Capture result.**

Compare `baseline_md5` to `post_md5` and check the marker grep:

- If `post_md5 != baseline_md5` AND `MARKER_ABSENT` → ADR claim **CONFIRMED** (config.json was overwritten, sentinel destroyed)
- If `post_md5 == baseline_md5` OR `MARKER_PRESENT` → ADR claim **REFUTED** (or partially refuted — see Verdict Criteria)

**Step 6: Log to JSONL.**

Append one line to `.orchestrator/research/h3-hook-seam-test-template.jsonl` (the same log file used by H3, so both hypotheses share a single artifact for issue #484):

```json
{"timestamp":"<ISO-8601 UTC>","hypothesis":"H4","baseline_md5":"<hash>","post_md5":"<hash>","marker_survived":true|false,"verdict":"confirmed|refuted|inconclusive","evidence":"<short notes — what state-update was triggered, any anomalies>"}
```

### Verdict Criteria

The verdict matrix is deterministic on two observations: checksum delta and marker survival.

| `post_md5` vs `baseline_md5` | Marker | Verdict | Outcome |
|---|---|---|---|
| Changed | Absent | **CONFIRMED** | ADR 0002 structural-incompat claim stands. Adapter verdict is final. Combined with H3 PASS, spike-design (W3+ follow-up issue) proceeds. |
| Unchanged | Present | **REFUTED** | ADR claim broken — file is more stable than the docs assert. Re-examine the structural-incompat claim; potentially re-opens Adopt vs Adapter question. Spike-design held pending ADR amendment. |
| Unchanged | Absent | **REFUTED** | Logically impossible if the only edit was the marker insertion. If observed, indicates the manual edit never persisted to disk — re-run Step 2 with a deliberate `cat` verification before triggering. |
| Changed | Present | **INCONCLUSIVE** | Partial overwrite (or marker landed in a preserved region of the config). Insufficient to confirm or refute. More empirical work needed: vary the marker location, retry with different state-update triggers, before re-opening ADR 0002. |

A CONFIRMED verdict requires both signals to agree. Anything else is a non-confirmation and blocks the spike-design follow-up.

### Status

**PENDING-EMPIRICAL** — H4 has not yet been run by an operator. H4 depends on H3 setup being live so the two can be run back-to-back without recreating the team scaffold.

**Operator action:** After H3's manual 3-run completes (and BEFORE the post-run cleanup at lines 158-167 deletes `~/.claude/teams/h3-test-deep3/`), immediately run H4 (1 additional run, ~5 minutes). Then proceed with cleanup.

**Aggregate outcome gate:** `H3 PASS + H4 CONFIRMED` → spike-design proceeds (a follow-up issue will be filed for W3+ to wire the default-off `agent-teams:` Session Config key and the `parallel-review` / `competing-hypothesis-debug` wave routing). Any other combination → ADR 0002 stands as Adapter on paper, but no Session Config wiring ships this quarter and no further integration work is planned.

### CLAUDE.md Session Config Note

> **Note:** The default-off `agent-teams:` Session Config key proposed in ADR 0002 (line 69, referencing `docs/session-config-template.md` key-parity enforcement) is **INTENTIONALLY NOT WIRED** in this deep-3 session. Wiring depends on `H3 PASS` empirical evidence, which is still `PENDING-EMPIRICAL`. The key will be added in a follow-up session if H3 (and H4) confirm the ADR claims. This deferral is consistent with the ADR-364 graduated-adoption discipline (`docs/adr/2026-05-10-364-remote-agent-substrate.md`): no flag ships without empirical evidence of the precondition.

