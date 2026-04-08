# Session Report Style

Use this format for session-start presentations and session-end summaries.

## Structure

### Session Overview Table

| Field | Value |
|-------|-------|
| Type | `{housekeeping\|feature\|deep}` |
| Repo | `{name}` on `{branch}` |
| Git | {uncommitted} uncommitted, {unpushed} unpushed, {branches} branches |
| GitLab | {open} open issues ({high} high), {mrs} open MRs |
| Health | Tests: {status} \| Validator: {status} \| CI: {status} |

### Findings Section

Use bullet points with status icons:
- Items requiring action
- Observations and context

Status icons: `pass` / `fail` / `warn` / `info` / `skip`

### Recommendations

Present as numbered options with clear rationale:

1. **Option A (recommended):** Description — why this is best
2. **Option B:** Description — trade-offs

### Scope Table (session-end)

| Issue | Status | Summary |
|-------|--------|---------|
| GL#{n} | done/partial/deferred | One-line description |

### Metrics (session-end)

| Metric | Value |
|--------|-------|
| Files changed | {n} |
| Tests | {n} passing |
| Commits | {n} pushed |
| Duration | {estimate} |

## Rules

- Tables over prose — scannable beats readable
- One line per finding — no multi-paragraph explanations
- Link issues as `GL#{n}` — clickable in GitLab context
- Quantify everything — "3 issues" not "several issues"
- Lead with status — good news first, then blockers
