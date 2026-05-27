# ADR 0009: Worktree Path-Layouts — Two Functions, Two Layouts, No Unification

> Status: Accepted · session main-2026-05-27-deep-3 · issues #574 #580
> Source: `scripts/lib/autopilot/worktree-pipeline.mjs` module-header comment + `enterWorktree()` / `setupWorktree()`; `skills/_shared/parallel-aware-preamble.md` § PROMOTION_OFFER outcome-handling; `docs/prd/2026-05-26-parallel-aware-sessions.md` §3 P3 layout requirement.
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

`scripts/lib/autopilot/worktree-pipeline.mjs` exports two functions that each create a git worktree but with structurally different path layouts and different lifecycle contracts:

| Function | Caller | Path layout | Lifecycle |
|---|---|---|---|
| `enterWorktree()` | session-start Phase 0.5 PROMOTION_OFFER | `<basePath>/<repoName>-<sessionId>/` (sibling-flat, 1-level) | One worktree per interactive session; removed at session-end Phase 4a |
| `setupWorktree()` | `runStoryPipeline()` → autopilot-multi | `<worktreeRoot>/<repoBasename>/<issueIid>/` (2-level nested) | One worktree per story/issue; GC'd by `gc-stale-worktrees.mjs` after loop exit |

The path layouts are not merely cosmetically different — they reflect different requirements:

**`enterWorktree()` (sibling-flat):** The promoted worktree must live as a sibling of the primary repo checkout so the operator can navigate to it naturally (`cd ../myrepo-main-2026-05-27-deep-3/`) and so `detectAutoPromotedWorktree()` in Phase 4a can identify it by matching `path.basename(repoRoot)` against `<repoName>-<sessionId>`. The PRD §3 P3 Gherkin row-1 layout requirement explicitly specifies this `<basePath>/<repo-name>-<sessionId>/` form. A 2-level nested path would break the detection algorithm.

**`setupWorktree()` (2-level nested):** Autopilot-multi runs N stories in parallel, each in its own worktree under a shared `WORKTREE_ROOT_DEFAULT` (`~/.so-worktrees`). The 2-level `<worktreeRoot>/<repoBasename>/<issueIid>/` layout keeps all story worktrees for a given repo co-located under one directory (`~/.so-worktrees/myrepo/`), making `gc-stale-worktrees.mjs` scans and `teardownWorktree()` GC straightforward. Flattening to a sibling layout would scatter per-story worktrees into the user's project directory and conflict with the `enterWorktree()` naming convention.

A naive unification — a single `createWorktree(opts)` that switches on a `layout` parameter — was considered and rejected. The layouts are not configuration knobs; they are load-bearing contracts tied to detection, GC, and lifecycle logic that differ per consumer. Unification would require the callers to know which layout they need, which is equivalent to having two separate functions but with an additional switch parameter and a shared internal surface that neither consumer needs.

### DI seam divergence (#580-DI-001)

Both `enterWorktree()` and `setupWorktree()` use an async `opts.$` (zx template-tag) DI seam for git operations — because both are async functions that `await` git commands.

The synchronous cleanup and sweep helpers in the same ecosystem — `scripts/lib/session-end/worktree-cleanup.mjs` and `scripts/lib/memory-cleanup/worktree-sweep.mjs` — use an `opts.execFileFn` (synchronous `execFileSync`) DI seam, because they run in synchronous coordinator steps.

This seam divergence is intentional. Forcing a single seam across the async and sync boundaries would require either:

- Making the sync helpers async (introducing `await` into steps that the session-end and memory-cleanup coordinators rely on being synchronous), or
- Making the async functions synchronous (breaking the zx-based git call model and the lazy-import isolation that Pipeline 3848 commit 1347c7a established to prevent `vi.mock` routing failures).

The module-header comment in `worktree-pipeline.mjs` (§ DI seam #580-DI-001) explicitly documents this: *"The seams are kept divergent on purpose — forcing a single seam would break the sync/async boundary. Do NOT unify."*

## Decision

**Keep `enterWorktree()` and `setupWorktree()` as two separate exported functions with distinct path layouts and DI seams. Do not introduce a shared path-layout abstraction or unify the `opts.$` / `opts.execFileFn` seams.**

Callers choose the function that matches their use-case:

- **Use `enterWorktree()`** when session-start Phase 0.5 fires a PROMOTION_OFFER and the operator accepts. One call per session. The returned `wtPath` follows the sibling-flat layout and is registerable with `detectAutoPromotedWorktree()` at session-end.
- **Use `setupWorktree()`** (via `runStoryPipeline()`) when autopilot-multi drives a batch of stories in parallel. One call per story/issue IID. The returned `wtPath` follows the 2-level nested layout under `WORKTREE_ROOT_DEFAULT`.

Neither function should be called in the other's context. Specifically: `enterWorktree()` must not be used for per-story autopilot-multi worktrees (the sibling-flat path would conflict with `gc-stale-worktrees.mjs` scans and scatter worktrees into the project directory), and `setupWorktree()` must not be used for the PROMOTION_OFFER path (the 2-level layout would break `detectAutoPromotedWorktree()` and violate the PRD §3 P3 layout requirement).

The `opts.$` / `opts.execFileFn` seam split is preserved as the canonical pattern for the async/sync boundary. New worktree helpers that run in async contexts use `opts.$`. New helpers that run in synchronous coordinator steps use `opts.execFileFn`. Cross-seam adaptation (e.g., promisifying `execFileSync` to pass it as `opts.$`) is explicitly forbidden — it defeats the DI purpose and the testability the seam provides.

## Consequences

**What the path-layout split enables:**

- `detectAutoPromotedWorktree()` can identify a promoted worktree purely from its path basename without maintaining any additional state or registry. The naming contract (`<repoName>-<sessionId>`) is self-describing.
- `gc-stale-worktrees.mjs` can scan for per-story worktrees under `~/.so-worktrees/<repoBasename>/` without risk of matching promoted-session worktrees (different root, different naming pattern).
- Neither function needs to be aware of the other's callers, layout rules, or GC policy.

**What the seam split enables:**

- Test isolation: `vi.mock('zx', ...)` routes cleanly to `opts.$` seam callers because the lazy import pattern (`await import('zx')` inside the function) preserves module-load order. Sync helpers mock `opts.execFileFn` independently with a simple `vi.fn()`.
- The sync/async boundary remains explicit at the call site. A coordinator step that imports `detectAutoPromotedWorktree` knows it is synchronous without inspecting the implementation.

**Engineering guidance for new worktree helpers:**

- If the helper runs in an `async` context (awaits git, runs in `runStoryPipeline` or `enterWorktree`): add an `opts.$` DI seam, use lazy `await import('zx')` as default.
- If the helper runs in a sync coordinator step (session-end, memory-cleanup, session-start detection): add an `opts.execFileFn` DI seam, default to `execFileSync` with an arg-array (#577 HARDEN-001 — no shell interpolation).
- If a helper must span both contexts: split it into an async variant and a sync variant rather than introducing a mixed abstraction.

**Known non-issues:**

- The two-function surface adds a small discoverability burden: a new contributor may not immediately know which function to call. The JSDoc on each function (`enterWorktree` JSDoc: "This is structurally distinct from `setupWorktree`…") and this ADR together cover the routing guidance.
- `WORKTREE_ROOT_DEFAULT` (`~/.so-worktrees`) is a constant shared by `setupWorktree()` and `teardownWorktree()` but not by `enterWorktree()` (which uses `basePath` from the caller). This is correct: the promoted-session worktree lives in the user's project directory (`basePath`), not in the hidden dot-directory.

## References

- Issue #574 — P3.1 Worktree-Auto-Promotion (`enterWorktree()` + sibling-flat layout)
- Issue #580 — follow-up audit; #580-DI-001 seam-divergence documentation
- `scripts/lib/autopilot/worktree-pipeline.mjs` module-header comment and `enterWorktree()` JSDoc
- `skills/_shared/parallel-aware-preamble.md` § PROMOTION_OFFER outcome-handling
- `docs/prd/2026-05-26-parallel-aware-sessions.md` §3 P3 layout requirement (Gherkin row-1)
- `scripts/lib/session-end/worktree-cleanup.mjs` — `detectAutoPromotedWorktree()` (consumes sibling-flat naming contract)
- `scripts/gc-stale-worktrees.mjs` — GC for 2-level nested per-story worktrees
- ADR 0008 — worktree-cleanup ordering (Phase 4a, consumer of `enterWorktree()` path contract)
