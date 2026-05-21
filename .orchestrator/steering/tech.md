# Steering: Tech Context

> Stable tech-stack facts for session context injection. Not session narrative.
> Maintained by: coordinator or `/plan new` scaffolding.
> Do NOT commit secrets. Do NOT include session-specific state here.

## Runtime Stack

- **Node.js:** 20+ (engine-strict enforced via `.npmrc`)
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
- **`CLAUDE_PLUGIN_ROOT` / `CODEX_PLUGIN_ROOT`:** 4-level fallback chain for plugin root resolution.
- **Vitest snapshot pollution:** fixture files in `tests/fixtures/` must be isolated; avoid shared mutable state.

## CI / Quality Gates

- `npm test` runs vitest with coverage
- `npm run lint` runs ESLint v10 flat config
- `npm run typecheck` runs the typecheck script (ESM type-check via `tsgo --noEmit` equivalent)
- Schema-drift CI requires `SCHEMA_DRIFT_TOKEN` deploy-token (see `docs/ci-setup.md`)
- Gitleaks 37-rule pre-commit hook active

## Learning & Memory Modernization (Phase 1)

Phase 1 of the [Learning & Memory System Modernization PRD](../../docs/prd/2026-05-21-learning-memory-modernization.md) ships three top-level migration scripts: `scripts/vault-consolidate.mjs` (one-shot fold of `~/Projects/vault/` into `~/Projects/Bernhard/vault/`, #499), `scripts/migrate-vault-paths.mjs` (cross-repo username-drift path repair, #499 follow-on), and `scripts/migrate-cold-start-seed.mjs` (welcome-banner-pending markers for dormant repos, #507).

The cold-start subsystem (`scripts/lib/cold-start-detector.mjs`, #500) detects bootstrapped repos with no closed sessions and surfaces a one-time nudge at SessionStart. The auto-dream subsystem (`scripts/lib/auto-dream.mjs`, #502) dispatches `/memory-cleanup --dry-run` from session-end Phase 3.6.5 and writes a unified-diff proposal to `.orchestrator/pending-dream.md` for operator application in the next session. The vault-mirror quality gate (#504) rejects skeletal session and learning notes below `vault-mirror.quality.{min-narrative-chars,min-confidence}` thresholds. Config parsers for both subsystems live under `scripts/lib/config/` (`cold-start.mjs`, `vault-mirror-quality.mjs`).
