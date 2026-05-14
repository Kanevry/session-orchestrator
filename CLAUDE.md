# Session Orchestrator Plugin

> Project-instruction file resolution: this is `CLAUDE.md` on Claude Code / Cursor IDE; the equivalent file on Codex CLI is `AGENTS.md`. See [skills/_shared/instruction-file-resolution.md](skills/_shared/instruction-file-resolution.md).

> Für Installation, CLI-Nutzung und Architektur siehe [`README.md`](./README.md). Diese Datei enthält nur die runtime-kritischen Abschnitte, die von `skills/_shared/config-reading.md` gelesen werden.

## Structure

See [`README.md`](./README.md#components) for the canonical inventory (30 skills, 10 commands, 11 agents, 10 hook event matchers / 10 hook handlers). Runtime layout: `skills/`, `commands/`, `agents/`, `hooks/`, `.orchestrator/policy/`, `.claude/rules/`. Stable product/tech/structure context lives at `.orchestrator/steering/{product,tech,structure}.md` and is injected at session-start Phase 2.6 (when present).

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
name: kebab-case-name                # 3-50 chars, lowercase + hyphens only
description: Use this agent when [conditions]. <example>Context: ... user: "..." assistant: "..." <commentary>Why this agent is appropriate</commentary></example>
model: inherit                        # inherit | sonnet | opus | haiku — OR full ID like claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5-20251001
color: blue                           # blue | cyan | green | yellow | purple | orange | pink | red | magenta
tools: Read, Grep, Glob, Bash         # comma-separated string OR JSON array (both accepted; we prefer comma-string for consistency)
---
```

**Frontmatter spec source:** https://code.claude.com/docs/en/sub-agents § Supported frontmatter fields. Our local validator (`scripts/lib/validate/check-agents.mjs` + `scripts/lib/agent-frontmatter.mjs`) matches the canonical spec on `tools` (both forms accepted), `color` (canonical 8-color palette + magenta for backward-compat), and `model` (aliases + full IDs).

**Required vs optional:**
- Runtime canonical doc: only `name` + `description` are required.
- Our validator (defensive for plugin-distribution): all four of `name + description + model + color` required; `tools` optional.
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). Put `<example>` blocks inline.
- `tools` accepts BOTH comma-separated string (`Read, Edit, Write`) and JSON array (`["Read", "Edit", "Write"]`). Anthropic's own reference agents use array form; we use string form for consistency.

**Body conventions** (from Anthropic's `plugins/plugin-dev/agents/*` reference set):
- Sections: `**Your Core Responsibilities:**` → `**[X] Process:**` → `**Quality Standards:**` → `**Output Format:**` → `**Edge Cases:**`.
- Length: 500–3000 words is the recommended range. Below 500 reads as under-specified; above 3000 reads as bloated.
- Read-only reviewer agents: tools `Read, Grep, Glob, Bash` (no Edit/Write). Implementer agents: `Read, Edit, Write, Glob, Grep, Bash`.

Reference: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/agent-development/SKILL.md

## Operational Rules <!-- consistency:exempt:runtime-only -->

- **CI status MUST be surfaced at session-start** — Local-only test runs are insufficient evidence of CI green. The 8-pipeline silent regression (2026-05-09 deep-3 → 2026-05-10 deep-1, fixed in deep-2) is the cautionary tale. Phase 4 of session-start invokes `scripts/lib/ci-status-banner.mjs` via `checkCiStatus({ repoRoot })` to render a 🚨 banner when CI is red on HEAD. Never assume CI is green from `npm test` results alone.

## Current State

- **Plugin version:** v3.5.0 (released 2026-05-09, GitHub + GitLab tag). Previous releases v3.4.0 (2026-05-08), v3.3.0 (2026-04-30), v3.2.0 (2026-04-27) at https://github.com/Kanevry/session-orchestrator/releases.
- **Active epic:** none — v3.2 Autopilot epic (#271) closed 2026-04-30 (all phases A/B/C-1/C-1.b/C-1.c/C-2/C-5 shipped). Sub-issues #297 (calibration, needs ≥10 RUNS) + #298 (evolve type 8, needs runtime data) remain data-gated on autopilot RUN-Volumen, not on code.
- **Stack:** Node 20+, vitest 4.1.5, ESLint 10. Run `npm ci` after cloning. Test: `npm test`. Lint: `npm run lint`. Coverage thresholds 70/65/70/60.
- **Tests:** 4826 passed / 12 skipped (post 2026-05-14 deep-1 Track A; +86 net = +16 fingerprint + +18 artifact-paths + +35 issue-reconcile + +17 ux-evaluator-frontmatter). validate-plugin 31/31, typecheck 67/67, lint 0, doc-consistency 0.
- **Backlog:** 19 open issues (post 2026-05-14 deep-1 — #379 #380 #382 Track A in-progress; newly filed #388 SEC-IR-MED-1 sentinel-injection hardening · #389 SEC-IR-LOW-1 maxBuffer/body-length cap; carryover #381 #383 #384 #385 #386 #387). Tracking-only: #305 vault strict watcher · #213 ComposioHQ · #123 awesome-claude-code · #341 Phase D placeholder. Data-gated: #297 (cap-decision calibration, needs ≥10 RUNS) / #298 (/evolve type 8). Low-priority chore remaining: #372 schema_version v2 bump (gate still satisfied at 3/3 green historical-entries CI runs, ready to file v2 bump PR when convenient).
- **2026-05-14 deep-1 — Track A of /test epic (#378): ux-evaluator + playwright-driver + test-runner skeleton (#379 #380 #382):** 5W coord-direct ~25min total agent time, isolation:none per #243 (new-dir detection), 14 agents dispatched. Headline: first 3 issues of the /test dependency chain land — agent, driver skill, and test-runner helper modules. **W1 Discovery (5 Explore, ~7m):** D1 skill/phase-model audit confirmed test-runner fits as a new skill (not a command extension); D2 agent frontmatter audit verified `blue`/`opus` validator-compatible for `ux-evaluator` (palette now at 11 agents on 9 colors — `blue` collides with `architect-reviewer` and `cyan` already collides between `docs-writer`/`qa-strategist`, both tolerated since neither pair is co-dispatched in practice; palette expansion is a known follow-up); D3 playwright probe discovered the PRD carried a wrong package name (`@playwright/cli@0.1.13` is an unrelated stub — canonical is `playwright@1.60.0` with binary `playwright`), corrected inline in skill before any code landed; D4 validator-extension audit confirmed `check-playwright-mcp-canary.mjs` pattern and wiring point in `validate-plugin.mjs`; D5 helper-module spec resolved export signatures for `fingerprint.mjs`, `artifact-paths.mjs`, `issue-reconcile.mjs`. **W2 Impl-Core (4 code-implementer, isolation:none):** I1 (#379) `agents/ux-evaluator.md` (~141 LOC) + `skills/test-runner/rubric-v1.md` (~373 LOC) — 4-check rubric (onboarding step-count ≤7, axe-violations critical/serious, console-errors visible to user, Apple-Liquid-Glass `.glassEffect()` conformance on SwiftUI 26+); I2 (#380) `skills/playwright-driver/SKILL.md` (~201 LOC) + `skills/playwright-driver/soul.md` (~30 LOC) — MCP-wired driver with artifact layout (`screenshots/`, `traces/`, `axe-*.json`, `console.ndjson`); I3 (#382-A) `skills/test-runner/SKILL.md` (~279 LOC) + `skills/test-runner/soul.md` (~46 LOC) — phase model (Setup → Drive → Evaluate → Reconcile → Report), Phase 2 peekaboo-driver placeholder graceful-absent; I4 (#382-B) `scripts/lib/test-runner/fingerprint.mjs` + `artifact-paths.mjs` + `issue-reconcile.mjs` + `scripts/lib/validate/check-playwright-mcp-canary.mjs` — pure helper modules, no side effects, DI-friendly. **W3 Impl-Polish (2 code-implementer, ~3.5m):** P1 wired R5 grep-canary into `validate-plugin.mjs` (check count 28 → 31, +3 new R5 rules); P2 cross-skill integration audit found and fixed 2 defects — (a) playwright-driver was documenting `.yaml` AX dumps but rubric Check 2 needs `axe-*.json`, reconciled in driver layout + rubric; (b) rubric described console.log as "plain-text prefixed by log level" but driver writes NDJSON `{ts,type,text,location}`, reconciled to NDJSON in rubric + evaluator parser step. **W4 Quality (3 agents + coord-direct Full Gate, ~6m):** Q1 test-writer 69 tests across 3 helper modules (`fingerprint.test.mjs` 16 tests, `artifact-paths.test.mjs` 18 tests, `issue-reconcile.test.mjs` 35 tests) — covers happy paths, edge cases, invalid inputs, normalisation invariants; Q2 ux-evaluator frontmatter regression 17 tests (`ux-evaluator-frontmatter.test.mjs`) — name/description/model/color/tools validation + floor/ceiling agent-count canary; Q3 security-reviewer PROCEED-WITH-CAVEATS — SEC-IR-MED-1: `recommendation` field in `issue-reconcile.mjs` lacks sentinel-injection hardening when consumed by glab (filed #388); SEC-IR-LOW-1: `maxBuffer` + body-length cap parity with `mr-draft.mjs` not yet enforced (filed #389); both non-blocking; Q4 Full Gate GREEN — typecheck 67/67, lint 0, validate-plugin 31/31, doc-consistency 0, tests 4826p/12s. **W5 Finalization (this wave):** CLAUDE.md (or AGENTS.md on Codex CLI) narrative + README component count bump + #388 + #389 follow-up issues confirmed filed. **Notable corrections:** (1) PRD package-name: `npm i -g @playwright/cli@latest` was wrong — `@playwright/cli@0.1.13` is an unrelated low-version package; canonical is `playwright@1.60.0`; documented inline in `skills/playwright-driver/SKILL.md` to prevent re-introduction; (2) cross-skill artifact format mismatch: driver documented `.yaml` AX dumps, rubric + evaluator expected `axe-*.json` NDJSON — both files reconciled to NDJSON in W3. **Quality:** 4740p/12s → 4826p/12s (+86 net, 0 skipped delta). typecheck 67/67, lint 0, validate-plugin 28/28 → 31/31 (+3 R5 canary rules), doc-consistency 0. **Filed follow-ups:** #388 (SEC-IR-MED-1 sentinel-injection hardening) · #389 (SEC-IR-LOW-1 maxBuffer/body-length cap). **Carryover:** #381 peekaboo-driver Track B · #383 `/test` command file + Session Config field + profile registry schema · #384 issue-reconciliation glab wiring + triage AUQ · #385 WEB-PROOF end2end · #386 MAC-PROOF end2end · #387 projects-baseline adoption. Commit on main; pipeline TBD post-push.

For older session narratives (2026-05-08 → 2026-05-12), release histories, and meta-audit fallout see [[01-projects/session-orchestrator/decisions]] in the Meta-Vault. Quick index of most recent commits: `cb3e942` (2026-05-14 Track A) · `a5c354e` (2026-05-12 #214 auto-commit-per-wave stub) · `5cfa469` (2026-05-12 #378 PRD) · `7b71573` (2026-05-12 #375/376/377 Phase D follow-ups) · `abd82aa` (2026-05-10 #374) · `eb820ca` (2026-05-11 #370/371/373) · `12c0df4` (2026-05-10 #364-substrate) · `ed83019` (2026-05-10 CI restoration) · `ce7fb1a` (2026-05-10 spike cluster) · `fe154c5` (2026-05-09 hotspot-splits) · `68e5e75` (2026-05-09 agent-authoring alignment) · `7095690` (2026-05-09 5W×6A cluster) · `8141878` (2026-05-09 repo-audit DX) · `c8b6ad4` (2026-05-08 discovery cluster) · `7158b82` (2026-05-08 v3.4.0). The PRDs for v3.2 Autopilot live at [[01-projects/session-orchestrator/prd/2026-04-24-state-md-recommendations-contract|Phase A]] / [[01-projects/session-orchestrator/prd/2026-04-25-mode-selector|Phase B]] / [[01-projects/session-orchestrator/prd/2026-04-25-autopilot-loop|Phase C]].

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
