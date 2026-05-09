# Session Orchestrator Plugin

> Project-instruction file resolution: this is `CLAUDE.md` on Claude Code / Cursor IDE; the equivalent file on Codex CLI is `AGENTS.md`. See [skills/_shared/instruction-file-resolution.md](skills/_shared/instruction-file-resolution.md).

> Für Installation, CLI-Nutzung und Architektur siehe [`README.md`](./README.md). Diese Datei enthält nur die runtime-kritischen Abschnitte, die von `skills/_shared/config-reading.md` gelesen werden.

## Structure

See [`README.md`](./README.md#components) for the canonical inventory (28 skills, 10 commands, 10 agents, 10 hook event matchers / 10 hook handlers). Runtime layout: `skills/`, `commands/`, `agents/`, `hooks/`, `.orchestrator/policy/`, `.claude/rules/`. Stable product/tech/structure context lives at `.orchestrator/steering/{product,tech,structure}.md` and is injected at session-start Phase 2.6 (when present).

## Destructive-Command Guard

`hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands in the main session (alongside subagent waves). Policy lives in `.orchestrator/policy/blocked-commands.json` (13 rules). Bypass per-session via Session Config:

```yaml
allow-destructive-ops: true
```

Rule source of truth: [`.claude/rules/parallel-sessions.md`](.claude/rules/parallel-sessions.md) (PSA-003). See README § Destructive-Command Guard for the full narrative.

## Agent Authoring Rules

Agent files live in `agents/` as Markdown with YAML frontmatter. Required fields:

```yaml
---
name: kebab-case-name          # 3-50 chars, lowercase + hyphens only
description: Use this agent when [conditions]. <example>Context: ... user: "..." assistant: "..." <commentary>Why this agent is appropriate</commentary></example>
model: inherit                 # inherit | sonnet | opus | haiku
color: blue                    # blue | cyan | green | yellow | magenta | red
tools: Read, Grep, Glob, Bash  # COMMA-SEPARATED STRING, not JSON array!
---
```

**Critical pitfalls** (cause "agents: Invalid input" validation failure):
- `tools` MUST be a comma-separated string (`Read, Edit, Write`), NOT a JSON array (`["Read", "Edit"]`)
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). Put `<example>` blocks inline.
- All 4 fields (name, description, model, color) are required. `tools` is optional.

Reference: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/agent-development/SKILL.md

## Current State

- **Plugin version:** v3.4.0 (released 2026-05-08, GitHub + GitLab tag). Previous releases v3.3.0 (2026-04-30) and v3.2.0 (2026-04-27) at https://github.com/Kanevry/session-orchestrator/releases.
- **Active epic:** none — v3.2 Autopilot epic (#271) closed 2026-04-30 (all phases A/B/C-1/C-1.b/C-1.c/C-2/C-5 shipped). Sub-issues #297 (calibration, needs ≥10 RUNS) + #298 (evolve type 8, needs runtime data) remain data-gated on autopilot RUN-Volumen, not on code.
- **Stack:** Node 20+, vitest 4.1.5, ESLint 10. Run `npm ci` after cloning. Test: `npm test`. Lint: `npm run lint`. Coverage thresholds 70/65/70/60.
- **Tests:** 3591 passed / 12 skipped (stable 2026-05-09 deep-1; config-only changes). validate-plugin 27/27, typecheck 66/66, lint 0. CI security gates: gitleaks 0 leaks (258 commits), npm audit 0 vulnerabilities.
- **Backlog:** 6 open issues (post 2026-05-09 deep-1 snapshot). Zero `priority:high|medium` code work remaining. Tracking-only: #305 cross-repo strict watcher (medium) · #213 ComposioHQ submission · #123 awesome-claude-code tracker · #341 Autopilot Phase D placeholder. Data-gated: #297 / #298.
- **2026-05-09 deep-1 — Repo-audit DX+security cluster (#350–#354):** 5W coord-direct (14-consecutive now), 5 issues closed. NEW gitleaks-scan + npm-audit CI gates (GitLab + GitHub `security` stage), NEW Husky 9 + commitlint + lint-staged (`.husky/{pre-commit,commit-msg}`, `commitlint.config.mjs`, `.lintstagedrc.mjs`), `.prettierignore` extended, CLAUDE.md trim 110→88L + verbose 2026-05-08 bullets archived to vault. Self-bootstrapping: closing commit was first to fire all 4 hooks. Commit `8141878`. Volltext in [[01-projects/session-orchestrator/decisions]].
- **2026-05-08 deep-2 — Discovery-derived 6-issue cluster (#344–#349):** 5W×6A coord-direct, +453 tests (3138→3591), 2 NEW production files (`scripts/lib/crypto-digest-utils.mjs`, `scripts/lib/validate/check-hooks-symmetry.mjs`) + 16 NEW test files. validate-plugin 22→27. Commit `c8b6ad4`. Volltext und Wave-Narrative in [[01-projects/session-orchestrator/decisions]].
- **2026-05-08 PM — v3.4.0 release (#325–#332, #342):** 5W×6A coord-direct, +196 tests (2942→3138), 11 NEW production files (vault-sync-baseline, frontmatter-guard, session-lock, subagents-schema, autopilot-telemetry, 5 ecosystem-wizard sub-modules, 4 hooks) + 1 NEW skill (`skills/frontmatter-guard/`). v3.4.0 cut + GitHub release `--latest`. Commit `7158b82`. Volltext in [[01-projects/session-orchestrator/decisions]].

For older session narratives, release histories, and meta-audit fallout see [[01-projects/session-orchestrator/decisions]] in the Meta-Vault. The PRDs for v3.2 Autopilot live at [[01-projects/session-orchestrator/prd/2026-04-24-state-md-recommendations-contract|Phase A]] / [[01-projects/session-orchestrator/prd/2026-04-25-mode-selector|Phase B]] / [[01-projects/session-orchestrator/prd/2026-04-25-autopilot-loop|Phase C]].

## Session Config

persistence: true
enforcement: warn
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
  vault-dir: ~/Projects/vault
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
persona-reviewers:
  enabled: false           # opt-in inter-wave architecture/QA/PRD audits
  reviewers: []            # ["architect-reviewer", "qa-strategist", "analyst"]
  mode: warn               # warn | strict | off
