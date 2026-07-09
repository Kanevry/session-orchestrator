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

- **CI status is the source of truth at session-start.** Local-only test runs are insufficient evidence of CI green. Phase 4 of session-start invokes `scripts/lib/ci-status-banner.mjs` via `checkCiStatus({ repoRoot })` to render a 🚨 banner when CI is red on HEAD. Never claim CI green from `npm test` alone — the 8-pipeline silent regression (2026-05-09 → 2026-05-10, fixed in deep-2) is the cautionary tale. <!-- consistency:exempt:runtime-only -->
- **Destructive-Command Guard is active in main + subagent waves.** `hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands per `.orchestrator/policy/blocked-commands.json` (13 rules). Rule source of truth: [`.claude/rules/parallel-sessions.md`](.claude/rules/parallel-sessions.md) (PSA-003). Per-session bypass via Session Config: `allow-destructive-ops: true` (intentional maintenance only).
- **Session Config below is runtime-critical.** `scripts/parse-config.mjs` parses the `## Session Config` block; `claude-md-drift-check` Check 6 enforces top-level-key parity against `docs/session-config-template.md`. Edit it like code, not prose — a dropped key changes runtime behaviour.
- **Live state is not in this file.** Stack: Node 24+, vitest, ESLint 10 (`npm ci` after clone). Test counts, backlog, version, component inventory drift fast — the SSOT is README badges + `.orchestrator/metrics/sessions.jsonl`. Per-session detail lives in the Meta-Vault decisions log (linked above), not here.
- **`memory.propose` requires `SO_WAVE_AGENT=1`.** `scripts/memory-propose.mjs` exits `3` (`rejected-wrong-context`) unless `process.env.SO_WAVE_AGENT === '1'`. The wave-executor boilerplate (see `skills/wave-executor/SKILL.md`) sets this env-var for every dispatched agent automatically. Direct invocation from the coordinator thread will always be rejected — use `/evolve` there instead. Full status dict: `queued` (0), `dry-run-ok` (0, validate-only via `--dry-run` — validates + prints, never writes proposals.jsonl; #741.3), `quota-exceeded` (1), `rejected-low-confidence` (2), `rejected-wrong-context` (3), `error` (4). See `docs/session-config-reference.md` § Memory Proposals. <!-- consistency:exempt:runtime-only -->
- **Auto-promoted worktree cleanup is Hybrid Pattern (Anthropic-style).** When a session ran in a sibling worktree created via `enterWorktree()` (Phase 0.5 PROMOTION_OFFER outcome), `/close` Phase 4a detects this (`parseSessionId().format === 'semantic'` + path matches `<basePath>/<repo-name>-<sessionId>/`). Clean worktree → auto-remove with WARN. Dirty (uncommitted/untracked/unpushed) → AUQ `[Behalten/Löschen/Manuell]`. The Phase 4a cleanup runs AFTER Phase 4 commit+push, not before — this respects #490 durableCommit ordering so sessions.jsonl + STATE.md are persisted to origin BEFORE worktree-removal. PSA-003 compliance enforced. Implementation: `skills/session-end/SKILL.md § Phase 4a`. <!-- consistency:exempt:runtime-only -->

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
plan-baseline-path: ~/Projects/projects-baseline   # host-local override: SO_BASELINE_PATH > owner.yaml paths.baseline-path > this default (#653)
plan-prd-location: docs/prd
plan-retro-location: docs/retro
plan-default-visibility: internal
vcs: gitlab
auto-skill-dispatch: false               # opt-in; phrase-match meta-skill — see skills/using-orchestrator/SKILL.md
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault    # host-local override: SO_VAULT_DIR > owner.yaml paths.vault-dir > this default (#653)
  mode: warn               # strict | warn | off
  vault-name:              # optional (#660) — overrides git-derived repo slug for per-project vault namespacing; null/absent → deriveRepo()
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
docs-staleness:
  enabled: false           # opt-in — #781 (Epic #774) — mtime-staleness probe für docs/*.md (root) + docs/examples/*.md; docs/adr/ + docs/prd/ bewusst ausgenommen
  thresholds:
    living: 90             # days — single tier; severity eskaliert bei 1×/2×/3× threshold
  mode: warn               # strict | warn | off
drift-check:
  enabled: true            # #780 (Epic #774) — session-end Phase 2.2 Narrative-Drift-Gate; alle check-*-Flags defaulten true
  mode: warn               # warn (report, exit 0) | hard (exit 1 on errors)
  check-docs-parity: true  # Check 10 — components.md-Zähl-Claims, Template↔Reference-Key-Parität, Metrics-Pfad-Liveness
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
auto-dream:
  min-confidence: 0.5            # issue #566 — filter applied at memory-proposals collect-emit (session-end Phase 3.6.3); SECOND gate above memory.proposals.confidence-floor — inert at default; only bites when set HIGHER than confidence-floor (persist-medium / surface-high)
cold-start:
  enabled: true                  # PRD F1.3 (#500) — silence cold-start nudges when false
  nudge-after-hours: 1           # PRD F1.3 (#500) — hours of idle before cold-start nudge fires
  silence-after-sessions: 1      # PRD F1.3 (#500) — consecutive silent sessions before nudge fires
state-md-lock:
  enabled: true                  # PRD gsd Pattern 1 (#518) — mechanical STATE.md write lock
  timeout-ms: 10000              # acquire timeout
handover-gate:
  enabled: true                  # #769 — interactive Handover-Alignment-Gate in /close before carryover filing (fail-open: skips when disabled/headless/autopilot)
  max-open-questions: 3          # integer ≥ 0 — max open questions surfaced in the gate's triage AUQ (0 = none; channel stays active)
slopcheck:
  enabled: false                 # PRD gsd Pattern 2 (#520) — opt-in package legitimacy gate
  sources: [plan, discovery]     # where classifyPackages is invoked
templates-first:
  enabled: true                  # PRD gsd Pattern 3 (#519) — gh/glab template-read enforcement
  hosts: [github, gitlab]        # host-regex allow-list
verification-auto-fix:
  enabled: false                 # PRD gsd Pattern 4 (#521) — opt-in auto-fix retry loop after Quality-Gate fail
  max-retries: 2                 # bounded retries
discovery-validator:
  enabled: true                  # PSA-006 (#567) — distributional-claim grep-verification enforcement (SubagentStop hook, log+warn-only, exit-0-always, non-blocking)
frontend-slop-hook:
  enabled: false                 # #684 — PostToolUse frontend-slop detector after UI-file edits (warn-only, non-blocking, opt-in); profile-gate also applies
loop-guard:
  enabled: true                  # ecc-analysis (#619) — PostToolUse runaway tool-loop detector (warn-only, non-blocking); profile-gate also applies
  threshold: 3                   # identical (tool+argsHash) calls within window before a loop-warning fires
  window: 5                      # ring-buffer size (recent tool calls tracked per session)
instruction-budget:
  enabled: true                  # #687 — session-start Phase 4 always-on directive-budget banner (warn-only, non-blocking, growth-ratchet)
  ceiling: 480                   # structural-directive ceiling; banner fires when always-on count exceeds this (baseline ~457; ratchet guards against growth)
  mode: warn                     # warn (surface banner) | off (silent no-op)
config-protection:
  enabled: true                  # ecc-analysis (#622) — PreToolUse guard: warn when an Edit/Write LOOSENS a quality gate (eslint/vitest/tsconfig/gitleaks/...)
  mode: warn                     # warn (stderr + event, exit 0) | strict (block loosening edits, exit 2)
allow-config-weakening: false    # ecc-analysis (#622) — per-session bypass for config-protection (mirrors allow-destructive-ops)
compact-nudge:
  enabled: false                 # ecc-analysis (#620) — opt-in advisory /compact nudge at inter-wave checkpoints (never auto-compacts)
  after: [discovery, impl]       # wave boundaries that may fire the nudge — subset of {discovery, impl, failed-wave}
  mode: warn                     # warn (surface one bullet in the wave progress update) | off (silent no-op)
goal-integration:
  enabled: false                 # Lever 5 (#636) — opt-in advisory /goal continuation anchor at named seams; ADR-0010: continuation, never judgment
  seams: [session-end-backlog, inter-wave-fixloop]   # subset of {session-end-backlog, inter-wave-fixloop}; one goal per session — pick ONE seam at a time
custom-phases:
  # #637 — repo-declared deterministic close/housekeeping phases; see docs/session-config-reference.md § Custom Phases.
  # Parser-Gotcha: die `custom-phases:`-Key-Zeile selbst darf KEINEN Inline-Kommentar tragen (custom-phases.mjs /^custom-phases:\s*$/).
  - name: archive-closed-prds
    when: both                   # #782 (Epic #774) — verschiebt PRDs geschlossener Epics in den Meta-Vault (dry-run-Default im CLI; hier explizit --apply)
    command: node scripts/archive-closed-prds.mjs --apply
    mode: warn                   # non-blocking — fail-closed CLI skippt bei unklarem Epic-State
  - name: archive-closed-plans
    when: both                   # #786 — verschiebt docs/plans/-Artefakte geschlossener Features/Epics in den Meta-Vault (gleicher fail-closed Mechanismus wie archive-closed-prds)
    command: node scripts/archive-closed-prds.mjs --apply --prd-dir docs/plans --vault-subdir 01-projects/session-orchestrator/plans
    mode: warn                   # non-blocking — fail-closed CLI skippt bei unklarem Epic-State
evolve:
  extra-sources: []              # #638 — opt-in EXTRA /evolve learning sources (sidecar JSON: {path, kind: regression-flags, learning-type: domain-regression}); empty = none. /evolve READS the sidecars, never runs the measurement. See docs/session-config-reference.md § Evolve Extra Sources
dialectic:
  cadence: 5                     # #506 — session-end 3.6.7 auto-trigger alle N Sessions (0 = kill-switch; manuell geht immer)
  model: haiku                   # haiku | sonnet | opus — fail-fast on unknown value
  budget-tokens: 32000           # 2026-07-04 session-3: Default 8000 strukturell unerreichbar — Fixanteil (Peer-Cards+Steering+Gerüst) ≈13k, volle Inputs (top-50/last-10) ≈28.4k
reconcile:
  enabled: false                 # #697 + #696 — opt-in; FA3 reads this to gate session-end Phase 3.6.8 (advisory rule-proposal delivery)
  mode: warn                     # off | warn — advisory only; rules are NEVER auto-applied, every write is operator-AUQ-gated (#696)
  targets: [repo-local]          # where approved rules are written; repo-local = .claude/rules/ in v1 (#696)
  rule-expiry-days: null         # CRITICAL: default null — reconcile engine (emitter.mjs computeExpiresAt) falls back to per-type TTL (default 60d). Set a positive integer to override flat expiry. (#697)
  confidence-floor: 0.5          # float 0.0..1.0 — min learning confidence before a learning is eligible for a rule proposal (#696)
  min-rule-days: 7               # #741.1 — floor for emitted rule expires-at: max(derived, now + N days). Prevents born-dead rules (expired at proposal time → rule-loader excludes). Positive integer; ≤0/malformed → 7.
  min-insight-chars: 24          # #741.2 — reject a learning whose trimmed insight is shorter than N chars before rule conversion (placeholder/legacy-stub gate, analog to vault-mirror.quality.min-narrative-chars). Integer ≥0; 0 = off.

## Skill Evolution <!-- consistency:exempt:parity-exempt-skill-evolution-block -->

> Opt-in self-evolution autonomy gate (Epic #643). A DISTINCT top-level block from the `evolve:` Session Config key above — `scripts/lib/config/skill-evolution.mjs` parses it independently of the `## Session Config` boundary. Lives outside `## Session Config` by design so `claude-md-drift-check` Check 6 (session-config-parity) does not flag it. Activated for this repo (#652) after the C2 engine (#647/#651) + the H1 evidence_kind guard (session-3) made autonomous-apply safe: the engine may auto-apply ONLY the `command-count` drift shape on the root instruction file, behind the quadruple gate (autonomy ∧ safe-posture ∧ gate-green ∧ evidence ≥ evidence-floor) AND only for `filesystem-fact`-sourced candidates. Plugin/local-skill/remote targets are ALWAYS MR-only.

skill-evolution:
  autonomy: autonomous-gated      # off | advisory | autonomous-gated — armed (#652)
  evidence-floor: 0.5             # float 0.0..1.0 — min evidence before an autonomous-gated repair acts
  judge: off                      # opt-in session-end LLM-judge (advisory only); default off

## Dispatcher Autonomy <!-- consistency:exempt:parity-exempt-dispatcher-autonomy-block -->

> **Parity-exempt section** (Epic #673, #679). Intentionally OUTSIDE `## Session Config` so `claude-md-drift-check` Check-6 (session-config-parity) does not flag repos that have not adopted this feature — `scripts/lib/config/dispatcher-autonomy.mjs` parses it independently of the `## Session Config` boundary. This committed block is the one-time capture of #681 (dogfooded here); its PRESENCE is the never-re-ask marker, so session-start Phase 1.1's migration trigger will not re-prompt. The value is `off` — fail-closed, no behaviour change, identical to this repo's de-facto state before adoption. The effective autonomy resolves host-locally `SO_DISPATCHER_AUTONOMY` env > `owner.yaml` `dispatcher.autonomy` > committed > `off` (#653 pattern), so a machine may opt this repo into `advisory`/`autonomous-gated` without editing this block.

dispatcher-autonomy:
  autonomy: off            # off | advisory | autonomous-gated — default off (fail-closed)
  confidence-floor: 0.5    # float 0.0..1.0
