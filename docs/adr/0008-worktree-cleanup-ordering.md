# ADR 0008: Worktree-Cleanup Ordering — Phase 4a Runs After Phase 4 Commit+Push

> Status: Accepted · session main-2026-05-27-deep-3 · issues #574 #575
> Source: `skills/session-end/SKILL.md` § Phase 4a ordering rationale; `scripts/lib/session-end/worktree-cleanup.mjs`; issue #490 (durableCommit ordering invariant); CLAUDE.md "Auto-promoted worktree cleanup is Hybrid Pattern" critical gotcha.
> Project-instruction file resolution: this repo's root context file is `CLAUDE.md` on Claude Code / Cursor IDE and `AGENTS.md` on Codex CLI — transparent aliases per [skills/_shared/instruction-file-resolution.md](../../skills/_shared/instruction-file-resolution.md).

## Context

Epic #568 Phase 3 shipped two sub-issues that together constitute the Worktree-Auto-Promotion feature:

- **#574 (P3.1):** `enterWorktree()` in `scripts/lib/autopilot/worktree-pipeline.mjs` — creates a sibling worktree when the operator accepts the PROMOTION_OFFER AUQ at session-start Phase 0.5. Path layout: `<basePath>/<repo-name>-<sessionId>/`.
- **#575 (P3.2):** Hybrid Cleanup — Phase 4a in `skills/session-end/SKILL.md`, implemented in `scripts/lib/session-end/worktree-cleanup.mjs` — detects and removes (or prompts to retain) that sibling worktree at session close via `/close`.

The central design question was: **at which phase of the `/close` sequence should Phase 4a execute?**

The `/close` sequence has the following structure relevant to this decision:

| Phase | Description |
|---|---|
| Phase 3.4 | `sessions.jsonl` metrics write + STATE.md final update |
| Phase 3.8 | Session lock release |
| Phase 4 | Commit + push all changes (including `sessions.jsonl` + STATE.md) to origin |
| Phase 4a | Auto-promoted worktree cleanup (this ADR) |
| Phase 5 | Session summary output |

The worktree created by `enterWorktree()` is the directory from which the session ran. It contains the final `sessions.jsonl` entry and STATE.md written during the session. Removing it before Phase 4 would destroy those files before they are committed and pushed — exactly the failure class issue #490 (durableCommit ordering invariant) was established to prevent.

Two alternative orderings were considered:

1. **Before Phase 3.1 (pre-commit):** Earns simplicity — no worktree to track after commit. Rejected: the worktree's tracked files (`sessions.jsonl`, STATE.md) have not been staged or committed yet. Removal here is unconditionally destructive.
2. **After Phase 4 (post-push):** The worktree's contribution to the session record is durable on origin before removal. Safe to remove under the clean-check contract. **This is the chosen ordering.**

## Decision

**Phase 4a runs strictly after Phase 4 commit+push, never before.**

The invariant is: `sessions.jsonl` + STATE.md must be pushed to origin (durable) before the auto-promoted sibling worktree is touched in any way — including inspection, removal, or AUQ presentation.

The Hybrid Cleanup Pattern applied by Phase 4a is:

- **Detect:** `detectAutoPromotedWorktree(repoRoot, sessionId, opts)` from `scripts/lib/session-end/worktree-cleanup.mjs`. Uses `parseSessionId()` (never a custom regex) to identify semantic-format session IDs; UUID-format sessions return `null` immediately and skip Phase 4a entirely. Derives the main-checkout root from `git worktree list --porcelain` (not from `path.basename(repoRoot)`) to avoid the basename-self-compare structural impossibility surfaced in the W3 T2 finding during this session.
- **Clean path:** `isWorktreeClean(wtPath, opts)` — passes iff `git status --porcelain` is empty AND `git status --short --branch` contains no `ahead` indicator. If clean: `git worktree remove <wtPath>` (no `--force`), log WARN. Auto-remove without user confirmation is safe here because no uncommitted, untracked, or unpushed work exists.
- **Dirty path:** AUQ with three options — `Behalten (Recommended)` / `Löschen` / `Manuell`. Calling `git worktree remove --force` on a dirty worktree without explicit operator confirmation would violate PSA-003 (destructive action safeguards, `.claude/rules/parallel-sessions.md`). The dirty state may contain uncommitted work from another session or unmerged commits the operator has not reviewed.

All git invocations in Phase 4a use the injection-safe arg-array form (`execFileSync('git', ['-C', dir, …])` — #577 HARDEN-001). The legacy shell-interpolation form (`execSync(\`git -C ${var} …\`\)`) is forbidden.

## Consequences

**What changes:**

- Phase 4a is wired into `skills/session-end/SKILL.md` between Phase 4 and Phase 5. It is guarded by `persistence: false` skip and by the `detectAutoPromotedWorktree` null-return for non-promoted worktrees (the common case — overhead is one `git worktree list` call).
- `scripts/lib/session-end/worktree-cleanup.mjs` is the authoritative implementation. Skill bodies must import and call the module functions; re-implementing the detection or clean-check logic inline from the SKILL.md pseudocode is forbidden.
- The ordering constraint is documented in CLAUDE.md as a critical gotcha: *"The Phase 4a cleanup runs AFTER Phase 4 commit+push, not before — this respects #490 durableCommit ordering so sessions.jsonl + STATE.md are persisted to origin BEFORE worktree-removal."*

**What we keep unchanged:**

- **The #490 durableCommit ordering invariant.** `sessions.jsonl`, STATE.md, and all other session-telemetry files are always committed and pushed before any ephemeral workspace reclamation step. Phase 4a is a new consumer of this invariant, not an exception to it.
- **PSA-003 destructive-action safeguards.** A dirty worktree is never force-removed without explicit user authorization. The AUQ default option is `Behalten` (keep), not `Löschen`. This ensures that uncommitted or unpushed work from the session — or from any parallel session that may have touched the worktree — is never silently destroyed.
- **Session skip logic.** `persistence: false` in Session Config skips Phase 4a entirely. UUID-format session IDs (non-semantic, non-promoted) skip Phase 4a via early `null` return from `detectAutoPromotedWorktree`. The common case (no promoted worktree) incurs no user-visible behavior change.
- **The Manuell escape hatch.** The operator can abort `/close` at Phase 4a to inspect the worktree before any action. Re-running `/close` after manual resolution is supported — `detectAutoPromotedWorktree` will find the worktree already removed or return a new `null` on a clean re-run.

**Known limitations:**

- Phase 4a cannot remove a worktree that was created by a different session (wrong `sessionId` → `detectAutoPromotedWorktree` returns `null`). Orphaned worktrees from crashed sessions are the domain of `scripts/gc-stale-worktrees.mjs`, not Phase 4a.
- The `git worktree remove` command (no `--force`) will fail if the worktree has untracked files git cannot prune. In that edge case, the error is surfaced to the operator; `/close` does not abort silently.

## References

- Issue #490 — durableCommit ordering invariant (established in ADR 0003 context)
- Issue #574 — P3.1 Worktree-Auto-Promotion (`enterWorktree()`)
- Issue #575 — P3.2 Hybrid Cleanup (Phase 4a + `worktree-cleanup.mjs`)
- `skills/session-end/SKILL.md` § Phase 4a (authoritative phase spec)
- `scripts/lib/session-end/worktree-cleanup.mjs` (authoritative implementation)
- CLAUDE.md § "Auto-promoted worktree cleanup is Hybrid Pattern" (critical gotcha)
- `.claude/rules/parallel-sessions.md` PSA-003 (destructive action safeguards)
- Issue #577 — HARDEN-001: arg-array git invocation in worktree-cleanup
