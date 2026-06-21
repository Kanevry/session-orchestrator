---
description: Reconcile learnings into .claude/rules/ proposals — on-demand version of session-end Phase 3.6.8
argument-hint: "[--dry-run]"
---

# Reconcile

The user wants to reconcile learnings into rule proposals. Invoke the reconcile skill with arguments: **$ARGUMENTS**.

Runs the same pipeline as session-end Phase 3.6.8: filters eligible learnings from
`.orchestrator/metrics/learnings.jsonl`, renders proposed `.claude/rules/<slug>.md` entries,
and presents them to the operator via AUQ multiSelect (batches of 4) for approval before
writing. Advisory-only — no rule is ever written without explicit operator confirmation.

**Usage:**

- `/reconcile` — full approval flow: engine → AUQ → write approved rules
- `/reconcile --dry-run` — print proposals and rejections without writing anything or rendering the AUQ prompt

**Engine seams used:** `runReconcile` (engine.mjs) · `writeApprovedRules` (writer.mjs) · `reconcile` config block · `.claude/rules/` write target

Reads `reconcile.rule-expiry-days` and `reconcile.confidence-floor` from Session Config.
The `reconcile.enabled` flag is NOT checked — this command always runs on-demand.
