# ADR 0014: Peer visibility under an advisory lock — annotate, never filter

> Status: Accepted · 2026-09-02 · session main-2026-09-02-session-1 · issue GH#67
> Authoritative implementation: [`scripts/lib/session-discovery.mjs`](../../scripts/lib/session-discovery.mjs) (`sessionFromRegistryEntry`)
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

`session.lock` is **advisory**, not exclusive (#1085 contract) — a second session can and demonstrably does run in the same working copy without ever holding it ("Vier Sessions, eine Arbeitskopie", 2026-08-23). GH#67's symptom is the visible consequence for one platform: Codex CLI has no `SessionEnd` hook, so a finished Codex task's session-registry entry stays a fresh-looking peer for up to `freshnessMin` (15 min) after the task is actually done — while a genuinely live local `session.lock` (a different session, or the same task on a retry) reports as the "current" owner of the root.

## Decision

**Additive annotation, never a filter.** `sessionFromRegistryEntry()` marks every registry-sourced session with `registryOnly: true` plus a `lockSuperseded` / `lockOwnerId` pair: `lockSuperseded: true` means a LIVE lock at this repoRoot is owned by a different raw `session_id` than this registry entry. It is a **HINT, not a verdict** — the lock is advisory, so the entry may equally be a live session that lost the acquire race. Lock-sourced sessions carry none of the three fields, so their shape stays byte-identical to pre-GH#67.

Consumers choose what to do with the hint: the parallel-aware preamble downgrades a `lockSuperseded` peer's `PROMOTION_OFFER` weight to an advisory line rather than treating it as absent; the session-start banner marks the peer inline (`supersessionMarker()`) while leaving `peer_count` unchanged, so the supersession rate stays independently measurable (`.claude/rules/host-resources.md` § HR-106); `orchestrator.session.started` gains an optional `peers_superseded` count.

## Rejected Alternative: Filter registry entries superseded by a live foreign lock

Rejected on measurement, 2026-09-02: filtering the entry out (instead of annotating it) turns **9 tests red** — `tests/lib/peer-discovery.test.mjs` cases `B1`, `B3`, `H2`, `H3`, `I1b`, `I5`, `I10b`, plus 2 cases in `tests/integration/session-identity-boundaries.test.mjs`. Every one of them pins visibility of a genuine same-working-copy peer under the #1085 semantic-alias boundary. A filter that hides "superseded-looking" entries hides exactly the peers those tests exist to keep visible — the lock's advisory status means "superseded" is never provable at discovery time, only suspectable.

## Consequences

The residual gap is real and named, not solved: a live lock still hides a *finished* Codex task for up to `DEFAULT_TTL_HOURS` (4 h, `scripts/lib/session-lock.mjs`) when nothing else marks the registry entry stale sooner — the annotation makes the ambiguity visible to consumers, it does not resolve it. Closing that gap needs a Codex task-end signal this repo does not currently receive; tracked as #1171.

## References

- Issue GH#67 — Codex CLI has no SessionEnd; registry entry outlives the finished task
- Issue #1085 — semantic-alias boundary (`tests/integration/session-identity-boundaries.test.mjs`)
- Issue #1171 — Codex task-end signal (residual gap, follow-up)
- `docs/events-schema.md` § `orchestrator.session.started` (`peers_superseded`)
- `.claude/rules/host-resources.md` § HR-106 (a banner number must be the number the rule judged)
- [ADR 0013 — Worktree-Auto-Promotion Is a Process Boundary, Not a Live Migration](0013-worktree-promotion-process-boundary.md) — nearest neighbour: both ADRs turn on the same fact (`session.lock` is advisory, not exclusive), applied to two different consumers
