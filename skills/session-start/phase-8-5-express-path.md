# Phase 8.5: Express Path Evaluation (#214)

> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../_shared/instruction-file-resolution.md). All references to `CLAUDE.md` below apply to whichever file the repo uses.

After the user confirms the session type and scope via the Q&A above, evaluate whether the **Express Path** applies before handing off to session-plan. The express path collapses the full 5-wave plan into a single coordinator-direct phase for lightweight sessions.

**Do not evaluate these conditions by hand — call the code (#1119).**

```js
import { evaluateExpressPath } from '$PLUGIN_ROOT/scripts/lib/express-path.mjs';
const { activated, reasons } = await evaluateExpressPath({
  repoRoot, config, sessionType, taskCount, parallelAgentsRequired,
});
```

`evaluateExpressPath` makes the decision AND records it as `orchestrator.express_path.evaluated`
— on **every** evaluation, activation and refusal alike. That is the whole point: until #1119 the
conditions below were prose only, `scripts/lib/config.mjs` discarded `express-path` **even when the
block was present** (measured: 88 keys emitted, none of them this one), and the ledger held **0**
express-path events across its entire history. Whether the path ever fired was unanswerable.
Re-deriving the conditions in a coordinator turn re-opens exactly that hole; the conditions below
are the specification the module implements, not a second implementation.

`reasons` carries the blocking codes when `activated: false` and the satisfied ones when `true`.
Nothing short-circuits, so a refusal names **every** blocker — a reader can see whether trimming
the issue list alone would have helped. Unmeasured inputs are omitted from the payload, never
written as `0`/`false`, and an unmeasured `sessionType`/`taskCount` fails CLOSED.

**Activation conditions (the module's specification):**

1. `express-path.enabled` is `true` in Session Config (default: `true` — opt-in by default, opt-out via `express-path.enabled: false`).
2. Session type is `housekeeping` (the user confirmed `housekeeping` in Phase 8).
3. Agreed issue scope is ≤ 3 issues AND no parallel agents are required (i.e., tasks are sequential, no wave decomposition needed).

> Condition 3 carries **two** clauses, so the module takes **four** inputs, not three. The
> condition matrix below and `docs/session-config-reference.md` both list a `housekeeping` / 1–3 /
> `enabled: true` row that still does NOT activate, because parallel agents are required.

**Backward compat:** when `express-path.enabled: false`, this evaluation is skipped entirely and the normal 5-wave session-plan flow runs as before.

**Historical context:** The 13 prior coordinator-direct sessions documented in `CLAUDE.md` (or `AGENTS.md` on Codex CLI; 2026-04 series — vault-mirror GH#31, phased-rollout #307, v3.2.0 release, etc.) were all running this pattern implicitly: no wave decomposition, coordinator executes tasks directly in sequence. This phase codifies what was already proven to work.

**When Express Path activates:**

Emit the following banner immediately after the Phase 8 Q&A resolves:

```
Express path activated — <N> tasks, coordinator-direct, no inter-wave checks.
```

> **UNRESOLVED — three documents disagree about what happens AFTER activation, and none of them is code (measured 2026-08-23).** The activation *conditions* are identical everywhere; the *routing* is not:
>
> | Site | Says |
> |---|---|
> | this file (below) | "skip the handoff to session-plan **entirely**" |
> | `skills/session-start/SKILL.md:1189` | "executes tasks coordinator-direct (**bypassing session-plan** and wave-executor)" |
> | `docs/session-config-reference.md:1542` | "session-plan **is called** but receives the express-path signal" |
> | `skills/session-plan/SKILL.md:51` | has an `## Express Path Short-Circuit (#214)` section that emits a **1-wave plan** |
> | `commands/go.md:19` | gates on the banner **AND** "the session-plan output emitted a 1-wave Express Path plan" |
>
> Two of the five say session-plan is skipped; three say it runs and short-circuits. `/go` cannot
> work under the first reading — it looks for a plan that would never have been produced. Deliberately
> NOT resolved here: picking one silently is the failure class this repo keeps paying for. It is an
> Open Question for the operator; whoever answers it edits all five sites in one pass.

Under the reading this file has carried so far — **skip the handoff to session-plan entirely** — execute the agreed tasks directly as the coordinator:

1. For each agreed task (in dependency order): execute as a direct coordinator action — read files, make changes, run quality checks inline.
2. After all tasks complete, invoke `skills/session-end/SKILL.md` directly (bypass session-plan and wave-executor).
3. Log the express-path activation in STATE.md `## Deviations` section: `Express path: N tasks executed coord-direct (express-path.enabled: true, session-type: housekeeping, scope: N issues)`.
4. After session-end completes successfully: verify STATE.md `status` is `completed` and `## Deviations` contains the express-path entry from step 3. If either is missing, warn the user with a one-line note and instructions to re-run `/close` manually. Then return the final session summary to the user.

**Persistence contract:**

The four steps above MUST all happen within a single coordinator turn. Specifically:

- Step 1 (execute tasks) happens first in the coordinator's main flow.
- Step 2 (deviations log) is written BEFORE session-end is invoked. The coordinator calls `appendDeviation()` from `scripts/lib/state-md.mjs` to append the `Express path:` bullet to the `## Deviations` section while STATE.md is still `status: active`.
- Step 3 (invoke session-end) flips `status` to `completed`, writes the metrics record to `.orchestrator/metrics/sessions.jsonl`, and runs the standard close flow. Session-end has no Express Path-specific logic — it treats this run identically to any other completed session.
- Step 4 (verification) is the coordinator's final action before returning control. The verification check uses `parseStateMd()` from `scripts/lib/state-md.mjs` to read the file and check `frontmatter.status === 'completed'` and that the body contains the literal string `Express path:`.

If `/go` is invoked but the session-plan emitted a 1-wave Express Path plan (per `skills/session-plan/SKILL.md` § "Express Path Short-Circuit"), the `/go` command MUST detect this and route to coord-direct execution + session-end auto-invocation, NOT to wave-executor. See `commands/go.md` for the detection branch.

**When Express Path does NOT activate** (conditions not met):

Proceed normally to Phase 9 (session-plan handoff). The express-path evaluation is a silent no-op when any condition fails.

**Condition examples:**

| Scenario | Activates? | Reason |
|---|---|---|
| `housekeeping`, 2 issues, `express-path.enabled: true` | Yes | All 3 conditions met |
| `housekeeping`, 4 issues, `express-path.enabled: true` | No | Scope > 3 |
| `feature`, 2 issues, `express-path.enabled: true` | No | Not housekeeping |
| `housekeeping`, 2 issues, `express-path.enabled: false` | No | Opted out |
| `housekeeping`, 3 issues needing parallel agents, `express-path.enabled: true` | No | Parallel agents needed |

## See Also

- `commands/go.md` — Express Path detection and auto-invocation of session-end after coord-direct tasks
- `skills/session-end/SKILL.md` — Phase 1 pre-check (Rule 2) blocks `/close` when STATE.md `status: completed`; auto-invocation from express-path bypasses this
- `commands/close.md` — Rule 2 wording the user sees if express-path persistence breaks
