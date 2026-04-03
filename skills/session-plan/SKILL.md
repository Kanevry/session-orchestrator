---
name: session-plan
user-invocable: false
description: >
  Creates a structured wave execution plan with role-based assignment after user alignment.
  Decomposes agreed tasks into configurable waves (default 5) with optimal agent assignment,
  dependency ordering, and inter-wave checkpoints. Activated by session-start after Q&A phase completes.
---

# Session Plan Skill

## Purpose

Transform the agreed session scope (from session-start Q&A) into an executable wave plan (using role-based assignment) with specific agent assignments, file scopes, and acceptance criteria per task.

## Step 1: Task Decomposition

0. **Check for resume context**: If `.claude/STATE.md` exists with `status: active` or `status: paused`, read it to understand:
   - Which waves were completed in the prior session
   - Which agents completed, which were partial/failed
   - What deviations were logged
   - Use this to avoid re-doing completed work and to prioritize carryover tasks
   If no STATE.md or `status: completed`, proceed with fresh planning.

0.5. **Read project intelligence**: If `.claude/metrics/learnings.jsonl` exists, read active learnings (confidence > 0.3, not expired) and apply:
   - **Fragile files**: if any planned task touches a known fragile file, note it as a warning in the agent spec
   - **Effective sizing**: use historical sizing data to inform Step 3 complexity scoring
   - **Recurring issues**: pre-populate risk mitigation with known issue patterns
   - **Scope guidance**: validate planned scope against historical session capacity

For each agreed task/issue:
1. Read the VCS issue description and acceptance criteria
2. Identify affected files by searching the codebase (Grep/Glob — don't guess)
3. Map dependencies: which tasks must complete before others can start
4. Estimate complexity: small (1 agent), medium (2-3 agents), large (dedicated wave)
5. Identify synergies: tasks that touch the same files → same wave, same agent

## Step 2: Wave Assignment

Distribute tasks across waves using 5 named roles. Read `waves` from Session Config (default: 5) and map roles to wave numbers.

### Wave Roles

| Role | Purpose | Agents modify code? |
|------|---------|---------------------|
| **Discovery** | Understand the current state before changing anything | No (read-only) |
| **Impl-Core** | Primary implementation — core feature code, APIs, DB changes | Yes |
| **Impl-Polish** | Fix issues from Impl-Core, secondary tasks, integration, edge cases | Yes |
| **Quality** | Tests, typecheck, lint, security review | Yes (tests only) |
| **Finalization** | Documentation, issue cleanup, commit preparation | Minimal |

### Role-to-Wave Mapping

Map roles to the configured wave count:

| `waves` | Mapping |
|---------|---------|
| 3 | W1=Discovery+Impl-Core, W2=Impl-Polish+Quality, W3=Finalization |
| 4 | W1=Discovery, W2=Impl-Core+Impl-Polish, W3=Quality, W4=Finalization |
| 5 | W1=Discovery, W2=Impl-Core, W3=Impl-Polish, W4=Quality, W5=Finalization |
| 6+ | W1=Discovery, W2-W3=Impl-Core (split), W4-W5=Impl-Polish (split), W6=Quality+Finalization |

When roles are combined into a single wave, agents from both roles execute in that wave. The combined wave inherits the more restrictive verification level.

> Example: When Discovery+Impl-Core are combined (3-wave config), the wave runs Incremental quality checks (Impl-Core's level) rather than no verification (Discovery's level).

**Splitting criteria for 6+ waves**: When Impl-Core or Impl-Polish span multiple waves, split by module or dependency boundary. Tasks with shared file dependencies go in the same wave; tasks touching independent modules go in separate waves. If no clear boundary exists, split by task count (distribute evenly).

### Role Details

**Discovery**
- Explore-type subagents (read-only, fast)
- Tasks: Audit affected code paths, verify assumptions, check test coverage, identify edge cases
- Output: Validated understanding, updated task scope if discoveries warrant it
- Tools: Read, Grep, Glob, Bash (read-only commands only) — do NOT use Edit or Write
- Scope enforcement: set `allowedPaths` to `[]` (empty) for Discovery waves. Include in agent prompts: "You are READ-ONLY. Do NOT use Edit or Write tools."

**Impl-Core**
- Full implementation agents with Write/Edit/Bash access
- Tasks: Core feature code, database changes, API endpoints, primary UI components
- Output: Working implementation (may have rough edges)

**Impl-Polish**
- Targeted fix agents + new implementation agents
- Tasks: Bug fixes from Impl-Core, secondary features, integration, edge cases
- Output: Complete implementation with integrations working

**Quality**
- Simplification agents + test writers + quality reviewers
- Tasks: Simplify AI-generated code patterns (using slop-patterns.md from discovery skill), write/update tests (test files only — `**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`), run full quality checks per quality-gates skill, security review
- Scope restriction: Simplification agents may edit production files changed in this session. Test/review agents restricted to test file patterns and test configuration.
- Output: Simplified code, all tests passing, 0 TypeScript errors, no lint violations

**Finalization**
- 1-2 specialized agents
- Tasks: Update SSOT files, close issues, write session handover, prepare commits
- Output: Clean git state, updated documentation, issues resolved

## Step 3: Complexity Assessment

Score the session scope to determine optimal agent counts per wave. Skip for housekeeping sessions (use fixed counts from Step 4).

### Scoring Formula

| Factor | 0 points | 1 point | 2 points |
|--------|----------|---------|----------|
| Files to change | 1-5 | 6-15 | 16+ |
| Cross-module scope | 1 directory | 2-3 directories | 4+ directories |
| Issue count | 1 issue | 2-3 issues | 4+ issues |

**Total score** = sum of all factors (0-6 range).

### Complexity Tiers

| Tier | Score | Description |
|------|-------|-------------|
| Simple | 0-1 | Small scope, few files, single module |
| Moderate | 2-3 | Medium scope, multiple modules |
| Complex | 4-6 | Large scope, many modules and issues |

### Agent Count by Tier

| Session Type | Tier | Discovery | Impl-Core | Impl-Polish | Quality | Finalization |
|-------------|------|-----------|-----------|-------------|---------|-------------|
| feature | simple | 2-3 | 3-4 | 2-3 | 2 | 1 |
| feature | moderate | 4-5 | 5-6 | 4-5 | 3-4 | 2 |
| feature | complex | 5-6 | 6 | 5-6 | 4 | 2 |
| deep | simple | 3-4 | 4-6 | 3-4 | 3 | 2 |
| deep | moderate | 5-6 | 6-8 | 5-6 | 4-5 | 2-3 |
| deep | complex | 6-8 | 8-10 | 6-8 | 6 | 3-4 |

The `agents-per-wave` Session Config value caps the maximum regardless of tier.

If project intelligence (learnings) suggests different sizing based on historical data, prefer the historical recommendation over the formula.

## Step 4: Agent Specification

For each wave, define agents with:

```
[Role] (Wave N) Agent M:
  Task: [specific task description]
  Files: [exact file paths to read/modify]
  Acceptance: [what "done" looks like — measurable]
  Tools needed: [Read, Write, Edit, Bash, Grep, Glob, etc.]
  Dependencies: [output from which prior role/agent]
  Isolation: [worktree|none — read from Session Config, default: worktree for feature/deep, none for housekeeping]
  MaxTurns: [read from Session Config max-turns, default: housekeeping=8, feature=15, deep=25]
```

- `Isolation: worktree` means the wave-executor will pass `isolation: "worktree"` to the Agent tool, giving each agent its own git worktree copy
- `MaxTurns` is enforced via the agent prompt — wave-executor includes a turn limit instruction in each agent's prompt

### Agent Count by Session Type

| Session Type | Discovery | Impl-Core | Impl-Polish | Quality | Finalization |
|-------------|-----------|-----------|-------------|---------|-------------|
| housekeeping | 2 | 2 | 1 | 1 | 1 |
| feature | 4-6 | 6 | 4-6 | 4 | 2 |
| deep | 6-8 | 6-10 | 6-8 | 6 | 2-4 |

Read `agents-per-wave` from Session Config to cap the maximum.

> **Note:** For feature and deep sessions, prefer the complexity-based agent counts from Step 3. This table provides defaults when complexity scoring is skipped (housekeeping) or as a fallback.

## Step 5: Issue Updates

Before presenting the plan:

> **VCS Reference:** Use CLI commands per the "Common CLI Commands" section of the gitlab-ops skill.

1. Mark all selected issues as `status:in-progress` (use the issue update/edit command for the detected VCS platform)
2. Add a comment to each issue noting the session and planned wave (use the issue note/comment command for the detected VCS platform)

## Step 6: Present Plan for Approval

Present the plan in this format:

```
## Wave Plan (Session: [type], [N] waves)

### Wave 1: Discovery ([N agents])
- Agent 1: [task] → [files] → [acceptance criteria]
...

### Wave 2: Impl-Core ([N agents])
- Agent 1: [task] → [files] → [acceptance criteria]
...

### Wave 3: Impl-Polish ([N agents])
...

### Wave 4: Quality ([N agents])
...

### Wave 5: Finalization ([N agents])
...

### Inter-Wave Checkpoints
- After Discovery: Validate discoveries, adjust Impl-Core scope if needed
- After Impl-Core: Incremental quality checks per quality-gates. **If `pencil` configured: design review.**
- After Impl-Polish: Incremental quality checks + integration verification. **If `pencil` configured: final design-code alignment check.**
- After Quality: Full Gate per quality-gates — if failing, create fix tasks for Finalization
- After Finalization: Final review before session-end

### Project Intelligence Applied
- [list of learnings that influenced this plan, with confidence scores]
- Or: "No project intelligence available yet"

### Risk Mitigation
- [identified risks and how each wave handles them]

Ready to execute? Use /go to begin.
```

## Step 7: Handle Plan Changes

If the user requests changes:
- Re-scope affected waves
- Re-assign agents
- Update issue comments if scope changes
- Re-present the modified plan

## Critical Rules

- **NEVER put independent tasks in the same agent** — each agent gets ONE focused task
- **ALWAYS order waves by dependency** — never schedule a task before its dependency completes
- **TypeScript check only in Discovery (baseline) and Quality/Finalization roles** — not during implementation roles
- **Build commands only in housekeeping sessions** — never during feature/deep work mid-session
- **Agent prompts must be self-contained** — include ALL context the agent needs (file paths, issue details, acceptance criteria). The agent starts with zero context.
- **If a task is too large for one agent**, split it across multiple agents with clear file-boundary separation
