# Phase 1: Plan Verification

> Sub-file of the session-end skill. Executed as the first phase of session close-out.
> For quality gates, documentation, commit, and reporting, see `SKILL.md`.

> Since the #1157 references/ split this file carries the FULL Phase 1 body (1.1 … 1.10), moved verbatim out of `SKILL.md`, which keeps a one-line stub. The pre-split duplicates of 1.1 / 1.2 / 1.3 / 1.4 / 1.6 / 1.8 that lived here — written before #769 moved carryover FILING behind the Phase 1.65 gate — were removed in favour of the moved (authoritative) text; the 1.5 and 1.7 duplicates were removed in favour of `discovery-scan.md` and `metrics-collection.md`, which the moved body points at.

### SESSION_START_REF accessor

> Referenced by Phase 3.2 (Docs Verification) and Phase 1.1a (File-Level Grounding). Canonical definition lives here.

Read `session-start-ref` from STATE.md frontmatter. If the field is missing (older session or persistence disabled), fall back to `git diff --name-only origin/main...HEAD` (compares current HEAD against origin/main rather than a pinned SHA). The fallback is less precise but functional. Always prefer the pinned SHA when available.

```bash
SESSION_START_REF=$(node --input-type=module -e "
import {readFileSync} from 'node:fs';
import {parseFrontmatter} from '${PLUGIN_ROOT}/scripts/lib/state-md.mjs';
const fm = parseFrontmatter(readFileSync('<state-dir>/STATE.md', 'utf8'));
process.stdout.write(fm['session-start-ref'] ?? '');
" 2>/dev/null)
# Fallback when field absent
[ -z "$SESSION_START_REF" ] && SESSION_START_REF="origin/main"
```

Read back the session plan that was agreed at the start. For EACH planned item:

### 1.1 Done Items
- **Verify with evidence**: read the changed files, check git diff, run relevant test
- Confirm acceptance criteria are met
- Mark as completed

### 1.1a File-Level Grounding

> Gate: skip this entire sub-phase if `grounding-check: false` in Session Config (default: `true`). Informational — does NOT block the session close on its own.

Compare the files the plan said would be touched against the files actually changed in the session. Catches both **scope creep** (files changed that were not in any agent's prompt scope) and **incomplete coverage** (files in the plan that were never edited).

1. **Planned files** = union of all file paths from agent prompt scopes across all waves. Source: STATE.md Wave History, falling back to the original session plan's per-agent "Files:" specs. Glob patterns are expanded against the working tree at session-start time.
2. **Actual files** = `git diff --name-only $SESSION_START_REF..HEAD`, where `$SESSION_START_REF` comes from the `session-start-ref` field in STATE.md frontmatter. If the field is missing (older session), fall back to `git diff --name-only origin/main...HEAD`.
3. **Compute discrepancies:**
   - **Touched** = files in both Planned and Actual
   - **Unplanned (scope creep)** = files in Actual but not in Planned
   - **Untouched (incomplete coverage)** = files in Planned but not in Actual
4. **Noise reduction filters** (apply before reporting):
   - Test files (`*.test.*`, `*.spec.*`, `**/__tests__/**`) corresponding to a touched production file are reclassified as expected (not scope creep)
   - Generated/lock files (`pnpm-lock.yaml`, `*.lock`, `dist/**`, `node_modules/**`) are excluded from both planned and actual sets
   - The `.claude/`, `.codex/`, and `.cursor/` state directories are excluded — they are session artifacts, not code

   > **Scope-drift cross-reference:** the S2 warn-only drift tripwire (below) uses its own separately-maintained filter list — `DRIFT_EXCLUDE_PATTERNS` in `scripts/lib/scope-baseline.mjs` — and is NOT derived from the filters above. That list is the shared filter source for both sides of its ratio IN CODE: `writeBaseline()`'s denominator (`countPlannedFiles()`) and `computeDrift()`'s numerator both call the same internal `filterExcluded()` helper (#894 review finding F1 — previously only the numerator was code-filtered; the denominator relied on a coordinator prose instruction to pre-filter before calling `writeBaseline()`, which is why three earlier PRD revisions shipped a tripwire that read a wrong ratio).
5. **Report** in the verification output. Also call `computeDrift({ repoRoot, threshold: 2.0 })` (`scripts/lib/scope-baseline.mjs`) and append its result — warn-only, informational, never blocks close:
   ```
   File-level grounding:
   - Planned: N files
   - Touched: N files (X% coverage)
   - Unplanned (scope creep): N files [list first 5]
   - Untouched (planned but not edited): N files [list first 5]
   - Scope drift: filesRatio X.X (Y actual / Z planned, threshold 2.0) — [breached | ok | skipped: <reason>]
   ```
6. **Append to session metrics** (`grounding` field in the Phase 1.7 JSONL entry):
   ```json
   "grounding": {
     "planned": N,
     "touched": N,
     "unplanned": N,
     "untouched": N
   }
   ```
   The metrics field is conditional on `grounding-check: true` — when the gate is off, omit the field entirely (do not write `null`).

### 1.2 Partially Done Items
- Document what was completed and what remains
- **Do NOT file the carryover issue here (#769).** Collect a carryover **candidate** instead — append it to the in-memory candidate list that the Phase 1.65 Handover Alignment Gate consumes. The issue is filed (only if the gate confirms it) in Phase 5 Step 3. Candidate record (JS keys as `routeCandidates` / `normalizeCandidate` read them — `source-phase`→`sourcePhase`, `origin-issue`→`originIssue`; see `plan-verification.md § Candidate Record Format`):
  - `{ task: '<original task description>', sourcePhase: '1.2', originIssue: <IID or null>, priority: '<original>', bucket: 'partially-done' }`
- The eventual issue keeps the source-specific `[Carryover]` template — Title `[Carryover] <original task description>`, Labels `priority::<original>` + `status:ready`, Description = what's done / what's left / context for next session / **Revisit-Trigger** (mandatory — a concrete reopen condition; a deferral with no named trigger is not a deferral; see `skills/gitlab-ops/SKILL.md § Carryover Template`).
- Link to the original issue when applicable (record its IID as `originIssue`; a candidate with no origin issue auto-carries per the gate's routing, so nothing planned is silently forgotten).

### 1.3 Not Started Items
- Document WHY (blocked? de-scoped? out of time?)
- If no longer relevant: close the original issue with a comment explaining why. This is a **pre-gate disposition** — it files nothing and adds no candidate.
- If still relevant: **do NOT touch the original issue here.** Append a carryover candidate so the Phase 1.65 gate surfaces it — `{ task: '<item>', sourcePhase: '1.3', originIssue: <original IID>, priority: '<original>', bucket: 'not-started' }`. Phase 1.3 files no NEW `[Carryover]` issue; the candidate's disposition IS the keep-vs-carry decision on the ORIGINAL issue. If the gate carries it → ensure the original remains `status:ready`; a dropped middle-band 1.3 candidate leaves the original issue unchanged and open (no auto-close in v1).

### 1.4 Emergent Work
- Tasks that were NOT in the plan but were done (fixes, discoveries)
- **Completed emergent work** (finished, or already dispositioned into an issue): document and attribute to the relevant issues exactly as today — this path is **NOT gated**. If a completed emergent fix warrants a follow-up/doc issue, create it immediately (unchanged behavior).
- **Unfinished / undispositioned emergent work** (at close, neither finished nor already filed as an issue): **do NOT file it here.** Append a carryover candidate — `{ task: '<emergent item>', sourcePhase: '1.4', originIssue: <IID or null>, priority: '<assessed>', bucket: 'emergent' }`. The Phase 1.65 gate decides whether it is filed; a confirmed 1.4 candidate is filed in Phase 5 Step 3 as a **normal** issue (NOT the `[Carryover]` template).

### Candidate Record Format (#769)

> Since #769, Phases 1.2 / 1.3 (still-relevant) / 1.4 (unfinished emergent) / 1.6 (SPIRAL/FAILED walk) **no longer file `[Carryover]` issues immediately** — they append **carryover candidates** to an in-memory list that the Phase 1.65 Handover Alignment Gate routes, and Phase 5 Step 3 files the gate's carry-list. The authoritative gate prose (routing, AUQ shapes, fail-open) lives in `SKILL.md § 1.65 Handover Alignment Gate` — this subsection documents only the record shape the phases produce.

Each candidate is a plain object with these fields (JS keys are the ones `routeCandidates` / `normalizeCandidate` in `scripts/lib/handover-gate.mjs` read):

| Concept | JS key | Type | Notes |
|---|---|---|---|
| task | `task` | `string` | Task text. Missing/empty → `normalizeCandidate` flags `malformed: true` and routes it to `ask`. |
| source-phase | `sourcePhase` | `'1.2' \| '1.3' \| '1.4' \| '1.6'` | The Phase-1 bucket that emitted the candidate; used to infer `bucket` when absent. |
| origin-issue | `originIssue` | `number \| null` | Origin issue IID, or `null` when there is none. **`null` → auto-carry** (dropping a candidate with no origin issue would be real forgetting; keeps `SKILL.md:853` intact). |
| priority | `priority` | `'critical' \| 'high' \| 'medium' \| 'low' \| null` | `critical`/`high` → auto-carry. `medium`/`low`/`null` (with an origin issue) → middle-band `ask`. |
| bucket | `bucket` | `'partially-done' \| 'not-started' \| 'emergent' \| 'spiral-failed'` | Maps 1.2→`partially-done`, 1.3→`not-started`, 1.4→`emergent`, 1.6→`spiral-failed`. `spiral-failed` → auto-carry. |

**Routing (deterministic, `routeCandidates`):** a candidate lands in `autoCarry` (non-deselectable, gate-summary only) when `priority ∈ {critical, high}` OR `bucket === 'spiral-failed'` OR `originIssue === null`; otherwise it lands in `ask` (the preselected middle-band multiSelect). SPIRAL/FAILED candidates additionally carry a non-schema `_spiral: { kind, context }` annotation on the coordinator's original object — consumed by the deferred `createSpiralCarryoverIssue` call in Phase 5 Step 3 (`routeCandidates` strips it from its normalized copies).

### 1.5 Discovery Scan (if enabled)

Read `skills/session-end/discovery-scan.md` for embedded discovery dispatch and findings triage.

### 1.6 Safety Review

> Skip if `persistence` is `false` in Session Config (STATE.md won't exist).

Review safety metrics from the session. This is informational — it does NOT block the session close.

1. Read `<state-dir>/STATE.md` to extract:
   - **Circuit breaker activations**: agents that hit maxTurns (`PARTIAL`), agents that spiraled (`SPIRAL`), agents that failed (`FAILED`)
   - **Worktree status**: which agents used worktree isolation, any fallbacks or merge conflicts
2. Read enforcement hook logs from stderr (if captured): count of scope violations blocked/warned, command violations blocked/warned
3. Summarize:
   ```
   Safety review:
   - Agents: [X] complete, [Y] partial (hit turn limit), [Z] spiral/failed
   - Enforcement: [N] scope violations, [M] command blocks
   - Isolation: [K] agents in worktrees, [J] fallbacks
   ```
4. If any agents were `SPIRAL` or `FAILED`, ensure a carryover **candidate** is collected for each (they auto-carry; filed via the Phase 1.65 gate → Phase 5 Step 3 — cross-reference with Phase 1.2)

5. **Carryover validation fallback (#261) — collect, do NOT file yet (#769):** Walk each Wave History entry in STATE.md. For every agent whose status is `SPIRAL` or `FAILED`, check whether the line ends with a `→ issue #NNN` suffix (or `→ existing #NNN`). If the suffix is absent, the auto-create call in wave-executor did not run (e.g. a consumer-project #251 V0.x.y-close incident where the session crashed before dispatch completed, or the CLI was offline at detection time). **Do NOT call `createSpiralCarryoverIssue` here** — since #769 its firing moves behind the Phase 1.65 Handover Alignment Gate so that NO `[Carryover]` issue is created before the gate. Instead append an **auto-carry** candidate (SPIRAL/FAILED is a non-deselectable auto-carry class — the gate only surfaces it in the status count, never as a deselectable option; consistent with the Critical Rule at `SKILL.md:853`), carrying the payload the deferred `createSpiralCarryoverIssue` call will need:

   ```js
   // #769: collect, don't file. The actual createSpiralCarryoverIssue() call
   // fires in Phase 5 Step 3 (behind the gate). bucket 'spiral-failed' → auto-carry,
   // so it is ALWAYS carried; the operator never sees it as a triage option.
   // For each SPIRAL/FAILED agent missing the "→ issue #NNN" suffix:
   candidates.push({
     task: '<agent task from Wave History>',
     sourcePhase: '1.6',
     originIssue: null,           // SPIRAL/FAILED safety-net items carry no origin issue
     priority: 'high',
     bucket: 'spiral-failed',
     // Filing payload retained on the coordinator's original candidate object,
     // consumed in Phase 5 Step 3 (routeCandidates only classifies — it returns
     // normalized copies and does not carry this annotation):
     _spiral: { kind: 'SPIRAL' /* or 'FAILED' */, context: '<Deviations / error context from STATE.md>' },
   });
   ```

   The deferred Phase-5.3 call imports `createSpiralCarryoverIssue` from `${PLUGIN_ROOT}/scripts/lib/spiral-carryover.mjs`; it is idempotent via its task-hash dedup marker, so re-running the fallback across sessions will not create duplicates.

#### 1.6.6 Record "What Not To Retry" entries (#623)

> Skip if `persistence` is `false` (STATE.md won't exist).

For every `SPIRAL` or `FAILED` agent surfaced in the walk above, ALSO append a cross-session "What Not To Retry" entry to STATE.md. This is the durable, human-readable continuity slot that the NEXT session-start surfaces as a forced-read block (session-start Phase 6.5.1) so a future session does not re-attempt the same failed approach. Unlike a carryover issue (which captures unfinished work), this captures the *approach that should not be repeated*.

```js
import { appendWhatNotToRetryOnDisk } from '${PLUGIN_ROOT}/scripts/lib/state-md.mjs';

// `parsed` = parseStateMd(STATE.md); `session:` is an attribution/history label.
// It records this entry's provenance only and never authorizes lock ownership.
const sessionId = parsed.frontmatter.session ?? 'unknown-session';
const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// For each SPIRAL/FAILED agent from the Wave History walk:
await appendWhatNotToRetryOnDisk(repoRoot, {
  approach: '<agent task description from Wave History>',
  why_failed: '<SPIRAL|FAILED> — <one-line context> (evidence: <file:line or path>)',
  session_id: sessionId,
  date: today,
});
```

`why_failed` MUST cite at least one concrete file (and line, if applicable) that grounds the failure — a bare narrative reason without a file reference is not acceptable.

The helper is lock-guarded (PSA-005) and prunes the section FIFO to the 10 most-recent entries on each append. **Optional coordinator entry:** if the session abandoned an approach for reasons NOT captured by a SPIRAL/FAILED agent (e.g. a design that proved unworkable mid-session), the coordinator MAY add a free-text entry through the SAME `appendWhatNotToRetryOnDisk` helper with a descriptive `approach` + `why_failed`. Recording is informational and does NOT block the close.

### 1.65 Handover Alignment Gate (#769)

> **Opt-in-by-default interactive gate.** Reads `handover-gate.enabled` (default `true`) and `handover-gate.max-open-questions` (default `3`) from parsed Session Config (`cfg['handover-gate']`, produced by `scripts/lib/config.mjs` → `scripts/lib/config/handover-gate.mjs`). Position is load-bearing: it runs AFTER Phase 1.6.6 — so all four candidate sources (1.2 Partially Done, 1.3 Not Started still-relevant, 1.4 unfinished Emergent, 1.6 SPIRAL/FAILED walk) are computed and NOTHING has been filed yet — and BEFORE Phase 1.7, so the gate's carry/drop decision feeds the Phase 1.7 carryover count. This is the ONLY place `[Carryover]` filing is authorized to originate; Phase 5 Step 3 merely executes the gate's carry-list.

> **Skill-prose-first, minimal mechanical core** — same pattern as Phase 3.6.3 memory-proposals: the coordinator runs the `AskUserQuestion` interaction (per `.claude/rules/ask-via-tool.md` AUQ-003); the pure `scripts/lib/handover-gate.mjs` lib does only the deterministic classification. No hook, no agent, no new event schema.

#### Fail-open skip (FA5 — the load-bearing safety decision)

Skip the gate entirely — treat EVERY candidate as carry (byte-identical to the pre-#769 status quo), emitting a single stderr WARN — when ANY of:

- `cfg['handover-gate'].enabled === false`.
- session-end runs in an **embedded / autopilot** context OR headless `claude -p` (no operator at the keyboard; `AskUserQuestion` is unavailable per AUQ-004 — the same embedded-mode precedent as discovery suppressing its AUQ).
- `AskUserQuestion` is unavailable or throws at call time (wrap the calls; on error, fail-open — never surface a half-rendered gate).
- The candidate list is empty AND STATE.md `## Open Questions` has no unanswered entry — **Zero-Friction clean close**: emit NO AUQ and continue unchanged.

Fail-open NEVER hangs the close on an unanswerable AUQ and NEVER loses data — it degrades exactly to today's silent-carryover behavior. Log e.g. `⚠ handover-gate: skipped (<reason>) — all candidates carry (status quo)`.

**Telemetry on skip (#773):** even when the gate is skipped, emit the `orchestrator.handover.gated` event ONCE with `path: "fail_open"` so this never-interactive path is still measurable (the carryover=0 blind spot #773 closed was invisible precisely because skipped closes emitted nothing). Every candidate carries, so `auto_carry = candidates_total`, `asked = 0`, `dropped = 0`, and the three question counts are `0`:

```bash
node scripts/emit-event.mjs --type orchestrator.handover.gated --payload \
  "$(node -e "process.stdout.write(JSON.stringify({candidates_total: CT, auto_carry: CT, asked: 0, dropped: 0, questions_asked: 0, questions_answered: 0, questions_deferred: 0, path: 'fail_open'}))")"
```

(`CT` = the in-memory candidate-list length. The Zero-Friction clean-close variant — empty candidates AND no open questions — emits with all counts `0` and `path: "fail_open"` too, so even the quietest close leaves a breadcrumb.)

#### Step 1 — Assemble candidates + open questions

1. The in-memory **candidate list** is the union of the candidates appended by Phases 1.2 / 1.3 (still-relevant) / 1.4 (unfinished emergent) / 1.6 (SPIRAL/FAILED). Each candidate object carries `{ task, sourcePhase, originIssue, priority, bucket }` (plus any filing payload, e.g. the SPIRAL/FAILED `_spiral` kind/context). See `plan-verification.md § Candidate Record Format`.

2. **Classify** via the pure helper:

   ```js
   import { routeCandidates } from '${PLUGIN_ROOT}/scripts/lib/handover-gate.mjs';
   const { autoCarry, ask } = routeCandidates(candidates);
   ```

   `autoCarry` = `priority::critical|high` OR `bucket === 'spiral-failed'` OR `originIssue === null` — **non-deselectable** (dropping any of these would be real forgetting; consistent with the Critical Rule at `SKILL.md:853`). `ask` = the middle-band (priority `medium`/`low`/none WITH an origin issue, buckets not-started/emergent/partially-done) plus any `malformed` record. `routeCandidates` returns NORMALIZED copies for gate rendering; the coordinator retains its ORIGINAL candidate objects (with filing payloads) for Phase 5 Step 3.

3. Read STATE.md contents and extract the open questions via the sibling helper:

   ```js
   import { readOpenQuestions } from '${PLUGIN_ROOT}/scripts/lib/state-md.mjs';
   const openQuestions = readOpenQuestions(stateMdContents); // Array<{question, source, priority, answered, answer?}>
   const unanswered = openQuestions.filter((q) => !q.answered);
   ```

4. **Zero-Friction check:** if `autoCarry.length === 0 && ask.length === 0 && unanswered.length === 0`, skip per Fail-open above (no AUQ, no WARN needed beyond an info log — clean close).

#### Step 2 — AUQ Call 1 (Status-Gate)

Render ONE `AskUserQuestion`. The question text NAMES the candidate counts by class and the open-question count, e.g. `"<A> auto-carry + <M> triage candidate(s), <U> open question(s). Close and triage now?"`. Options (Recommendation first, AUQ-003):

- **"Closen + Triage (Recommended)"** — proceed to AUQ Call 2 (triage the middle-band + answer the top open questions), then file the resulting carry-list in Phase 5 Step 3.
- **"Alle carryoven (ohne Triage)"** — fast-path: carry ALL candidates (`autoCarry ∪ ask`) with no triage; SKIP AUQ Call 2; unanswered questions stay `- [ ]` and roundtrip to the next session. Equivalent to the status quo for filing, minus the friction.
- **"Weiterarbeiten (Close abbrechen)"** — abort session-end cleanly: NO commit, NO lock-release, NO issue creation; STATE.md stays `status: active`; the session remains open and the coordinator continues working the open points. **Before stopping, emit `orchestrator.handover.gated` ONCE with `path: "weiterarbeiten"` (#773)** — the gate WAS rendered (AUQ Call 1 happened) and the operator chose to keep working, which is a distinct, previously-unmeasured outcome. Nothing is filed, so report `auto_carry = autoCarry.length`, `asked = ask.length`, `dropped = 0`, and all three question counts `0`:

  ```bash
  node scripts/emit-event.mjs --type orchestrator.handover.gated --payload \
    "$(node -e "process.stdout.write(JSON.stringify({candidates_total: CT, auto_carry: AC, asked: ASK, dropped: 0, questions_asked: 0, questions_answered: 0, questions_deferred: 0, path: 'weiterarbeiten'}))")"
  ```

  Then print `session-end aborted at Phase 1.65 by user choice (Weiterarbeiten). Session stays open.` and STOP the close (do not fall through to Phase 1.7).

(Codex CLI / Cursor IDE: same three options as a numbered Markdown list.)

#### Step 3 — AUQ Call 2 (Triage + Open Questions) — only after "Closen + Triage"

Combine the Middle-Band triage multiSelect AND up to `max-open-questions` open-question single-questions, honoring AUQ-003 (≤4 questions/call, ≤4 options/multiSelect):

1. **Middle-Band multiSelect** — one multiSelect over the `ask` candidates, EVERY option **preselected** (= carry; one Enter keeps the sensible default). Option label: `[<bucket>] <task-truncated> — <priority|—> (origin #<IID|none>)`. `multiSelect: true`. Deselected = drop.
   - **Batching (Phase 3.6.3 precedent):** `0` → no multiSelect; `1–4` → a single multiSelect that rides in the SAME first call alongside the open questions; `5+` → sequential `Batch N of M` multiSelects in FIFO batches of 4 (`header: "Handover — Triage Middle-Band (Batch N of M)"`).

     ```js
     const BATCH_SIZE = 4;
     const batches = [];
     for (let i = 0; i < ask.length; i += BATCH_SIZE) batches.push(ask.slice(i, i + BATCH_SIZE));
     ```

     When `ask.length ≤ 4`: the single triage multiSelect + up to `max-open-questions` open-question single-questions all ride in ONE call (1 + 3 = 4 questions max — AUQ-003-safe). When `ask.length > 4`: emit the open questions in the FIRST call and the middle-band as ⌈M/4⌉ dedicated `Batch N of M` calls.

2. **Open questions** — up to `max-open-questions` (default 3; effectively capped at 3 in the first call = the 4-question limit minus the 1 triage multiSelect) highest-priority `unanswered` questions, each a single-select with 2–4 options (Recommendation first). Derive options from the agent-supplied answer-candidates when present; otherwise offer `Answer: <A> / Answer: <B> / Defer (keep open)`. Questions beyond the cap stay untouched (`- [ ]`) and roundtrip (FA3-Semantik).

#### Step 4 — Apply the gate outcome

1. **carry-list** = `autoCarry` (always) ∪ the middle-band `ask` items the operator LEFT SELECTED. **drop-list** = the middle-band `ask` items the operator DESELECTED. (`"Alle carryoven"` → carry-list = `autoCarry ∪ ask`, drop-list = ∅.) Store both for Phase 5 Step 3 (filing) and Phase 6 (report). NOTHING is filed in this phase.

2. **Answered open questions — decide + enqueue in-memory only; do NOT mark `[x]` yet (#769):** for each open question answered in AUQ Call 2, capture the outcome in an in-memory `answeredQuestions` list — one record per answered question: `{ question, answer, impliesWork: <bool> }`. Do **NOT** call `markOpenQuestionAnsweredOnDisk` in this phase.

   The durable STATE.md `- [x]` write is deliberately deferred to **Phase 5 Step 3** so that it lands on the SAME side of the Quality Gate (Phase 3) as the carryover-issue filing — either a completed close marks the question `[x]` AND files its implied work, or a Quality-Gate abort does neither. Marking `[x]` here (at gate time) would silently forget the answer if the Quality Gate later aborts the close: the now-`[x]` question no longer re-surfaces via `readOpenQuestions().filter(!answered)` on re-close, so any implied work would be dropped ticketless — exactly the silent-forget this feature exists to prevent.

   If the chosen answer **implies NEW work** (`impliesWork: true`), ALSO enqueue it now onto the carry-list as a carry-candidate (`originIssue: null` → auto-carry), carrying the answer as body context, so Phase 5 Step 3 files the issue AND marks the question `[x]` atomically. Pure decisions with no to-do (`impliesWork: false`) carry no candidate; they are recorded only by the Phase 5.3 STATE.md `[x]` mark + the Final Report. Unanswered / over-cap questions stay `- [ ]` and roundtrip to the next session (FA4).

3. The gate's carry/drop split feeds the Phase 1.7 carryover count.

#### Step 5 — Emit gate telemetry (#773)

After the carry/drop split is settled, emit `orchestrator.handover.gated` **exactly once** for the interactive path taken. This is the mechanical producer that makes the gate observable — before #773 the gate decided carry/drop entirely in coordinator prose, so `effectiveness.carryover` had no mechanical anchor and 41/41 records read `carryover: 0` despite real filtering. Derive the payload from the in-memory gate state:

- `candidates_total` = `autoCarry.length + ask.length`
- `auto_carry` = `autoCarry.length` (non-deselectable)
- `asked` = `ask.length` (middle-band candidates surfaced for triage)
- `dropped` = drop-list length (middle-band items the operator DESELECTED; `0` on the `"Alle carryoven"` fast-path since AUQ Call 2 is skipped)
- `questions_asked` / `questions_answered` / `questions_deferred` = the open-question counts from AUQ Call 2 (surfaced / answered / left `- [ ]` and roundtripped). All `0` on the fast-path.
- `path` = `"triage"` (after "Closen + Triage") or `"fast_path"` (after "Alle carryoven ohne Triage")

```bash
node scripts/emit-event.mjs --type orchestrator.handover.gated --payload \
  "$(node -e "process.stdout.write(JSON.stringify({candidates_total: CT, auto_carry: AC, asked: ASK, dropped: DROP, questions_asked: QA, questions_answered: QAN, questions_deferred: QD, path: PATH}))")"
```

The `questions_asked / questions_answered / questions_deferred` values here are the SAME three counts recorded as the top-level `open_questions_asked / open_questions_answered / open_questions_deferred` session fields in Phase 1.7 (see `metrics-collection.md`). Emit the event with the exact `scripts/emit-event.mjs --type … --payload …` flag signature (NOT a positional argument — see the CLI header).

### 1.7 Metrics Collection

Read `skills/session-end/metrics-collection.md` for JSONL schema and conditional field rules.

### 1.8 Session Review

Dispatch the session-reviewer agent to verify implementation quality before the quality gate:

> On Codex CLI, dispatch via the `session-reviewer` agent role defined in `.codex-plugin/agents/session-reviewer.toml`.

1. Invoke `subagent_type: "session-orchestrator:session-reviewer"` with:
   - **Scope**: all files changed this session (from `git diff --name-only` against the base branch)
   - **Context**: the session plan (issues, acceptance criteria) and all wave results from STATE.md
2. Wait for the reviewer's **Verdict**:
   - **PROCEED** — continue to Phase 2
   - **FIX REQUIRED** — disposition each listed item by severity:

     | Finding class | Disposition |
     |---|---|
     | HIGH+ / blocking review finding | Fix inline if quick (<2 min); else create an issue (`priority::high`, `status:ready`) and note it in the Final Report |
     | MED / LOW review finding | Fold in-session if quick; else record under "Unresolved Review Findings" in the Final Report — DO NOT create an issue (#617) |
     | Planned-carryover (item was in the plan, not finished) | Route as a carryover **candidate** per Phase 1.2 → the Phase 1.65 gate files it. Never forgotten: a no-origin/critical/high item auto-carries as a `[Carryover]` issue; a middle-band item with an origin issue is preselected=carry (and its origin issue stays open even if dropped). |
     | SPIRAL / FAILED agent carryover | Route as an **auto-carry** candidate per Phase 1.6 → filed via `createSpiralCarryoverIssue` in Phase 5 Step 3 (non-deselectable; **exempt from the `issue-budget` cap** — the `[Carryover] [SPIRAL\|FAILED]` title and the `type::carryover` label bypass it, so a full budget can never swallow this filing) |

**Override-ratio telemetry (#730/H5):** whenever one or more MED/LOW review findings are routed to "Unresolved Review Findings" (rather than fixed), additionally emit a single event capturing how many findings were absorbed rather than resolved — feeding the `override_ratio` metric:

```bash
node scripts/emit-event.mjs --type orchestrator.finding.overridden --payload '{"phase":"1.8","kind":"med-low-review-finding","count":N}'
```

### 1.9 Mission-Status Classification (when `mission-status` present in STATE.md)

> Skip if `persistence` is `false` in Session Config, or if `mission-status:` is absent from STATE.md frontmatter. When absent, fall back to binary checkbox detection in 1.1–1.4 unchanged — full backward compat.

When STATE.md frontmatter contains a `mission-status:` array (set by session-plan + wave-executor per #340), use the enum values to classify items into the 1.1–1.4 buckets. Read the array via `parseMissionStatus(frontmatter)` from `scripts/lib/state-md.mjs`.

**Classification mapping:**
- `status: completed` → **1.1 Done Items** (item finished; verify with evidence per 1.1)
- `status: testing` or `status: in-dev` → **1.2 Partially Done** (carryover; document what remains)
- `status: validated` or `status: brainstormed` → **1.3 Not Started** (carryover; check if still relevant)
- Items NOT present in the `mission-status:` array → fall back to binary checkbox detection per 1.1–1.4 unchanged

**Backward compat:** When `mission-status:` is absent from STATE.md (pre-#340 STATE.md files, or sessions where session-plan did not emit the block), behave exactly as before — enum classification is skipped entirely and 1.1–1.4 binary checkbox logic runs as the sole classification mechanism.

### 1.10 Mission Status Breakdown (when `mission-status` present)

> Skip if `mission-status:` is absent from STATE.md frontmatter (backward compat — no breakdown emitted).

After classifying items in Phase 1.9, produce a **Mission Status breakdown** subsection as part of the closed/carryover summary output. Count the number of tasks at each enum value across ALL waves:

```
### Mission Status Breakdown
- completed:    <N> tasks
- testing:      <N> tasks
- in-dev:       <N> tasks
- validated:    <N> tasks
- brainstormed: <N> tasks
- Total:        <N> tasks across <W> waves
```

Rules:
- Count each task-id entry from the `mission-status:` frontmatter array by its current `status` value.
- `completed` maps to Phase 1.1 (Done). `testing` + `in-dev` map to Phase 1.2 (Partial). `validated` + `brainstormed` map to Phase 1.3 (Not Started).
- Include this block in the Phase 6 Final Report under `### Carried Over` or as a standalone subsection immediately after the Completed/Carried Over/New Issues lists.
- When all tasks are `completed`, the breakdown still appears (confirms clean session state).

