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

## Current State

- **Plugin version:** v3.4.0 (released 2026-05-08, GitHub + GitLab tag). Previous releases v3.3.0 (2026-04-30) and v3.2.0 (2026-04-27) at https://github.com/Kanevry/session-orchestrator/releases.
- **Active epic:** none — v3.2 Autopilot epic (#271) closed 2026-04-30 (all phases A/B/C-1/C-1.b/C-1.c/C-2/C-5 shipped). Sub-issues #297 (calibration, needs ≥10 RUNS) + #298 (evolve type 8, needs runtime data) remain data-gated on autopilot RUN-Volumen, not on code.
- **Stack:** Node 20+, vitest 4.1.5, ESLint 10. Run `npm ci` after cloning. Test: `npm test`. Lint: `npm run lint`. Coverage thresholds 70/65/70/60.
- **Tests:** 4430 passed / 12 skipped (stable 2026-05-09 deep-4; +534 net from deep-3 hotspot-splits). validate-plugin 27/27, typecheck 66/66, lint 0, doc-consistency 0 findings. CI security gates: gitleaks 0 leaks (258 commits), npm audit 0 vulnerabilities.
- **Backlog:** 6 open issues (post 2026-05-09 deep-3 snapshot — closed 5: #359–#363); deep-4 hotspot-splits cluster shipped without issue-tracker entries (internal architectural refactor, no functional change). Zero `priority:critical|high|medium` code work remaining. Tracking-only: #305 cross-repo strict watcher (medium) · #213 ComposioHQ submission · #123 awesome-claude-code tracker · #341 Autopilot Phase D placeholder. Data-gated: #297 / #298.
- **2026-05-09 deep-4 — 5W×6A hotspot-splits cluster (file-disjoint architectural refactor, no issues):** First deep session shipped without VCS issue traceability — internal architectural refactor on the back of deep-2's split pattern. Six file-disjoint hotspots ≥400 LOC split into submodules (all <300 LOC each), public API preserved via barrel re-exports: **state-md.mjs** (563→31 LOC barrel; 4 new submodules: yaml-parser/197, frontmatter-mutators/53, body-sections/133, mission-status/202) · **mode-selector.mjs** (480→149 LOC orchestrator; 4 new submodules: constants/29, scoring/194, alternatives/64, rationale/55) · **session-schema.mjs** (462→70 LOC barrel; 5 fresh submodules: constants/76, validator/259, normalizer/65, timestamps/64, aliases/71) · **owner-config.mjs** (459→28 LOC wrapper; 7 fresh submodules: constants/21, error/19, defaults/50, coerce/29, validate/259, merge/52, index/13) · **worktree.mjs** (418→15 LOC barrel; 5 fresh submodules: constants/35, meta/64, listing/114, lifecycle/254, index/17) · **autopilot.mjs** (418→39 LOC barrel; 3 new submodules + relocated telemetry: flags/104, telemetry/120 [from autopilot-telemetry.mjs, backward-compat shim retained], loop/262, kill-switches existing/148). 26 NEW `*.test.mjs` files added with **+534 tests (3896→4430)**. The W3 stability adapter `tests/lib/refactor-stability.test.mjs` extended 24→46 tests covering all 6 modules' public APIs. typecheck 66/66, lint 0, validate-plugin 27/27, doc-consistency 0 broken refs, test-quality audit 0 anti-pattern violations across all 503 new tests. 5W×6A coordinator-direct dispatch with file-disjoint allowedPaths per agent (no scope conflicts). Commit `<TBD>`. Volltext + Discovery split-plans + W3 polish trims in [[01-projects/session-orchestrator/decisions]].
- **2026-05-09 deep-3 — Anthropic-canonical agent-authoring alignment (#359–#363):** 5W coord-direct, primary-source-grounded refactor of all 10 agent files. **Validator alignment** (#359): `scripts/lib/validate/check-agents.mjs` + `scripts/lib/agent-frontmatter.mjs` brought in line with [code.claude.com/sub-agents](https://code.claude.com/docs/en/sub-agents) — tools accepts both comma-string AND JSON array (Anthropic's reference agents use array form), color palette expanded to canonical 8 colors + magenta (was 6), model regex accepts full IDs (`claude-opus-4-7`). **Implementer normalization** (#360): code-implementer/db-specialist/ui-developer/test-writer expanded 187/226/236/294w → 815/803/845/996w with full Output-Format + Edge-Cases sections per Anthropic plugin-dev SKILL.md template. **Reviewer/writer compliance** (#361): docs-writer + qa-strategist gained Edge-Cases sections. **Color-collision fix** (#362): db-specialist blue→purple, docs-writer blue→cyan, session-reviewer cyan→pink, test-writer yellow→orange — resolves 3 same-wave collisions, all 9 distinct co-dispatchable colors. **Worked examples** (#363): test-writer Falsification-check (`add(2,3)→5` example), session-reviewer Silent-failure-vs-graceful contrast (6 cases), security-reviewer fully-filled HIGH SQL-injection finding template. CLAUDE.md (or AGENTS.md on Codex CLI) "Agent Authoring Rules" rewritten with canonical-spec accuracy. Tests 3888→3908 (+20). validate-plugin 27/27, typecheck 66/66, lint 0. Commit `<TBD>`. Volltext + research-Briefings (Anthropic primary sources, community survey, cross-check) in [[01-projects/session-orchestrator/decisions]].
- **2026-05-09 deep-2 — 5W×6A parallel-subagent cluster (#355 #356 #357 #358):** First non-coord-direct deep session in 14+ session streak — explicit user override to test 6-parallel-subagent-per-wave dispatch on file-disjoint scopes. CRITICAL CI fix #356 (harness-audit JSON truncation at byte 8188 — 10+ failed CI runs since 2026-05-01, root cause = stdout flush race before `process.exit(0)`). 16 NEW `*.test.mjs` files (#357 backfill, +297 tests 3591→3888). 5 NEW production submodules (#358 hotspot splits: `scripts/lib/{autopilot/kill-switches,state-md/recommendations,mode-selector/context-pressure,learnings/io,learnings/filters}.mjs`). 9th autopilot kill-switch `TOKEN_BUDGET_EXCEEDED` (#355, opt-in via `opts.maxTokens`, forward-compat preserved). Q3 follow-up extracted `learnings/schema.mjs` leaf to break a circular-import topology in the initial split. All 4 hotspots now <500 LOC; public API preserved via 24-test adapter `tests/lib/refactor-stability.test.mjs`. Commit `<TBD>`. Volltext + Q1/Q3/Q4 review findings + carry-forward in [[01-projects/session-orchestrator/decisions]].
- **2026-05-09 deep-1 — Repo-audit DX+security cluster (#350–#354):** 5W coord-direct (14-consecutive now), 5 issues closed. NEW gitleaks-scan + npm-audit CI gates (GitLab + GitHub `security` stage), NEW Husky 9 + commitlint + lint-staged (`.husky/{pre-commit,commit-msg}`, `commitlint.config.mjs`, `.lintstagedrc.mjs`), `.prettierignore` extended, project-instruction-file trim 110→88L + verbose 2026-05-08 bullets archived to vault. Self-bootstrapping: closing commit was first to fire all 4 hooks. Commit `8141878`. Volltext in [[01-projects/session-orchestrator/decisions]].
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
