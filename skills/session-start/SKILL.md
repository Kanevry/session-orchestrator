---
name: session-start
user-invocable: false
tags: [orchestration, initialization, analysis, alignment]
model: inherit
model-preference: opus
model-preference-codex: gpt-5.4
model-preference-cursor: claude-opus-4-6
description: >
  Use this skill when initializing a session for any project repo. Autonomously analyzes git state,
  VCS issues, SSOT files, branches, environment, and cross-repo status. Then presents
  structured findings with recommendations for user alignment before creating a wave plan.
  Triggered by /session [housekeeping|feature|deep] command.
---

# Session Start Skill

> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../_shared/instruction-file-resolution.md). All references to `CLAUDE.md` in this skill resolve via that precedence rule.

## Soul

Before anything else, read and internalize `soul.md` in this skill directory. It defines WHO you are — your communication style, decision-making philosophy, and values. Every interaction in this session should reflect this identity. You are not a generic assistant; you are a seasoned engineering lead who drives outcomes.

**Then set the output level.** Read `~/.config/session-orchestrator/owner.yaml` and take `efficiency.output-level` (`lite` | `full` | `ultra`), `efficiency.preamble`, and `tone.style`. If the file is missing, unreadable, or a key is absent, use the defaults `full` / `minimal` / `neutral`. Apply the matching `### output-level: <value>` block from `soul.md` § Output Levels for the whole session — its line budgets are binding, not advisory, and § "Never traded for brevity" names what they may never cut.

## Phase 0: Bootstrap Gate

Read `skills/_shared/bootstrap-gate.md` and execute the gate check. If the gate is CLOSED, invoke `skills/bootstrap/SKILL.md` and wait for completion before proceeding. If the gate is OPEN, continue to Phase 1.

<HARD-GATE>
Do NOT proceed past Phase 0 if GATE_CLOSED. There is no bypass. Refer to `skills/_shared/bootstrap-gate.md` for the full HARD-GATE constraints.
</HARD-GATE>

## Phase 0.5: Parallel-Aware Preamble

> Skip silently when `persistence: false` in Session Config.

Before Phase 1, run the parallel-aware preamble per `skills/_shared/parallel-aware-preamble.md`. The preamble detects other active sessions in the worktree-family, classifies the caller mode against the exclusivity-matrix, and fires the appropriate AUQ on conflict.

This runs BEFORE the local session-lock acquire in Phase 1.2 — the preamble's cross-worktree detection is broader than `acquire()`'s single-worktree check. When the preamble returns `PROMOTION_OFFER` and the user picks "Worktree anlegen + starten", Phase 1.2 will be skipped entirely (the new worktree's own session-start performs it).

**Outcome handling:**
- `PASS_THROUGH` → continue to Phase 1
- `PASS_THROUGH` with a non-empty `advisory` array (GH#67) → a `discovered` peer with `lockSuperseded: true` never fires the Promotion AUQ (it stays visible, per the #1085 advisory-lock contract — it is not filtered). Print ONE advisory line per entry: `parallel-aware: registry entry <sessionId> (last heartbeat <N> min ago) is superseded by this root's live lock <lockOwnerId> — likely a finished task on a platform without SessionEnd (GH#67); still counted for PSA-001 awareness`, then continue to Phase 1. It remains PSA-002-relevant if the same id also shows up in STATE.md (`source: 'state-md'` is handled by Phase 1.2.1 unchanged).
- `EXCLUSIVE_BLOCKED` → exit Phase 0 cleanly per the AUQ outcome (`Warten` / `Andere Session beenden` / `Abbrechen` — all three return without initializing STATE.md)
- `PROMOTION_OFFER` with user picking "Worktree anlegen + starten" → call `enterWorktree({ basePath, sessionId, branch, repoRoot, rawSessionId, reason: 'worktree-promotion' })` from `scripts/lib/autopilot/worktree-pipeline.mjs` — since #1170 this ONE call does both jobs: it creates the destination worktree AND, because `rawSessionId` is supplied, releases the source root internally (see below), so no separate `leaveSourceRoot` call is made at this site. Compute params: `basePath = path.dirname(repoRoot)`, `sessionId` from resolveSemanticSessionId() **for the worktree-name attribution label only**, `branch` from current HEAD, `repoRoot = process.cwd()`, `rawSessionId` from `readLock({ repoRoot }).session_id`. `sessionId` (the semantic label) is not a lock/registry ownership key; the new worktree's Phase 1.2 obtains its own physical raw `session_id`. Because `branch` is the current HEAD it is normally checked out by `repoRoot` already, so `enterWorktree` treats it as a start point only and lands the promoted worktree on a fresh `so/<sessionId>` branch, returning `{ branch: 'so/<sessionId>', promotedFrom: '<branch>' }` (#1067) — the new worktree's STATE.md `branch` MUST record `so/<sessionId>` and note `promoted from <branch>@<repoRoot>`, never the source branch alone. **`rawSessionId` is the RAW physical `session_id` read from this root's `.orchestrator/session.lock` via `readLock({ repoRoot })` — never the semantic label, and never the id in `current-session.json`, which may describe a peer session (#863); a wrong id aborts the internal `leaveSourceRoot()` teardown with `left.ok: false, reason: 'lock-session-mismatch:<owner>'` and removes nothing.** The promotion is a PROCESS BOUNDARY, not a live migration (#1069): the old root is deregistered and its `session.lock` released BEFORE the new worktree's own Phase 1.2 acquires, so the two roots never both own a live claim at once. `enterWorktree()`'s return value carries the outcome as `left: { ok, steps, reason? }`; `leaveSourceRoot()` never throws, so on `left.ok !== true` `enterWorktree` itself emits the stderr WARN `enterWorktree: leaveSourceRoot: <reason>` and the promotion continues regardless — the destination worktree already exists by the time this runs, so aborting here would leave exactly the two-live-roots state the call prevents. Then exit Phase 0 immediately — the new worktree's own session-start runs from scratch (Phase 1 onwards), Phase 1.2 session-lock-acquire is the new worktree's responsibility. On enterWorktree failure (`WorktreeBoundaryError` or `git worktree add` non-zero exit), emit stderr WARN `parallel-aware: enterWorktree failed: <err>; falling back to Manuell` and proceed via the Manuell path.
- `PROMOTION_OFFER` with user picking "Manuell — in-place daneben" → append Deviation, continue to Phase 1
- `PROMOTION_OFFER` with user picking "Abbrechen" → exit cleanly

**Implementation reference:** `skills/_shared/parallel-aware-preamble.md § Implementation`.
**AUQ reference:** `skills/_shared/parallel-aware-auq.md`.

## Phase 1: Read Session Config

Read and parse Session Config per `skills/_shared/config-reading.md`. Store result as `$CONFIG`.

## Phase 1.05: Skill-Invocation Self-Report (#1199)

> Emit an L1 skill-invocation record for `session-start` itself. The PreToolUse `Skill`-matcher hook only captures skills dispatched via the `Skill` tool — a **prose-invoked** skill like this one is invisible to it (verified gap: external users show 0/20 sessions with a `session-start` row in `skill-invocations.jsonl`, vs. 93/93 for the operator). This self-report closes that gap so L2/L3 skill-health has a `session-start` selection signal. Best-effort, try/catch-silent — it never blocks Phase 1.1.

```javascript
try {
  const { appendSkillInvocation, DEFAULT_SKILL_INVOCATIONS_PATH } =
    await import('${PLUGIN_ROOT}/scripts/lib/skill-invocations-schema.mjs');
  const nodePath = await import('node:path');
  await appendSkillInvocation(nodePath.join(process.cwd(), DEFAULT_SKILL_INVOCATIONS_PATH), {
    timestamp: new Date().toISOString(),
    event: 'selected',
    skill: 'session-orchestrator:session-start',
    session_id: null,   // no session.lock is bound yet at Phase 1 — the raw id is acquired at Phase 1.2 (#1199)
    phase: 'session-start',
  });
} catch { /* self-report is advisory — never blocks Phase 1.1 */ }
```

## Phase 1.1: Dispatcher-Autonomy Migration Capture (one-time, per-repo)

> Runs after Phase 1, before Phase 1.2. Fires **exactly once per repo** — only when the committed `## Dispatcher Autonomy` H2 is ABSENT from CLAUDE.md (raw presence check via `isDispatcherAutonomyBlockPresent`, never the resolved value); skip silently when no committed CLAUDE.md exists. One AUQ, then the committed block is written and never re-asked. Full procedure: [`references/phase-1-1-dispatcher-autonomy-capture.md`](references/phase-1-1-dispatcher-autonomy-capture.md).

## Phase 1.2: Session Lock Acquire (#330)

> Skip when `persistence: false`. Confirmatory since Epic #583 — `hooks/on-session-start.mjs` writes `.orchestrator/session.lock` mechanically; this phase verifies it via `readLock({ repoRoot })` and re-calls `acquire()` only when the lock is `null` or its raw `session_id` does not match. Active / stale / fs-error decision flow, `forceAcquire()` on user consent, and cross-host behaviour: [`references/phase-1-2-session-lock.md`](references/phase-1-2-session-lock.md).

## Phase 1.2.1: Peer-Guard (Epic #583 defense-in-depth)

> Skip when `persistence: false`. After 1.2, `findPeers(repoRoot, { mySessionId })` re-checks the STATE.md surface for a live peer the lock missed; a `source: 'state-md'` peer fires the Worktree-Promotion AUQ instead of overwriting STATE.md. SOFT-GATE (operator may override), fail-open on read errors. Full decision flow: [`references/phase-1-2-session-lock.md`](references/phase-1-2-session-lock.md) § Phase 1.2.1.

## Phase 1.5: Session Continuity

> Skip when `persistence: false`. Reads `<state-dir>/STATE.md` (stale when its `branch` ≠ current HEAD) and branches on `status:` — `active`/`paused` → resume AUQ + Snapshot Recovery; `completed` → Recommendations Banner, then Idle Reset. Every surfaced prior-session record MUST carry the #621 HISTORICAL guard banner (SSOT `scripts/lib/historical-guard.mjs`). Full procedure incl. Recommendations Banner, Idle Reset (which PRESERVES `## What Not To Retry`), Snapshot Recovery (#196) and the Current-Task Banner (#184): [`references/phase-1-5-session-continuity.md`](references/phase-1-5-session-continuity.md). The same file carries the STATE.md-init rule for the `ultradeep` alias (`setSessionProfile` — `session-type` stays `deep`; absence is the contract for every other argument).

## Phase 1.6: Metrics Initialization

> Skip if `persistence` config is `false`.

1. Ensure '.orchestrator/metrics/' directory exists in the project root (create if missing). For backward compatibility with pre-v2.0 sessions, also check the platform's legacy metrics directory (`<state-dir>/metrics/` where `<state-dir>` is `.claude/`, `.codex/`, or `.cursor/` per platform).
2. If '.orchestrator/metrics/sessions.jsonl' exists, count lines to determine number of previous sessions. If not found, check `<state-dir>/metrics/sessions.jsonl` as a platform-specific legacy fallback.
3. Store the count for display in Phase 7 — this feeds the Historical Trends section

## Phase 1.7: Vault Live-Status Board (#674)

> Skip silently unless `vault-integration.enabled: true` in Session Config. Marks THIS repo `in-progress` on `<vault-dir>/01-projects/_active-sessions.md` via `sweepBoard()` (`scripts/lib/vault-status/board-writer.mjs`) and force-closes crashed rows host-wide via `enumerateCandidates()`; generator-marked, idempotent, never touches `_overview.md`, non-blocking (falls back to single-repo `mirrorBoard()`). Full procedure: [`references/phase-1-7-vault-status-board.md`](references/phase-1-7-vault-status-board.md).

## Phase 2: Git Analysis (parallel)

Run these checks as ONE parallel Bash block — background the independent git ops with `&` and `wait`:

```bash
# Refresh remote-tracking refs BEFORE reading them. Without this, `origin/main`
# is a snapshot from the last fetch or clone, and every ahead/behind derivation
# below silently compares against stale data — a repo can read "in sync" while
# the real remote is many commits ahead. Best-effort and non-blocking: connect
# timeouts are bounded (no `timeout(1)` — it is absent on macOS by default) and
# any failure (offline, no remote, auth prompt) falls through to `|| true`,
# leaving the previous behaviour of reading whatever refs are on disk.
GIT_SSH_COMMAND='ssh -o ConnectTimeout=5 -o BatchMode=yes' \
  git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=5 \
  fetch --quiet --prune 2>/dev/null || true

# Independent ops — launch in parallel, collect output via tmpfiles
git branch -a > /tmp/so-branches.$$ &
git log --oneline -N > /tmp/so-commits.$$ &        # N from Session Config `recent-commits` (default 20)
git status --short > /tmp/so-status.$$ &
# `--left-right --count A...B` emits "<behind>\t<ahead>": commits reachable only
# from origin/main, then only from HEAD. The older `git log origin/main..HEAD`
# form could express ahead ONLY, so "behind" was structurally unreportable.
git rev-list --left-right --count origin/main...HEAD > /tmp/so-divergence.$$ 2>/dev/null &
wait
# Then read the 4 tmpfiles in a single step and derive: branch state, recent commits,
# unpushed/uncommitted, open branches. Clean up tmpfiles once derivations are done:
rm -f /tmp/so-branches.$$ /tmp/so-commits.$$ /tmp/so-status.$$ /tmp/so-divergence.$$
```

Checks to run (derived from the collected output):

1. **Branch state**: current branch (from `branch -a`), ahead/behind origin (from the `divergence` tmpfile — field 1 is behind, field 2 is ahead). Report BOTH directions. A non-zero behind count means the local branch is missing remote work: surface it, because agents reading repo instructions from a stale checkout will follow superseded guidance. An empty `divergence` tmpfile means no `origin/main` ref resolved (no remote, or a differently-named default branch) — report that as unknown, never as zero.
2. **Recent commits**: parse `commits` tmpfile — identify last session's work by commit patterns
3. **Unpushed/uncommitted**: `status` tmpfile + the ahead field of the `divergence` tmpfile combined
4. **Open branches**: parse `branch -a` tmpfile, identify which are mergeable to develop/main
5. **Stale branches**: run AFTER the parallel block — requires iterating over branches (depends on `branch -a` output). Use `git log -1 --format=%ct <branch>` per branch; flag those with no commits in more than `stale-branch-days` (default: 7) days.

**Rationale:** The 4 independent ops are I/O-bound — running them in parallel cuts Phase 2 wall-clock from ~500ms to ~150ms. The stale-branches check depends on the branch list, so it runs after `wait`.

## Phase 2.5: Docs Planning (Docs-Orchestrator Integration)

> Skip this phase if `docs-orchestrator.enabled` config is not `true` (default: `false`).

Reads the `docs-orchestrator` config fields, auto-detects which audiences (user/dev/vault) are affected by the current scope using signals from Phases 2–5, confirms the selection with the user via AskUserQuestion, and emits a `### Docs Planning Result (Phase 2.5)` block into the conversation context. That block is the **MANDATORY contract** consumed by session-plan Step 1.8 to seed Docs-role tasks. Audience → file-pattern mapping is the authoritative source at `skills/docs-orchestrator/audience-mapping.md`. Contains non-overlap discipline rules (paths owned by `vault-mirror` and `daily` are off-limits).

**See `phase-2-5-docs-planning.md` for full details.**

## Phase 2.6: Steering Docs Loading

> Skip this phase silently when `.orchestrator/steering/` does not exist in the project root. This mirrors Phase 2.5's silent-no-op pattern — backward compatibility with repos that have not yet scaffolded steering docs.

Check for the steering directory and load all three docs if present:

```bash
STEERING_DIR=".orchestrator/steering"
if [ -d "$STEERING_DIR" ]; then
  PRODUCT_MD=""
  TECH_MD=""
  STRUCTURE_MD=""
  [ -f "$STEERING_DIR/product.md" ]   && PRODUCT_MD=$(cat "$STEERING_DIR/product.md")
  [ -f "$STEERING_DIR/tech.md" ]      && TECH_MD=$(cat "$STEERING_DIR/tech.md")
  [ -f "$STEERING_DIR/structure.md" ] && STRUCTURE_MD=$(cat "$STEERING_DIR/structure.md")
fi
```

When at least one file is non-empty, inject the following **Steering Context** banner into the conversation context before Phase 3. This gives Phase 3 (VCS Deep Dive) and subsequent phases stable product/tech/structure facts without re-reading CLAUDE.md:

```
--- Steering Context ---
[product.md contents — mission, target users, in-scope, out-of-scope]
[tech.md contents — stack, commands, constraints]
[structure.md contents — directory map, inventory, key skills]
--- End Steering Context ---
```

If `.orchestrator/steering/` is absent or all three files are empty, proceed directly to Phase 3 with no banner and no warning. Do not treat missing steering docs as an error.

**See `.orchestrator/steering/{product,tech,structure}.md` for file contents.**

## Phase 2.7: GitLab Portfolio Snapshot (#41)

> Skip silently unless `gitlab-portfolio.enabled: true` AND `vault-integration.enabled: true` with a non-empty `vault-dir` AND `gitlab-portfolio.mode != off`. Dry-run only — renders a compact portfolio health banner via `scripts/lib/gitlab-portfolio/cli.mjs --dry-run` inside an 8s budget, writes no file and never blocks session-start (the write path belongs to `/portfolio`). Full procedure incl. banner rendering, failure behaviour and performance budget: [`references/phase-2-7-portfolio-snapshot.md`](references/phase-2-7-portfolio-snapshot.md).

## Phase 3: VCS Deep Dive (parallel)

> **VCS Reference:** Detect the VCS platform per the "VCS Auto-Detection" section of the gitlab-ops skill.
> Use CLI commands per the "Common CLI Commands" section. For cross-project queries, see "Dynamic Project Resolution."

Using the detected VCS CLI, query (reading `issue-limit` from Session Config, default: 50):

1. **Open issues** — categorize by priority and status labels
2. **Recently closed** — what was done since last session
3. **Milestones** — active sprint status
4. **Open MRs/PRs** — anything waiting for review/merge
5. **Pipeline/CI status** — is CI green?

Group issues by:
- `priority::critical` / `priority::high` — must-address
- `status:ready` — ready to work on
- Session-type relevance (housekeeping tasks vs feature tasks vs deep-work tasks)

## Phase 4: SSOT & Environment Check

> Always runs; every finding is a NON-BLOCKING banner in the Session Overview (never a gate — the Full Gate is the Quality wave's job). Covers SSOT freshness, the Baseline quality commands (resolved `.orchestrator/policy/quality-gates.json` → Session Config → defaults, each availability-checked with `command -v`), Pencil design status, plugin freshness, and the banner-probe family registered in `scripts/lib/session-start-probes.mjs` (bootstrap-lock-freshness, vault-staleness, telemetry-flush-health, ci-status, qg-command-drift, peer-cards, loop-readiness, instruction-budget, maintenance-due, sessions-staleness, sessions-integrity, owner-config, moc-staleness, context-coverage, claude-md-budget-lint, tests:src-ratio, project-hygiene, mirror-issues, git-config-drift — 19 total). Per-probe module path, return contract and exact banner wording: [`references/phase-4-ssot-environment-check.md`](references/phase-4-ssot-environment-check.md).

## Phase 4.5: Resource Health (v3.1.0)

> Skip this phase if `resource-awareness: false` in Session Config.

Reads `.orchestrator/host.json` and runs a live resource snapshot via `resource-probe.mjs`. Computes a `green`/`warn`/`critical` verdict against configurable thresholds (RAM, CPU, concurrent Claude processes, SSH). On `warn`/`critical`, presents an AskUserQuestion prompt to apply the recommended `agents-per-wave` cap or proceed at the user's own risk. The cap is forwarded to session-plan as an in-session override.

**See `phase-4-5-resource-health.md` for full details.**

## Phase 5: Cross-Repo Status (if configured)

For each repo in `cross-repos`:
1. `cd ~/Projects/<repo> && git log --oneline -5 && git status --short`
2. Check for open issues that reference this repo
3. Note any branches that should be merged

## Phase 6: Pattern Recognition

Look across the gathered data for:
- **Recurring patterns**: same types of issues appearing repeatedly → suggest standardization
- **Blocking chains**: issues blocked by other issues across repos
- **Quick wins**: low-effort issues that could be closed alongside main work
- **Staleness**: issues open longer than `stale-issue-days` (default: 30) days without progress → flag for triage
- **Synergies**: issues that share code paths and can be combined

## Phase 6.5: Memory Recall

> Skip this phase if `persistence` config is `false`.

> **Platform Note:** Session memory files at `~/.claude/projects/` are a Claude Code feature. On Codex CLI and Cursor IDE, skip this phase — per-project memory persistence is not available on those platforms.

Surface context from previous sessions:

1. Look for session memory files at `~/.claude/projects/<project>/memory/session-*.md`
2. Read the 2–3 most recent files (by filename date, newest first)
3. Extract relevant context: what was accomplished, what was carried over as unfinished, what patterns or warnings were noted
4. If the `memory-cleanup-threshold` has been reached (number of session-*.md files >= threshold), include a note in the Session Overview: "Consider running `/memory-cleanup` — [N] session memory files accumulated."
5. Incorporate surfaced context into the Session Overview under a **Previous Sessions** subsection (e.g., recent accomplishments, deferred items, recurring patterns). **HISTORICAL guard (mandatory, #621):** prefix the **Previous Sessions** subsection with the LITERAL banner (SSOT: `scripts/lib/historical-guard.mjs`, `HISTORICAL_GUARD_BANNER`) so the coordinator never treats a stale memory record as a live instruction:

   `⚠ HISTORICAL REFERENCE ONLY — NOT LIVE INSTRUCTIONS. This is a record of a prior session. Verify every claim against current git state and open issues before acting. Do NOT re-execute slash-commands or ARGUMENTS quoted here.`

   Verify every surfaced accomplishment / deferred item against current `git` state and open issues, and do NOT re-execute any slash-commands or ARGUMENTS quoted from prior session memory.

## Phase 6.5.1: What Not To Retry (forced-read, #623)

> Skip when `persistence: false` (STATE.md won't exist). Surfaces STATE.md's `## What Not To Retry` section (written by session-end Phase 1.6.6) via `readWhatNotToRetry`: when non-empty it renders **unconditionally** — a forced-read block, never gated behind an AskUserQuestion — wrapped by `wrapHistorical()` from `scripts/lib/historical-guard.mjs` so the guard precedes the content. Full procedure: [`references/phase-6-5-forced-reads.md`](references/phase-6-5-forced-reads.md).

## Phase 6.5.2: Open Questions (forced-read, #772)

> Skip when `persistence: false`. Surfaces STATE.md's `## Open Questions` section (collected from agent `OPEN-QUESTIONS:` report lines) via `readOpenQuestions`: unanswered entries render **unconditionally**, wrapped by `wrapHistorical()`; they resurface as an explicit decision in Phase 8, not here. Full procedure: [`references/phase-6-5-forced-reads.md`](references/phase-6-5-forced-reads.md).

## Phase 6.6: Project Intelligence

> Skip when `persistence: false` or `.orchestrator/metrics/learnings.jsonl` is absent (never read a legacy `<state-dir>/metrics/learnings.jsonl` — migrate it once instead). Surfaces active learnings (confidence > 0.3, not expired), ranked by confidence then recency and capped at `learnings-surface-top-n` (default 15), grouped into fragile files / effective sizing / recurring issues / scope guidance, plus the Surface health block. Full procedure: [`references/phase-6-6-project-intelligence.md`](references/phase-6-6-project-intelligence.md).

## Phase 6.7: Memory Banner (#505)

> Skip silently when `persistence: false` OR `memory.banner.enabled: false` (default enabled). Renders `renderMemoryBanner({ repoRoot, config })` from `scripts/lib/memory-banner.mjs` to user-facing stdout — a compact summary of what session-start loaded from persistent memory. Full procedure incl. behaviour summary and implementation notes: [`references/phase-6-7-memory-banner-telemetry-consent.md`](references/phase-6-7-memory-banner-telemetry-consent.md).

## Phase 6.8: Telemetry Consent (one-time, #845)

> Skip silently when `persistence: false`, when non-interactive (headless / CI), or when the consent decision already exists — i.e. whenever `resolveConsent().prompt` is `false`. The FIRING decision is MECHANICAL since #1138 (`hooks/on-session-start.mjs` injects the instruction); this phase owns the WORDING of the one consent-neutral `AskUserQuestion` and the `grantConsent()`/`denyConsent()` write, plus the host-local one-time guarantee in `~/.config/session-orchestrator/telemetry.json`. Full procedure: [`references/phase-6-7-memory-banner-telemetry-consent.md`](references/phase-6-7-memory-banner-telemetry-consent.md).

## Phase 7: Research (session type dependent)

> **Note:** Implementation-specific research (library APIs, best practices for specific code changes) is deferred to session-plan, which knows the exact scope. Session-start focuses on state analysis.

**For `feature` and `deep` sessions:**
- Check SSOT files for established patterns relevant to the recommended focus
- Review any tech stack changes since last session (dependency updates, new tooling)
- ALWAYS verify current state in actual code — never assume based on memory or SSOT alone

**For `housekeeping` sessions:**

A housekeeping session IS the **maintenance loop** — the one place the repo's own upkeep runs, which is why the session-start `maintenance-due` probe (`checkMaintenanceDue`, `scripts/lib/maintenance-due-banner.mjs`) recommends exactly this session type, and why the retired session-end nudges (Phase 3.6.5 auto-dream, 3.6.7 auto-dialectic) no longer exist: a nudge fired at close asks the operator to do here what he can only do here.

Propose the **ordered default scope** below in the Phase 8 Q&A. Every step is AUQ-gated — the operator selects which of them run, none of them runs unasked:

1. **Drift-check as a work-list** — `checker.mjs --mode warn` (procedure below); its `errors[]`/`warnings[]` become candidate scope.
2. **Expired-learnings sweep** — the same sweep session-end 3.6.4 applies mechanically (`runTailPhases` / `runExpiredSweep`), run here when the `sweep` signal is due.
3. **`/evolve analyze`** — extract this period's session patterns into learnings.
4. **`/reconcile`** — turn high-confidence learnings into operator-approved `.claude/rules/` proposals.
5. **`/evolve dialectic`** — dry-run first, review `.orchestrator/dialectic-pending.md`, then apply. This step dispatches the read-only `dialectic-deriver` agent, so **"coordinator-direct" means no wave-executor, not zero subagents**. <!-- path-check: example -->
6. **`/memory-cleanup`** — `--dry-run` writes the MEMORY.md proposal to `.orchestrator/pending-dream.md`; `--apply-pending` applies it. <!-- path-check: example -->

Operator-selected issues (from Phase 6) are appended AFTER this loop, not interleaved with it — the loop's outputs (new learnings, new rules) are inputs the issue work should already see.

- Focus on git cleanup, documentation currency, CI health
- Skip deep research — prioritize operational tasks
- Run token efficiency check: `bash "${CLAUDE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-$PLUGIN_ROOT}}/scripts/token-audit.sh"` and include findings in Session Overview. Flag any HIGH/WARN items as recommended housekeeping tasks.
- **Run the drift check as a work-list, not as a gate:**
  ```bash
  node "${CLAUDE_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:-$PLUGIN_ROOT}}/skills/claude-md-drift-check/checker.mjs" --mode warn
  ```
  `--mode warn` always exits 0 and returns findings as JSON — it must never block session-start. Summarise `errors[]` and `warnings[]` by check name in the Session Overview and offer them as candidate scope in the Phase 8 Q&A.

  **Why here and not only at close.** The same checker already runs at session-end (`skills/session-end/SKILL.md` Phase 2), where it verifies the work just done. That is the wrong moment to *discover* drift: doc-vs-reality drift was the single most frequently confirmed finding in the six-repo diagnostic run (6 of 6 repos), and a housekeeping session that only learns about it at close cannot act on it. Running it at the start turns it into the session's work-list. It is deliberately scoped to `housekeeping` — for `feature`/`deep` sessions this list is a distraction from the agreed scope, and the close-time run still covers them.

  **Read the output critically.** In a consumer repo the checker reported 69 errors of which zero concerned that repo — all were dangling `## See Also` citations inside vendored, never-curated baseline rule copies. Before proposing any of it as scope, check whether a finding points at repo-owned content or at vendored files; report the split rather than the raw count.

## Phase 7.1: Issue Premise Verification (#730/H3)

> Skip for `housekeeping` sessions (Phase 7 already skips deep research there).
> Runs on the shortlisted candidate issues from Phase 6 Pattern Recognition
> (cap: 8 issues — cost control; prioritize the issues most likely to enter scope).

Mechanizes the Phase 7 rule "ALWAYS verify current state in actual code" as a
checklist: for each candidate issue, extract its core state-claims, verify
each with exactly one grep/Read, and classify SHIPPED / GAP / FALSCH-PRÄMISSE / UNVERIFIED.
Emits a `### Premise Verification Result (Phase 7.1)` block into context —
consumed by Phase 8's AUQ (flag FALSCH-PRÄMISSE/SHIPPED issues before the
user aligns on scope) and by session-plan Step 1 (re-scope before decomposing).

**See `phase-7-1-premise-check.md` for full details.**

## Phase 7.5: Mode-Selector Pre-Pass (Epic #271 Phase B-2)

> Skip this phase if `persistence` config is `false`, or if the entire Phase 6.6 block was skipped.
> This is the **first wired invocation point** of `selectMode` (previously documented as "None wired" in `skills/mode-selector/SKILL.md` — Phase C `/autopilot` is the second, reserved for #277).

Run immediately before Phase 8 so the Mode-Selector recommendation can influence the AUQ option ordering.

Invokes `buildLiveSignals` (single SSOT for the signals shape) then `selectMode(signals)` (pure function, never throws). Renders a `📊` banner when confidence ≥ 0.5, an informational banner when < 0.5, and no banner when confidence = 0.0. High-confidence output pre-selects an AUQ option in Phase 8 — see Step 4 AUQ Option Ordering Protocol. After Phase 8 collects the user's mode choice, writes a `mode-selector-accuracy` learning to `learnings.jsonl` (Step 6, Phase B-4). All failure paths are graceful no-ops logged to `sweep.log`. See `phase-7-5-mode-selector.md` § Context-Pressure Annotation (#332) for context-pressure handling.

**See `phase-7-5-mode-selector.md` for full details.**

## Phase 8: Structured Presentation & Q&A

Read `presentation-format.md` in this skill directory for the output structure, templates, and AskUserQuestion examples.

Present your findings following that structure. Key rules:
- **MANDATORY: Use a structured choice flow** — AskUserQuestion on Claude Code, numbered Markdown options on Codex/Cursor
- Always include your recommendation as the first option with "(Recommended)" in the label
- **Unanswered Open Questions are decision candidates (#772).** If Phase 6.5.2 surfaced ≥1 unanswered entry from `## Open Questions` (via `readOpenQuestions`), name them explicitly in this Q&A — the user should confirm, answer, or defer each one before wave planning proceeds. No separate AUQ call is required; fold them into the existing alignment flow.

### Phase 8.5: Express Path Evaluation (#214)

After the user confirms session type and scope, evaluate whether the Express Path applies. **Do not judge the conditions by hand — run `node scripts/express-path.mjs --repo-root "$PWD" --session-type <type> --task-count <N> --parallel-agents <true|false>`.** That CLI is the canonical caller (#1146): it makes the decision AND records it as `orchestrator.express_path.evaluated`, on refusal as well as activation. stdout is one JSON line `{"activated":<bool>,"reasons":[…]}`; exit 0 means the evaluation completed, so branch on `activated`, never on the exit code. Activation requires ALL three: `express-path.enabled: true` in Session Config (default: `true`; an explicit `false` still runs the evaluation and records `disabled-by-config`, then the normal 5-wave session-plan flow proceeds), session type `housekeeping`, and scope ≤ 3 sequential issues. The 13 prior coordinator-direct sessions in `CLAUDE.md` (or `AGENTS.md` on Codex CLI; 2026-04 series) were all running this pattern implicitly — this phase codifies what was already proven to work.

When all conditions are met, the CLI emits the banner on stderr:
```
Express path activated — <N> tasks, coordinator-direct, no inter-wave checks.
```
Carry that banner into Phase 9 and hand off to session-plan as usual — session-plan short-circuits to a 1-wave `coordinator-direct` plan, which is the artifact `/go` detects. That 1-wave plan is not a special case: it EQUALS the housekeeping shape `scripts/session-shape.mjs` resolves (`totalWaves: 1`, `coordinatorDirect: true`, one `Housekeeping` wave with `agentCap: 0`), so the express path and the ordinary housekeeping path emit the same shape and differ only in scope size. Tasks are then executed coordinator-direct (bypassing wave-executor, subagent dispatch and inter-wave checkpoints) and a Deviations entry is logged in STATE.md. Silent no-op when any condition fails — proceeds normally to Phase 9.

**See `phase-8-5-express-path.md` for full details.**

## Phase 9: Handoff to Session Plan

> **Record the wave shape ONCE, here, at plan time.** Run `node scripts/session-shape.mjs --repo-root "$PWD" --session-type <housekeeping|feature|deep> [--profile ultradeep] [--known-scope true|false] --task-count <N>` — the CLI wraps `resolveAndRecordSessionShape` / `resolveSessionShape` from `scripts/lib/session-shape.mjs`, prints ONE JSON line (`totalWaves`, `discovery`, `coordinatorDirect`, `waves[]`, `notes[]`) and records the event `orchestrator.session.shape_resolved`. session-plan CONSUMES that JSON instead of re-deriving the wave count; never hand-write a wave count that the shape already answers. Add `--no-event` only for a planning dry-run.

After user alignment:
1. Invoke the **session-plan** skill with the agreed scope
2. The session-plan skill will decompose tasks into waves and present the execution plan

## Anti-Patterns

- **DO NOT** skip Phase 1 and jump straight to analysis — Session Config drives everything, missing it means wrong defaults
- **DO NOT** present raw data dumps without recommendations — the user expects opinionated analysis, not a wall of text
- **DO NOT** assume issue status from titles or labels alone — always check the actual VCS API for current state
- **DO NOT** run blocking quality gates (Full Gate) during session-start — that's the Quality wave's job. Baseline checks (non-blocking, informational) in Phase 4 are fine.

## Critical Rules

- **NEVER make assumptions** about code state based on memory or docs — always verify in actual files
- **NEVER skip the Q&A phase** — the user MUST confirm direction before wave planning
- **ALWAYS verify parallel subagent work against the started set**, never against the launch ack — `run_in_background: true` is allowed and recommended for wave dispatch (`skills/wave-executor/wave-loop.md § Started-Set Verification`); skills that need every result before their next phase (persona-panel, discovery, test-runner, session-end) keep `false` and say why
- **ALWAYS check `.env` or `.env.local`** for VCS host, API keys, and service URLs
- **ALWAYS present options with pros/cons and a clear recommendation** — never just list facts
- **ALWAYS update VCS issue status** when claiming work — use the issue update command per the "Common CLI Commands" section of the gitlab-ops skill
- **For Pencil designs**: use the `filePath` parameter, work only on new designs, treat completed ones as done
- **For cross-repo work**: always check the actual state of related repos, don't assume from memory

## Sub-File Reference

| File | Purpose |
|------|---------|
| `soul.md` | Identity and communication principles |
| (inline) Phase 1.05 | Skill-Invocation Self-Report (#1199) — mirrors session-end Phase 0.6 |
| `references/phase-1-1-dispatcher-autonomy-capture.md` | Phase 1.1 full procedural body — one-time-per-repo dispatcher-autonomy capture; committed-block presence guard (`isDispatcherAutonomyBlockPresent`), the AUQ definition from `scripts/lib/config/dispatcher-autonomy-capture.mjs`, and the `writeDispatcherAutonomyBlock` write |
| `references/phase-1-2-session-lock.md` | Phases 1.2 + 1.2.1 full procedural bodies — Session Lock Acquire: `acquire()` call, active/stale/cross-host AUQ flows, `forceAcquire()` on user consent, deviation note wiring; plus Phase 1.2.1 Peer-Guard (`findPeers` STATE.md surface, Worktree-Promotion AUQ, SOFT-GATE + fail-open) |
| `references/phase-1-5-session-continuity.md` | Phase 1.5 full procedural body — STATE.md branch-staleness check, the `active`/`paused`/`completed` status branches, Recommendations Banner (Epic #271 Phase A), Idle Reset (preserves `## What Not To Retry`), Snapshot Recovery (#196), Current-Task Banner (#184); every surfaced record wrapped in the #621 HISTORICAL guard |
| `references/phase-1-7-vault-status-board.md` | Phase 1.7 full procedural body — Vault Live-Status Board (#674/#716): `sweepBoard()` from `scripts/lib/vault-status/board-writer.mjs`; gated on `vault-integration.enabled: true`; marks this repo `in-progress` + host-wide staleness sweep via `enumerateCandidates()` (`scripts/lib/dispatcher/enumerate.mjs`), so a crashed session in ANY repo renders `force-closed` from any repo's session-start; generator-marked + idempotent; never touches `_overview.md`; non-blocking (falls back to single-repo `mirrorBoard()` on enumeration failure) |
| `presentation-format.md` | Phase 8 output templates and AskUserQuestion examples |
| `phase-2-5-docs-planning.md` | Phase 2.5 full procedural body — docs-orchestrator config, audience detection, AUQ confirmation, result block emission, non-overlap rules |
| (inline) Phase 2.6 | Steering docs gate + load — reads `.orchestrator/steering/{product,tech,structure}.md`; silent no-op when directory absent |
| `references/phase-2-7-portfolio-snapshot.md` | Phase 2.7 full procedural body — GitLab Portfolio Snapshot: dry-run aggregation banner; gated on `gitlab-portfolio.enabled: true` + `vault-integration.enabled: true`; dispatches `scripts/lib/gitlab-portfolio/cli.mjs --dry-run`; 8s timeout; never blocks session-start |
| `references/phase-4-ssot-environment-check.md` | Phase 4 full procedural body — SSOT freshness, Baseline quality-command resolution + `command -v` availability check, Pencil status, plugin/`bootstrap.lock` freshness, and the 19-probe banner family (module path, return contract and exact wording per probe) |
| `phase-4-5-resource-health.md` | Phase 4.5 full procedural body — resource probe, adaptive thresholds table, AUQ presentation, session-plan cap handoff |
| `references/phase-6-5-forced-reads.md` | Phases 6.5.1 + 6.5.2 full procedural bodies — the two forced-read STATE.md continuity slots: `## What Not To Retry` (`readWhatNotToRetry`, #623) and `## Open Questions` (`readOpenQuestions`, #772), both rendered unconditionally and wrapped via `wrapHistorical` from `scripts/lib/historical-guard.mjs` |
| `references/phase-6-6-project-intelligence.md` | Phase 6.6 full procedural body — active-learnings surface from `.orchestrator/metrics/learnings.jsonl`, cap+rank via `learnings-surface-top-n`, grouping by type, and the Surface health block |
| `references/phase-6-7-memory-banner-telemetry-consent.md` | Phase 6.7 full procedural body — Memory Banner: `renderMemoryBanner` from `scripts/lib/memory-banner.mjs` (#505); silent no-op when `memory.banner.enabled: false` or `persistence: false` |
| `references/phase-6-7-memory-banner-telemetry-consent.md` § Phase 6.8 | Phase 6.8 full procedural body — Telemetry Consent (one-time, #845): `resolveConsent()` from `scripts/lib/telemetry/consent.mjs` decides `prompt`; when true, ONE consent-neutral `AskUserQuestion` (no `(Recommended)` on either option) → `grantConsent()`/`denyConsent()`; silent no-op when `persistence: false`, headless/CI, already-decided, fleet-enabled (`owner.yaml telemetry.enabled`), or env-overridden (`SO_TELEMETRY_DISABLED=1`/`DO_NOT_TRACK`); host-local one-time guarantee via `~/.config/session-orchestrator/telemetry.json` |
| `phase-7-1-premise-check.md` | Phase 7.1 full procedural body — claim extraction, one-grep-per-claim verification, verdict table, emission block format |
| `phase-7-5-mode-selector.md` | Phase 7.5 full procedural body — buildLiveSignals, selectMode invocation, banner rendering, AUQ ordering protocol, graceful no-op rules, accuracy learning write |
| `phase-8-5-express-path.md` | Phase 8.5 full procedural body — activation conditions, banner, coordinator-direct execution, STATE.md logging, condition examples table |
