# Phase 3.7: Write Session Metrics

> Sub-file of the session-end skill. Executed as part of Phase 3 (Documentation Updates) when `persistence` is enabled.
> For the full session close-out flow, see `SKILL.md`.

### 3.7 Write Session Metrics

> Gate: Only run if `persistence` is enabled in Session Config.
>
> This step writes the session JSONL entry, verifies it, then optionally mirrors the session summary to the configured Obsidian vault via `scripts/vault-mirror.mjs`.

> **MANDATORY WRITE PATH (#400):** ALL session closes — including coord-direct sessions, housekeeping, express-path, and autopilot runs — MUST write the JSONL metrics entry exclusively via `node scripts/emit-session.mjs`. **Hand-composing JSON and appending it directly to `sessions.jsonl` is forbidden.** `emit-session.mjs` calls `validateSession` from `scripts/lib/session-schema.mjs` (the schema authority) before appending and stamps `schema_version: 1`. Entries that bypass this path skip validation and produce malformed records with missing required fields (`waves[]`, `agent_summary`) or unresolved legacy field names (`waves_completed`, `files_changed`, `planned_issues` at top-level instead of under `effectiveness`).
>
> Minimal invocation:
> ```bash
> printf '%s' "$METRICS_ENTRY" | node "$PLUGIN_ROOT/scripts/emit-session.mjs" --file .orchestrator/metrics/sessions.jsonl
> ```
> See step 2 below for the full invocation including exit-code handling.

1. Ensure `.orchestrator/metrics/` directory exists: `mkdir -p .orchestrator/metrics`

1-pre. **`memory_cleanup_at` is DERIVED, not remembered (#699 + 2026-08-17 follow-up)** — there is **no coordinator step here any more**. Do not set a `ranMemoryCleanupThisSession` boolean and do not call `stampMemoryCleanup()` by hand at session-end.

   `scripts/emit-session.mjs` derives the field itself: it calls `deriveMemoryCleanupSignal()` (`scripts/lib/memory-cleanup-stamp.mjs`), which reads the sibling `events.jsonl` for `orchestrator.memory.cleanup_completed` records whose `timestamp` falls inside this session's own `[started_at, completed_at]` window (and whose `semantic_session_id`, when present, matches). The emitting side is the LAST step of every `/memory-cleanup` run — see `skills/memory-cleanup/SKILL.md` § "Session-End Signal".

   **Contract:** a no-op run (MEMORY.md already healthy, no files mutated) is still a cleanup, so it still emits and therefore still stamps. When `/memory-cleanup` did not run, no event exists, nothing is derived, and the field is simply absent — never `null`. An EXPLICIT `memory_cleanup_at` already present on the record WINS over derivation and is never overwritten; that path is for backfills and tests, not for normal operation.

   **Why this stopped being a coordinator instruction.** It was one until 2026-08-17, and it measurably failed: a `/memory-cleanup` ran on 2026-08-14 with a documented yield, the prose step above was not executed, and all three session records of that day carried `memory_cleanup_at: null` — so the session-start banner reported "last cleanup 29 days ago" against the operator's own "3 days". `stampMemoryCleanup()` had **zero production callers** at that point; every reference to it was an instruction asking an LLM to remember. Same failure class as the STATE.md write-race Epic #583 replaced with a lock: Disziplin statt Mechanik.

   > **#701.2 DOC NOTE — `completed_at >= started_at` guard:** This invariant is enforced mechanically by `scripts/emit-session.mjs`. The writer applies `clampTimestampsMonotonic()` (from `scripts/lib/session-schema/timestamps.mjs`) before `validateSession()`, clamping any inversion of `completed_at < started_at` to `started_at` and recording forensics in `_clamped: true` / `_original_completed_at`. Previously-inverted entries (e.g. `main-2026-06-21-session-4`) are already corrected. **No per-session coordinator action is needed** — the writer enforces the invariant at write time. Do not add defensive clamping logic here; the canonical guard lives in `emit-session.mjs`.

1a. **Token Rollup (#644, #1244 — mechanical since #1436)** — no coordinator action. `scripts/emit-session.mjs` (step 2) runs `rollupSessionTokens()` itself whenever the incoming record carries no `total_tokens`: it resolves the session's raw UUID from `.orchestrator/current-session.json` (adopted only when its `semantic_session_id` equals the record's `session_id` and no process-local session id contradicts it), joins the sibling `subagents.jsonl` on `parent_session_id`, and fills `total_tokens`, `total_token_input`, `total_token_output`, the three cache buckets, `total_cost_usd`, `subagents_with_tokens`, `matched_records`, `cost_records_priced`, `cost_records_total` and `_token_schema` for every key the record does not already carry — plus `raw_session_id`. No matching records, an unreadable ledger or a foreign marker omits the fields with a WARN on stderr, never a fabricated `0`. An explicit key on `$METRICS_ENTRY` still wins. The same UUID also backs `session_start_ref` when STATE.md has none (the `head_sha` of the session's own `orchestrator.session.started` event).

   **Semantics:** `null` totals mean "no token data was captured for this session" — this is NOT the same as zero cost. Do NOT coerce null to 0 when displaying or summing across sessions. The same holds for `total_cost_usd`: it is omitted whenever `cost_records_priced < cost_records_total` (#1475) — at least one cost-relevant subagent record could not be priced (a model the price table does not know, a token-bearing turn naming no model, a transcript that yielded no tokens, e.g. one over the hook's size cap, or an agent with a start record whose stop found no transcript of its own, mostly `workflow-subagent`) — and also when `cost_records_total` is 0, because there was nothing to price. It is never "$0" for an unknown cost and never a partial sum over the v2 agents the ledger can see. Phantom stops (#939, no start record) are no agents and never count. The two counters are persisted beside it, so a missing cost says whether part of the session was unpriceable or nothing was priceable. Blind spots remain: an agent whose start record fell outside the hook's tail window looks like a phantom, an agent with neither start nor stop record is invisible, and a session spanning the 2026-09-09 schema boundary is priced over its v2 records only (its v1 records are neither priced nor counted as candidates — 4 distinct fleet sessions carry such a cost, 2026-10-01). A subagent whose turns span several models carries a per-model `models_usage` breakdown in `subagents.jsonl` (#1470) and is priced part by part. The emit-session warning names the reason via `match_status` (ledger absent, ledger with no readable records, or records present but none for the own raw UUID); none of these means zero cost.

   **Provenance (#949):** the rollup sums ONLY records carrying `subagent_transcript_found: true` — the flag the producer sets when it read the subagent's own transcript. Pre-#949 records carry the PARENT transcript's running totals and are excluded, so a session made up entirely of them now reports `null` rather than a fabricated sum (73 historical sessions, 96,148,781 phantom tokens, measured 2026-08-11). Two consequences for readers: totals already written into `sessions.jsonl` before 2026-08-11 were produced by the unfiltered recipe and are a series break, not a trend; and `matched_records` counts start records and phantom stops alike, so it is NOT the denominator for a coverage ratio — use `subagents_with_tokens` against the session's real agent count.

   **Schema boundary (#1244, 2026-09-09):** from `schema_version: 2` a subagent record's `token_input` is BILLABLE PROMPT VOLUME (uncached + cache_read + cache_creation); v1 records held raw uncached input only and are therefore EXCLUDED from every total and reported as `legacy_v1_records`. Sessions spanning the boundary are a second series break — do not trend across it.

2. Append the prepared JSONL entry (from Phase 1.7; the writer itself adds the token fields — step 1a) via the validating writer `scripts/emit-session.mjs` (issue #249):
   ```bash
   printf '%s' "$METRICS_ENTRY" | node "$PLUGIN_ROOT/scripts/emit-session.mjs" --file .orchestrator/metrics/sessions.jsonl
   EMIT_EXIT=$?
   if [[ $EMIT_EXIT -eq 1 ]]; then
     echo "ERROR: session-end validation failed — entry rejected by scripts/emit-session.mjs. See stderr above. Session metrics NOT written." >&2
     exit 1
   elif [[ $EMIT_EXIT -ne 0 ]]; then
     echo "ERROR: scripts/emit-session.mjs failed with exit $EMIT_EXIT. Session metrics NOT written." >&2
     exit 1
   fi
   ```
   `scripts/emit-session.mjs` calls `validateSession` from `scripts/lib/session-schema.mjs` before appending, stamps `schema_version: 1` if absent, and uses `appendJsonl` (atomic for lines < PIPE_BUF). Exit 1 on validation error, exit 2 on I/O error — block session close in both cases so malformed metrics can never reach disk.

   **`session_profile` (#1247):** when `$METRICS_ENTRY` omits the `session_profile` key, `emit-session.mjs` fills it itself from this repo's own `<state-dir>/STATE.md` `session-profile` frontmatter (e.g. `ultradeep`) — no coordinator-side plumbing needed; an explicit value on the entry always wins and is never overwritten.

   **`autopilot_run_id` (additive, optional, #300):** when this session was launched by `/autopilot`, the wave-executor `sessionRunner` callback passes `args.autopilotRunId` from `runLoop`. session-end MUST persist that value as a top-level field on the JSONL record:

   ```json
   {"schema_version":1,"session_id":"…","autopilot_run_id":"main-2026-04-25-1432-autopilot",...}
   ```

   Manual sessions either omit the field or write `null` — both are treated identically per the v1 additive convention. Readers must NOT distinguish "missing" from "null" semantically. `validateSession` does not require this field; it passes through unknown keys unchanged.
3. The writer creates the file if it does not exist.
4. Verify: read back the last line to confirm valid JSON (sanity check; validation already ran):
   ```bash
   tail -1 .orchestrator/metrics/sessions.jsonl | jq . > /dev/null || {
     echo "ERROR: last sessions.jsonl line is not valid JSON — manual fix required" >&2; exit 1;
   }
   ```

4a. **Verify the record SCHEMA, not just its JSON syntax (#1408)** — step 4 only proves the line parses. The #1408 record parsed fine and was still invalid (`ended_at` instead of `completed_at`, four required fields missing, wave objects keyed `n` instead of `wave`); `vault-mirror` dropped it as `skipped-invalid`, so that session got no vault note and nobody was told until the NEXT session-start banner. Run the same check `/close`'s successor would run, now:

   ```bash
   node "$PLUGIN_ROOT/scripts/check-sessions-integrity.mjs" --session-id "$SESSION_ID" || exit 1
   ```

   **Exit contract:** 0 = this session's record validates and mirrors. 1 = THIS session's record is broken, or is not in the ledger at all — block the close and re-emit via `scripts/emit-session.mjs`. 2 = tool error (bad flag, unreadable repo root). Pre-existing invalid records from earlier sessions are printed (the banner text on stderr) but never block: they are not this close's to fix, and failing on them would make every close red until someone ran `node scripts/repair-invalid-sessions.mjs --apply`. Identity (`--session-id`), not tail POSITION, is the filter — a parallel session may append between step 2 and here. A named id with NO record fails on purpose: "sound" and "never written" are indistinguishable to the checker, and passing on that reading is the fail-open half.

   Add `--repo-root <path>` when the cwd is not the repo (the default is cwd), and `--json` for a machine-readable result (`{ok, exitCode, sessionId, matched, findings[]}`).
5. **Vault Mirror** — mirror the session entry to the Obsidian vault (if configured):

   ```bash
   VM_ENABLED=$(echo "$CONFIG" | jq -r '."vault-integration".enabled // false')
   VM_MODE=$(echo "$CONFIG" | jq -r '."vault-integration".mode // "warn"')
   VM_HOST_OVERRIDE=$(echo "$CONFIG" | jq -r '."vault-integration"."host-override" // empty')

   if [[ -n "$VM_HOST_OVERRIDE" && ( "$VM_ENABLED" != "true" || "$VM_MODE" == "off" ) ]]; then
     # SO#1448: this host switched the mirror off on purpose (env
     # SO_VAULT_INTEGRATION or owner.yaml `vault-integration:`). Say so, instead of
     # running into vault-mirror's exit 2 (missing-vault-dir) and a strict block.
     echo "vault-mirror: bewusst aus auf diesem Host ($VM_HOST_OVERRIDE)"
   elif [[ "$VM_ENABLED" == "true" && "$VM_MODE" != "off" ]]; then
     # Resolve vault directory: config field (host-resolved, see vault-dir-source)
     # takes precedence; $VAULT_DIR is only the bash fallback when it is empty.
     VM_DIR=$(echo "$CONFIG" | jq -r '."vault-integration"."vault-dir" // empty')
     VM_DIR_SOURCE=$(echo "$CONFIG" | jq -r '."vault-integration"."vault-dir-source" // "committed"')
     if [[ -z "$VM_DIR" && -n "${VAULT_DIR:-}" ]]; then
       VM_DIR="$VAULT_DIR"
       VM_DIR_SOURCE="env VAULT_DIR"
     fi
     # SO#1490: display form for echo lines only — the home dir becomes `~`
     # through the ONE redactor (`redactHomeDir`, scripts/lib/common.mjs,
     # path-boundary aware: `/Users/bob` never rewrites `/Users/bobby`). The
     # commands below still get the real value. VM_DIR has no producer to emit
     # a display path, so one helper serves every echo; if node cannot load the
     # module it falls back to `…/<basename>` (vault-mirror's #1479 form),
     # never to the raw path.
     so_tilde() {
       node --input-type=module -e "import { redactHomeDir } from '$PLUGIN_ROOT/scripts/lib/common.mjs'; process.stdout.write(redactHomeDir(process.argv[1]))" "$1" 2>/dev/null \
         || printf '…/%s' "${1##*/}"
     }
     echo "vault-dir=$(so_tilde "$VM_DIR") (Quelle: $VM_DIR_SOURCE)"

     # Quality-gate thresholds (PRD F1.2). Defaults match
     # scripts/vault-mirror.mjs (400 chars / 0.5 confidence). The nested key
     # path `vault-mirror.quality.*` is owned by the I6 config parser; this
     # site is a read-only consumer.
     VM_QUALITY_NARRATIVE=$(echo "$CONFIG" | jq -r '."vault-mirror".quality."min-narrative-chars" // 400')
     VM_QUALITY_CONFIDENCE=$(echo "$CONFIG" | jq -r '."vault-mirror".quality."min-confidence" // 0.5')
     VM_VAULT_NAME=$(echo "$CONFIG" | jq -r '."vault-integration"."vault-name" // empty')

     VM_OUTPUT=$(node "$PLUGIN_ROOT/scripts/vault-mirror.mjs" \
       --vault-dir "$VM_DIR" \
       --source .orchestrator/metrics/sessions.jsonl \
       --kind session \
       --session-id "$SESSION_ID" \
       ${VM_VAULT_NAME:+--vault-name "$VM_VAULT_NAME"} \
       --quality-min-narrative-chars "$VM_QUALITY_NARRATIVE" \
       --quality-min-confidence "$VM_QUALITY_CONFIDENCE" 2>&1)
     VM_EXIT=$?

     # Surface script output so user can see skipped-handwritten results
     if [[ -n "$VM_OUTPUT" ]]; then
       echo "$VM_OUTPUT"
     fi

     if [[ $VM_EXIT -ne 0 ]]; then
       if [[ "$VM_MODE" == "strict" ]]; then
         echo "ERROR: vault-mirror failed (exit $VM_EXIT) — session close blocked (vault-integration.mode=strict)"
         echo "Fix the vault mirror issue or set vault-integration.mode: warn to downgrade to a warning."
         exit 1
       else
         # mode: warn (default) — surface warning but do not block
         echo "WARNING: vault-mirror exited $VM_EXIT — session metrics were NOT mirrored to the vault. Set vault-integration.mode: strict to block on this error."
       fi
     else
       # Parse the destination path from the script's JSON output (one JSON line per action)
       VM_DEST=$(echo "$VM_OUTPUT" | jq -r 'select(.action == "created" or .action == "updated") | .path' 2>/dev/null | head -1)
       if [[ -n "$VM_DEST" ]]; then
         echo "Mirrored session summary to $VM_DEST"
       fi

       # Quality gate summary (PRD F1.2): count entries skipped because they
       # failed the quality filter, so the operator can tune thresholds.
       VM_QUALITY_SKIP=$(echo "$VM_OUTPUT" | jq -rc 'select(.action == "skipped-quality-low")' 2>/dev/null | wc -l | tr -d ' ')
       if [[ "${VM_QUALITY_SKIP:-0}" -gt 0 ]]; then
         echo "vault-mirror: ${VM_QUALITY_SKIP} entry/entries skipped by quality gate (set vault-mirror.quality.min-narrative-chars / min-confidence to tune)"
       fi
     fi

     # ── Durable Narrative Mirror (#675) ────────────────────────────────────
     # Sibling of the session-mirror above, gated on the SAME vault-integration
     # gate ($VM_ENABLED / $VM_MODE checked at the top of this block). Reads this
     # repo's `.claude/STATE.md`, extracts the DURABLE narrative — `## Wave History`,
     # `## Deviations`, `## What Not To Retry`, plus the mission-status rollup — and
     # idempotently writes a generator-owned per-repo file at
     # `<vault-dir>/01-projects/<repo-slug>/_session-narrative.md`, so a reviewer
     # or stand-in can read PER REPO what was done, what failed, and what not to
     # retry WITHOUT opening the repo.
     #
     # Idempotent + safe: NEVER touches `_overview.md` or any hand-authored file
     # (marker-guarded via `session-orchestrator-vault-status-narrative@1`). A
     # re-run with no STATE.md change returns `skipped-noop`; an existing
     # non-generator file returns `skipped-handwritten`; absent STATE.md returns
     # `skipped-no-statemd`. The helper ALSO self-no-ops (`skipped-vault-disabled`)
     # when vault-integration is off — this gate is defense-in-depth, not the sole
     # gate. Non-blocking: a failure surfaces a warning and never blocks close,
     # using the same strict/warn degradation idiom as the vault-mirror step above.
     NM_OUTPUT=$(node -e "
       import('$PLUGIN_ROOT/scripts/lib/vault-status/narrative-mirror.mjs').then(async (m) => {
         const r = await m.mirrorNarrative({ repoRoot: process.cwd() });
         process.stdout.write(JSON.stringify(r));
       }).catch((e) => { process.stderr.write(String(e && e.message || e)); process.exit(3); });
     " 2>&1)
     NM_EXIT=$?

     if [[ $NM_EXIT -ne 0 ]]; then
       if [[ "$VM_MODE" == "strict" ]]; then
         echo "ERROR: narrative-mirror failed (exit $NM_EXIT) — session close blocked (vault-integration.mode=strict): $(so_tilde "$NM_OUTPUT")"
         echo "Fix the narrative mirror issue or set vault-integration.mode: warn to downgrade to a warning."
         exit 1
       else
         # mode: warn (default) — surface warning but do not block
         echo "WARNING: narrative-mirror exited $NM_EXIT — durable per-repo narrative was NOT mirrored to the vault. Set vault-integration.mode: strict to block on this error."
       fi
     else
       # Surface the JSON result so the operator can see skipped-* / written outcomes.
       NM_ACTION=$(echo "$NM_OUTPUT" | jq -r '.action // empty' 2>/dev/null)
       # `.path` is absolute (under the vault, i.e. the home dir) — display form only.
       NM_PATH=$(echo "$NM_OUTPUT" | jq -r '.path // empty' 2>/dev/null)
       [[ -n "$NM_PATH" ]] && NM_PATH=$(so_tilde "$NM_PATH")
       if [[ "$NM_ACTION" == "written" && -n "$NM_PATH" ]]; then
         echo "Mirrored durable session narrative to $NM_PATH"
       elif [[ -n "$NM_ACTION" ]]; then
         echo "narrative-mirror: $NM_ACTION${NM_PATH:+ ($NM_PATH)}"
       fi
     fi
   fi
   ```

   > **Repo name** is derived internally: `mirrorNarrative` defaults the per-repo slug + frontmatter `repo:` field to `path.basename(repoRoot)` when `repo` is omitted, so the call needs only `repoRoot: process.cwd()` — no shell-var plumbing. (Pass an explicit `repo:` only to override the derived basename.) The narrative mirror shares vault-dir resolution with `mirrorNarrative` itself (it reads Session Config internally), so no separate `--vault-dir` plumbing is needed here.

   **Behaviour matrix:**

   | `enabled` | `mode`  | Result |
   |-----------|---------|--------|
   | `false` via host override (`host-override` set) | any | Skip; print `vault-mirror: bewusst aus auf diesem Host (<quelle>)` — never blocks |
   | `false` or missing | any | Skip entirely — no-op, no output |
   | `true` | `off`   | Skip entirely — no-op, no output |
   | `true` | `warn`  | Run mirror; on failure surface a warning but do NOT block close |
   | `true` | `strict` | Run mirror; on failure block session close with an error message |

   > **Host-local overrides.** `enabled`/`mode` above are the values AFTER the host switch: env `SO_VAULT_INTEGRATION=off|warn|strict` > owner.yaml `vault-integration: { enabled: false | mode: … }` > committed. The host may only lower the committed level, never raise it; `."vault-integration"."host-override"` names the tier that lowered it (`env:SO_VAULT_INTEGRATION`, `owner.yaml`) and is `null` otherwise. `."vault-integration"."vault-dir-source"` (`env`, `match`, `owner`, `committed`) says where the vault path came from. See `docs/session-config-reference.md` § Vault Integration.

   > **Hand-written note protection:** `vault-mirror.mjs` checks for a `_generator: session-orchestrator-vault-mirror@1` marker before overwriting any existing file. When it skips an existing hand-written note it emits a JSON line `{"action":"skipped-handwritten","path":"<path>","kind":"<kind>","id":"<id>"}` — the step above surfaces this output so the user can see the result. Action names: `created`, `updated`, `skipped-noop`, `skipped-handwritten`, `skipped-collision-resolved`, `skipped-invalid` (entry failed required-field validation, or the mapper crashed rendering an otherwise-parseable record — the latter case carries `reason: "mapper-crash"`, #718), `skipped-quality-low` (entry failed quality gate — PRD F1.2; line carries a `reason` field).
