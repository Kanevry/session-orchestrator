---
name: wave-executor
description: >
  Executes the agreed session plan in 5 waves with parallel subagents. Handles inter-wave
  quality checks, plan adaptation, and progress tracking. Core orchestration engine for
  feature and deep sessions. Triggered by /go command.
---

# Wave Executor Skill

## Execution Model

You are the **coordinator**. You do NOT implement — you orchestrate. Your job:
1. Dispatch subagents for each wave
2. Wait for ALL agents in a wave to complete
3. Review their outputs
4. Adapt the plan if needed
5. Dispatch the next wave
6. Repeat until all 5 waves complete

## Pre-Execution Check

Before starting Wave 1:
1. `git status --short` — ensure clean working directory (commit or stash if needed)
2. Verify no parallel session conflicts (unexpected modified files)
3. Confirm the agreed plan is still valid (no new critical issues since planning)

## Wave Execution Loop

For each wave (1 through 5):

### 1. Dispatch Agents

Use the **Agent tool** to dispatch all agents for this wave IN PARALLEL in a SINGLE message:

```
For each agent in this wave:
  Agent({
    description: "<3-5 word summary>",
    prompt: "<COMPLETE task context including:
      - What to do (specific, measurable)
      - Which files to read/modify (exact paths)
      - Acceptance criteria (how to verify done)
      - Relevant patterns from .claude/rules/
      - GitLab issue reference if applicable
      - What NOT to touch (other agents' files)
      >",
    subagent_type: "general-purpose",
    run_in_background: false   // CRITICAL: always false — wait for completion
  })
```

**CRITICAL: `run_in_background: false`** — You MUST wait for ALL agents to complete before proceeding. NEVER use `run_in_background: true` during wave execution. Dispatch all agents in a single message for maximum parallelism, then wait.

### 2. Review Agent Outputs

After ALL agents in the wave complete:

1. **Read each agent's result** carefully
2. **Check for conflicts**: did two agents modify the same file? → manual merge needed
3. **Check for failures**: did any agent report errors or blockers?
4. **Run incremental verification**:
   - After Wave 1: no verification needed (read-only)
   - After Wave 2: run tests on changed files only
   - After Wave 3: run full integration test if available
   - After Wave 4: `tsgo --noEmit` + `pnpm test --run` + `pnpm lint`
   - After Wave 5: final git status check
5. **Pencil design review** (after Wave 2 and Wave 3 only, if `pencil` configured in Session Config):
   a. Check Pencil editor state: `get_editor_state({ include_schema: false })`. If no editor active, open the configured `.pen` file via `open_document({ filePathOrTemplate: "<pencil-path>" })`. If that also fails → skip with note "Pencil review skipped — .pen file unavailable."
   b. Get design structure: `batch_get({ filePath: "<pencil-path>", patterns: [{ type: "frame" }], readDepth: 2, searchDepth: 2 })` — find frames relevant to this wave's UI work.
   c. Screenshot relevant frames: `get_screenshot({ filePath: "<pencil-path>", nodeId: "<frame-id>" })` for each frame matching the wave's UI tasks.
   d. Read the actual UI files changed in this wave (from agent outputs).
   e. **Compare**: layout structure, component hierarchy, visual elements (headings, buttons, inputs, cards), responsive behavior.
   f. **Report** in wave progress:
      `- Design: [ALIGNED / MINOR DRIFT / MAJOR MISMATCH] — [specific findings]`
   g. **Act**: ALIGNED → proceed. MINOR DRIFT → add fix tasks to next wave. MAJOR MISMATCH → inform user, propose revised plan.
   
   Always use the `filePath` parameter on Pencil MCP calls. Only review frames relevant to the current wave, not the entire file.

### 3. Adapt Plan (if needed)

After reviewing wave results, decide:

- **On track**: proceed to next wave as planned
- **Minor issues**: add fix tasks to next wave's agent assignments
- **Major blocker**: inform the user, propose revised plan for remaining waves
- **Agent failed**: re-dispatch with corrected instructions in next wave
- **Scope change**: document why, adjust remaining waves, inform user

**Deviation protocol**: ALWAYS document WHY you deviated from the plan. Log it in a brief note that session-end can reference.

### 4. Progress Update

After each wave, provide a brief status:

```
## Wave [N] Complete ✓
- [Agent 1]: [done/partial/failed] — [1-line summary]
- [Agent 2]: [done/partial/failed] — [1-line summary]
- Tests: [passing/failing] | TypeScript: [0 errors / N errors]
- Design: [aligned/drift/mismatch — or N/A if no pencil config or Wave 1/4/5]
- Adaptations for Wave [N+1]: [none / list changes]
```

## Agent Prompt Best Practices

Each agent prompt MUST include:

1. **Clear scope boundary**: "You are working on [X]. Do NOT modify files outside [paths]."
2. **Full context**: file paths, current code structure, issue description
3. **Acceptance criteria**: measurable definition of done
4. **Rule references**: "Follow patterns in .claude/rules/[relevant].md"
5. **Testing expectation**: "Write tests for your changes" or "Run existing tests"
6. **Commit instruction**: "Do NOT commit. The coordinator handles commits."

Each agent prompt MUST NOT include:
- References to other agents' tasks (isolation)
- Vague instructions like "improve" or "optimize" without specifics
- Assumptions about code state — provide the actual state

## Session Type Behavior

### Housekeeping Sessions
- Skip wave structure entirely
- Execute tasks serially with 1-2 agents
- Focus: git cleanup, SSOT refresh, CI fixes, branch merges, documentation
- End with a single commit summarizing all housekeeping work

### Feature Sessions
- Full 5-wave execution
- 4-6 agents per wave (read from Session Config)
- Balance between implementation speed and quality

### Deep Sessions
- Full 5-wave execution
- Up to 10-18 agents per wave (read from Session Config)
- Extra emphasis on Wave 1 discovery and Wave 4 testing
- May include security audits, performance profiling, architecture refactoring

## Error Recovery

| Situation | Action |
|-----------|--------|
| Agent times out | Re-dispatch with smaller scope |
| Agent produces broken code | Add fix task to next wave |
| Tests fail after wave | Diagnose in next wave, don't skip |
| Merge conflict between agents | Resolve manually, document |
| TypeScript errors introduced | Track count, must be 0 by Wave 4 |
| New critical issue discovered | Inform user, add to Wave 3+ if fits scope |
| Agent edits wrong files | Revert via git, re-dispatch with stricter scope |

## Completion

After Wave 5 completes successfully:
1. Report final status to the user
2. Suggest invoking `/close` to finalize the session
3. Do NOT auto-commit — `/close` handles that with proper verification

## Anti-Patterns

- **NEVER** run `run_in_background: true` during waves — you lose coordination ability
- **NEVER** skip inter-wave review — quality degrades exponentially
- **NEVER** let agents commit independently — coordinator commits at session end
- **NEVER** continue to next wave if previous wave has unresolved failures
- **NEVER** dispatch more agents than configured in `agents-per-wave`
- **NEVER** let wave execution run without reporting progress to the user
