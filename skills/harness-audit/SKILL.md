---
name: harness-audit
description: Run the harness audit and report the rubric score for this repository
user-invocable: true
model: inherit
---
# Harness Audit

> **Plugin root:** `${CLAUDE_PLUGIN_ROOT}`. Claude Code replaces this with the plugin's absolute path when it loads this file. Where it appears unreplaced — in a file this skill reads with the Read tool, or on Codex, Cursor or Pi — the plugin root is the directory that contains this skill's `skills/` folder (two levels above the folder of this SKILL.md). Write that absolute path literally into every command that starts a plugin script: the Bash tool has no plugin variable, and shell variables do not survive between tool calls.

## Invocation

`/harness-audit` takes no arguments — `$ARGUMENTS` is always ignored; anything passed is discarded without a warning. Run the audit exactly as described below and report the rubric score.

The user wants to audit this repository against the session-orchestrator harness rubric. There are no arguments.

Run the audit script and surface the results:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/harness-audit.mjs"
```

The script writes a concise human-readable summary to stderr and emits a JSON record to stdout. Capture both:

1. Print the stderr summary verbatim so the user sees it immediately.
2. Parse the stdout JSON and report:
   - `summary.overall_band` — `healthy`, `warn`, or `critical`
   - `summary.overall_mean_0_10` — the numeric score
   - Any category with `score_0_10 < 7`, listing its name and score

The full JSON record is also appended automatically to `.orchestrator/metrics/audit.jsonl` by the script — no additional action needed.

If the script exits non-zero, report the error output to the user verbatim. Do not interpret or retry.
