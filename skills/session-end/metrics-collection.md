# Phase 1.7: Metrics Collection

> Sub-file of the session-end skill. Executed as part of Phase 1 when `persistence` is enabled.
> For the full session close-out flow, see `SKILL.md`.

### 1.7 Metrics Collection

> Gate: Only run if `persistence` is enabled in Session Config.

Finalize session metrics by reading the wave data accumulated during execution:

1. Read `<state-dir>/STATE.md` Wave History to extract per-wave data: agent counts, statuses, files changed

> **Graceful degradation:** If STATE.md is missing expected fields (no Wave History, missing frontmatter keys, malformed YAML), degrade gracefully: report what is available, skip metrics fields that cannot be parsed. Do NOT fail the session close because STATE.md is incomplete — a crashed session may leave partial STATE.md behind.

2. Compute session totals:
   - `total_duration_seconds`: from `started_at` to now (ISO 8601 diff)
   - `total_waves`: count of completed waves
   - `total_agents`: sum of agents across all waves
   - `total_files_changed`: unique files changed across entire session (from `git diff --stat`)
   - `agent_summary`: `{complete: N, partial: N, failed: N, spiral: N}`
3. Read stagnation events from `.orchestrator/metrics/events.jsonl` filtered by `event == "stagnation_detected"` AND `session == <session_id>`. If the file does not exist or contains no matching entries, treat as zero events (omit the field per the rule below) — do NOT fail the session close. Aggregate into `stagnation_events`:
   - `total`: count of matching events
   - `by_pattern`: count by `pattern` value (omit zero-valued keys)
   - `by_error_class`: count by `error_class` value (omit zero-valued keys; omit entire sub-object if all events lack error_class)
   - `files`: unique list of non-null `file` values (deduplicated)
   - **Omit the entire `stagnation_events` field if `total == 0`** (keeps historical entries clean).
4. Read grounding events from `.orchestrator/metrics/events.jsonl` filtered by `event == "grounding_injected"` AND `session == <session_id>`. If the file does not exist or contains no matching entries, treat as zero events (omit the field per the rule below) — do NOT fail the session close. Aggregate into `grounding_injections`:
   - `count`: total number of matching events
   - `files`: deduplicated list of unique file paths from the events (sort alphabetically)
   - `total_lines`: sum of `lines` field across all events
   - **Omit the entire `grounding_injections` field if `count == 0`** (matches stagnation_events pattern to keep historical entries clean).
5. Prepare the JSONL entry (written in Phase 3.7):
   ```json
   {
     "session_id": "<branch>-<YYYY-MM-DD>-<HHmm>",
     "session_type": "<type>",
     "platform": "<claude|codex>",
     "started_at": "<ISO 8601>",
     "completed_at": "<ISO 8601>",
     "duration_seconds": N,
     "total_waves": N,
     "total_agents": N,
     "total_files_changed": N,
     "agent_summary": {"complete": N, "partial": N, "failed": N, "spiral": N},
     "waves": [
       {"wave": 1, "role": "Discovery", "agent_count": N, "files_changed": N, "quality": "pass|fail|skip"},
       ...
     ],
     "discovery_stats": {
       "probes_run": N,
       "findings_raw": N,
       "findings_verified": N,
       "false_positives": N,
       "user_dismissed": N,
       "issues_created": N,
       "by_category": {
         "code": {"findings": N, "actioned": N},
         "infra": {"findings": N, "actioned": N},
         "ui": {"findings": N, "actioned": N},
         "arch": {"findings": N, "actioned": N},
         "session": {"findings": N, "actioned": N}
       }
     },
     "review_stats": {
       "total_findings": N,
       "high_confidence": N,
       "auto_fixed": N,
       "manual_required": N
     },
     "effectiveness": {
       "planned_issues": N,
       "completed": N,
       "carryover": N,
       "emergent": N,
       "completion_rate": 0.0
     },
     "grounding_injections": {
       "count": N,
       "files": ["..."],
       "total_lines": M
     },
     "stagnation_events": {
       "total": N,
       "by_pattern": {"error-echo": N, "turn-key-repetition": N, "pagination-spiral": N},
       "by_error_class": {"edit-format-friction": N, "scope-denied": N, "command-blocked": N, "other": N},
       "files": ["<relative path>", "..."]
     }
   }
   ```

> The `session_id` uses `<HHmm>` from the `started_at` timestamp to ensure uniqueness when multiple sessions run on the same branch in one day.

> **Conditional fields:**
> - `discovery_stats`: populated ONLY when `discovery-on-close: true` in Session Config AND Phase 1.5 executed successfully. Source: the stats object returned by the discovery skill (see discovery skill Phase 4.6 for schema). When discovery runs in **embedded mode** (Phases 0-4 only), `user_dismissed`, `issues_created`, and `actioned` per category will always be `0` — embedded mode does not perform user triage (Phase 5) or issue creation (Phase 6).
> - `review_stats`: populated ONLY when Phase 1.8 dispatched the session-reviewer agent AND it returned findings. Source: the session-reviewer's output summary.
> - `effectiveness`: ALWAYS populated from Phase 1 plan verification results. `completion_rate` = `completed / planned_issues` (0.0-1.0, where 0.0 means nothing was completed).
> - `stagnation_events`: populated ONLY when ≥1 stagnation event was logged to `events.jsonl` during this session. When `total == 0`, the field is omitted from the JSONL entry.
> - `grounding_injections`: populated ONLY when ≥1 `grounding_injected` event was logged to `events.jsonl` during this session. When `count == 0`, the field is omitted from the JSONL entry.
