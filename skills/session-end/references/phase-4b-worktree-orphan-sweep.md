# Phase 4b: Worktree-Orphan Sweep (#831/B5)

> Sub-file of the session-end skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-end/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 4b: Worktree-Orphan Sweep (#831/B5)

> Skip if `persistence: false` in Session Config. Skip silently unless `worktree-orphans.enabled: true` (opt-in; default `false`).

Sweep the repo's worktree set for branches with **0 commits ahead of the base branch** — orphans left behind by finished sessions. Distinct from Phase 4a: 4a asks "did *this* session run in a promoted worktree?", 4b asks "which worktrees from *past* sessions have nothing left in them?".

> **Ordering rationale (#490 durableCommit dependency):** Phase 4b runs AFTER the Phase 4 commit+push, NOT before — the same invariant that governs Phase 4a. Removing a worktree before commit+push would lose its `STATE.md` before the Phase 3.4 `sessions.jsonl` metrics writes are committed. See `docs/adr/0008-worktree-cleanup-ordering.md`.

### The module proposes; the coordinator disposes

> **Authoritative impl:** `scripts/lib/session-end/worktree-orphan-sweep.mjs` — `checkWorktreeOrphans({ repoRoot, mainCheckoutRoot, config, execFileFn })`. Import and call; do NOT re-implement from this doc.

`checkWorktreeOrphans()` **executes zero mutating commands.** Its complete argv set is four read-only shapes — `worktree list --porcelain`, `rev-list --count --end-of-options <base>..<branch>`, and (via the reused Phase 4a helper `isWorktreeClean`) `status --porcelain` and `status --short --branch` — all via the injection-safe arg-array form (`execFileSync('git', ['-C', dir, …])`, #577 HARDEN-001), never a template-literal shell string. It returns `null` (silent no-op) or ONE object `{ severity: 'warn', message, candidates: [{ wtPath, branch, sessionId, aheadCount: 0 }] }`.

**`--end-of-options` is load-bearing, not decoration.** `base-branch` comes from Session Config, and a value shaped like a git flag (e.g. `--glob=refs/heads/*`) is otherwise parsed by `rev-list` as an OPTION rather than a revision range — which exits 0 and prints `0`, silently marking EVERY worktree as a 0-ahead orphan and offering the operator "Löschen" for worktrees full of live work. That is not an error path the conservative default catches, because `0` parses fine. `--end-of-options` turns the payload into a hard git error that DOES fall into the conservative `continue`, and `_isSafeBaseBranch` in the config parser rejects leading-dash values at the source. No attacker is needed for this — a typo reaches the same outcome.

**The gate is opt-in and fails CLOSED:** the module returns `null` unless `enabled === true`. It accepts either the full config object or the already-indexed `worktree-orphans` block, so neither call shape can accidentally open the gate.

**A dirty worktree is never a candidate.** Orphan-ness is not decided by commit count alone — `isWorktreeClean()` is consulted first, and any uncommitted, staged or untracked work (or any git error while checking) excludes the worktree entirely. A worktree that is 0-ahead but holds live work is exactly the case where a deletion prompt would cost real data.

The return field is named `candidates`, not `orphans` or `removals`, and the name is load-bearing: **the coordinator decides, the module never does.** Grounding: `.claude/rules/parallel-sessions.md` § PSA-003 — *"Did I create this file/commit/change? If not, it is not mine to touch."* A sweep probe created none of the worktrees it inspects.

**Nothing is removed without explicit operator confirmation.** The rendered banner always ends with the literal clause `nothing was removed.` — the operator-visible proof of the invariant.

**Conservative default (safety-critical):** any git error, unparseable `rev-list` output, detached HEAD, unresolvable branch, or ambiguity of any kind → that worktree is NOT reported as a candidate. A failing sibling never suppresses a healthy finding, and silence is never to be read as "safe to delete".

### The AUQ is rendered by the coordinator, never by the module

`AskUserQuestion` is unavailable inside dispatched subagents (`.claude/rules/ask-via-tool.md` AUQ-004), so the module returns data only and the **coordinator** renders the picker — one call per candidate.

**Option order is locked and is itself a safety property (#580-AUQ-001): the non-destructive option goes FIRST and is marked `(Recommended)`, so an accidental Enter keypress can never destroy a worktree.**

`[ Behalten (Recommended) / Löschen / Manuell ]`

- **Behalten (Recommended)** — leave the worktree in place; re-surfaces next session.
- **Löschen** — operator explicitly authorises removal; the coordinator performs it, subject to PSA-003.
- **Manuell** — operator handles it outside the session; no further prompting this session.

```js
import { checkWorktreeOrphans } from '${PLUGIN_ROOT}/scripts/lib/session-end/worktree-orphan-sweep.mjs';

const sweep = checkWorktreeOrphans({
  repoRoot: process.cwd(),
  config: config['worktree-orphans'],
});

if (sweep) {
  console.warn(sweep.message);
  // → coordinator renders the AUQ per sweep.candidates entry.
  //   [ Behalten (Recommended) / Löschen / Manuell ]
  //   Nothing is removed unless the operator picks "Löschen".
}
```

