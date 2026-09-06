# Phase 6.6: Project Intelligence

> Sub-file of the session-start skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-start/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 6.6: Project Intelligence

> Skip if `persistence` config is `false` or `.orchestrator/metrics/learnings.jsonl` does not exist. If the canonical file is absent and a legacy `<state-dir>/metrics/learnings.jsonl` still exists, do not read it — direct the user to run `scripts/migrate-legacy-learnings.sh` once to migrate.

Read `.orchestrator/metrics/learnings.jsonl` and surface active learnings (confidence > 0.3, not expired):

1. Apply cap + rank (#88): sort active learnings by `confidence` DESC, then `created_at` DESC as tiebreaker. Slice to the first `learnings-surface-top-n` entries (default 15). Only the surfaced subset is used for the grouping below. Record the full pre-cap active count `M` (confidence > 0.3, not expired) and the surfaced count `N` for the Surface Health section.
2. Group learnings by type:
   - **Fragile files**: "These files have been problematic: [list with confidence scores]"
   - **Effective sizing**: "Previous sessions suggest [N] agents for [scope type]"
   - **Recurring issues**: "Watch for: [issue patterns with frequency]"
   - **Scope guidance**: "Sessions with [N] issues typically [outcome]"

### Surface health

Present a Surface Health block immediately after the per-type grouping, before the Project Intelligence section. Use the values computed in step 1 (`M` = active count pre-cap, `N` = surfaced count = `learnings-surface-top-n`):

1. Compute confidence buckets across the full active set (M entries, confidence > 0.3, not expired):
   - **High** (≥ 0.7): count entries with `confidence >= 0.7`
   - **Medium** (0.5–0.69): count entries with `confidence >= 0.5 and < 0.7`
   - **Low** (< 0.5, above filter threshold): count entries with `confidence > 0.3 and < 0.5`

2. Present the block using this template (substitute `{M}`, `{N}`, `{M - N}`, bucket counts, oldest values, and paths):

   ```
   **Project Intelligence — Surface Health**
   Active learnings: {M}  (high: {high-count} / medium: {med-count} / low: {low-count})
   Surfaced this session: {N}  |  Suppressed: {M - N}
   Oldest surfaced: {oldest-created_at ISO 8601} ({relative-age} days ago)
   Source file: .orchestrator/metrics/learnings.jsonl
   Vault mirror: {vault-dir value from Session Config, or "not enabled" if absent/empty}
   ```

3. Oldest surfaced entry: find the entry among the top-N surfaced learnings with the smallest `created_at` value. Display the raw ISO 8601 timestamp and compute relative age as `floor((current_date - created_at) / 86400)` days.

4. Vault mirror: read `vault-integration.vault-dir` from Session Config (`echo "$CONFIG" | jq -r '."vault-integration"."vault-dir" // empty'`). If the value is absent or empty, print `"not enabled"`.

5. **Conditional advisory** — print the following line only when `{M - N} > {N}` (i.e., suppressed count exceeds surfaced count):
   > ⚠ More learnings are suppressed ({M - N}) than surfaced ({N}). Consider raising `learnings-surface-top-n` in Session Config or running `/evolve review` to prune low-value entries.
   Do NOT print the advisory when `{M - N} <= {N}`.

3. Include a **Project Intelligence** section in the Phase 7 presentation:
   ```
   ## Project Intelligence (from [N] learnings)
   - Fragile: [files] (confidence: [X])
   - Sizing: [recommendation]
   - Watch: [recurring issues]
   - Scope: [guidance]
   ```
   If no active learnings exist, display: "No project intelligence yet — learnings accumulate after 2+ sessions."

4. **Effectiveness analysis** (requires 5+ sessions in `sessions.jsonl`):

   > Skip if `.orchestrator/metrics/sessions.jsonl` does not exist or has fewer than 5 entries.

   Read `.orchestrator/metrics/sessions.jsonl` and compute:
   - **Completion rate trend**: average `effectiveness.completion_rate` over last 5 sessions
     - If < 0.6: "Completion rate is [X]%. Consider reducing scope or using deep sessions."
     - If > 0.9: "Consistently high completion. Current scope sizing works well."
   - **Discovery probe value**: for sessions with `discovery_stats`, check each category in `by_category`:
     - If `findings == 0` across 3+ sessions: "Probe category '[X]' has produced no findings in [N] sessions. Consider excluding via `discovery-probes` config."
     - If `findings > 5` consistently but issues are rarely created from that category: "Probe category '[X]' generates many findings ([avg]) but few lead to issues. Consider raising `discovery-severity-threshold` or `discovery-confidence-threshold`."
   - **Carryover pattern**: if `effectiveness.carryover / planned_issues > 0.3` across 3+ sessions:
     "High carryover rate ([X]%). Consider: smaller scope, longer sessions (deep), or splitting across sessions."

   If fewer than 5 sessions exist: "Effectiveness analysis: not enough data yet ([N]/5 sessions)."

   Include effectiveness insights in the **Project Intelligence** section of the Phase 7 presentation:
   ```
   ## Project Intelligence (from [N] learnings, [M] sessions)
   - Fragile: [files] (confidence: [X])
   - Sizing: [recommendation]
   - Watch: [recurring issues]
   - Scope: [guidance]
   - Effectiveness: [completion rate trend, probe value, carryover pattern]
   ```

