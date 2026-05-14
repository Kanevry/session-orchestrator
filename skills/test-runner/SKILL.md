---
name: test-runner
user-invocable: false
tags: [test, orchestrator, e2e, ux]
model-preference: sonnet
model-preference-codex: gpt-5.4
model-preference-cursor: claude-sonnet-4-6
description: >
  Agentic end-to-end test orchestrator. Resolves target + profile, dispatches
  the right driver(s) (playwright for web today, peekaboo for macOS once
  #381 lands), invokes the ux-evaluator agent (opus, read-only) against
  driver artifacts, reconciles findings with the open issue tracker via
  scripts/lib/test-runner/issue-reconcile.mjs, and writes report.md +
  JSONL roll-up. Wraps upstream tools (no forks). Hard-gates Playwright MCP
  for browser drive (4× token cost vs CLI per Microsoft's own benchmark).
---

# Test Runner Skill

> Project-instruction file resolution: `CLAUDE.md` and `AGENTS.md` (Codex CLI) are transparent aliases — see [skills/_shared/instruction-file-resolution.md](../_shared/instruction-file-resolution.md). Wherever this skill mentions `CLAUDE.md`, the alias rule applies.

## Soul

Before anything else, read and internalize `soul.md` in this skill directory. It defines WHO you are — your role as an orchestrator, your delegation boundaries, and your non-negotiable constraints.

## Phase 0: Bootstrap Gate

Read `skills/_shared/bootstrap-gate.md` and execute the gate check. If GATE_CLOSED, invoke `skills/bootstrap/SKILL.md` and wait for completion. If GATE_OPEN, continue to Phase 1.

<HARD-GATE>
Do NOT proceed past Phase 0 if GATE_CLOSED. There is no bypass. Refer to `skills/_shared/bootstrap-gate.md` for the full HARD-GATE constraints.
</HARD-GATE>

## Phase 1: Read Session Config + Resolve Target / Profile

Read and parse Session Config per `skills/_shared/config-reading.md`. Store result as `$CONFIG`.

Test-runner specific fields (parse these specifically):
- `test-runner.default-profile` (default: `smoke`)
- `test-runner.retention-days` (default: `30`)
- `test-command`, `typecheck-command`, `lint-command` (used for context only — not driven here)

### Target / Profile Resolution

Resolution order (first match wins):

1. **CLI argument** `--target <name> --profile <name>` (explicit, highest priority)
2. **Policy file lookup** — `.orchestrator/policy/test-profiles.json` by target name (if present)
3. **Convention-based detection** (marker files):
   - `playwright.config.{ts,js}` present → target type `web`, dispatch `playwright-driver`
   - `Package.swift` present → target type `mac`, dispatch `peekaboo-driver` (placeholder — #381 not yet shipped)
4. **Fallback** → emit error and halt:
   ```
   Error: Cannot resolve target — provide --target or add .orchestrator/policy/test-profiles.json
   ```

### Run ID

Generate a run ID immediately after target resolution:

```js
import { makeRunId } from 'scripts/lib/test-runner/artifact-paths.mjs';
const runId = makeRunId(); // e.g. "aiat-pmo-module-1715688000123"
```

All artifact paths in subsequent phases derive from this run ID. Never use ad-hoc paths.

### Status Report

After resolution, emit: `Test Runner: target=[name] profile=[name] run_id=[runId] driver=[driver]`

## Phase 2: Driver Dispatch

Determine `${RUN_DIR}` from `artifact-paths.mjs:runDirPath(runId)` before dispatching any driver. All drivers write artifacts under `${RUN_DIR}/`.

For each resolved driver:

### Web (playwright-driver)

Dispatch via Bash per `skills/playwright-driver/SKILL.md`. Pass `${RUN_DIR}` so the driver writes all artifacts (screenshots, AX dumps, HAR) under it.

```bash
# Example invocation shape (exact flags defined by playwright-driver SKILL.md)
node scripts/lib/playwright-driver/runner.mjs \
  --run-dir "${RUN_DIR}" \
  --profile "${PROFILE}" \
  --target "${TARGET}"
```

Capture exit code. A non-zero exit from Playwright means test failures — these become findings for the UX evaluator. They are NOT a fatal error for the orchestrator. Continue to Phase 3 regardless of exit code.

Log: `playwright-driver exited [code] — [N] test files captured under ${RUN_DIR}`

### macOS (peekaboo-driver)

> **Placeholder — #381 not yet shipped.** When this branch is reached, emit:
>
> ```
> peekaboo-driver: not yet available (issue #381). Skipping macOS dispatch.
> ```
>
> Continue to Phase 3. When #381 lands, replace this paragraph with the dispatch contract from `skills/peekaboo-driver/SKILL.md`.

## Phase 3: UX Evaluator Dispatch

Invoke the `ux-evaluator` agent (`agents/ux-evaluator.md`) via the Agent tool. The agent reads driver artifacts under `${RUN_DIR}/` and applies `skills/test-runner/rubric-v1.md` (4 checks). The agent writes `findings.jsonl` directly to `${RUN_DIR}/findings.jsonl` — the coordinator does NOT need to forward findings through prompt context.

```js
Agent({
  description: `UX evaluate run ${runId}`,
  prompt: `<scope: ${RUN_DIR}, rubric: skills/test-runner/rubric-v1.md, output: ${RUN_DIR}/findings.jsonl>`,
  subagent_type: "ux-evaluator",
  run_in_background: false
})
```

`run_in_background: false` is mandatory — Phase 4 depends on `findings.jsonl` being fully written before reconciliation begins.

After the agent completes, verify `${RUN_DIR}/findings.jsonl` exists. If missing, emit a warning and skip Phase 4 (no findings to reconcile).

## Phase 4: Issue Reconciliation

Read `${RUN_DIR}/findings.jsonl`. Use the helpers in `scripts/lib/test-runner/issue-reconcile.mjs` for all glab/gh interactions — never call `glab` or `gh` directly.

### Available Helper Functions (issue-reconcile.mjs)

| Function | Purpose |
|---|---|
| `listExistingFindings({glabPath, project, label, maxBuffer})` | Query the tracker for all open `from:test-runner` issues; returns `{ok, issues[], fingerprints: Set}` |
| `createFinding({glabPath, project, fingerprint, title, body, labels, dryRun, maxBuffer})` | Create a new issue; returns `{ok, action: 'create', iid?, command?}` |
| `updateFinding({glabPath, project, iid, comment, dryRun, maxBuffer})` | Add a comment to an existing issue; returns `{ok, action: 'comment', command?}` |
| `triageDecision(finding, candidates)` | Pure decision: fingerprint-exact → `ignore`; Levenshtein ≤ 2 on title → `update`; else → `create` |
| `reconcileFinding({finding, existingFingerprints, glabPath, dryRun})` | Track-A legacy helper — single-finding create-or-noop using a pre-built fingerprint Set |

Security notes (ADR-364 §C5, #388, #389):
- All execFile calls use `maxBuffer: 4 MB` and `shell: false`.
- Bodies > 65 536 bytes are rejected with `{ok: false, error: {code: 'BODY_TOO_LARGE', ...}}`.
- `**Fingerprint:**` literals in free-text fields are replaced with `__Fingerprint__` before the authoritative sentinel line is appended (sentinel-injection hardening, #388).

### Existing-Fingerprint Dedup

Before iterating findings, build the dedup set once:

```js
import { listExistingFindings } from 'scripts/lib/test-runner/issue-reconcile.mjs';

const listResult = await listExistingFindings({ glabPath });
// listResult.ok === false → log and continue with empty Set (conservative)
const existingFingerprints = listResult.ok ? listResult.fingerprints : new Set();
const existingIssues = listResult.ok ? listResult.issues : [];
```

If the glab query fails, log the error and proceed with an empty fingerprint set (conservative: may create duplicate issues, safer than silently skipping).

### Severity Routing

| Severity | Action |
|----------|--------|
| `critical` | Auto-create issue — no AUQ. Label: `from:test-runner,priority:critical` |
| `high` | Auto-create issue — no AUQ. Label: `from:test-runner,priority:high` |
| `medium` | Batched AUQ triage (see below) |
| `low` | Batched AUQ triage (see below) |

For `critical` and `high`, call `triageDecision(finding, existingIssues)` first. If `action === 'ignore'`, skip. If `action === 'update'`, call `updateFinding()`. If `action === 'create'`, call `createFinding()`.

### Batched AUQ Triage (medium / low)

Group `medium` and `low` findings and present via a single `AskUserQuestion` call (mirror the discovery skill's Phase 5 Step 3 pattern):

```js
AskUserQuestion({
  questions: [{
    question: `<N> medium/low findings to triage. How to handle?`,
    header: "Test-runner triage",
    options: [
      {
        label: "Create all (Recommended)",
        description: "File <N> new issues, all with label from:test-runner"
      },
      {
        label: "Review each",
        description: "Walk through findings individually with create/update/ignore"
      },
      {
        label: "Skip all",
        description: "Dismiss medium/low; only critical/high get auto-filed"
      }
    ],
    multiSelect: false
  }]
})
```

**"Create all"**: For each medium/low finding call `triageDecision(finding, existingIssues)`:
- `ignore` → skip silently.
- `update` → call `updateFinding({iid: target, comment, ...})`.
- `create` → call `createFinding({fingerprint, title, body, labels, ...})`.

**"Review each"**: Walk through findings one by one. For each, call `triageDecision` to get the recommended action, then present a per-finding AUQ with three options (Create / Update existing `#<iid>` / Skip). Honour the user's selection.

**"Skip all"**: Dismiss all medium/low findings without filing. Log `skipped: N medium/low findings (user dismissed)`.

### Reconcile Outcomes

Collect outcomes from reconciliation calls into three buckets:
- `created[]` — issue IIDs of newly created issues
- `commented[]` — issue IIDs of existing issues that received a new comment
- `noop[]` — fingerprints/IIDs where no action was taken (dedup hit or user dismissed)

Pass these buckets to Phase 5.

## Phase 5: Report + JSONL Roll-up

### report.md

Write `${RUN_DIR}/report.md` — a markdown summary of the run. Minimum content:

```markdown
# Test Run Report

**Run ID:** <runId>
**Target:** <target>
**Profile:** <profile>
**Timestamp:** <ISO 8601>
**Duration:** <ms>ms

## Findings Summary

| Severity | Count |
|----------|-------|
| critical | N |
| high | N |
| medium | N |
| low | N |

## Check Breakdown

| Check | Findings |
|-------|---------|
| <check_name> | N |

## Issue Actions

- **Created:** <IIDs>
- **Commented:** <IIDs>
- **No-op (dedup):** <IIDs>

## Driver Exit Codes

| Driver | Exit Code |
|--------|-----------|
| playwright | N |
```

### JSONL Roll-up

Append one record to `.orchestrator/metrics/test-runs.jsonl` (path from `artifact-paths.mjs:jsonlRollupPath()`) via `appendJsonlAtomic` from `scripts/lib/autopilot/telemetry.mjs`. Never use `appendFileSync` — POSIX-atomic guarantee is required (per #376).

Schema v1:

```json
{
  "schema_version": 1,
  "run_id": "aiat-pmo-module-1715688000123",
  "timestamp": "2026-05-14T07:30:00Z",
  "target": "aiat-pmo-module",
  "profile": "smoke",
  "drivers": ["playwright"],
  "finding_counts": {"critical": 0, "high": 2, "medium": 5, "low": 3},
  "issues": {"created": [388, 389], "commented": [], "noop": [380]},
  "exit_code": 0,
  "duration_ms": 12345
}
```

`exit_code` is the orchestrator's own exit code: `0` if no critical/high findings auto-created, `1` otherwise.

### Final Status Line

Emit to stdout:

```
Test Runner complete: run_id=<runId> findings=[total] issues_created=[N] duration=[ms]ms
```

## Anti-Patterns

- **DO NOT** invoke Playwright or Peekaboo directly from the coordinator prompt — always dispatch via the wrapper skills (`skills/playwright-driver/SKILL.md`, future `skills/peekaboo-driver/SKILL.md`).
- **DO NOT** inline AX-tree dumps or screenshots into coordinator or agent prompt context — artifacts go to disk under `${RUN_DIR}`.
- **DO NOT** re-file existing findings — fingerprint-based dedup via `issue-reconcile.mjs` is mandatory every run.
- **DO NOT** use `@playwright/mcp` for browser drive — R5 hard-gate enforced by `scripts/lib/test-runner/check-playwright-mcp-canary.mjs` (4× token cost per Microsoft benchmark).
- **DO NOT** call `glab` or `gh` directly — always go through `scripts/lib/test-runner/issue-reconcile.mjs` (execFile + binary allowlist + arg-validation, per ADR-364 §C5).
- **DO NOT** write JSONL via `appendFileSync` — use `appendJsonlAtomic` from `scripts/lib/autopilot/telemetry.mjs`.

## Critical Rules

- **NEVER** auto-merge MRs created by issue-reconcile.
- **NEVER** persist artifacts outside `${RUN_DIR}` — it is the single source of truth for a run.
- **NEVER** call `glab`/`gh` directly — always route through `issue-reconcile.mjs`.
- **ALWAYS** use the orchestrator's run-id everywhere (from `artifact-paths.mjs:makeRunId()`).
- **ALWAYS** invoke `appendJsonlAtomic` for JSONL roll-up — never `appendFileSync` (POSIX-atomic guarantee, per #376).
- **ALWAYS** set `run_in_background: false` for the `ux-evaluator` agent dispatch — Phase 4 depends on its output.

## Sub-File Reference

| File | Purpose |
|------|---------|
| `soul.md` | Orchestrator identity — read before Phase 0 |
| `rubric-v1.md` | UX rubric specification (4 checks, fingerprint formula, findings JSON schema) — read by `ux-evaluator` agent |

## Implementation Modules

| File | Purpose |
|------|---------|
| `scripts/lib/test-runner/fingerprint.mjs` | Stable 16-hex fingerprint per finding (deterministic, idempotent) |
| `scripts/lib/test-runner/artifact-paths.mjs` | Run-dir + artifact path builders — pure functions, no side effects |
| `scripts/lib/test-runner/issue-reconcile.mjs` | glab/gh dispatch via execFile + binary allowlist (ADR-364 §C5) |
