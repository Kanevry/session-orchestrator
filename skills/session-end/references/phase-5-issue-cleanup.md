# Phase 5: Issue Cleanup

> Sub-file of the session-end skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-end/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 5: Issue Cleanup

> **VCS Reference:** Use CLI commands per the "Common CLI Commands" section of the gitlab-ops skill.

1. **Close resolved issues**: Before closing each issue, strip `status:*` workflow labels using `stripStatusLabels` from `scripts/lib/issue-close-strip-labels.mjs` (#308). A closed issue carrying `status:in-progress` or `status:ready` skews dashboard filters and discovery heuristics. Then close and add a note using the issue close and note commands per the "Common CLI Commands" section of the gitlab-ops skill. Note: some VCS platforms require separate note and close commands.

   ```js
   import { stripStatusLabels } from '${PLUGIN_ROOT}/scripts/lib/issue-close-strip-labels.mjs';

   // For each resolved issue IID:
   const { stripped, error } = await stripStatusLabels({ issueId: iid, vcs: '<from Session Config>' });
   if (error) {
     console.warn(`⚠ label strip failed for #${iid}: ${error} — proceeding with close`);
   } else if (stripped.length) {
     console.log(`Stripped ${stripped.join(', ')} from #${iid}`);
   }
   // then: glab issue close <iid> / gh issue close <iid>
   ```

   The call is idempotent: if the issue has no `status:*` labels, no update CLI call is made. Failures from `stripStatusLabels` are non-fatal — log and proceed with close.

2. **Update in-progress issues**: ensure labels reflect actual state using the issue update command
3. **Create carryover issues — from the Phase 1.65 gate's carry-list ONLY (#769):** file an issue for each item on the carry-list produced by the Handover Alignment Gate — i.e. the non-deselectable **auto-carry** class (`priority::critical|high`, SPIRAL/FAILED, or no-origin-issue candidates) PLUS the middle-band items the operator LEFT SELECTED in triage. Do NOT file anything the gate dropped, and do NOT file directly from Phase 1.2/1.3/1.4/1.6 — those phases only collected candidates.
   - **Template stays source-specific:** 1.2 Partially-Done → `[Carryover] <task>` (labels `priority::<original>`, `status:ready`); 1.4 unfinished Emergent → a **normal** issue (NOT the `[Carryover]` template); 1.6 SPIRAL/FAILED → fire the deferred `createSpiralCarryoverIssue({ taskDescription, kind, context, priority: 'high', vcs })` (idempotent task-hash dedup — payload comes from the candidate's `_spiral` annotation set in Phase 1.6 step 5). 1.3 files no NEW issue: a carried 1.3 candidate simply keeps its ORIGINAL issue `status:ready`.
   - **Dropped middle-band items:** file NO `[Carryover]` duplicate; the origin issue stays open and unchanged. Record each drop in the Phase 6 Final Report under `### Dropped at Handover Gate` with its origin-issue reference and a reason slot.
   - **Fail-open / gate skipped:** when Phase 1.65 skipped fail-open, the carry-list is ALL candidates (status quo) and there is no drop-list.
   - **Mark answered open questions `[x]` durably — atomic with the filing above (#769):** now, on the completed side of the Quality Gate, persist each answered open question captured in-memory at Phase 1.65 Step 4 to STATE.md via the lock-guarded sibling helper (PSA-005). Co-locating this write with the carryover-issue filing is the load-bearing correctness invariant: an earlier Quality-Gate abort leaves every question `- [ ]` on disk, so it correctly re-surfaces via `readOpenQuestions().filter(!answered)` on re-close — the `[x]` mark now reflects a COMPLETED handover, never a mid-close state a later abort would invalidate. Any implied-work candidate an answered question enqueued in Phase 1.65 is filed by the carry-list step above, so the mark and its issue land together:

     ```js
     import { markOpenQuestionAnsweredOnDisk } from '${PLUGIN_ROOT}/scripts/lib/state-md.mjs';
     // answeredQuestions captured in Phase 1.65 Step 4 (in-memory, un-persisted until now)
     for (const { question, answer } of answeredQuestions) {
       await markOpenQuestionAnsweredOnDisk(repoRoot, question, answer); // "- [ ] Q" → "- [x] Q → Antwort: <answer>"
     }
     ```

     Fail-open: a `markOpenQuestionAnsweredOnDisk` failure is non-fatal — log a WARN and proceed with the close; the question simply stays `- [ ]` and roundtrips to the next session.

3b. **Drain the issue-budget overflow — exactly ONE collector artefact (issue-budget):** when this session's budget file (`budgetStatePath(repoRoot, accountingSessionId)` → `.orchestrator/runtime/issue-budget/<hash>.json`, #1141) has a non-empty `overflow[]`, the session hit its `issue-budget.max-per-session` cap and every over-cap creation was PARKED rather than filed. Fold the whole list into a single artefact so nothing is silently dropped.

    **Ordering (load-bearing):** run this as the LAST issue-creating action of Phase 5 — after step 3, after "Discovery Issue Creation", after step 4 — and re-read the counter file at that moment. Those steps can themselves push new entries into `overflow[]`; draining early would leave them unfiled.

    ```js
    import { readFileSync } from 'node:fs';
    import {
      readBudgetState,
      budgetStatePath,
      resolveIssueBudgetSessionId,
    } from '${PLUGIN_ROOT}/scripts/lib/issue-budget.mjs';

    // `sessionId` is the physical raw lock/registry identity from session-start.
    const rawSessionId = sessionId;
    let currentSession = null;
    try {
      currentSession = JSON.parse(
        readFileSync(`${repoRoot}/.orchestrator/current-session.json`, 'utf8'),
      );
    } catch { /* no verified semantic accounting bridge */ }
    const accountingSessionId = resolveIssueBudgetSessionId(rawSessionId, currentSession);
    const state = readBudgetState(repoRoot, accountingSessionId);
    // { sessionId, count, exempt, overflow: [...] }
    ```

    `accountingSessionId` may be semantic only after
    `currentSession.session_id === rawSessionId`; this is budget accounting, not
    lock/registry ownership. When that proof is absent it remains the raw id.
    A host rotation that changes both raw and semantic values has no guaranteed
    budget continuity.

    - **`issue-budget.overflow: collect-issue` (default)** — create exactly ONE issue:
      - Title: `[Backlog-Sammel] <accountingSessionId>, <N> zurückgestellte Punkte`
      - Labels: `type::backlog`, `priority::low`
      - Body: a Markdown checklist with one `- [ ]` line per `overflow[]` entry (`title` when present, otherwise the truncated `command`, plus its `at` timestamp).
      - This collector issue is itself EXEMPT from the cap (`[Backlog-Sammel]` is in the exemption list in `scripts/lib/issue-budget.mjs`), so it always lands even at count == max.
    - **`issue-budget.overflow: vault-note`** — create NO issue. Write one Markdown file `vault/00-inbox/<accountingSessionId>-backlog-sammel.md` (path relative to `vault-integration.vault-dir`) with valid vault frontmatter and the same checklist body.
    - After the artefact exists, reset `overflow` to `[]` in the counter file and record the collector issue ID / note path in the Phase 6 Final Report under `### Zurückgestellt (issue-budget)`.
    - **Never exempt-by-accident:** the cap never applied to `priority::critical`, the carryover class (`[Carryover]`, SPIRAL/FAILED, `type::carryover`), or `broken-window` closure issues, so nothing on the Phase 1.65 carry-list can ever appear in `overflow[]`. The promises at Phase 1.8 ("SPIRAL / FAILED agent carryover … non-deselectable") and the Critical Rule "ALWAYS create issues for unfinished PLANNED work" stay intact by construction.
    - Fail-open: a missing or malformed counter file means "no overflow" — log a WARN and continue the close.
    - **Then reap stale counter files (#1151):** the per-session split (#1141) writes one file per accounting session and nothing ever deleted them, so `.orchestrator/runtime/issue-budget/` grew without bound in every working copy. After the drain, sweep files older than 14 days; THIS session's file is exempt regardless of age, and the call is best-effort (it never throws, so it can never abort the close).

      ```js
      import { reapStaleBudgetFiles } from '${PLUGIN_ROOT}/scripts/lib/issue-budget.mjs';

      const { removed } = reapStaleBudgetFiles({ repoRoot, sessionId: accountingSessionId });
      if (removed.length) console.log(`issue-budget: reaped ${removed.length} stale counter file(s) (> 14 d)`);
      ```

#### Discovery Issue Creation (if discovery ran in Phase 1.5)

For each finding with severity `critical` or `high` from Phase 1.5:
1. Create a VCS issue using the detected platform CLI:
   - Title: `[Discovery] <description>` (truncated to 70 chars)
   - Body: `**Probe:** <probe>\n**File:** <file>:<line>\n**Severity:** <severity>\n**Confidence:** <confidence>%\n**Recommendation:** <recommendation>`
   - Labels: `type:discovery`, `priority::<severity>` (critical→critical, high→high)
2. Log each created issue ID for the Final Report
3. Update `discovery_stats.issues_created` count

4. **Create gap issues for HIGH+/blocking newly-discovered problems only** — MED/LOW review findings are recorded in the Final Report, not filed as issues (#617; see the Phase 1.8 severity-disposition table). This mirrors the Phase 5 "Discovery Issue Creation" gate (critical/high only).
5. **Update milestones**: if milestone progress changed

