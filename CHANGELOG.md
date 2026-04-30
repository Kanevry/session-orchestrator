# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Owner Persona Layer (#161 epic)** — first-run owner.yaml + soul.md template engine + baseline rule (all in-repo).
  - `scripts/lib/owner-yaml.mjs` (184L) — schema, validator, loader, writer, defaults. 5 exports: `OWNER_YAML_PATH`, `validateOwnerConfig`, `loadOwnerConfig`, `writeOwnerConfig`, `getDefaults`. Plain-JS validation (no Zod dep added). 36 tests.
  - `scripts/lib/owner-interview.mjs` (130L) — 5-question interview (language, tone style, output level, preamble, hardware-sharing consent). C4 hardware-sharing consent (#173) merged into question 5; on Yes generates 64-char hex `hash-salt` via `crypto.randomBytes`. Idempotent: skipIfExists default; `force: true` archives to `owner.yaml.bak-<timestamp>`.
  - `scripts/lib/soul-resolve.mjs` (98L) — mustache-style `{{slot}}` resolver. Pure `resolveSoul(template, ownerConfig)` + disk-loading `loadAndResolveSoul(soulPath, opts)`. Falls back to `getDefaults()` silently for missing slots; unknown slots left in place with warning. 10 tests.
  - `skills/session-start/soul.md` + `skills/plan/soul.md` — both now contain `{{owner.language}}`, `{{tone.style}}`, `{{efficiency.output-level}}`, `{{efficiency.preamble}}` slots. Static defaults preserved at module level so resolution never fails.
  - `skills/bootstrap/SKILL.md` — Phase 3.5 (30 lines) documents owner-interview integration. Phase 3.6 = (former 3.5) Rules-Fetch Bridge.
  - `.claude/rules/owner-persona.md` (79L, 7 sections) — documents owner.yaml location, slot system, `--owner-reset` re-trigger, privacy guarantee (path-only, never content).
  - `skills/bootstrap/standard-template.md` S99 step now lists `owner-persona.md` in baseline-fetch manifest.
  - `tests/integration/owner-persona-flow.test.mjs` (15 tests) — end-to-end: interview → write → load → soul resolve.
- **Architecture-DDD-Trio (#309)** — CLAUDE.md narrative bullet added; `skills/discovery/probes-arch.md` confirmed already complete (W1 audit). Cross-repo work (#314, #315) deferred to projects-baseline.
- **Marketplace prep (#213)** — `docs/marketplace/composio-submission.md` (114L) — submission draft for ComposioHQ/awesome-claude-plugins (entry text, 9-row comparison vs maestro-orchestrate + backlog, PR mechanics, risk/fallback path).

### Changed
- **#218 partial port** — 6 top-level .sh scripts ported to .mjs:
  - `scripts/codex-install.mjs` (200L), `scripts/cursor-install.mjs` (90L)
  - `scripts/run-quality-gate.mjs` (155L) — orchestrates 4 variants by spawning existing `gate-*.sh` sub-scripts
  - `scripts/validate-wave-scope.mjs` — replaces stub; preserves all .sh validation rules (path traversal, absolute paths, gates-object check)
  - `scripts/validate-plugin.mjs` (116L) — orchestrates 5 sub-script validators via spawn
  - `scripts/lib/fetch-baseline.mjs` (303L) — named export `fetchBaselineFile(opts)` + CLI mode; native `fetch()`, no new deps; cache fallback for 404/transport (NOT for 401/403)
- **Doc cleanup (#218 sweep)** — README.md, CONTRIBUTING.md, USER-GUIDE.md, codex-setup.md, cursor-setup.md, migration-v3.md, session-config-reference.md, .claude/rules/cli-design.md (Shared Shell Library section rewritten), skills/quality-gates/SKILL.md, skills/session-end/verification-checklist.md, scripts/lib/quality-gates-policy.mjs — 12 files updated to reference .mjs paths instead of .sh.

### Removed
- 5 top-level .sh scripts deleted: `scripts/codex-install.sh`, `scripts/cursor-install.sh`, `scripts/run-quality-gate.sh`, `scripts/validate-plugin.sh`, `scripts/lib/fetch-baseline.sh`. (`scripts/validate-wave-scope.sh` was already absent pre-session.)

### Kept (deliberate)
- `scripts/lib/common.sh` — retained because 10 nested .sh files under `scripts/lib/gates/` (5) and `scripts/lib/validate/` (5) still source it. Follow-up #317 created for nested ports + common.sh removal.

### Testing
- Test count: 2160 → 2420 (+260):
  - 36 tests for owner-yaml
  - 10 tests for soul-resolve
  - 15 tests for owner-persona-flow integration
  - 6 tests for codex-install + 5 for cursor-install
  - 24 for run-quality-gate + 18 for validate-wave-scope + 16 for validate-plugin
  - 22 for fetch-baseline (rewritten from .skip placeholder)

### Closed Issues (2026-04-30 deep session)
- #143 (vitest baseline functionally done — 2420 tests, GitLab CI green)
- #152, #153, #154 (all superseded by v3.2.0 shipped 2026-04-27)
- #173 (C4 consent merged into D2 question 5)
- #175, #176, #177 (D2/D3/D4 of #161 epic — all in-repo work complete)

### New Follow-up Issue
- **#317** — port nested gates/ + validate/ shell scripts to .mjs + remove common.sh (10 .sh files remain)

## [3.2.0] - 2026-04-27

Consolidated stable release covering the v3.0.0 (Windows native), v3.1.0 (environment-aware sessions), and v3.2.0 (Mode-Selector + Autopilot) work since v2.0.0. Supersedes the `v3.0.0-rc.1` pre-release.

### ⚠ BREAKING CHANGES (carried from v3.0.0)

- **Node.js 20+ is required.** The plugin runs as ES modules (`.mjs`) and uses native `fs.promises`, `fetch`, and `AbortSignal.timeout`. Node 18 and earlier are unsupported.
- **`npm install` is required once in the plugin directory** before hooks fire. `zx` is a runtime dependency; without it, hooks fail at load time.
- **Hooks are now `.mjs` files instead of `.sh`.** `hooks/hooks.json` points to the Node runtime. Custom consumer configs that referenced `.sh` hook paths must be updated.
- **`jq` and Bash are no longer hard dependencies for hooks.** Scope/command enforcement and session state reads use native Node JSON parsing. `jq` remains a soft recommendation for policy-editing workflows.
- **`bats` test suite retired.** Development and CI use [vitest](https://vitest.dev/) exclusively.

See [`docs/migration-v3.md`](docs/migration-v3.md) for the upgrade path from v2.x.

### Added — Windows native + Node.js migration (v3.0.0 surface)

- **Native Windows support** — no WSL or Git-Bash required. All file paths use `path.join`, tmp paths use `os.tmpdir()`, filesystem walks terminate at drive roots, glob matching normalizes backslashes. CRLF-tolerant config parsing and `.gitattributes` EOL rules prevent autocrlf breakage.
- **GitHub Actions CI matrix** across `ubuntu-latest`, `macos-latest`, and `windows-latest` with `fail-fast: false`, concurrency grouping, and per-OS `jq` install steps.
- **Vitest test framework** (`npm test`) replacing the `bats` shell harness. 1871 passing tests with byte-exact parity checks against the retired Bash implementations.
- **`package.json` at plugin root** with `type: "module"`, `engines.node >= 20`, `zx ^8.1.0` runtime dep, ESLint v9 + Prettier v3 + Vitest dev deps. `npm ci` bootstraps a reproducible tree.
- **Pre-bash destructive-command guard** — `hooks/pre-bash-destructive-guard.mjs` blocks `git reset --hard`, `rm -rf`, `git push --force`, and related destructive operations in the main session, with a 13-rule policy at `.orchestrator/policy/blocked-commands.json`. Opt-out via `allow-destructive-ops: true` in Session Config.
- **Canonical `parallel-sessions.md` rule** vendored via bootstrap. Documents PSA-001 through PSA-004 (detect before acting, ask before assuming, never destroy what you didn't create, isolate your changes).
- **ESLint v9 flat config + Prettier** with Node 20 globals, `_`-prefix allowlist for unused vars, markdown excluded.

### Added — Environment-aware sessions (v3.1.0 surface)

- **Resource-gate dispatch** — `scripts/lib/wave-resource-gate.mjs` reads live RAM/CPU/concurrent-session metrics before dispatching each wave. Eight-rule decision chain returns `proceed`, `reduce` (halve agent count), or `coordinator-direct` (0 agents). Configurable via `resource-thresholds` in Session Config; failures degrade to `proceed` so the gate never blocks.
- **`worktree-exclude` Session Config field** — string array of top-level directories skipped when creating agent worktrees. Default 10-pattern list (`node_modules`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `.cache`, `.turbo`, `.vercel`, `out`). Empty array disables. Cuts worktree clone size dramatically on large repos.
- **Multi-session registry** — `scripts/lib/session-registry.mjs` tracks active sessions across the host with heartbeat + sweep semantics. `on-session-start` hook registers the session and detects peers; `on-stop` deregisters cleanly. Enables resource-gate to factor in concurrent Claude/Codex sessions.
- **Anonymized hardware learnings** — `scripts/export-hw-learnings.mjs` exports anonymized hardware-pattern learnings for sharing. Promotion pipeline + anonymization regex tuning (no machine names, no usernames, no absolute paths).
- **CWD-drift guard** — `restoreCoordinatorCwd` runs after every worktree-isolated `Agent` dispatch so subsequent coordinator Edit/Write/Bash calls cannot silently route to a worktree branch.
- **Coordinator snapshots** — pre-dispatch `git stash create` refs under `refs/so-snapshots/` provide crash recovery for unfinished sessions; surfaced to the user via `AskUserQuestion` on session-start when the prior session was `active` or `paused`.

### Added — Mode-Selector + Autopilot (v3.2.0 surface)

- **Mode-Selector** — pure-function recommendation engine that suggests the next session mode (`housekeeping` | `feature` | `deep`) based on live signals: prior STATE.md recommendations, recent `sessions.jsonl` trend, surfaced learnings, bootstrap tier, and live VCS backlog scan. Renders a `📊` banner at session-start when confidence ≥ 0.5; modifies `AskUserQuestion` option ordering to put the recommendation first.
- **STATE.md Recommendations Contract** — five forward-looking frontmatter fields (`recommended-mode`, `top-priorities`, `carryover-ratio`, `completion-rate`, `rationale`) written by `session-end` and read by the next session-start as a `📋` banner. Backwards-compatible: pre-v1.1 STATE.md files are silently no-op.
- **Autopilot loop** — `/autopilot` runs `session-start → session-plan → wave-executor → session-end` chained for N iterations with kill-switches: SPIRAL detection, FAILED-wave gate, carryover > 50%, max-hours, sub-threshold confidence, etc. Eight kill-switches total.
- **Autopilot headless CLI** — `scripts/autopilot.mjs` is a walk-away driver. `--headless` required flag, `--verbose` pipes child stdio, `--dry-run` round-trips without spawning. Spawns `claude -p '/session <mode>'` per iteration and propagates `AUTOPILOT_RUN_ID` for retro joinability across `autopilot.jsonl` ↔ `sessions.jsonl`.
- **Vault-mirror auto-commit** — opt-in via `--session-id <id>`. After mirroring artifacts, stages `40-learnings/` + `50-sessions/`, validates `_generator: session-orchestrator-vault-mirror@1` frontmatter on every staged file, commits as `chore(vault): mirror <id> — N learnings + M sessions` when staged set is all-mirror, or unstages + warns on mismatch.
- **Docs-orchestrator** — opt-in audience-aware doc generation (User / Dev / Vault). Three hook points: session-start Phase 2.5 (audience detection + AskUserQuestion), session-plan Step 1.5/1.8 (Docs role classification + docs-writer auto-match), session-end Phase 3.2 (per-task ok/partial/gap verification).
- **Harness-audit scorecard** — deterministic 7-category rubric (`RUBRIC_VERSION` pinned), JSON to stdout + JSONL trend in `.orchestrator/metrics/audit.jsonl`. Available via `/discovery audit` probe and standalone `/harness-audit` command.
- **Plan modes** — `/plan new` (project kickoff with repo scaffolding), `/plan feature` (compact feature PRD), `/plan retro` (data-driven retrospective with vault-backfill sub-mode). All modes share a researched Q&A engine that dispatches parallel Explore agents before each question wave.
- **Discovery probes** — modular probes adapted to the project's tech stack, including `vault-staleness`, `vault-narrative-staleness`, `state-md-staleness`, and `bootstrap-lock-freshness`.
- **Adaptive wave sizing** — complexity scoring (files × directories × issues) maps to agent counts per role. Cross-session learnings can override the formula based on historical data.
- **Intelligent agent dispatch** — project agents > plugin agents > general-purpose. Optional `agent-mapping` Session Config for explicit role-to-agent binding. Model selection matrix (haiku / sonnet / opus per task type).
- **`isolation: 'none'` default for new-directory waves** — Pre-Dispatch New-Directory Detection forces `isolation: 'none'` when any agent's target parent directory doesn't exist and `configIsolation: 'auto'`. Avoids the Claude Code merge-back regression where new-dir writes silently fail to sync back from worktrees. Explicit `isolation: 'worktree'` overrides are honored with a warning.

### Changed

- **All hooks and `scripts/lib/` helpers migrated from Bash to Node.js.** Security-critical hooks (`enforce-scope.mjs`, `enforce-commands.mjs`) include symlink-escape protection, shell-operator + quote-boundary parsing, and Windows backslash normalization.
- **Cross-platform path handling** — `os.tmpdir()` replaces `${TMPDIR:-/tmp}`, `path.join`/`path.sep` throughout, `path.parse(dir).root` for filesystem-walk termination.
- **Native JSON parsing** replaces all `jq` shell-outs inside hooks.
- **Vitest 4.1.5** — upgraded from vitest 2.1.9. Includes the GitHub Actions CI tinypool timeout wrapper for Windows.

### Removed

- `bats` test suite — retired in favor of vitest.
- Hard runtime dependency on `jq` and `bash` for hooks.

### Security

- Pre-bash destructive-command guard active alongside subagent waves.
- Symlink-escape protection in scope-enforcement (`fs.realpath` + ancestor-walk fallback for non-existent targets).
- Shell-operator + quote-boundary parsing in command-enforcement (catches `ls;rm -rf /`, `psql -c "DROP TABLE …"`, and similar bypass patterns).
- `CLAUDE_PROJECT_DIR` validated against the platform's state directory before being trusted by enforcement hooks.
- Coordinator-snapshot refs (`refs/so-snapshots/`) garbage-collected at session-end for completed sessions.

### Quality

- 1871 tests passing / 10 skipped across vitest suites.
- Coverage thresholds: 70 / 65 / 70 / 60 (lines / functions / statements / branches).
- ESLint v9 flat config, Prettier v3 — `lint:fix` idempotent on the full tree.
- TypeScript discipline via `node scripts/typecheck.mjs` (43 file(s) OK).

### Migration

Short version:

```bash
cd /path/to/session-orchestrator
git pull
npm install           # installs zx + vitest + ESLint + Prettier
# Restart Claude Code / Codex / Cursor so hooks.json is re-read.
```

For details, see [`docs/migration-v3.md`](docs/migration-v3.md). Rollback: `git checkout v2.0.0 && rm -rf node_modules` and restart the editor.

---

## Internal Development Trail (pre-v3.2.0)

Detailed per-session entries captured during the v3.0.0 / v3.1.0 / v3.2.0 development cycles. Retained for traceability; content is consolidated in the [3.2.0] release block above.

### Added — harness-retro Wave 1 (2026-04-19, Epic #181)

Promotes validated patterns from advanced consumer repos into bootstrap defaults.

- `scripts/lib/config-schema.mjs` + `scripts/validate-config.mjs` (#182): plain-JS Session Config validator (no zod dep). Enforces 7 mandatory fields (`test-command`, `typecheck-command`, `lint-command`, `agents-per-wave`, `waves`, `persistence`, `enforcement`). Wired into `scripts/parse-config.sh` with enforcement-aware behavior (off|warn|strict). Bypass via `SO_SKIP_CONFIG_VALIDATION=1`.
- Bootstrap canonical config block: `_minimal/CLAUDE.md.tmpl` + `fast-template.md` + `public-fallback.md` now emit all 7 mandatory fields on every tier.
- Bootstrap `--retroactive` config-field patcher (#182): fills missing mandatory fields with package-manager-aware defaults during retroactive adoption.
- `.orchestrator/policy/quality-gates.schema.json` + `quality-gates.example.json` + `scripts/lib/quality-gates-policy.mjs` (#183): JSON-Schema policy for canonical test/typecheck/lint commands. Readable from Node (`loadQualityGatesPolicy`, `resolveCommand`) and Bash (`scripts/run-quality-gate.sh` policy-first `extract_command`).
- `scripts/lib/package-manager.mjs` (#183): lockfile-based detection (`pnpm-lock.yaml` / `yarn.lock` / `bun.lockb` / `package-lock.json`) + per-PM default command triads. Null falls back to npm (most portable).
- `skills/bootstrap/standard-template.md` Step 6.5 (#183): bootstrap writes `.orchestrator/policy/quality-gates.json` with package-manager-aware defaults. Idempotent — never overwrites user edits.
- `skills/bootstrap/standard-template.md` Step 6.6 + `skills/bootstrap/STATE.md.template` (#184): bootstrap scaffolds an idle STATE.md placeholder.
- `scripts/lib/state-md.mjs` (#184): hand-rolled YAML-subset frontmatter helpers (`parseStateMd`, `serializeStateMd`, `touchUpdatedField`, `readCurrentTask`). Never throws.
- STATE.md schema v1 extended with 3 optional fields: `updated`, `session`, `session-start-ref`. Backward-compat for files that omit them.
- `skills/session-start/SKILL.md` Phase 1.5: current-task banner from STATE.md. Phase 4: command-availability check before quality baseline.
- `skills/session-end/SKILL.md` Phase 3.4: touches `updated: <ISO>` on session close.
- `skills/discovery/probes-session.md`: new `state-md-staleness` probe (warn >7d, info 2-7d) reading optional `updated` frontmatter with file-mtime fallback.
- vitest coverage: +68 tests across `tests/lib/{config-schema,quality-gates-policy,package-manager,state-md}.test.mjs` and `tests/integration/parse-config-validator.test.mjs`. Total suite: 546 pass, 10 skipped.

### Added — v3.1.0 sub-epic B resource-gate session (2026-04-19)
- `scripts/lib/wave-resource-gate.mjs` (#193): pre-dispatch gate consumed by wave-executor. Reads `resource-thresholds` from Session Config and live RAM/CPU/concurrent-session metrics from `resource-probe.mjs`. 8-rule decision chain returns `proceed`, `reduce` (halve agent count, min 1), or `coordinator-direct` (0 agents). Probe failures and missing-thresholds configs degrade to `proceed` — gate never blocks the dispatch loop. Exported `formatGateReport(result)` helper for coordinator progress updates.
- `skills/wave-executor/wave-loop.md` § 0.5 (#193): pre-dispatch resource-gate playbook + STATE.md deviation contract — `reduce` and `coordinator-direct` decisions append a single timestamped line to `## Deviations` with measurements, so future sessions and `/evolve` can mine for hardware-pattern learnings.
- `worktree-exclude` Session Config field (#192): string array of top-level directories to skip when creating agent worktrees. Default 10-pattern list (`node_modules`, `dist`, `build`, `.next`, `.nuxt`, `coverage`, `.cache`, `.turbo`, `.vercel`, `out`). Empty array disables the feature. Mirrored across `scripts/lib/config.mjs`, `scripts/parse-config.sh`, and the validator.
- `scripts/lib/worktree.mjs` `applyWorktreeExcludes(wtPath, patterns)` (#192): pure-fs helper extracted from `createWorktree` for unit-testability (dodges a vitest worker-thread + zx AsyncLocalStorage interaction). Best-effort `fs.rm` per pattern, stderr-logs each removal. `createWorktree` now reads the configured exclude list (or accepts `options.excludePatterns`) and applies the helper after `git worktree add` succeeds. Bash parity in `scripts/lib/worktree.sh`.
- vitest coverage: 12 cases for `wave-resource-gate` (each decision branch + `plannedAgents=0/1` edges + probe-failure mock + missing-thresholds defensive path), 5 cases for `applyWorktreeExcludes` (default list, custom override, empty disables, non-existent pattern, top-level-only nesting), 2 cases for `worktree-exclude` config parsing. Suite total: 533/543 pass, 10 pre-existing skipped, 0 failed.

### Context — sub-epic B
Issues #192 and #193 were filed in response to the BuchhaltGenie OOM incident (2026-04-19) where parallel sessions saturated host RAM. The exclude list keeps worktree clones lean; the resource-gate halves or escalates dispatches when free RAM drops below configured thresholds. Both ship on `feat/v3.1-resource-gate-192-193 → feat/env-aware-v3.1` (Sub-Epic A+B will land via MR !9 once env-aware reaches main).

### Added — libs + hooks session (2026-04-19)
- `scripts/lib/io.mjs` (#131): hook stdin/stdout helpers. `readStdin()` with 5 s AbortController timeout + 1 MB byte guard, `emitAllow`/`emitDeny`/`emitWarn`/`emitSystemMessage` matching the Claude Code hook I/O contract (exit 2 for deny, 0 for allow, single-line JSON on stdout). Pure Node stdlib, no external deps.
- `scripts/lib/events.mjs` (#133): JSONL append to `.orchestrator/metrics/events.jsonl` via `fs.promises.appendFile` + optional fire-and-forget webhook POST via native `fetch` with `AbortSignal.timeout(3000)` when `CLANK_EVENT_SECRET` is set. Network errors swallowed; graceful skip when env var unset.
- `scripts/lib/worktree.mjs` (#134): zx-based cross-platform git worktree helpers. `os.tmpdir()` replaces `${TMPDIR:-/tmp}`, `path.join` throughout for Windows separator safety, retry-once pattern in `createWorktree`, best-effort `removeWorktree` (always resolves, warns on uncommitted changes), `listWorktrees`, `cleanupAllWorktrees`.
- `scripts/lib/hardening.mjs` (#135): env/runtime checks (`assertNodeVersion`, `assertDepInstalled`, `checkEnvironment`) plus scope/pattern primitives used by the Wave 3 hooks (`findScopeFile`, `getEnforcementLevel`, `gateEnabled`, `pathMatchesPattern`, `commandMatchesBlocked`, `suggestForScopeViolation`, `suggestForCommandBlock`). Scope expanded beyond the original issue to absorb hook-primitive helpers — documented in the commit trailer.
- `scripts/lib/common.mjs` (#136): shared utilities (`makeTmpPath`, `utcTimestamp`, `epochMs`, `readJson`, `writeJson`, `appendJsonl`). Async `fs.promises`, auto-creates parent directories via recursive `mkdir`.
- `hooks/enforce-scope.mjs` (#137): PreToolUse hook blocking Edit/Write outside `wave-scope.json` `allowedPaths`. Node port of `hooks/enforce-scope.sh` with SECURITY-REQ-01..08 from security pre-review addressed: top-level try/catch emits `emitDeny` on any unhandled error (never exit 1), `fs.realpath` on file + ancestor-walk fallback for non-existent targets prevents symlink-escape, Windows backslash normalization before glob matching, relative `file_path` resolved against project root (not CWD), scope file read once per invocation.
- `hooks/enforce-commands.mjs` (#138): PreToolUse hook blocking dangerous Bash commands. Shell-operator-aware word boundary (catches `ls;rm -rf /`, `ls&&rm -rf /`, `(rm -rf /)`, `` `rm -rf /` ``, `$(rm -rf /)`) plus quote-boundary (catches `psql -c "DROP TABLE …"`). Fallback blocklist expanded: adds `git push -f` short form and `drop table` lowercase variant that the Bash predecessor missed.
- vitest coverage for Wave 2–3 artifacts: 179 tests across `tests/lib/{io,events,worktree,hardening,common}.test.mjs` and `tests/hooks/{enforce-scope,enforce-commands}.test.mjs`. Includes F-01 shell-operator-bypass regression block, F-02 symlink-escape regression (skipIf win32), 10-row `pathMatchesPattern` parity table, and 8-row `commandMatchesBlocked` parity table from the migration baseline spec. Total suite: 343 tests pass, 10 pre-existing skipped, 0 failed.

### Fixed — libs + hooks session
- `scripts/lib/worktree.mjs`: replaced 5 `$.nothrow($\`…\`)` call sites with the `nothrow` named export — in zx v8 `$.nothrow` is a boolean property, not callable; the original code threw `TypeError` on every cleanup path.
- `scripts/lib/hardening.mjs:commandMatchesBlocked`: extended boundary class from `\s` to `[\s;|&(){}`'"]`. Previously `ls;rm -rf /` bypassed the blocklist because the semicolon wasn't a boundary char; `psql -c "DROP TABLE …"` bypassed because the quote wasn't either. Both are now caught (7 regression tests).

### Also on this branch (parallel non-session commits)
Three vault-sync commits (`a76e180`, `e3c8e47`, `82be589`) landed alongside the v3 libs/hooks session. Scope: managed-mirror Zod schema sync with a drift gate, BEGIN/END sentinels on vendored schema, GitLab CI pipeline (`test` + `schema-drift-check` stages), and learning-provenance decoupling from session-file lifecycle. Not part of the `[131,133,134,135,136,137,138]` session plan — documented here for traceability. Requires a one-time `projects-baseline` CI/CD Token Access allowlist for `infrastructure/session-orchestrator` before the first pipeline run.

### Added — foundation wave (2026-04-18)
- `.gitattributes` (#125): cross-platform EOL rules. LF for `.sh`, `.md`, `.json`, `.yaml`, `.mjs`; CRLF for `.ps1`; `* text=auto` fallback. Prevents autocrlf breakage on Windows checkouts.
- `package.json` + `package-lock.json` (#126): plugin-root Node 20+ manifest with `type: "module"`, zx ^8.1.0 dep, ESLint v9, Prettier v3, and vitest ^2 devDeps. `npm ci`-installable. Version bumped to `3.0.0-dev`.
- ESLint v9 flat config + Prettier (#127): `eslint.config.js` with @eslint/js recommended, Node 20 globals, project rules (`no-unused-vars` with `_`-prefix allowlist, `prefer-const`, `no-var`, `eqeqeq`). `.prettierrc` uses single quotes, 100 columns, LF. `.prettierignore` excludes `*.md` because skill files have intentional formatting. Baseline green, `lint:fix` idempotent.
- CI matrix for ubuntu, macos, and windows-latest (#128): `.github/workflows/test.yml` extends to a 3-OS matrix with `fail-fast: false`. Preserves v2.0 hardenings (least-privilege `permissions`, `timeout-minutes`, SHA-pinned actions). Adds concurrency group, conditional typecheck (gated on `.mjs` existence), jq install per-OS, vitest placeholder for Wave 4.
- `scripts/lib/platform.mjs` (#129): Node port of `platform.sh` with Windows-safe filesystem walk (`path.parse(dir).root` replaces the Bash `/`-terminator that breaks on `C:\`). New exports: `SO_OS`, `SO_IS_WINDOWS`, `SO_IS_WSL`, `SO_PATH_SEP` alongside the six existing IDE/project constants. Five named helper functions for callers that need to re-detect.
- `scripts/lib/path-utils.mjs` (#130): CWE-23-safe pure path helpers backing the forthcoming `enforce-scope.mjs`. Rejects null bytes, empty strings, UNC paths (Windows), prefix-match confusion, cross-drive escapes. Locale-stable case normalization via `toLocaleLowerCase('en-US')` to avoid Turkish-I-style regressions. Exports a documented `CWE_23_ATTACK_PATTERNS` taxonomy for test self-check.
- `scripts/lib/config.mjs` (#132): Node port of `parse-config.sh` + `config-yaml-parser.sh` + `config-json-coercion.sh` combined into one module with private coercion helpers. CRLF-tolerant input, native JSON (no jq shellout). Byte-exact parity against the `.sh` version on the project's own `CLAUDE.md`.
- vitest coverage for foundation libs: 142 tests across `tests/lib/{platform,path-utils,config}.test.mjs` plus 5 fixtures under `tests/fixtures/`. `path-utils` tests cover every documented CWE-23 vector and are falsification-verified. `config` tests include a subprocess-bash parity diff gated on non-Windows.

### Fixed — foundation wave
- session-start: reset STATE.md to idle when previous session completed. Clears `current-wave`, sets `status: idle`, demotes `## Wave History` into `## Previous Session`, and empties `## Deviations`. Only triggers on the `completed` branch; `active` and `paused` paths remain user-interactive via AskUserQuestion. Prevents a fresh session from appearing "already completed". (closes infrastructure/projects-baseline#159)
- Pre-v3 `.mjs` lint baseline: removed an unused `fileURLToPath` import, replaced `== null` with explicit `=== null || === undefined`, prefixed intentionally-unused destructures and params with `_`, cleaned a `no-useless-escape`. `npm run lint` is now idempotent on the full tree.

### Migration — still pending
- Hook wiring (`hooks.json` → `.mjs`) is still on the bash files. `enforce-scope.mjs` + `enforce-commands.mjs` are implemented and tested but not yet activated — that lands with #142 in a later session.
- 3 lower-priority hook migrations remain (`post-edit-validate`, `on-session-start`, `on-stop`) — issues #139–#141.

### Migration
- Developer prerequisite: Node 20+ and `npm ci` after clone. Existing bash test suite (`scripts/test/run-all.sh`) continues to work on Unix while the foundation stabilizes; Windows users run `npm test` only.
- No user-visible breakage yet. Hook migrations in later waves will require `npm install` in the plugin directory before hooks fire.

## [2.0.0] - 2026-04-17

First stable release of the 2.x line. Bundles six betas worth of work into a single stable cut.

### Added
- **Bootstrap Gate** (beta.6): non-bypassable Phase-0 check that prevents orchestrator skills from running against unstructured repos. Three tiers (Fast/Standard/Deep), committed `.orchestrator/bootstrap.lock`, new `/bootstrap` command with `--fast`/`--standard`/`--deep`/`--upgrade`/`--retroactive` flags.
- **Pre-dispatch grounding injection** (beta.5): prepends line-numbered GROUNDING blocks to agent prompts for files with recent `edit-format-friction` stagnation history, reducing Edit-tool retry loops. Per-agent scope, capped at `grounding-injection-max-files` (default 3), gated on `persistence: true`.
- **Learnings-system efficiency** (beta.4): ranked cap on surfaced learnings (`learnings-surface-top-n`, default 15), passive confidence decay for untouched entries, surface-health telemetry in session-start, and retirement of the legacy split-brain `metrics/learnings.jsonl` path.
- **Scope and command enforcement hardening** (beta.2): shared `scripts/lib/hardening.sh` module with per-gate toggles (`enforcement-gates`), actionable denial suggestions, stagnation pattern detection (Pagination Spiral, Turn-Key Repetition, Error Echo), and file-level grounding verification (`grounding-check`).
- **Stagnation telemetry** (beta.2): session-end emits per-agent stagnation events with `pattern` and `error_class` fields; evolve accumulates these into `stagnation-class-frequency` learnings. Error-Class Taxonomy covers six classes.
- **Clank Event Bus integration** (beta.1): async event emission for session start, stop, and agent stop events via `scripts/lib/events.sh`. Graceful degradation when unconfigured.
- **Wave execution foundation** (alpha series): role-based wave assignment, adaptive sizing from complexity scoring, cross-session learning system, worktree isolation, circuit breaker with maxTurns and spiral detection, session persistence via STATE.md, PreToolUse enforcement hooks, and deterministic config parsing in `scripts/parse-config.sh`.

### Changed
- Marketplace install identifier is `session-orchestrator@kanevry` (renamed from the redundant `session-orchestrator@session-orchestrator` in beta.3).
- Phase 0 of every orchestrator skill (`/plan`, `/session`, `/go`, `/close`, `/discovery`, `/evolve`) now runs the Bootstrap Gate before any other work.
- Cross-session learnings are now ranked by confidence and capped before injection; entries that go untouched across sessions decay gradually rather than staying at full weight indefinitely.

### Security
- Placeholder substitution in bootstrap public-fallback templates uses Python `argv`, not `sed` string interpolation, to prevent injection via repo names.
- Explicit file enumeration for `git add` in all bootstrap templates; no `git add -A` in generated commit steps.
- `glab api` and `gh api` error output is redacted to prevent token leakage in hook logs.
- Scope enforcement defaults to fail-closed (`strict`) when the `enforcement` field is absent from `wave-scope.json`.
- `CLAUDE_PROJECT_DIR` is validated to contain a `.claude/` directory before being trusted by enforcement hooks.

### Migration
- Consumer repos with a legacy `<state-dir>/metrics/learnings.jsonl` file should run `bash <plugin>/scripts/migrate-legacy-learnings.sh` once after upgrading. The script is idempotent and produces a `.bak` copy of anything it touches.
- The plugin install command changed in beta.3: use `/plugin marketplace add <source>` and `/plugin install session-orchestrator@kanevry` inside a running Claude Code session. There is no `claude plugin` shell command.

## [2.0.0-beta.6] — 2026-04-16

Issue #98 (Epic) — Bootstrap Gate. Addresses the "LLM rationalizes past hard-stops" problem: in a new empty repo, Codex bypassed the `/plan` skill's Phase-0 abort by falling back to "pragmatic paths", leaving the repo unstructured. The gate is a state-file-backed, cross-platform (Claude Code / Codex / Cursor), non-bypassable replacement. All 20 test suites pass.

### Added — Bootstrap Gate (Epic #98)

- **Non-bypassable Bootstrap Gate** (`skills/_shared/bootstrap-gate.md`) runs in Phase 0 of every orchestrator skill (`/plan`, `/session`, `/go`, `/close`, `/discovery`, `/evolve`). If a repo lacks `CLAUDE.md` + `## Session Config` + `.orchestrator/bootstrap.lock`, the gate invokes a new bootstrap flow.
- **Three intensity tiers** — Fast (demos/spikes), Standard (MVPs/products), Deep (production/team). Each tier is a strict superset of the previous. LLM recommends tier from first user prompt; user confirms with one question.
- **Public path** for users without a local `projects-baseline`: `claude init` (Claude Code) or plugin-bundled minimal templates (Codex, Cursor). Five archetypes: `_minimal`, `static-html`, `node-minimal`, `nextjs-minimal`, `python-uv`.
- **Anti-bureaucracy guardrails** — exactly 1 question in normal flow, max 2 in ambiguous public path; idempotent gate check; committed `.orchestrator/bootstrap.lock` as mechanical truth.
- **New `/bootstrap` command** with `--fast`/`--standard`/`--deep`/`--upgrade <tier>`/`--retroactive` flags.
- **Six new test scripts** covering gate-check, tiers, upgrade, public path, idempotency, red-team.

### Changed

- Phase 0 Bootstrap Gate prepended to all 6 orchestrator skills (`plan`, `session-start`, `wave-executor`, `session-end`, `discovery`, `evolve`).

### Security

- Sanitized placeholder substitution in `skills/bootstrap/public-fallback.md` (Python argv, not sed string interpolation).
- Explicit file enumeration for `git add` in all bootstrap templates (no `git add -A`).
- Redacted `glab api` / `gh api` error output to prevent token leakage.
- Follow-up issues #108 (LOW security) and #109 (MEDIUM+LOW tech-debt) filed for remaining hardening.

### Motivation

Addresses the "LLM rationalizes past hard-stops" problem: in a new empty repo, Codex bypassed the `/plan` skill's Phase-0 abort by falling back to "pragmatic paths", leaving the repo unstructured. The gate is a state-file-backed, cross-platform (Claude Code / Codex / Cursor), non-bypassable replacement.

## [2.0.0-beta.5] - 2026-04-15

Issue #85 — pre-dispatch grounding injection for friction-prone files. Direct translation of the Hashline idea from the *Harness Problem* abgleich (gap G3) to wave-executor's layer: when an agent's scope includes a file with recent `edit-format-friction` stagnation history (from #84 telemetry), the agent prompt is prepended with a line-numbered view of that file so the agent references lines stably instead of re-matching character spans. Per-agent scope, capped at `grounding-injection-max-files` (default 3), gated on `persistence: true`. All 14 script test suites remain green; integration fixtures grew from 107 to 122 assertions.

### Added
- feat(wave-executor): pre-dispatch grounding injection — prepend a line-numbered GROUNDING block to each agent's prompt for any file in the agent's scope that has recent `edit-format-friction` stagnation history (from #84 telemetry). Reduces Edit-tool retry loops by giving agents stable line-number references. Per-agent scope, capped at `grounding-injection-max-files` (default 3). Helper script `scripts/compute-grounding-injection.sh` (new); gated on `persistence: true`. Addresses Harness Problem gap G3. (#85)
- feat(session-end): aggregate `grounding_injected` events into sessions.jsonl as `grounding_injections: {count, files, total_lines}`. Omitted when `count == 0`. (#85)
- config: `grounding-injection-max-files` (integer, default `3`) — cap files injected per agent; set `0` to disable the feature. (#85)

### Tests
- test-integration.sh Group 12 (#85): 15 new assertions covering config default/override/disable, helper early-exit, match-and-emit, cap behavior with `grounding_capped=true`, and PERSISTENCE=false no-event-write path. Total integration assertions 107 → 122.

## [2.0.0-beta.4] - 2026-04-15

Epic #87 — learnings-system efficiency package. Four targeted changes to the cross-session intelligence layer that restore the original design intent: surface the most useful learnings, let irrelevant ones fade naturally, retire the legacy split-brain file, and make the whole thing transparent. Empirical baseline from the BuchhaltGenie consumer repo (85 active learnings, ~13.6k tokens at every session-start) motivated the bundle. All 14 script test suites remain green; integration fixtures grew from 76 to 107 assertions.

### Added
- feat(session-start): rank and cap learnings injection — sort active learnings by confidence, slice to `learnings-surface-top-n` (default 15). Reduces Phase 5.6 token consumption on mature consumer repos. Configurable via Session Config key. Addresses Epic #87 / Issue #88. (#88)
- feat(session-end): passive confidence decay for untouched learnings — subtract `learning-decay-rate` (default `0.05`) from every learning not confirmed, contradicted, or newly-appended this session. Applied before the existing prune step. `0.0` opts out. A learning starting at `0.5` survives ~10 untouched sessions. Addresses Epic #87 / Issue #89. (#89)
- feat(session-start): "Surface health" sub-section in Project Intelligence — shows active/surfaced/suppressed counts, confidence distribution (high/medium/low), oldest surfaced entry, source file, vault mirror status. Prints an advisory when suppressed > surfaced. Addresses Epic #87 / Issue #91. (#91)

### Fixed
- fix(session-start): retire legacy `<state-dir>/metrics/learnings.jsonl` fallback — Phase 5.6 and `_shared/config-reading.md` now read ONLY the canonical `.orchestrator/metrics/learnings.jsonl`. Consumer repos with leftover legacy entries should run `scripts/migrate-legacy-learnings.sh` once. Addresses Epic #87 / Issue #90. (#90)

  **MIGRATION**: in each consumer repo, run:

      bash <plugin>/scripts/migrate-legacy-learnings.sh

  where `<plugin>` is the session-orchestrator plugin directory. The script is idempotent, produces a `.bak` copy of any legacy file it touches, and emits a one-line JSON summary on stdout.

### Tests
- Added 31 integration-test assertions across 4 new fixture groups in `scripts/test/test-integration.sh`: Group 8 (cap+rank, #88, 6 assertions incl. equal-confidence tiebreaker), Group 9 (passive decay, #89, 3 assertions incl. IEEE-754 tolerance), Group 10 (surface health, #91, 8 assertions incl. positive + negative advisory), Group 11 (migration helper, #90, 13 assertions incl. empty-canonical, malformed-legacy, idempotency).
- Added `json_float()` helper to `scripts/parse-config.sh` with regex + awk-based bounds validation (`0.0 ≤ x < 1.0` via strict-less-than max), covered by existing `test-parse-config.sh` suite.

## [2.0.0-beta.3] - 2026-04-15

Documentation patch release. No runtime code changes — all 16 script test suites remain green. End users and contributors can now successfully install the plugin through Claude Code for the first time since #14 shipped.

### Changed
- **Marketplace identifier** renamed from `session-orchestrator` to `kanevry` in `.claude-plugin/marketplace.json`. The plugin name itself remains `session-orchestrator`; this change only affects the suffix after `@` in the install command, so it reads `session-orchestrator@kanevry` instead of the redundant `session-orchestrator@session-orchestrator`. Existing local installs that registered the old marketplace name can remove it with `/plugin marketplace remove session-orchestrator` and re-add.
- **Version string audit** — bumped every `2.0.0-beta.2` reference in sync: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, `hooks/hooks.json`, `hooks/hooks-codex.json`, `scripts/mcp-server.sh`, `README.md` version badge, `docs/USER-GUIDE.md` banner example, `CONTRIBUTING.md` hook example. Applies the version-string-drift learning from the beta.2 release-cut.

### Fixed
- **Install instructions** across `README.md`, `docs/USER-GUIDE.md`, and `CONTRIBUTING.md` referenced non-existent `claude plugin add` / `claude plugin install` shell commands. Claude Code has no such CLI — plugins install exclusively via the slash commands `/plugin marketplace add <source>` and `/plugin install <name>@<marketplace>` inside a running session. End users following the previous instructions could not install the plugin at all. Docs now show the correct slash-command flow for both GitHub and local-clone installs. This is a follow-up to #14, whose original fix in commit 802d821 introduced the incorrect commands.

## [2.0.0-beta.2] - 2026-04-13

### Added
- **Shared hardening module** (GL#76) — `scripts/lib/hardening.sh` with pure, independently-testable helpers (`require_jq`, `source_platform`, `find_scope_file`, `get_enforcement_level`, `gate_enabled`, `path_matches_pattern`, `command_matches_blocked`, `emit_deny`, `emit_warn`, `suggest_for_*`). All three enforcement hooks now source this module instead of duplicating logic.
- **test-hardening.sh** — 33 assertions covering path matching (directory prefix, `**`, single-segment glob, exact), command word-boundary matching, scope-file discovery, enforcement-level parsing, gate toggles, and suggestion content.
- **Per-gate enforcement toggles** (GL#77) — new `enforcement-gates` Session Config field. Object with boolean values for `path-guard`, `command-guard`, `post-edit-validate`. Missing entries default to enabled. Wave-scope.json gains optional `gates` field; `gate_enabled()` in hardening.sh drives skip logic.
- **Actionable suggestions in hook denials** (GL#78) — `enforce-scope.sh` and `enforce-commands.sh` now include a context-aware suggestion in their denial reason (e.g., force-push denial points to `--force-with-lease`; scope violation lists the allowed paths and next steps).
- **STATE:/PLAN: structured reasoning** (GL#79) — new `reasoning-output` Session Config field (boolean, default `false`). When enabled, wave-executor appends a STATE/PLAN transparency block to every agent prompt. Opt-in — adds prompt overhead.
- **Stagnation patterns** (GL#80) — `circuit-breaker.md` documents three new pagination-aware patterns (Pagination Spiral, Turn-Key Repetition, Error Echo) with a decision table mapping each to a recovery action. `wave-loop.md` step 2 hooks the per-agent check into the existing post-wave review. Detection is heuristic (LLM-applied), not executable code. Detection discipline explicitly notes that two different agents reading the same file is coordination, not stagnation.
- **File-level grounding verification** (GL#81) — `plan-verification.md` § 1.1a compares planned files (union of agent prompt scopes) against actual files (`git diff --name-only $SESSION_START_REF..HEAD`) and reports scope creep + incomplete coverage. Adds a `grounding` field to session metrics JSONL. Gated by the new `grounding-check` Session Config field (boolean, default `true`). Informational only — does not block session close. `wave-loop.md` step 2 also gains a per-wave variant (bullet 3b) using each wave's pre-dispatch HEAD snapshot.
- **Stagnation telemetry + error-echo classification** (GL#84) — `session-end` now emits per-agent stagnation events to `events.jsonl` with `pattern` + `error_class` fields; `evolve` accumulates these into `stagnation-class-frequency` learnings. `circuit-breaker.md` adds an Error-Class Taxonomy (scope-denied, command-denied, edit-format-friction, test-reality-gap, state-read-failure, unknown) with worked examples.
- **Design Philosophy section in wave-executor** (GL#82) — 200-word framing between Execution Model and Platform Note explaining why friction is intentional; references `circuit-breaker.md` + `wave-loop.md`.
- **Stagnation-class-frequency learning type** (GL#83) — shipped in `skills/evolve/SKILL.md:103-110` (redundant with #84 telemetry; issue closed as already-implemented in b238135).
- **test-stagnation.sh** + **test-grounding.sh** — 27 new assertions covering content structure of the new sections, parse-config round-trip for `grounding-check`, error-path for invalid values, and structural ordering (1.1 < 1.1a < 1.2).
- **vault-mirror skipped-invalid action** — new action type emitted when a JSONL entry fails field validation (C2 hardening); prevents silent data loss during auto-sync to the Meta-Vault.
- **daily skill corrupt-file guard** — detects 0-byte or frontmatter-less daily notes and re-creates them; distinct exit codes 2/3/4 for file-missing / corrupt / frontmatter-invalid.

### Changed
- `hooks/enforce-scope.sh`, `hooks/enforce-commands.sh`, `hooks/post-edit-validate.sh` refactored to source `scripts/lib/hardening.sh`. Behavior is unchanged in the default configuration; new behavior surfaces only when `enforcement-gates` or `reasoning-output` are set.
- `scripts/validate-wave-scope.sh` now validates the optional `gates` field (must be an object of booleans).
- `scripts/parse-config.sh` adds `enforcement-gates`, `reasoning-output`, and `grounding-check` fields; `json_bool_object()` helper coerces string values to real JSON booleans.
- `docs/session-config-reference.md` documents the new fields in the Persistence & Safety section.
- `.mcp.json` now falls back to `git rev-parse --show-toplevel` when `$CLAUDE_PLUGIN_ROOT` is unset, allowing local development inside this repo to connect the MCP server without reinstalling as a plugin.
- `skills/vault-sync/SKILL.md` — Outputs/Inputs sections rewritten to match `validator.mjs` impl; vestigial `--json` flag removed from `validator.sh`.
- `skills/daily/SKILL.md` — documented VAULT_DIR Session Config resolution; added Exit codes table.
- `skills/wave-executor/SKILL.md` — added Design Philosophy section (200w) with harness-friction framing.

### Fixed
- **vault-mirror C2 field validation** — malformed JSONL lines now produce `skipped-invalid` actions instead of crashing the sync loop.
- **vault-mirror C3 readline race** — switched to `for await` collect-then-sequential to prevent out-of-order Markdown writes on large JSONL streams.
- **vault-mirror C4 dry-run mkdir** — removed unconditional `mkdirSync` that leaked directories during `--dry-run`; guarded behind write-mode.
- **vault-mirror H3/H4** — nested null-checks + `session_id` slug validation with uuid fallback.
- **session-end C1 broken jq selector** — `.dest` / `written` action selector never matched; corrected to `.path` / `created|updated`. Action list extended with `skipped-invalid`.
- **daily skill** — 0-byte and frontmatter-less daily notes now re-create cleanly instead of propagating corrupt state.

### Sanitized
- Public-surface cleanup: `skills/vault-sync/SKILL.md` and `skills/_shared/model-selection.md` no longer reference private project names or absolute user paths.
- `.orchestrator/metrics/*.jsonl` removed from git tracking (per-project observability data belongs locally, not in the public repo).
- `docs/specs/` removed from git tracking (internal design artifacts).
- `.gitignore` updated accordingly.

### Tests
- 328 → 396 passing (33 new in test-hardening.sh, 6 new in test-parse-config.sh, 15 new in test-stagnation.sh, 12 new in test-grounding.sh — including 3 invalid-value error-path assertions, +2 in test-parse-config.sh for `grounding-check`).
- Bats: `daily.bats` 8 → 10, `vault-mirror.bats` 36 → 40 (+6 assertions across the vault stack).

## [2.0.0-beta.1] - 2026-04-08 — Beta Release

### Added
- **Clank Event Bus integration** (GL#53) — `scripts/lib/events.sh` with `so_emit_event()` function for async event emission to Clank's Event Bus (`events.gotzendorfer.at/api/events`). Bearer-auth via `CLANK_EVENT_SECRET`, graceful degradation when unconfigured.
- **SessionStart event hook** — `hooks/on-session-start.sh` emits `orchestrator.session.started` with platform and project context
- **Stop/SubagentStop event emission** — existing hooks now emit `orchestrator.session.stopped` and `orchestrator.agent.stopped` events
- **Output Styles** (GL#56) — 3 output style definitions (`output-styles/session-report.md`, `wave-summary.md`, `finding-report.md`) for consistent session reporting format
- **test-events.sh** — 12 assertions covering event library loading, graceful degradation, hook integration, and registration

### Changed
- hooks.json + hooks-codex.json: SessionStart now includes async event notification hook
- Plugin version: alpha.15 → beta.1
- Tests: 172+ → 184+ passing (12 new event bus assertions)

### Closed
- GL#53 (HTTP Hooks — reimplemented as Clank Event Bus integration)
- GL#56 (Output Styles)
- GL#47 (Epic: Plugin API Alignment — all sub-issues resolved)

## [2.0.0-alpha.15] - 2026-04-08 — Plugin API Alignment

### Added
- **plugin.json component paths** — `commands`, `agents`, `hooks`, `mcpServers` fields per Plugin API spec
- **validate-plugin.sh** (GL#48) — 18-check validation script: manifest schema, component path resolution, hooks JSON, agent frontmatter, mcpServers validity
- **test-validate-plugin.sh** — 17 assertions covering valid plugin, missing fields, invalid JSON, broken paths, bad frontmatter
- **Stop hook** (GL#52) — `hooks/on-stop.sh` persists session state to metrics on unexpected exit
- **SubagentStop hook** (GL#52) — `hooks/on-subagent-stop.sh` logs agent completion for wave-executor metrics
- **MCP Server skeleton** (GL#54) — `.mcp.json` + `scripts/mcp-server.sh` exposing `session_config` and `session_metrics` tools via JSON-RPC 2.0 stdio

### Changed
- **Issue triage** (GL#60) — verified all 14 epic issues against actual Plugin API docs: 6 closed (not in API), 2 deferred, 4 implemented, 1 epic tracking
- hooks.json + hooks-codex.json now include `Stop` and `SubagentStop` event types
- Tests: 155 → 172+ passing (17 new validate-plugin assertions)

### Closed (not in Plugin API)
- GL#49 (`userConfig`), GL#50 (`CLAUDE_PLUGIN_DATA`), GL#51 (agent extended frontmatter), GL#55 (`bin/` auto-PATH), GL#57 (skill `paths`), GL#58 (LLM hook types)

### Deferred
- GL#53 (HTTP hooks), GL#56 (output styles)

## [2.0.0-alpha.14] - 2026-04-07 — Cross-Platform + Housekeeping

### Added
- **Codex CLI full support** — platform detection (`scripts/lib/platform.sh`), `.orchestrator/metrics/` shared knowledge layer, `.codex-plugin/` with 3 agent TOMLs (explorer, wave-worker, session-reviewer), hooks-codex.json, codex-setup.md
- **Cursor IDE rules-based integration** — 9 `.cursor/rules/*.mdc` files, sequential execution model (no Agent() tool), platform.sh cursor detection, cursor-setup.md, hooks-cursor.json, cursor-install.sh
- **Intelligent agent dispatch** — 3-tier resolution: project agents > plugin agents > general-purpose fallback. 5 domain agents (code-implementer, test-writer, db-specialist, ui-developer, security-reviewer)
- **Worktree tests** (GL#39) — `scripts/test/test-worktree.sh` with 10 assertions covering create/cleanup/cleanup_all
- **Platform slow-path tests** (GL#42) — 8 assertions for marker directory detection without env vars

### Changed
- **DRY hook scripts** (GL#41) — all 3 hooks now source `platform.sh` instead of duplicating `find_project_root()`
- **Removed orphan config fields** (GL#40) — `session-types` and `cli-tools` removed from parser, docs, tests, and 23 files total
- **Codex agent specialization** documented as known limitation (GL#43) — Platform Limitations section in codex-setup.md
- **Test-writer hardening** — 3 anti-greenwashing rules: hardcoded assertions, mandatory error tests, falsification self-check
- **Lifecycle Simulation v3** — 37 gaps found across 3-platform trace, 28 fixed (session-end, wave-executor, session-plan, discovery, evolve, hooks, .cursor/rules)
- All 10 SKILL.md files now include `model-preference-cursor` frontmatter
- `skills/_shared/platform-tools.md` extended with Cursor column
- `skills/_shared/config-reading.md` updated with Cursor fallback paths
- Tests: 130 → 155 passing (10 worktree + 8 platform slow-path + adjustments for removed fields)

### Fixed
- **3 discovery issues created** — GL#44 (post-edit-validate.sh JSON injection), GL#45 (Session Config dogfooding), GL#46 (.claudeignore)

## [2.0.0-alpha.13] - 2026-04-06 — Validate Refactor + Probes Split + PostToolUse Hook

- **refactor:** extract 4 helpers from `validate()` in validate-wave-scope.sh — 109→22 lines (#25)
- **refactor:** split `probes.md` (943 lines) into 6 category files — code, infra, ui, arch, session + intro (#26)
- **feat:** PostToolUse hook for incremental typecheck after Edit/Write — informational, never blocks (#20)
  - `hooks/post-edit-validate.sh` — resolves typecheck command from config, 2s timeout, macOS-compatible
  - hooks.json updated with PostToolUse section
- **test:** 33 new test assertions (wave-scope edge cases + hook test suite)
- **fix:** macOS `date +%s%3N` compatibility in post-edit-validate.sh (BSD date lacks `%N`)

## [2.0.0-alpha.12] - 2026-04-06 — /evolve + Skill Splits

- **feat:** `/evolve` command + skill — extract, review, and list cross-session learnings (#21)
  - `analyze` mode: extract patterns from session history (5 learning types), present via AskUserQuestion, atomic write
  - `review` mode: interactive management (boost/reduce/delete/extend) of existing learnings
  - `list` mode: read-only display grouped by type with confidence and expiry summary
- **refactor:** extract `verification-checklist.md` from session-end SKILL.md Phase 2 (#18)
- **refactor:** extract `wave-template.md` from session-plan SKILL.md Step 4 (#18)
- **feat:** seed initial `learnings.jsonl` with 4 learnings from 8-session history (effective-sizing, scope-guidance)

## [2.0.0-alpha.11] - 2026-04-06 — Deterministic Scripts

- **feat:** `scripts/parse-config.sh` — deterministic Session Config parser with type validation, 36 fields, defaults from reference doc (#19)
- **feat:** `scripts/run-quality-gate.sh` — 4 quality gate variants (baseline, incremental, full-gate, per-file) with structured JSON output (#19)
- **feat:** `scripts/validate-wave-scope.sh` — wave-scope.json validator with security checks (path traversal, absolute paths) (#19)
- **feat:** `scripts/lib/common.sh` — shared library (find_project_root, require_jq, die, warn, resolve_plugin_root)
- **feat:** 94 bash tests across 3 test suites with 8 fixtures
- **refactor:** skills updated to reference scripts (session-start, discovery, plan, wave-executor, session-end, quality-gates)

## [2.0.0-alpha.10] - 2026-04-05

### v2.0.0-alpha.10

**Quality & Architecture**

- fix: remove hardcoded archetype/style/group mappings in plan mode-new — now discovered dynamically from `$BASELINE_PATH` (#11)
- feat: shared Session Config reference at `docs/session-config-reference.md` — single source of truth for all 36 fields (#12)
- refactor: deduplicate Phase 0 config lists across session-start, discovery, and plan skills (#12)
- refactor: extract session-start Phase 7 presentation template to `presentation-format.md` (#18)
- refactor: session-start SKILL.md reduced from 290 to 210 lines (28% reduction) (#18)

## [2.0.0-alpha.9] - 2026-04-05 — Cross-Repo Learnings + Competitive Analysis

- **feat:** cross-repo learnings — anti-pattern detection, skill metadata extraction, confidence-based filtering
- **feat:** skill frontmatter extended with `tags` and `model-preference` fields
- **fix:** discovery probe consistency fixes (false positive reduction, deduplication logic)
- **analysis:** competitive analysis of everything-claude-code, projects-baseline, claude-code-skills repos

## [2.0.0-alpha.8] - 2026-04-04

### Fixed
- **enforce-scope.sh**: default enforcement changed from `warn` (fail-open) to `strict` (fail-closed) when `enforcement` field missing from `wave-scope.json`
- **enforce-commands.sh**: same fail-closed default applied
- **enforce-scope.sh**: incomplete regex metacharacter escaping — `+`, `?`, `|`, `[`, `]`, `(`, `)` now escaped before glob→regex conversion
- **enforce-scope.sh**: symlink bypass — `realpath` canonicalization added for both PROJECT_ROOT and FILE_PATH (directory-level resolution for new files)
- **enforce-commands.sh**: hardcoded fallback safety blocklist (`rm -rf`, `git push --force`, `git reset --hard`, `DROP TABLE`, `git checkout -- .`) enforced when `blockedCommands` absent from `wave-scope.json`
- **Both hooks**: `CLAUDE_PROJECT_DIR` environment variable now validated — must contain `.claude/` directory to be trusted
- **wave-executor**: jq prerequisite check added to Pre-Execution phase (step 4) — warns user if jq missing before wave dispatch

### Changed
- Plugin version alpha.7 → alpha.8
- SECURITY.md expanded with Enforcement Architecture, Prerequisites, Known Limitations, Credential Safety sections
- README.md: jq listed as prerequisite for enforcement hooks
- USER-GUIDE.md: credential safety warning added to Session Config section

## [2.0.0-alpha.7] - 2026-04-04

### Added
- **`/plan` skill** — structured project planning & PRD generation (#27)
- `/plan new` — project kickoff with 3-wave requirement gathering, full PRD, and repo setup
- `/plan feature` — compact feature PRD with 1-2 wave discovery
- `/plan retro` — data-driven retrospective from session metrics
- 3 PRD templates: full (8 sections), feature (5 sections), retro (metrics + actions)
- PRD reviewer prompt with 6-criteria quality review and max 3 iteration protocol
- Product Strategist soul identity (`skills/plan/soul.md`)
- 4 new Session Config fields: `plan-baseline-path`, `plan-default-visibility`, `plan-prd-location`, `plan-retro-location`

### Changed
- Plugin version alpha.6 → alpha.7
- SessionStart hook message updated to include `/plan [new|feature|retro]`
- Component counts updated: 8→9 skills, 4→5 commands

## [2.0.0-alpha.6] - 2026-04-04

### Fixed
- **Worktree enforcement bypass** — `find_project_root()` fallback added to both hook scripts (#21 prep)
- **Quality wave scope conflict** — two-phase scope enforcement: simplification agents get production file scope, then test/review agents get test-only scope (#21 prep)
- **Undefined `<session-start-ref>`** — `SESSION_START_REF` captured at session start, used in 3 locations (#21 prep)
- **PARTIAL/SPIRAL/FAILED detection** — STATUS reporting protocol with coordinator detection rules and definitions table (#21 prep)
- **Discovery embedded mode return contract** — JSON schema for findings + stats between discovery and session-end (#21 prep)
- **Learnings I/O** — in-memory tracking in Phase 3.5a, atomic rewrite in Phase 3.6, explicit conditions (#21 prep)
- 8 medium/low consistency fixes: subject matching, cross-module scope definition, sort order, gate headers, field naming, enforcement docs (M1-M6, L1-L2)

### Changed
- Version bumped alpha.5 → alpha.6 across 5 files
- Validation checklist expanded from 11 to 17 scenarios

## [2.0.0-alpha.5] - 2026-04-03

### Added
- **Confidence-based scoring for discovery probes** (#22) — 0-100 confidence score per finding based on pattern specificity, file context, and historical signal. Auto-defers low-confidence findings below configurable threshold (`discovery-confidence-threshold`, default: 60). Critical findings never auto-deferred.
- **Post-implementation simplification pass** (#23) — Quality wave now dispatches simplification agents before test writers, applying `slop-patterns.md` patterns to clean AI-generated code (unnecessary try-catch, over-documentation, redundant boolean logic, re-implemented stdlib functions).
- **Session-reviewer specialized review sections** (#24) — 3 new review sections: Silent Failure Analysis (catch blocks that swallow errors), Test Depth Check (assertion quality, mock boundaries), Type Design Spot-Check (overly broad types, missing unions). Per-finding confidence scoring (>=80 threshold).
- **CLAUDE.md quality audit probe** (#25) — New `claude-md-audit` probe in session category: validates Session Config paths, checks rules freshness against codebase, detects stale CLAUDE.md, cross-references technology mentions against package.json.
- **Session effectiveness tracking** (#26) — Extended `sessions.jsonl` schema with `discovery_stats`, `review_stats`, and `effectiveness` fields. Session-start surfaces completion rate trends, low-value probe detection, and carryover pattern analysis after 5+ sessions.
- Confidence Scoring Reference section in `probes.md` with per-category guidance
- Discovery Phase 6 (Capture Discovery Stats) for standalone mode

## [2.0.0-alpha.4] - 2026-04-03

### Fixed
- **enforce-scope.sh**: glob matching now supports `**` recursive patterns via regex conversion (was limited to single-level globs)
- **enforce-commands.sh**: word-boundary matching prevents false positives (e.g., `rm -rflag` no longer blocked by `rm -rf` pattern)
- **session_id uniqueness**: format changed from `<branch>-<YYYY-MM-DD>` to `<branch>-<YYYY-MM-DD>-<HHmm>` to prevent same-day collisions
- **Spiral detection scope**: clarified as per-agent (not per-wave) — two agents editing the same file is expected, not a spiral
- **Complexity tier boundaries**: rebalanced to Simple (0-1), Moderate (2-3), Complex (4-6) for better distribution
- **Dynamic scaling threshold**: "fast" defined as under 3 minutes wall-clock (was undefined)
- **Worktree merge strategy**: defined sequential merge protocol with conflict resolution heuristics
- **Directory creation**: explicit `mkdir -p` commands instead of prose instructions for STATE.md and metrics
- **JSONL write safety**: documented POSIX-atomic `>>` append, warned against read-modify-write
- **USER-GUIDE spiral wording**: corrected "per wave" to "per agent" to match authoritative circuit-breaker.md

### Added
- `deviation-pattern` learning type — session-end now reads STATE.md deviations for cross-session pattern extraction
- Discovery role enforcement: `allowedPaths: []` + read-only prompt instruction
- Quality role scope restriction: `allowedPaths` limited to test file patterns (`**/*.test.*`, `**/*.spec.*`, `**/__tests__/**`)
- Role combination verification example (Discovery+Impl-Core → Incremental checks)
- 6+ wave splitting criteria (by module/dependency boundary)
- jq prerequisite documentation in USER-GUIDE.md with install commands
- Integration test reference config (`docs/examples/integration-test-config.md`) covering all 30 Session Config fields
- Validation checklist (`docs/validation-checklist.md`) mapping to #21's 11 test plan items

### Changed
- Hook jq-missing warnings now explicitly state that enforcement is fully disabled
- `enforce-scope.sh` matching has 4 branches: directory prefix → recursive glob → simple glob → exact match

## [2.0.0-alpha.3] - 2026-04-03

### Added
- Session metrics tracking — wall-clock time, agent counts, files changed per wave (#8)
- Historical trend display in session-start showing last 5 sessions
- Adaptive wave sizing with complexity scoring (simple/moderate/complex tiers) (#19)
- Dynamic agent scaling between waves based on performance signals
- Cross-session learning system with confidence scoring (#20)
- Project Intelligence sections in session-start and session-plan from accumulated learnings
- Structured quality-gates output format (JSON) for metrics integration

### Changed
- Circuit breaker and worktree isolation extracted to `circuit-breaker.md` sub-reference
- session-plan steps renumbered (new Step 3: Complexity Assessment)
- session-end Final Report expanded with per-wave metrics breakdown and learnings summary
- Quality gates Variants 2 and 3 have structured JSON output specifications

## [2.0.0-alpha.2] - 2026-04-03

### Added
- Hybrid session persistence via STATE.md lifecycle (init/update/clear) + session memory files (#16)
- PreToolUse hook enforcement: enforce-scope.sh (Edit/Write), enforce-commands.sh (Bash) (#17)
- Circuit breaker with maxTurns limit and spiral detection (#18)
- Worktree isolation for parallel agent execution (#18)
- 5 new Session Config fields: persistence, memory-cleanup-threshold, enforcement, isolation, max-turns
- SESSION-START Phase 0.5 (Session Continuity) and Phase 5.5 (Memory Recall)

### Changed
- USER-GUIDE.md: 2 new sections (Session Persistence, Safety Features) + config fields + cheat sheet
- wave-executor: STATE.md initialization, post-wave updates, scope manifest, circuit breaker

## [2.0.0-alpha] - 2026-04-02

### Added
- quality-gates reference skill — canonical commands for typecheck, test, lint with 4 variants (Baseline, Incremental, Full Gate, Per-File)
- 9 new Session Config fields: test-command, typecheck-command, lint-command, ssot-freshness-days, plugin-freshness-days, recent-commits, issue-limit, stale-branch-days, stale-issue-days
- Role-to-wave mapping table — waves dynamically map to 5 roles (Discovery, Impl-Core, Impl-Polish, Quality, Finalization) based on configured wave count (3-6+)
- discovery skill with /discovery command — systematic quality audit with 22 probes across 5 categories (code, infra, ui, arch, session)
- 4 new Session Config fields for discovery: discovery-on-close, discovery-probes, discovery-exclude-paths, discovery-severity-threshold

### Changed
- gitlab-ops is now the single source of truth for all VCS operations — consuming skills reference it instead of duplicating commands (#11)
- Quality checks across all skills now reference quality-gates instead of hardcoding commands (#12)
- Session Config documentation consolidated — USER-GUIDE.md Section 4 is the authoritative field reference (#13)
- All hardcoded thresholds (SSOT freshness, plugin age, stale branches, etc.) are now configurable via Session Config (#14)
- Wave execution model rewritten from hardcoded wave numbers to role-based assignment (#15)
- Pencil design review triggers now reference Impl-Core and Impl-Polish roles instead of Wave 2/3
- Label taxonomy in CONTRIBUTING.md and USER-GUIDE.md now points to gitlab-ops as SSOT

### Removed
- ~80 lines of duplicated VCS detection/command logic across 4 skills
- ~30 lines of duplicated quality check commands across 4 skills
- ~60 lines of duplicated Session Config documentation across 3 files
- All hardcoded "Wave 1/2/3/4/5" references in favor of role names

## [1.0.0] - 2026-04-02

### Added
- 6 skills: session-start, session-plan, wave-executor, session-end, ecosystem-health, gitlab-ops
- 3 commands: /session, /go, /close
- 1 agent: session-reviewer (inter-wave quality gate)
- SessionStart hook with startup notification
- Soul personality system (soul.md)
- VCS auto-detection with dual GitLab + GitHub support
- 5-wave execution pattern with configurable agent counts
- Inter-wave Pencil design-code alignment reviews
- Ecosystem health monitoring (service endpoints + cross-repo scanning)
- Session Config system with 13 configurable fields
- User Guide, CONTRIBUTING guide, and example Session Configs
