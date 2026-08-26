<!-- source: session-orchestrator plugin (canonical: rules/always-on/parallel-sessions.md) -->
# Parallel Session Awareness (Always-on)

Multiple Claude Code sessions may be active in the same working directory simultaneously. Another agent may be editing files, creating commits, or running builds right now. Treat the repo as a shared workspace, not a private sandbox.

## PSA Scope Axes — Operator-Session vs In-Run

PSA rules span two distinct axes. Naming them keeps clear which rule protects what:

- **Operator-session axis:** independent parallel operator / Claude sessions in the **same working copy**. PSA-001..004, plus the per-repo session lock, guard this domain. Native in-run multi-agent primitives cannot enter it — they are per-process / per-session, never per-repo.
- **In-run axis:** multiple agents coordinated inside a single session/run. Native agent-coordination features provide **no automatic isolation**: file-scope deconfliction (no two agents in the same wave may modify the same file) plus serialized STATE.md writes still do work the platform does not.

PSA-005 spans **both** axes; only its session-lock half is purely operator-scoped. PSA-006 is **orthogonal** to both (Discovery grep-discipline). PSA-007 is in-run only.

## Decision Tree — What To Do When You Detect Parallel Signals

```
Did I detect any parallel-session signal?
│
├─ No  →  Continue normally.
│
└─ Yes →  Does the signal originate from a SIBLING wave-agent dispatched in
          THIS SAME wave (in-run axis — same dispatch round, the file sits
          inside that sibling's declared file-scope per the wave plan) —
          AND the file is NOT ALSO inside my own declared file-scope?
          │
          ├─ Yes →  NOT a PSA-002 case. Confirm the sibling's file-scope
          │          ownership against the wave plan, then continue working —
          │          note it PSA-001-style, do not pause. (PSA-007 governs the
          │          in-run git-write rule.)
          │
          └─ No  →  Does the signal touch files/scope I own in this task?
                    │
                    ├─ No  →  PSA-001 (Aware): note the signal, continue
                    │          working. Do NOT pause. Do NOT "fix" the foreign
                    │          change.
                    │
                    └─ Yes →  PSA-002 (Pause): stop the current action, ask the
                              user before proceeding. This branch also catches a
                              file assigned to BOTH my scope AND a sibling's
                              scope per the wave plan (a wave-plan deconfliction
                              bug) — that overlap is a genuine in-run collision,
                              never a benign sibling signal, so the sibling
                              branch above may not mask it.
```

**Scope overlap examples (triggers PSA-002):**
- A file you are about to edit is already modified by someone else.
- Staged changes in `git diff --cached` include files you did not touch.
- A build error appears in a file you just edited — but the error is in a line you didn't change.

**No-overlap examples (stay at PSA-001):**
- Unfamiliar commits in `git log` for modules you are not working on.
- New untracked files in directories outside your file scope.
- A test failure in a file not in your task's file-scope list.

## PSA-001 — Aware (Passive Detection, No Pause)

Detect and note parallel-session signals without interrupting your work. Continue normally when the signal does not overlap your owned files.

**Signals to recognise:**
- **Unexpected git status changes:** files modified or staged that are not part of your current task likely belong to another session.
- **Unfamiliar commits:** new entries in `git log` that you did not create mean another agent (or the user manually) committed work.
- **Spontaneous errors:** build failures, type errors, or test failures in code you did not touch may be in-progress work from another session — not pre-existing bugs.
- **Files changed between reads:** if a file's content differs from what you read moments ago, another session likely edited it.
- **New untracked files:** files appearing in `git status` that you did not create belong to someone else's work.

**In-run caveat:** in a wave dispatched without per-agent isolation, unfamiliar modifications outside your own scope may simply belong to a sibling wave-agent's declared file-scope in the SAME dispatch round — disambiguate against the wave plan before logging it as a generic parallel-session signal (see PSA-007).

**PSA-001 behaviour:**
- Log the observation in your response narrative.
- Do NOT pause, do NOT ask the user, do NOT "fix" foreign changes.
- Continue with your assigned task in your own file scope.

## PSA-002 — Pause (Active Conflict, Stop and Ask)

When a parallel-session signal **directly overlaps your owned scope**, stop the current action and ask the user before proceeding.

**Triggers (overlap = PSA-002):**
- A file in your task's file-scope list has unexpected modifications you did not make.
- `git diff --cached` includes staged changes you did not stage.
- A file you need to write or edit is locked in an in-progress state by another session.
- External changes block your task (e.g. a merge conflict in one of your files).

**PSA-002 behaviour:**
- Stop immediately — do not overwrite, merge, or work around the conflict.
- Ask the user: *"I notice changes I didn't make in [file(s)] that are in my task scope. Is another session active?"*
- Wait for user guidance before touching the affected file(s).
- **Never "fix" code outside your task scope.** Errors in files you are not working on may be intentional intermediate states from another session.
- **If blocked by external changes, ask the user** rather than reverting, resetting, or working around them.
- **Track your own footprint.** Be aware of which files you have created or modified. Your commits should contain only your changes.

## PSA-003 — Destructive Action Safeguards (Never Destroy What You Didn't Create)

These commands require explicit user confirmation even in normal operation. When parallel work is suspected, they are **forbidden** without user approval:
- **`git reset` (any form)** — destroys staged or committed work that may belong to another session.
- **`git checkout -- <file>`** — discards uncommitted changes another session is actively building.
- **`git clean -f`** — deletes untracked files another session created.
- **`git stash`** — captures another session's changes into a stash they cannot find.
- **`rm` / delete of files you did not create** — may remove work-in-progress from another session.
- **`git revert` of commits you did not make** — undoes another session's completed work.
- **`git push --force`** — rewrites shared history (dangerous even without parallel sessions).

Before running any of the above, ask: "Did I create this file/commit/change? If not, it is not mine to touch."

## PSA-004 — Commit Discipline (Isolate Your Changes)

- **Stage files individually** (`git add <file>`) rather than `git add .` or `git add -A`, which may sweep in another session's work.
- **Review `git diff --cached` before committing** to verify every staged change is yours.
- **If you see unfamiliar changes in the diff, unstage them** and ask the user.
- **Never amend a commit you did not create.**

## PSA-005 — Mechanical STATE.md Write Protection

The behavioural rules above are complemented by mechanical enforcement. When `state-md-lock.enabled: true` is set in Session Config, every STATE.md write is wrapped by the plugin's session-lock helper (`withStateMdLock(repoRoot, fn)`), which guards an `.orchestrator/state.lock` lockfile using atomic tmp-file + rename acquisition with liveness-based stale detection.

**What this mechanically enforces:**
- **PSA-003:** a concurrent writer cannot overwrite STATE.md while another writer holds the lock. The race is structurally impossible — not merely discouraged.
- **PSA-004:** STATE.md updates are serialised; no frontmatter update can be silently lost between two concurrent callers.

**Bypass mechanics:** lock timeout defaults to 10s (`state-md-lock.timeout-ms`). On a stale lock (holder no longer alive) → atomic override + WARN on stderr. On genuine contention timeout → the caller receives a failure result and must decide whether to retry or abort.

**When to use:** all STATE.md writers (session-start, inter-wave checkpoints, session-end), and any hook that mutates STATE.md.

**When NOT to use:** STATE.md *readers* — locking readers serialises them with no safety benefit. The session lock is a separate, orthogonal domain: the session lock means "this working copy is occupied by an active session"; the state lock means "STATE.md is being written right now".

## PSA-006 — Discovery Grep-Verification

Discovery agents and exploration agents MUST verify any distributional claim — "100% of callers opt-in", "N of M sites use pattern X", "no remaining references to Y", "all instances replaced" — **and any bare number describing repo state** ("14 commits since the ref", "5 dirty files", "412 lines") with an EXECUTED measurement command: `grep`/`rg`/`find` for code locations, `git`/`wc`/`jq`/`ls`/`node` for repo state. The output MUST quote:

1. The exact command executed.
2. The file scope passed to the tool.
3. The resulting count or zero-match assertion.
4. WHEN it was measured — an ISO date, or the SHA / `HEAD` it was measured at. A fact re-used by a downstream wave hours later is a claim about the PAST unless it carries its measurement time.

Untestable adoption claims based on inference, partial sampling, or model recall are **forbidden**. Coordinators reviewing Discovery output MUST REJECT claims that lack a quoted measurement transcript and ask for re-verification — even when the claim is plausible. Verification cost is cheap; mid-session correction cost is expensive.

**When PSA-006 does NOT apply:**
- Inline single-file reads — the file read IS the verification.
- Claims about the behaviour of a SINGLE function — a focused test verifies, not a grep.
- Hypotheticals stated as such ("if all callers opted in, ..." is a question, not a claim).

**Mechanical enforcement:** when `discovery-validator.enabled: true` in Session Config, a `SubagentStop` hook scans the subagent's transcript tail for these claim patterns and records a violation event (plus a stderr WARN) whenever such a claim lacks an adjacent measurement transcript. The hook is log + warn only and never blocks the agent — it complements the rule rather than replacing the coordinator's REJECT obligation.

## PSA-007 — Subagent Git-Write Prohibition

*In-run axis. Distinct from PSA-003/PSA-004, which govern the COORDINATOR's own destructive-op and commit discipline; PSA-007 governs what a DISPATCHED SUBAGENT may touch of the shared VCS state.*

The git index and stash are **shared resources of the working copy**, not a private workspace scoped to each dispatched agent. When a wave dispatches multiple subagents in parallel, a subagent that runs a git-write command competes with its siblings for the SAME `.git/index` and stash stack — observed failure modes include `index.lock` collisions and stash operations that silently discard sibling work-in-progress.

**Dispatched subagents MUST NEVER run:**
- `git add` / `git commit` — index writes race with a sibling agent's concurrent index write, even when each agent only stages its own files.
- `git stash` (any form) — captures (and can drop) a sibling agent's uncommitted work; the sibling has no way to find or recover it.
- `git mv` / `git rm` — index-mutating, same race class as `git add`.
- `git push` — no subagent has the authority to publish; also destructive at the remote-history layer.
- `git reset` / `git checkout -- <file>` — destructive to sibling work AND an index-write race; banned from subagents unconditionally, not only "when parallel work is suspected".

**The only write channel a subagent has is editing files inside its own declared file scope.** All VCS operations — staging, committing, pushing — belong to the coordinator. This makes the PSA-004 guarantee structural rather than behavioural at the subagent layer: an agent that never touches the index cannot violate PSA-004 by construction.

**Anti-patterns:**
- A subagent running `git add <its own files>` "to be helpful" before reporting done — even scoped to its own files, it races the coordinator's staging pass and any sibling's concurrent index write.
- A subagent running `git stash` to "save progress" before switching tasks — report `blocked` and let the coordinator decide, never stash.
- A subagent running `git commit --no-verify` "just this once to unblock the wave".

## Anti-Patterns

- Seeing unfamiliar changes and assuming they are "leftover mess" to clean up — they are likely active work.
- Running `git reset --hard` to "start fresh" — this destroys all uncommitted work across all sessions.
- Fixing type errors or lint issues in files outside your scope — the other session will handle their own files.
- Using `git add .` in a shared workspace — you will commit another session's partial work.
- Reverting "broken" commits without asking — another session may have intentionally pushed incremental progress.
- Pausing at PSA-001 signals when your scope is unaffected — unnecessary interruptions slow the session.
- A subagent staging or committing its own work (PSA-007).
