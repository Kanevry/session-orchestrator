---
name: discovery
user-invocable: false
tags: [quality, discovery, probes, issues]
model-preference: sonnet
description: >
  Systematic quality discovery and issue detection. Runs modular probes
  adapted to the project's tech stack, presents findings interactively
  for user triage, and creates VCS issues for confirmed problems.
  Invoked standalone via /discovery or embedded in session-end.
---

# Discovery Skill

## Invocation Modes

Two modes of operation:

- **Standalone** (`/discovery [scope]`): Full 5-phase flow with interactive triage (Phases 0-5)
- **Embedded** (from session-end when `discovery-on-close: true`): Phases 0-3 only, returns structured findings to session-end

The `scope` argument accepts: `all` (default), `code`, `infra`, `ui`, `arch`, `session`, or comma-separated like `code,session`.

## Phase 0: Read Session Config

Run `bash "$CLAUDE_PLUGIN_ROOT/scripts/parse-config.sh"` to get the validated config JSON. If it exits with code 1, read stderr for the error and report to the user. Store the JSON output as `$CONFIG` for use throughout this skill — extract fields with `echo "$CONFIG" | jq -r '.field-name'`.

If the script is not available, fall back to reading CLAUDE.md manually per `docs/session-config-reference.md`.

For the complete field reference, see `docs/session-config-reference.md` in the plugin root.

Discovery-relevant fields (parse these specifically):
- `discovery-on-close`, `discovery-probes`, `discovery-exclude-paths`, `discovery-severity-threshold`, `discovery-confidence-threshold`
- `test-command`, `typecheck-command`, `lint-command`
- `pencil`, `vcs`, `cross-repos`, `stale-issue-days`

## Phase 1: Stack Detection & Probe Activation

Detect the project's tech stack via marker file checks. Use Glob and run checks in parallel:

| Marker File(s)                        | Activates               |
|---------------------------------------|-------------------------|
| `package.json`                        | JS/TS probes            |
| `tsconfig.json`                       | TypeScript probes       |
| `requirements.txt` / `pyproject.toml` | Python probes           |
| `Dockerfile` / `docker-compose.yml`   | Container probes        |
| `vercel.json` / `.vercel/`            | Vercel probes           |
| `.github/workflows/`                  | GitHub CI probes        |
| `.gitlab-ci.yml`                      | GitLab CI probes        |
| `supabase/`                           | Supabase probes         |
| `next.config.*` / `nuxt.config.*`     | SSR probes              |
| `tailwind.config.*`                   | Tailwind probes         |
| Pencil in Session Config              | design-drift probe      |

### Build Activation Set

1. Start with all probes whose marker files are present
2. If `discovery-probes` is set in config, intersect with that list
3. If a `scope` argument was passed, restrict to that category
4. Remove probes whose activation conditions are not met

### Exclude Paths

Default exclude paths (always apply):
- `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `.nuxt/`, `coverage/`

Add any paths from `discovery-exclude-paths` in Session Config.

### VCS Detection

> **VCS Reference:** Detect the VCS platform per the "VCS Auto-Detection" section of the gitlab-ops skill.

### Status Report

Report: "Discovery: [N] probes active across [categories]. Stack: [detected]. Threshold: [severity]."

## Phase 2: Probe Execution

Dispatch probe agents IN PARALLEL using the Agent tool. Group by category (max 5 agents):

- **Code probes agent**: Runs all activated code probes (hardcoded-values, orphaned-annotations, dead-code, ai-slop, type-safety-gaps, test-coverage-gaps, test-anti-patterns, security-basics)
- **Infra probes agent**: Runs all activated infra probes
- **UI probes agent**: Runs all activated UI probes
- **Arch probes agent**: Runs all activated arch probes
- **Session probes agent**: Runs all activated session probes

Each agent receives:
- The probe definitions from `probes.md` (include the actual grep commands/patterns in the prompt)
- The exclude paths list
- The project root path
- Tools: Read, Grep, Glob, Bash (read-only -- no Edit/Write)
- Instruction: "Run each probe. For each finding, output EXACTLY this format:"

```
FINDING:
  probe: <probe_name>
  category: <category>
  severity: <critical|high|medium|low>
  file_path: <absolute path>
  line_number: <number>
  matched_text: <exact text from tool output>
  title: <short title for the finding>
  description: <1-2 sentence description>
  recommended_fix: <concrete fix suggestion>
```

"If a probe's activation condition is not met, skip it with: SKIPPED: <probe_name> -- <reason>"
"If a probe command fails, skip it with: FAILED: <probe_name> -- <error>"
"Do NOT fabricate findings. Only report what tool output confirms."

CRITICAL: `run_in_background: false` for all agents.

Skip categories with no activated probes (don't dispatch empty agents).

## Phase 3: Verification & Scoring

After all probe agents complete:

### 3.1 Parse Findings

Collect all `FINDING:` blocks from agent outputs into a unified findings list.

### 3.2 Verification Pass

For EACH finding:
1. Read the file at `file_path:line_number` using the Read tool
2. Confirm `matched_text` appears at or near that line (+/-3 lines tolerance)
3. If NOT confirmed, discard with note "false positive -- text not found at reported location"
4. Report: "Verification: N confirmed, M discarded as false positives"

### 3.2a Confidence Scoring

For each verified finding, assign a confidence score (0-100) based on three factors:

| Factor | Low (+0) | Medium (+10) | High (+20) |
|--------|----------|-------------|------------|
| Pattern specificity | Generic match (URL, TODO) | Moderate (orphaned annotation, magic number) | Specific (API key regex, eval(), SQL injection) |
| File context | Test fixture, example, seed data, docs | Utility, config, scripts | Production source, API handler, middleware |
| Historical signal | Previously dismissed as false positive | No prior data (first occurrence) | Recurring issue (confirmed in learnings.jsonl) |

**Scoring rules:**
1. Start at 40 (baseline)
2. Add each factor's score (+0/+10/+20)
3. Clamp to 0-100 range
4. **Critical severity override:** findings with severity `critical` get a minimum confidence of 70 — they are NEVER auto-deferred

**Threshold:** Read `discovery-confidence-threshold` from Session Config (default: 60). If not configured, use 60.

Annotate each finding with its confidence score for Phase 4 presentation.

### 3.3 Deduplication

Two findings are duplicates if:
- Same `file_path` AND
- Overlapping line range (+/-5 lines) AND
- Different probes

Keep the higher severity finding. Merge descriptions.

### 3.4 Apply Thresholds

1. **Severity filter:** Remove findings below `discovery-severity-threshold` from Session Config.
2. **Confidence filter:** Remove findings with confidence score below `discovery-confidence-threshold` (default: 60). Log filtered-out findings: "Auto-dismissed N low-confidence findings (below threshold [T]). Use `discovery-confidence-threshold: 0` to see all."

### 3.5 Group by Category

Group remaining findings by category for Phase 4 presentation.

### 3.6 Embedded Mode Exit

If in embedded mode (called from session-end): STOP HERE. Return structured findings to the caller using this schema:

**Findings array** — one entry per verified finding:
```json
[{
  "probe": "<probe name>",
  "category": "<code|infra|ui|arch|session>",
  "severity": "<critical|high|medium|low>",
  "confidence": <0-100>,
  "file_path": "<path>",
  "line_number": <N>,
  "title": "<short title>",
  "description": "<detailed description>"
}]
```

**Stats object** — summary of the discovery run:
```json
{
  "probes_run": <N>,
  "findings_raw": <N>,
  "findings_verified": <N>,
  "false_positives": <N>,
  "by_category": {
    "<category>": {"findings": <N>, "actioned": <N>}
  }
}
```

Present both as structured data in your final output. Do not proceed to Phase 4.

## Phase 4: Interactive Triage (Standalone Mode Only)

### 4.0 Auto-Defer Low-Confidence Findings

Before presenting findings for triage, separate by confidence threshold:

1. Findings with confidence >= threshold → present for interactive triage (below)
2. Findings with confidence < threshold → auto-defer with summary:
   "Auto-deferred [N] low-confidence findings (score < [threshold]). Review with `/discovery --include-deferred`."
3. List auto-deferred findings in a collapsed section (not interactive — informational only)

### 4.1 Present High-Confidence Findings

Present findings using AskUserQuestion -- NEVER plain text options.

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
```

### Step 2: Critical + High Findings -- Review Individually

For each Critical or High finding, use AskUserQuestion:

```
AskUserQuestion({
  questions: [{
    question: "<finding title>\n\n<file_path>:<line_number>\n```\n<matched_text with +/-3 lines context>\n```\n\n<description>\n\nRecommended fix: <recommended_fix>",
    header: "<severity>",
    options: [
      { label: "Create issue (<severity>)", description: "Create a priority:<severity> issue for this finding" },
      { label: "Adjust priority", description: "Create issue with different priority" },
      { label: "Dismiss -- intentional", description: "This is by design, skip" },
      { label: "Dismiss -- false positive", description: "Detection was wrong, skip" }
    ]
  }]
})
```

If user selects "Adjust priority", ask which priority with another AskUserQuestion.

### Step 3: Medium + Low Findings -- Review Batched

Group remaining findings by category. For each category with medium/low findings:

```
AskUserQuestion({
  questions: [{
    question: "[N] medium/low findings in [category]:\n\n1. [title] -- [file_path]:[line] ([severity])\n2. [title] -- [file_path]:[line] ([severity])\n...",
    header: "[Category]",
    options: [
      { label: "Accept all (Recommended)", description: "Create issues for all [N] findings" },
      { label: "Review individually", description: "Walk through each finding one by one" },
      { label: "Dismiss all", description: "Skip all medium/low findings in this category" }
    ]
  }]
})
```

If "Review individually" selected, walk through each like Step 2.

### Step 4: Batch Confirmation

Before creating any issues:

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

## Phase 5: Issue Creation & Report

### 5.1 Issue Creation

> **VCS Reference:** Detect the VCS platform per the "VCS Auto-Detection" section of the gitlab-ops skill.
> Use CLI commands per the "Common CLI Commands" section.

For each approved finding:

1. Format using the Discovery Finding Issue Template from `issue-templates.md`
2. Determine labels: `type:discovery` + `priority:<level>` + `area:<inferred from category/filepath>` + `status:ready`
3. Create issue via VCS CLI:
   - **GitLab**: `glab issue create --title "[Discovery] <title>" --label "type:discovery,priority:<level>,area:<area>,status:ready" --description "<body>"`
   - **GitHub**: `gh issue create --title "[Discovery] <title>" --label "type:discovery,priority:<level>,area:<area>,status:ready" --body "<body>"`
4. Brief pause (1s) between creations for rate limiting

### 5.2 Final Report

```
## Discovery Report

### Summary
- Probes run: [N] across [categories]
- Raw findings: [N]
- Verified: [N] (false positives discarded: [M])
- User approved: [N]
- Issues created: [N]

### Created Issues
| # | Title | Priority | Area | Probe |
|---|-------|----------|------|-------|
| <IID> | <title> | <priority> | <area> | <probe> |

### Dismissed Findings
- [N] dismissed as intentional
- [M] dismissed as false positive

### Recommendations
- [suggestions based on finding patterns]
```

## Critical Rules

- **NEVER** fabricate findings -- every finding must come from tool output with verifiable evidence
- **NEVER** create issues without user approval (standalone mode)
- **ALWAYS** verify findings by re-reading the file at the reported line (Phase 3)
- **ALWAYS** use AskUserQuestion for triage decisions -- never plain text options
- **ALWAYS** reference gitlab-ops for VCS operations -- never duplicate CLI logic inline
- If a probe command fails or tool is unavailable, skip gracefully, continue with others
- If in embedded mode, stop after Phase 3, return findings as structured data
- Respect `discovery-severity-threshold` -- filter before presenting to user
- Default exclude paths always apply: `node_modules/`, `.git/`, `dist/`, `build/`, `.next/`, `.nuxt/`, `coverage/`

## Phase 6: Capture Discovery Stats (Standalone Mode Only)

> This phase runs only in standalone mode. Embedded mode returns findings to the caller.

After Phase 5 (Issue Creation) completes, prepare discovery statistics for session metrics:

1. Count totals from the triage results:
   - `probes_run`: number of probes that were activated and executed
   - `findings_raw`: total findings before verification
   - `findings_verified`: findings that passed Phase 3.2 verification
   - `false_positives`: findings discarded during verification
   - `user_dismissed`: findings the user declined during Phase 4 triage
   - `issues_created`: issues created in Phase 5
   - `by_category`: per-category breakdown of findings and actioned items

2. Report stats summary:
   ```
   Discovery stats: [probes_run] probes, [findings_raw] raw → [findings_verified] verified ([false_positives] false positives). User dismissed [user_dismissed]. Created [issues_created] issues.
   ```

3. These stats are available for session-end to include in `sessions.jsonl` under the `discovery_stats` field. The discovery skill does NOT write to `sessions.jsonl` directly — session-end handles that.

## Anti-Patterns

- **DO NOT** report findings without verifying them first — false positives erode user trust faster than missed issues
- **DO NOT** skip the interactive triage phase — auto-creating issues for unconfirmed findings creates noise
- **DO NOT** run probes outside the configured scope — if the user asked for `code` scope, don't scan infrastructure
- **DO NOT** present findings without evidence (file path, line number, actual content) — assertions without proof are useless
- **DO NOT** write to `sessions.jsonl` directly — session-end handles metrics persistence
