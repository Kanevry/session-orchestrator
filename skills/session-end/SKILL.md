---
name: session-end
user-invocable: false
tags: [orchestration, verification, commits, issues]
model: inherit
model-preference: sonnet
model-preference-codex: gpt-5.4-mini
model-preference-cursor: claude-sonnet-4-6
description: >
  Use this skill when performing a full session close-out: verifies all planned work against the agreed plan, creates issues
  for gaps, runs quality gates, commits cleanly, mirrors to GitHub, and produces a session
  summary. Triggered by /close command.
---

# Session End Skill

> **Platform Note:** State files (STATE.md, wave-scope.json) live in the platform's native directory: `.claude/` (Claude Code), `.codex/` (Codex CLI), `.cursor/` (Cursor IDE), or `.pi/` (Pi). All references to `.claude/` below should use the platform's state directory. Shared metrics live in `.orchestrator/metrics/`. See `skills/_shared/platform-tools.md`.

> **Project-instruction file:** `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../_shared/instruction-file-resolution.md). All references to `CLAUDE.md` in this skill resolve via that precedence rule.

## Phase 0: Bootstrap Gate

Read `skills/_shared/bootstrap-gate.md` and execute the gate check. If the gate is CLOSED, invoke `skills/bootstrap/SKILL.md` and wait for completion before proceeding. If the gate is OPEN, continue to Phase 1.

<HARD-GATE>
Do NOT proceed past Phase 0 if GATE_CLOSED. There is no bypass. Refer to `skills/_shared/bootstrap-gate.md` for the full HARD-GATE constraints.
</HARD-GATE>

## Phase 0.5: Parallel-Aware Preamble

> Skip silently when `persistence: false` in Session Config.

Before Phase 1, run the parallel-aware preamble per `skills/_shared/parallel-aware-preamble.md`. The preamble detects other active sessions in the worktree-family via `findPeers(repoRoot, { mySessionId })`, classifies the caller's mode via `classifyMode(callerMode)` against the exclusivity-matrix, and fires the appropriate AUQ on conflict.

**Outcome handling:**
- `PASS_THROUGH` → continue to Phase 1
- `EXCLUSIVE_BLOCKED` → exit Phase 0 cleanly per the AUQ outcome
- `PROMOTION_OFFER` → user picks Worktree-Promotion (see `parallel-aware-auq.md` outcome-handling — calls `enterWorktree()`), in-place + Deviation, or Abbrechen

For session-end specifically: the preamble is DETECTION-ONLY. The lock-release path in later phases keeps its current behavior — releasing the OWN session's lock requires no matrix consultation.

**Implementation reference:** `skills/_shared/parallel-aware-preamble.md § Implementation`.
**AUQ reference:** `skills/_shared/parallel-aware-auq.md`.

## Phase 0.6: Skill-Invocation Self-Report (#724, C4)

> Emit an L1 skill-invocation record for `session-end` itself. The PreToolUse `Skill`-matcher hook only captures skills dispatched via the `Skill` tool — a **prose-invoked** skill like this one is invisible to it (verified gap: zero `session-end` rows in `skill-invocations.jsonl` despite many closed sessions). This self-report closes that gap so L2/L3 skill-health has a `session-end` selection signal. Best-effort, try/catch-silent — it never blocks the close.

```javascript
try {
  const { appendSkillInvocation, DEFAULT_SKILL_INVOCATIONS_PATH } =
    await import('${PLUGIN_ROOT}/scripts/lib/skill-invocations-schema.mjs');
  const nodePath = await import('node:path');
  await appendSkillInvocation(nodePath.join(process.cwd(), DEFAULT_SKILL_INVOCATIONS_PATH), {
    timestamp: new Date().toISOString(),
    event: 'selected',
    skill: 'session-orchestrator:session-end',
    session_id: sessionId ?? null,   // from session.lock `session_id`, when available
    phase: null,
  });
} catch { /* self-report is advisory — never block the close */ }
```

## Phase 1: Plan Verification

> Always runs, first. Reads back the agreed plan and dispositions every item: 1.1 Done (verify with evidence) + 1.1a File-Level Grounding, 1.2 / 1.3 / 1.4 which COLLECT carryover candidates and file nothing (#769), 1.5 Discovery Scan, 1.6 Safety Review + 1.6.6 "What Not To Retry", then **1.65 Handover Alignment Gate** — the only place `[Carryover]` filing is authorized to originate, fail-open to "everything carries" — followed by 1.7 Metrics Collection, 1.8 Session Review, and 1.9 / 1.10 Mission-Status classification + breakdown. Full procedure: [`plan-verification.md`](plan-verification.md).

## Phase 2: Quality Gate

> Always runs and is BLOCKING — do NOT commit broken code. Runs every check in `verification-checklist.md`, then Phase 2.0a Echo-Stub Detection (GH #42 — a `stubbed: {}` entry from `gate-full.mjs` is a FAILED gate, never a pass), 2.1 Vault Validation, 2.2 CLAUDE.md (or AGENTS.md) Drift Check and 2.3 Vault Staleness Check — each gated by its own Session Config key. Full procedure incl. the per-mode routing matrices: [`references/phase-2-quality-gate.md`](references/phase-2-quality-gate.md).

## Phase 2.5: Custom Phases (#637)

> Opt-in. Skip this phase entirely if `custom-phases` in `$CONFIG` is absent or `[]` (the default).

Repos declare deterministic close/housekeeping phases as a **contract** (not the freeform `special:` convention): each phase runs a `command` with exit-code gating and Final-Report reporting. The block is parsed by `scripts/lib/config/custom-phases.mjs`; each record is `{ name, when, command, mode, review }` (already validated — unsafe records were dropped at parse time).

#### Step 1 — Read + filter by `when`

Read `custom-phases` from `$CONFIG` and the `session-type` from STATE.md frontmatter (`feature | deep | housekeeping | none`):

- If `session-type === 'housekeeping'`: keep phases with `when ∈ {housekeeping, both}`.
- Otherwise (`feature`/`deep`/any other): keep phases with `when ∈ {session-end, both}`.

If no phases remain after filtering, skip to Phase 3.

#### Step 2 — Run each phase in declaration order

For each kept phase:

- `mode === 'off'` ⇒ skip silently (do not run the command).
- Otherwise run `command` via Bash. Capture the **exit code** and the **last ~10 lines of stdout** (these become the report summary — do NOT inline the full output).
- If `review` is set, read that file after the command as the review step and note its path in the report.

#### Step 3 — Route by `mode`

- `mode === 'warn'` (default): record the result (name, exit code, summary) for the Phase 6 Final Report "Custom Phases" line. Never block the close — even on a non-zero exit.
- `mode === 'hard'`:
  - exit code `0` ⇒ continue; record `<name>: pass (mode=hard)`.
  - exit code `≠ 0` ⇒ **BLOCK the close** using the same routing pattern as Phase 2.3 strict-mode. `mode: hard` here is an operator-declared repo contract (the repo deliberately chose `mode: hard`), so the block semantics are preserved — but the AUQ now ALSO offers a warn + carryover escape hatch. Present the phase name + captured summary and offer:
    - On Claude Code: AskUserQuestion with options:
      1. "Fix and retry Phase 2.5" (Recommended) — exit close, let the user investigate.
      2. "Warn + carryover and close" — file a carryover issue (labels `carryover`, `priority::high`) titled `[Carryover] custom-phase '<name>' (mode=hard) exited <code>` capturing the phase name + captured summary for a follow-up session, log the Deviation entry, then continue the close.
      3. "Override and close" — proceed, log a Deviation entry in STATE.md `## Deviations`:
         `- [<ISO timestamp>] Phase 2.5: custom-phase '<name>' (mode=hard) exited <code>, overridden by user.`
         In addition to the Deviation entry, emit an override-ratio event so the override feeds the `override_ratio` metric (#730/H5): `node scripts/emit-event.mjs --type orchestrator.finding.overridden --payload '{"phase":"2.5","kind":"custom-phase-hard","count":N}'`.
      4. "Abort close" — exit close without writing.
    - On Codex CLI / Cursor IDE: same options as a numbered Markdown list.

A `hard`-fail (whether overridden or not) ALWAYS appends its result line to STATE.md `## Deviations`; `warn`-mode results do not.

#### Step 4 — Surface to closing report

Pass each phase result `(name, mode, exitCode, summary, review?)` forward to the Phase 6 Final Report "Custom Phases" line (see Phase 6 below).

## Phase 2.6: Broken-Window Budget (#730/H5)

> Opt-in via `broken-window-budget.enabled` in Session Config (default `false`).
> Skip silently when disabled.

Assemble the in-memory "knowingly-broken shipment" list from THIS session's
already-computed results — no new detection logic, only aggregation:

1. Phase 2.0a stub findings (`result.stubbed`) that shipped anyway under `enforcement: warn`.
2. Phase 2.3 / 2.5 "Override and close" choices (reuse each entry's Deviation-log payload verbatim).
3. Phase 1.8 MED/LOW findings routed to "Unresolved Review Findings" (#617).
4. Wave-level reviewer findings overridden without a fix task (`## Deviations` entries matching `reviewer finding overridden` — written by wave-executor §5/5a).

For EACH item: file a hard-terminated closure issue via `createBrokenWindowIssue()`
from `scripts/lib/spiral-carryover.mjs` — labels `broken-window` + `priority::high`,
due-date = today + `broken-window-budget.due-days` (default 7; `glab` native
`--due-date`, `gh` fallback: `Due: <date>` as first body line — GitHub has no
native due-date field). Idempotent per task-hash — re-running a close never
duplicates issues.

Emit ONE event per filed issue (note: event-name segments use underscores, never hyphens):

```bash
node scripts/emit-event.mjs --type orchestrator.broken_window.filed --payload \
  "$(node -e "process.stdout.write(JSON.stringify({source:'<2.0a|2.3|2.5|1.8|wave-override>', issue:<IID>, due:'<YYYY-MM-DD>'}))")"
```

Non-blocking: a filing failure is a WARN, never blocks the close (same fail-open
discipline as `createSpiralCarryoverIssue`).

## Phase 3: Documentation Updates

> Always runs. Refreshes the session-lock heartbeat at entry (`updateHeartbeat`, #590-3 — skip when `persistence: false`) so a long close-out cannot lapse the 4h TTL, then walks 3.0 Defensive Cleanup → 3.1 SSOT files → 3.2 Docs Verification → 3.2a Session Handover → 3.3 Claude-rules freshness → 3.4/3.4a STATE.md write + coordinator-snapshot cleanup → 3.45 Telemetry Flush → 3.5/3.5a/3.6.x session memory, learning extraction and the mechanical skip-plan tail → 3.7/3.7a/3.7b/3.7c/3.7d metrics write, recommendations, durable commit (#490), vault board → closed, session-eval. Full procedure: [`references/phase-3-documentation-updates.md`](references/phase-3-documentation-updates.md).

## Phase 3.8: Session Lock Release (#330)

> Gate: Only run if `persistence` is `true` in Session Config. Skip silently otherwise.

After STATE.md is finalized with `status: completed` (Phase 3.4) and Recommendations are written (Phase 3.7a), release the distributed session-lock so the next session can acquire it cleanly:

```javascript
import { release } from 'scripts/lib/session-lock.mjs';
// sessionId is the physical raw value established by session-start Phase 1.2
// and stored in .orchestrator/session.lock `session_id`. It is not STATE.md
// `session:` or `semantic_session_id`, both of which are attribution labels.
const rawSessionId = sessionId;
const result = release({ sessionId: rawSessionId, repoRoot: process.cwd() });
// result.ok is always true unless a filesystem error occurred.
// result.deleted === true  → lock file removed successfully.
// result.deleted === false → lock was absent or had a different raw session_id.
```

If `result.deleted === false`, log `info: session-lock not released — already absent or raw session_id mismatch` and continue. An active lock whose raw id differs is ambiguous: do **not** retry release with an equal `semantic_session_id`, STATE.md `session`, or owner proof. Leave that live lock for its TTL/Reaper lifecycle.

If `result.ok === false` (rare filesystem error), log `⚠ session-lock: release failed — <result.reason>` and continue. Do NOT block the close for a lock-release failure — the TTL provides automatic expiry for the next session.

The lock is released here — AFTER all STATE.md writes are complete and BEFORE the commit is staged in Phase 4.1. This ordering ensures a clean handover when the current raw owner releases it: the lock file is absent from the working tree when the commit is assembled, so it is not accidentally staged.

## Phase 4: Commit & Push

### 4.1 Stage Changes
- **Stage files individually**: `git add <file>` — NEVER `git add .` or `git add -A`
- **Always stage these session artifacts** (if modified):
  - `.orchestrator/metrics/sessions.jsonl` (session summary from Phase 3.7)
  - `.orchestrator/metrics/learnings.jsonl` (learnings from Phase 3.6)
  - `.orchestrator/metrics/eval.jsonl` (eval record from Phase 3.7d, if modified — note: in repos where metrics are gitignored this is a no-op)
  - `<state-dir>/STATE.md` (session state, if persistence enabled)
  - Any files created or modified by wave agents
- Review staged changes: `git diff --cached` — verify every change is from THIS session
- If you see changes you did NOT make, ask the user (parallel session awareness)

### 4.2 Commit
Use Conventional Commits format:
```
type(scope): description

- [bullet points of what changed]
- Closes #IID1, #IID2 (if applicable)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
```

For sessions with many changes, prefer ONE commit per logical unit (not one mega-commit).

### 4.3 Push
```bash
git push origin HEAD
```

### 4.4 GitHub Mirror (if configured in Session Config)

Three states, three DISTINGUISHABLE outcomes. The predecessor of this block
(`git remote get-url github 2>/dev/null && git push github HEAD 2>/dev/null || echo "GitHub mirror: not configured"`)
collapsed a **failed push** into `GitHub mirror: not configured` and exited 0 — git's real
error went to `/dev/null`, so a broken mirror was indistinguishable from an unconfigured one
(`.claude/rules/bash-harness-pitfalls.md` — "Silence is not success"). That matters more once
anything is wired to the mirror (e.g. a Vercel Git deploy): a silently-failing push means the
downstream artifact never updates and nobody is told.

Run it verbatim — `tests/skills/session-end/github-mirror-push.test.mjs` extracts the block
between the markers and executes it, so no second copy of this command may exist.

```bash
# --- github-mirror-push:begin ---
# Only attempt if 'mirror: github' is in Session Config.
# State 0: not a git repository at all → loud WARN, exit 1. This state was MISSED
#          in the first version and is the reason it is listed first now: outside
#          a repo, `git remote get-url` fails with "fatal: not a git repository",
#          which is indistinguishable from "no such remote" by exit code alone.
#          The block then announced "no 'github' remote configured — skipping
#          (not an error)" and exited 0 — fail-open, in the very fix written to
#          close a fail-open. Found by an adversarial reviewer, not by the author.
# State 1: no 'github' remote      → informational, exit 0 (legitimate for consumer repos)
# State 2: push succeeded          → confirmation WITH the pushed SHA, exit 0
# State 3: push FAILED             → loud WARN on stderr WITH git's real output, exit 1
if ! git_dir=$(git rev-parse --git-dir 2>&1); then
  echo "WARN GitHub mirror: not a git repository — cannot mirror anything." >&2
  echo "  git said: ${git_dir}" >&2
  exit 1
elif ! mirror_url=$(git remote get-url github 2>&1); then
  echo "GitHub mirror: no 'github' remote configured — skipping (not an error)."
  echo "  git said: ${mirror_url}" >&2
elif push_out=$(git push github HEAD 2>&1); then
  echo "GitHub mirror: pushed $(git rev-parse HEAD) -> ${mirror_url}"
else
  echo "WARN GitHub mirror PUSH FAILED: $(git rev-parse HEAD) is NOT on ${mirror_url}" >&2
  echo "${push_out}" >&2
  echo "WARN Mirror is stale — anything wired to it (site deploy) will not update." >&2
  exit 1
fi
# --- github-mirror-push:end ---
```

State 3 exits non-zero on purpose: it is the only machine-readable signal that the mirror is
behind. Report it to the operator in the session summary; do not retry silently and do not
swallow it with `|| true`.

## Phase 4a: Auto-Promoted Worktree Cleanup (#575 P3.2)

> Skip when `persistence: false`; skip silently unless the CURRENT worktree is an auto-promoted sibling — `detectAutoPromotedWorktree()` from `scripts/lib/session-end/worktree-cleanup.mjs` (marker `.orchestrator/promoted-from.json` first, legacy basename match as fallback, #1069). Runs AFTER the Phase 4 commit+push, never before (#490 durableCommit ordering). Clean worktree → auto-remove with WARN; dirty → the 3-option AUQ (`Behalten` / `Löschen` / `Manuell`) before any destructive action, per PSA-003. Full procedure: [`references/phase-4a-worktree-cleanup.md`](references/phase-4a-worktree-cleanup.md).

## Phase 4b: Worktree-Orphan Sweep (#831/B5)

> Skip when `persistence: false`; skip silently unless `worktree-orphans.enabled: true` (opt-in, default `false`). Runs AFTER the Phase 4 commit+push (same #490 invariant as 4a). `checkWorktreeOrphans()` from `scripts/lib/session-end/worktree-orphan-sweep.mjs` PROPOSES with a read-only argv set; the coordinator DISPOSES via the AUQ it renders itself. Full procedure: [`references/phase-4b-worktree-orphan-sweep.md`](references/phase-4b-worktree-orphan-sweep.md).

## Phase 5: Issue Cleanup

> Always runs. Closes resolved issues (stripping `status:*` labels first via `stripStatusLabels`, #308), updates partially-done issues, and in Step 3 FILES the Phase 1.65 gate's carry-list — the deferred `createSpiralCarryoverIssue` call for SPIRAL/FAILED items and the `markOpenQuestionAnsweredOnDisk` write live here, not in Phase 1.65 (atomicity). Step 3b folds non-exempt over-cap creations into one `[Backlog-Sammel]` collector under the `issue-budget` cap; discovery findings from Phase 1.5 are filed at the end. Full procedure: [`references/phase-5-issue-cleanup.md`](references/phase-5-issue-cleanup.md).

## Phase 6: Final Report

Present to the user the **Session Summary**: Completed / Carried Over / Dropped at Handover Gate (#769) / New Issues Created / Unresolved Review Findings (MED-LOW, #617) / Metrics — including the Docs Health line rendered from the Phase 2.3 result and the Custom Phases line from Phase 2.5 — / Next Session Recommendations. Full template plus the Test-delta and Documentation-Coverage anchors: [`references/session-summary-template.md`](references/session-summary-template.md).

## Sub-File Reference

| File | Purpose |
|------|---------|
| `plan-verification.md` | Phase 1 FULL procedural body (1.1 … 1.10) — SESSION_START_REF accessor, 1.1a File-Level Grounding, the #769 Candidate Record Format, 1.5 Discovery Scan, 1.6 Safety Review + 1.6.6 "What Not To Retry", **1.65 Handover Alignment Gate** (routing, AUQ shapes, fail-open, telemetry), 1.7 Metrics, 1.8 Session Review, 1.9/1.10 Mission-Status |
| `verification-checklist.md` | Phase 2 quality gate checklist and checks |
| `references/phase-2-quality-gate.md` | Phase 2 full procedural body — Phase 2.0a Echo-Stub Detection (GH #42), 2.1 Vault Validation, 2.2 CLAUDE.md/AGENTS.md Drift Check, 2.3 Vault Staleness Check (mode resolution, probe invocation, aggregation + routing, closing-report surface) |
| `discovery-scan.md` | Phase 1.5 embedded discovery dispatch and findings triage |
| `metrics-collection.md` | Phase 1.7 JSONL schema and conditional field rules |
| `vault-operations.md` | Phase 2.1 validator bash contract and reporting matrix |
| `drift-operations.md` | Phase 2.2 drift-checker bash contract and reporting matrix |
| `references/phase-3-documentation-updates.md` | Phase 3 full procedural body — final heartbeat (#590-3), 3.0 Defensive Cleanup, 3.1 SSOT files, 3.2/3.2a docs + handover, 3.3 rules freshness, 3.4/3.4a STATE.md write + snapshot cleanup, 3.45 Telemetry Flush, 3.5/3.5a/3.6.x memory + learnings + tail dispatcher, 3.7/3.7a/3.7b/3.7c/3.7d metrics, recommendations, durable commit, vault board, session-eval |
| `phase-3-2-docs-verification.md` | Phase 3.2 full procedural body — docs-tasks load, SESSION_START_REF, per-task loop, mode-gated report, Documentation Coverage block |
| `learning-patterns.md` | Phases 3.5a + 3.6 extraction heuristics, confidence updates, passive decay, and JSONL write procedure |
| `phase-3-6-tail.md` | Phase 3.6.x tail — full unabridged detail procedures for all six tail phases: 3.6.3 Memory-Proposals Collection (`collectProposals` + AUQ multiSelect + `promoteAndClear`, composing `writeApproved` + `clearProposalsJsonl` behind a mechanical write-before-clear guard, #828), 3.6.4 Expired-Learnings Sweep (Epic #723 B4), 3.6.5 Auto-Dream nudge (`shouldDispatchAutoDream`, #614), 3.6.6 Skill-Applied Judge (#645 L3 — `runSkillJudge`, coordinator-writes), 3.6.7 Auto-Dialectic nudge (`shouldDispatchAutoDialectic`, #614), 3.6.8 Reconciliation Rule Proposals (#696 FA3 — `runReconcile` + AUQ + `writeApprovedRules`). Loaded on demand by the SKILL.md skip-plan dispatcher (#724) — only phases with `run: true` in the `planTailPhases()` plan execute |
| `scripts/lib/session-end/phase-skip.mjs` | Phase 3.6.x tail skip-plan aggregator (#724) — `planTailPhases({repoRoot, config, sessionId, platform})` → `{plan, skippedReport}`; side-effect-free (reconcile/sweep via dry-run — no writes), never-throws (per-phase probe error fail-opens to `run: true`); wraps the six existing signal helpers with config gates first, then input detection |
| `references/phase-3-documentation-updates.md` § 3.45 | Telemetry Flush (advisory, #844; MECHANICAL since #1138 — `hooks/on-session-end.mjs` calls `flush()` itself at the end of every teardown and emits an `orchestrator.telemetry.flush` breadcrumb, so this phase is the DESCRIPTION and the fallback, never the trigger; a coordinator that skips it changes nothing) — `flush()` from `scripts/lib/telemetry/sync.mjs` drains the host-local send-queue fire-and-forget; no config key (send-gate is `resolveConsent()` inside the module, fail-closed); skip when `persistence: false`; never-throw + ~3s-bounded, offline → bounded oldest-dropped queue, optional `Telemetry: sent/queued/gated` close-summary line, NEVER an error banner; runs late in the close after Phase 3.7 |
| `session-metrics-write.md` | Phase 3.7 JSONL append, vault-mirror invocation, durable narrative mirror (`mirrorNarrative`, #675), and behavior matrix |
| `phase-3-7a-recommendations.md` | Phase 3.7a full procedural body — computeV0Recommendation call, STATE.md field write, data source guarantee, error mode |
| `phase-3-7a-recommendations.md` § 3.7b | Phase 3.7b full procedural body — `withDurableCommit` invocation for `sessions.jsonl` + `STATE.md` (#490 AC2), `enabled:false` local no-op, autopilot.jsonl exclusion note |
| `references/phase-3-documentation-updates.md` § 3.7c | Vault Board → Closed (#674) — `mirrorBoard({ explicitStatus: 'closed' })` transitions this repo's board row to `closed`; gated on `vault-integration.enabled`, generator-marked + idempotent, non-blocking, ordered after 3.7b and before 3.7d/3.4/3.8 |
| `references/phase-3-documentation-updates.md` § 3.7d | Session-Eval (opt-in — #803) — `node scripts/eval-session.mjs --json` scores the just-closed session; gated on `eval.enabled` + `eval.mode != off` (parsed by `scripts/lib/config/eval.mjs`), optional `eval-judge` dispatch + `writeEvalReport`, advisory/never-blocks-close, ordered after 3.7 (record must exist) and before 3.4/Phase 4 (record committed with the session). Full flow in `skills/eval/SKILL.md` |
| (inline) Phase 3.8 | Session Lock Release — `release()` uses the physical raw `session_id`; raw mismatch/absent is non-fatal but never repaired with semantic labels or proof (live ambiguity remains for TTL/Reaper); fs-errors are non-fatal; runs after STATE.md writes and before Phase 4 commit staging |
| (inline) Phase 4 | Commit & Push — stage individually (PSA-004), commit, push to origin, then the `github-mirror-push` block (4 states: not-a-repo / no `github` remote / pushed / push failed) |
| `references/phase-4a-worktree-cleanup.md` | Phase 4a full procedural body — auto-promoted-worktree detection (`detectAutoPromotedWorktree`, marker-keyed since #1069), clean-check, clean auto-remove path, dirty 3-option AUQ (`Behalten`/`Löschen`/`Manuell`), PSA-003 + #490 ordering rationale |
| `references/phase-4b-worktree-orphan-sweep.md` | Phase 4b full procedural body — `checkWorktreeOrphans()` read-only proposal set, the coordinator-rendered AUQ, opt-in `worktree-orphans.enabled` gate |
| `references/phase-5-issue-cleanup.md` | Phase 5 full procedural body — close resolved issues (`stripStatusLabels`, #308), Step 3 filing of the Phase 1.65 carry-list incl. the deferred `createSpiralCarryoverIssue` and `markOpenQuestionAnsweredOnDisk`, Step 3b `[Backlog-Sammel]` overflow, discovery-issue creation |
| `references/session-summary-template.md` | Phase 6 Final Report — the full Session Summary template (Completed / Carried Over / Dropped at Handover Gate / New Issues / Unresolved Review Findings / Metrics incl. Docs Health + Custom Phases / Next Session Recommendations) plus the Test-delta and Documentation-Coverage anchors |

## Anti-Patterns

- **DO NOT** commit before running quality gates — a "clean commit" with TypeScript errors is not clean
- **DO NOT** mark issues as closed without verifying the implementation actually addresses them
- **DO NOT** skip creating tracking issues for unfinished work — "I'll remember for next session" always fails
- **DO NOT** use `git add .` or `git add -A` — parallel sessions may have uncommitted work in the tree
- **DO NOT** push to mirrors before verifying origin push succeeded — broken state propagates

## Critical Rules

- **NEVER claim work is done without running verification** — evidence before assertions
- **NEVER commit with TypeScript errors** — 0 errors is non-negotiable
- **NEVER use `git add .`** — stage files individually to avoid capturing parallel session work
- **NEVER skip issue updates** — VCS must reflect reality after every session
- **ALWAYS create issues for unfinished PLANNED work** — SPIRAL/FAILED agent carryover and partially-done plan items (Phase 1.2 / 1.6) ALWAYS get a ticket; nothing planned-but-unfinished is "remembered" without one. The `issue-budget` per-session cap does NOT weaken this: `priority::critical`, the carryover class (`[Carryover]`, `[SPIRAL]`/`[FAILED]`, `type::carryover`, bare `carryover`) and `broken-window` closure issues are exempt from the cap by construction (`scripts/lib/issue-budget.mjs` `EXEMPT_RULES`). Non-exempt over-cap creations are not dropped either — they are parked and folded into one `[Backlog-Sammel]` collector in Phase 5 Step 3b.
- **DO NOT auto-file MED/LOW review findings as issues** — newly-surfaced reviewer findings (Phase 1.8 / W4 panel) at MED or LOW severity are folded in-session or recorded in the Final Report under "Unresolved Review Findings". Only HIGH+/blocking review findings get an issue. (Issue #617 — stops the self-referential low-priority backlog.)
- **ALWAYS push to origin** — local-only work is lost work
- **ALWAYS mirror to GitHub** if configured — keep mirrors in sync
- **ALWAYS review `git diff --cached`** before committing — verify only YOUR changes are staged
