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

For each agreed task/issue:
1. Read the GitLab issue description and acceptance criteria
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

### Role Details

**Discovery**
- Explore-type subagents (read-only, fast)
- Tasks: Audit affected code paths, verify assumptions, check test coverage, identify edge cases
- Output: Validated understanding, updated task scope if discoveries warrant it

**Impl-Core**
- Full implementation agents with Write/Edit/Bash access
- Tasks: Core feature code, database changes, API endpoints, primary UI components
- Output: Working implementation (may have rough edges)

**Impl-Polish**
- Targeted fix agents + new implementation agents
- Tasks: Bug fixes from Impl-Core, secondary features, integration, edge cases
- Output: Complete implementation with integrations working

**Quality**
- Test writers + quality reviewers
- Tasks: Write/update tests, run full quality checks per quality-gates skill, security review
- Output: All tests passing, 0 TypeScript errors, no lint violations

**Finalization**
- 1-2 specialized agents
- Tasks: Update SSOT files, close issues, write session handover, prepare commits
- Output: Clean git state, updated documentation, issues resolved

## Step 3: Agent Specification

For each wave, define agents with:

```
[Role] (Wave N) Agent M:
  Task: [specific task description]
  Files: [exact file paths to read/modify]
  Acceptance: [what "done" looks like — measurable]
  Tools needed: [Read, Write, Edit, Bash, Grep, Glob, etc.]
  Dependencies: [output from which prior role/agent]
```

### Agent Count by Session Type

| Session Type | Discovery | Impl-Core | Impl-Polish | Quality | Finalization |
|-------------|-----------|-----------|-------------|---------|-------------|
| housekeeping | 2 | 2 | 1 | 1 | 1 |
| feature | 4-6 | 6 | 4-6 | 4 | 2 |
| deep | 6-8 | 6-10 | 6-8 | 6 | 2-4 |

Read `agents-per-wave` from Session Config to cap the maximum.

## Step 4: Issue Updates

Before presenting the plan:

> **VCS Reference:** Use CLI commands per the "Common CLI Commands" section of the gitlab-ops skill.

1. Mark all selected issues as `status:in-progress` (use the issue update/edit command for the detected VCS platform)
2. Add a comment to each issue noting the session and planned wave (use the issue note/comment command for the detected VCS platform)

## Step 5: Present Plan for Approval

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

### Risk Mitigation
- [identified risks and how each wave handles them]

Ready to execute? Use /go to begin.
```

## Step 6: Handle Plan Changes

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
