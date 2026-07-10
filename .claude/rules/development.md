---
tier: always
---

# Development Rules (Always-on)

## TypeScript Discipline
- Strict mode in all projects. No `any` without `// eslint-disable-next-line` + justification.
- Use `tsgo --noEmit` (NOT `tsc --noEmit`) for type checking — 3-5x faster.
- 0 TypeScript errors is a mandatory baseline. Never merge with errors.
- Use Zod for runtime validation at system boundaries (user input, API responses).
- Prefer `satisfies` over `as` for type assertions.
- Path aliases: `@/*` → `src/*` (Next.js), `~/*` → `src/*` (alternative).

### tsgo in CI (TS-001)
The `tsgo` binary lives in `node_modules/.bin/` after `pnpm install`. GitLab CI executors do **not** inherit `node_modules/.bin` on `$PATH` by default, so a bare `tsgo --noEmit` fails with `tsgo: command not found` or silently resolves to a different binary.

Always prepend the local `bin/` to `PATH` in any CI job that invokes `tsgo`:

```yaml
# .gitlab-ci.yml — typecheck job
typecheck:
  stage: validate
  script:
    - pnpm install --frozen-lockfile
    - export PATH=$(pwd)/node_modules/.bin:$PATH
    - tsgo --noEmit
```

Alternative: invoke via `pnpm exec tsgo --noEmit`. Slightly slower (pnpm lookup overhead) but path-safe and works without the PATH export. Prefer the PATH export when `tsgo` runs multiple times per job.

This quirk bit several consumer repos before it was codified — the baseline mandates `tsgo`, so the PATH discipline is a rule, not a trivia note.

## Package Management
- The CANONICAL package manager of a repo is defined by its COMMITTED lockfile — never assumed from a cross-project default. Check `package.json`'s `packageManager` field first, then which lockfile is tracked in git (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lockb`).
- pnpm is the cross-project default for newly scaffolded repos — but **this repo (session-orchestrator) is npm-canonical**: `package-lock.json` is the committed lockfile, `pnpm-lock.yaml` is gitignored. Always use `npm` commands here, never `pnpm` or `yarn`.
- Never run a different package manager's install command in a repo than its canonical one. Doing so silently rewrites `node_modules` to that PM's layout (e.g. pnpm's `.pnpm` store + symlinked deps) and strands a foreign lockfile at the repo root — the incident class behind issue #715 (a stray `pnpm-lock.yaml` sat gitignored at this repo's root, invisible to CI, until `scripts/check-package-manager.mjs` was added as a recurrence guard). This repo's `.npmrc` sets `ignore-scripts=true` (SEC-020), which makes npm's own `preinstall`/`pretest` lifecycle hooks silently DEAD — the guard is instead wired via an explicit `node scripts/check-package-manager.mjs && vitest ...` chain in the `test`/`test:coverage`/`test:watch` scripts, a git-native `.husky/pre-commit` hook, the `.gitlab-ci.yml` `.node-setup` `before_script` (right after `npm ci`), and the standalone `package-manager-guard` CI job.
- Lock files for the repo's canonical package manager must be committed. Never commit a lockfile for a different package manager than the one actually in use.
- CI enforces `npm audit --omit=dev --audit-level=high` in this repo (or the pnpm/yarn/bun equivalent in repos whose canonical PM is one of those). Fix critical/high vulnerabilities immediately.

## Git Conventions
Enforced by commitlint (see `.commitlintrc` / repo commitlint config). Quick ref: `type(scope): description`; `BREAKING CHANGE:` footer for majors.

## Code Style
Enforced by ESLint flat config (`eslint.config.mjs`) + Prettier. Notable behavioural rule: `no-console` error (except warn/error) — prevents PII leakage in production.

## Dependencies
- Prefer established, maintained packages. No packages with <1000 weekly downloads unless justified.
- Pin exact versions for critical deps (database drivers, auth, crypto). Semver ranges (`^`) for non-critical.

## Error Handling
- Never expose internal error messages to users (SEC-009).
- Use typed error classes. No generic `throw new Error("something went wrong")`.
- Log errors with structured data (correlation IDs, user context minus PII).
- Validate at boundaries, trust internally.
- **Env-var fallback whitespace trap:** `process.env.X || fallback` falls back only on *falsy* values — a whitespace-only value (`'   '`) is truthy and short-circuits the OR, returning the spaces verbatim. For string/path-valued env vars use `(process.env.X || '').trim() || fallback`.
- **Env-var wiring (dead env / three wirings):** an env var set in ops (docker-compose / deploy `.env`) but never read in `src/` is a **dead env** — ops thinks it active, code ignores it (hardcoded default wins); grep `src/` for every ops-set var, where 0 matches = wiring never finished. Conversely a new `process.env.X` read needs **three wirings**: code default, compose/env, and every deploy target's env.

## Documentation
- CLAUDE.md in every project root (50-100 lines, lean).
- Detailed rules in `.claude/rules/` with path-scoping.
- API docs via JSDoc/TSDoc on public functions.
- No README.md bloat — keep it minimal, link to docs.

## Corpus Freeze Marker (FROZEN-MANIFEST)

When a spinout/snapshot leaves a dead copy behind in the source repo (e.g. a
discovery kit forked into a new standalone repo), mark the retained copy with a
`FORK-NOTES.md` / `SNAPSHOT.md` at its root stating: frozen date, new SSOT
location, and "do not edit — see <SSOT>". Prevents silent double-maintenance of
a corpus whose canonical copy has moved. See `skills/spinout/SKILL.md` Phase 4.

## Guard & Threshold Design

When a counter-based guard (loop-guard, kill-switches, …) produces false
positives, the fix is category separation — split into distinct counters per
call-class — NOT raising the shared threshold. Raising a threshold weakens
detection for the true-positive class the counter was built to catch.
(Fleet-confirmed conf 0.95: 4 failed threshold-patches vs. 1 structural
category-split fix.)

## Local Tool Versioning
- `.nvmrc` is required for CI compatibility (Docker images use it). Keep in all repos.
- `.mise.toml` (mise-en-place) is optional for local dev — manages Node, pnpm, and other tools with a single file.
- Template available in `templates/shared/.mise.toml`. Both `.nvmrc` and `.mise.toml` can coexist.

## Package Lifecycle & Versioning
- **Patch** (`1.0.x`): bug fixes, doc corrections, internal refactors with no public API change.
- **Minor** (`1.x.0`): new exports, new optional parameters, new sub-path entrypoints. Fully backwards-compatible.
- **Major** (`x.0.0`): removed exports, renamed functions, changed required peer dep ranges, altered runtime behaviour. Never merge without a migration guide.
- **Pre-release**: use `1.2.0-beta.1` for cross-repo validation before major bumps. Tag as `beta`, never as `latest`.
- **Deprecation**: add `@deprecated` JSDoc + `console.warn` on first call. Keep deprecated API for at least one minor cycle (min 4 weeks). Remove in next major.
- **Breaking changes**: `BREAKING CHANGE:` in commit footer, `major` changeset type, CHANGELOG "Migration" subsection with before/after code diff, `MIGRATION-vN.md` in package dir.
- **Changesets + publishing**: tool-driven via `pnpm changeset`. Access control: all packages publish `access: restricted` to GitLab Package Registry (project 52). Never publish to public npm. `package.json` versions managed exclusively by `pnpm changeset version`.

## See Also
security.md · security-web.md · testing.md · frontend.md · backend.md · backend-data.md · swift.md · mvp-scope.md · cli-design.md · parallel-sessions.md · verification-before-completion.md · receiving-review.md
