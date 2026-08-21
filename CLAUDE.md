# Session Orchestrator Plugin

> Project-instruction file resolution: this is `CLAUDE.md` on Claude Code / Cursor IDE; the equivalent file on Codex CLI is `AGENTS.md`. See [skills/_shared/instruction-file-resolution.md](skills/_shared/instruction-file-resolution.md).

> Lean root by design (Anthropic large-codebase best-practice: root = pointers + critical gotchas). Delegated docs:
> - **Install, CLI usage, architecture, component inventory** → [`README.md`](./README.md) ([§Components](./README.md#components))
> - **Sub-agent authoring spec** (frontmatter, body, `sandbox-tier`, `output-schema`) → [`agents/AGENTS.md`](./agents/AGENTS.md)
> - **Stable product/tech/structure context** → [`.orchestrator/steering/`](./.orchestrator/steering/) (injected at session-start Phase 2.6)
> - **Always-on + path-scoped rules** → [`.claude/rules/`](./.claude/rules/) (per-wave via `rule-loader.mjs`, #336/#694); authoring spec → [`docs/rule-authoring.md`](./docs/rule-authoring.md)
> - **Session narrative & decisions log** → [[01-projects/session-orchestrator/decisions]] in the Meta-Vault
> - **Operator tmux side-channel** → `/tmux-layout` (4-pane: STATE.md/CI-watch/events; [ADR-0007](docs/adr/0007-tmux-visualization-substrate.md))
>
> Additive instruction-file layering: this root for the big picture, nested files (`agents/AGENTS.md`, `.claude/rules/*.md`) for local conventions.

## Current State <!-- consistency:exempt:lean-root-pointer-section -->

State-free by design (see the **Live state is not in this file** gotcha below). The live version, test/coverage counts, backlog, and component inventory live in their SSOTs — never inline here, because they drift faster than this file is edited:
- **Version + test/coverage** → README badges
- **Per-session metrics & history** → [`.orchestrator/metrics/sessions.jsonl`](./.orchestrator/metrics/sessions.jsonl)
- **Session narrative & decisions** → [[01-projects/session-orchestrator/decisions]] (Meta-Vault)

## Critical Gotchas <!-- consistency:exempt:lean-root-pointer-section -->

These are the non-obvious, mistake-causing facts that must load every session. Everything else is delegated above.

- **CI status is the source of truth at session-start.** Local-only test runs are insufficient evidence of CI green.
  Phase 4 of session-start invokes `scripts/lib/ci-status-banner.mjs` via `checkCiStatus({ repoRoot })` to render a 🚨 banner when CI is red on HEAD.
  Never claim CI green from `npm test` alone — the 8-pipeline silent regression (2026-05-09 → 2026-05-10, fixed in deep-2) is the cautionary tale. <!-- consistency:exempt:runtime-only -->
- **Destructive-Command Guard is active in main + subagent waves.** `hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands per `.orchestrator/policy/blocked-commands.json` (14 rules).
  Rule source of truth: [`.claude/rules/parallel-sessions.md`](.claude/rules/parallel-sessions.md) (PSA-003). Per-session bypass via Session Config: `allow-destructive-ops: true` (intentional maintenance only).
- **Session Config below is runtime-critical.** `scripts/parse-config.mjs` parses the `## Session Config` block; `claude-md-drift-check` Check 6 enforces top-level-key parity against `docs/session-config-template.md`. Edit it like code, not prose — a dropped key changes runtime behaviour.
- **Live state is not in this file.** Stack: Node 24+, vitest, ESLint 10 (`npm ci` after clone). Test counts, backlog, version, component inventory drift fast — the SSOT is README badges + `.orchestrator/metrics/sessions.jsonl`. Per-session detail lives in the Meta-Vault decisions log (linked above), not here.
- **`memory.propose` requires `SO_WAVE_AGENT=1`.** `scripts/memory-propose.mjs` exits `3` (`rejected-wrong-context`) unless `process.env.SO_WAVE_AGENT === '1'`.
  The wave-executor boilerplate (see `skills/wave-executor/SKILL.md`) sets this env-var for every dispatched agent automatically. Direct invocation from the coordinator thread will always be rejected — use `/evolve` there instead.
  Full status dict: `queued` (0), `dry-run-ok` (0, validate-only via `--dry-run` — validates + prints, never writes proposals.jsonl; #741.3), `quota-exceeded` (1), `rejected-low-confidence` (2), `rejected-wrong-context` (3), `error` (4).
  See `docs/session-config-reference.md` § Memory Proposals. <!-- consistency:exempt:runtime-only -->
- **Auto-promoted worktree cleanup is Hybrid Pattern (Anthropic-style).** When a session ran in a sibling worktree created via `enterWorktree()` (Phase 0.5 PROMOTION_OFFER outcome), `/close` Phase 4a detects this (`parseSessionId().format === 'semantic'` + path matches `<basePath>/<repo-name>-<sessionId>/`).
  Clean worktree → auto-remove with WARN. Dirty (uncommitted/untracked/unpushed) → AUQ `[Behalten/Löschen/Manuell]`.
  The Phase 4a cleanup runs AFTER Phase 4 commit+push, not before — this respects #490 durableCommit ordering so sessions.jsonl + STATE.md are persisted to origin BEFORE worktree-removal.
  PSA-003 compliance enforced. Implementation: `skills/session-end/SKILL.md § Phase 4a`. <!-- consistency:exempt:runtime-only -->
- **`allowedPaths` is COMPUTED, and the scope declaration has TWO shapes — writing only one is the silent failure (#1020).**
  (a) **Per agent**, `<state-dir>/filescopes/wave-<N>/<agent-id>.json`, a JSON array of path STRINGS. This is `$AGENT_FILESCOPE_JSON` — what the `FILE-SCOPE` prompt injection, the Learnings-Index and `--assert-subset` read.
  (b) **Per wave**, ONE aggregate sidecar holding an array of `{id, files}` RECORDS, built from every file in (a) plus the coordinator's own. This is the only thing `--assert-disjoint` and `--union` accept: pass them the wave directory and you get `Cannot read --union file`; pass them a single (a)-file and you get `must be a JSON array of {id, files} records`.
  `node scripts/materialize-wave-scope.mjs --state-dir <state-dir> --wave <N>` is the canonical writer: it receives that one record array on stdin, writes every (a) file first, then (b) last. Neither is a `$TMPDIR` copy, and neither substitutes for the other. Skipping (a) degrades the chain to signal-free ALLOW: no `FILE-SCOPE` block reaches the prompt, so `hooks/pre-task-scope-disjoint.mjs` extracts nothing, permits the dispatch, and writes no ledger entry — the absence looks identical to a clean run.
  **Measured 2026-08-19:** a coordinator that wrote only (b) ran SIX waves and ~27 dispatches with zero injection; `.orchestrator/wave-dispatch-scopes.json` still carried a `|w2|` entry from two days earlier. Only `wave-scope.json` `allowedPaths` (global Gate 7) was live, which is why blocks still fired and the gap stayed invisible.
  The coordinator's OWN direct edits go in a `coordinator.json` under (a) **and must be folded into (b)** — a `coordinator.json` that is never folded in is read by nothing. 2 of the 5 recorded divergences were coordinator-direct edits, which no agent scope file covers by construction.
  Mechanism, error-class matrix and named limits: [`docs/scope-collision-guard.md`](docs/scope-collision-guard.md); the authoritative two-stage procedure is `skills/wave-executor/wave-loop.md` § Scope Manifest 3.1/3.2. <!-- consistency:exempt:runtime-only -->
- **`vault-dir` resolves HOST-LOCALLY — a hand-run vault probe writes into the operator's REAL vault.** Precedence is `SO_VAULT_DIR` > `owner.yaml` `paths.vault-dir` > the committed `vault-integration.vault-dir` below (`scripts/lib/config/host-paths.mjs`); the literal value in this file LOSES against both.
  So a throwaway invocation of a vault writer (`mirrorNarrative()`, `vault-mirror.mjs`, the board writer) with a synthetic `repoRoot` does **not** land in a sandbox — the fake repo path only fakes the SOURCE, never the DESTINATION. A reviewer in this repo walked into exactly that.
  Export `SO_VAULT_DIR=<tmpdir>` before ANY manual invocation of vault-writing code. <!-- consistency:exempt:runtime-only -->

## Session Config

persistence: true
enforcement: warn
agents-per-wave: 6 (deep: 18)
waves: 5
recent-commits: 20
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
stale-branch-days: 7
plugin-freshness-days: 30
plan-baseline-path: OVERRIDE-IN-owner.yaml   # placeholder, NOT a real path — resolve host-locally
plan-prd-location: docs/prd
plan-retro-location: docs/retro
plan-default-visibility: internal
vcs: gitlab
auto-skill-dispatch: false
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn
  vault-name:
docs-orchestrator:
  enabled: false
  audiences: [user, dev, vault]
  mode: warn
vault-staleness:
  enabled: false
  thresholds:
    top: 30
    active: 60
    archived: 180
  mode: warn
docs-staleness:
  enabled: false
  thresholds:
    living: 90
  mode: warn
moc-staleness:
  enabled: false
  thresholds:
    moc: 90
  mode: warn
context-coverage:
  enabled: false
  mode: warn
worktree-orphans:
  enabled: false
  base-branch: main
  mode: warn
drift-check:
  enabled: true
  mode: warn
  check-docs-parity: true
wave-reviewers:
  enabled: false
  reviewers: []
  mode: warn
memory-cleanup-soft-limit: 180
vault-mirror:
  quality:
    min-narrative-chars: 400
    min-confidence: 0.5
memory:
  banner:
    enabled: true
  proposals:
    enabled: true
    quota-per-wave: 5
    confidence-floor: 0.5
auto-dream:
  min-confidence: 0.5
cold-start:
  enabled: true
  nudge-after-hours: 1
  silence-after-sessions: 1
state-md-lock:
  enabled: true
  timeout-ms: 10000
handover-gate:
  enabled: true
  max-open-questions: 3
issue-budget:
  max-per-session: 12
  mode: strict
  overflow: collect-issue
broken-window-budget:
  enabled: false
  due-days: 7
slopcheck:
  enabled: false
  sources: [plan, discovery]
templates-first:
  enabled: true
  hosts: [github, gitlab]
verification-auto-fix:
  enabled: false
  max-retries: 2
discovery-validator:
  enabled: true
frontend-slop-hook:
  enabled: false
loop-guard:
  enabled: true
  threshold: 3
  window: 5
instruction-budget:
  enabled: true
  ceiling: 480
  mode: warn
config-protection:
  enabled: true
  mode: warn
allow-config-weakening: false
custom-phases:
  - name: archive-closed-prds
    when: both
    command: node scripts/archive-closed-prds.mjs --apply
    mode: warn
  - name: archive-closed-plans
    when: both
    command: node scripts/archive-closed-prds.mjs --apply --prd-dir docs/plans --vault-subdir 01-projects/session-orchestrator/plans
    mode: warn
evolve:
  extra-sources: []
dialectic:
  cadence: 5
  model: haiku
  budget-tokens: 32000
eval:
  enabled: true
  mode: warn
  judge: off
  report: html
  handle:
reconcile:
  enabled: false
  mode: warn
  targets: [repo-local]
  rule-expiry-days: null
  confidence-floor: 0.5
  min-rule-days: 7
  min-insight-chars: 24

## Skill Evolution <!-- consistency:exempt:parity-exempt-skill-evolution-block -->

> Opt-in self-evolution autonomy gate (Epic #643). A DISTINCT top-level block from the `evolve:` Session Config key above — `scripts/lib/config/skill-evolution.mjs` parses it independently of the `## Session Config` boundary, so `claude-md-drift-check` Check 6 (session-config-parity) never flags it.
> See `docs/session-config-reference.md` § Skill Evolution for the #652 activation history, the C2/H1-guard detail, and the quadruple-gate + MR-only rules.

skill-evolution:
  autonomy: autonomous-gated      # off | advisory | autonomous-gated — armed (#652)
  evidence-floor: 0.5             # float 0.0..1.0 — min evidence before an autonomous-gated repair acts
  judge: off                      # opt-in session-end LLM-judge (advisory only); default off

## Dispatcher Autonomy <!-- consistency:exempt:parity-exempt-dispatcher-autonomy-block -->

> **Parity-exempt section** (Epic #673, #679). Intentionally OUTSIDE `## Session Config` so `claude-md-drift-check` Check-6 (session-config-parity) does not flag repos that have not adopted this feature — `scripts/lib/config/dispatcher-autonomy.mjs` parses it independently.
> This block's committed presence is itself the never-re-ask marker (session-start Phase 1.1 migration trigger). Effective autonomy resolves host-locally: env > `owner.yaml` > committed > `off`.
> See `docs/session-config-reference.md` § Dispatcher Autonomy for the #681 capture history and the full precedence chain.

dispatcher-autonomy:
  autonomy: off            # off | advisory | autonomous-gated — default off (fail-closed)
  confidence-floor: 0.5    # float 0.0..1.0
