# Circuit Breaker & Worktree Isolation — Reference

Sub-reference for the wave-executor skill. Defines safety mechanisms for agent execution.

## Circuit Breaker

1. **MaxTurns enforcement**: Read `max-turns` from Session Config (default: auto — housekeeping=8, feature=15, deep=25). Include this instruction in EVERY agent prompt:
   ```
   TURN LIMIT: You have a maximum of [N] turns. If you cannot complete within [N] turns, report PARTIAL with what you accomplished and what remains.
   ```
   The agent prompt must also include this status reporting instruction:
   ```
   STATUS REPORTING: When you finish, end your final message with exactly one of:
   - STATUS: done — <1-line summary of what was accomplished>
   - STATUS: partial — <what was accomplished> | REMAINING: <what still needs to be done>
   - STATUS: failed — <what went wrong>
   Do NOT omit the STATUS line. The coordinator uses it to track progress.
   ```
2. **Spiral detection**: After each wave, the coordinator checks agent results for:
   - Same file edited 3+ times **within a single agent's execution** (across its turns) → possible thrashing
   - Same error message repeated across turns → stuck
   - Agent reverted its own changes → loop
   If spiral detected: log in STATE.md, mark agent as SPIRAL, re-scope task narrower for next wave.

   > Spiral detection operates per-agent, not per-wave. The coordinator reviews each agent's output independently for spiral indicators after the wave completes. Two different agents editing the same file is expected (conflict resolution, not spiral).

## Status Detection Protocol

The coordinator determines each agent's status after the wave completes:

1. **Read the agent's final output** and look for the `STATUS:` line
2. **Map to status**:
   - `STATUS: done` → agent completed successfully
   - `STATUS: partial` → agent hit turn limit or couldn't finish (PARTIAL)
   - `STATUS: failed` → agent encountered an error it couldn't recover from (FAILED)
   - No STATUS line found → infer from output: if agent produced changes, mark as `done`; if it reported errors, mark as `failed`; if output is truncated, mark as `partial`
3. **Spiral detection** (checked independently of the STATUS line):
   - After the wave, review each agent's git history in its worktree (or shared directory)
   - If the same file was edited 3+ times by a single agent → mark as SPIRAL (overrides other status)
   - Detection method: `git log --oneline --name-only` within the agent's execution scope
   - Two different agents editing the same file is NOT a spiral — that's expected coordination

### Status Definitions

| Status | Meaning | Trigger | Recovery |
|--------|---------|---------|----------|
| **done** | Agent completed all assigned work | Agent reports `STATUS: done` | None needed |
| **partial** | Agent made progress but couldn't finish | Turn limit hit, or agent reports `STATUS: partial` | Carry forward remaining work to next wave with context |
| **failed** | Agent couldn't make meaningful progress | Tool errors, invalid assumptions, agent reports `STATUS: failed` | Re-dispatch with corrected instructions and narrower scope |
| **spiral** | Agent got stuck in an edit loop | Same file edited 3+ times (detected post-wave) | Revert agent's changes, narrow scope, split task if needed |

3. **Recovery protocol**:
   - FAILED agent → log in STATE.md, add fix task to next wave with corrected instructions
   - PARTIAL agent → carry forward remaining work with context
   - SPIRAL agent → revert the agent's changes (`git checkout -- <affected-files>` or `git stash` the agent's worktree), narrow scope to a single file or function, re-dispatch in next wave. If the task spiraled twice, escalate to the user.

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
   - Review each agent's changes for conflicts using `git diff` between worktree branches
   - **Merge strategy**: Apply agent changes sequentially (by agent number). For each agent:
     a. Attempt fast-forward merge. If clean, proceed.
     b. If conflicts: prefer the later agent's version for new code, prefer the earlier agent's version for modified existing code. When unclear, keep both versions and add a fix task to the next wave.
   - After all agents merged, run incremental quality checks
   - Document any conflict resolutions in the wave progress update
4. **Fallback**: If worktree creation fails (e.g., git state issue), fall back to shared directory with a warning logged.
