# Session Orchestrator Plugin

> Project-instruction file resolution: this is `CLAUDE.md` on Claude Code / Cursor IDE; the equivalent file on Codex CLI is `AGENTS.md`. See [skills/_shared/instruction-file-resolution.md](skills/_shared/instruction-file-resolution.md).

> Für Installation, CLI-Nutzung und Architektur siehe [`README.md`](./README.md). Diese Datei enthält nur die runtime-kritischen Abschnitte, die von `skills/_shared/config-reading.md` gelesen werden.

## Structure

See [`README.md`](./README.md#components) for the canonical inventory (37 skills, 16 commands, 11 agents, 10 hook event matchers / 10 hook handlers). Runtime layout: `skills/`, `commands/`, `agents/`, `hooks/`, `.orchestrator/policy/`, `.claude/rules/`. Stable product/tech/structure context lives at `.orchestrator/steering/{product,tech,structure}.md` and is injected at session-start Phase 2.6 (when present).

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

- **Plugin version:** v3.6.0 (released 2026-05-14, GitHub + GitLab tag). Previous releases v3.5.0 (2026-05-09), v3.4.0 (2026-05-08), v3.3.0 (2026-04-30) at https://github.com/Kanevry/session-orchestrator/releases.
- **Active epic:** none — v3.2 Autopilot epic (#271) closed 2026-04-30 (all phases shipped). Sub-issues #297 (calibration, needs ≥10 RUNS) + #298 (evolve type 8, needs runtime data) remain data-gated on autopilot RUN-Volumen, not on code.
- **Stack:** Node 20+, vitest 4.1.5, ESLint 10. Run `npm ci` after cloning. Test: `npm test`. Lint: `npm run lint`. Coverage thresholds 70/65/70/60.
- **Tests:** 5256 passed / 0 failed / 11 skipped (+127 net from 2026-05-16 deep-2; CI pipeline TBD after push). validate-plugin 43/43, typecheck 67/67, lint 0.
- **Backlog:** ~5-7 open post 2026-05-16 deep-2 cut (closed superpowers-adoption cluster #35 #36 #37 #38 #39 #40). Open: GitHub #34 (awesome-list submission), GitHub #43 (Codex plugin icon), GitHub #44 (MED path-traversal --vault-dir SEC follow-up for gitlab-portfolio), GitHub #45 (LOW execFile AbortSignal resource hygiene). Plus open-on-GitLab: #386 (mac-gate end2end), #403 (RUBRIC_GLASS_V2 profile-config flag). Tracking-only: #305 · #213 · #123 · #341. Data-gated: #297 / #298. Low-pri chore: #372 schema_version v2 bump.

### Recent sessions (one-line summaries; long-form in [[01-projects/session-orchestrator/decisions]])

- **2026-05-16 deep-2** — Superpowers-adoption cluster closed: GH #35 umbrella + #36 (skills/brainstorm/ NEW + commands/brainstorm.md, HARD-GATE-gated Socratic design dialogue) + #37 (skills/debug/ NEW + commands/debug.md, 4-phase Iron Law systematic debugging with `.orchestrator/debug/` artifact contract) + #38 (.claude/rules/verification-before-completion.md NEW, VBC-001..005, banned phrases + 5-step Gate Function) + #39 (skills/write-executable-plan/ NEW + plan-template.md + docs/plans/2026-05-16-superpowers-cluster.md retrospective dogfood) + #40 (.claude/rules/receiving-review.md NEW, RCR-001..006, forbidden phrases + 6-step pattern). 11 NEW files + 9 cross-ref edits (wave-executor, code-implementer, session-reviewer, plan, session-plan, development.md, testing.md, cli-design.md with bidirectional See-Also). 5W×NA parallel (4+4+3+4+2 = 17 agents). 0 partial/failed/spiral. Tests **5129 → 5256p/0f/11s** (+127 net: 34 brainstorm/debug + 50 VBC/RCR + 42 write-executable-plan + 1 misc). Full Gate GREEN (typecheck 67/67, lint 0, validate-plugin 43/43). Coordinator inline fix: tests/skills/debug.test.mjs removed unused `yaml` import (1-line lint). D4 finding: validate-plugin auto-discovers skills via filesystem — no count-assertion update needed.
- **2026-05-16 deep-1** — GH #42 (echo-stub detector) + GH #41 (gitlab-portfolio skill, 6 files NEW: skills/gitlab-portfolio/SKILL.md + scripts/lib/gitlab-portfolio/{aggregator,markdown-writer,cli,vcs-detect}.mjs + scripts/lib/config/gitlab-portfolio.mjs; commands/portfolio.md NEW; docs/recipes/quality-gate-container-pattern.md NEW; skills/session-end Phase 2.0a + skills/session-start Phase 2.7 wire-up). 5W×NA parallel (4+4+3+4+2 = 17 agents). 0 partial/failed/spiral. Tests **5001 → 5129p/0f/12s** (+128 net). Full Gate GREEN. Q3 security PASS-WITH-FOLLOWUPS: filed GH #44 (MED path-traversal --vault-dir, conf 0.80) + GH #45 (LOW execFile timeout abort, conf 0.75). Coordinator inline fixes: gate-baseline.test.mjs fixtures (4 lines, echo→node-e) + cli.mjs:224 AGENTS.md alias.
- **2026-05-16 housekeeping-1** — Express Path coord-direct CI restore (#408: `apt-get` guard for Mac shell-runner + `vitest.config.mjs` CI `testTimeout` 30s + gitleaks `entrypoint:[""]`) + @lib alias rollout (#407: **124 test files**, 35 → 159 alias adopters; 2 child-spawn-target exemptions: `tests/fixtures/io-driver.mjs` + `tests/unit/rules-sync.test.mjs:20`). 3 commits (`479181c`, `f03cc1e`, `a8a64a9`). Tests **5001p/0f/12s** (zero delta), validate-plugin **43/43** (zero delta). **CI pipeline #4068 GREEN** (5 jobs: gitleaks 4s ✅, npm-audit 5s ✅, test 256s ✅, schema-drift 21s ✅, coverage 25s ✅ retry). PSA-001 parallel-session signal: `3b45e83` `/memory-cleanup` skill landed by separate session (no scope overlap, no pause).
- **2026-05-14 deep-5** — `validatePathInsideProject` helper extraction + @lib alias rollout (33 files) + boundary tests (#402 #404 #405 #406; #407 filed). Tests 4982 → **5001p/0f/12s** (+19). validate-plugin **39 → 43**. Commit `a758fdb`.
- **2026-05-14 deep-4** — /test pipeline housekeeping cluster: Division-of-Responsibility doc-sync, `shared/profiles → profiles/` rename, runDir traversal MED, AbortController tests (#395 #396 #397 #398 #399 #400 #401). validate-plugin **36 → 39**. Commit `522e839`.
- **2026-05-14 deep-3** — /test live-run vs aiat-pmo-module: mechanism proven, reporter-syntax bug fixed inline (`html,json` not Jest-style `html:<path>`) + #390 #391 #393 #394. validate-plugin **34 → 36**. Commit `07d1985`.
- **2026-05-14 deep-2** — /test Track B: `peekaboo-driver` skill + `playwright-driver/runner.mjs` (260 LOC, spawn + AbortSignal) + #385 mechanism-proof (#381). validate-plugin **31 → 34**. Commit `253a4ab`.
- **2026-05-14 deep-1** — CI restore + `/test` command + issue-reconcile glab wiring (#383 #384 #388 #389) + Track A (ux-evaluator + playwright-driver + test-runner skeleton; #379 #380 #382). validate-plugin **28 → 31**. Commits `3aee4cc` + `cb3e942`.

For older session narratives (2026-04-27 → 2026-05-12), release histories, and meta-audit fallout see [[01-projects/session-orchestrator/decisions]] in the Meta-Vault. Quick commit index: `a8a64a9` + `f03cc1e` + `479181c` (housekeeping-1 2026-05-16) · `a758fdb` (deep-5) · `522e839` (deep-4) · `07d1985` (deep-3) · `253a4ab` (deep-2) · `3aee4cc` (deep-1 CI restore) · `cb3e942` (deep-1 Track A) · `a5c354e` (#214 stub) · `5cfa469` (#378 PRD) · `7b71573` (#375/376/377) · `abd82aa` (#374) · `eb820ca` (#370/371/373) · `12c0df4` (#364 substrate) · `ed83019` (CI restoration) · `7158b82` (v3.4.0). The PRDs for v3.2 Autopilot live at [[01-projects/session-orchestrator/prd/2026-04-24-state-md-recommendations-contract|Phase A]] / [[01-projects/session-orchestrator/prd/2026-04-25-mode-selector|Phase B]] / [[01-projects/session-orchestrator/prd/2026-04-25-autopilot-loop|Phase C]].

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
