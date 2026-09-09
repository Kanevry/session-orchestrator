# Discovery — Phase 5: Interactive Triage (Standalone Mode Only)

> Reference of the `discovery` skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.

## Phase 5: Interactive Triage (Standalone Mode Only)

### 5.0 Load Triage State & Partition Findings

Before auto-defer and before presenting any findings for triage, load the persistent discovery triage state and filter findings through it:

1. Call `loadTriageState()` from `scripts/lib/discovery/triage-state.mjs` (uses default path `.orchestrator/metrics/discovery-triage.jsonl`). Returns an empty Map if the file does not exist — no error.
2. Call `filterFindings({ findings: verifiedFindings, stateMap })` to partition findings into three buckets:
   - `toShow` — state is `open`, `reopened`, or **no prior state entry** (new findings — present for user triage)
   - `suppressed` — state is `dismissed` or `accepted-as-known` (skip silently)
   - `tracked` — state is `promoted-to-#NNN` (issue already filed; show as informational)

3. Emit a one-line state banner before the summary table:
   ```
   Triage state: [N suppressed] suppressed (dismissed/accepted-as-known), [N tracked] tracked in existing issues. Presenting [N toShow] findings.
   ```
   Omit the banner entirely if all three counts are zero (first run).

4. Render `tracked` findings as informational lines in the summary — NOT as interactive triage items:
   ```
   [INFO] Finding "<title>" (<file_path>) is tracked in #<issue_id> — not re-triaged.
   ```

5. Continue Phase 5 triage using only `toShow` findings. The `suppressed` bucket requires no user interaction.

6. After the user completes triage (Steps 1-4 below), append state changes to `.orchestrator/metrics/discovery-triage.jsonl` via `appendTriageEntry()` from `triage-state.mjs`:
   - User selects "Create issue" → append `{ fingerprint, state: 'promoted-to-#<issue_id>', issue_id: <N>, timestamp, session_id }`
   - User selects "Dismiss -- intentional" or "Dismiss -- false positive" → append `{ fingerprint, state: 'dismissed', user_decision: '<reason>', timestamp, session_id }`
   - User selects "Accept all" for batch → append one `{ fingerprint, state: 'open', ... }` entry per finding (so they re-appear next run if not yet promoted)

### 5.1 Auto-Defer Low-Confidence Findings

Before presenting findings for triage, separate by confidence threshold:

1. Findings with confidence >= threshold → present for interactive triage (below)
2. Findings with confidence < threshold → auto-defer with summary:
   "Auto-deferred [N] low-confidence findings (score < [threshold]). Review with `/discovery --include-deferred`."
3. List auto-deferred findings in a collapsed section (not interactive — informational only)

### 5.1 Present High-Confidence Findings

Present findings using AskUserQuestion -- NEVER plain text options. On Codex CLI where AskUserQuestion is unavailable, present as numbered Markdown lists.

Include confidence scores in the presentation:
```
[CRITICAL] (confidence: 85) hardcoded-values: API key found in src/config.ts:42
[HIGH] (confidence: 72) security-basics: eval() usage in src/utils/parser.ts:18
[MEDIUM] (confidence: 61) orphaned-annotations: TODO without issue in src/lib/auth.ts:55
```

### Step 1: Summary

Present a findings overview table:

```
## Discovery Results

Probes run: [N] | Findings verified: [N] | False positives discarded: [N]

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Code     | ...      | ...  | ...    | ... | ...   |
| Infra    | ...      | ...  | ...    | ... | ...   |
| UI       | ...      | ...  | ...    | ... | ...   |
| Arch     | ...      | ...  | ...    | ... | ...   |
| Session  | ...      | ...  | ...    | ... | ...   |
| Audit    | ...      | ...  | ...    | ... | ...   |
| Vault    | ...      | ...  | ...    | ... | ...   |
| Feature  | ...      | ...  | ...    | ... | ...   |
```

### Step 2: Critical + High Findings -- Review Individually

For each Critical or High finding, use AskUserQuestion (on Codex CLI where AskUserQuestion is unavailable, present as numbered Markdown lists):

```
AskUserQuestion({
  questions: [{
    question: "<severity> finding in <file_path> — what should happen with it?",
    header: "Finding",
    options: [
      { label: "Create issue (<severity>)", description: "Files it as priority::<severity>, so it is tracked outside this session. The code below is copied into the issue body.",
        preview: "<finding title>\n\n<file_path>:<line_number>\n```\n<matched_text with +/-3 lines context>\n```\n\n<description>\n\nRecommended fix: <recommended_fix>" },
      { label: "Adjust priority", description: "Same issue, a priority you pick — this question then comes back with the new label." },
      { label: "Dismiss -- intentional", description: "The code is deliberate. Nothing is filed, and the finding stays only in this run's report." },
      { label: "Dismiss -- false positive", description: "The probe misread the code. Nothing is filed; worth reporting if the same probe misfires again." }
    ],
    multiSelect: false
  }]
})
```

If user selects "Adjust priority", ask which priority with another AskUserQuestion. On Codex CLI where AskUserQuestion is unavailable, present as numbered Markdown lists.

### Step 3: Medium + Low Findings -- Review Batched

Group remaining findings by category. For each category with medium/low findings (on Codex CLI where AskUserQuestion is unavailable, present as numbered Markdown lists):

```
AskUserQuestion({
  questions: [{
    question: "Create issues for all [N] medium/low findings in [category]?",
    header: "Findings",
    options: [
      { label: "Accept all (Recommended)", description: "Medium and low findings are cheap to file and cheap to close. Cost: [N] issues, roughly one second apart.",
        preview: "1. [title] -- [file_path]:[line] ([severity])\n2. [title] -- [file_path]:[line] ([severity])\n..." },
      { label: "Review individually", description: "One question per finding, same options as the critical ones. Cost: [N] more prompts." },
      { label: "Dismiss all", description: "Nothing is filed for this category. The findings stay in this run's report only." }
    ],
    multiSelect: false
  }]
})
```

If "Review individually" selected, walk through each like Step 2.

### Step 4: Batch Confirmation

Before creating any issues (on Codex CLI where AskUserQuestion is unavailable, present as numbered Markdown lists):

```
AskUserQuestion({
  questions: [{
    question: "Ready to create [N] issues?\n\n- [X] critical\n- [Y] high\n- [Z] medium\n- [W] low",
    header: "Confirm",
    options: [
      { label: "Create all [N] issues", description: "Proceed with issue creation" },
      { label: "Review list first", description: "Show full list before creating" },
      { label: "Cancel", description: "Do not create any issues" }
    ]
  }]
})
```

