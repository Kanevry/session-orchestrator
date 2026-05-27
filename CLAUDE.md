# Session Orchestrator Plugin

> Project-instruction file resolution: this is `CLAUDE.md` on Claude Code / Cursor IDE; the equivalent file on Codex CLI is `AGENTS.md`. See [skills/_shared/instruction-file-resolution.md](skills/_shared/instruction-file-resolution.md).

> Lean root by design (Anthropic large-codebase best-practice: root = pointers + critical gotchas). Delegated docs:
> - **Install, CLI usage, architecture, component inventory** → [`README.md`](./README.md) ([§Components](./README.md#components))
> - **Sub-agent authoring spec** (frontmatter, body, `sandbox-tier`, `output-schema`) → [`agents/AGENTS.md`](./agents/AGENTS.md)
> - **Stable product/tech/structure context** → [`.orchestrator/steering/`](./.orchestrator/steering/) (injected at session-start Phase 2.6)
> - **Always-on + path-scoped rules** → [`.claude/rules/`](./.claude/rules/)
> - **Session narrative & decisions log** → [[01-projects/session-orchestrator/decisions]] in the Meta-Vault

## Critical Gotchas <!-- consistency:exempt:lean-root-pointer-section -->

These are the non-obvious, mistake-causing facts that must load every session. Everything else is delegated above.

- **CI status is the source of truth at session-start.** Local-only test runs are insufficient evidence of CI green. Phase 4 of session-start invokes `scripts/lib/ci-status-banner.mjs` via `checkCiStatus({ repoRoot })` to render a 🚨 banner when CI is red on HEAD. Never claim CI green from `npm test` alone — the 8-pipeline silent regression (2026-05-09 → 2026-05-10, fixed in deep-2) is the cautionary tale. <!-- consistency:exempt:runtime-only -->
- **Destructive-Command Guard is active in main + subagent waves.** `hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands per `.orchestrator/policy/blocked-commands.json` (13 rules). Rule source of truth: [`.claude/rules/parallel-sessions.md`](.claude/rules/parallel-sessions.md) (PSA-003). Per-session bypass via Session Config: `allow-destructive-ops: true` (intentional maintenance only).
- **Session Config below is runtime-critical.** `scripts/parse-config.mjs` parses the `## Session Config` block; `claude-md-drift-check` Check 6 enforces top-level-key parity against `docs/session-config-template.md`. Edit it like code, not prose — a dropped key changes runtime behaviour.
- **Live state is not in this file.** Stack: Node 20+, vitest, ESLint 10 (`npm ci` after clone). Test counts, backlog, version, component inventory drift fast — the SSOT is README badges + `.orchestrator/metrics/sessions.jsonl`. Per-session detail lives in the Meta-Vault decisions log (linked above), not here.
- **`memory.propose` requires `SO_WAVE_AGENT=1`.** `scripts/memory-propose.mjs` exits `3` (`rejected-wrong-context`) unless `process.env.SO_WAVE_AGENT === '1'`. The wave-executor boilerplate (see `skills/wave-executor/SKILL.md`) sets this env-var for every dispatched agent automatically. Direct invocation from the coordinator thread will always be rejected — use `/evolve` there instead. Full status dict: `queued` (0), `quota-exceeded` (1), `rejected-low-confidence` (2), `rejected-wrong-context` (3), `error` (4). See `docs/session-config-reference.md` § Memory Proposals. <!-- consistency:exempt:runtime-only -->
- **Auto-promoted worktree cleanup is Hybrid Pattern (Anthropic-style).** When a session ran in a sibling worktree created via `enterWorktree()` (Phase 0.5 PROMOTION_OFFER outcome), `/close` Phase 4a detects this (`parseSessionId().format === 'semantic'` + path matches `<basePath>/<repo-name>-<sessionId>/`). Clean worktree → auto-remove with WARN. Dirty (uncommitted/untracked/unpushed) → AUQ `[Behalten/Löschen/Manuell]`. The Phase 4a cleanup runs AFTER Phase 4 commit+push, not before — this respects #490 durableCommit ordering so sessions.jsonl + STATE.md are persisted to origin BEFORE worktree-removal. PSA-003 compliance enforced. Implementation: `skills/session-end/SKILL.md § Phase 4a`. <!-- consistency:exempt:runtime-only -->

## Layered Instruction Files <!-- consistency:exempt:lean-root-pointer-section -->

This repo uses Anthropic's additive instruction-file layering pattern: this root for the big picture, nested files for local conventions.

| File | Scope | Loaded |
|---|---|---|
| `CLAUDE.md` / `AGENTS.md` (root) | This file — pointers + critical gotchas + Session Config | every session |
| [`agents/AGENTS.md`](./agents/AGENTS.md) | Sub-agent authoring spec + local validation commands | when working under `agents/` |
| [`.orchestrator/steering/{product,tech,structure}.md`](./.orchestrator/steering/) | Stable project context | session-start Phase 2.6 |
| [`.claude/rules/*.md`](./.claude/rules/) | Always-on + glob-scoped engineering rules | per-wave via `rule-loader.mjs` |

> **Opt-in visualization:** **`/tmux-layout`** renders a 4-pane operator side-channel (STATE.md tail, CI-watch, events.jsonl) in a second terminal — see [ADR-0007](docs/adr/0007-tmux-visualization-substrate.md). Coordinator chat stays in your original terminal (AUQ-001). PSA-003-compliant (`--force` required to replace an existing layout).

## Session Config

persistence: true
enforcement: warn
agents-per-wave: 6 (deep: 18)   # base 6; deep sessions use 18 — see config-reading.md override syntax
waves: 5
recent-commits: 20
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
stale-branch-days: 7
plugin-freshness-days: 30
plan-baseline-path: ~/Projects/projects-baseline
plan-prd-location: docs/prd
plan-retro-location: docs/retro
plan-default-visibility: internal
vcs: gitlab
auto-skill-dispatch: false               # opt-in; phrase-match meta-skill — see skills/using-orchestrator/SKILL.md
vault-integration:
  enabled: true
  vault-dir: ~/Projects/Bernhard/vault
  mode: warn               # strict | warn | off
docs-orchestrator:
  enabled: false           # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]
  mode: warn               # warn | strict | off
vault-staleness:
  enabled: false           # opt-in vault-drift probes (runs in /discovery vault)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
  mode: warn               # warn | strict | off
wave-reviewers:
  enabled: false           # opt-in inter-wave architecture/QA/PRD audits
  reviewers: []            # ["architect-reviewer", "qa-strategist", "analyst"]
  mode: warn               # warn | strict | off
memory-cleanup-soft-limit: 180   # PRD F2.2 (#502) — hard ceiling on memory file count before nudge
vault-mirror:
  quality:
    min-narrative-chars: 400     # PRD F1.2 (#504) — min vault note body length before mirror
    min-confidence: 0.5          # PRD F1.2 (#504) — min learning confidence (0.0..1.0) before mirror
memory:
  banner:
    enabled: true                # PRD F2.3 (#505) — silence the session-start "📚 Loaded from memory" banner when false
  proposals:
    enabled: true                # PRD F2.1 (#501) — agent-writable memory tool (memory.propose CLI + session-end AUQ)
    quota-per-wave: 5            # max proposals per wave-executor agent
    confidence-floor: 0.5        # below this confidence, propose() returns rejected-low-confidence
cold-start:
  enabled: true                  # PRD F1.3 (#500) — silence cold-start nudges when false
  nudge-after-hours: 1           # PRD F1.3 (#500) — hours of idle before cold-start nudge fires
  silence-after-sessions: 1      # PRD F1.3 (#500) — consecutive silent sessions before nudge fires
state-md-lock:
  enabled: true                  # PRD gsd Pattern 1 (#518) — mechanical STATE.md write lock
  timeout-ms: 10000              # acquire timeout
slopcheck:
  enabled: false                 # PRD gsd Pattern 2 (#520) — opt-in package legitimacy gate
  sources: [plan, discovery]     # where classifyPackages is invoked
templates-first:
  enabled: true                  # PRD gsd Pattern 3 (#519) — gh/glab template-read enforcement
  hosts: [github, gitlab]        # host-regex allow-list
verification-auto-fix:
  enabled: false                 # PRD gsd Pattern 4 (#521) — opt-in auto-fix retry loop after Quality-Gate fail
  max-retries: 2                 # bounded retries
