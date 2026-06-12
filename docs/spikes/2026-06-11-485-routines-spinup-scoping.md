# Spike Scoping — Routines Cloud-Execution Empirical Spin-up (#485)

> **SUPERSEDED 2026-06-12 (issue #485 closed won't-do).** Per operator decision, Anthropic Routines will not be adopted as the cloud-execution substrate — see `docs/adr/0003-routines-cloud-execution.md § Supersession (2026-06-12)`. The empirical spin-up this doc scopes is therefore moot. The durability need is redirected to the in-harness detached headless autopilot path (issue #640, verified PASS — `docs/spikes/2026-06-12-640-background-detachment-test.md`) plus a documented self-hosted-runner follow-up. This scoping doc is retained as a historical record of the (un-executed) Routines plan.
> Date: 2026-06-11 · Session: main-2026-06-11-session-2 · Status: SUPERSEDED (was: SCOPING — operator-gated on Routines access)
> ADR: docs/adr/0003-routines-cloud-execution.md (Adapter, ACCEPTED) · Issue: #485
> Supersedes-by-reference: docs/research/2026-05-19-deep-3-routines-empirical.md (the copy-paste-ready test plan; this doc is the decision frame around it)
> HARD GATE: issue #490 (3-file durable-telemetry wiring) must close before any `enabled: true` flip — independent of this spike's outcome.

## 1. Objective

Convert ADR 0003's three deferred empirical questions from "docs imply" to "observed on the live surface" by firing this repo as ONE bounded cloud Routine, so the Adapter can either be wired (default-off Session Config key) or closed won't-do. This spike does NOT flip `durable-telemetry.mjs` to enabled — that is gated separately on #490.

## 2. Falsifiable questions (the only reasons to spend a fire)

- **Q-BILLING:** Per fire, how much subscription usage is drawn down, and what is the per-account daily run cap (third-party reports ~15/account; docs publish no number)? Where observed: `claude.ai/settings/usage` before/after. Falsifiable: cap number captured OR not.
- **Q-HOOK-FIRE:** Do the repo-committed `hooks/hooks.json` guards (`pre-bash-destructive-guard.mjs`, `enforce-scope.mjs`) actually fire inside the cloud session? Where observed: the run transcript URL — grep for the hook names in the transcript. Falsifiable: hook output present OR absent.
- **Q-TELEMETRY-ATOMICITY:** Does a `.orchestrator/metrics/*.jsonl` write committed to a `claude/`-prefixed branch survive forced env reclamation — i.e. is the commit+push atomic relative to teardown, or can the clone be reclaimed mid-commit leaving the branch absent on origin? Where observed: `git fetch origin && git log origin/claude/<branch>`. Falsifiable: branch+commit present on origin OR not.

## 3. Minimal trivial-Routine design

One bounded maintenance check — a `/loop`-style single iteration, NOT a multi-iteration loop (ADR 0003's one-bounded-session-per-fire constraint, 0003:25). The Routine prompt:

> "Run exactly one bounded maintenance check. (1) Write a marker file `.orchestrator/metrics/routine-spinup-marker-<UTC>.txt` containing the run timestamp and the string 'h-fire-probe'. (2) Run a Bash command that the committed destructive-guard would evaluate (a SAFE one, e.g. `git status`) so the hook demonstrably fires in-transcript. (3) Commit `.orchestrator/metrics/routine-spinup-marker-*.txt` to branch `claude/routine-spinup-485` with message 'chore(spike): #485 routines spin-up marker'. (4) Push the branch. (5) /close and exit. Do NOT modify any source file. Do NOT iterate."

Routine config skeleton (full copy-paste version lives in the deep-3 plan, §4.2):
- repositories: [github.com/Kanevry/session-orchestrator]
- connectors: [] (none — avoids the no-prompt connector-write surface, ADR research §2.9)
- trigger: API manual fire (header `anthropic-beta: experimental-cc-routine-2026-04-01`)
- Allow unrestricted branch pushes: OFF (default; `claude/` prefix is allowed without it)

## 4. Observation checklist (where each answer lands)

| # | Observation | Method | Lands in |
|---|---|---|---|
| 1 | Usage delta + daily cap | `claude.ai/settings/usage` before/after; fire 10-15× to hit cap | Q-BILLING; routines-h3-cap-results.json |
| 2 | Hook fired in cloud | grep transcript for `pre-bash-destructive-guard` / `enforce-scope` | Q-HOOK-FIRE; routines-h1-h2-results.jsonl |
| 3 | Branch+commit on origin | `git fetch origin && git log origin/claude/routine-spinup-485 --oneline` | Q-TELEMETRY-ATOMICITY |
| 4 | Atomicity under reclamation | repeat the fire ≥3×; check whether the branch is EVER absent/partial after a green run | Q-TELEMETRY-ATOMICITY (the race) |
| 5 | Green-status caveat honored | read full transcript, do NOT trust green status | all (ADR research §2.3) |

> Atomicity note: a single successful push proves the happy path, not atomicity. To probe "forced env reclamation," fire ≥3× and treat ANY run where the green status is reported but `origin/claude/routine-spinup-485` lacks the expected commit as evidence the commit→push is NOT atomic vs teardown (→ telemetry shim needs a fsync/verify step before #490 wiring).

## 5. Abort criteria

- Abort immediately if any fire attempts a non-`claude/` branch push or a source-file write (scope breach).
- Abort the cap-measurement loop (checklist #1) at the first HTTP 429 — record the number, stop firing.
- Abort the whole spike if Q-HOOK-FIRE = absent: if committed hooks do NOT fire in-cloud, the Adapter's safety premise is void (ADR research §5 NOT-READY) → close won't-do, do not measure billing further.

## 6. Estimated cost bound

≤ ~20 cloud fires total: 3-5 for Q-HOOK-FIRE + Q-TELEMETRY-ATOMICITY (atomicity needs repeats), up to 15 for the daily-cap probe (which by design stops at the cap). Each fire draws subscription usage identically to one interactive session of a trivial single-iteration task (cheap — marker-file + one commit). No per-run pre-budget gate exists (ADR 0003:38), so the operator MUST watch `claude.ai/settings/usage` and stop manually if draw-down is unexpectedly high. Hard ceiling: stop at 20 fires regardless.

## 7. Decision tree (answers → verdict)

- **Q-HOOK-FIRE present + Q-TELEMETRY-ATOMICITY atomic (branch always lands) + Q-BILLING bounded:** → upgrade ADR 0003 toward production wiring. Close #490 (3-file wiring) FIRST, then flip `durable-telemetry.mjs enabled:true` + add default-off `routines-adapter` Session Config key. (PROD-READY, ADR research §5.)
- **Q-HOOK-FIRE present BUT Q-TELEMETRY-ATOMICITY non-atomic (branch sometimes absent after green):** → CONDITIONALLY-READY. Keep Adapter on paper; the telemetry shim needs a verify-after-push step. Do NOT flip enabled until atomicity is solved AND #490 closes.
- **Q-HOOK-FIRE absent:** → NOT-READY. ADR 0003 Adapter path closes won't-do; `/loop` + local `runLoop` stays the only production path. The 10 kill-switches never reach the cloud — the whole premise fails.
- **Stop-condition primitive observed shipping** (orthogonal watch, ADR 0003:51 / deep-3 §6): re-open ADR 0003 toward a guarded multi-iteration cloud loop via a SEPARATE ADR amendment — this spike does not decide that.

## 8. Status

SCOPING — operator-gated. Live execution requires Routines access (Pro/Max/Team/Enterprise with Claude Code on the web). When access is available, execute the copy-paste plan in docs/research/2026-05-19-deep-3-routines-empirical.md §4, record results in the JSONL/JSON artifacts named there, then fill §7 of this doc with the verdict and update ADR 0003.
