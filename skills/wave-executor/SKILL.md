---
name: wave-executor
user-invocable: false
tags: [orchestration, execution, agents, waves]
model-preference: sonnet
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
4. **Verify `jq` is installed** — run `command -v jq`. If not found, warn the user: "⚠ jq is not installed. Scope and command enforcement hooks will be DISABLED. Install jq (`brew install jq` / `apt install jq`) to enable security enforcement." Do NOT proceed with waves until user acknowledges.
5. Read `persistence` from Session Config (default: `true`)
6. **Initialize session metrics** (if `persistence` enabled): Prepare a metrics tracking object for this session:
   - `session_id`: `<branch>-<YYYY-MM-DD>-<HHmm>` (HHmm from `started_at` — ensures uniqueness across multiple sessions per day)
   - `session_type`: from Session Config
   - `started_at`: ISO 8601 timestamp
   - `waves`: empty array (populated after each wave)
   This object lives in memory during execution — it is written to disk by session-end.

## Pre-Wave 1: Capture Session Start Ref

Before dispatching Wave 1, capture the current commit as the session baseline:

```bash
SESSION_START_REF=$(git rev-parse HEAD)
```

Store this value for use throughout the session — it is needed by the simplification pass (Quality wave) and session-reviewer dispatch to determine which files changed during this session. Include it in the coordinator's context, NOT in individual agent prompts.

## Pre-Wave 1: Initialize STATE.md

> Skip this section entirely if `persistence: false`.

Before dispatching Wave 1, write `.claude/STATE.md` with YAML frontmatter and Markdown body:

```yaml
---
session-type: feature|deep|housekeeping
branch: <current branch>
issues: [<issue numbers from plan>]
started_at: <ISO 8601 timestamp with timezone>
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

Create the `.claude/` directory if needed (`mkdir -p .claude`) before writing. This file is the persistent state record — other skills and resumed sessions read it.

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
   - **Simplification pass** (at the start of the Quality wave, before test/review agents):
     1. Identify all files changed in this session: `git diff --name-only $SESSION_START_REF..HEAD`
     2. Dispatch 1-2 simplification agents with:
        - Changed file list (production files only — exclude `*.test.*`, `*.spec.*`, `__tests__/`)
        - Reference: `slop-patterns.md` from the discovery skill directory — include the actual patterns in the agent prompt
        - Reference: project's CLAUDE.md conventions
        - Instruction: "Review each changed file for AI-generated code patterns. Apply targeted simplifications: remove unnecessary try-catch around non-throwing operations, delete over-documentation (params that repeat the name, returns that say 'the result'), replace re-implemented stdlib functions with standard alternatives, simplify redundant boolean logic (if/else returning true/false, double negation, explicit boolean comparisons). Do NOT change functionality. Do NOT touch files you weren't given. Do NOT commit."
        - Tools: Read, Edit, Grep, Glob
        - Model: sonnet
     3. After simplification agents complete, proceed to Quality test/review agents
   - After **Quality**: Full Gate quality checks per quality-gates (typecheck + test + lint, must all pass)
   - After **Finalization**: final git status check
5. **Session-reviewer dispatch** (after Impl-Core, Impl-Polish, and Quality waves only):
   - After **Impl-Core** and **Impl-Polish** waves, dispatch the session-reviewer agent to verify wave output:
     ```
     Agent({
       description: "Review wave N output",
       prompt: "<include: session plan, wave results, changed files list, acceptance criteria>",
       subagent_type: "session-orchestrator:session-reviewer",
       run_in_background: false
     })
     ```
   - The session-reviewer checks changed files against the plan and reports PASS/WARN/FAIL per category (implementation, tests, TypeScript, security, silent failures, test depth, type design, issues).
   - If the session-reviewer reports **WARN or FAIL** findings: add fix tasks to the next wave's agent assignments (feed into step 3 — Adapt Plan).
   - After the **Quality** wave: dispatch the session-reviewer with **full session scope** (all files changed since session start, not just the current wave). Use `git diff --name-only $SESSION_START_REF..HEAD` to provide the complete changed files list.
   - **Discovery** and **Finalization** waves: skip session-reviewer dispatch — Discovery is read-only and Finalization is a final git status check only.
   - This is complementary to the incremental verification in step 4 — the session-reviewer provides deeper analysis (security, silent failures, test depth, type design) that automated checks do not cover.
6. **Pencil design review** (after Impl-Core and Impl-Polish roles only, if `pencil` configured in Session Config):
   a. Check Pencil editor state: `get_editor_state({ include_schema: false })`. If no editor active, open the configured `.pen` file via `open_document({ filePathOrTemplate: "<pencil-path>" })`. If that also fails → skip with note "Pencil review skipped — .pen file unavailable."
   b. Get design structure: `batch_get({ filePath: "<pencil-path>", patterns: [{ type: "frame" }], readDepth: 2, searchDepth: 2 })` — find frames relevant to this wave's UI work.
   c. Screenshot relevant frames: `get_screenshot({ filePath: "<pencil-path>", nodeId: "<frame-id>" })` for each frame matching the wave's UI tasks.
   d. Read the actual UI files changed in this wave (from agent outputs).
   e. **Compare**: layout structure, component hierarchy, visual elements (headings, buttons, inputs, cards), responsive behavior.
   f. **Report** in wave progress:
      `- Design: [ALIGNED / MINOR DRIFT / MAJOR MISMATCH] — [specific findings]`
   g. **Act on results**:
      - ALIGNED → proceed to next wave
      - MINOR DRIFT → add fix tasks to next wave (no pause)
      - MAJOR MISMATCH → **PAUSE wave execution**:
        1. Report specific mismatches to user
        2. AskUserQuestion: "Continue as-is", "Revise plan for remaining waves", "Abort session"
        3. If "Revise" → re-run session-plan for remaining waves only
        4. If "Abort" → mark remaining waves as DEFERRED, proceed to session-end
   
   Always use the `filePath` parameter on Pencil MCP calls. Only review frames relevant to the current wave, not the entire file.

7. **Capture wave metrics**: If `persistence` is enabled in Session Config, record for this wave after all agents complete and quality checks run. If `persistence` is `false`, skip metrics capture entirely — do not accumulate in-memory metrics. Record:
   - `wave_number`, `role`, `started_at` (when agents were dispatched), `completed_at` (when all finished)
   - `agent_count`: number of agents dispatched
   - Per-agent results: `{description, status: done|partial|failed, files_changed_count}`
   - `files_changed`: total unique files changed this wave (from `git diff --stat --name-only`)
   - `quality_check`: incremental check result (pass/fail/skipped)
   Append this wave record to the session metrics `waves` array.

### 3. Adapt Plan (if needed)

After reviewing wave results, decide:

- **On track**: proceed to next wave as planned
- **Minor issues**: add fix tasks to next wave's agent assignments
- **Major blocker**: inform the user, propose revised plan for remaining waves
- **Agent failed**: re-dispatch with corrected instructions in next wave
- **Scope change**: document why, adjust remaining waves, inform user

**Deviation protocol**: ALWAYS document WHY you deviated from the plan. Log it in a brief note that session-end can reference.

#### Dynamic Scaling

After reviewing wave results, adjust the next wave's agent count based on performance signals:

| Signal | Action | Example |
|--------|--------|---------|
| All agents completed in under 3 minutes wall-clock, no issues | Reduce next wave by 1-2 agents | 6 agents all done in <3m → next wave uses 4 |
| Agent failures or broken code | Add fix agents to next wave (+1-2) | 2 agents failed → next wave gets 2 extra |
| Scope expansion discovered | Scale up next wave | New module found → add agents for it |
| Quality regressions found | Add targeted fix agents | 3 test failures → 3 fix agents next wave |

**Scaling constraints:**
- Never exceed `agents-per-wave` from Session Config
- Never go below 1 agent per wave
- Log all scaling decisions in the wave progress update
- Record actual vs. planned agent count in wave metrics

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
- Duration: [Nm Ns] (wall-clock from dispatch to completion)
- Tests: [passing/failing] | TypeScript: [0 errors / N errors]
- Design: [aligned/drift/mismatch — or N/A if not Impl-Core/Impl-Polish or no pencil config]
- Scaling: [unchanged / reduced to N / increased to N] — [reason]
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
2. Validate by piping through `bash "$CLAUDE_PLUGIN_ROOT/scripts/validate-wave-scope.sh"`. If validation fails (exit 1), fix the JSON based on stderr errors and retry.
3. `allowedPaths` is the UNION of all agent file scopes for this wave
4. Read `enforcement` from Session Config (default: `warn`). The `enforcement` field is REQUIRED in `wave-scope.json` — always write it explicitly. The hooks default to `warn` if the field is missing, which would silently degrade strict enforcement. If jq was confirmed missing in Pre-Execution Check step 4, set `enforcement` to `off` and include a comment in the progress update noting that enforcement is disabled.
5. For **Discovery** role waves, set `allowedPaths` to `[]` (empty array) — Discovery agents are read-only and must not modify files. Also add to each Discovery agent prompt: "You are READ-ONLY. Do NOT use Edit or Write tools."
   > **Defense in depth:** The empty `allowedPaths` enforcement hook is the PRIMARY barrier (blocks Write/Edit at the tool level). The prompt instruction is a SECONDARY safeguard. If jq is unavailable (enforcement set to `off`), the prompt instruction becomes the ONLY barrier — log a warning in this case.
6. For **Quality** role waves, use two-phase scope enforcement:
   - **Phase 1 (Simplification)**: Before dispatching simplification agents, set `allowedPaths` to the production files changed this session (`git diff --name-only $SESSION_START_REF..HEAD`, excluding test files). After simplification agents complete, delete `.claude/wave-scope.json`.
   - **Phase 2 (Test/Review)**: Before dispatching test and review agents, regenerate `.claude/wave-scope.json` with `allowedPaths` restricted to test file patterns (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`, plus test config files). Quality test/review agents must not modify production source code.
7. After the final wave completes, delete `.claude/wave-scope.json` (cleanup)

## Circuit Breaker & Worktree Isolation

> **Reference:** See `circuit-breaker.md` in this skill directory for MaxTurns enforcement, spiral detection, recovery protocol, and worktree isolation configuration. Apply those rules during every wave dispatch and post-wave review.

## Agent Prompt Best Practices

Each agent prompt MUST include:

1. **Clear scope boundary**: "You are working on [X]. Do NOT modify files outside [paths]."
2. **Full context**: file paths, current code structure, issue description
3. **Acceptance criteria**: measurable definition of done
4. **Rule references**: "Follow patterns in .claude/rules/[relevant].md"
5. **Testing expectation**: "Write tests for your changes" or "Run existing tests"
6. **Commit instruction**: "Do NOT commit. The coordinator handles commits."
7. **Turn limit**: Include the maxTurns instruction from `circuit-breaker.md`

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
