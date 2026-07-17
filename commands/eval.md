---
description: Run an honest session-process evaluation (Standard v1, aiat-llm-eval/1.0) — score the last completed session against the pre-registered rubric-v1 dimensions
argument-hint: "[--session <id>] [--no-write] [--verify <run-id>]"
---

# Eval

The user wants to run a session-process evaluation. Invoke the eval skill with arguments: **$ARGUMENTS**.

Scores ONE completed orchestrator session against the pre-registered **rubric-v1**
check set via the deterministic engine (`scripts/eval-session.mjs`), appends a
`session-eval` record to the journal (`.orchestrator/metrics/eval.jsonl`), and —
when configured — renders an HTML report and overlays an advisory LLM judge.
Deterministic-first; **no global score, by construction**; missing data yields an
honest `cannot-determine` rather than a guess.

**Usage:**

- `/eval` — evaluate the last completed session (resolution cascade), append the record, render the report
- `/eval --session <id>` — evaluate a specific session_id
- `/eval --no-write` — evaluate + report without appending to the journal (dry-run)
- `/eval --verify <run-id>` — re-score a stored run and diff for drift (the reproducibility proof; exit 1 on drift)

**Seams used:** `scripts/eval-session.mjs` (deterministic CLI) · `runEvalJudge` / `mergeJudgeDimensions` (judge.mjs, opt-in) · `writeEvalReport` (report.mjs) · `appendEvalRecord` (sink.mjs) · `eval` config block · `skills/eval/rubric-v1.md` (frozen check set)

Reads the `eval` block (`enabled`, `mode`, `judge`, `report`, `handle`) from
Session Config. On-demand `/eval` runs regardless of `eval.enabled` — that flag
gates only the automatic session-end eval phase.
