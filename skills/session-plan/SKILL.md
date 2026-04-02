---
name: session-plan
description: >
  Creates a structured wave execution plan after user alignment. Decomposes agreed tasks
  into 5 waves with optimal agent assignment, dependency ordering, and inter-wave checkpoints.
  Activated by session-start after Q&A phase completes.
---

# Session Plan Skill

## Purpose

Transform the agreed session scope (from session-start Q&A) into an executable 5-wave plan with specific agent assignments, file scopes, and acceptance criteria per task.

## Step 1: Task Decomposition

For each agreed task/issue:
1. Read the GitLab issue description and acceptance criteria
2. Identify affected files by searching the codebase (Grep/Glob — don't guess)
3. Map dependencies: which tasks must complete before others can start
4. Estimate complexity: small (1 agent), medium (2-3 agents), large (dedicated wave)
5. Identify synergies: tasks that touch the same files → same wave, same agent

## Step 2: Wave Assignment

Distribute tasks across 5 waves following this pattern:

### Wave 1: Validation & Discovery
- **Purpose**: Understand the current state before changing anything
- **Agents**: Explore-type subagents (read-only, fast)
- **Tasks**: Audit affected code paths, verify assumptions, check test coverage, identify edge cases
- **Output**: Validated understanding, updated task scope if discoveries warrant it

### Wave 2: Implementation A (Core)
- **Purpose**: Primary implementation work
- **Agents**: Full implementation agents with Write/Edit/Bash access
- **Tasks**: Core feature code, database changes, API endpoints, primary UI components
- **Output**: Working implementation (may have rough edges)

### Wave 3: Implementation B (Polish + Overflow)
- **Purpose**: Fix issues from Wave 2, implement secondary tasks
- **Agents**: Targeted fix agents + new implementation agents
- **Tasks**: Bug fixes from W2, secondary features, integration between W2 outputs, edge cases
- **Output**: Complete implementation with integrations working

### Wave 4: Quality & Testing
- **Purpose**: Ensure everything works end-to-end
- **Agents**: Test writers + quality reviewers
- **Tasks**: Write/update tests, run full test suite, typecheck (`tsgo --noEmit`), lint, security review
- **Output**: All tests passing, 0 TypeScript errors, no lint violations

### Wave 5: Finalization
- **Purpose**: Documentation, issues, commits
- **Agents**: 1-2 specialized agents
- **Tasks**: Update SSOT files, close issues, write session handover, prepare commits
- **Output**: Clean git state, updated documentation, issues resolved

## Step 3: Agent Specification

For each wave, define agents with:

```
Wave N Agent M:
  Task: [specific task description]
  Files: [exact file paths to read/modify]
  Acceptance: [what "done" looks like — measurable]
  Tools needed: [Read, Write, Edit, Bash, Grep, Glob, etc.]
  Dependencies: [output from which prior wave/agent]
```

### Agent Count by Session Type

| Session Type | Wave 1 | Wave 2 | Wave 3 | Wave 4 | Wave 5 |
|-------------|--------|--------|--------|--------|--------|
| housekeeping | 2 | 2 | 1 | 1 | 1 |
| feature | 4-6 | 6 | 4-6 | 4 | 2 |
| deep | 6-8 | 6-10 | 6-8 | 6 | 2-4 |

Read `agents-per-wave` from Session Config to cap the maximum.

## Step 4: Issue Updates

Before presenting the plan:
1. Mark all selected issues as `status:in-progress`:
   - GitLab: `glab issue update <IID> --label "status:in-progress"`
   - GitHub: `gh issue edit <NUMBER> --add-label "status:in-progress"`
2. Add a comment to each issue noting the session and planned wave:
   - GitLab: `glab issue note <IID> -m "Working on this in current session (Wave N)"`
   - GitHub: `gh issue comment <NUMBER> -b "Working on this in current session (Wave N)"`

## Step 5: Present Plan for Approval

Present the plan in this format:

```
## Wave Plan (Session: [type])

### Wave 1: Validation & Discovery ([N agents])
- Agent 1: [task] → [files] → [acceptance criteria]
- Agent 2: [task] → [files] → [acceptance criteria]
...

### Wave 2: Implementation A ([N agents])
- Agent 1: [task] → [files] → [acceptance criteria]
...

### Wave 3: Implementation B ([N agents])
...

### Wave 4: Quality & Testing ([N agents])
...

### Wave 5: Finalization ([N agents])
...

### Inter-Wave Checkpoints
- After W1: Validate discoveries, adjust W2 scope if needed
- After W2: Run incremental tests, check for conflicts between agents. **If `pencil` configured: design review — screenshot frames, compare with implemented UI, flag drift.**
- After W3: Integration test, verify all pieces connect. **If `pencil` configured: final design-code alignment check before quality waves.**
- After W4: Full quality gate — if failing, create fix tasks for W5
- After W5: Final review before session-end

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
- **TypeScript check only in Wave 1 (baseline) and Wave 4/5** — not during implementation waves
- **Build commands only in housekeeping sessions** — never during feature/deep work mid-session
- **Agent prompts must be self-contained** — include ALL context the agent needs (file paths, issue details, acceptance criteria). The agent starts with zero context.
- **If a task is too large for one agent**, split it across multiple agents with clear file-boundary separation
