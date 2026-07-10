# Session Config Reference

> Canonical field reference for Session Config. All skills reference this file instead of maintaining inline copies.
> Users: see `docs/USER-GUIDE.md` Section 4 for examples and usage guidance.

## Config File Location

- **Claude Code**: Add `## Session Config` to your project's `CLAUDE.md`
- **Codex**: Add `## Session Config` to your project's `AGENTS.md`

The format and all fields are identical on both platforms. The section header must be exactly `## Session Config`.

## Schema Validation (#182)

The 7 mandatory fields enforced by `scripts/lib/config-schema.mjs` are:

| Field | Rule |
|-------|------|
| `test-command` | non-empty string |
| `typecheck-command` | non-empty string |
| `lint-command` | non-empty string |
| `agents-per-wave` | integer ≥ 2 (or object with `default` ≥ 2) |
| `waves` | integer ≥ 3 |
| `persistence` | boolean |
| `enforcement` | one of `strict` / `warn` / `off` |

Validation runs automatically via `scripts/parse-config.mjs` → `scripts/validate-config.mjs`. Behavior is driven by the `enforcement` field itself:

- `enforcement: off` → skip validation entirely
- `enforcement: warn` → print errors to stderr, still emit config (exit 0)
- `enforcement: strict` → print errors to stderr, suppress output, exit 1

Bypass via `SO_SKIP_CONFIG_VALIDATION=1`. Missing fields can be patched into an existing config file via `/bootstrap --retroactive`.

## Policy Files

Some sub-configs live in dedicated policy files under `.orchestrator/policy/`:

| File | Schema | Purpose |
|------|--------|---------|
| `blocked-commands.json` | inline | Destructive-command guard rules (#155). |
| `quality-gates.json` | `quality-gates.schema.json` | Canonical test/typecheck/lint commands (#183). Overrides the `test-command` / `typecheck-command` / `lint-command` Session Config fields when present. |

## Session Structure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `agents-per-wave` | integer or integer with overrides | `6` | Maximum parallel subagents per wave. Supports session-type overrides: `6 (deep: 18)` outputs `{"default": 6, "deep": 18}`. Plain integers remain plain. |
| `agent-mapping` | object | null | Optional mapping of role keys to agent names for explicit agent binding. Keys: `impl`, `test`, `db`, `ui`, `security`, `compliance`, `docs`, `perf`. Example: `{ impl: code-editor, test: test-specialist }`. Overrides auto-discovery when present. |
| `waves` | integer | `5` | Number of execution waves for feature and deep sessions. |
| `recent-commits` | integer | `20` | Number of recent commits to display during session start git analysis. |
| `special` | string | none | Repo-specific instructions. Freeform text that the orchestrator reads and follows during sessions. |

## VCS & Infrastructure

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vcs` | string | auto-detect | Version control platform: `github` or `gitlab`. Auto-detected from git remote URL if not set. |
| `gitlab-host` | string | from remote | Custom GitLab hostname. Only needed if the host cannot be inferred from the git remote URL. |
| `mirror` | string | `none` | Mirror target after push. Set to `github` to automatically push to a GitHub remote after every session commit. |
| `cross-repos` | list | none | Related repositories under `~/Projects/`. The orchestrator checks their git state and critical issues during session start. |
| `cross-repo.projects` | list | `[]` | Repos to process when running cross-repo maintenance scripts (`run-migrate-v2-cross-repo.mjs`, `vault-integration-watcher.mjs`, `promote-vault-strict.mjs`). Each entry is a path (absolute, `~`-prefixed, or bare name resolved under `~/Projects/`). When this list is empty or absent, those scripts emit a one-line notice and exit 0 — they never error on an empty list. Example: `[~/Projects/my-app, ~/Projects/another-app]`. |
| `pencil` | string | none | Path to a `.pen` design file (relative to project root). Enables design-code alignment reviews after Impl-Core and Impl-Polish waves. |
| `ecosystem-health` | boolean | `false` | Enable service health checks at session start. Requires `health-endpoints` to be configured. |
| `health-endpoints` | list | none | Service URLs to check health. Each entry is an object with `name` and `url` fields. |
| `issue-limit` | integer | `50` | Maximum issues to fetch when querying VCS during session start. |
| `stale-branch-days` | integer | `7` | Days of inactivity before a branch is flagged as stale. |
| `stale-issue-days` | integer | `30` | Days without progress before an issue is flagged for triage. |

## Templates-First Hook (#519)

Opt-out configuration for the PreToolUse `Bash` hook that blocks `gh|glab pr|mr|issue create` calls unless the matching repo template (`.github/PULL_REQUEST_TEMPLATE*`, `.github/ISSUE_TEMPLATE*`, `.gitlab/merge_request_templates/*`, `.gitlab/issue_templates/*`) was Read in the current session. Per-session acknowledgement is tracked in `.orchestrator/runtime/templates-acknowledged.json` — once a template is Read (or `/templates-ack` is invoked), the hook stops blocking for the remainder of the session. Mechanical replacement for gitlab-ops template advice. PRD gsd Pattern 3 / issue #519.

All fields live under a top-level `templates-first` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
templates-first:
  enabled: true                        # default true; mechanical replacement for gitlab-ops template advice
  hosts: [github, gitlab]              # array of "github" | "gitlab" — host allow-list
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `templates-first.enabled` | boolean | `true` | Master toggle for the hook. When `false`, the hook is bypassed entirely — `gh`/`glab` create calls are never blocked on template-read state. |
| `templates-first.hosts` | list of `"github"` \| `"gitlab"` | `[github, gitlab]` | Host allow-list the hook enforces against. A malformed or empty list falls back to the default; unrecognised entries are filtered out silently. |

**Used by:** `hooks/pre-bash-templates-first.mjs`, `.orchestrator/policy/templates-policy.json`, `/templates-ack` (session-scoped bypass).

## Quality

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `test-command` | string | `npm test` | Custom test command. Used by quality gates for all test invocations. Overridden by `.orchestrator/policy/quality-gates.json` when present (#183). |
| `typecheck-command` | string | `npm run typecheck` | Custom TypeScript check command. Set to `skip` for non-TS projects. Overridden by policy file when present. |
| `lint-command` | string | `npm run lint` | Custom lint command. Used by the Full Gate quality check at session end. Overridden by policy file when present. |
| `ssot-files` | list | none | Single Source of Truth files to track for freshness (e.g., `STATUS.md`, `STATE.md`). Flagged if older than `ssot-freshness-days`. |
| `ssot-freshness-days` | integer | `5` | Days before an SSOT file is flagged as stale during session start. |
| `plugin-freshness-days` | integer | `30` | Days before the plugin itself is flagged as potentially outdated. |

## Verification Auto-Fix Loop (#521)

Opt-in retry loop that dispatches a `code-implementer` fixer-agent after an inter-wave Quality-Gate failure, supplying the failed gate's output, `corrective_context`, and the changed file paths since the last green SHA. Bounded by `max-retries` — after the loop is exhausted, a diagnostics bundle is written to `.orchestrator/metrics/verification-failures/<ISO-timestamp>.json` and the wave hard-aborts. When disabled (default), the wave-executor aborts on the first gate failure — today's behaviour is unchanged. PRD gsd Pattern 4 / issue #521.

All fields live under a top-level `verification-auto-fix` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
verification-auto-fix:
  enabled: false                       # opt-in; default false preserves current abort-on-fail behaviour
  max-retries: 2                       # integer ≥ 0 — bounded fixer-agent retries before hard abort
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `verification-auto-fix.enabled` | boolean | `false` | Master toggle. When `false`, the inter-wave Quality-Gate aborts the wave on the first failure — no fixer-agent is dispatched. |
| `verification-auto-fix.max-retries` | integer | `2` | Maximum number of fixer-agent dispatch attempts before the loop gives up and hard-aborts the wave. Bounds: integer ≥ 0. |

**Used by:** `scripts/lib/quality-gate.mjs` (`runQualityGateWithRetry`), `skills/wave-executor/SKILL.md` inter-wave checkpoint, `.claude/rules/quality-gates-autofix.md`.

## Discovery

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `discovery-on-close` | boolean | session-type aware: `false` for `housekeeping`, `true` for `feature`/`deep` (#264) | Run discovery probes automatically during `/close`. Default is `false` for housekeeping sessions and `true` for feature and deep sessions when not explicitly configured. An explicit value always overrides the session-type default. |
| `discovery-probes` | list | `[all]` | Probe categories to run: `all`, `code`, `infra`, `ui`, `arch`, `session`, `audit`, `vault`, `feature`. |
| `discovery-exclude-paths` | list | `[]` | Glob patterns to exclude from discovery scanning (e.g., `vendor/**`, `dist/**`). |
| `discovery-severity-threshold` | string | `low` | Minimum severity for reported findings: `critical`, `high`, `medium`, `low`. |
| `discovery-confidence-threshold` | integer | `60` | Minimum confidence score (0-100) for discovery findings to be reported. Findings below this threshold are auto-deferred. |
| `discovery-parallelism` | integer | `5` | Maximum probe agents dispatched in parallel per category during Phase 3. Bounds: `1..16`; out-of-range values silently fall back to the default. Raise for large stacks to reduce wall-clock, lower to relieve a busy host. |

## Slopcheck (Package Legitimacy Gate) (#520)

Opt-in defense against LLM-hallucinated package names ("slopsquatting"). When enabled, `classifyPackages(pkgs)` consults the registry and classifies each package as `LEGITIMATE` (exists, download count above threshold), `ASSUMED` (exists but very new / low downloads — warning, not block), `SUS` (audit warning hit — operator confirmation required), or `SLOP` (package not found in the registry — a possible LLM hallucination; hard block in plan-flow). Hooked into `/plan` PRD generation (Phase 3.5 Package-Audit) and `/discovery` supply-chain probes. Complementary to the always-on SEC-020 supply-chain baseline (`ignore-scripts=true`, `block-exotic-subdeps=true`, `minimum-release-age=1440`): SEC-020 prevents post-install execution of malicious packages; Slopcheck prevents adopting non-existent (typosquat-target) packages in the first place. PRD gsd Pattern 2 / issue #520.

All fields live under a top-level `slopcheck` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
slopcheck:
  enabled: false                       # opt-in; defaults to off so existing sessions are unaffected
  sources: [plan, discovery]           # array of "plan" | "discovery" — where classifyPackages is invoked
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `slopcheck.enabled` | boolean | `false` | Master toggle for the package-legitimacy gate. When `false`, `classifyPackages()` is never invoked from `/plan` or `/discovery`. |
| `slopcheck.sources` | list of `"plan"` \| `"discovery"` | `[plan, discovery]` | Which call-sites invoke `classifyPackages()`. A malformed or empty list falls back to the default; unrecognised entries are filtered out silently. |

**Used by:** `scripts/lib/slopcheck.mjs` (`classifyPackages`), `skills/plan/SKILL.md` Phase 3.5, `skills/discovery/probes/supply-chain-slopcheck.mjs`.

## Persistence & Safety

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persistence` | boolean | `true` | Enable session resumption via STATE.md and session memory files. |
| `memory-cleanup-threshold` | integer | `5` | Recommend `/memory-cleanup` after N accumulated session memory files. |
| `memory-cleanup-soft-limit` | integer | `180` | Hard ceiling on accumulated memory files before the cleanup nudge escalates from a soft suggestion to a strong recommendation. PRD F2.2 / issue #502. Used by `scripts/lib/auto-dream.mjs`. |
| `learning-expiry-days` | integer | `30` | Legacy/default expiry window used by review/extend flows. New analyzer learnings preserve a candidate-supplied `expires_at` or derive expiry from `LEARNING_TTL_DAYS[type]` (for example, `autonomy-verdict` is 90 days). |
| `learnings-surface-top-n` | integer | `15` | Cap on how many learnings the session-start Phase 5.6 and session-plan Step 0.5 sections surface, ranked by confidence descending. `0` = do not surface any learnings. Applies to Project Intelligence output. |
| `learning-decay-rate` | float (0.0 ≤ x < 1.0) | `0.05` | Confidence decay applied to every untouched learning at session-end (after touched-set update, before prune). `0.0` = disable decay. A learning starting at `0.5` confidence survives ~10 untouched sessions with default decay. |
| `enforcement` | string | `warn` | Hook enforcement level for scope and command restrictions: `strict`, `warn`, or `off`. |
| `enforcement-gates` | object | null | Per-gate toggles for enforcement hooks. Keys: `path-guard`, `command-guard`, `post-edit-validate`. Values are booleans. Missing keys default to enabled. Example: `{ path-guard: true, command-guard: true, post-edit-validate: false }`. Combined with `enforcement` (which controls strict/warn/off globally). |
| `allow-destructive-ops` | boolean | `false` | When `true`, disables the main-session destructive-command guard (`hooks/pre-bash-destructive-guard.mjs`). Set to `true` for intentional maintenance sessions that need `git reset --hard`, `rm -rf`, etc. Defaults to `false` (safe). See issue #155 and `.claude/rules/parallel-sessions.md` (PSA-003). Example: `allow-destructive-ops: true` |
| `reasoning-output` | boolean | `false` | Enable STATE:/PLAN: structured reasoning markers in agent prompts. When true, agents emit short transparency lines before tool calls. Opt-in — adds prompt overhead. |
| `grounding-check` | boolean | `true` | Enable file-level grounding verification in session-end Phase 1.1a (planned vs touched files). When true, session-end compares each agent's declared file scope against `git diff --name-only $SESSION_START_REF..HEAD` and reports scope creep + incomplete coverage. Informational — does not block session close. |
| `grounding-injection-max-files` | integer | `3` | Max files with recent `edit-format-friction` stagnation history to inject as line-numbered GROUNDING blocks into each agent's prompt before dispatch (wave-executor pre-dispatch step). Per-agent scope; selects top N by recency. `0` disables the feature. Gated on `persistence: true`. (#85) |
| `isolation` | string | `auto` | Agent isolation mode: `worktree`, `none`, or `auto`. `auto` resolves per-wave via the graduated default (#194): ≤2 agents → `none`, 3–4 agents on feature/deep → `worktree`, ≥5 agents → `worktree`, housekeeping 3–4 → `none`. Explicit `worktree` or `none` overrides the graduation. See [isolation graduation](#isolation-graduation) below. |
| `max-turns` | integer or string | `auto` | Maximum agent turns before PARTIAL. Auto: housekeeping=8, feature=15, deep=25. |
| `auto-commit-per-wave` | boolean | `false` | Automatically commit each wave's work after the Quality-Lite gate passes. Checkpoint commits per wave reduce the risk of data loss from `git stash` collisions in parallel sessions (V3.3 RESCUE incident — see GitLab #214). When `false`, all work is committed at session-end via `/close`. Requires `persistence: true`; the flag is silently ignored when `persistence: false`. Trade-off: each wave produces an additional commit; git log shows N+1 commits instead of 1. Use `/simplify` or `git rebase -i --autosquash` before final close to squash if a clean history is desired. **Implementation note:** the procedural commit sequence (`scripts/lib/auto-commit.mjs`) is deferred to V3.6. Until then, setting this flag to `true` triggers a session-start warning that auto-commits are not yet active — the flag is a no-op but is validated so projects can opt in early. |

## STATE.md Lock (#518)

Mechanical write-lock around STATE.md that prevents race conditions between parallel worker sessions (or parallel wave-executor checkpoints within one session) writing the same file. When enabled, `withStateMdLock(repoRoot, fn)` acquires `.orchestrator/state.lock` via atomic tmp-file + rename before invoking `fn`, and releases on completion or throw. A stale lock (holder PID no longer alive, or heartbeat expired) is overridden atomically with a WARN on stderr; genuine contention past `timeout-ms` returns `{ ok: false, reason: 'timeout' }` to the caller. This mechanically enforces PSA-003/PSA-004 (Destructive Action Safeguards / Commit Discipline) for STATE.md specifically — the race condition becomes structurally impossible rather than merely discouraged. PRD gsd Pattern 1 / issue #518.

All fields live under a top-level `state-md-lock` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
state-md-lock:
  enabled: true                        # default true; mechanical guard against PSA-003/PSA-004 violations
  timeout-ms: 10000                    # integer ≥ 0 — acquire timeout in milliseconds
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `state-md-lock.enabled` | boolean | `true` | Master toggle for the mechanical write-lock. When `false`, STATE.md writers proceed without acquiring `.orchestrator/state.lock` — behaviour reverts to the pre-#518 unlocked write path. |
| `state-md-lock.timeout-ms` | integer | `10000` | Milliseconds a caller waits to acquire the lock before giving up. Bounds: integer ≥ 0. |

**Used by:** `scripts/lib/session-lock.mjs` (`acquireStateLock`/`releaseStateLock`/`withStateMdLock`), every STATE.md writer under `scripts/lib/state-md/`, session-start Phase 1.5/1b, wave-executor inter-wave checkpoints, session-end Phase 3.7. See `.claude/rules/parallel-sessions.md` § PSA-005.

## Discovery-Validator (PSA-006 Enforcement, #567)

Non-blocking `SubagentStop` hook that mechanically enforces PSA-006: distributional claims ("N of M", "100% of", "all N", "no remaining", "every X", "none of") appearing in a subagent's transcript tail must carry an adjacent fenced grep/rg/find transcript. When a claim lacks one, the hook records a `discovery_validator_violation` event in `.orchestrator/metrics/events.jsonl` and emits a stderr WARN. v1 is log + warn only — exit 0 always, never blocks the agent; a blocking hard-gate is reserved for a future iteration. Default ON (flip risk is near-zero; the hook only ever generates telemetry).

All fields live under a top-level `discovery-validator` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
discovery-validator:
  enabled: true                        # on by default; log+warn-only, exit-0-always — set false to silence
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `discovery-validator.enabled` | boolean | `true` | Master toggle. When `false`, the `SubagentStop` hook is bypassed entirely — no transcript scanning, no `discovery_validator_violation` events. Note: when the `discovery-validator:` block is present but omits the `enabled:` line, the parser conservatively resolves to `false` (only a literal `true` flips it) — the `true` default applies when the block is absent entirely. Always set `enabled` explicitly when adding this block. |

**Used by:** `hooks/post-subagent-discovery-validator.mjs`, `scripts/lib/config/discovery-validator.mjs` (`_parseDiscoveryValidator`). See `.claude/rules/parallel-sessions.md` § PSA-006.

## Worker-Pool Dispatch (#415)

Opt-in bounded-concurrency cursor-based agent dispatch. When `enabled: true`, wave-executor uses `runWavePool()` (from `scripts/lib/wave-executor/pool.mjs`), so at most `max-parallel` agents are active at any moment. Projects that omit this block use the default small-batch Agent() dispatch (3–4 calls per message, cumulative up to `agents-per-wave`; large single-message fan-outs are forbidden — see `skills/wave-executor/wave-loop.md § Dispatch Agents`).

All fields live under a top-level `worker-pool` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
worker-pool:
  enabled: false           # opt-in; default false preserves existing behavior
  max-parallel: 4          # cap concurrent workers; defaults to agents-per-wave
  drain-timeout-ms: 10000  # ms to wait for in-flight workers after abort signal
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `worker-pool.enabled` | boolean | `false` | When `false`, the default small-batch Agent() dispatch is used (3–4 calls per message; large single-message fan-outs forbidden). When `true`, dispatches via `runWavePool()` with a bounded cursor. |
| `worker-pool.max-parallel` | integer | value of `agents-per-wave` | Maximum concurrent workers active simultaneously. Falls back to `agents-per-wave` when unset. |
| `worker-pool.drain-timeout-ms` | integer | `10000` | Milliseconds the pool waits for in-flight workers to settle after an abort signal fires before returning partial results. |

## Agent Output Schema Validation (#451)

Opt-in validation of each agent's machine-readable output block against its declared JSON Schema (`output-schema:` frontmatter). When enabled, wave-executor calls `validateAgentOutput()` (from `scripts/lib/agent-output-schema.mjs`) on every agent result and annotates the record with a `schema_status` field. Agents without an `output-schema:` declaration are silently skipped (backward-compatible). Agents with a schema that emit invalid output are flagged according to `enforce`.

All fields live under a top-level `output-schema-validation` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
output-schema-validation:
  enabled: false           # opt-in; default off preserves existing behavior
  enforce: warn            # warn | strict | off
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `output-schema-validation.enabled` | boolean | `false` | Master toggle. When `false`, no schema validation is performed and agent records carry no `schema_status` field. When `true`, validation runs after every agent completes. |
| `output-schema-validation.enforce` | string | `warn` | Violation handling: `warn` logs the violation in `subagents.jsonl` and continues the wave; `strict` surfaces the violation as a wave-blocking finding; `off` disables violation recording entirely (useful when `enabled: true` is needed only for `schema_status` tagging on valid outputs). |

## Environment Awareness (v3.1.0)

Introduced by Epic #157 / issue #166. Lets session-start sense the host (RAM, CPU, SSH, peer sessions) and adapt wave planning accordingly. All fields are opt-in defaults — a project without this block behaves identically to v3.0.0.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `resource-awareness` | boolean | `true` | Master toggle for the env-aware runtime. When `false`, skips Phase 4.5 adaptive wave sizing and the host banner. |
| `enable-host-banner` | boolean | `true` | Whether `hooks/on-session-start.mjs` emits the host + resource banner at the top of every session. Set `false` to silence. |
| `resource-thresholds` | object | see below | Numeric thresholds that drive Phase 4.5 adaptive rules. Unset sub-keys fall back to defaults. Sub-keys: `ram-free-min-gb`, `ram-free-critical-gb`, `cpu-load-max-pct`, `concurrent-sessions-warn`, `ssh-no-docker`, `zombie-threshold-min`. |

### resource-thresholds

Sub-key defaults:

```yaml
resource-thresholds:
  ram-free-min-gb: 4            # below this, cap agents-per-wave at 2
  ram-free-critical-gb: 2       # below this, recommend coordinator-direct
  cpu-load-max-pct: 80          # sustained above this, cap agents-per-wave at 2
  concurrent-sessions-warn: 5   # warn when host has this many Claude sessions
  ssh-no-docker: true           # when session is over SSH, steer the plan away from Docker-based tests
  zombie-threshold-min: 30      # age (minutes) above which an idle Claude/Node process is a zombie candidate
```

**`zombie-threshold-min`** (default: `30`): When set, the resource probe runs a secondary `ps` pass that counts Claude and Node processes older than this many minutes **and** with CPU% ≤ 1%. These are "zombie candidates" — stale sessions or orphaned workers that still hold RAM. The probe exposes them via `zombie_processes_count` in the snapshot. The evaluator escalates the verdict to at least `warn` when `zombie_processes_count >= 1` **and** `claude_processes_count > 0` (i.e., there are active Claude processes alongside the zombies). The reason string surfaces the threshold and count so the session-start banner gives actionable context. Set to `0` to disable zombie detection entirely (the field is omitted from the default snapshot when absent from config).

Rationale: originated from the 2026-04-19 incident where 8 parallel Claude sessions on one Mac caused a hard freeze. The adaptive rules cap concurrent agent load when the host is under pressure, before a wave ever spawns subagents. See Epic #157 and Sub-Epic #158.

### isolation graduation

The graduated default implements `scripts/lib/wave-sizing.mjs::resolveIsolation`. Per-wave truth table:

| agentCount | sessionType | isolation |
|---|---|---|
| ≤ 2 | any | `none` |
| 3–4 | housekeeping | `none` |
| 3–4 | feature / deep | `worktree` |
| ≥ 5 | any | `worktree` |

**Plan-level override:** session-plan may emit `collision-risk: low | medium | high` alongside each wave spec. `high` forces `worktree` even at ≤2 agents — use it when agents will edit the same files.

**Config-level override:** setting `isolation: worktree` or `isolation: none` in Session Config disables the graduation entirely for every wave.

**Enforcement auto-promote (#194):** when isolation resolves to `none`, `enforcement: warn` auto-promotes to `strict` for that wave — the scope hook becomes the only barrier once worktrees are absent, so it must be hard. Explicit `enforcement: off` is respected (user opt-out).

Rationale: the verified learning `coordinator-over-worktree-on-shared-files` (confidence 0.75) showed that small waves on partitioned scopes merge cleaner in-place than under worktree isolation. Two consecutive deep sessions (2026-04-20 07:30, 09:00) hit worktree base-ref staleness on ≤2-agent waves — the graduated default eliminates that hot path.

### base-ref freshness (#195)

Independent of isolation choice, wave-executor now persists a per-worktree meta file (`.orchestrator/tmp/worktree-meta/<suffix>.json`) when dispatching with `isolation: worktree`. Before each merge-back, it calls `checkWorktreeBaseRefFresh` (from `scripts/lib/worktree-freshness.mjs`) which returns one of four decisions:

- **pass** — worktree base matches current `main` HEAD; merge-back proceeds.
- **warn** — `main` advanced since worktree creation but drift does not overlap the agent's scope; log and proceed.
- **block** — `main` advanced AND drift files overlap the agent's scope; merge-back is refused. The coordinator reconciles manually or rebases the agent's branch.
- **no-meta** — meta file missing or corrupted; fall back to manual diff review.

This guard converts the manual post-copy `git diff` check (used to rescue the 07:30 and 09:00 regressions) into a coded pre-copy gate. The check is non-blocking on `pass` / `warn` / `no-meta`; only `block` interrupts the wave.

## Planning

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `baseline-ref` | string (git ref) or null | null | Git ref (branch, tag, or SHA) on the baseline GitLab project from which to fetch canonical `.claude/rules/*.md` and `.claude/agents/*.md` during `/bootstrap`. When null, rules arrive via Clank's weekly baseline sync MRs (legacy path). See [baseline-ref](#baseline-ref) below. |
| `baseline-project-id` | string or number | `"52"` | GitLab project ID of the baseline repository. Defaults to `"52"` (`infrastructure/projects-baseline`). Has no effect when `baseline-ref` is unset. See [baseline-project-id](#baseline-project-id) below. |
| `plan-baseline-path` | string | none | Path to projects-baseline directory (e.g., `~/Projects/projects-baseline`). Optional. When absent, `/bootstrap` falls back to plugin-bundled minimal templates. Previously required for `/plan new` repo scaffolding; now only required if you want to scaffold from your own baseline. |
| `plan-default-visibility` | string | `internal` | Default repo visibility for `/plan new`: `internal`, `private`, or `public`. |
| `plan-prd-location` | string | `docs/prd/` | Directory where PRD documents are saved (relative to project root). |
| `plan-retro-location` | string | `docs/retro/` | Directory where retrospective documents are saved (relative to project root). |

### baseline-ref

- **Type:** string (git ref) | null
- **Default:** null
- **Used by:** bootstrap (rules-fetch bridge)

The git ref (branch name, tag, or commit SHA) on the baseline GitLab project from which to fetch canonical `.claude/rules/*.md` and `.claude/agents/*.md` during `/bootstrap`. When set, the rules-fetch bridge runs as a post-scaffold step.

When `null` (the default), rules arrive in the repo via Clank's weekly baseline sync MRs (the legacy path). Setting `baseline-ref: main` short-circuits that delay so a freshly-bootstrapped repo starts with current rules immediately.

Pin to a specific SHA for reproducible bootstraps:
```yaml
baseline-ref: a1b2c3d4
```

Or float on a branch for always-current rules:
```yaml
baseline-ref: main
```

Requires:
- `GITLAB_TOKEN` env var set with read scope on the baseline project
- `scripts/lib/fetch-baseline.mjs` present in the session-orchestrator plugin

If the fetch fails (network error, auth error, missing file), bootstrap continues without aborting — rules will arrive via the legacy Clank sync path. A warning is printed.

See: session-orchestrator issue #110, projects-baseline `docs/REPO-STATUS.md`.

### baseline-project-id

- **Type:** string | number
- **Default:** `"52"` (infrastructure/projects-baseline on `<your-gitlab-host>`)
- **Used by:** bootstrap (rules-fetch bridge)

The numeric GitLab project ID of the baseline repository. Defaults to `"52"` which corresponds to `infrastructure/projects-baseline`. Override only when adopting this plugin against a different baseline source.

Used together with `baseline-ref`. Has no effect when `baseline-ref` is unset.

## Vault Sync

Opt-in configuration for the `vault-sync` quality gate at session-end (see `skills/vault-sync/SKILL.md`). The gate validates YAML frontmatter against the canonical `vaultFrontmatterSchema` and flags dangling wiki-links across a markdown knowledge base. Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-sync` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-sync:
  enabled: true
  mode: warn
  vault-dir: .
  exclude: [ "**/_MOC.md", "**/_overview.md", "**/README.md" ]
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-sync.enabled` | boolean | `false` | If true, session-end runs the vault-sync validator as part of Phase 2 Quality Gate. When false (or missing), the gate is skipped silently. |
| `vault-sync.mode` | string | `warn` | Gate severity. `hard` blocks session close on frontmatter/schema errors. `warn` reports errors in the quality gate report but does not block. `off` bypasses the validator entirely (useful during onboarding when `enabled` is flipped on but the vault is not yet clean). Dangling wiki-links are always warnings regardless of mode. |
| `vault-sync.vault-dir` | string | project root (`$PWD`) | Directory to scan for `.md` files. Passed to the validator via `VAULT_DIR`. Accepts absolute or project-relative paths. |
| `vault-sync.exclude` | list of glob strings | `[]` | File patterns to skip during validation (e.g. `**/_MOC.md`, `**/README.md`, `**/_overview.md`). Legitimate index files that do not carry full note frontmatter should be listed here. Matching files are counted in `excluded_count` but are not validated. Supports `**`, `*`, and `?` wildcards (fnmatch-style). |

## CLAUDE.md Drift Check

Opt-in narrative-drift gate at session-end Phase 2.2 (see `skills/claude-md-drift-check/SKILL.md` for the full spec — the SSOT for check semantics). Ten checks run against top-level repo docs:

1. `path-resolver` — absolute paths in CLAUDE.md / _meta resolve on disk
2. `project-count-sync` — hardcoded `01-projects/` count claims match the actual folder count
3. `issue-reference-freshness` — issue references inside forward-looking sections (What's Next, Backlog, Open Issues, Offene Themen, Todo, Next Steps, Roadmap) are not closed
4. `session-file-existence` — `50-sessions/YYYY-MM-DD-*.md` references exist on disk
5. `command-count` — claimed "N commands" prose matches actual `commands/*.md` count
6. `session-config-parity` — top-level `## Session Config` keys diffed against `docs/session-config-template.md`
7. `vault-dir-parity` — `CLAUDE.md` vs `AGENTS.md` agreement on `vault-integration.vault-dir`
8. `generated-rule-staleness` (WARN-only) — auto-generated rules whose `learning-key` is absent or expired in `learnings.jsonl`
9. `rule-scoping` — `.claude/rules/*.md` `paths:`/`globs:` frontmatter defects, cited-but-missing rule citations, zero-match globs, foreign PascalCase glob tokens
10. `docs-parity` — `docs/components.md` count-claims vs actual on-disk counts, Session Config key parity between `docs/session-config-template.md` and `docs/session-config-reference.md`, and stale legacy metrics-path references (the pre-#217 `.claude`-rooted convention, superseded by `.orchestrator/metrics/`) in the docs tree (three sub-checks a/b/c; issue #780)

Complementary to `vault-sync`: that gate validates frontmatter inside the vault tree; this gate validates narrative claims in top-level docs.

All fields live under a top-level `drift-check` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
drift-check:
  enabled: true
  mode: warn
  include-paths:
    - CLAUDE.md
    - AGENTS.md
    - _meta/**/*.md
  check-path-resolver: true
  check-project-count-sync: true
  check-issue-reference-freshness: true
  check-session-file-existence: true
  check-command-count: true
  check-session-config-parity: true
  check-vault-dir-parity: true
  check-generated-rule-staleness: true
  check-rule-scoping: true
  check-docs-parity: true
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `drift-check.enabled` | boolean | `false` | If true, session-end runs the drift checker as part of Phase 2.2. When false (or missing), the gate is skipped silently. |
| `drift-check.mode` | string | `warn` | Gate severity. `hard` makes the checker exit non-zero on drift; session-end surfaces the errors, creates carryover, and continues. `warn` reports drift in the quality gate report but does not block. `off` bypasses the checker entirely. |
| `drift-check.include-paths` | list of strings | `["CLAUDE.md", "AGENTS.md", "_meta/**/*.md"]` | Files to scan. Supports exact paths and `<dir>/**/*.<ext>` directory-recursive patterns (relative to repo root). |
| `drift-check.check-path-resolver` | boolean | `true` | Enable Check 1 (`path-resolver`): every absolute `/Users/…` path in scope files must resolve via `existsSync`. Code-fence blocks are skipped. |
| `drift-check.check-project-count-sync` | boolean | `true` | Enable Check 2 (`project-count-sync`): hardcoded `(N registered)` / `(N projects)` claims must match the actual `01-projects/*/` count. Auto-skipped if no `01-projects/` directory exists. |
| `drift-check.check-issue-reference-freshness` | boolean | `true` | Enable Check 3 (`issue-reference-freshness`): `#NN` references inside forward-looking sections (What's Next, Backlog, Open Issues, Offene Themen, Todo, Next Steps, Roadmap) must be open per `glab issue view`. Auto-skipped if `glab` is not on PATH or origin repo cannot be detected. |
| `drift-check.check-session-file-existence` | boolean | `true` | Enable Check 4 (`session-file-existence`): every `50-sessions/YYYY-MM-DD-*.md` reference must exist on disk at `<vault>/50-sessions/<file>`. |
| `drift-check.check-command-count` | boolean | `true` | Enable Check 5 (`command-count`): claimed "N commands" prose must match the actual count of `*.md` files directly inside `commands/` (non-recursive). Auto-skipped if no `commands/` directory exists. |
| `drift-check.check-session-config-parity` | boolean | `true` | Enable Check 6 (`session-config-parity`): every top-level key under `## Session Config` in the canonical template (`docs/session-config-template.md`) must also be present in the resolved local instruction file. Missing keys are errors. |
| `drift-check.check-vault-dir-parity` | boolean | `true` | Enable Check 7 (`vault-dir-parity`): when both `CLAUDE.md` and `AGENTS.md` exist, their `vault-integration.vault-dir` values must agree. Skipped when only one instruction file is present. |
| `drift-check.check-generated-rule-staleness` | boolean | `true` | Enable Check 8 (`generated-rule-staleness`, WARN-only): every `.claude/rules/*.md` file with `auto-generated: true` frontmatter must carry a `learning-key` that resolves to a non-expired entry in `.orchestrator/metrics/learnings.jsonl`. Never blocks — this check only ever produces warnings. |
| `drift-check.check-rule-scoping` | boolean | `true` | Enable Check 9 (`rule-scoping`): validates `.claude/rules/*.md` frontmatter against the `rule-loader.mjs` activation contract — a top-level `paths:` key (error), cited-but-missing rule citations in `CLAUDE.md`/`AGENTS.md`/`## See Also` footers (error), zero-match `globs:` patterns (warn), and foreign PascalCase glob tokens (warn). Skipped silently when `.claude/rules/` is absent. |
| `drift-check.check-docs-parity` | boolean | `true` | Enable Check 10 (`docs-parity`): three sub-checks over the public docs surface, all reported under the single `docs-parity` check id — **(a)** `docs/components.md`'s own heading counts vs the same on-disk derivation Check 5's surface-count family uses; **(b)** top-level Session Config keys documented in `docs/session-config-template.md` (opt-in baseline) vs `docs/session-config-reference.md` (a key counts as documented when it appears in a `yaml` fence, a heading, or the first cell of a table row); **(c)** stale legacy metrics-path references (the old `.claude`-rooted convention, superseded by `.orchestrator/metrics/`) in root `docs/*.md` / `docs/examples/*.md`. Skipped silently when `docs/components.md` is absent, or explicitly via `--skip-docs-parity`. Issue #780. |

## Vault Integration

Opt-in configuration for the `vault-mirror` auto-sync that writes learnings and session summaries into the Meta-Vault after each session (see `scripts/vault-mirror.mjs`). When enabled, the session-end skill invokes the mirror script after writing JSONL metrics, and the evolve skill mirrors new learnings after each learning atomic-rewrite. Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-integration` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn
  vault-name:                # optional (#660) — per-project vault namespace override
```

> **Host-local override (#653).** `vault-dir` (and `plan-baseline-path`) resolve host-locally with precedence: env-var (`SO_VAULT_DIR` / `SO_BASELINE_PATH`) > `owner.yaml` `paths:` section (`vault-dir` / `baseline-path`) > the committed default. This keeps maintainer-specific absolute paths out of version control. Resolver: `scripts/lib/config/host-paths.mjs`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-integration.enabled` | boolean | `false` | If true, session-end and evolve skills invoke `vault-mirror.mjs` to sync learnings and sessions into the vault. When false (or missing), mirroring is skipped silently. |
| `vault-integration.vault-dir` | string or null | `null` | Absolute path to the vault repository. Falls back to `$VAULT_DIR` env variable if not set. Required when `enabled` is true. |
| `vault-integration.mode` | string | `warn` | Mirror error handling. `strict` blocks session close if the mirror exits non-zero. `warn` reports errors but does not block. `off` bypasses mirror invocation entirely (useful when transitioning). |
| `vault-integration.vault-name` | string or null | `null` | Optional override for the per-project vault namespace segment (#660). When set (or via CLI `--vault-name`), vault writes go to `40-learnings/<vault-name>/` and `50-sessions/<vault-name>/`, sanitised to a kebab slug. When null/absent, the namespace is derived from the git origin via `deriveRepo()`. Owner-privacy leaks (personal home path / private slug / personal name) are redacted to `redacted-repo`. NOT a filesystem path → NOT host-path-resolved. Resolver: `scripts/lib/vault-mirror/namespace.mjs` (`resolveRepoNamespace`). |
| `vault-integration.gitlab-groups` | string[] or null | `null` | List of GitLab group paths to scan for repos missing `.vault.yaml`. Consumed by `scripts/vault-backfill.mjs` (via `readVaultIntegrationConfig()`) and the `/plan retro` vault-backfill sub-mode (`skills/plan/mode-retro.md` Phase 1.6 Step 1). When null/unset, the backfill CLI exits with a "no groups configured" notice. |

### Environment override: `VAULT_MIRROR_CANONICAL_SUFFIX`

`vault-mirror.mjs` refuses to mirror into any directory whose `git remote get-url origin` does not end with a canonical-vault path suffix — a network-of-trust guard (#600 D2) that stops notes from silently accumulating in a wrong or typo'd vault location. A non-matching suffix fails the **whole run** (`process.exit(2)`), not a per-entry skip — mirroring even one note into the wrong place is the bug it prevents.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `VAULT_MIRROR_CANONICAL_SUFFIX` | env-var (string) | `/agents/vault` | Tightens the guard from the host-agnostic default (`/agents/vault`, suffix-only — matches that tail on **any** host) to a **host-qualified** match for high-threat / multi-host environments. Example: `VAULT_MIRROR_CANONICAL_SUFFIX=gitlab.mycompany.com/agents/vault`. Whitespace-only values fall back to the default. |

This is an **environment variable only — not a Session Config key** (intentional: a host-qualified suffix embeds an operator-specific hostname, which must never be committed into a public `CLAUDE.md` / `AGENTS.md`). Set it in your shell profile or CI secret store. The sibling `VAULT_MIRROR_SKIP_CANONICAL_CHECK` is an internal test-only escape hatch and is intentionally **not** an operator flag.

## Vault Mirror Quality (#504)

Opt-in quality thresholds applied by `scripts/vault-mirror.mjs` before mirroring a learning or session note to the Meta-Vault. Notes that fail the thresholds are skipped silently (not an error). PRD F1.2.

All fields live under a top-level `vault-mirror` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-mirror:
  quality:
    min-narrative-chars: 400
    min-confidence: 0.5
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-mirror.quality.min-narrative-chars` | integer | `400` | Minimum body length (characters) before a learning or session note is mirrored to the vault. Notes shorter than this threshold are skipped — useful to prevent low-information notes from cluttering the vault during onboarding or when a session yields only stubs. Bounds: integer ≥ 0. Out-of-range values silently fall back to the default. PRD F1.2 / issue #504. |
| `vault-mirror.quality.min-confidence` | float | `0.5` | Minimum learning confidence (0.0..1.0) before a learning note is mirrored. Confidence is read from the source learning record. Notes below this threshold are skipped. Set to `0.0` to mirror every learning regardless of confidence. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. PRD F1.2 / issue #504. |

**Used by:** `scripts/vault-mirror.mjs`.

## Memory Banner (#505)

Opt-out configuration for the session-start memory-load banner. When session memory files are found and loaded at Phase 2.6, the orchestrator emits a `📚 Loaded from memory: N files` banner. Setting `enabled: false` silences the banner without affecting memory loading. PRD F2.3.

All fields live under a top-level `memory` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
memory:
  banner:
    enabled: true                # default true; set false to silence the session-start memory banner
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory.banner.enabled` | boolean | `true` | When `true`, session-start Phase 2.6 emits a one-line banner listing how many memory files were loaded. When `false`, the banner is suppressed — memory files are still loaded and applied normally. PRD F2.3 / issue #505. |

**Used by:** `scripts/lib/memory-banner.mjs`, `scripts/lib/config/memory.mjs`.

## Memory Proposals (#501)

Opt-out configuration for the agent-writable memory tool. During a wave, an agent may queue a learning proposal via the `memory.propose` CLI. At session-end Phase 3.6.3, the coordinator surfaces every queued proposal to the operator via `AskUserQuestion` for accept / reject / edit. Only accepted proposals are persisted to `.orchestrator/metrics/learnings.jsonl` with a `proposed-by: <agent-name>` provenance tag — a one-line audit trail showing which agent generated the learning. PRD F2.1 / issue #501.

This is a Hermes-style memory-write API **without** Hermes' overwrites-manual-edits critique: the operator confirmation is mandatory and there is no silent overwrite path. Three safety layers keep the surface conservative:

1. **Quota per wave** — `quota-per-wave` (default `5`) caps how many proposals any single agent may queue within one wave. Excess proposals exit `1` and the call-site logs the rejection.
2. **Confidence floor** — `confidence-floor` (default `0.5`) rejects low-confidence proposals before they reach the operator (exit `2`). Tuned so a learning is only proposed when the agent is at least 50% sure of the insight.
3. **AUQ confirm-or-discard** — the session-end phase never auto-persists. Every proposal is `AskUserQuestion`-gated; the operator can accept, reject, or edit before commit.

All fields live under the top-level `memory` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), nested as a sibling of `memory.banner`:

```yaml
memory:
  proposals:
    enabled: true                # default true; opt-out master toggle for the memory.propose feature
    quota-per-wave: 5            # max proposals an agent may queue per wave (exit 1 on overflow)
    confidence-floor: 0.5        # proposals below this confidence are rejected (exit 2)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `memory.proposals.enabled` | boolean | `true` | Master toggle for the entire memory-proposals feature. When `false`, the `memory.propose` CLI exits `3` (rejected-wrong-context) for every call and session-end Phase 3.6.3 is skipped. When `true`, agents may queue proposals during waves and the coordinator surfaces them at session-end. PRD F2.1 / issue #501. |
| `memory.proposals.quota-per-wave` | integer | `5` | Maximum number of proposals one wave-executor agent can queue per wave. The 6th proposal from the same agent in the same wave exits `1` (quota-exceeded). Bounds: integer ≥ 0. Set to `0` to disable proposals from agents without disabling the feature entirely (operator can still propose). |
| `memory.proposals.confidence-floor` | float | `0.5` | Minimum confidence (0.0..1.0) required for a proposal to be queued. Proposals with `--confidence < confidence-floor` exit `2` (rejected-low-confidence) before reaching the operator. Bounds: `0.0 ≤ value ≤ 1.0`. Set to `0.0` to accept any confidence (operator filters at AUQ time). |

### Agent CLI invocation

Agents call the CLI with five required flags **and must set `SO_WAVE_AGENT=1`** in the environment:

```bash
SO_WAVE_AGENT=1 node scripts/memory-propose.mjs \
  --type workflow-pattern \
  --subject "vault-mirror BATS test ordering" \
  --insight "BATS test files must be sourced before harness fixtures load the fnmatch shim." \
  --evidence "tests/vault-mirror/harness.bats:23 fails when shim loads after assertion bindings." \
  --confidence 0.85
```

**Wave-executor dispatch**: the boilerplate prompt in `skills/wave-executor/SKILL.md` sets `SO_WAVE_AGENT=1` automatically for every dispatched agent. Direct CLI invocation from the coordinator thread or outside a wave-executor agent context will exit `3` (`rejected-wrong-context`) because the env-var is absent. This is intentional — the guard prevents accidental coordinator-context invocations. Use `/evolve` instead when proposing learnings from the coordinator level (#543 H3).

**`--dry-run` flag (#741.3)**: pass `--dry-run` to validate a proposal (argv parsing + schema shape) without writing to `proposals.jsonl`. Under `--dry-run`, the wrong-context gates above (STATE.md active-check, `SO_WAVE_AGENT`, current-wave presence) are all bypassed — a dry-run never reaches the write step, so their protective purpose is moot, and bypassing them is what makes the flag safely runnable from coordinator context (e.g. for manual CLI verification) without first faking a wave-agent environment:

```bash
node scripts/memory-propose.mjs \
  --type workflow-pattern \
  --subject "vault-mirror BATS test ordering" \
  --insight "BATS test files must be sourced before harness fixtures load the fnmatch shim." \
  --evidence "tests/vault-mirror/harness.bats:23 fails when shim loads after assertion bindings." \
  --confidence 0.85 \
  --dry-run
```

A successful dry-run exits `0` with stdout status `dry-run-ok` (see updated exit-codes table below) and never appends to `proposals.jsonl`.

`--type` accepts one of the `PROPOSAL_TYPES` enum values (the agent-writable subset of the learnings schema): `mode-selector-accuracy`, `hardware-pattern`, `fragile-file`, `effective-sizing`, `recurring-issue`, `workflow-pattern`, `proven-pattern`, `anti-pattern`, `autopilot-effectiveness`, `domain-regression`, `convention`, `architecture-pattern`, `design-pattern`. Analyzer-only learning types such as `autonomy-verdict` are intentionally excluded because their evidence gates are enforced by `/evolve` analyzers, not by agent proposals. Strings with embedded quotes must be shell-escaped per usual conventions. The CLI appends one JSONL line to `.orchestrator/metrics/proposals.jsonl` (atomic via O_APPEND under the `.orchestrator/metrics/proposals-write.lock` mutex) and updates a per-wave summary at `.orchestrator/metrics/proposals-summary-<wave-id>.json` (counters: queued / dropped / below_floor / fs_error). The coordinator surfaces both files at session-end Phase 3.6.3 to render the AUQ multiSelect; approved entries promote into `.orchestrator/metrics/learnings.jsonl` with `_provenance: agent-proposed@<wave-id>`; rejected entries archive to `.orchestrator/proposals.rejected.log`. Privacy: `proposed_by_agent` is captured in the audit hook (`events.jsonl`) only and is stripped before promotion to learnings.jsonl.

### Exit codes

| Exit code | stdout `status` | Meaning | Triggered by |
|-----------|-----------------|---------|--------------|
| `0` | `queued` | Queued | Proposal accepted into the per-wave staging directory; awaits operator confirmation at session-end Phase 3.6.3. |
| `0` | `dry-run-ok` | Validated, not written | `--dry-run` was passed and the proposal (argv + schema) validated successfully. No write to `proposals.jsonl` occurs; the wrong-context gates are bypassed under this flag (#741.3). |
| `1` | `quota-exceeded` | Rejected — quota exceeded | This agent has already queued `quota-per-wave` proposals in this wave. Subsequent calls from the same agent fail until the next wave. Not applicable under `--dry-run` (gate bypassed). |
| `2` | `rejected-low-confidence` | Rejected — low confidence | `--confidence` argument is below `confidence-floor`. Tighten the insight or raise the confidence (operator can still tune the floor). |
| `3` | `rejected-wrong-context` | Rejected — wrong context | Feature disabled (`enabled: false`), STATE.md not active, or `SO_WAVE_AGENT != "1"` (call originated outside a wave-executor agent context). Not applicable under `--dry-run` (gate bypassed). |
| `4` | `error` | Arg error | Missing or malformed flag — invalid `--type`, empty `--subject`, non-numeric `--confidence`. The CLI prints a one-line usage message on stderr. |

The call-site (agent prompt) is expected to handle exit codes `1`, `2`, `3` gracefully — they are anticipated outcomes, not errors. Only exit code `4` indicates a bug in the agent's invocation. `dry-run-ok` (exit `0`) is a distinct success status from `queued` (also exit `0`) — callers that branch on stdout `status` (not just exit code) must match the exact string to distinguish "validated only" from "queued for review".

### Where it fits in the lifecycle

Memory proposals are one of five Epic #498 Phase 2 features that share the same memory-lifecycle picture. The full set:

- **F2.1 / #501 — Memory Proposals** (this section): agents queue learnings during waves; operator confirms at session-end.
- **F2.2 / #502 — Auto-Dream**: session-end auto-dispatches `/memory-cleanup` after every N sessions when memory-file count exceeds `memory-cleanup-soft-limit`.
- **F2.3 / #505 — Memory Banner** (sibling block above): session-start surfaces top learnings at the start of every session.
- **F2.4 / #503 — Peer Cards**: USER.md/AGENT.md curated profiles update from session evidence (operator-driven).
- **F2.5 / #506 — Dialectic-Deriver**: session-end auto-proposes peer-card edits via the dialectic critique loop.

Together: F2.1 captures fresh insight mid-flight, F2.2 consolidates old insight at scale, F2.3 surfaces it at the start, F2.4/F2.5 distill it into the durable peer-card profiles.

**Used by:** `scripts/lib/memory-proposals/{schema,store,collector,sink}.mjs`, `scripts/memory-propose.mjs`, `agents/memory-proposal-collector.md`, `hooks/pre-bash-memory-propose-audit.mjs`, `skills/session-end/SKILL.md` Phase 3.6.3.

**Cross-reference:** issue #501, PRD F2.1 in the Learning-Memory Modernization PRD; issue #741.3 (`--dry-run` flag + `dry-run-ok` status). Sibling features: `memory.banner` (above, F2.3 / #505), `dialectic.cadence` (F2.5 / #506), Auto-Dream (F2.2 / #502, surfaced via `memory-cleanup-soft-limit`).

## Auto-Dream Proposal Filter (#566)

Collect-emit confidence floor for memory proposals. Applied by `collectProposals()` (`scripts/lib/memory-proposals/collector.mjs`) at session-end Phase 3.6.3, immediately before the operator AUQ that promotes/rejects queued proposals. This is a **second** confidence gate above the write-time `memory.proposals.confidence-floor` (default `0.5`) enforced by `scripts/memory-propose.mjs`: the per-record write-floor runs first when an agent calls the CLI; the collect-emit floor here filters what surfaces to the operator's AUQ at session-end.

The two floors are additive — a proposal queued by an agent at confidence `0.6` will pass the default write-floor of `0.5` and be appended to `proposals.jsonl`, but if `auto-dream.min-confidence: 0.7` is set in Session Config, it is dropped from the queue at collect-emit time and never surfaces to the operator. The per-wave summaries in `stats` reflect the full intake (pre-filter) so audit trails remain accurate; only the AUQ-visible queue is filtered.

All fields live under a top-level `auto-dream` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
auto-dream:
  min-confidence: 0.5
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `auto-dream.min-confidence` | float | `0.5` | Minimum confidence (0.0..1.0) for a queued proposal to surface in the session-end AUQ. Records with `record.confidence < min-confidence` are dropped from the returned queue (but counted in stats). Set to `0.0` to surface every proposal regardless of confidence. Set to `1.0` to surface only fully-confident records. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. Second confidence gate applied to memory-proposals at session-end Phase 3.6.3 collect-emit (above the write-time `memory.proposals.confidence-floor`). Issue #566. |

**Used by:** `scripts/lib/config/auto-dream.mjs` (parser), `scripts/lib/memory-proposals/collector.mjs` (filter applied inside `collectProposals()`), `skills/session-end/SKILL.md` Phase 3.6.3.

**Cross-reference:** issue #566. Sibling feature: `memory.proposals.confidence-floor` (above, F2.1 / #501 — the write-time floor that runs first).

## Cold Start (#500)

Opt-out configuration for the cold-start detector. The detector nudges the operator at session-start when sessions go silent — no commits, no learnings, long wall-clock idle. PRD F1.3.

All fields live under a top-level `cold-start` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
cold-start:
  enabled: true
  nudge-after-hours: 1
  silence-after-sessions: 1
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `cold-start.enabled` | boolean | `true` | Master toggle for the cold-start detector. When `false`, the detector is skipped entirely — no nudges fire and no idle-time tracking is performed. Defaults to `true` so the feature is opt-out rather than opt-in. PRD F1.3 / issue #500. |
| `cold-start.nudge-after-hours` | integer | `1` | Hours of wall-clock idle (since the last session-end) before the cold-start detector fires a nudge at session-start. Set to a higher value (e.g. `24`) to silence transient idle pings on a busy host. Set to `0` to disable the wall-clock check (only the silence-after-sessions check applies). Bounds: integer ≥ 0. PRD F1.3 / issue #500. |
| `cold-start.silence-after-sessions` | integer | `1` | Number of consecutive silent sessions (no commits, no learnings, no vault mirror writes) before the cold-start detector fires a nudge. A session counts as silent when both commits and learnings are zero. Set to `0` to disable the silence-count check. Bounds: integer ≥ 0. PRD F1.3 / issue #500. |

**Used by:** `scripts/lib/cold-start-detector.mjs`.

## Handover Alignment Gate (#769)

Opt-out configuration for the interactive Handover-Alignment-Gate in `/close`. The gate surfaces open questions before carryover issues are filed, giving the operator a chance to align on scope/expectations before the session's incomplete work is handed off. Fail-open: the gate is skipped entirely when disabled, when running headless, or under `/autopilot`.

All fields live under a top-level `handover-gate` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
handover-gate:
  enabled: true
  max-open-questions: 3
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `handover-gate.enabled` | boolean | `true` | Master toggle for the Handover-Alignment-Gate. When `false`, the gate is skipped entirely — `/close` proceeds straight to carryover filing with no interactive triage step. Fail-open: also skipped automatically when running headless or under `/autopilot`, regardless of this value. Issue #769. |
| `handover-gate.max-open-questions` | integer | `3` | Maximum number of open questions surfaced in the gate's triage AUQ. Bounds: integer ≥ 0. `0` means no questions are surfaced — the channel stays active (the gate still runs) but presents nothing to triage. Issue #769. |

**Used by:** `scripts/lib/config/handover-gate.mjs`, session-end Phase 1.65.

## Broken-Window Budget (#730/H5)

Opt-in configuration for the Broken-Window Budget in `/close`. When enabled, session-end Phase 2.6 aggregates THIS session's "knowingly-broken shipments" — echo-stub findings that shipped under `enforcement: warn`, "Override and close" choices in Phase 2.3 / 2.5, MED/LOW review findings routed to "Unresolved Review Findings" (#617), and wave-level reviewer findings overridden without a fix task — and files ONE hard-terminated closure issue per item (labels `broken-window` + `priority:high`, with a hard due-date). It also emits `orchestrator.finding.overridden` events feeding the `effectiveness.override_ratio` metric. Non-blocking and idempotent: a filing failure is a WARN and re-running a close never duplicates issues.

All fields live under a top-level `broken-window-budget` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
broken-window-budget:
  enabled: false
  due-days: 7
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `broken-window-budget.enabled` | boolean | `false` | Master toggle for session-end Phase 2.6. When `false`, the phase is skipped silently — no closure issues are filed and no override-ratio events are emitted. Issue #730 (Epic H / H5). |
| `broken-window-budget.due-days` | integer | `7` | Days from today used as the hard due-date on each filed closure issue. Bounds: integer ≥ 1. On GitLab this is passed to the native `--due-date` flag; on GitHub (no native due-date field) it is surfaced as a `Due: <date>` first body line. Malformed / non-integer / < 1 values fall back to 7 with a stderr WARN. Issue #730 (Epic H / H5). |

**Used by:** `scripts/lib/config/broken-window.mjs`, session-end Phase 2.6, `scripts/lib/spiral-carryover.mjs` (`createBrokenWindowIssue`).

## Dialectic-Deriver (#506)

Opt-in mode for `/evolve --dialectic` and session-end Phase 3.6.7 auto-trigger. When `cadence > 0`, session-end auto-dispatches `/evolve --dialectic --dry-run` after every N sessions to produce a proposed update to USER.md/AGENT.md peer cards (#503). The dry-run writes a sidecar at `.orchestrator/dialectic-pending.md`; the operator applies via `/evolve --dialectic --apply` in a subsequent session. Set `cadence: 0` as a kill-switch.

All fields live under a top-level `dialectic` object in your Session Config (CLAUDE.md or AGENTS.md):

```yaml
dialectic:
  cadence: 5              # integer ≥ 0; 0 = kill-switch
  model: haiku            # haiku | sonnet | opus
  budget-tokens: 8000     # input token budget per call
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dialectic.cadence` | integer | `5` | Number of sessions between auto-dialectic dispatches. Set to `0` to disable all dispatches (kill-switch). Non-integer and negative values silently fall back to default. |
| `dialectic.model` | string | `haiku` | Model tier for the critique call. Must be one of `haiku`, `sonnet`, `opus`. **Fail-fast**: unknown values cause parse-config.mjs to exit 1 at startup — NOT silently ignored. |
| `dialectic.budget-tokens` | integer | `8000` | Input token budget per call. Output budget is fixed at 4000 (per #506). Non-integer and negative values fall back to default. |

**Used by:** `skills/evolve/SKILL.md` Phase 6, `skills/session-end/SKILL.md` Phase 3.6.7, `scripts/dialectic-deriver.mjs`, `scripts/lib/auto-dialectic.mjs`.

**Cross-reference:** PRD F2.5 (#506) — Honcho's "reasoning at consolidation time" insight, adopted without SaaS/AGPL/per-message-LLM-cost.

**Auto-trigger behavior:** When `cadence > 0` AND sessions-since-last-dialectic ≥ cadence AND (≥1 new session OR ≥1 new learning since last run), session-end Phase 3.6.7 dispatches the deriver in dry-run mode. The diff sidecar lands at `.orchestrator/dialectic-pending.md` (gitignored, vault-mirror-excluded). When `cadence: 0`, the auto-trigger is permanently skipped; manual `/evolve --dialectic` always works.

**Token cost:** With defaults (cadence: 5, budget-tokens: 8000, output 4000, model haiku), ~12k tokens every 5 sessions. At haiku pricing this is ~$0.02/run. Surfaced in Final Report.

## Vault Staleness

Opt-in configuration for vault-drift discovery probes. Detects stale vault projects and narratives. Used by `/discovery vault` (on-demand probe execution) and session-end Phase 2.3 (automatic gate at close time). Projects without a vault leave these fields unset and are unaffected.

All fields live under a top-level `vault-staleness` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
vault-staleness:
  enabled: false           # opt-in
  mode: warn               # warn | strict | off  (NOT 'hard'; canonical per #217)
  thresholds:
    top: 30                # days — tier=top narrative staleness threshold
    active: 60             # days — tier=active
    archived: 180          # days — tier=archived
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `vault-staleness.enabled` | boolean | `false` | If true, vault-staleness probes are activated. When false (or missing), Phase 2.3 and `/discovery vault` probes are skipped silently. |
| `vault-staleness.mode` | string | `warn` | Gate severity. `warn` runs probes and reports findings in the Docs Health line but never blocks session close. `strict` runs probes and blocks session close when findings are present; an interactive override prompt is available and any deviation is logged to STATE.md. `off` skips Phase 2.3 entirely — no probe execution. |
| `vault-staleness.thresholds.top` | integer | `30` | Days before a `tier=top` project's `lastSync` or narrative file (`context.md`, `decisions.md`, `people.md`) is flagged as stale. |
| `vault-staleness.thresholds.active` | integer | `60` | Days before a `tier=active` project's narrative is flagged as stale. |
| `vault-staleness.thresholds.archived` | integer | `180` | Days before a `tier=archived` project's narrative is flagged as stale. |

**Mode behavior:**

| Mode | Phase 2.3 | Blocks close? | Notes |
|------|-----------|---------------|-------|
| `off` | Skipped | No | No probe execution at all. |
| `warn` (default) | Runs | No | Findings reported in session-end Docs Health line. |
| `strict` | Runs | Yes | Override available via interactive prompt; deviation logged to STATE.md. |

**Related skills and files:**
- `/discovery vault` — on-demand probe execution command
- `skills/discovery/probes/vault-staleness.mjs` — project-staleness probe (flags `01-projects` with `lastSync` age > threshold)
- `skills/discovery/probes/vault-narrative-staleness.mjs` — narrative-staleness probe (checks `context.md`, `decisions.md`, `people.md` by tier)
- `skills/session-end/SKILL.md` — Phase 2.3: staleness gating and interactive override
- `.orchestrator/metrics/vault-staleness.jsonl` — JSONL output from the project-staleness probe
- `.orchestrator/metrics/vault-narrative-staleness.jsonl` — JSONL output from the narrative-staleness probe
- GitLab issue `#232` (foundation), `#242` (Sub-Epic C integration)

## Docs Staleness (#781)

Opt-in filesystem-mtime staleness probe for living reference docs — root-level `docs/*.md` plus `docs/examples/*.md`. Deliberately excludes `docs/adr/` (historically stable, immutable-by-design decision records) and `docs/prd/` (active work-in-progress scoped to a project's lifecycle). Unlike `vault-staleness` above, which reads a YAML frontmatter `updated:` field, this probe measures staleness via filesystem mtime — most repo docs under `docs/` carry no frontmatter at all. Used by `/discovery` when enabled. Epic #774 / issue #781.

All fields live under a top-level `docs-staleness` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
docs-staleness:
  enabled: false                       # opt-in
  mode: warn                           # strict | warn | off
  thresholds:
    living: 90                         # days — single tier; severity escalates at 1×/2×/3× threshold
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `docs-staleness.enabled` | boolean | `false` | If true, the probe is activated as part of `/discovery`. When false (or missing), the probe is skipped silently. |
| `docs-staleness.mode` | string | `warn` | Gate severity: `strict` \| `warn` \| `off`. A malformed value falls back to `warn`. The probe itself is fail-soft regardless of mode — it never throws. |
| `docs-staleness.thresholds.living` | integer (days) | `90` | Age threshold for the single `living` tier. Severity escalates relative to this threshold: `low` above `1×`, `medium` above `2×`, `high` above `3×`. Non-numeric or non-positive values fall back to the default. |

**Used by:** `skills/discovery/probes/docs-staleness.mjs` (`runProbe`), `scripts/lib/config/docs-staleness.mjs` (`_parseDocsStaleness`). Writes one JSONL summary record per run to `.orchestrator/metrics/docs-staleness.jsonl`. See `docs/README.md` for the living-vs-archived docs classification this probe enforces.

## Docs Orchestrator

Opt-in configuration for the `docs-orchestrator` skill, which generates audience-split documentation (User / Dev / Vault) within sessions (see `skills/docs-orchestrator/SKILL.md`). When enabled, session-start runs a Phase 2.5 docs-context step, session-plan assigns a Docs role, and session-end runs a Phase 3.2 gap-reporting step. The `docs-writer` agent is made available automatically when `enabled: true`.

All fields live under a top-level `docs-orchestrator` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
docs-orchestrator:
  enabled: false                 # opt-in; when true, session-start Phase 2.5 runs + docs-writer agent available
  audiences: [user, dev, vault]  # allowed audiences — can be narrowed per project
  mode: warn                     # warn | strict | off — session-end Phase 3.2 gap reporting
```

| Field | Type | Default | Allowed values | Description |
|-------|------|---------|----------------|-------------|
| `docs-orchestrator.enabled` | boolean | `false` | `true` / `false` | If true, the docs-orchestrator lifecycle hooks activate: session-start Phase 2.5 runs a docs-context step, and session-end Phase 3.2 reports documentation gaps. When false (or missing), all docs-orchestrator steps are skipped silently. |
| `docs-orchestrator.audiences` | array of string | `[user, dev, vault]` | `user`, `dev`, `vault` | Audiences for which documentation is generated. Can be narrowed to a subset (e.g., `[user, dev]`) to skip vault-targeted docs on projects without a vault. Each value must be one of the three canonical audience identifiers. |
| `docs-orchestrator.mode` | string | `warn` | `warn` / `strict` / `off` | Gap-reporting severity at session-end Phase 3.2. `warn` reports undocumented changes but does not block session close. `strict` blocks session close when documentation gaps are detected. `off` bypasses gap reporting entirely (useful during onboarding). |

**Related skills and files:**
- `skills/docs-orchestrator/SKILL.md` — full skill spec, hook points, and source-citation rules
- `skills/docs-orchestrator/audience-mapping.md` — per-audience content rules and output formats
- `skills/session-start/SKILL.md` — Phase 2.5 docs-context step (activated when `enabled: true`)
- `skills/session-end/SKILL.md` — Phase 3.2 gap-reporting step (activated when `enabled: true`)
- `agents/docs-writer.md` — agent dispatched for documentation generation

## Events Rotation

Size-based rotation for `.orchestrator/metrics/events.jsonl` (#251). Rotation fires at **session-start only** — per-append overhead is rejected design given typical growth of ~6 KiB/day. When the active log exceeds `max-size-mb`, it is renamed to `events.jsonl.1`, older backups shift down (`.1` → `.2`, …, `.N-1` → `.N`), and the oldest backup (`events.jsonl.{max-backups}`) is deleted. Rotation failure never blocks session-start; errors are logged to stderr and swallowed.

All fields live under a top-level `events-rotation` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
events-rotation:
  enabled: true     # default true; set false to disable rotation entirely
  max-size-mb: 10   # default 10; integer, bounds 1..1024
  max-backups: 5    # default 5; integer, bounds 1..20
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `events-rotation.enabled` | boolean | `true` | If false, rotation is skipped entirely and `events.jsonl` grows unbounded. |
| `events-rotation.max-size-mb` | integer | `10` | Size threshold in MiB. When `events.jsonl` exceeds this, it is rotated at the next session-start. Bounds: `1..1024`; out-of-range values silently fall back to the default. |
| `events-rotation.max-backups` | integer | `5` | Number of retained backup files (`events.jsonl.1` … `events.jsonl.N`). The oldest is deleted before shifting. Bounds: `1..20`; out-of-range values silently fall back to the default. |

**Rename safety (POSIX):** Atomic rename is safe with in-flight writers. Open file descriptors continue writing to the original inode (now `events.jsonl.1`); new writers open the new file on next append. Maximum observed line size is 220 bytes, well under the 4096-byte PIPE_BUF atomicity guarantee.

## Test

Opt-in configuration for the `/test` agentic end-to-end test command (Epic #378, issue #383). When `enabled: true`, the `/test` command reads this block to determine which profile to run, where the profile registry lives, how to handle issue reconciliation findings, and how long to retain test-run artifacts. Projects that have not configured this block leave all fields at their defaults and are unaffected — `/test` will report "test is disabled" and exit unless `enabled` is set to `true`.

All fields live under a top-level `test` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
test:
  enabled: false                                         # master toggle
  default-profile: smoke                                 # profile name used when no --profile flag given
  profiles-path: .orchestrator/policy/test-profiles.json # profile registry location
  mode: warn                                             # warn | strict | off
  retention-days: 30                                     # artifact retention in days
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `test.enabled` | boolean | `false` | Master toggle for the `/test` agentic end-to-end test command. When `false`, `/test` reports "test is disabled" and exits. |
| `test.default-profile` | string | `smoke` | Profile name used when no `--profile` flag or positional arg is given. Must match a key in the profile registry at `profiles-path`. |
| `test.profiles-path` | string | `.orchestrator/policy/test-profiles.json` | Path (relative to repo root) where the test profile registry lives. |
| `test.mode` | string (`warn` \| `strict` \| `off`) | `warn` | Issue reconciliation severity. `warn` files findings non-blockingly. `strict` blocks session-end on HIGH/CRITICAL findings. `off` skips reconciliation entirely. |
| `test.retention-days` | integer | `30` | Days to retain `.orchestrator/metrics/test-runs/<run-id>/` artifacts before cleanup. Set to `0` to disable cleanup. |

## Custom Phases (#637)

Opt-in, repo-declared deterministic phases that run as their own phase during session close (and/or housekeeping). Where the freeform `special:` key gives no execution guarantee, `custom-phases` is a **contract**: each phase runs a deterministic `command` via Bash with exit-code gating and summary reporting, so a repo can run a domain command (e.g. an eval-learn aggregate) as a first-class close step. Absent/empty ⇒ `[]` ⇒ no custom phases run; existing sessions are unaffected.

The block is a YAML list under a top-level `custom-phases` key:

```yaml
custom-phases:
  - name: eval-learn-aggregate         # required, non-empty, SAFE slug
    when: housekeeping                  # housekeeping | session-end | both (default: session-end)
    command: npm run eval:aggregate     # required; run verbatim — NO interpolation from records
    mode: hard                          # warn | hard | off (default: warn)
    review: docs/eval/last-run.md       # optional; SAFE path; default null
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | — (required) | Phase identifier. Must match `^[A-Za-z0-9._-]+$` (SAFE slug — no spaces, no shell metacharacters). A record missing `name` or carrying an unsafe `name` is dropped with a stderr WARN. |
| `when` | string (`housekeeping` \| `session-end` \| `both`) | `session-end` | Trigger gate against STATE.md `session-type`. `housekeeping` ⇒ only housekeeping sessions; `session-end` ⇒ every non-housekeeping session-type; `both` ⇒ all. Invalid values fall back SILENTLY to `session-end`. |
| `command` | string | — (required) | Shell command run verbatim via Bash. NO value from any record is interpolated. Rejects shell metacharacters (`; $ \` \| & > <`); records with an unsafe `command` (or missing `command`) are dropped with a stderr WARN. |
| `mode` | string (`warn` \| `hard` \| `off`) | `warn` | `off` skips the phase. `warn` runs + reports in the Final Report but never blocks. `hard` + non-zero exit code BLOCKS the close (AskUserQuestion: Fix / Override+log Deviation / Abort). Invalid values fall back SILENTLY to `warn`. **Note:** the blocking value is `hard`, not `strict` — unlike `vault-sync`/`drift-check` (see #217). |
| `review` | string \| null | `null` | Optional repo-relative or absolute file path the coordinator reads as a review step after the command. SAFE-path validated (`^[A-Za-z0-9._~/-]+$`); an unsafe path drops the whole record with a stderr WARN. |

**Security note.** Like the mandatory `test-command` / `typecheck-command` / `lint-command`, a `custom-phases[].command` is executed by the shell and is therefore a command-bearing surface. It is acceptable under the same **VCS-trust-anchor** model: any change to `custom-phases` is commit-gated and visible in `git log` for review. The parser additionally rejects shell metacharacters in `command`/`review`/`name` as a defense-in-depth layer. See `.claude/rules/quality-gates-autofix.md` § "Session Config Command Injection (RCE via shell: true)".

Read by: `scripts/lib/config/custom-phases.mjs` (parser), `skills/session-end/SKILL.md` Phase 2.5 (executor + routing).

**This repo's committed phases.** Two `archive-closed-*` phases are declared in `CLAUDE.md`, both `when: both`, `mode: warn`, both driven by the same generic `scripts/archive-closed-prds.mjs` (archive docs of closed Epics/Issues into the Meta-Vault; fail-closed — skips on unclear Epic state):

- `archive-closed-prds` (#782, Epic #774) — `node scripts/archive-closed-prds.mjs --apply` — archives `docs/prd/` PRDs (defaults).
- `archive-closed-plans` (#786) — `… --apply --prd-dir docs/plans --vault-subdir 01-projects/session-orchestrator/plans` — archives `docs/plans/` executable-plan artefacts of closed features/Epics. The plan's tracking `#NNN` (inline in the plan's `Source:` header, see `skills/write-executable-plan/`) is the anchor this phase reads; a plan with no `#NNN` is never archived (fail-closed `no-epic-ref`).

## Evolve Extra Sources (#638)

Opt-in EXTRA learning sources for `/evolve`. A domain measurement (e.g. an eval-learn regression harness) runs OUT-OF-BAND and writes a sidecar JSON of regression flags; `/evolve` then READS each declared sidecar and emits a `domain-regression` learning candidate per flag that has persisted across ≥2 consecutive sessions. This is a strict **read-only consumption contract**: `/evolve` never runs the domain measurement — it only consumes the sidecar output. Absent/empty ⇒ `[]` ⇒ no extra sources are read; existing `/evolve` runs are unaffected.

The block is a nested YAML list under a top-level `evolve` key with an `extra-sources` sub-key. The returned config value is exposed as the dotted key `evolve.extra-sources` (mirroring the `cross-repo.projects` precedent), defaulting to `[]`:

```yaml
evolve:
  extra-sources:
    - path: eval/learn/reports/latest.json   # required; SAFE path
      kind: regression-flags                  # enum: regression-flags
      learning-type: domain-regression        # enum: domain-regression
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | — (required) | Repo-relative or absolute path to the sidecar JSON. SAFE-path validated (`^[A-Za-z0-9._~/-]+$`); a record missing `path` or carrying a shell-metacharacter in `path` is dropped with a stderr WARN. The sidecar is schema-gated by `/evolve` against `{ flags: [{ metric, baseline, recent, delta }] }`; an unknown/missing schema ⇒ skip + WARN. |
| `kind` | string (`regression-flags`) | `regression-flags` | Selects the sidecar parser. Only `regression-flags` is defined; an unknown value DROPS the entry with a stderr WARN (schema gate — `/evolve` never guesses a parser). |
| `learning-type` | string (`domain-regression`) | `domain-regression` | Stamps the emitted learning candidate's `type`. Only `domain-regression` is registered (in `LEARNING_TTL_DAYS` and `PROPOSAL_TYPES`); an unknown value DROPS the entry with a stderr WARN. |

**Security note.** `path` is a read-only file path consumed by `/evolve`; it rejects shell metacharacters as a defense-in-depth layer. Confinement at the read sink is the actual path-traversal guard. Changes are commit-gated under the same **VCS-trust-anchor** model as the other path/command-bearing keys.

Read by: `scripts/lib/config/evolve.mjs` (parser), `skills/evolve/SKILL.md` Step 3.1b (read + emit).

## Reconcile (#693 / #696 / #697)

Opt-in configuration for the learning→conditional-rule reconciliation engine (Epic #693). When enabled, the reconciliation engine runs at session-end Phase 3.6.8 and proposes new `.claude/rules/` entries derived from accumulated learnings. The proposal is always operator-AUQ-gated — rules are **never** auto-applied. FA3 (#696) delivers proposals via `AskUserQuestion`; FA4 (#697) adds the guardrail config block documented here. When `enabled: false` (the default), Phase 3.6.8 is a silent no-op and the engine never runs.

All fields live under a top-level `reconcile` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
reconcile:
  enabled: false           # opt-in; Phase 3.6.8 is a no-op when false
  mode: warn               # warn | off
  targets: [repo-local]    # where approved rules are written
  rule-expiry-days: null   # null = per-type TTL (default 60d via deriveExpiresAt)
  confidence-floor: 0.5    # min learning confidence before a learning is eligible
  min-rule-days: 7         # floor on emitted expires-at so a rule is never born-dead
  min-insight-chars: 24    # reject placeholder/minimal insights before rule conversion
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `reconcile.enabled` | boolean | `false` | Master toggle. When `false`, session-end Phase 3.6.8 is a silent no-op — the reconciliation engine never runs. When `true`, the engine evaluates learnings that meet `confidence-floor` and presents rule proposals to the operator via `AskUserQuestion`. Rules are never written without explicit operator approval. Epic #693 FA3 (#696). |
| `reconcile.mode` | string (`warn` \| `off`) | `warn` | Advisory posture. `warn`: proposals surface in the session-end AUQ and the operator may accept or reject each one; accepted proposals are written to `targets`. `off`: advisory surface is suppressed entirely (equivalent to `enabled: false` for the AUQ step, but Phase 3.6.8 may still emit metrics). In both modes, rules are **never** auto-applied — every write is operator-AUQ-gated. |
| `reconcile.targets` | string[] | `["repo-local"]` | Where approved rules are written. `repo-local` (v1) maps to `.claude/rules/` in the current repository. This is the rule-write location — it is NOT issue-state or label sync. Future values may include `baseline` (global baseline rules) or `global` (cross-repo). |
| `reconcile.rule-expiry-days` | integer \| null | `null` | Optional override for the TTL stamped into each generated rule's `expires-at` frontmatter. **Default is `null`** — when null or absent, the engine uses per-type TTL (`deriveExpiresAt`, default 60 days). Setting this to a positive integer N forces a flat N-day expiry for all proposals in this repo, overriding per-type TTL. CRITICAL: the default must remain `null` to preserve per-type TTL behaviour; a non-null committed default would silently force flat expiry. |
| `reconcile.confidence-floor` | float | `0.5` | Minimum learning confidence (0.0..1.0) required before a learning is eligible for a rule proposal. Learnings with `confidence < confidence-floor` are skipped by the engine. Bounds: `0.0 ≤ value ≤ 1.0`; out-of-range values silently fall back to `0.5`. Set to `0.0` to surface proposals for all learnings regardless of confidence. |
| `reconcile.min-rule-days` | integer | `7` | Floor (in days) applied to the emitted rule's `expires-at` — issue #741.1. A learning close to its natural per-type TTL expiry could otherwise generate a rule that expires almost immediately ("born-dead"); `computeExpiresAt()` (`scripts/lib/reconcile/emitter.mjs`) floors the result at `now + min-rule-days` so an approved rule always has at least this many days of active life. Mirrors the hardcoded `MIN_RULE_DAYS_DEFAULT` constant in the emitter. Bounds: positive integer; non-finite or ≤0 values fall back to the default. |
| `reconcile.min-insight-chars` | integer | `24` | Minimum `insight` length (characters) required before a learning is eligible for rule conversion — issue #741.2. Opt-in and additive to the always-on placeholder/empty-insight rejection in `classifyLearning()` (`scripts/lib/reconcile/eligibility.mjs`): a non-empty but too-short insight (e.g. a stub or a recovery placeholder) is rejected with reason `placeholder-insight` before it reaches proposal generation. Set to `0` to disable the length check (only the always-on empty/placeholder-regex check applies). |

### Never-always-on invariant

Generated rules carry a `globs:` frontmatter key (path-scoped conditional loading) and are **never** emitted with `always-on: true`. The engine throws if a proposal would produce an always-on rule — this is an FA3 invariant enforced in `scripts/lib/reconcile/emitter.mjs`. Background: always-on rules accumulate in the coordinator context regardless of path scope and count toward the instruction-budget ceiling (`instruction-budget.ceiling`, issue #687 / see [Instruction Budget](#instruction-budget-687) above). Allowing the reconciler to generate always-on rules would be a vector for unchecked instruction-budget growth.

### Cross-references

- Engine: `scripts/lib/reconcile/` (eligibility, emitter, renderer, idempotency, engine)
- Session-end Phase 3.6.8: `skills/session-end/SKILL.md` — gated on `reconcile.enabled: true`
- Resolver: `scripts/lib/config/reconcile.mjs`
- `/reconcile` command: `skills/reconcile/SKILL.md` (on-demand invocation)
- Epic #693 (reconciliation engine umbrella), FA3 #696 (advisory delivery), FA4 #697 (guardrails + this config block)
- Issue #741.1 (`min-rule-days` born-dead floor) / #741.2 (`min-insight-chars` placeholder gate)
- Instruction-budget guard: [Instruction Budget](#instruction-budget-687) (`instruction-budget.ceiling`, issue #687) — the never-always-on invariant protects this ceiling from reconciler-driven growth
- Rule-authoring cross-reference: [`docs/rule-authoring.md`](rule-authoring.md#learning-type-taxonomy-ttl--provenance-standard-issue-723-b6--733) § "Learning Type-Taxonomy, TTL & Provenance Standard" — the type-taxonomy registry these config keys tune

**Used by:** `scripts/lib/config/reconcile.mjs` (parser), `scripts/lib/reconcile/engine.mjs` (engine), `skills/session-end/SKILL.md` Phase 3.6.8.

## STATE.md Schema §Recommendations (v1.1)

> Added by Epic #271 Phase A (issues #272–#275). **Additive** — `schema-version` remains `1`. Absence of all 5 fields is a valid `schema-version: 1` STATE.md meaning "no recommendation available" (pre-v1.1 compatibility). Readers MUST treat missing fields identically to explicit nulls.

Session-end Phase 3.7a is the **only writer** of these fields. Session-start Phase 1.5 is the reader (renders a one-line banner on `status: completed`). Phase B Mode-Selector (planned) will consume these fields as its primary input.

### Fields

| Field | Type | Value range | Description |
|-------|------|-------------|-------------|
| `recommended-mode` | string | `housekeeping` \| `feature` \| `deep` \| `discovery` \| `evolve` \| `plan-retro` | v0 heuristic output: suggested mode for the next session. |
| `top-priorities` | integer[] | 0–5 entries | Carried-over issue IIDs, pre-sorted (priority:critical/high first, FIFO tiebreak). |
| `carryover-ratio` | float | `0.00`–`1.00` | `carryover_count / planned_issues` (0 when planned=0). Rounded to 2 decimals. |
| `completion-rate` | float | `0.00`–`1.00` | `completed_issues / planned_issues`. Rounded to 2 decimals. |
| `rationale` | string | ≤ 120 chars, single line | Which v0 rule branch fired (e.g. `"v0: completion <50% → retro"`). |

### Example frontmatter

```yaml
---
schema-version: 1
session-type: deep
branch: main
issues: [272, 273, 274, 275]
started_at: 2026-04-24T18:10:00+02:00
status: completed
current-wave: 5
total-waves: 5
recommended-mode: feature
top-priorities: [278, 283, 285]
carryover-ratio: 0.00
completion-rate: 1.00
rationale: "v0: default clean completion"
---
```

### v0 heuristic (deterministic)

Evaluated in order; first match wins:

1. `completion_rate < 0.50` → `plan-retro` (rationale: `v0: completion <50% → retro`)
2. `carryover_ratio >= 0.30` → `deep` (rationale: `v0: carryover ≥30% → deep`)
3. otherwise → `feature` (rationale: `v0: default clean completion`)

Implementation: `scripts/lib/recommendations-v0.mjs` → `computeV0Recommendation()`. Deterministic — same inputs always produce same output. Phase B will replace this with a learnings-driven selector; the contract (5 fields, same types) stays stable.

### Backward compatibility

- Pre-v1.1 STATE.md files (produced by sessions before Epic #271 shipped) simply do not contain these fields. The parser returns `null` from `parseRecommendations`; the banner silently no-ops.
- `schema-version` is NOT bumped to `1.1` in the frontmatter — the existing `schema-version: 1` remains canonical. The v1.1 label is documentation-only, describing the additive surface.
- Idle Reset (session-start Phase 1.5) archives these fields into the `## Previous Session` body block of STATE.md as a human-readable block, then removes them from the frontmatter — so a fresh session never inherits stale recommendations in its live frontmatter.

### Reader behavior

The banner renders with one of the following shapes:

- **All 5 fields present, `top-priorities` non-empty:**
  ```
  📋 Previous session recommended: deep — v0: carryover ≥30% → deep (completion: 85%, carryover: 40%)
    Suggested issues: #272, #273, #274
  ```
- **All 5 fields present, `top-priorities` empty:** banner line only (no "Suggested issues" line).
- **Partial fields (1–4 present):** banner still renders; missing numeric fields display as `—`; WARN event `state-md-partial-recommendation` written to `.orchestrator/metrics/sweep.log`.
- **`top-priorities` type-mismatch** (not an array): field treated as null; WARN `state-md-type-mismatch` written to sweep.log; other fields still render.
- **Unknown `recommended-mode`:** banner shows `(unknown-mode)` instead of the string.
- **Pre-v1.1 STATE.md (no fields at all):** silent no-op, no banner, no WARN.

### Consumer cross-reference

- **Writer:** `skills/session-end/SKILL.md` § Phase 3.7a "Compute and Write Recommendations" (runs after Phase 3.7 sessions.jsonl write, before Phase 3.4 `status: completed` setting).
- **Reader:** `skills/session-start/SKILL.md` § Phase 1.5 "Recommendations Banner" (renders on `status: completed` branch only).
- **Archival:** `skills/session-start/SKILL.md` § Idle Reset rule 6 (removes fields from frontmatter, prepends readable block to `## Previous Session`).
- **Future consumer:** Phase B Mode-Selector skill (planned in Epic #271) will read these fields as the primary input for autonomous mode selection.

## Frontend-Slop Hook (#684)

Opt-in configuration for the frontend-slop detector hook. When enabled, the `PostToolUse` hook runs the deterministic frontend-slop detector (`scripts/lib/frontend-detect/detect.mjs`) on a UI file right after it is edited and surfaces findings as a `hookSpecificOutput.additionalContext` roll-up. **Warn-only / non-blocking** — it never blocks an edit. The Hook Runtime Profile Control gate (below) also applies, so the hook can be silenced via the standard profile env-vars even when `enabled: true`. Default OFF — opt-in by design (unlike `loop-guard`, which defaults on). Epic #684 P1.

All fields live under a top-level `frontend-slop-hook` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`):

```yaml
frontend-slop-hook:
  enabled: false           # opt-in; PostToolUse warn-only / non-blocking
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `frontend-slop-hook.enabled` | boolean | `false` | Master toggle for the frontend-slop PostToolUse hook. Only an explicit `enabled: true` enables it; any other value (or an absent block) resolves to disabled. When `true`, the hook fires after `Edit`/`Write`/`MultiEdit` on UI files, runs the deterministic detector, and emits findings as `additionalContext` (warn-only, never blocks). Profile-gate also applies. Issue #684. |

**Used by:** `hooks/post-tooluse-frontend-slop.mjs` (parser/loader: `scripts/lib/config/frontend-slop-hook.mjs`).

**Cross-reference:** detector rule markers (`<!-- rule:<id> -->`) live in `.claude/rules/frontend.md` (Absolute Bans / Motion / Layout sections). Mirrors the opt-in / default-on contrast against `loop-guard`.

## Loop Guard (#619)

Always-on `PostToolUse` guard that maintains a per-session ring buffer of recent `{tool, argsHash}` pairs and injects an `additionalContext` loop-warning when the same (tool + args) call recurs `threshold` or more times within the last `window` tool calls. Warn-only / non-blocking — it never stops a tool call, it only surfaces a hint. The Hook Runtime Profile Control gate (below) also applies, so the hook can be silenced via the standard profile env-vars even when `enabled: true`. Default ON — the contrast case for `frontend-slop-hook` (above), which defaults off.

All fields live under a top-level `loop-guard` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
loop-guard:
  enabled: true                        # on by default; warn-only, non-blocking; profile-gate also applies
  threshold: 3                         # identical (tool+argsHash) calls within window before a loop-warning fires
  window: 5                            # ring-buffer size (recent tool calls tracked per session)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `loop-guard.enabled` | boolean | `true` | Master toggle. Only an explicit `enabled: false` disables the hook — any other value (or an absent `enabled` line inside a present block) leaves it on. |
| `loop-guard.threshold` | integer (≥ 2) | `3` | Number of identical `{tool, argsHash}` calls within `window` before a loop-warning fires. Non-integer or below-minimum values fall back to the default. |
| `loop-guard.window` | integer (≥ 2) | `5` | Ring-buffer size — how many recent tool calls are tracked per session. Non-integer or below-minimum values fall back to the default. Self-healing clamp: a `window` smaller than `threshold` is silently widened to `threshold` (a shorter ring could never recur `threshold` times, so the guard would never fire). |

**Used by:** `hooks/loop-guard.mjs`, `scripts/lib/config/loop-guard.mjs` (`_parseLoopGuard`). Issue #619.

## Config Protection (#622)

`PreToolUse` `Edit`/`Write` guard that intercepts edits to a small allow-list of quality-gate config files (eslint, vitest, tsconfig, prettier, commitlint, gitleaks) and warns — or, in `strict` mode, blocks — when an edit LOOSENS a gate (a threshold lowered, a disable/ignore directive added, a rule removed, a gitleaks allowlist widened, tsconfig strictness relaxed). The edit-tool analogue of the test-the-mock gate-cheating anti-pattern (see `.claude/rules/testing.md`). First-time file creation, tightening edits, and neutral edits are always allowed regardless of mode.

All fields live under a top-level `config-protection` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
config-protection:
  enabled: true                        # PreToolUse guard: warn when an Edit/Write loosens a quality gate
  mode: warn                           # warn (stderr + event, exit 0) | strict (block loosening edits, exit 2)
allow-config-weakening: false          # per-session bypass (mirrors allow-destructive-ops); top-level, NOT nested under config-protection
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `config-protection.enabled` | boolean | `true` | Master toggle. Only an explicit `enabled: false` disables the guard — any other value (or an absent `enabled` line inside a present block) leaves it on. |
| `config-protection.mode` | `warn` \| `strict` | `warn` | `warn` emits a stderr message + an event, exit code 0 (never blocks). `strict` blocks the loosening `Edit`/`Write` with exit code 2. Any value other than `strict` resolves to `warn`. |
| `allow-config-weakening` | boolean | `false` | Top-level key (NOT nested under `config-protection`) — a per-session bypass mirroring `allow-destructive-ops`. When `true`, the guard is bypassed for the entire session — for intentional config-weakening changes (e.g. deliberately relaxing a rule as planned work). |

**Used by:** `hooks/config-protection.mjs`, `scripts/lib/config/config-protection.mjs` (`_parseConfigProtection`, `_isConfigWeakeningAllowed`). Issue #622.

## Instruction Budget (#687)

Always-on directive-budget banner. At session-start Phase 4 the probe (`scripts/lib/instruction-budget-guard.mjs`, `checkInstructionBudget`) sums the structural directives (bullets, ordered items, headings ≥ depth 2 — fenced code and YAML frontmatter excluded) across the always-on `.claude/rules/*.md` files (membership delegated to `rule-loader.mjs`; glob-scoped rules excluded) and renders a **warn-only / non-blocking** banner when the total **exceeds** `ceiling`. It is a *growth-ratchet*: the current baseline (~457 structural directives across 11 always-on rules) sits under the default ceiling of `480`, so the banner is silent today and only fires when NEW always-on directives push the count over the ceiling — "mechanism over discipline". Default ON (this is a guard, not an opt-in feature) — set `enabled: false` or `mode: off` to silence it.

All fields live under a top-level `instruction-budget` object inside the `## Session Config` block of your host file (`CLAUDE.md` or `AGENTS.md`):

```yaml
instruction-budget:
  enabled: true            # default on (growth-ratchet guard)
  ceiling: 480             # structural-directive ceiling
  mode: warn               # warn (surface banner) | off (silent no-op)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `instruction-budget.enabled` | boolean | `true` | Master toggle. `false` → the Phase 4 probe returns `null` (no banner). Default on because this is a structural-drift guard, not an opt-in feature. Issue #687. |
| `instruction-budget.ceiling` | integer | `480` | Structural-directive ceiling. The banner fires only when the always-on count **strictly exceeds** this. The default `480` is an operator-chosen ratchet just above the ~457 baseline, leaving headroom for normal edits while catching unchecked growth. A config value `≤ 0` falls back to the default. |
| `instruction-budget.mode` | `warn` \| `off` | `warn` | `warn` surfaces the banner alongside the other Phase 4 banners; `off` is a silent no-op (equivalent to `enabled: false`). Any value other than `off` resolves to `warn`. |

**Behaviour on config-load failure:** if no instruction file is found (or it is unreadable), the probe falls back to `{ enabled: true, ceiling: 480, mode: warn }` and still computes — graceful, like the other session-start probes. The wrapper never throws.

**Why a ratchet, not in-repo glob-respecting injection:** the Claude Code harness injects ALL `.claude/rules/*.md` into the coordinator context regardless of each rule's `globs:` frontmatter (`rule-loader.mjs` governs only the PER-WAVE surface). The repo cannot make the harness respect `globs:` for coordinator injection — see "Instruction-Budget Mechanism — Coordinator-Injection Verdict" (#687; archived in the private Meta-Vault). The directive-budget ratchet is therefore the one in-repo, mechanism-over-discipline lever; physically trimming/merging rule files is tracked separately in #688.

**Used by:** session-start Phase 4 (`skills/session-start/SKILL.md`). Probe: `scripts/lib/instruction-budget-guard.mjs`.

## Hook Runtime Profile Control (#211)

Control which hooks run at runtime via environment variables — no settings-file edits required.

### Environment variables

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `SO_HOOK_PROFILE` | `full` \| `minimal` \| `off` | `full` | Preset bundle that enables/disables groups of hooks. |
| `SO_DISABLED_HOOKS` | Comma-separated hook names | _(none)_ | Disable individual hooks regardless of profile. |

### Profile bundles

| Profile | Enabled hooks |
|---------|--------------|
| `full` | All hooks (default — no behaviour change when env unset) |
| `minimal` | `on-session-start`, `pre-bash-destructive-guard` only |
| `off` | No hooks |

### Precedence

`SO_DISABLED_HOOKS` takes precedence over `SO_HOOK_PROFILE` for the listed names. Unknown `SO_HOOK_PROFILE` values fall back to `full` with a single stderr warning.

### Examples

```bash
# Disable all hooks for a quick one-shot run
SO_HOOK_PROFILE=off claude ...

# Keep only the safety guard active
SO_HOOK_PROFILE=minimal claude ...

# Disable only the typecheck-on-save hook, keep everything else
SO_DISABLED_HOOKS=post-edit-validate claude ...

# Disable two hooks independently
SO_DISABLED_HOOKS=enforce-scope,enforce-commands claude ...
```

### Hook name reference

| Hook name | hooks.json event |
|-----------|-----------------|
| `on-session-start` | SessionStart |
| `pre-bash-destructive-guard` | PreToolUse/Bash |
| `enforce-commands` | PreToolUse/Bash |
| `enforce-scope` | PreToolUse/Edit\|Write |
| `post-edit-validate` | PostToolUse/Edit\|Write |
| `on-stop` | Stop + SubagentStop |

### Implementation

Each hook handler imports `shouldRunHook` from `hooks/_lib/profile-gate.mjs` at the top level and calls `process.exit(0)` immediately when gated off. The exit is silent (no stdout, no stderr), so Claude Code sees an allow as if the hook had never run.

## Webhooks (#228)

Opt-in webhook notifications delivered by `scripts/lib/webhook-url.mjs`. The helper centralizes URL resolution so no personal-domain default ever silently fires — callers must supply a URL explicitly.

### Resolution order

For every supported kind the resolver checks sources in this order; the first non-empty string wins:

1. **Environment variable** `SO_WEBHOOK_<KIND>_URL` — uppercase kind, hyphens → underscores  
   e.g. `SO_WEBHOOK_SLACK_URL`, `SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL`
2. **Session Config** `webhooks.<kind>.url`
3. **Error** — `WebhookConfigError` is thrown. No silent personal-domain fallback.

### Supported kinds

| Kind | Env variable | Config key |
|------|-------------|------------|
| `slack` | `SO_WEBHOOK_SLACK_URL` | `webhooks.slack.url` |
| `discord` | `SO_WEBHOOK_DISCORD_URL` | `webhooks.discord.url` |
| `generic` | `SO_WEBHOOK_GENERIC_URL` | `webhooks.generic.url` |
| `gitlab-pipeline-status` | `SO_WEBHOOK_GITLAB_PIPELINE_STATUS_URL` | `webhooks.gitlab-pipeline-status.url` |

### Session Config example

```yaml
webhooks:
  slack:
    url: https://hooks.slack.com/services/REDACTED/REDACTED/REDACTED
  discord:
    url: https://discord.com/api/webhooks/REDACTED/REDACTED
  generic:
    url: https://example.com/hooks/session-events
  gitlab-pipeline-status:
    url: https://gitlab.example.com/hooks/pipeline
```

### Clank Event Bus (events.mjs / on-stop.mjs)

The internal Clank Event Bus webhook is controlled by two environment variables:

| Variable | Purpose |
|----------|---------|
| `CLANK_EVENT_SECRET` | Bearer token. **Required** — if absent, no POST is made. |
| `CLANK_EVENT_URL` | Target base URL. **Required** — if absent, no POST is made (no personal-domain default). |

Both variables must be set for the fire-and-forget POST to fire. Setting only `CLANK_EVENT_SECRET` without `CLANK_EVENT_URL` is a safe no-op.

## Express Path (#214)

Codified coordinator-direct flow for housekeeping and simple single-issue sessions. When the express path activates, session-start Phase 8.5 skips the full 5-wave plan decomposition and runs all tasks directly as the coordinator — no subagents dispatched, no inter-wave checkpoints.

> **Historical context:** The 13 coordinator-direct sessions documented in the project `CLAUDE.md` (2026-04 series: vault-mirror GH#31, phased-rollout #307, v3.2.0 release, Architecture-DDD-Trio, etc.) were running this pattern implicitly without a codified path. Issue #214 codifies it so that future housekeeping sessions gain the express path automatically without needing to know to opt in manually.

All fields live under a top-level `express-path` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
express-path:
  enabled: true   # default true; set false to always use the full 5-wave flow
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `express-path.enabled` | boolean | `true` | When `true`, session-start Phase 8.5 evaluates the express-path activation conditions. When `false`, the evaluation is skipped and the full session-plan 5-wave flow always runs. |

### Activation conditions

All three conditions must be true simultaneously for the express path to activate:

1. `express-path.enabled: true` (default)
2. Session type is `housekeeping` (confirmed in session-start Phase 8 Q&A)
3. Agreed issue scope is ≤ 3 issues AND no parallel agents are required

When any condition is false, the full 5-wave flow runs as before — the check is a transparent no-op.

### What changes when express path is active

- **session-start:** After Phase 8 Q&A, emits `"Express path activated — N tasks, coordinator-direct, no inter-wave checks."` banner and executes tasks directly as the coordinator. session-plan is called but receives the express-path signal.
- **session-plan:** Detects the banner in conversation context and emits a minimal 1-wave `coordinator-direct` plan (0 agents dispatched). Skips all role decomposition, complexity scoring, and wave splitting.
- **STATE.md:** Activation is logged in the `## Deviations` section for traceability.
- **Inter-wave checkpoints:** Skipped entirely — no Discovery → Impl-Core → Quality pipeline.

### When to disable

Set `express-path.enabled: false` when:

- You want all housekeeping sessions to go through the standard quality-gate pipeline (Discovery + Quality waves).
- The session involves ≥ 4 issues (the scope check already prevents activation, but disabling makes the intent explicit).
- You are running an automated `/autopilot` loop and want predictable wave counts across session types.

### Condition matrix

| Session type | Issue count | `express-path.enabled` | Parallel agents? | Activates? |
|---|---|---|---|---|
| `housekeeping` | 1–3 | `true` | No | **Yes** |
| `housekeeping` | 4+ | `true` | No | No — scope too large |
| `housekeeping` | 1–3 | `false` | No | No — opted out |
| `feature` | 1–3 | `true` | No | No — not housekeeping |
| `housekeeping` | 1–3 | `true` | Yes | No — parallel agents required |

**Related skills and files:**
- `skills/session-start/SKILL.md` — Phase 8.5: Express Path Evaluation (activation logic + banner)
- `skills/session-plan/SKILL.md` — Express Path Short-Circuit section (1-wave plan emission)
- GitLab issue `#214` (foundation and codification)

## Autopilot Multi-Story (#431)

Opt-in configuration for `autopilot --multi-story` (`scripts/autopilot-multi.mjs`). Controls how parallel story pipelines are isolated when N stories run concurrently. Projects that do not use `--multi-story` leave this block unset and are unaffected.

All fields live under a top-level `autopilot` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
autopilot:
  bg-isolation: worktree   # worktree | none (default: worktree)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autopilot.bg-isolation` | `worktree` \| `none` | `worktree` | Isolation mode for concurrent story pipelines. `worktree` (default): each story creates its own git worktree — safe for parallel writes, costs disk space and EnterWorktree latency. `none`: no worktrees; sub-sessions spawn directly in the main working tree — faster for monorepos with heavy build state but requires explicit file-scope deconfliction (see below). |

**`bg-isolation: none` hard-error guard:** when `bg-isolation: none` AND `--max-stories > 1`, `autopilot-multi` requires `--deconflict-paths=<glob>` on the CLI to confirm that per-story file ownership is planned. Omitting the flag exits with code 1. This enforces the parallel-session discipline defined in `.claude/rules/parallel-sessions.md` PSA-001/002/003 — two agents editing the same file in the main tree simultaneously will corrupt each other's work.

**Feature introduced by:** GitLab issue #431 (CC 2.1.143 `worktree.bgIsolation` changelog adoption). Implementation: `scripts/autopilot-multi.mjs` reads `config?.autopilot?.['bg-isolation']` via `scripts/parse-config.mjs`. Documentation: `skills/autopilot/SKILL.md` § Configuration.

## Persona-Gate Wave (#458)

Opt-in mid-wave hook that dispatches a `/persona-panel`-style review after a configured wave completes (Quality or Impl-Polish). Distinct from `wave-reviewers` (which targets code-oriented reviewer agents like `architect-reviewer` and `qa-strategist`): `persona-gate-wave` dispatches catalog personas from `.claude/personas/` — domain-experts, buyer-personas, and auditors. The two keys are independent; a project may configure both on the same wave without conflict.

When enabled, wave-executor runs `### 3b. Persona-Gate Hook` after the wave's STATE.md update and before the progress summary. The consolidated panel verdict is written to a JSON sidecar under `.orchestrator/persona-panel/<iso>-<runId>.json` (validated against `agents/schemas/persona-panel-sidecar.schema.json`). On `mode: 'strict'` with a non-PROCEED verdict, the operator is prompted via `AskUserQuestion` to proceed, revise the remaining waves, or abort the session.

All fields live under a top-level `persona-gate-wave` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
persona-gate-wave:
  enabled: false               # opt-in; default false preserves existing behavior
  after: quality               # quality | impl-polish — wave name after which to fire
  threshold: "all"             # "M-of-N" | "all" | "N-of-N" — passed to parseThreshold
  personas: []                 # list of persona names from .claude/personas/; empty = all catalog
  dispatch-model: claude-opus-4-7   # alias or full model ID — default 'claude-opus-4-7'
  mode: off                    # off | warn | strict
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persona-gate-wave.enabled` | boolean | `false` | Master toggle. When `false` (or the block is absent), the hook is skipped entirely — wave-executor proceeds from `### 3a` to `### 4` without dispatching personas. |
| `persona-gate-wave.after` | string (`quality` \| `impl-polish`) | `quality` | The wave role after which the hook fires. The hook runs once per session, immediately after the named wave's STATE.md update. |
| `persona-gate-wave.threshold` | string | `"all"` | Voting threshold passed to `parseThreshold()` from `scripts/lib/persona-panel/threshold.mjs`. Accepts `"all"`, `"any"`, or `"M-of-N"` where `1 ≤ M ≤ N ≤ 20`. Example: `"6-of-6"` requires every persona to vote PASS; `"4-of-6"` allows two dissenters. |
| `persona-gate-wave.personas` | string[] | `[]` | Roster of persona names to dispatch. Each entry must match `^[a-z0-9-]{1,64}$` and refer to a persona file under `.claude/personas/<name>.md`. When the list is empty (default), every persona in the catalog is dispatched. |
| `persona-gate-wave.dispatch-model` | string | `claude-opus-4-7` | Model used for each persona agent dispatch. Accepts the same shape as agent frontmatter `model:` — one of `inherit` \| `sonnet` \| `opus` \| `haiku`, or a full model ID like `claude-opus-4-7`. |
| `persona-gate-wave.mode` | string (`off` \| `warn` \| `strict`) | `off` | Behaviour on consolidator result. `off` skips dispatch entirely even when `enabled: true` (silent no-op). `warn` consolidates and logs findings under a `Persona-gate:` bullet in the wave progress update without blocking. `strict` consolidates and on any non-PROCEED verdict prompts the operator via `AskUserQuestion` to proceed-as-is, revise remaining waves, or abort. |

**Validation:**
- An `enabled: true` + `mode: off` combination is degenerate — `parseSessionConfig` emits a single stderr WARN at load time so the operator can spot the configuration drift, but the hook itself is a no-op.
- `threshold` is parsed via `parseThreshold()` at config-load time; a malformed spec (e.g. `"21-of-21"`, `"5/5"`, empty string) raises a precise error before wave-executor even starts.

### When to enable

The canonical use case is the **Buyer-Panel pattern** from a flagship product's W5 hard-gate: six buyer personas evaluate UI/UX work at the end of every Quality wave, with `threshold: "6-of-6"`, `mode: 'strict'`, and `after: 'quality'`. Any dissent pauses the session and surfaces the dissenters' rationale via `AskUserQuestion` before commit — UI changes that would dilute a target persona's experience are caught before they ship.

Enable when:
- Domain or audience perspective is load-bearing for the work (UX, marketing pages, on-boarding flows, persona-specific feature releases).
- Code-level review (`wave-reviewers`) is insufficient — the question is "does this work serve persona X?", not "is the implementation correct?".
- A small, stable set of persona files (2–10) live under `.claude/personas/` and the catalog rarely changes mid-session.

Leave disabled (default) when:
- The project has no persona files or the work is purely infrastructural.
- The wave's deliverable is server-side / backend-only and persona evaluation would be noise.

**Related skills and files:**
- `commands/persona-panel.md` — standalone `/persona-panel` command for ad-hoc panel runs (not gated on `persona-gate-wave.enabled`).
- `skills/persona-panel/SKILL.md` — full skill spec (catalog format, consolidation modes, sidecar shape).
- `skills/wave-executor/wave-loop.md` § 3b — the wave-executor hook contract.
- `agents/schemas/persona-panel-sidecar.schema.json` — sidecar JSON Schema enforced before write.

## Compact Nudge (#620)

Advisory-only checkpoint surfaced at inter-wave boundaries in the wave-executor loop. Never auto-compacts — `/compact` is a user slash-command, and the coordinator/operator decides when to invoke it. When the gate conditions are met, the wave-executor appends ONE advisory bullet to the wave progress update suggesting a `/compact` before the next wave.

All fields live under a top-level `compact-nudge` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
compact-nudge:
  enabled: false                       # opt-in advisory /compact nudge at inter-wave checkpoints (never auto-compacts)
  after: [discovery, impl]             # wave boundaries that may fire the nudge — subset of {discovery, impl, failed-wave}
  mode: warn                           # warn (surface one bullet in the wave progress update) | off (silent no-op)
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `compact-nudge.enabled` | boolean | `false` | Master toggle. When `false` (or the block is absent), the nudge never fires — zero behaviour change. |
| `compact-nudge.after` | list of `"discovery"` \| `"impl"` \| `"failed-wave"` | `[discovery, impl]` | Wave boundaries that may fire the nudge. `discovery`/`impl` are wave ROLES, matched against the just-completed wave's role string. `failed-wave` is not a role — it keys off the wave's failure OUTCOME (any wave that did not pass its quality gate), so it can fire after a wave of any role. |
| `compact-nudge.mode` | `warn` \| `off` | `warn` | `warn` emits the advisory bullet in the wave progress update. `off` is a silent no-op even when `enabled: true`. |

**Used by:** `skills/wave-executor/wave-loop.md` § 3c "Strategic Compact-Nudge". Issue #620. See `.claude/rules/loop-and-monitor.md` for the broader `/loop` vs `/goal` vs Monitor routing this nudge composes with.

## Goal Integration (#636)

Opt-in advisory continuation anchor that surfaces a suggested `/goal` command at named seams — the inter-wave fix-loop (`inter-wave-fixloop`) and the session-end backlog drain (`session-end-backlog`). Never auto-invokes `/goal`, never blocks forward progress; `/goal` remains a user slash-command the operator chooses to run. Per ADR-0010, `/goal` provides CONTINUATION, never JUDGMENT — the suggested condition always references freshly-run deterministic gate output and embeds a bound (e.g. "or stop after N attempts"); the exit-code result of the underlying gate stays the authority.

All fields live under a top-level `goal-integration` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
goal-integration:
  enabled: false                       # opt-in advisory; default off — zero behaviour change when absent
  seams: [session-end-backlog, inter-wave-fixloop]   # subset of {session-end-backlog, inter-wave-fixloop}; one goal per session — pick ONE seam at a time
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `goal-integration.enabled` | boolean | `false` | Master toggle. When `false` (or the block is absent), no `/goal` suggestion is ever surfaced — zero behaviour change. |
| `goal-integration.seams` | list of `"session-end-backlog"` \| `"inter-wave-fixloop"` | `[session-end-backlog, inter-wave-fixloop]` | Which seam(s) may surface the advisory `/goal` suggestion. Only ONE `/goal` can be active per session — if both seams are listed, the operator picks a single seam to actually invoke; the two cannot hold simultaneous active goals. |

**Used by:** `skills/wave-executor/wave-loop.md` § "/goal Continuation Anchor" (inter-wave-fixloop seam), `skills/session-end/SKILL.md` § 1.3a "Optional /goal Backlog-Drain" (session-end-backlog seam). Lever 5 / issue #636. See `.claude/rules/loop-and-monitor.md` § LM-008 for the full continuation-vs-judgment contract.

## Skill Evolution (#646)

Opt-in configuration for the Skill Self-Evolution Foundation (Epic #643, Sub-issue #646). Controls whether `/evolve` surfaces skill health signals for operator review only (`advisory`) or additionally applies deterministic repairs to local config artifacts behind an evidence gate (`autonomous-gated`). The default is `off` — no behavior change for repos that omit this block.

All fields live under a top-level `skill-evolution` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
skill-evolution:
  autonomy: off            # off | advisory | autonomous-gated — default off (opt-in)
  evidence-floor: 0.5      # float 0.0..1.0 — min evidence before autonomous-gated repair acts
  judge: false             # opt-in session-end LLM-judge for advisory L3; default false
  judge-budget-tokens: 8000 # token budget for the L3 judge dispatch; default 8000
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `skill-evolution.autonomy` | string (`off` \| `advisory` \| `autonomous-gated`) | `off` | Master autonomy mode. `off`: feature inactive, no skill-health signals surfaced. `advisory`: `/evolve` surfaces a session-end skill-health summary (D-token rollup, telemetry gaps, A/B experiment deltas) for operator review — no automated edits. `autonomous-gated`: surfaces the advisory summary AND applies repairs that clear the `evidence-floor` gate to the repo's own local config artifacts (Session Config fields, local skill overrides). Plugin-level and remote skill repairs are always MR-only regardless of this setting. |
| `skill-evolution.evidence-floor` | float | `0.5` | Minimum evidence score (0.0..1.0) required before an `autonomous-gated` repair is applied without operator confirmation. Repairs below the floor are surfaced as advisory suggestions only. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. Only evaluated when `autonomy: autonomous-gated`. |
| `skill-evolution.judge` | boolean | `false` | When `true`, session-end (Phase 3.6.6) dispatches a bounded **read-only** haiku LLM-judge that reads the transcript tail and emits advisory per-skill `applied`/`completed` judgments (L3). The judge RETURNS JSON; the coordinator writes the `.orchestrator/metrics/skill-judgments.jsonl` sidecar (#614-safe — the read-only agent never writes its own sidecar). Adds one subagent call per session-end when enabled. Advisory only — every judgment carries a schema-enforced `advisory: true` and provably cannot reach a C2 repair gate. |
| `skill-evolution.judge-budget-tokens` | integer | `8000` | Token budget for the L3 judge dispatch (`runSkillJudge`). The budget gate fires BEFORE dispatch: if the built prompt's estimated input exceeds this, the judge is skipped (`status: budget-exceeded`) rather than truncated. Non-positive or non-integer values silently fall back to `8000`. Only evaluated when `judge: true`. |

**Used by:** `skills/evolve/SKILL.md` (skill-health summary step), `scripts/lib/config/skill-evolution.mjs` (parser), `scripts/lib/skill-judge.mjs` (L3 judge), `scripts/lib/skill-judgments-schema.mjs` (sidecar schema), `skills/session-end/SKILL.md` § Phase 3.6.6 (judge dispatch + coordinator-write).

**Cross-reference:** "Skill Self-Evolution Foundation (OpenSpace-inspired)" (#643; archived in the private Meta-Vault), Sub-issue #646.

**Parity note.** The `skill-evolution:` key is documented in `docs/session-config-template.md` as a **standalone `## Skill Evolution` section** outside the `## Session Config` block — intentionally parity-exempt from `claude-md-drift-check` Check-6. Adding it as a column-0 key inside `## Session Config` would hard-fail every repo with `drift-check.mode: hard` that has not yet adopted the feature.

## Dispatcher Autonomy (#679)

Opt-in configuration for the cross-repo free-repo dispatcher autonomy gate (Epic #673, Sub-issue #679). Controls whether the `/dispatcher` flow runs in advisory mode (surfaces ranked candidates for operator review only) or applies dispatch decisions behind a confidence gate. The default is `off` — fail-closed, no behavior change for repos that omit this block.

All fields live under a top-level `dispatcher-autonomy` object in your Session Config host file (`CLAUDE.md` or `AGENTS.md`), for example:

```yaml
dispatcher-autonomy:
  autonomy: off            # off | advisory | autonomous-gated — default off (fail-closed)
  confidence-floor: 0.5    # float 0.0..1.0 — min confidence before an autonomous-gated dispatch acts
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `dispatcher-autonomy.autonomy` | string (`off` \| `advisory` \| `autonomous-gated`) | `off` | Master autonomy mode. `off`: dispatcher inactive, no cross-repo candidate routing. `advisory`: the dispatcher surfaces ranked free-repo candidates for operator review — no automated dispatch. `autonomous-gated`: surfaces the advisory ranking AND routes dispatches that clear the `confidence-floor` gate. Fail-closed: any invalid/empty value resolves to `off`. |
| `dispatcher-autonomy.confidence-floor` | float | `0.5` | Minimum confidence score (0.0..1.0) required before an `autonomous-gated` dispatch is routed without operator confirmation. Candidates below the floor are surfaced as advisory suggestions only. Bounds: `0.0 ≤ value ≤ 1.0`. Out-of-range values silently fall back to the default. Only evaluated when `autonomy: autonomous-gated`. |

**Used by:** `scripts/lib/config/dispatcher-autonomy.mjs` (parser + `resolveDispatcherAutonomy` resolver), `skills/dispatcher/SKILL.md` (cross-repo dispatch flow).

**Host-local override (#653 pattern).** The effective `autonomy` enum is resolved at config-load time with precedence (highest first): `SO_DISPATCHER_AUTONOMY` env-var > `owner.yaml` `dispatcher.autonomy` (host-local, never committed) > committed `dispatcher-autonomy.autonomy` > `off`. An invalid/empty value at any tier falls through to the next tier — mirroring the `vault-dir` / `baseline-path` host-path resolution layer (`scripts/lib/config/host-paths.mjs`). This keeps a per-host autonomy posture out of the committed Session Config. The pure parser keeps the raw committed value for `claude-md-drift-check` raw-value parity; only the final `loadConfig()` object carries the resolved enum.

**Cross-reference:** "Cross-Repo Vault-Status Mirror + Autopilot Dispatcher" (#673; archived in the private Meta-Vault), Sub-issue #679.

**Parity note.** The `dispatcher-autonomy:` key is documented in `docs/session-config-template.md` as a **standalone `## Dispatcher Autonomy` section** outside the `## Session Config` block — intentionally parity-exempt from `claude-md-drift-check` Check-6 (session-config-parity). Adding it as a column-0 key inside `## Session Config` would hard-fail every repo with `drift-check.mode: hard` that has not yet adopted the feature.

## Defaults

If no `## Session Config` section exists in the platform config host file (`CLAUDE.md` or `AGENTS.md`), skills use: `feature` type, 6 agents, 5 waves, and field-specific defaults listed above.
