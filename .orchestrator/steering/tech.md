# Steering: Tech Context

> Stable tech-stack facts for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.

## Runtime Stack

- **Node.js:** 24+ (`package.json` engines; engine-strict enforced via `.npmrc`)
- **Test runner:** vitest 4.1.5
- **Linter:** ESLint 10 (flat config `eslint.config.mjs`)
- **Package manager:** npm (plugin uses npm, not pnpm — `npm ci` after cloning)
- **Language:** ESM-only `.mjs` source files — no CommonJS, no TypeScript transpile step

## Key Commands

| Purpose | Command |
|---------|---------|
| Install | `npm ci` |
| Test | `npm test` |
| Lint | `npm run lint` |
| Typecheck | `npm run typecheck` |
| Quality gate | `node scripts/run-quality-gate.mjs` |
| Validate plugin | `node scripts/validate-plugin.mjs` |

## Coverage Thresholds

vitest coverage enforces four gates (fail build if below):

| Metric | Threshold |
|--------|-----------|
| Statements | 70% |
| Branches | 65% |
| Functions | 70% |
| Lines | 60% |

## Constraints & Pitfalls

- **`.mjs` only:** all scripts and library modules use `.mjs` extension. Never add `.js` or `.cjs` files.
- **No `require()`:** ESM-only. Use `import`/`export` everywhere.
- **`ignore-scripts=true` in `.npmrc`:** postinstall scripts are blocked by default (SEC-020).
- **Agent YAML pitfalls (cause "agents: Invalid input" failure):**
  - `tools` field MUST be a comma-separated string, NOT a JSON array
  - `description` MUST be a single-line inline string, NOT a block scalar (`>` or `|`)
  - All 4 fields (`name`, `description`, `model`, `color`) are required; `tools` is optional
- **Plugin roots:** Claude uses `CLAUDE_PLUGIN_ROOT`; Codex hook manifests use native `${PLUGIN_ROOT}` and export `CODEX_PLUGIN_ROOT` for compatibility; Cursor uses `CURSOR_RULES_DIR`; Pi uses `PI_PLUGIN_ROOT`. Codex wrappers also set `SO_PLATFORM=codex` so explicit hook context wins over ambient detection.
- **Codex install state:** marketplace configured, plugin installed+enabled, and hooks trusted/executing are separate. `scripts/codex-install.mjs` uses public marketplace/add/list commands and never writes hook trust.
- **Codex refresh/versioning:** every installer run repeats `plugin add`; explicit invalidation is the committed `<base>+codex.<YYYYMMDDHHmmss>` manifest version, which the installer validates but never mutates.
- **Codex hooks — measured surface (codex-cli 0.144.4, 2026-09-06).** The runtime knows **ten** events; the shipped binary embeds one JSON-Schema pair per event (`strings -a <codex> | grep '"title": "'` → `pre-tool-use` / `post-tool-use` / `permission-request` / `pre-compact` / `post-compact` / `session-start` / `subagent-start` / `subagent-stop` / `user-prompt-submit` / `stop` `.command.{input,output}`). Our curated project surface is six of them: `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop` — `PreToolUse` and `SubagentStart` are declared but empty. Unwired-but-available: `UserPromptSubmit`, `PermissionRequest`, `PreCompact`, `PostCompact` (this repo has no handler for any of them). **`SessionEnd` and `Interrupt` do not exist at 0.144.4** — they are not "Claude-only", they are absent, and the manifest deserializer rejects unknown keys (`unexpected map key`), so adding one takes the whole manifest down rather than skipping one hook. `Interrupt` is 0.150.0+ and async hooks (`"async": true`) are 0.148+ — documented upstream, unverifiable on this host.
- **Codex hooks — why our handlers stay unwired, corrected.** The blocker is the tool-name VOCABULARY, not a missing payload adapter. `pre-tool-use.command.input` REQUIRES `tool_name` and `tool_input` (with `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_use_id`, `transcript_path`, `turn_id`), and the deny envelope is `hookSpecificOutput.{hookEventName,permissionDecision,permissionDecisionReason}` — byte-identical to `emitDeny()`. But Codex ships no `Bash`/`Edit`/`Write`/`MultiEdit` tool (`grep -c '"Bash"'` on the binary → 0); it has `shell`, `exec_command`, `unified_exec`, `apply_patch`, `update_plan`, `view_image`. Every PreToolUse guard opens with an equality gate on a Claude tool name and `emitAllow()`s otherwise, so wiring one yields false enforcement. Only the **Edit/Write matchers** additionally need an `apply_patch` payload adapter; the Bash guards need only a tool-name map. SSOT: `CODEX_NATIVE_EVENTS` / `CODEX_TOOL_NAMES` in `scripts/lib/codex/plugin-contract.mjs`.
- **Codex hook timeout budget:** all events documented at 600 s except `SessionEnd` and `Interrupt`, which upstream caps at **1 s default / 3 s max**. Neither event exists at 0.144.4, so this is a constraint for the day they are wired, not a live one — `hooks/on-session-end.mjs` measures ~221 ms median, which fits the 3 s ceiling with margin. Expensive handlers on other events can opt into `"async": true` (Codex 0.148+, unverified here).
- **Vitest snapshot pollution:** fixture files in `tests/fixtures/` must be isolated; avoid shared mutable state.

## CI / Quality Gates

- `npm test` runs vitest with coverage
- `npm run lint` runs ESLint v10 flat config
- `npm run typecheck` runs the typecheck script (ESM type-check via `tsgo --noEmit` equivalent)
- Schema-drift CI requires `SCHEMA_DRIFT_TOKEN` deploy-token (see `docs/ci-setup.md`)
- Gitleaks 37-rule pre-commit hook active

## Learning & Memory Modernization (Phase 1)

Phase 1 of the Learning & Memory System Modernization (epic #498) ships three top-level migration scripts: `scripts/vault-consolidate.mjs` (one-shot vault fold, #499), `scripts/migrate-vault-paths.mjs` (cross-repo username-drift path repair, #499 follow-on), and `scripts/migrate-cold-start-seed.mjs` (welcome-banner-pending markers for dormant repos, #507).

The cold-start subsystem (`scripts/lib/cold-start-detector.mjs`, #500) detects bootstrapped repos with no closed sessions and surfaces a one-time nudge at SessionStart. The auto-dream subsystem (`scripts/lib/auto-dream.mjs`, #502) surfaces a nudge at session-end Phase 3.6.5 (nudge-only, no live dispatch — #614); a manual `/memory-cleanup --dry-run` writes a complete-body MEMORY.md proposal (single fenced block, never a unified diff — #717) to `.orchestrator/pending-dream.md` for operator application in the next session. The vault-mirror quality gate (#504) rejects skeletal session and learning notes below `vault-mirror.quality.{min-narrative-chars,min-confidence}` thresholds. Config parsers for both subsystems live under `scripts/lib/config/` (`cold-start.mjs`, `vault-mirror-quality.mjs`).
