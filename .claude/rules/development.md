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
- pnpm is the standard package manager for all JS/TS projects.
- Always use `pnpm` commands, never `npm` or `yarn`.
- Lock files (`pnpm-lock.yaml`) must be committed.
- Run `pnpm audit --prod` regularly. Fix critical/high vulnerabilities immediately.

## Git Conventions
- Conventional Commits: `type(scope): description`
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `perf`, `security`
- Scope: module/feature name (e.g., `auth`, `invoices`, `ci`, `deploy`)
- Subject: imperative mood, sentence-case, no period, max 120 chars
- Body: explain WHY, not WHAT (the diff shows what)
- Breaking changes: `feat!:` or `BREAKING CHANGE:` in footer

## Code Style
- ESLint v9 flat config (`eslint.config.mjs`). Never disable rules globally.
- Prettier handles formatting. No manual formatting discussions.
- `no-console`: error (except warn/error) — prevents PII leakage in production.
- File naming: kebab-case for files, PascalCase for React components and classes.
- One component per file. Co-locate tests (`*.test.ts` next to source).

## Dependencies
- Prefer established, maintained packages. Check npm download trends + last publish date.
- No packages with <1000 weekly downloads unless absolutely necessary.
- Pin exact versions for critical deps (database drivers, auth, crypto).
- Semver ranges (`^`) for non-critical deps.
- Run `pnpm outdated` monthly. Update in batches, test after each batch.

## Error Handling
- Never expose internal error messages to users (SEC-009).
- Use typed error classes. No generic `throw new Error("something went wrong")`.
- Log errors with structured data (correlation IDs, user context minus PII).
- Validate at boundaries, trust internally.

## Documentation
- CLAUDE.md in every project root (50-100 lines, lean).
- Detailed rules in `.claude/rules/` with path-scoping.
- API docs via JSDoc/TSDoc on public functions.
- No README.md bloat — keep it minimal, link to docs.

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
- **Changesets**: run `pnpm changeset` after every substantive change, before opening MR. One changeset per logical change. `patch` for fixes, `minor` for features, `major` for breaks.
- **Publishing checklist**: `pnpm test` -> `pnpm typecheck` -> `pnpm build` -> `pnpm changeset version` -> review diffs -> commit as `chore(release): version packages` -> `pnpm changeset publish` -> `git tag` + push.
- **Access control**: all packages publish `access: restricted` to GitLab Package Registry (project 52). Never publish to public npm.
- **No manual version edits**: `package.json` versions managed exclusively by `pnpm changeset version`.

## See Also
security.md · security-web.md · security-compliance.md · testing.md · test-quality.md · frontend.md · backend.md · backend-data.md · infrastructure.md · swift.md · mvp-scope.md · cli-design.md · parallel-sessions.md · verification-before-completion.md · receiving-review.md · ai-agent.md
