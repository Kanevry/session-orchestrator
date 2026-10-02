# Phases 3.5a + 3.6: Learning Extraction and Memory Cleanup

> Sub-file of the session-end skill. Executed as part of Phase 3 (Documentation Updates) when `persistence` is enabled.
> For the full session close-out flow, see `SKILL.md`.

### 3.5a Learning Extraction

> Gate: Only run if `persistence` is enabled in Session Config.

Analyze the completed session to extract reusable learnings for future sessions.

**What to extract:**
- **Fragile files**: use `git log --name-only --format="" $SESSION_START_REF..HEAD | sort | uniq -c | sort -rn | head -10` to find files changed most frequently across commits this session. Files appearing in 3+ commits are candidates for fragile-file learnings. Cross-reference with `<state-dir>/STATE.md` Wave History to correlate with specific waves. Skip this when `$SESSION_START_REF` is empty (the accessor's skip in `plan-verification.md`): `git log ..HEAD` reads as `HEAD..HEAD` and prints nothing with exit 0, which would pass for "no fragile files".
- **Effective sizing**: actual agent count vs. planned — what worked for this complexity level
- **Recurring issues**: same issue type appearing across waves (e.g., type errors, missing imports)
- **Scope guidance**: was the scope too large/small? How many issues fit comfortably in one session?
- **Deviation patterns**: read the `## Deviations` section from `<state-dir>/STATE.md` — were there plan adaptations? What triggered them? Extract as `deviation-pattern` type if a pattern emerges across sessions (e.g., "scope expansion during Impl-Core is common for this project")

**Learning format** (collect each as a learning object; Phase 3.6 writes them through `scripts/apply-session-learnings.mjs`):
```json
{
  "schema_version": 1,
  "id": "<uuid-v4>",
  "type": "fragile-file|effective-sizing|recurring-issue|scope-guidance|deviation-pattern|stagnation-class-frequency",
  "subject": "<what the learning is about>",
  "insight": "<the actionable insight>",
  "evidence": "<what happened this session>",
  "confidence": 0.5,
  "source_session": "<session_id>",
  "scope": "local",
  "host_class": null,
  "anonymized": false,
  "file_paths": ["<repo-relative path(s) this learning applies to>"],
  "created_at": "<ISO 8601>"
}
```

- `scope` MUST be one of `local|private|public`. A file PATH belongs in `file_paths`, **never** in `scope` — a producer that wrote a path into `scope` is the GH#69 root cause, and the strict `validateLearning` in the write CLI rejects it.
- `schema_version` MUST be the integer `1` (not `"1"`, not `2`).
- `expires_at` may be omitted: the CLI derives it per `type` via `deriveExpiresAt()` (`LEARNING_TTL_DAYS`), not a flat +30 days.
- `file_paths` may be omitted when the learning is not about specific files; for `fragile-file`, `file_paths: [subject]`.

**Schema versioning** (`schema_version`, introduced 2026-04):
- All new records MUST carry `schema_version: 1`. `scripts/lib/learnings.mjs` auto-stamps missing values on append/rewrite so callers can omit the field safely.
- Records without `schema_version` are treated as `schema_version: 0` (pre-versioning legacy). They are read and validated successfully for backward compat, but the reader emits a one-line WARN to stderr flagging the missing tag.
- Both `schema_version: 0` and `schema_version: 1` pass `validateLearning`. Any other value is rejected.

**Confidence updates for existing learnings:**
Before writing new learnings, read `.orchestrator/metrics/learnings.jsonl` and check for existing entries with the same `type` + `subject` (exact string match on both fields):
- If this session **confirms** an existing learning: note the update — increment `confidence` by +0.15 (cap at 1.0) and reset `expires_at` via `deriveExpiresAt(now, type)` (the per-type TTL in `LEARNING_TTL_DAYS`)
- If this session **contradicts** an existing learning: note the update — decrement `confidence` by -0.2
- If no existing match: note as a new learning with confidence 0.5

**File I/O strategy:** Track all updates in memory during extraction. Do NOT modify `learnings.jsonl` here — Phase 3.6 handles the actual file write. Pass these data structures to Phase 3.6:
- `confidence_updates`: list of `{id: "<existing_learning_id>", operation: "confirm"|"contradict"}`
- `new_learnings`: list of complete learning objects (all JSONL fields per the format above)

> ⚠️ **NEVER point a validating writer at the live store to "test" it.** `rewriteLearnings` performs an atomic, destructive replace — validating the input does NOT protect the file that is being overwritten. On 2026-07-02 a coordinator probe ran the validator against the live `learnings.jsonl` and the subsequent atomic rewrite replaced 107 entries with 3; because the store is gitignored there was no VCS restore (recovered only via the `.bak` sidecar + vault-mirror). To probe a live store safely, use the dry-run path — `rewriteLearnings(file, entries, { dryRun: true })` validates the batch and returns the validated entries but writes NOTHING (no rewrite, no `.bak`). Since #721, a real `rewriteLearnings` also snapshots the current file to `${file}.bak-<ISO>` (keep 3) before the rename, so an accidental overwrite is recoverable — but the dry-run path is still the correct tool for a probe.

**Subject matching:** Match on exact `type` + `subject` string equality. For `fragile-file`, `subject` is the file path. For other types, use a short canonical identifier (e.g., `type-errors-in-api`, `scope-too-large`, `missing-imports`).

### 3.6 Memory Cleanup & Learnings Write

> Gate: Only run if `persistence` is enabled in Session Config.

1. Count session memory files matching `session-*.md` in the memory directory
2. If count exceeds `memory-cleanup-threshold` (default: 5), suggest:
   "You have [N] session memory files. Consider running `/memory-cleanup` to consolidate."
3. This is a suggestion only — not blocking
4. **Write learnings** to `.orchestrator/metrics/learnings.jsonl` (if the file exists or new learnings were extracted) — **only** through `scripts/apply-session-learnings.mjs` (#1446):
   a. Write the Phase 3.5a result as ONE JSON object to a sidecar under `.orchestrator/tmp/` via the Write tool, e.g. `.orchestrator/tmp/session-learnings.json`:
      `{"confidence_updates": [{"id": "<existing id>", "operation": "confirm"}], "new_learnings": [<learning objects per the format above>]}`
   b. Dry run first and show the summary line (`read`, `confirmed`, `contradicted`, `appended`, `decayed`, `pruned`, `consolidated`, `kept`) — nothing is written:
      `node scripts/apply-session-learnings.mjs --input .orchestrator/tmp/session-learnings.json --json`
   c. Apply the same input: `node scripts/apply-session-learnings.mjs --input .orchestrator/tmp/session-learnings.json --apply --json`
   d. The CLI performs everything the old hand-written steps did, in code: confirm (+0.15, cap 1.0, `expires_at` re-derived per type) / contradict (-0.2, floor 0); strict `validateLearning` on every new record; **passive decay (#89)** of every existing learning NOT confirmed or contradicted this session by `learning-decay-rate` (Session Config, default `0.05`; `0.0` opts out; `expires_at` is not reset); prune (`expires_at` < now OR `confidence` <= 0.0); consolidate duplicates (same `type` + `subject`, highest confidence wins); archive every removed record to `learnings-archive.jsonl`; atomic rewrite with a `.bak-<ISO>` snapshot — all via `pruneLearnings()` in `scripts/lib/learnings/expiry-sweep.mjs`.

      | Sessions since last touch | Confidence (starting 0.5, decay 0.05) | Status |
      |---|---|---|
      | 0 | 0.50 | active |
      | 5 | 0.25 | active |
      | 9 | 0.05 | active |
      | 10 | 0.00 | pruned next write |

   e. Exit codes: `0` applied (or a clean no-op); `1` input or validation error — the message names the record id and the failing field, and **nothing was written**: fix the sidecar and re-run; `2` store/IO error — report it, do not retry by hand. Unparseable lines already in the store are NOT an error and never block the write: the CLI keeps them verbatim at the end of the store (never archived), reports `malformed: N` in its summary and prints a stderr WARN with their line numbers — carry that count into the Phase 6 report.
   f. **Hand-writing the store is FORBIDDEN** — no shell rewrite, no shell append, no `jq … | tee`, and that includes "repairing" a malformed line the WARN reports: it stays until the operator decides. Those bypass validation, the `.bak` snapshot and the archive (see `skills/evolve/SKILL.md` § Critical Rules). The blocking validator `scripts/lib/validate/check-learnings-shell-writes.mjs` fails `validate-plugin` on prose that instructs one. Once the operator decides to remove a line, the ONE sanctioned path is the CLI (#1500): `node scripts/sweep-expired-learnings.mjs --drop-malformed --line N` previews it (dry run: the line's text and the store `generation`), then `node scripts/sweep-expired-learnings.mjs --drop-malformed --line N --generation <that token> --apply --repo-root .` removes it. The apply copies the whole store to `learnings.pre-drop-malformed.jsonl.bak-<ISO>` beside it first and appends one `orchestrator.learnings.malformed_dropped` record. Line numbers move with every rewrite (malformed lines go to the end), so a store changed since the dry run exits `3` — re-run the dry run; a line that is not malformed exits `1`. Both write nothing. A malformed line that still holds a readable record — behind a UTF-8 BOM, or fused after a torn prefix (the dry run reports `bom` / `embedded_record`) — is refused at `--apply` with exit `1` as well, because dropping it loses that record; `--accept-embedded` is the operator's explicit decision to drop it anyway (the pre-drop snapshot keeps the line).
   g. Proof it ran: `--apply` appends one `orchestrator.learnings.session_write_applied` record to `.orchestrator/metrics/events.jsonl` (`appended`, `confirmed`, `contradicted`, `decayed`, `pruned`). No record = no write.
   h. If no existing file and no new learnings: skip
