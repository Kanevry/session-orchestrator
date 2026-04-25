# Session Orchestrator Plugin

Claude Code plugin for session-level orchestration. This is a **plugin repo** — not an application.

> **Für Installation, CLI-Nutzung und Kommando-Referenz:** Siehe [`README.md`](./README.md).

## Structure

- `skills/` — 19 skills (bootstrap, session-start, session-plan, wave-executor, session-end, claude-md-drift-check, ecosystem-health, gitlab-ops, quality-gates, discovery, plan, evolve, vault-sync, vault-mirror, daily, docs-orchestrator, skill-creator, mcp-builder, hook-development)
- `commands/` — 8 commands (/session, /go, /close, /discovery, /plan, /evolve, /bootstrap, /harness-audit)
- `agents/` — 7 agents (code-implementer, test-writer, ui-developer, db-specialist, security-reviewer, session-reviewer, docs-writer)
- `hooks/` — 6 event matchers covering 7 hook handlers: SessionStart (banner + init), PreToolUse/Edit|Write (scope enforcement), PreToolUse/Bash (destructive-command guard + enforce-commands), PostToolUse (edit validation), Stop (session events), SubagentStop (agent events)
- `.orchestrator/policy/` — runtime policy files (e.g. `blocked-commands.json`, 13 rules for destructive-command guard)
- `.claude/rules/` — always-on contributor rules (e.g. `parallel-sessions.md`)

## Development

Edit skills directly. Test by running `/session feature` in any project repo.

Skills are loaded by Claude Code from the plugin directory — no build step needed.

## Destructive-Command Guard

`hooks/pre-bash-destructive-guard.mjs` blocks destructive shell commands in the main session (alongside subagent waves). Policy lives in `.orchestrator/policy/blocked-commands.json` (13 rules). Bypass per-session via Session Config:

```yaml
allow-destructive-ops: true
```

Rule source of truth: `.claude/rules/parallel-sessions.md` (PSA-003). See issue #155.

## Rules

- `.claude/rules/parallel-sessions.md` — PSA-001/002/003/004 parallel-session discipline. Vendored to all consumer repos via bootstrap (issue #155).

## Key Conventions

- Skills use Markdown with YAML frontmatter
- Commands use `$ARGUMENTS` for user input
- Agent definitions need `<example>` blocks in description
- Hooks use the Claude Code hooks.json format

## Agent Authoring Rules

Agent files live in `agents/` as Markdown with YAML frontmatter. Required fields:

```yaml
---
name: kebab-case-name          # 3-50 chars, lowercase + hyphens only
description: Use this agent when [conditions]. <example>Context: ... user: "..." assistant: "..." <commentary>Why this agent is appropriate</commentary></example>
model: inherit                 # inherit | sonnet | opus | haiku
color: blue                    # blue | cyan | green | yellow | magenta | red
tools: Read, Grep, Glob, Bash  # COMMA-SEPARATED STRING, not JSON array!
---
```

**Critical pitfalls** (cause "agents: Invalid input" validation failure):
- `tools` MUST be a comma-separated string (`Read, Edit, Write`), NOT a JSON array (`["Read", "Edit"]`)
- `description` MUST be a single-line inline string, NOT a YAML block scalar (`>` or `|`). Put `<example>` blocks inline.
- All 4 fields (name, description, model, color) are required. `tools` is optional.

Reference: https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/agent-development/SKILL.md

## v3.0 Migration

Bash → Node.js migration for native Windows support. Epic #124 complete:
foundation (#125–#130, #132), hooks (#137–#142), tests (#143–#145), and legacy
cleanup (#151). Legacy `.sh` scripts under `hooks/`, `scripts/lib/` (except
`common.sh`, retained for install tooling), and `scripts/test/` have been
removed. Entry point is `scripts/parse-config.mjs`.

Development prerequisite: **Node 20+**. Run `npm ci` after cloning. Test with
`npm test` (vitest). Lint: `npm run lint`.

## v3.1.0 Release — Environment-Aware Sessions (Epic #157)

Shipped 2026-04-24 via cascade-merge of !15/!10/!12 into !9 → main. Four sub-epics:

- **Sub-Epic A+B — Host-Identity + Pre-Session Resource Gate (#158)**: `scripts/lib/host-identity.mjs` (device fingerprint + SSH detection, #162), `scripts/lib/resource-probe.mjs` (live RAM/CPU/process snapshot + `evaluate()` verdict, #163), `hooks/on-session-start.mjs` host+resource banner + `peer_count` event payload (#164), `skills/session-start` Phase 4.5 adaptive wave sizing (#165), new `resource-awareness` / `enable-host-banner` / `resource-thresholds` Session Config block (#166).
- **Sub-Epic B — Pre-Dispatch Resource Gate (#192 #193)**: `scripts/lib/wave-resource-gate.mjs` 8-rule decision chain (`proceed`/`reduce`/`coordinator-direct`); probe failure + missing thresholds degrade to `proceed` so the gate never blocks. New `worktree-exclude` Session Config field plus `applyWorktreeExcludes` post-`git worktree add` helper (default: node_modules, dist, build, .next, .nuxt, coverage, .cache, .turbo, .vercel, out).
- **Sub-Epic C+E — Hardware-Pattern Learnings + Privacy Tiers (#170 #171 #172)**: `scripts/lib/learnings.mjs` `scope: local | private | public` + `host_class` + `anonymized` schema. Privacy validator enforces `{scope:'public', anonymized:false}` throws. `scripts/lib/hardware-pattern-detector.mjs` 5 detection signals (oom-kill, heartbeat-gap, concurrent-session-pressure, disk-full, thermal-throttle) + `/evolve` type 7 handler. `scripts/export-hw-learnings.mjs --promote` CLI (anonymize → set `scope:public`/`anonymized:true` → validate → rewrite with `.bak-<ISO>`). Anonymization: macOS+Linux system paths (incl. `/root`, `/var`, `/opt`, `/tmp`, `/mnt`, `/srv`), Windows paths (forward + back slash), IPv4, GitHub/GitLab URLs.
- **Sub-Epic F — Multi-Session Registry + Heartbeat (#167 #168 #169)**: `scripts/lib/session-registry.mjs` (atomic writes via temp+rename, sha256 repo-path hash, configurable `registryBaseDir`, zombie sweep with threshold), `hooks/on-session-start.mjs` register-self + detect-peers + sweep with peer banner, `hooks/on-stop.mjs` idempotent deregister. Both hooks now emit `register-failed`/`deregister-failed` breadcrumbs to `sweep.log` via `logSweepEvent` helper (silent-failure observability). Default registry: `~/.config/session-orchestrator/sessions/active/`, overridable via `SO_SESSION_REGISTRY_DIR`.
- **CI flake remediation (#268)**: Root cause was vitest 2.1.9 + tinypool worker exit-hang AFTER all tests pass. Remediated in `.gitlab-ci.yml` via bounded `timeout --preserve-status` + per-file `✓`/`✗` marker count (decouples CI green signal from vitest exit sequence). Also added `vitest.config.mjs` hardening: `pool: 'forks'`, `teardownTimeout: 15000`, `hookTimeout: 30000`, `include` narrowed to `['tests/**/*.test.mjs']` (excludes `skills/vault-sync/tests/schema-drift.test.mjs` which runs standalone in the `schema-drift-check` CI stage).

## Meta-Audit #265 Sweep — Telemetry-JSONL Cluster (2026-04-24)

Second meta-audit pass shipped alongside v3.1.0. Closes 1 CRIT + 2 HIGH from Epic #265 plus 3 MED checklist items:

- **events.jsonl rotation (#251, CRIT)**: New `scripts/lib/events-rotation.mjs` — size-based rotation (default 10 MB, configurable 1..1024), backup-shift-and-drop (default 5 backups, configurable 1..20), POSIX-atomic rename, never-throws contract. Triggered once per session from `hooks/on-session-start.mjs` (post-emitEvent, try/caught so rotation failure never blocks session-start). Per-append rotation explicitly rejected design — session-start trigger is predictable and low-frequency. Session Config block: `events-rotation: { enabled, max-size-mb, max-backups }`.
- **agent-mapping validation (#255, HIGH)**: `scripts/lib/config.mjs` `agent-mapping` parse now throws on invalid role keys (outside `['impl', 'test', 'db', 'ui', 'security', 'compliance', 'docs', 'perf']`) or empty/non-string values. Plain-JS validator matches repo convention (no Zod). Fix-forward after review: `_coerceObject` changed from `if (k && v)` to `if (k)` so empty values reach the validator instead of being silently filtered.
- **discovery-parallelism configurable (#259, HIGH)**: New integer Session Config field `discovery-parallelism` (default 5, bounds 1..16, silent-fallback on out-of-range). `skills/discovery/SKILL.md:91` now references `$CONFIG['discovery-parallelism']` instead of hardcoded 5.
- **learnings schema versioning (M7)**: `scripts/lib/learnings.mjs` introduces `CURRENT_SCHEMA_VERSION = 1`. New records auto-stamped with `schema_version: 1`. `validateLearning` accepts v0 (legacy, missing field) and v1. `normalizeLearning` tags untagged records as v0 with a **deduplicated** `console.error` WARN (module-level `Set` keyed on record id — warns at most once per unique id per process, preventing log spam on large files).
- **learnings.jsonl data cleanup (M1)**: 6 records missing `expires_at` (lines 69, 81–85) patched with `created_at + 30d` ISO 8601. Atomic write via tmp + rename. Original backed up to `.bak-<ISO>`. Restores harness-audit score from 9.4 → 10.
- **session-end single-pass read (M9)**: `skills/session-end/metrics-collection.md` Phase 1.7 now reads `events.jsonl` exactly once via `jq -s` partition into stagnation + grounding arrays (was: two separate reads). Per-field `total == 0` omission rules preserved.

## Producer Schema Lock — #249 Follow-ups (2026-04-24)

Follow-up work for issue #249 (vault-mirror dual-schema post-mortem) — closes the "producer-side schema chaos" flagged by the post-mortem. Locks down the session-JSONL writer path and provides tooling for legacy data cleanup. Three modules shipped:

- **`scripts/lib/session-schema.mjs` (new)**: Plain-JS validator + normalizer mirroring `scripts/lib/learnings.mjs` (same repo precedent from M7). Exports `CURRENT_SESSION_SCHEMA_VERSION = 1`, `SESSION_KEY_ALIASES` (11 safe renames), `ValidationError` class, `validateSession()` (throws on write-side contract violations), `normalizeSession()` (never-throws read-side with deduplicated `[sessions] WARN:` per session_id via module-level Set). Asymmetric v0/v1 semantics: writes stamp `schema_version: 1`; reads tag pre-versioning entries as `schema_version: 0`. 41 unit tests.
- **`scripts/emit-session.mjs` (new)**: Validating CLI writer. Replaces the shell `>>` append previously in `skills/session-end/session-metrics-write.md` Phase 3.7. Reads entry JSON (stdin or `--entry`), calls `validateSession`, then `appendJsonl` via `scripts/lib/common.mjs`. Exit codes: 0 (appended), 1 (validation), 2 (I/O/parse). session-end Phase 3.7 now shells to the wrapper and blocks close on any non-zero. 12 CLI tests via `spawnSync`.
- **`scripts/backfill-sessions.mjs` (new)**: Legacy-data repair CLI. Modes: `--dry-run` (default), `--apply` (atomic rewrite via copy-to-backup-first + tmp → rename-over-canonical — eliminates the crash window where canonical could be briefly missing), `--mark-deprecated-only` (conservative — tags only unmappable entries). Safe-alias path runs `normalizeSession`; value-transforming aliases (`duration_min × 60 → duration_seconds`, `agents_complete/partial/failed → agent_summary` reconstruction with `spiral: 0` fallback) live inline. Structurally unmappable shapes (`waves: null`, `waves: <number>`, `waves_executed` scalar, `metrics`-bag variant) preserved with `_deprecated: true` + `_deprecation_reason: 'structural: <shape>'`. Dry-run on live `.orchestrator/metrics/sessions.jsonl`: 49 entries → 0 unchanged / 39 rewritten / 10 deprecated / 0 parse-errors. 19 CLI tests including idempotence + atomic-replace canonical-preservation regression.
- **`scripts/vault-mirror.mjs --strict-schema` flag**: Opt-in CI gate that tracks `skipped-invalid` count across learning/session runs. When flag is set and count > 0, emits `{"action":"strict-schema-abort","skipped":N,"kind":"..."}` on stdout and exits 1. Default (lenient) behavior unchanged. 3 regression tests (abort path, clean-pass no-op, default-lenient).
- **session-end Phase 3.7 write path**: `skills/session-end/session-metrics-write.md` Phase 3.7 now calls `node $PLUGIN_ROOT/scripts/emit-session.mjs` instead of raw shell `>>` append. Captures `$EMIT_EXIT`; blocks close on both exit 1 (validation) and exit ≠ 0 (I/O). Post-write `tail -1 | jq .` sanity check retained.
- **Follow-up review fix-forward (coordinator-direct W5)**: session-reviewer flagged 2 high-confidence WARN items, both mechanical. Fixed inline: (1) `_deprecation_reason` added to structural-unmappable branch (was only set in post-transform-validation-failure branch); (2) backfill atomic-rename dance refactored — pre-copy backup THEN tmp → rename-over-canonical (POSIX atomic) instead of the 3-step rename dance. +2 regression tests.

Total: 6 new/changed files + 1 skill update. 75 new tests (1514 → 1589 green, 10 skipped). Backfill tool ready for operator-supervised live-data apply during quiet time (deferred this session due to 7 concurrent Claude processes / PSA-001 race risk).

## Vitest 4 Upgrade + GH Actions CI Repair (2026-04-24)

Closes #282 (vitest 2.1.9 → 4.1.5) + #280 (GH Actions mirror red for 8 consecutive runs) + #224 (dupe of #282). Shipped in 3 commits across one feature session (coordinator-direct, RAM 1.6 GB resource gate):

- **`07d3a75` — vitest 4.1.5 bump**: `@vitest/coverage-v8` + `vitest` pinned to `^4.1.5`. Zero config changes required — every key in `vitest.config.mjs` (`pool: 'forks'`, `testTimeout`, `teardownTimeout`, `hookTimeout`, `coverage.{provider,reporter,include,exclude,thresholds}`) is stable across v2 → v4. Removed options (`coverage.all`, `coverage.extensions`, `poolOptions.{isolate,maxWorkers,vmMemoryLimit}`) were not in use. `pool: 'forks'` is now the v4 default — kept explicit for clarity. Side-effect: `npm audit` moderate count 6 → 0.
- **`eb1a24c` — #280 Windows portability regressions**: GH Actions had 10 Windows failures across 3 files, root cause was NOT tinypool. Three test-side/workflow fixes:
  1. `.github/workflows/test.yml` — git-identity `git config --global user.name/email` was gated on `runner.os != 'Windows'`. Every subprocess-spawned `git` on Windows failed with "Author identity unknown" → 8× `multi-session-registry.test.mjs` failures. Split the step so diagnostics stay Unix-only but git identity runs on all platforms.
  2. `tests/lib/events-default-url.test.mjs` — path-separator regex assertion compared raw fs paths (`D:\a\...\scripts\lib\events.mjs`) against `/scripts\/lib\/events\.mjs$/`. Normalize via `replaceAll(path.sep, '/')` before matching (precedent from #216).
  3. `tests/lib/hardening.test.mjs` — `assertDepInstalled('vitest')` returned `false` on Windows with v4. v4's dynamic-import path triggers module-evaluator worker side-effects that can fail when invoked from inside a vitest worker. Switched the dep to `prettier` (pure ESM, no complex loader state).
- **`042be0a` — #280 Ubuntu wrapper port**: vitest 4 does NOT eliminate the tinypool exit-hang on Linux CI — Ubuntu hung at teardown for 15 min after all tests passed on the `eb1a24c` run, hitting `timeout-minutes: 15`. Ported the GitLab CI remediation (timeout-bounded run + per-file `✓`/`✗` marker count, decouples green signal from vitest exit sequence) into `.github/workflows/test.yml` as two conditional steps: `Vitest (Linux — wrapped)` for Ubuntu, `Vitest (macOS + Windows — plain)` for the others that do NOT hang. Coverage step (Linux-only) gets the same 420s wrapper.

End-state per mirror on `042be0a`:
- **GitLab CI** (Linux only, `pipeline #3308`): ✓ green — existing wrapper still active, belt-and-suspenders.
- **GH Actions** (ubuntu + macOS + windows matrix): ubuntu ✓, windows ✓, macOS ✗ blocked by pre-existing #222 (`harness-audit.integration` stdout JSON truncation at 8188 bytes) — explicitly out of this session's scope.

Local suite remained stable: 1589 tests passing / 10 skipped / 7.01s on M4 Pro across both the bump and the portability fix. Coverage thresholds intact (73.6% / 65.8% / 76.2% / 71.5%).

## Meta-Audit Follow-ups #281 + #270 (2026-04-24)

Small feature session closing two audit-flagged bugs under critical RAM (coordinator-direct, 5 waves, ~40 min):

- **#281 — learnings.jsonl required-key drift**: Repaired 18 legacy records in `.orchestrator/metrics/learnings.jsonl` (5 from the audit probe's `type,subject,confidence` check + 13 also missing `insight`/`evidence`/`source_session`/`expires_at`). Repair derives `subject` from `id` (first-2-tokens + rest split by space), `insight` from `content` or `subject`, `source_session` from `evidence[0]` prefix "session ", `expires_at` from `created_at + 30d`. Atomic tmp+rename, `.bak-<ISO>` preserved. Added reader-side dedupe'd WARN in `scripts/lib/learnings.mjs` `normalizeLearning()` — keyed `<id>|<sorted-missing-fields>` so shape-shifts on the same id still warn but repeated reads stay silent. Mirrors the existing `_warnedMissingSchemaVersion` pattern at L163. Audit probe check `learnings-jsonl-nonempty` now 0/93 missing (was 5/88). 12 residual records still fail the stricter 9-field `LEGACY_REQUIRED_FIELDS` contract (missing `id` or using alt `text`/`session_id` schema) — visible via reader WARN, out of this session's scope.
- **#270 — validate-wave-scope v3.0 residue**: Ported `scripts/validate-wave-scope.sh` → `scripts/validate-wave-scope.mjs` (plain node, zero shell deps, same CLI contract: stdin OR `<path>`, exit 0 on valid with stdout echo, exit 1 on invalid with stderr ERROR lines). Closes the v3.0 Bash→Node migration straggler — the legacy `.sh` sourced `scripts/lib/common.sh:5` which tried to `source platform.sh` (removed in commit d41e00e), silently exiting 1 under `set -euo pipefail`. `skills/wave-executor/wave-loop.md:529` now invokes `node`; docs refs updated in `CONTRIBUTING.md:483` + `docs/USER-GUIDE.md:721`; `.sh` deleted.
- **Tests (+21)**: 5 new in `tests/lib/learnings.test.mjs` for the required-key WARN (emits, dedupes, distinct-WARN on shape-shift, no-WARN on complete record, `<unknown>` id path). 16 new in `tests/scripts/validate-wave-scope.test.mjs` — stdin + file input, 6 contract checks (wave positive integer, role non-empty string, enforcement enum, allowedPaths array, blockedCommands array, gates object), 3 security checks (absolute path, path traversal, non-string entries), invalid JSON, file-not-found. 1611 passed / 10 skipped (was 1589). Full Gate green: typecheck 37 OK, lint clean, coverage 73.67 / 65.96 / 76.30 / 71.54.
- **Dupe cleanup**: #225 closed as duplicate of #285 (same file `scripts/lib/harness-audit/categories.mjs`, same 956-line snapshot). #226 closed as duplicate of #284 (same file `scripts/lib/config.mjs`; newer #284 at 1075L is the current source of truth).

## v3.2 Autopilot Phase A — STATE.md Recommendations-Contract (2026-04-24)

First Phase A slice of Epic #271 (v3.2 Autopilot). Four issues shipped end-to-end in a single deep session (coordinator-direct throughout due to critical RAM 0.2 GB + 6 concurrent Claude procs — 6th-consecutive coordinator-direct session). Additive contract under `schema-version: 1` — zero breaking changes for pre-v1.1 STATE.md files.

- **#272 — Parser + v0-Heuristik:** `scripts/lib/state-md.mjs` gains `parseRecommendations(frontmatter)` (null on pre-v1.1, otherwise 5-field object with per-field type-coercion to null on mismatch) and `updateFrontmatterFields(contents, fields)` (additive; `null`/`undefined` value deletes the key). `parseScalar` extended to parse floats (`/^-?\d+\.\d+$/`) — needed for `carryover-ratio` / `completion-rate`. New `scripts/lib/recommendations-v0.mjs` exports `computeV0Recommendation` (3-branch deterministic: `<0.5 → plan-retro`, `≥0.3 carryover → deep`, else `feature`) + `isValidMode` (6-mode enum).
- **#273 — session-end Writer (Phase 3.7a):** `skills/session-end/SKILL.md` gains `### 3.7a Compute and Write Recommendations` between 3.7 and 3.4. Runtime order is now `3.7 → 3.7a → 3.4` (explicit Runtime Ordering Note in 3.4 defers `status: completed` to LAST in Phase 3). Reads in-memory metrics (NOT just-written sessions.jsonl) to avoid read-after-write hazards. Defensive try/catch → `recommendation-compute-failed` sweep.log event + field omission, but Phase 3.4 still proceeds. session-end is **sole writer** of the 5 fields.
- **#274 — session-start Reader (Phase 1.5):** New `### Recommendations Banner (Epic #271 Phase A)` subsection renders on `status: completed` branch only, BEFORE Idle Reset archives the fields. Pure observer — does not mutate STATE.md. Banner shape: `📋 Previous session recommended: <mode> — <rationale> (completion: XX%, carryover: XX%)` + optional `Suggested issues:` line. Graceful degradation: partial fields → WARN `state-md-partial-recommendation` + render with `—` for missing numerics; `top-priorities` type-mismatch → WARN `state-md-type-mismatch` + field null; unknown mode → `(unknown-mode)` display; pre-v1.1 → silent no-op. Idle Reset rule 6 added: archives 5 fields into `## Previous Session` body block as readable markdown (not YAML), deletes from frontmatter via null-value semantics. New "STATE.md Schema §Recommendations (v1.1)" section in `docs/session-config-reference.md` — fields table, example frontmatter, v0 heuristic, backward-compat, reader behavior matrix, consumer cross-ref.
- **#275 — Vault-Mirror:** PRD (`docs/prd/2026-04-24-state-md-recommendations-contract.md`, new) authored + mirrored to `vault/01-projects/session-orchestrator/prd/` with Obsidian-compatible frontmatter. Schema violation caught inline: initial `type: prd` + `status: shipped` rejected by vault schema enum → adjusted to `type: reference` + `status: verified` + `type/prd` tag. vault `context.md` gains v3.2 Autopilot decision line under "Key Decisions". AC3 validation: 0 errors in session-orchestrator paths. AC4 sessions.jsonl mirror explicit-check: STATE.md fields not mirrored to vault (only sessions.jsonl + learnings.jsonl are), no breakage.
- **Tests (+24):** `tests/lib/state-md.test.mjs` +8 (recommendations v1.1 describe block). `tests/lib/recommendations-v0.test.mjs` +11 (rule branches + boundaries + `isValidMode`). `tests/integration/state-md-handoff.test.mjs` +5 (Writer AC1/AC2/AC3 + follow-on + additive preserve). Full Gate green: typecheck 38 OK (+1 new module), lint clean, **1637/10 tests**, coverage **71.8/66.51/76.71/73.91** — all above thresholds (70/65/70/60). `recommendations-v0.mjs` lands at 100/94.7/100/100; `state-md.mjs` lifted to 87.83/84.96/100/92.05.

Forward path: Phase B (#276 Mode-Selector Skill, appetite:2w, own PRD) consumes these 5 fields — the contract is stable, only the heuristic gets swapped. Phase C (#277 `/autopilot` Loop Command, appetite:6w, own PRD) chains Phase B into an autonomous session-start → session-plan → wave-executor → session-end loop with SPIRAL/FAILED/carryover-50% kill-switches.

## v3.2 Autopilot Phase B — Mode-Selector Scaffold (2026-04-24)

Second Phase of Epic #271 (v3.2 Autopilot). Scaffold-only slice (#276) consumed immediately after Phase A ship: PRD + pure-function library + doc-only skill, no session-start wiring yet. Ships the contract surface so Phase B-1 (heuristic) and Phase C (autopilot) can integrate incrementally.

- **PRD (`docs/prd/2026-04-25-mode-selector.md`, new)**: 8-section document mirroring Phase A structure. Covers problem (session-start has no centralized mode-selector — v0 is a single frontmatter field, not a reusable skill), explicit non-goals (no learnings consumption, no backlog scan, no session-start wiring — all filed as Phase B-N follow-ups), typed `signals` input (10 fields, 5 from Phase A + 5 reserved), `Recommendation` output contract (mode enum, rationale ≤120 chars, confidence 0.0–1.0, alternatives array), v0 scaffold heuristic (passthrough of Phase A `recommended-mode` at confidence 0.5, else fallback 'feature' at 0.0), ownership matrix (selectMode pure; session-start + /autopilot are consumers; learnings.jsonl reserved as future read-only input), 5 Q-decisions.
- **`scripts/lib/mode-selector.mjs` (new)**: Pure function `selectMode(signals) → {mode, rationale, confidence, alternatives}`. Imports `isValidMode` from `recommendations-v0.mjs` — mode enum stays in one place. Zero I/O, zero throws, every return has all 4 keys, `alternatives` is always an array (never null). Three branches: null/undefined signals → fallback 0.0; valid `recommendedMode` → passthrough 0.5; invalid/missing → fallback 0.0. ~60 lines incl. JSDoc typedefs.
- **`skills/mode-selector/SKILL.md` (new)**: 164-line doc-only skill file with YAML frontmatter (`user-invocable: false`, tags: phase-b/autopilot/mode-selection/scaffold). Body sections: Status, Purpose, Contract (input + output), Invocation Points (current: none wired; future: session-start Phase 1.5 banner + /autopilot threshold execution), v0 Heuristic pseudocode, Fallback Behavior (confidence thresholds 0.0/0.5/0.85), Integration cross-refs to state-md/learnings/session-schema/bootstrap-lock-freshness/gitlab-ops, Critical Rules (pure function, never writes STATE.md, all 4 keys always), Anti-Patterns, Open Questions for Phase B-1.
- **Tests**: `tests/lib/mode-selector.test.mjs` added covering fallback paths (null/undefined/empty-object/non-string/unknown-mode all → 'feature' 0.0), passthrough path parametrized across all 6 valid modes at 0.5, shape contract (exact 4 keys, alternatives array, rationale ≤120 chars), reserved-fields-ignored contract.
- **Follow-up sub-issues filed at /close**: Phase B-1 (full heuristic — rule-set consuming learnings + sessions trend + backlog priority + bootstrap tier), Phase B-2 (session-start integration — render banner, pre-select first AUQ option), Phase B-3 (VCS backlog scan signal source), Phase B-4 (learnings feedback loop — `mode-selector-accuracy` learning written after user confirm/override).

Forward path: Phase B-1 fills the heuristic inside `selectMode` — callers and contract remain stable. Phase C (/autopilot Loop Command, #277) chains Mode-Selector → session-start → session-plan → wave-executor → session-end with SPIRAL/FAILED/carryover kill-switches and confidence-gated auto-execution.

## v2.0 Features

- Session persistence via STATE.md + session memory files
- Scope & command enforcement hooks (PreToolUse)
- Circuit breaker: maxTurns limit + spiral detection
- Worktree isolation for parallel agent execution
- 5 new Session Config fields (persistence, enforcement, circuit breaker, worktrees, ecosystem-health)
- Session metrics tracking with historical trends (sessions.jsonl)
- Coordinator snapshots: pre-dispatch `git stash create` refs under `refs/so-snapshots/` for crash recovery (#196)
- CWD-drift guard: `restoreCoordinatorCwd` after every worktree-isolated Agent dispatch (#219)
- Harness audit scorecard: deterministic 7-category rubric (RUBRIC_VERSION pinned), JSON to stdout + JSONL trend in `.orchestrator/metrics/audit.jsonl`, `/discovery audit` probe, `/harness-audit` command (#210)
- Docs-orchestrator skill + docs-writer agent: audience-split (User/Dev/Vault) doc generation within sessions. Opt-in via `docs-orchestrator.enabled`. Source-cited only (diff/git-log/session-memory/affected-files); sourceless sections get `<!-- REVIEW: source needed -->`. Canonical four source types with hard abort when ALL absent. Three hook points: session-start Phase 2.5 (audience detection + AskUserQuestion, #233), session-plan Step 1.5/1.8 (Docs role classification + docs-writer auto-match + machine-readable `### Docs Tasks` SSOT emission, #234), session-end Phase 3.2 (per-task ok/partial/gap verification, mode warn/strict/off, #235). Config schema fields documented at `docs/session-config-reference.md § Docs Orchestrator` (#236). Umbrella #229 + foundation #230.
- Isolation:none default for new-directory waves (#243): `wave-executor/wave-loop.md` Pre-Dispatch New-Directory Detection inspects each agent's file scope — if ANY agent's target parent directory doesn't exist AND `configIsolation: 'auto'`, forces `isolation: 'none'` (NOT worktree). Avoids the Claude Code Agent-tool merge-back regression where new-dir writes silently fail to sync back. Enforcement auto-promotes `warn` → `strict` to keep the scope hook hard. Explicit `isolation: 'worktree'` overrides are honored with a `⚠` warning. 3rd-consecutive-session learning (conf 0.90).
- Vault-staleness discovery probes: `/discovery vault` activates two `.mjs` probes — `vault-staleness` flags 01-projects with `lastSync` age > 24h; `vault-narrative-staleness` flags `context.md`/`decisions.md`/`people.md` by tier thresholds (top=30d, active=60d, archived=180d). JSONL under `.orchestrator/metrics/vault-*.jsonl` (#232)
- Vault-backfill CLI (#241): `scripts/vault-backfill.mjs` scans configured GitLab groups (`vault-integration.gitlab-groups`), dry-run by default, `--apply` generates canonical `.vault.yaml` from projects-baseline template per repo, `--yes <manifest>` skips confirmation. Surfaced as `/plan retro` sub-mode via `skills/plan/mode-retro.md` Phase 1.6 (vault-backfill path). Umbrella #229.
- Session-end Phase 2.3 vault staleness check (#242): opt-in via `vault-staleness.enabled: true`; runs both `vault-staleness` + `vault-narrative-staleness` probes via Node import at close time. `mode: warn` surfaces findings in the Phase 6 Final Report Docs Health line; `mode: strict` blocks session-end with AskUserQuestion override. Umbrella #229.
- Adaptive wave sizing based on complexity scoring
- Cross-session learning system with confidence-based intelligence
- Intelligent agent dispatch: project agents > plugin agents > general-purpose
- Agent-mapping Session Config for explicit role-to-agent binding
- Model selection matrix (haiku/sonnet/opus per task type)

## Session Config

persistence: true
enforcement: warn
recent-commits: 20
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
stale-branch-days: 7
plugin-freshness-days: 30
plan-baseline-path: ~/Projects/projects-baseline
plan-prd-location: docs/prd
plan-retro-location: docs/retro
plan-default-visibility: internal
vcs: gitlab
docs-orchestrator:
  enabled: false           # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]
  mode: warn               # warn | strict | off
vault-staleness:
  enabled: false           # opt-in vault-drift probes (runs in /discovery vault)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
  mode: warn               # warn | strict | off
