---
name: dispatcher
description: Use when you want the orchestrator to pick the next repo to work on across your whole portfolio — it enumerates candidate repos below the confinement root, resolves free/busy from each repo's session.lock lease, ranks the FREE ones by backlog priority × staleness × readiness, recommends the single most worthwhile one via AskUserQuestion, atomically claims it, and routes you to the chosen entry command. Triggers: "what should I work on next", "dispatch me to a repo", "pick the next project", "run /dispatcher". <example>Context: operator finished a session and wants the next-best repo across the portfolio. user: "/dispatcher" assistant: "Ranked 18 free repos — top recommendation: Pencil-Designs (score 4.50, 90d stale). Confirm via the picker, I'll claim its lease atomically, then route you to /session deep."</example>
model: sonnet
---

# Dispatcher Skill

> Cross-repo autopilot front-door — enumerate → rank → owner-AUQ → atomic claim → route. Read-only until the operator confirms; the only mutating step is the atomic `session.lock` claim, and it happens BEFORE any launch.

## Soul

The dispatcher answers one question: *"of all my repos, which is the most worthwhile to work on right now, and is it free?"* It scans the confinement-root children, resolves each repo's free/busy status from its `session.lock` v2 lease (same lease semantics as the vault-status board), ranks only the FREE ones by `priority × staleness × readiness`, and recommends the single best one. You confirm via a picker, it claims the lease atomically (winning the race or excluding-and-re-ranking on a loss), then routes you to the entry command for that repo. Busy repos are listed-as-such, never selected.

## When to use

- You just finished a session and want the orchestrator to pick the next-best repo across your whole portfolio.
- You want a ranked, free/busy-aware view of every candidate repo before committing to one.
- You want the atomic claim handled for you so two parallel sessions never both grab the same repo.

## When NOT to use

- Single-repo work where you already know the target — just run `/session`, `/plan`, or `/discovery` directly in that repo.
- A cross-repo *read-only health dashboard* (open issues/MRs/CI per repo) — that is `/portfolio` (gitlab-portfolio), not the dispatcher.
- Writing issues/MRs back to GitLab/GitHub — use `gitlab-ops`.
- Inside a subagent — the dispatcher is coordinator-only because Phase 2 uses `AskUserQuestion` (unavailable in dispatched agents; see `.claude/rules/ask-via-tool.md` AUQ-004).

## Phase 1: Enumerate + Rank

Run the read path (non-mutating). Either invoke the CLI directly or call `runDispatch` from the module:

```bash
node scripts/lib/dispatcher/cli.mjs --json
```

The JSON object has keys `{ candidates, free, ranked, warnings, recommended }`:

- `candidates` — every repo found below the confinement root (busy ones LISTED, not dropped).
- `free` — the subset with no live lease (`free === true`).
- `ranked` — the free candidates sorted DESC by score; `ranked[0]` is the recommendation.
- `recommended` — `ranked[0]` or `null` (no free candidates).
- `warnings` — human-readable degradation notes (glab/gh missing, host probe failed). **Surface every warning to the operator** — they explain why a repo was ranked on partial signals.

Ranking combines three signals per repo (implementation: `scripts/lib/dispatcher/rank.mjs`): backlog **priority** (critical/high counts), **staleness** (days since the last completed session — older = more worthwhile, capped at 90d), and **readiness** (CI status × host resource verdict — only ever dampens). A null priority (glab/gh missing) is ranked on staleness × readiness alone with a warning; the dispatcher NEVER blocks on a missing CLI.

## Phase 2: Owner-AUQ

Present the decision to the operator via the **`AskUserQuestion` tool** — never inline prose (`.claude/rules/ask-via-tool.md` AUQ-001..005, enforced).

- `AskUserQuestion` is a **deferred tool**. Call `ToolSearch` with `"select:AskUserQuestion"` ONCE per session before the first use to load its schema.
- **Option 1 is always the recommendation**, labelled `(Recommended)`: the top-ranked free repo paired with a recommended session-type. Options 2–4 are overrides (other high-ranked free repos, or other session-types for the same repo). 2–4 options total, each with a one-line `description` explaining the trade-off.
- This skill runs at coordinator level. **Never** call `AskUserQuestion` from inside a subagent — if a sub-step needs the decision, bubble it back to the coordinator (AUQ-004).

Recommended session-type heuristic for option 1: high critical/high backlog ⇒ `/session deep`; stale-but-clean (no backlog signal, high staleness) ⇒ `/discovery` or `/session housekeeping`; unscoped/new work ⇒ `/plan`. Offer the alternatives as the other options.

## Phase 3: Atomic claim

After the operator confirms repo **R**, claim its lease **BEFORE** launching anything:

```js
// via the module (preferred — returns the acquire() result verbatim)
import { claimRepo } from 'scripts/lib/dispatcher/cli.mjs';
const res = claimRepo({ repoRoot: R, sessionId, mode, ttlHours, semanticSessionId });
```

Or reuse the primitive directly: `acquire({ sessionId, mode, ttlHours, repoRoot, semanticSessionId })` from `scripts/lib/session-lock.mjs`. The claim is a `linkSync` create-or-fail = **atomic**.

- **`ok: true`** → the claim is held. Proceed to Phase 4.
- **`ok: false`** (race lost / busy — reasons: `active`, `stale-pid-alive`, `stale-pid-dead`, `fs-error`, …) → **exclude R**, re-rank the remaining free candidates (drop R from `free`, re-run Phase 1's rank step), and re-present Phase 2. Loop until a claim succeeds or no free candidate remains (then Phase 5).

Do NOT reinvent the claim — always go through `claimRepo`/`acquire`. The `ok:false` path is the load-bearing concurrency guard: two parallel dispatchers can both recommend R, but only one wins the `linkSync`; the loser must re-rank, never force.

## Phase 4: Route

With the lease held, the **coordinator** invokes the chosen entry slash-command for repo R:

- `/session housekeeping` or `/session deep` — execution modes.
- `/plan` — read-only planning precursor (produces a wave plan; does not execute).
- `/discovery` — read-only investigation precursor (maps scope; does not execute).

`/plan` and `/discovery` are **read-only precursors**, NOT execution modes — the menu may route to them, but they only produce artifacts for a later execution session. The full mode taxonomy lives in the mode-selector surface (P2 of this epic); the dispatcher only routes to the entry command the operator picked.

## Phase 5: Edge cases

- **No free candidate** (`recommended === null` / `free` empty) → report "all repos busy", and offer `resume` (an in-progress session) or `wait` via AUQ. **Never force a selection** of a busy repo.
- **vault off / glab missing** → degrade per the `warnings` array: rank on staleness × readiness only, surface the warning, continue. A missing CLI is never fatal.
- **Host resource probe failed** → readiness is scored without resource dampening (a warning says so); ranking still completes.
- **Bad `--start-dir`** → CLI exits 1 (user/input error); fix the path and re-run.

## CLI

```bash
node scripts/lib/dispatcher/cli.mjs [--json] [--dry-run] [--repo <name>] [--start-dir <path>] [--help] [--version]
```

| Flag | Description |
|---|---|
| `--json` | Emit `{ candidates, free, ranked, warnings, recommended }` as a single JSON object to stdout. |
| `--dry-run` | Explicit non-mutating rank (the read path is already non-mutating; documents intent). |
| `--repo <name>` | Filter the human-readable table to one `repoName` (informational; does not change ranking). |
| `--start-dir <path>` | Override the scan root (defaults to the confinement root). |
| `--help` / `--version` | Print usage / version and exit 0. |

Data → stdout, warnings/errors → stderr (never mixed). Exit codes follow `.claude/rules/cli-design.md`:

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User/input error (e.g. bad `--start-dir`) |
| `2` | System error (unexpected dispatch failure) |

## Anti-Patterns

- **Inline prose for the Phase-2 decision** — always `AskUserQuestion` (AUQ-001). A numbered markdown list of repos is a bug.
- **Launching before claiming** — Phase 3's `acquire` MUST succeed before Phase 4. Launching then claiming re-opens the race the lease exists to close.
- **Forcing a busy repo** when none are free — report and offer resume/wait; never select a `free === false` candidate.
- **Treating a missing glab/gh as fatal** — null priority degrades to staleness × readiness with a warning; never block.
- **Re-implementing the claim** — go through `claimRepo`/`acquire`; do not hand-roll a lockfile.
- **Ignoring `ok:false`** — on a lost race you MUST exclude-and-re-rank, not retry the same repo or proceed without the lease.
- **Running this from a subagent** — coordinator-only (AUQ is unavailable in subagents).

## Critical Rules

- The read path (`runDispatch` / `cli.mjs` without a claim) is NON-MUTATING. The ONLY mutating step is the Phase-3 atomic claim.
- The atomic claim is `linkSync` create-or-fail via `acquire(...)`. `ok:false` ⇒ exclude the repo and re-rank — this is the concurrency guard, not an error to swallow.
- Phase 2 uses `AskUserQuestion` with option 1 = recommendation `(Recommended)`; coordinator-only.
- Busy repos are LISTED, never selected (PRD: "busy repos listed as such, not selected").
- glab/gh/host-probe degradation is surfaced as a warning and never blocks ranking.
- Implementation files: `scripts/lib/dispatcher/cli.mjs` (orchestration: `runDispatch`, `claimRepo`) · `scripts/lib/dispatcher/enumerate.mjs` (enumeration + free/busy) · `scripts/lib/dispatcher/rank.mjs` (scoring) · `scripts/lib/session-lock.mjs` (`acquire` atomic claim).
