<!-- source: session-orchestrator plugin (canonical: rules/always-on/npm-quality-gates.md) -->
# Quality Gates (Always-on)

Shipping code with known type errors, failing tests, or lint violations is a false economy: it offloads cost from the author onto every reviewer and future maintainer. The triad — typecheck, test, lint — is the minimum bar before any commit enters the branch.

## Rules

- **Run the full triad before every commit.** The three gates are typecheck, test, and lint. All three must pass. Skipping any one is not acceptable even under time pressure.
- **Commands come from Session Config.** Read `test-command`, `typecheck-command`, and `lint-command` from the project's `## Session Config` block in `CLAUDE.md`. These override any globally assumed defaults. This plugin's own gate runner assumes `npm` (`npm test`, `npm run typecheck`, `npm run lint`) — other projects may use `pnpm`, `yarn`, `uv run pytest`, or `cargo test`. Always use the project-configured commands.
- **CI must run the same gate.** Whatever commands are in Session Config, the CI pipeline must invoke the same commands in the same order. Divergence between local gates and CI is a configuration smell that will produce "passes locally, fails in CI" incidents.
- **Never commit with known TypeScript errors.** If `npm run typecheck` (or equivalent) fails, stop and fix the errors. Do not mark them as `@ts-ignore` or `@ts-expect-error` without an explicit comment explaining the suppression and a linked issue to resolve it properly.
- **Never commit with failing tests.** If tests are red, either fix the code or explicitly skip the test with a comment explaining why and a linked issue for follow-up. Never delete a test to make the suite green.
- **Never use `--no-verify`.** Pre-commit hooks enforce these gates at the git layer. Bypassing them with `--no-verify` ships a broken state to collaborators.
- **Fix root causes, not symptoms.** Suppression flags, `any` casts, and disabled lint rules are last resorts. When you reach for them, leave a `// TODO(#<issue>)` comment with a concrete follow-up.

## Anti-Patterns

- Running only one of the three gates before committing — each gate catches a different class of defect.
- Using `npm run typecheck || true` in CI to "ignore" type errors — this silently regresses the codebase.
- Wrapping a failing test in `describe.skip` without a linked issue — the failure disappears from view but the bug persists.
- Differing commands between local and CI (e.g., `pnpm test` locally vs `npm test` in CI) — produces unreliable feedback loops.
- Committing generated files with type errors and marking them `@ts-nocheck` — the generator needs fixing, not the output.

## See Also

- Session Config keys: `test-command`, `typecheck-command`, `lint-command` — set in `CLAUDE.md` under `## Session Config`.
