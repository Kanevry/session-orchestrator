# Phase 4a: Auto-Promoted Worktree Cleanup (#575 P3.2)

> Sub-file of the session-end skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-end/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 4a: Auto-Promoted Worktree Cleanup (#575 P3.2)

> Skip if `persistence: false` in Session Config. Skip silently if the current worktree is NOT an Auto-promoted sibling (the common case).

After Phase 4 commit+push has durably persisted `sessions.jsonl` + `STATE.md` to origin, check whether the current session ran in an Auto-promoted sibling worktree (created via the P3.1 PROMOTION_OFFER path). If yes, apply Hybrid Cleanup-Pattern: clean → auto-remove, dirty → AUQ.

> **Ordering rationale (#490 durableCommit dependency):** Phase 4a runs AFTER Phase 4 commit+push, NOT before. Removing the promoted worktree before commit+push would lose the worktree's `STATE.md` before Phase 3.4 metrics writes (`sessions.jsonl`) are committed, violating the #490 durableCommit ordering invariant. Once Phase 4 has pushed all metrics + STATE.md to origin, the promoted worktree can be safely removed without data loss.

### Detection: is the current worktree an Auto-promoted sibling?

Auto-promoted sibling worktrees are created by `enterWorktree()` during the Phase 0.5 PROMOTION_OFFER path. Their path layout is `<basePath>/<repo-name>-<sessionId>/`. Detection uses `parseSessionId()` from `scripts/lib/session-id.mjs` (#572) — never custom regex.

> **Authoritative impl:** `scripts/lib/session-end/worktree-cleanup.mjs` — `detectAutoPromotedWorktree(repoRoot, sessionId, opts)`. Import and call; do NOT re-implement from this doc.
>
> Two keys, tried in this order:
>
> 1. **Marker (primary).** Reads `<repoRoot>/.orchestrator/promoted-from.json` (`PROMOTION_MARKER_RELPATH`), written by `enterWorktree()` at creation time with `branch`, `source_session_id`, `source_root_hash`, `source_root_basename`, `promoted_at`. Accepted when the file parses, carries a non-empty `branch` + `source_session_id`, and the worktree's current branch (`git branch --show-current`) either matches the recorded one or cannot be read at all — an unverifiable branch never triggers auto-removal by itself, since that is gated separately by `isWorktreeClean()`, which fails closed on any git error. On match returns `{ wtPath, sessionId: marker.source_session_id, branch: marker.branch, source: 'marker' }`. This is the only key that survives the #1069 process boundary: since #1069 the session that RUNS in the promoted worktree is a brand-new session with its own id (see ADR-0013), so the current session's id appears in neither the worktree's directory name nor its branch — key 2 below can never match a #1069-promoted worktree.
> 2. **Basename (legacy fallback).** Parse `sessionId` via `parseSessionId()`; return `null` immediately for UUID-format sessions (never auto-promoted). Derive the MAIN checkout root from the first `worktree ` entry of `git worktree list --porcelain` (NOT `path.basename(repoRoot)` — the promoted worktree's basename IS the comparison target). If `repoRoot` resolves to the main checkout, return `null`. Otherwise compare `path.basename(repoRoot)` against `<main-repo-name>-<sessionId>` (the CURRENT session id); on match return `{ wtPath, sessionId, branch: parsed.branch, source: 'basename' }` — still correct for worktrees created before the marker existed. Returns `null` on no match.
>
> All git invocation is via the injection-safe `opts.execFileFn` (default `execFileSync` with an args array — #577 HARDEN-001).

### Clean-check

A worktree is clean iff ALL three conditions hold:

1. **No uncommitted changes**: `git status --porcelain` is empty
2. **No untracked files**: implicit in #1 (porcelain includes `??` entries)
3. **No unpushed commits**: `git status --short --branch` does NOT contain `ahead` indicator

> **Authoritative impl:** `scripts/lib/session-end/worktree-cleanup.mjs` — `isWorktreeClean(wtPath, opts)`. Import and call; do NOT re-implement from this doc.
>
> Algorithm: run `git status --porcelain`; filter blank lines, then discount EXACTLY the one untracked line the promotion marker itself produces (`?? .orchestrator/promoted-from.json` — in a repo where `.orchestrator/` is only partly gitignored, or on a worktree whose branch predates the ignore line, the marker `enterWorktree()` writes would otherwise make every promoted worktree read "dirty"; a modified/staged/renamed/conflicted marker still counts as dirty). If any lines remain → dirty (`false`). Else run `git status --short --branch`; if it matches `/\bahead\b/` → unpushed (`false`). Otherwise `true`. On ANY git error → `false` (conservative PSA-003 default: never auto-remove a worktree we could not verify). Git invocation is via the injection-safe `opts.execFileFn` (default `execFileSync` with an args array — #577 HARDEN-001).

### Clean path: auto-remove + WARN (PRD §3 P3 Gherkin row 2)

When detection returns a worktree object AND `isWorktreeClean()` returns `true`, auto-remove via `git worktree remove` (NO `--force`) and log a WARN line. The main checkout's git dir (`repoMainRoot`) is derived via the first entry of `git worktree list --porcelain`.

> **Authoritative impl:** import `detectAutoPromotedWorktree` + `isWorktreeClean` from `scripts/lib/session-end/worktree-cleanup.mjs`. All git invocation MUST go through the injection-safe arg-array form (`execFileSync('git', ['-C', dir, …])`, #577 HARDEN-001) — never the legacy `execSync(\`git -C ${var} …\`)` template-literal shell form.

```js
import { execFileSync } from 'node:child_process';
import { detectAutoPromotedWorktree, isWorktreeClean } from '${PLUGIN_ROOT}/scripts/lib/session-end/worktree-cleanup.mjs';

const promoted = detectAutoPromotedWorktree(process.cwd(), sessionId);
if (!promoted) {
  // Not auto-promoted — skip Phase 4a entirely. Continue to Phase 5.
} else {
  // Derive main checkout root from first worktree-list entry (arg-array, no shell)
  const wtList = execFileSync('git', ['-C', promoted.wtPath, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
  const mainLine = wtList.split('\n').find((l) => l.startsWith('worktree '));
  const repoMainRoot = mainLine ? mainLine.slice('worktree '.length).trim() : null;

  if (isWorktreeClean(promoted.wtPath)) {
    // Clean path: PRD §3 P3 Gherkin row 2 — auto-remove
    console.warn(`session-end Phase 4a: auto-promoted worktree ${promoted.wtPath} is clean — removing via 'git worktree remove'`);
    execFileSync('git', ['-C', repoMainRoot, 'worktree', 'remove', promoted.wtPath], { encoding: 'utf8' });
  } else {
    // Dirty path: PRD §3 P3 Gherkin row 3 — AUQ before any destructive action
    // [AUQ block — see Dirty path subsection below]
  }
}
```

### Dirty path: AUQ before destructive action (PRD §3 P3 Gherkin row 3)

When the worktree is dirty (uncommitted, untracked, OR unpushed), render this AUQ via the coordinator's `AskUserQuestion` tool. The AUQ is coordinator-only — per `.claude/rules/ask-via-tool.md` AUQ-004, dispatched agents cannot call AUQ. Calling `git worktree remove --force` without explicit operator confirmation would violate PSA-003 (destructive action safeguards) — the dirty state may contain another session's work-in-progress or unmerged commits.

```js
// What is actually at stake, shown beside the options via `preview` (AUQ-006):
// the operator must see WHICH changes he would lose before he authorises the delete.
// Capped at 10 lines so the preview never outgrows the option list next to it.
const dirtyDetail = execFileSync('git', ['-C', promoted.wtPath, 'status', '--short', '--branch'], { encoding: 'utf8' })
  .trim()
  .split('\n')
  .slice(0, 10)
  .join('\n');

AskUserQuestion({
  questions: [{
    question: `Auto-promoted worktree at ${promoted.wtPath} has uncommitted/untracked/unpushed changes. How should I proceed?`,
    header: "Worktree",
    multiSelect: false,
    options: [
      { label: "Behalten (Recommended)", description: "Keeps the worktree exactly as it is — nothing is deleted, and you can still remove it by hand later.", preview: `Stays on disk:\n${dirtyDetail}` },
      { label: "Löschen", description: "I confirm the changes are handled or expendable. Run 'git worktree remove --force' on the worktree.", preview: `Deleted with the worktree:\n${dirtyDetail}` },
      { label: "Manuell", description: "Exit /close. I will inspect the worktree before re-running /close.", preview: `You would inspect this first:\n${dirtyDetail}` },
    ],
  }],
});
```

**Codex CLI / Cursor IDE fallback** (numbered Markdown list):

```
Worktree cleanup options (the changes at stake are the `git status --short --branch` lines printed above):
1. **Behalten (Recommended)** — Keeps the worktree exactly as it is; nothing is deleted, and you can still remove it by hand later.
2. **Löschen** — I confirm the changes are handled or expendable. Run 'git worktree remove --force'.
3. **Manuell** — Exit /close. I will inspect the worktree before re-running /close.
Reply with the number of your choice.
```

**On user choice:**

- **Behalten** → log `session-end Phase 4a: auto-promoted worktree retained (dirty); operator chose Behalten`. Continue to Phase 5.
- **Löschen** → `execFileSync('git', ['-C', repoMainRoot, 'worktree', 'remove', '--force', promoted.wtPath])` (arg-array, no shell — #577 HARDEN-001). Log WARN: `session-end Phase 4a: auto-promoted worktree force-removed by user choice`. Continue to Phase 5.
- **Manuell** → exit `/close` cleanly. Print: `session-end aborted at Phase 4a by user choice. Re-run /close after handling the worktree manually.`

### Cross-references

- **PRD:** "Parallel-Aware Sessions" (#568; archived in the private Meta-Vault) §3 P3 Gherkin rows 2-3 + §3.A P3 EARS event-driven clauses
- **PSA-003:** `.claude/rules/parallel-sessions.md` — destructive action safeguards (`git worktree remove --force` requires explicit user authorization)
- **#490 durableCommit dependency:** Phase 4a runs AFTER Phase 4 commit+push to guarantee `sessions.jsonl` + `STATE.md` are persisted to origin BEFORE worktree removal
- **Detection helper:** `parseSessionId()` from `scripts/lib/session-id.mjs` (#572)
- **AUQ rule:** `.claude/rules/ask-via-tool.md` AUQ-004 — coordinator-only invocation
- **Companion phases:** P3.1 PROMOTION_OFFER (`enterWorktree()` in `parallel-aware-auq.md`) creates the worktree; this phase removes it.

