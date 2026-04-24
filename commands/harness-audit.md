---
description: Run the harness audit and report the rubric score for this repository
argument-hint: ""
---

# Harness Audit

The user wants to audit this repository against the session-orchestrator harness rubric. There are no arguments.

Run the audit script and surface the results:

```bash
node scripts/harness-audit.mjs
```

The script writes a concise human-readable summary to stderr and emits a JSON record to stdout. Capture both:

1. Print the stderr summary verbatim so the user sees it immediately.
2. Parse the stdout JSON and report:
   - `summary.overall_band` — `healthy`, `warn`, or `critical`
   - `summary.overall_mean_0_10` — the numeric score
   - Any category with `score_0_10 < 7`, listing its name and score

The full JSON record is also appended automatically to `.orchestrator/metrics/audit.jsonl` by the script — no additional action needed.

If the script exits non-zero, report the error output to the user verbatim. Do not interpret or retry.
