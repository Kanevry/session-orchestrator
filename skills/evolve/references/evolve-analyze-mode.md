# Evolve — Phase 3: Analyze Mode

> Reference of the evolve skill, split out of `SKILL.md` (#1246). At the split the body was moved byte-identical; it has been edited since (#1321 — real-session filter, population rule, git-derived fragile-file method), so it is no longer verifiable against the pre-split file.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`** — the body carries no relative markdown links, only backticked file mentions.
> **Read when `/evolve analyze` (the default mode) runs** — `../SKILL.md` Phase 2's Mode Dispatch routes here. Covers pattern extraction (9 built-in analyzer types plus `evolve.extra-sources`), deduplication, relation judgment (#1016), the AskUserQuestion confirmation gate, the archive-safe write pipeline (Step 3.5), and the C2 auto-repair feeder (Step 3.6).

## Phase 3: Analyze Mode (default)

Extract learnings from session history.

> **Vault Integration:** If `vault-integration.enabled` is `true` in Session Config, confirmed learnings are mirrored to the configured Obsidian vault after the atomic write (Step 3.5, step 9). See `docs/session-config-reference.md` for the `vault-integration` config block.

### Step 3.1: Read Session Data

- Read the entries of `.orchestrator/metrics/sessions.jsonl` (or `<state-dir>/metrics/sessions.jsonl` if the v2 path does not exist — see Phase 1.4 fallback)
- Parse each JSONL line as JSON (skip unparseable lines)
- Keep only REAL sessions: drop every `status: "abandoned"` record (the #834 close-backfill stubs). The predicate is `isRealSession` / `filterRealSessions` in `scripts/lib/session-schema/filters.mjs:54` / `:65`. Do NOT key on `_backfill_source` — real, repaired records carry it too (#1296).
- Sort by `completed_at` descending (most recent first)
- If no real sessions remain, abort: "No session data available. Complete at least one session before running evolve." **Telemetry on abort (#1200, #1206):** before stopping, emit — same minimal `emit-event.mjs` call as Phase 1.2's abort, and for the same reason: this gate fires before the Step 3.5(5) `sweep-expired-learnings.mjs --prune` call exists to fold the emit into:

  ```bash
  node scripts/emit-event.mjs --type orchestrator.evolve.completed --payload \
    "$(node -e "process.stdout.write(JSON.stringify({aborted: 'no-session-data', reason: 'No session data available. Complete at least one session before running evolve.'.slice(0,300), duration_ms: DURATION_MS}))")"
  ```

### Step 3.1b: Read Extra Sources (#638)

When `evolve.extra-sources` is configured in Session Config (default `[]` ⇒ this step is a no-op), `/evolve` consumes OUT-OF-BAND domain measurement sidecars to surface `domain-regression` learnings.

**READ-ONLY contract:** `/evolve` NEVER runs the domain measurement. The measurement (e.g. an eval-learn regression harness) runs elsewhere and writes a sidecar JSON; this step only READS that sidecar's output. Never shell out to produce the sidecar from here.

For each configured `extra-sources` entry `{path, kind, learning-type}`:

1. **Read the sidecar** at `path` (parser-validated as repo-relative, with absolute paths and `..` escape segments dropped before this step, then resolved against the repo root). If the file is missing or unreadable, **skip with a WARN** (`evolve: extra-source not found: <path>`) — do not abort the whole run.
2. **Schema-gate** the sidecar against the `kind`'s expected shape. For `kind: regression-flags` the schema is `{ flags: [ { metric, baseline, recent, delta } ] }`. If the parsed JSON does not match (missing `flags` array, or a flag missing a required field), **skip with a WARN** (`evolve: extra-source <path> failed regression-flags schema gate`) — never guess at a different shape.
3. **Emit one `domain-regression` learning candidate per flag that is PERSISTENT** — i.e. the same `metric` regressed across ≥2 consecutive sessions (cross-reference prior sessions' sidecar reads or the existing learnings store for the same `subject`). A one-off flag is noise; only a persistent regression earns a candidate.
   - `type`: `learning-type` from the entry (registered enum value `domain-regression`)
   - `subject`: the flag's `metric`
   - `insight`: a human-readable regression statement (e.g. "metric `<metric>` regressed: baseline <baseline> → recent <recent> (delta <delta>) persisting across ≥2 sessions")
   - `evidence`: `baseline → recent` (the concrete data points from the sidecar)
   - `confidence` / `expires_at`: derived via the existing confidence + decay infrastructure (Step 3.5), exactly as for the built-in learning types. `domain-regression` carries a 60-day TTL (`LEARNING_TTL_DAYS`).
4. Candidates flow into the SAME Step 3.4 AskUserQuestion confirmation + Step 3.5 write path as the built-in learning types — there is no separate write path.

### Step 3.2: Pattern Extraction

For each of the 9 built-in analyzer learning types, apply these heuristics.

**Population rule (every analyzer, #1321):** work only on the real sessions from Step 3.1. Every learning candidate's `evidence` states the population it was drawn from as `n=<records or waves used>`. Below `n=5`, emit `evolve: WARN <type> n=<k> below min 5` instead of a learning candidate.

#### 1. fragile-file (type: `fragile-file`)

- `waves[].files_changed` is a COUNT (a number), never a list of paths — do not iterate it (#1321). File identity comes from git, the method of `skills/session-end/learning-patterns.md:13`, run per session over its commit range:
  `git log --name-only --format="" <session_start_ref>..<end_ref> | sort | uniq -c | sort -rn`
  with `<end_ref>` = the record's `end_ref` / `session_end_ref`; when neither exists use `HEAD` plus `--until=<completed_at>`. Records without `session_start_ref` fall back to `git log --name-only --format="" --since=<started_at> --until=<completed_at>`.
- **Prefer the ref range; label the fallback.** Only 26 of 201 real records carry `session_start_ref` (measured 2026-09-12), so most analyses land on the time-window fallback. That window also picks up commits a PARALLEL session made on the same branch in the same hours — it attributes foreign commits to this session. Use the ref range wherever the record has one, and mark every candidate whose evidence came from the fallback as `window: time (unattributed)` in its `evidence`.
- Within a session: a file changed in 3+ commits of that session's range is fragile. Here the population rule's `n` counts the **commits in that session's range**, not records — one session is always one record, so counting records would WARN on every within-session check
- Cross-session: if a file appears in 3+ different sessions' ranges, flag it
- Subject = file path (relative to project root)

#### 2. effective-sizing (type: `effective-sizing`)

- Compare `total_agents` and `total_waves` across session types
- Calculate average agents per wave for each session type. Read a wave's agent count defensively — older records use other keys: `agent_count`, else `agents` when it is a number, else the length of `agents` when it is an array (of descriptions), else `agents_dispatched`. A record with `total_waves: 0` contributes no per-wave ratio — skip it rather than divide by zero. Exclude coordinator-direct waves (`coordinator_direct: true`, which dispatched no agents) from the ratio. In particular, a record whose waves are all coordinator-direct `Housekeeping` waves (predicate `isCoordinatorDirectHousekeeping` in `scripts/lib/session-schema/filters.mjs`, the session-end writer shape since #1321) contributes no per-wave ratio, same as `total_waves: 0`. Counting it would log a false 0.0 agents-per-wave observation.
- Subject = canonical identifier like `deep-session-sizing` or `feature-session-sizing`
- Insight = "Deep sessions average X agents across Y waves" or "Feature sessions work well with X agents/wave"
- **Over-delivery ratio aggregation (#730/H4, #794.7):** compute the MEDIAN of `waves[].over_delivery_ratio` across the last ~5 `sessions.jsonl` records of the same `session_type`, filtered to waves whose `role` is not `Discovery`/`Finalization` and which carry the field (skip records lacking the field — pre-#730; also skip Discovery/Finalization waves, whose planned set is empty by design). This exclusion clause is intentionally identical to `skills/session-plan/SKILL.md` Step 0.5 "Over-delivery sizing" — keep the two wordings in sync on edit. Fold the median into this candidate's `insight`/`evidence` fields — e.g. `evidence`: `"median_over_delivery_ratio: 1.4 (n=12 waves, session_type=deep)"` — so `session-plan` Step 0.5 can read the ratio from the `effective-sizing` learning first, falling back to its own direct `sessions.jsonl` scan only when no such learning exists.

#### 3. recurring-issue (type: `recurring-issue`)

- Look at `agent_summary` — if `failed` or `partial` > 0 across multiple sessions, flag
- Check wave `quality` fields — repeated failures indicate recurring issues
- Subject = issue pattern identifier (e.g., "test-failures-in-wave-execution", "lint-regressions")

#### 4. scope-guidance (type: `scope-guidance`)

- Cross-reference `effectiveness.planned_issues` vs `effectiveness.completion_rate`
- **Skip sessions that lack the `effectiveness` field** (early sessions may not have it)
- If completion_rate is consistently 1.0 with N issues, note "N issues per session works well"
- If completion_rate < 0.7, note "scope was too large"
- Subject = `optimal-scope-per-session-type`

#### 5. deviation-pattern (type: `deviation-pattern`)

> **Ownership Reference:** See `skills/_shared/state-ownership.md`. evolve has read-only access to STATE.md.

- Read `<state-dir>/STATE.md` if it exists and check `## Deviations` section
- Cross-reference with session duration vs planned waves
- Subject = pattern name (e.g., "scope-creep-in-feature-sessions", "underestimated-complexity")

#### 6. stagnation-class-frequency (type: `stagnation-class-frequency`)

- Read `stagnation_events` from the most recent 5 sessions in `sessions.jsonl` (skip sessions lacking the field — they predate #84).
- For each `(file, error_class)` pair appearing in ≥2 sessions, extract a candidate:
  - Subject = `<file>:<error_class>` (e.g., `skills/wave-executor/wave-loop.md:edit-format-friction`)
  - Insight = "File <X> has <error_class> stagnation in <N> recent sessions — candidate for pre-edit grounding (#85)."
  - Evidence = "<N> sessions with stagnation_events for this file/class"
- These learnings feed #85 (pre-edit grounding injection) when it ships — high-frequency pairs trigger grounding.

#### 7. hardware-pattern (type: `hardware-pattern`)

> **v3.1.0 / Sub-Epic #160 (C2, issue #171).** Keyed on `host_class` rather than project — surfaces hardware-bound problems that affect the user across every repo on the same machine. Complements the project-keyed types above.

- Read `.orchestrator/metrics/events.jsonl` (session + wave events) and the registry `sweep.log` at `~/.config/session-orchestrator/sessions/sweep.log`. Both are optional — missing files produce no candidates.
- Invoke `scripts/lib/hardware-pattern-detector.mjs` → `detectHardwarePatterns({events, sweepLogEntries, thresholds})`. Thresholds come from Session Config `resource-thresholds` when present, falling back to `DEFAULT_THRESHOLDS`.
- Five detection signals (aggregated per `(signal, host_class)` pair, ≥2 occurrences required):
  - **oom-kill** — `orchestrator.turn.stopped` (or its deprecated alias `orchestrator.session.stopped`, which `hooks/on-stop.mjs` still emits with `deprecated: true` until **2027-03-06**) with `exit_code: 137` or OOM-marker in `error`. Both names are accepted for the deprecation window because every OOM record already on disk carries only the legacy name; the detector's set lives in `OOM_TERMINAL_EVENTS` (`scripts/lib/hardware-pattern-detector.mjs`) and drops the alias on that date.
  - **heartbeat-gap** — registry sweep-log entries with `gap_minutes` above `resource-thresholds.zombie-threshold-min`
  - **concurrent-session-pressure** — session-start events with `peer_count ≥ concurrent-sessions-warn`
  - **disk-full** — events whose `error` matches `ENOSPC` / "no space left"
  - **thermal-throttle** — events whose `resource_snapshot.cpu_load_pct` crosses `cpu-load-max-pct`
- Each candidate is piped through `candidateToLearning()` → `validateLearning()`. Default `scope` is `private` (in-repo only). To promote to `public`, the user runs `npm run share:hw-learnings -- --promote` (C3 export). This anonymizes each `private` hardware-pattern entry, validates via the privacy contract, and appends a `public` twin to `learnings.jsonl` (original preserved). Use `--dry-run` to preview without writing.
- Subject convention: `<signal>::<host_class>` (e.g., `oom-kill::macos-arm64-m3pro`). The `::` separator avoids colliding with project-keyed subjects.
- Confidence starts at 0.5 like other learning types, but decay is slower in practice: hardware stays the same longer than code. This is an emergent property of the existing expire-after-N-days policy applied to a mostly-stable `host_class` — no special-casing needed.
- **Presentation in step 3.5** (see below): render hardware-patterns in a dedicated section titled `## Hardware Patterns (keyed on host_class)` after the project-keyed patterns. This makes the source of the learning obvious to the user at confirmation time.

#### 8. autopilot-effectiveness (type: `autopilot-effectiveness`)

> **v3.2 Autopilot / Sub-Epic #271 (issue #298).** Compares manual vs. autopilot session outcomes per mode (housekeeping, feature, deep) so the loop can learn whether walk-away runs preserve quality. Complements the project-keyed and hardware-keyed types above.

- Read `.orchestrator/metrics/autopilot.jsonl` (one record per autopilot loop run) **and** `.orchestrator/metrics/sessions.jsonl` (manual + autopilot session outcomes). Both are optional — missing files produce no candidates.
- Invoke `scripts/lib/evolve/autopilot-effectiveness.mjs` → `analyze(autopilotRuns, sessions)`. The module pairs records by `mode` and compares completion-rate, carryover-rate, kill-switch frequency, and quality-gate pass-rate between the two populations.
- **Data-gating contract:** the analyzer requires **≥20 paired manual+autopilot runs per mode** before emitting any candidates. Below that threshold the function returns `[]` (empty input contract) — evolve simply skips this type for that mode and reports nothing. This prevents premature conclusions from small samples (#297 calibration depends on the same threshold).
- Subject convention: `<mode>-manual-vs-autopilot` (e.g., `housekeeping-manual-vs-autopilot`, `feature-manual-vs-autopilot`, `deep-manual-vs-autopilot`). One subject per mode that crosses threshold.
- Insight = "Autopilot <mode> sessions complete at <X>% vs. manual <Y>% (Δ <Z>pp across N pairs)" or analogous carryover/kill-switch framing when those signals dominate.
- Confidence starts at 0.5 like other learning types; lifecycle ±0.15 / -0.20 via the existing dedupe-and-update infrastructure in Step 3.3 — no special-casing.
- Each candidate is piped through `candidateToLearning()` → `validateLearning()` exactly like the other types. Default `scope` is `private` (autopilot RUN data is per-host until the user opts in to share). (refs #298)

#### 9. autonomy-verdict (type: `autonomy-verdict`)

> **Dispatcher Autonomy / P3.5 (issue #683).** Synthesizes per-repo or per-scope autonomy readiness from autopilot run outcomes plus advisory skill-judge signals. Complements `autopilot-effectiveness`: type 8 asks whether autopilot preserves quality by mode; this type asks whether a repo/scope is ready for more dispatcher autonomy.

- Read `.orchestrator/metrics/autopilot.jsonl`, `.orchestrator/metrics/sessions.jsonl`, and `.orchestrator/metrics/skill-judgments.jsonl`. All are optional — missing files produce no candidates.
- Invoke `scripts/lib/evolve/autonomy-verdict.mjs` → `analyze(autopilotRuns, sessions, skillJudgments, { repo | scope })`. The analyzer reuses the type-8 mode rollups and combines them with counted skill-judge `applied`/`completed` signals.
- **Data-gating contract:** the analyzer requires **≥1 autopilot run and ≥1 canonical advisory skill-judge judgment** (`schema_version: 1`, `event: "judged"`, `advisory: true`) before emitting a candidate. Below that threshold it returns `[]` so `/evolve analyze` stays quiet during cold-start.
- Subject convention: `<repo-or-scope>-autonomy-readiness` (e.g., `session-orchestrator-autonomy-readiness`).
- Insight frames the readiness verdict (`ready`, `watch`, or `not-ready`), the combined score, and the signal counts. Evidence includes the normalized scope, verdict, autopilot summary, and skill-judge summary.
- Confidence is derived in the analyzer from signal volume, judge confidence, and score separation, then flows through the existing dedupe-and-update infrastructure in Step 3.3. Default `scope` is `private` because autopilot and skill-judge data are host/session-local. (refs #683)

### Step 3.2b: Zero Patterns Check

If no patterns were extracted across all built-in analyzers and configured extra sources, report: "No patterns found in session history. This can happen with very few sessions or sessions that lack detailed wave/agent data." and skip to end (do not proceed to AskUserQuestion).

### Step 3.3: Deduplicate Against Existing Learnings

For each extracted pattern, check if a learning with same `type` + `subject` already exists in `learnings.jsonl`:

- **If exists:** propose confidence update (+0.15 if confirmed by new evidence, -0.2 if contradicted)
- **If new:** propose as new learning with confidence 0.5

This match is **exact string equality on `type` + `subject`** — it is blind to two records that say the same thing in different words, and it cannot detect a contradiction at all. The `-0.2 if contradicted` branch above has therefore had no producer since it was written. Step 3.3b is that producer.

### Step 3.3b: Relation Judgment (#1016)

> **Cadence: once per candidate.** Step 3.2b's zero-patterns check and Step 3.4's single AUQ are once-per-run; Step 3.5's write is once-per-run. This step is the only per-candidate one in Phase 3 — the pool build happens once, the judgment runs for each pattern that seeds a pool.

> **Runs in `/evolve`, never in a wave.** The pool build is O(N²) over the candidate + corpus union (~13 ms at N=100 records; the viability boundary is ~N=2000). `/evolve` is operator-invoked and off the dispatch hot path — that is the whole reason this lives here and not in `skills/wave-executor/`. Do not invoke it from a wave prompt, an inter-wave checkpoint, or a hook.

Skip this step entirely when `.orchestrator/metrics/learnings.jsonl` is absent or holds fewer than 2 entries — with no corpus there is no relation to judge.

1. **Pool.** Call `buildCandidatePools(records, { now })` from `scripts/lib/learnings/candidates.mjs`, passing the union of this run's extracted candidates and the on-disk corpus. It returns `{pools, duplicates, stats}`: `duplicates` are the exact-`learning_key` groups (already certain — no judgment needed), and each `pools[]` entry is `{seed, candidates}` where `candidates[].record` is a bounded, per-seed, non-transitive neighbour set. No clustering, no transitive closure: a neighbour of a neighbour is not a neighbour.

2. **Judge, per candidate that seeds a pool.** `buildJudgmentInput({candidate, neighbours})` then `judgeCandidate(input, { judge })`, both from `scripts/lib/learnings/judgment.mjs`. `buildJudgmentInput` returns `null` for a candidate with no usable `id` — skip that candidate, do not judge it. `judge` is the injected verdict provider: on Claude Code the coordinator reads the `input` envelope and returns the JSON object its `output_contract` field describes. There is no subagent type for this — do not dispatch one (#614: a read-only agent that must write its own sidecar never fires).

3. **Apply, through the one choke point.** `applyVerdict(verdict, effects)` is the only place a judgment may become an effect. In `/evolve` every effect handler is a *proposal recorder*, never a writer: `refine` / `supersede` / `merge` record a proposed change, and `proposeContradiction` records a contradiction pair. `applyVerdict` resolves all four handlers before invoking any of them, so an unwired handler refuses the whole batch rather than applying the decisions that happened to come first.

4. **Fail closed.** `verdict.ok === false` (any of the eight failure modes — unparseable, partial, phantom_id, self_reference, empty, timeout, enum_violation, duplicate_target) means **no relation was read**, not "no relation exists". The candidate keeps its Step 3.3 exact-match verdict and nothing about it is surfaced as a relation. Never fall back to a default decision, never repair-retry a malformed verdict, and never render an unreadable judgment to the operator — surfacing a relation IS the claim, so a voided judgment must not reach the AUQ at all.

5. **Route into the existing gate.** Every surviving decision becomes an OPTION in Step 3.4's AskUserQuestion, never an action:
   - `contradict` → a contradiction pair, presented as its own category beside "duplicate". If the operator selects it, it feeds the `-0.2 if contradicted` branch in Step 3.3 above, applied by Step 3.5(3) — which deliberately does NOT reset `expires_at`.
   - `supersede` / `merge` → an omit-the-loser (or replace-both-with-one) proposal. If selected, the operator's next generation simply omits those ids and Step 3.5(5) archives them — never a hand-delete. The merged record must carry both sources' provenance in its own `evidence`.
   - `refine` → an edit proposal against the existing record's `insight` / `evidence`.
   - `skip` / `abstain` → nothing is surfaced.

**The brandmauer holds here, unchanged (#693 FA2/FA3).** The judgment computes; it never writes. Every `.claude/rules/` write and every `learnings.jsonl` write stays behind the operator's Step 3.4 selection and Step 3.5's `--prune` invocation.

**Named ceiling (revisit trigger).** A `supersede` or `merge` executed through Step 3.5(5) is tagged `_archive_reason: "superseded"` with a `_superseded_by` tombstone **only when the two records share `type` + non-empty `subject`** — that is `pruneLearnings()`'s own consolidation pass. A cross-wording pair (the exact case this step exists to find) does not share a subject, so its loser is archived `pruned` instead: still in the corpus, still resolvable by id, but the archive record does not name its replacement. Revisit when the CLI grows per-record drop routing, or when an archive audit needs to answer "what replaced this?" for cross-wording merges.

### Step 3.4: Present Findings via AskUserQuestion

Present extracted patterns to the user for confirmation. Use AskUserQuestion with `multiSelect: true`:

> On Codex CLI where AskUserQuestion is unavailable, present as a numbered Markdown list.

```
AskUserQuestion({
  questions: [{
    question: "Which of the patterns extracted from this session's history should be saved?",
    header: "Speichern?",
    options: [
      {
        label: "[type] subject",
        description: "insight | evidence: ... | confidence: 0.5 (new) or +0.15 (update)"
      },
      ...
      {
        label: "Skip all",
        description: "Do not save any learnings this time"
      }
    ],
    multiSelect: true
  }]
})
```

If user selects "Skip all" or selects nothing, abort gracefully: "No learnings saved."

### Step 3.5: Write Confirmed Learnings

For confirmed learnings, use atomic rewrite strategy:

1. Read ALL existing lines from `.orchestrator/metrics/learnings.jsonl` (if exists) into memory. If not found, check `<state-dir>/metrics/learnings.jsonl` as a legacy fallback. If legacy data is found, it will be migrated to the v2 path on write (step 5).
2. Apply confidence updates for confirmed existing learnings:
   - Increment confidence by +0.15
   - Cap at 1.0
   - Reset `expires_at` using `deriveExpiresAt(now, type)` unless the candidate supplies a more specific expiry
3. Apply confidence decrements for contradicted learnings (-0.2) — do NOT reset `expires_at` for contradicted learnings (let them decay naturally)
4. Append new learnings with the **canonical schema_version:1 shape** — every field is required (#303):
   - `schema_version`: **1** (integer, ALWAYS — never omit)
   - `id`: UUID v4 string generated via `node -e "const {randomUUID}=require('crypto');process.stdout.write(randomUUID())"` or `uuidgen | tr '[:upper:]' '[:lower:]'`. MUST be a non-empty UUID string. **Never omit** — missing `id` causes 100% mirror-skip (#303).
   - `type`: one of `fragile-file`, `effective-sizing`, `recurring-issue`, `scope-guidance`, `deviation-pattern`, `stagnation-class-frequency`, `hardware-pattern`, `autopilot-effectiveness`, `autonomy-verdict`, `domain-regression` (#638 — only when sourced from `evolve.extra-sources`, see Step 3.1b)
   - `subject`: the pattern subject
   - `insight`: human-readable description of the pattern. **MUST be `insight`** — do NOT use `description` or `recommendation` (legacy alias keys that vault-mirror cannot read; see #303).
   - `evidence`: specific data points that support the pattern
   - `confidence`: use the candidate's derived confidence when supplied (e.g., `autonomy-verdict`); otherwise 0.5 for new learnings
   - `source_session`: **non-empty kebab-slug string** identifying the session from which the pattern was extracted (e.g. `main-2026-04-27-1942`). MUST be a string — never an object, array, number, or null. If multiple sessions contributed, use the earliest. If unknown, use `"unknown"` (the string). **Never** pass `String(<object>)` — that yields `"[object Object]"` and breaks the YAML mirror downstream (#307). Optional pre-write validation: `jq -e 'select(.source_session | type == "string" and length > 2)'`.
   - `created_at`: current ISO 8601 date
   - `expires_at`: preserve the candidate's derived expiry when supplied; otherwise derive from `LEARNING_TTL_DAYS[type]` via `deriveExpiresAt()` (falling back to the schema default) rather than hard-coding a 30-day horizon
   - `file_paths` (optional): repo-relative path(s) scoping the learning to specific files/directories. Required for a learning to ever become `/reconcile`-eligible (issue #900; see `docs/rule-authoring.md` § "Learning Type-Taxonomy, TTL & Provenance Standard"). For a `fragile-file` candidate, `file_paths: [subject]` is mechanically derivable — `subject` already IS the file path.
5. **Write the next generation through the archive-safe pipeline — NEVER a `>` redirect (#1017).**

   Steps 6–8 (prune, consolidate, rewrite) are **not prose you execute by hand**. They are
   `pruneLearnings()` in `scripts/lib/learnings/expiry-sweep.mjs`, the same module (and the same
   crash-safe ordering, KEEP-batch probe, and `.bak-<ISO>` snapshot) the expiry sweep uses. Until
   #1017, this step said "write entire result back with `>`" — with no archive append at all, which
   deleted 11 of 13 `learning-id` provenance targets referenced by rendered `.claude/rules/*.md`.
   Do not hand-roll a `jq | ... > learnings.jsonl` pass; it bypasses every #721 safety net.

   Write the full next-generation entry set (existing entries **with** the step-2/3 confidence
   updates, **plus** the step-4 new learnings) as JSONL to a temp sidecar **via the Write tool**
   (not a shell `>` redirect — the destructive-command guard blocks it), then invoke the
   `--prune` subcommand of the sweep CLI. **This call is also `/evolve`'s ONLY
   `orchestrator.evolve.completed` success emit (#1206)** — export `N` (Step 3.5(4)'s
   new-learnings count), `M` (Step 3.5(2)'s reinforced-existing count) and `DURATION_MS`
   (elapsed ms since the Phase 1 marker) as real shell variables before running this line;
   `${N:-0}`-style expansion means an un-exported variable degrades to a safe `0` rather than
   an argument error:

   ```bash
   NEXT=".orchestrator/metrics/.learnings-next.jsonl"   # written by the step above
   node scripts/sweep-expired-learnings.mjs --prune --apply --json --entries "$NEXT" \
     --appended "${N:-0}" --boosted "${M:-0}" --duration-ms "${DURATION_MS:-0}" \
     --repo-root "$(pwd)" && rm -f "$NEXT"
   ```

   `--file` / `--archive` default to the canonical store + archive paths — pass them only when
   operating on a non-default pair. The command prints ONE JSON line; capture it as `$PRUNE` and
   report its `{scanned, kept, archived, byReason}` in the final summary — `$PRUNE.archived` is
   also the `pruned` counter the emit above just wrote, so there is nothing left to compute for
   the telemetry after this line. Preview first with `--prune --dry-run --json` (same counts,
   zero writes, **no telemetry emit** — dry-run never claims a completed run) whenever the next
   generation was hand-assembled.

   > **This step is `/evolve`'s only store-write path, and (since #1206) its only
   > `orchestrator.evolve.completed` success emit.** Until #1017 the store write lived here as
   > an inline `node --input-type=module -e` block, and until #1206 the telemetry emit was a
   > SEPARATE `emit-event.mjs` call further down this file — both were a mechanism hiding inside
   > prose: no `--help`, no exit-code contract, no test, and (for the emit) forgettable
   > independently of the write it reported on. Do not re-inline either, and do not hand-roll a
   > `jq | ... > learnings.jsonl` pass — that bypasses every #721 safety net.

   **Exit codes are the no-op rule.** `0` = applied (or a clean no-op). `1` = input error: the
   sidecar is absent, carries a malformed line, or holds no records — the store and the archive
   were **not touched**;
   re-write the sidecar and re-run. `2` = the prune itself failed inside the lib. On any non-zero
   exit, surface the error and stop — never retry with a shell rewrite, and never delete `$NEXT`
   (the `&&` above already withholds the `rm`, so the assembled generation survives for a retry).

   `pruneLearnings()` — the function the subcommand calls — performs steps 6 + 7 + 8 mechanically
   and archives **every** record that
   leaves the store, tagged with `_archived_at` + an `_archive_reason` from the closed enum
   `expired | pruned | superseded | merged`:

   - **6. Prune** — `expires_at` < now → `expired`; `confidence <= 0.0` → `pruned`.
   - **7. Consolidate duplicates (NULL-SUBJECT SAFE)** — same `type` + non-empty `subject`: the
     highest-confidence entry wins; each loser is archived `superseded` with a
     `_superseded_by: <winning id>` tombstone. Entries with null/empty/missing `subject` are NEVER
     collapsed — each is keyed by its unique `id` and always preserved (issue #284).
   - **8. Rewrite** — via `rewriteLearnings()`: full schema validation, a `.bak-<ISO>` snapshot
     (keep-3 rotation), then an atomic tmp+rename. Any id you drop from the temp sidecar without
     an explicit reason is archived `pruned` automatically — the store can no longer lose a record
     silently, whatever the next generation omits.

   No `graceDays` here, deliberately: `/evolve` re-stamps `expires_at` on every reinforced learning
   in steps 2–3 of THIS run, strictly before the prune, so an entry still expired at prune time is
   one the analyzer just declined to reinforce. (The sweep's 14-day grace exists to protect entries
   from being archived *before* that reinforcement pass runs — a hazard that cannot occur here.)

   Report the returned `{scanned, kept, archived, byReason}` alongside the counts in the final
   summary line. On a non-zero exit, do NOT retry with a shell rewrite — surface the error. The
   old "read back the first line to confirm valid JSON" check is redundant here: `rewriteLearnings()`
   round-trip-validates EVERY line before any byte reaches disk (#662), and the `malformed` guard
   above rejects an unparseable sidecar before the store is touched at all.
6. **Vault mirror (conditional):** Check `$CONFIG."vault-integration".enabled` via jq. If the field is missing or `false`, skip this step entirely — skill behavior is unchanged.

   If `enabled` is `true`:

   a. Check `$CONFIG."vault-integration".mode`. If `mode` is `off`, skip the mirror invocation (treat as disabled). If `mode` is absent, default to `warn`.

   b. Resolve the vault directory: use `$CONFIG."vault-integration"."vault-dir"` if non-null, otherwise fall back to the `$VAULT_DIR` environment variable. If neither is set, emit a warning and skip.

   c. Invoke the mirror script. Derive a synthetic `EVOLVE_SESSION_ID` so the vault-mirror auto-commit phase (#31) produces a traceable commit subject (`chore(vault): mirror evolve-<date> — N learnings + 0 sessions`). Pass `--vault-name` when `vault-integration.vault-name` is set in Session Config:
      ```bash
      EVOLVE_SESSION_ID="evolve-$(date -u +%Y-%m-%d-%H%M)"
      EVOLVE_VAULT_NAME=$(echo "$CONFIG" | jq -r '."vault-integration"."vault-name" // empty')
      node "$PLUGIN_ROOT/scripts/vault-mirror.mjs" \
        --vault-dir "<vault-dir>" \
        --source .orchestrator/metrics/learnings.jsonl \
        --kind learning \
        --session-id "$EVOLVE_SESSION_ID" \
        ${EVOLVE_VAULT_NAME:+--vault-name "$EVOLVE_VAULT_NAME"}
      ```

   d. Handle the exit code according to `mode`:
      - `warn` (default): on non-zero exit, surface a warning in evolve output (e.g. "Warning: vault mirror failed — learnings saved locally but not mirrored.") but do NOT fail the skill.
      - `strict`: on non-zero exit, fail the skill immediately and report the error to the user.

   e. On success (exit 0), report: "Mirrored N learnings to `<vault-dir>/40-learnings/`."

Report: "Saved N new learnings, updated M existing. Total active: K."

**Telemetry (#1200, #1206):** already emitted by `scripts/sweep-expired-learnings.mjs --prune`
at Step 3.5(5) above — no separate action here. `appended`/`boosted`/`duration_ms` are whatever
`$N`/`$M`/`$DURATION_MS` carried into that call, and `pruned` is `$PRUNE.archived` (the sweep
CLI's own returned total). `promoted` is always `0` from THIS call site: promotion to `public`
scope is the separate `npm run share:hw-learnings -- --promote` CLI, never invoked by
`/evolve analyze` itself — see `docs/events-schema.md`.

### Step 3.6: C2 Auto-Repair Feeder (opt-in — #647)

> **Default OFF (advisory-only).** With no `skill-evolution:` block in Session Config, this step surfaces repair candidates as ADVICE only — it applies nothing and opens no MR. This mirrors the opt-in precedent of `slopcheck` (#520) and `verification-auto-fix` (#521): the engine is dark unless explicitly enabled.

After confirmed learnings are written (Step 3.5), the actionable subset can feed the C2 tiered auto-repair engine (Epic #643 / issue #647). This is a pointer section — the modules own the logic; do not duplicate it here.

**`skill-evolution:` is a DISTINCT sibling of the pre-existing `evolve:` block.** `evolve:` (`extra-sources`) tunes learning EXTRACTION (Step 3.1b); `skill-evolution:` tunes repair AUTONOMY. They are parsed by different modules and never share keys — do not conflate them. The `skill-evolution:` block is parsed by `scripts/lib/config/skill-evolution.mjs` (`_parseSkillEvolution`) and surfaced at `$CONFIG['skill-evolution']` (wired in `scripts/lib/config.mjs`). Shape: `{ autonomy: 'off'|'advisory'|'autonomous-gated', 'evidence-floor': number, judge: boolean }`, default `autonomy: 'off'`. Do NOT add `skill-evolution:` as a column-0 key to any consolidated Session Config parity block — it is a standalone top-level block (claude-md-drift-check Check-6 enforces parity only on the `## Session Config` keys).

**Candidate intake.** Pass the post-Step-3.5 learnings (and, when available, the `claude-md-drift-check` result) to `extractCandidates({ learnings, driftResult, evidenceFloor: $CONFIG['skill-evolution']['evidence-floor'], now })` from `scripts/lib/skill-evolution/candidate-intake.mjs`. It is a pure transform — only actionable, non-expired learnings whose `confidence ≥ evidence-floor` AND whose insight is prescriptive AND resolves to a repo-relative path become `RepairCandidate`s.

**Gate per artifact type.** Each candidate's `target_path` is classified by `classifyTarget(target_path, { repoRoot })` from `scripts/lib/skill-evolution/blast-radius-classifier.mjs` (the heart of the design; path-traversal-safe, fail-closed):

| Target type | Gate | Posture |
|---|---|---|
| plugin-skill (`skills/…`) | none | **always-mr** — never autonomous |
| local-skill (`.claude/skills/…`) | none | **always-mr** — never autonomous |
| local-config (ROOT `CLAUDE.md` / `AGENTS.md` Session Config) | config-validation | **autonomous-gated** |
| anything else | none | always-mr (fail-closed) |

Only ROOT-instruction Session Config edits are eligible for autonomous apply, and only when ALL of: `runConfigValidationGate({ repoRoot })` (`scripts/lib/skill-evolution/config-validation-gate.mjs`) is GREEN (parse-config + config-schema + claude-md-drift-check) **AND** `evidence ≥ evidence-floor` **AND** `autonomy: autonomous-gated`. Skill repairs are MR-only by construction.

**Invocation contract (this foundation slice = ADVISORY surfacing).** The single orchestrator that ties intake → classify → gate → route → stamp together is `runRepairEngine({ repoRoot, config, learnings, driftResult, dryRun })` from `scripts/lib/skill-evolution/engine.mjs` — it returns `{ outcomes, summary }` and applies the full gate-per-artifact-type decision matrix internally (`autonomy: off` ⇒ every outcome is advisory-only). In the default/advisory posture, `/evolve` SURFACES candidates and their classification only — it does not apply or open MRs. Apply is gated on the config-validation gate above; MR-opening (`openRepairMr({ candidate, diff, repoRoot, dryRun })` from `scripts/lib/skill-evolution/mr-opener.mjs`) is gated on `autonomy != off`. Candidate de-dup / `processed_at` lifecycle is owned by `scripts/lib/skill-evolution/idempotency.mjs`. When `autonomy: off` (default), report the surfaced candidates as advice and stop.
