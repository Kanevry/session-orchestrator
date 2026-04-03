# Circuit Breaker & Worktree Isolation — Reference

Sub-reference for the wave-executor skill. Defines safety mechanisms for agent execution.

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
