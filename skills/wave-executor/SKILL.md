---
name: wave-executor
user-invocable: false
description: >
  Executes the agreed session plan in waves with role-based execution and parallel subagents. Handles inter-wave
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
6. Repeat until all waves complete

## Pre-Execution Check

Before starting the first wave (Discovery role):
1. `git status --short` — ensure clean working directory (commit or stash if needed)
2. Verify no parallel session conflicts (unexpected modified files)
3. Confirm the agreed plan is still valid (no new critical issues since planning)
4. Read `persistence` from Session Config (default: `true`)

## Pre-Wave 1: Initialize STATE.md

> Skip this section entirely if `persistence: false`.

Before dispatching Wave 1, write `.claude/STATE.md` with YAML frontmatter and Markdown body:

```yaml
---
session-type: feature|deep|housekeeping
branch: <current branch>
issues: [<issue numbers from plan>]
started: <ISO 8601 timestamp with timezone>
status: active
current-wave: 0
total-waves: <from session plan>
---
```

```markdown
## Current Wave

Wave 0 — Initializing

## Wave History

(none yet)

## Deviations

(none yet)
```

Create the `.claude/` directory if it doesn't exist. This file is the persistent state record — other skills and resumed sessions read it.

## Wave Execution Loop

For each wave, resolve its assigned role(s) from the session plan's role-to-wave mapping:

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
      - VCS issue reference if applicable
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
4. **Run incremental verification** (per the quality-gates skill, based on the wave's role):
   - After **Discovery**: no verification needed (read-only)
   - After **Impl-Core**: Incremental quality checks per quality-gates (test changed files, typecheck)
   - After **Impl-Polish**: Incremental quality checks + integration verification
   - After **Quality**: Full Gate quality checks per quality-gates (typecheck + test + lint, must all pass)
   - After **Finalization**: final git status check
5. **Pencil design review** (after Impl-Core and Impl-Polish roles only, if `pencil` configured in Session Config):
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

### 3a. Post-Wave: Update STATE.md

> Skip if `persistence: false`.

After each wave completes and before the progress update, update `.claude/STATE.md`:

1. **Frontmatter**: set `current-wave` to the just-completed wave number; set `status` to `active` (or `paused` if waiting on user input)
2. **`## Current Wave`**: replace contents with next wave info — wave number, role, agents to dispatch and count
3. **`## Wave History`**: append an entry for the completed wave:
   ```
   ### Wave N — <Role>
   - Agent "<description>": <done|partial|failed> — <files changed> — <1-line note>
   - Agent "<description>": <done|partial|failed> — <files changed> — <1-line note>
   ```
4. **`## Deviations`**: if the plan was adapted in step 3, append a timestamped entry:
   ```
   - [<ISO timestamp>] Wave N: <what changed and why>
   ```

### 4. Progress Update

After each wave, provide a brief status:

```
## Wave [N] ([Role]) Complete ✓
- [Agent 1]: [done/partial/failed] — [1-line summary]
- [Agent 2]: [done/partial/failed] — [1-line summary]
- Tests: [passing/failing] | TypeScript: [0 errors / N errors]
- Design: [aligned/drift/mismatch — or N/A if not Impl-Core/Impl-Polish or no pencil config]
- Adaptations for Wave [N+1] ([NextRole]): [none / list changes]
```

## Scope Manifest

Before each wave dispatch:

1. **Write `.claude/wave-scope.json`** with the wave's scope:
   ```json
   {
     "wave": N,
     "role": "<role>",
     "enforcement": "<from Session Config, default: warn>",
     "allowedPaths": ["<from agent specs in session plan>"],
     "blockedCommands": ["rm -rf", "git push --force", "DROP TABLE", "git reset --hard", "git checkout -- ."]
   }
   ```
2. `allowedPaths` is the UNION of all agent file scopes for this wave
3. Read `enforcement` from Session Config (default: `warn`)
4. After the final wave completes, delete `.claude/wave-scope.json` (cleanup)

## Circuit Breaker

1. **MaxTurns enforcement**: Read `max-turns` from Session Config (default: auto — housekeeping=8, feature=15, deep=25). Include this instruction in EVERY agent prompt:
   ```
   TURN LIMIT: You have a maximum of [N] turns. If you cannot complete within [N] turns, report PARTIAL with what you accomplished and what remains.
   ```
2. **Spiral detection**: After each wave, the coordinator checks agent results for:
   - Same file edited 3+ times → possible thrashing
   - Same error message repeated across turns → stuck
   - Agent reverted its own changes → loop
   If spiral detected: log in STATE.md, mark agent as SPIRAL, re-scope task narrower for next wave.
3. **Recovery protocol**:
   - FAILED agent → log in STATE.md, add fix task to next wave with corrected instructions
   - PARTIAL agent → carry forward remaining work with context
   - SPIRAL agent → revert changes, narrow scope, consider splitting task

## Worktree Isolation

1. **When to use**: Read `isolation` from Session Config. Default: `worktree` for feature/deep sessions, `none` for housekeeping.
2. **Dispatch with isolation**: When isolation is enabled, add `isolation: "worktree"` to Agent tool calls:
   ```
   Agent({
     description: "...",
     prompt: "...",
     subagent_type: "general-purpose",
     run_in_background: false,
     isolation: "worktree"
   })
   ```
3. **Post-wave merge**: After wave completes, worktree changes are automatically available. If agents made changes in worktrees:
   - Review each agent's changes for conflicts
   - If conflicts detected: resolve manually before proceeding
   - Run incremental quality checks after merging
4. **Fallback**: If worktree creation fails (e.g., git state issue), fall back to shared directory with a warning logged.

## Agent Prompt Best Practices

Each agent prompt MUST include:

1. **Clear scope boundary**: "You are working on [X]. Do NOT modify files outside [paths]."
2. **Full context**: file paths, current code structure, issue description
3. **Acceptance criteria**: measurable definition of done
4. **Rule references**: "Follow patterns in .claude/rules/[relevant].md"
5. **Testing expectation**: "Write tests for your changes" or "Run existing tests"
6. **Commit instruction**: "Do NOT commit. The coordinator handles commits."
7. **Turn limit**: Include the maxTurns instruction from the Circuit Breaker section

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
- Full wave execution (5 roles mapped to configured wave count)
- 4-6 agents per wave (read from Session Config)
- Balance between implementation speed and quality

### Deep Sessions
- Full wave execution (5 roles mapped to configured wave count)
- Up to 10-18 agents per wave (read from Session Config)
- Extra emphasis on Discovery role and Quality role
- May include security audits, performance profiling, architecture refactoring

## Error Recovery

| Situation | Action |
|-----------|--------|
| Agent times out | Re-dispatch with smaller scope |
| Agent produces broken code | Add fix task to next wave |
| Tests fail after wave | Diagnose in next wave, don't skip |
| Merge conflict between agents | Resolve manually, document |
| TypeScript errors introduced | Track count, run Full Gate per quality-gates by Quality wave |
| New critical issue discovered | Inform user, add to Impl-Polish+ roles if fits scope |
| Agent edits wrong files | Revert via git, re-dispatch with stricter scope |

## Completion

After the Finalization wave completes successfully:
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
