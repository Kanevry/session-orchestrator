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
   - `total_files_changed`: unique files changed across entire session (from `git diff --stat`). **Not measured** (empty `$SESSION_RANGE`, #1505): the value is unknown, not zero — write `total_files_changed: 0` (`validateSession` requires a non-negative number; `null` or omitting the key is rejected) AND `_backfill_incomplete_fields: ["total_files_changed"]` (append if the array exists), which marks that 0 as a placeholder, the same pair `scripts/lib/session-record-repair.mjs` writes. A bare 0 without the marker claims a measured "no changes".
   - `agent_summary`: `{complete: N, partial: N, failed: N, spiral: N}`
   - **Coordinator-direct fallback (#1321):** when Wave History is empty AND the session ran coordinator-direct (housekeeping — `scripts/lib/session-shape.mjs:364-376` resolves it to ONE coordinator-direct wave that `/go` never hands to wave-executor, so no wave metrics are captured — or the express path), do NOT write `waves: []` / `total_waves: 0`. Write exactly one wave entry `{wave: 1, role: "Housekeeping", agent_count: 0, coordinator_direct: true, files_changed: <N>, quality: "<pass|fail|skip — the close quality-gate result>"}` with `total_waves: 1`, `total_agents: 0`. On this path both that wave's `files_changed` and `total_files_changed` are `git diff --name-only "$SESSION_RANGE" | wc -l` (accessor: `plan-verification.md` § SESSION_START_REF accessor; an empty `$SESSION_RANGE` is a skip, not zero changes — write the unmeasured pair from the `total_files_changed` bullet above and name the accessor's reason in the record's `notes`). The single definition of this shape is `isCoordinatorDirectHousekeeping(record)` in `scripts/lib/session-schema/filters.mjs` (every wave `role: "Housekeeping"` AND `coordinator_direct: true`). Consumers key on it (eval gate-health, evolve effective-sizing), so write `role` and `coordinator_direct` exactly as shown. `session_type` alone never marks it.
3. Read `.orchestrator/metrics/events.jsonl` **once** and build both event aggregates in a single pass. If the file does not exist, treat both aggregates as zero events (omit both fields per the rules below) — do NOT fail the session close.

   Filter all lines where `session == <session_id>`, then partition by `event` value:

   ```bash
   jq -s --arg sid "$SESSION_ID" '
     [.[] | select(.session == $sid)]
     | {
         stagnation: [.[] | select(.event == "stagnation_detected")],
         grounding:  [.[] | select(.event == "orchestrator.grounding.injected")]
       }
   ' .orchestrator/metrics/events.jsonl
   ```

   From the `stagnation` array, aggregate into `stagnation_events`:
   - `total`: count of entries in the array
   - `by_pattern`: count by `pattern` value (omit zero-valued keys)
   - `by_error_class`: count by `error_class` value (omit zero-valued keys; omit entire sub-object if all entries lack `error_class` — only `error-echo` records carry one)
   - `by_source`: count by `source` value — `coordinator` (post-wave review) vs `tail` (the `wave-transcript-tail` monitor, #1114). Same rule: omit zero-valued keys; omit the entire sub-object when no entry carries `source` (pre-#1114 records do not).
   - `files`: unique list of non-null `file` values (deduplicated)
   - **Omit the entire `stagnation_events` field if `total == 0`** (keeps historical entries clean).

   From the `grounding` array, aggregate into `grounding_injections`:
   - `count`: total number of entries in the array
   - `files`: deduplicated list of unique file paths from the entries (sort alphabetically)
   - `total_lines`: sum of `lines` field across all entries
   - **Omit the entire `grounding_injections` field if `count == 0`** (matches stagnation_events pattern to keep historical entries clean).

   > **Per-category zero-match rule:** If the `stagnation` array is empty but the `grounding` array is non-empty (or vice versa), omit only the zero-match field — the other field is still populated normally. The single read handles both cases; no second file read is needed.
4. Prepare the JSONL entry (written in Phase 3.7) by **constructing it programmatically** — DO NOT manually hand-compose ISO timestamp strings. The `completed_at` value MUST come from `new Date().toISOString()` to prevent issue #540-class corruption (e.g., `.3NZ` malformed-fraction inputs that bypass `Date.parse`-only validators). The validator at `scripts/lib/session-schema/validator.mjs` rejects any timestamp that does not match the canonical `YYYY-MM-DDTHH:MM:SS[.SSS]Z` regex.

   Use this snippet pattern (adapt the field values from the session's in-memory state, but keep `new Date().toISOString()` for `completed_at` literally):

   ```bash
   # Issue #540: completed_at is constructed programmatically — DO NOT manually
   # edit the ISO timestamp string. Use the snippet as-is to prevent .3NZ-class
   # corruption.
   METRICS_ENTRY=$(node --input-type=module -e "
   const entry = {
     session_id: '<STATE.md frontmatter session, verbatim>',
     session_type: '<type>',
     platform: '<claude|codex>',
     started_at: '<ISO 8601 from STATE.md frontmatter started_at — already canonical>',
     completed_at: new Date().toISOString(),  // canonical YYYY-MM-DDTHH:MM:SS.SSSZ
     duration_seconds: <N>,
     total_waves: <N>,
     total_agents: <N>,
     total_files_changed: <N>,
     agent_summary: {complete: <N>, partial: <N>, failed: <N>, spiral: <N>},
     waves: [/* {wave, role, agent_count, files_changed, quality, agent_count_planned?, agent_count_started?, agent_count_completed?} */],
     // effectiveness is CONSTRUCTED EXPLICITLY (#773) — NOT left as an optional
     // field for the coordinator to remember. Leaving it optional is exactly how
     // the carryover=0 blind spot recurred (41/41 records read carryover:0).
     // `carryover` = the Phase 1.65 gate carry-list length (see counting rules
     // below), NOT the raw Phase 1.2+1.3 candidate count.
     effectiveness: {
       planned_issues: <N>,
       completed: <N>,
       carryover: <N>,   // = Phase 1.65 gate carry-list length (see rules below)
       emergent: <N>,
       completion_rate: <0.0-1.0>,
       // override_ratio: <0.0-1.0>,  // OPTIONAL (#730/H5) — add ONLY when Phase 2.6 ran; OMIT otherwise (absent = "not measured")
     },
     // Handover-gate open-question telemetry (#773) — top-level, additive,
     // non-negative integers. OMIT (do not write 0) when the gate did not run an
     // interactive triage (fail-open skip / headless / fast-path): absent = "not
     // measured", 0 = "measured zero".
     open_questions_asked: <N>,      // surfaced in Phase 1.65 AUQ Call 2
     open_questions_answered: <N>,   // operator answered
     open_questions_deferred: <N>,   // left `- [ ]`, roundtripped to next session
     // Other optional fields below — populate per the Conditional Fields rules at
     // the bottom of this file; OMIT (do not write null) when the gating
     // condition is not met.
   };
   process.stdout.write(JSON.stringify(entry));
   ")
   ```

   **Canonical JSONL schema** (for field reference — populated by the snippet above):
   ```json
   {
     "session_id": "<STATE.md frontmatter session, verbatim>",
     "session_type": "<type>",
     "platform": "<claude|codex>",
     "started_at": "<canonical ISO 8601 from STATE.md>",
     "completed_at": "<canonical ISO 8601 from new Date().toISOString()>",
     "duration_seconds": N,
     "total_waves": N,
     "total_agents": N,
     "total_files_changed": N,
     "agent_summary": {"complete": N, "partial": N, "failed": N, "spiral": N},
     "waves": [
       {"wave": 1, "role": "Discovery", "agent_count": N, "files_changed": N, "quality": "pass|fail|skip", "agent_count_planned": N, "agent_count_started": N, "agent_count_completed": N},
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
       "completion_rate": 0.0,
       "override_ratio": 0.0
     },
     "open_questions_asked": N,
     "open_questions_answered": N,
     "open_questions_deferred": N,
     "grounding_injections": {
       "count": N,
       "files": ["..."],
       "total_lines": M
     },
     "stagnation_events": {
       "total": N,
       "by_pattern": {"error-echo": N, "turn-key-repetition": N, "pagination-spiral": N, "psa007-git-write": N, "status-partial": N},
       "by_source": {"coordinator": N, "tail": N},
       "by_error_class": {"edit-format-friction": N, "scope-denied": N, "command-blocked": N, "other": N},
       "files": ["<relative path>", "..."]
     }
   }
   ```

   > **ISO-8601 canonical format (#540):** `started_at`, `completed_at`, and `lease_acquired_at` MUST match the regex `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/`. The validating writer (`scripts/emit-session.mjs`) rejects any non-canonical form. Use `new Date().toISOString()` (Node-native, always canonical) — never hand-edit fractional digits or timezone suffixes.

> The `session_id` is the STATE.md frontmatter `session` value, copied verbatim — the semantic label session-start minted, which `.orchestrator/current-session.json` also carries as `semantic_session_id`. Never construct one (the former `<branch>-<YYYY-MM-DD>-<HHmm>` recipe is wrong): `scripts/emit-session.mjs` adopts `raw_session_id`, the token rollup and the events-derived `session_start_ref` only when the record's `session_id` equals the marker's `semantic_session_id`; any other label is WARNed and those fields are omitted.

> **Conditional fields:**
> - `discovery_stats`: populated ONLY when `discovery-on-close: true` in Session Config AND Phase 1.5 executed successfully. Source: the stats object returned by the discovery skill (see discovery skill Phase 4.6 for schema). When discovery runs in **embedded mode** (Phases 0-4 only), `user_dismissed`, `issues_created`, and `actioned` per category will always be `0` — embedded mode does not perform user triage (Phase 5) or issue creation (Phase 6).
> - `review_stats`: populated ONLY when Phase 1.8 dispatched the session-reviewer agent AND it returned findings. Source: the session-reviewer's output summary.
> - `effectiveness`: ALWAYS populated from Phase 1 plan verification results, and CONSTRUCTED EXPLICITLY in the METRICS_ENTRY snippet (#773) — never deferred to a "remember to add" optional step (that omission is how `carryover: 0` slipped past 41 records). `completion_rate` = `completed / planned_issues` (0.0-1.0, where 0.0 means nothing was completed). **`carryover` counting rule (#773):** `carryover` is the **length of the Phase 1.65 gate carry-list** — `autoCarry` ∪ the middle-band `ask` items the operator LEFT SELECTED ∪ the answered-question `impliesWork: true` candidates — NOT the raw Phase 1.2+1.3 candidate count. On the fail-open skip (gate disabled / headless / AUQ unavailable), EVERY candidate carries, so `carryover` = the full candidate-list length. Count the gate's OUTPUT (what reaches Phase 5 Step 3 filing), not its INPUT.
> - `effectiveness.override_ratio` (#730/H5): OPTIONAL nested field = `overridden_findings / max(total_findings_surfaced, 1)` (float 0.0-1.0). Populate ONLY when Phase 2.6 (Broken-Window Budget) ran this session (`broken-window-budget.enabled: true`). OMIT (do NOT write null/0) otherwise — **absent = "not measured"**, `0.0` = "measured, nothing overridden". `overridden_findings` = the summed `count` of the `orchestrator.finding.overridden` events emitted this session; `total_findings_surfaced` = every MED/LOW+ finding surfaced across Phase 1.8 + wave reviewers.
> - `waves[].agent_count_planned` / `waves[].agent_count_started` / `waves[].agent_count_completed` (#724/#1115): OPTIONAL per-wave fields, sourced from `wave-loop.md` § Capture wave metrics step 7 — mirror its definitions exactly, do not re-derive them here. `agent_count_planned` = agents named in the session plan for this wave. `agent_count_started` = distinct agents whose `agent-<id>.meta.json` sidecar is present, after any silent-drop re-dispatch — NOT "produced a tool-result" (under background dispatch the launch ack is a result and would count an agent that never ran). `agent_count_completed` = distinct agents whose task-notification (`<status>completed</status>`) arrived. Omit each field when the wave did not measure it — **absent = "not measured"**, never zero-fill; `0` would read as "measured, no agent started", which is the opposite of an unmeasured wave. The two gaps carry the diagnosis: `agent_count_planned > agent_count_started` after re-dispatch is a persistent silent drop, `agent_count_started > agent_count_completed` at wave end is an agent that started and never returned. Both are also logged to STATE.md `## Deviations` by wave-loop.md, so a record and a deviation entry should agree.
> - `waves[].suite_passed` / `waves[].suite_failed` / `waves[].suite_platform` (#944): OPTIONAL per-wave fields. Treat counts and header platform independently; absent = "not measured", `suite_failed: 0` = "measured, zero failures".
>   **`suite_passed` / `suite_failed`: read the event FIRST, the STATE.md header only as fallback (#966 step 3).** Since #954/#967 the between-waves gate wrapper `scripts/run-quality-gate.mjs` emits `orchestrator.quality_gate.{passed,failed}` with a machine-measured `counts: {passed, failed, total}` AND the `wave_number` it resolved from the `wave-scope.json` sidecar, so per-wave attribution needs no wall-clock window join. Payload fields are flat at the record's top level; for each wave of this session:
>
>   ```bash
>   jq -cR --argjson w "$WAVE" --arg s "$SEMANTIC_SESSION_ID" '
>     fromjson? | objects
>     | select((.event | type) == "string" and (.event | startswith("orchestrator.quality_gate.")))
>     | select(.semantic_session_id == $s and .wave_number == $w and .["counts"] != null)
>     | .["counts"]
>   ' .orchestrator/metrics/events.jsonl | tail -1
>   ```
>
>   `WAVE` and `SEMANTIC_SESSION_ID` come from the existing own session/wave identity; never construct either for this lookup. Filtering by both is mandatory: the ledger accumulates across sessions, and a different session or wave must not supply these counts. `counts.passed` → `suite_passed`, `counts.failed` → `suite_failed`. `tail -1` selects the last matching gate run of the wave, including auto-fix. `-R` with `fromjson? | objects` skips an unreadable ledger line (a torn tail from a killed writer, #1401) instead of letting one parse error end `jq`. The old pipeline could emit an earlier matching value before the parse error; `tail -1` retained that stale value and could hide the jq failure. Known limit: an interrupted `appendFile` can leave a truncated record that `fromjson?` discards completely; `tail -1` can still select an older matching run, which alone is not evidence of the current gate result. The library emits one record per `runQualityGateWithRetry` call, not per retry; `attempts` is not a record count.
>
>   An empty counts selector cannot distinguish a missing event, missing wave attribution,
>   or an attributed event without counts after fail-fast. Inspect the own session's
>   records without the counts filter before deciding whether a documented count
>   fallback case applies:
>
>   ```bash
>   jq -cR --argjson w "$WAVE" --arg s "$SEMANTIC_SESSION_ID" '
>     fromjson? | objects
>     | select((.event | type) == "string" and (.event | startswith("orchestrator.quality_gate.")))
>     | select(.semantic_session_id == $s)
>     | select(.wave_number == $w or .wave_number == null)
>     | {event, semantic_session_id, wave_number, counts}
>   ' .orchestrator/metrics/events.jsonl
>   ```
>
>   This is a diagnostic, not a replacement counts source. No rows means no readable
>   matching event; a row without `wave_number` is not proof of this wave's run;
>   a row for this wave without `counts` supplies no measurement. Keep the session
>   filter and never copy counts from another session or wave, or from a row without
>   wave attribution. An event without `semantic_session_id` is not attributable by
>   this query either; diagnose missing session attribution from independent evidence
>   of the own gate run, not by adopting an unrelated unattributed event. Missing
>   attribution or an empty result alone does not prove a fallback source exists.
>
>   **Count fallback is limited to three cases:** pre-#954 sessions, a gate run outside the event wrapper, or missing wave attribution (including an auto-fix call without a readable own wave scope). An event without `semantic_session_id` cannot match the selector — emitters set it only from the session lock via `sessionAttribution()` — and is treated like a gate run outside the wrapper. In those cases only, read the STATE.md Wave History header `— suite <passed>/<failed> on <platform>`. An auto-fix call with a known wave uses the event selector above. An empty selector alone is not a fallback case: an event without `counts`, for example after fail-fast before the test suite, supplies no replacement zeros and does not by itself permit count fallback.
>
>   If no counts are available and none of those fallback cases applies, omit `suite_passed` and `suite_failed`. Absent means "not measured"; a present `suite_failed: 0` means "measured, zero failures". Never zero-fill missing measurements.
>
>   **`suite_platform` comes separately and exclusively from the STATE.md Wave History header. There is no platform field in the event payload.** Omit it when no header platform measurement is available; do not infer it from `variant`, runner OS, or session platform. Event-derived counts may still be mirrored into the existing header as compatibility output, not a second measurement source; keep the header and sessions.jsonl contracts unchanged.
> - `open_questions_asked` / `open_questions_answered` / `open_questions_deferred` (#773): the three open-question counts from the Phase 1.65 gate's AUQ Call 2 (identical to the `questions_*` payload fields on the `orchestrator.handover.gated` event). Top-level, additive, non-negative integers. Populate ONLY when the gate ran an interactive triage ("Closen + Triage" path). OMIT all three (do NOT write `0`) when the gate was skipped (fail-open / headless / disabled) or took the fast-path — absent = "not measured", `0` = "measured, zero questions". Validator accepts absent/null/non-negative-integer.
> - `stagnation_events`: populated ONLY when ≥1 stagnation event was logged to `events.jsonl` during this session. When `total == 0`, the field is omitted from the JSONL entry.
> - `grounding_injections`: populated ONLY when ≥1 `orchestrator.grounding.injected` event was logged to `events.jsonl` during this session. When `count == 0`, the field is omitted from the JSONL entry.
> - `memory_cleanup_at`: **derived by the writer, not supplied by the coordinator.** `scripts/emit-session.mjs` sets it to `completed_at` whenever an `orchestrator.memory.cleanup_completed` event for THIS session sits in `events.jsonl` — emitted by every `/memory-cleanup` run in ANY mode (dry-run, apply-pending, OR healthy no-op). **A no-op is still a cleanup; it still emits, so the cadence marker (`readDreamSignals` → `lastCleanupAt`) still advances and `shouldDispatchAutoDream` does not fire a false nudge.** No event → field absent (never `null`). An explicit value already on the record wins and is not overwritten. Do NOT hand-call `stampMemoryCleanup()` here — the coordinator-supplied-boolean form was removed on 2026-08-17 after it silently failed for a real cleanup on 2026-08-14. (#699)
