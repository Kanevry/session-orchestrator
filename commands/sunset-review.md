---
description: Identify unused / near-zero-use / stale skills, agents, and commands as Demote or Retire candidates (read-only; never deletes)
argument-hint: "[--kind skill|agent|command] [--window-days N]"
---

# Sunset Review

The user wants to identify which skills, agents, and commands in the plugin surface are still in use and which are candidates to demote or retire. Optional arguments narrow the scope: `--kind` limits to one surface kind, `--window-days` overrides the default 90-day dispatch window.

Invoke `skills/sunset-review/SKILL.md` to perform the review.

The skill will:
1. Resolve the dispatch window (default 90 days; honour any `--window-days` override)
2. Run the read-only walker `node scripts/lib/sunset/walker.mjs --json` to combine agent-dispatch telemetry (start-events only) with static reference scanning
3. Classify every surface item into Active / Investigate / Demote / Retire, grouped for review
4. Emit a Markdown report + JSON sidecar at `.orchestrator/metrics/sunset-review-<timestamp>.{md,json}`
5. Record the run time for the quarterly cadence nudge

Critical guardrails:
- The walker is READ-ONLY and NEVER deletes a skill/agent/command. It surfaces candidates for human decision only.
- Telemetry only spans ~18 days, so the 90-day window cannot be satisfied — every Retire verdict is downgraded to Investigate and `meta.lowConfidence` is set. Do not retire anything while low-confidence.
- Draft-issue creation for candidates is a coordinator-side AskUserQuestion decision (AUQ-004) — a dispatched agent cannot file issues itself.

Distinguish from related commands:
- `/repo-audit` — does this repo match the ecosystem baseline? (compliance pass/fail)
- `/sunset-review` — which parts of OUR surface are unused? (prune candidates)
- `/harness-audit` — is session-orchestrator installed correctly? (plugin health)
