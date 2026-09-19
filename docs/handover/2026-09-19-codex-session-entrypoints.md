# Codex session entrypoints: merge and release handover

Date: 2026-09-19. Branch: `codex/session-entrypoints`. Implementation: `176b605c`, based on `8f6ac022`.

**Next-session priority: #1391.** The user explicitly assigned integration to the next session and requested that these fixes be active in the next release. Keep #1391 open through publication, production installation refresh and operational acceptance. Related existing work: #1263 and #1266; the latter still requires a visible desktop picker check.

## What was wrong, and what changed

This was a combination of adapter drift and argument handling, not evidence that Codex has no `go` or `close` support. The installed plugin already exposed those entries to native discovery. The portable generator, however, copied only skills and omitted command-only `session`. Passing a mode together with task prose also lacked an explicit leading-token boundary. The default remains `deep`; `housekeeping` and `ultradeep` are arguments to `session`, not separate commands. No `/start` alias was added.

- `scripts/generate-agents-skills.mjs` now generates the union of commands and skills with command precedence, valid canonical paths, native invocation policies and preserved explicit-only `go`/`close` behavior. The independent validator checks this union.
- `scripts/lib/session-invocation.mjs` and `scripts/resolve-session-invocation.mjs` parse the leading mode separately from inert task context. Empty input selects `deep`; `ultradeep` selects `deep` with the profile; invalid leading tokens warn and fall back. Input arrives through stdin, never shell interpolation.
- `commands/session.md`, session planning and wave execution honor the user's explicit request for parallel housekeeping in waves. Ordinary housekeeping keeps its one coordinator-direct wave. The actual approved plan owns custom wave metadata and counts; normal resource caps, scopes and reviews still apply.
- `.codex-plugin/plugin.json`, all four generated adapters, `docs/codex-setup.md` and shared platform-tool guidance match the supported entrypoints. The close discovery instruction also uses the runtime's available delegation with a sequential fallback when unavailable.

Read the actual implementation and regression tests before modifying these contracts:

- [Invocation command](../../commands/session.md), [parser](../../scripts/lib/session-invocation.mjs), [parser regressions](../../tests/commands/session-invocation.test.mjs).
- [Portable generator](../../scripts/generate-agents-skills.mjs), [independent validation](../../scripts/lib/validate/check-agents-skills.mjs).
- [Codex setup](../codex-setup.md), [platform tools](../../skills/_shared/platform-tools.md), [wave dispatch](../../skills/wave-executor/references/wave-loop-dispatch.md).

## Evidence and limits

Measured environment: Codex Desktop/CLI 0.153.4, macOS 26.6.2 arm64, Node 24.20.0. No model, reasoning effort or service tier was changed.

- Implementation full suite: 692 files passed / 1 skipped, 17,724 tests passed / 20 skipped; typecheck and lint passed. Plugin validator: 230 passed, 0 failed. All four generators were synchronized.
- Separate read-only review found no remaining implementation blocker after the parser command prefix and custom-wave dispatch fixes.
- Fresh public installation in an isolated `CODEX_HOME` accepted candidate `5.2.0+codex.20260919063435`. `skills/list` with `forceReload: true` returned installed and portable `session`, `go`, `close` enabled with `errors: []`. `plugin/read` confirmed the three native interface prompts.
- Installed canonical targets exist; `agents/openai.yaml` keeps `allow_implicit_invocation: false` for `go` and `close`. Eight real stdin parser cases passed, including Unicode, prose, ultradeep and inert shell-like text.
- A real npm tarball contained all 13 selected parser/entrypoint/policy/manifest files byte-identically; an independent dry-run checked 17 related package paths.
- The limited embedded close discovery covered seven session/adapter/package probes, found one stale sequential-delegation instruction, and that instruction was corrected. This was not a full repository or portfolio scan.
- Close drift check: 0 errors, 7 warnings about generated-rule learning references absent from this isolated worktree's local ledger. The full warning/note list is preserved in the accompanying close report. Configured archive phases completed and archived 0 documents.

**Not yet established:** green CI on the integrated SHA, a published release, refresh of the user's production plugin, a visible desktop picker, or complete LLM-driven lifecycle execution across all four harnesses. Native discovery is evidence of loading, not evidence of those operations. The production bundle at investigation time was `5.2.0+codex.20260917190217`; this session did not modify it. Computer Use explicitly blocks controlling Codex itself; do not work around that boundary.

## Next session: integration first

1. Read #1391 and the linked MR, this handover and the close report. Check current branch/HEAD and peer ownership before editing. This work ran in an isolated worktree because the main checkout had an active peer session. Keep that separation and retain this branch until integration is verified.
2. Fetch current `main`, inspect the complete MR diff and any new overlapping changes. Integrate/rebase in an isolated checkout without overwriting peer state. Do not use the older tracked `.codex/session-plan.md` as this session's plan; it describes an unrelated historical session.
3. Run the required checks on the resulting commit and require CI for that exact SHA. Earlier local passes and CI for another commit do not satisfy this step. Check generator outputs and packed artifacts after conflict resolution.
4. Merge the reviewed MR. Record the integrated SHA and CI evidence in #1391; do not auto-close the release carryover at merge time.

Useful checks from the repository root:

```sh
node scripts/generate-agents-skills.mjs --check
node scripts/generate-codex-skills.mjs --check
node scripts/generate-cursor-adapter.mjs --check
node scripts/generate-pi-prompts.mjs --check
node scripts/validate-plugin.mjs
npm run typecheck
npm run lint
SO_BOUNDED_WORKERS=1 npm test
npm run test:pack
```

The normal pre-push hook independently checks a materialized tracked tree. Keep it enabled. `test:pack` needs network access and complements the selected tarball-byte checks recorded above.

## Next release: delivery and activation

Follow [release](../../skills/release/SKILL.md) and [npm publishing](../../skills/npm-publish/SKILL.md). Ensure the Unreleased fix entry is included, all package/manifests use the release version, and the native cache identity is regenerated from the final bundle. Publish only after the release gates pass; read back the published artifact/version and marketplace metadata.

For an isolated installation regression, use a temporary Codex home and the public commands:

```sh
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin marketplace add "$RELEASE_CHECKOUT"
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin add session-orchestrator@kanevry --json
CODEX_HOME="$ISOLATED_CODEX_HOME" codex plugin list --available --json
```

Set both variables to deliberate temporary/test locations first. The production source here was `session-orchestrator@local`; preserve the actual installed source when refreshing it rather than installing a second competing copy. Use the public installed-plugin refresh procedure from the Codex setup guide and verify the returned cache version. A source merge, generated manifest or success exit alone is insufficient.

Start a fresh Codex task after refresh. Through the supported app-server protocol, initialize, then request `skills/list` with `forceReload: true` using both a neutral directory and the test project. For `plugin/read`, `marketplacePath` is the manifest file `.claude-plugin/marketplace.json`, not the marketplace directory. Verify enabled entries, empty load errors, canonical references and explicit-only policies.

## Operational acceptance before closing #1391

Use a disposable initialized project and a bounded harmless task; preserve the configured model. Exercise the actual `session` → `go` → `close` flow rather than merely reading skill text:

| Input / surface | Required observation |
| --- | --- |
| Codex `$session-orchestrator:session` with no mode, then explicit `deep` | Both select deep and produce a usable plan. |
| `housekeeping` with ordinary prose | Mode stays housekeeping; task text is preserved; ordinary one-wave shape remains. |
| `housekeeping` with an explicit parallel/waves request | The real plan records the override and dispatches within available worker caps with scopes, reviews and checkpoints. |
| `ultradeep` with task text | Deep mode plus ultradeep profile survives the lifecycle. |
| Explicit `$session-orchestrator:go` and `:close` | No implicit execution; close verifies work, dispositions carryover, writes a validated ledger entry before completed STATE, releases only its own lock and leaves a clean handover. |
| Fresh Codex desktop picker | `go` and `close` are selectable. Track the separate visible confirmation in #1266. |
| Claude Code, Cursor, Pi | Verify their actual entrypoint syntax, loading and lifecycle capabilities separately; do not infer native parallelism or hook enforcement from generated files. |

Record actual versions, input, plan/STATE/ledger observations and failures in #1391. Close the existing acceptance issues only when their own remaining criteria are evidenced. If a platform or picker cannot be exercised, keep that criterion explicitly open.

## What not to retry

- Do not replace `deep` with a new default or alter global config to hide parsing/discovery failures.
- Do not recreate command/skill twins in Claude Code or turn explicit-only `go`/`close` into implicit skills.
- Do not execute task prose as shell code, call the parser without `node`, or read custom-wave metadata from the ordinary housekeeping resolver shape.
- Do not claim the installed cache updated because source files changed; verify a fresh installed snapshot.
- Do not overwrite the active peer's STATE, lock, or shared vault board with this session's completed status.
