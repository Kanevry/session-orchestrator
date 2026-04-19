# Parallel Session Awareness (Always-on)

Multiple Claude Code sessions may be active in the same working directory simultaneously. Another agent may be editing files, creating commits, or running builds right now. Treat the repo as a shared workspace, not a private sandbox.

## Recognizing Parallel Work (PSA-001: Detect Before Acting)
- **Unexpected git status changes:** Files modified or staged that are not part of your current task likely belong to another session.
- **Unfamiliar commits:** New entries in `git log` that you did not create mean another agent (or the user manually) committed work.
- **Spontaneous errors:** Build failures, type errors, or test failures in code you did not touch may be in-progress work from another session — not pre-existing bugs.
- **Files changed between reads:** If a file's content differs from what you read moments ago, another session likely edited it.
- **New untracked files:** Files appearing in `git status` that you did not create belong to someone else's work.

## Behavioral Guidance (PSA-002: Ask, Don't Assume)
- **When you detect signs of parallel work, stop and ask the user:** "I notice changes I didn't make (e.g., modified files in git status, new commits). Is another session active?"
- **Never "fix" code outside your task scope.** Errors in files you are not working on may be intentional intermediate states from another session.
- **Stay in your lane.** Only read, create, modify, and delete files directly relevant to your assigned task.
- **If blocked by external changes, ask the user** rather than reverting, resetting, or working around them.
- **Track your own footprint.** Be aware of which files you have created or modified. Your commits should contain only your changes.

## Destructive Action Safeguards (PSA-003: Never Destroy What You Didn't Create)
These commands require explicit user confirmation even in normal operation. When parallel work is suspected, they are **forbidden** without user approval:
- **`git reset` (any form)** — destroys staged or committed work that may belong to another session.
- **`git checkout -- <file>`** — discards uncommitted changes another session is actively building.
- **`git clean -f`** — deletes untracked files another session created.
- **`git stash`** — captures another session's changes into a stash they cannot find.
- **`rm` / delete of files you did not create** — may remove work-in-progress from another session.
- **`git revert` of commits you did not make** — undoes another session's completed work.
- **`git push --force`** — rewrites shared history (dangerous even without parallel sessions).

Before running any of the above, ask: "Did I create this file/commit/change? If not, it is not mine to touch."

## Commit Discipline (PSA-004: Isolate Your Changes)
- **Stage files individually** (`git add <file>`) rather than `git add .` or `git add -A`, which may sweep in another session's work.
- **Review `git diff --cached` before committing** to verify every staged change is yours.
- **If you see unfamiliar changes in the diff, unstage them** and ask the user.
- **Never amend a commit you did not create.**

## Anti-Patterns
- Seeing unfamiliar changes and assuming they are "leftover mess" to clean up — they are likely active work.
- Running `git reset --hard` to "start fresh" — this destroys all uncommitted work across all sessions.
- Fixing type errors or lint issues in files outside your scope — the other session will handle their own files.
- Using `git add .` in a shared workspace — you will commit another session's partial work.
- Reverting "broken" commits without asking — another session may have intentionally pushed incremental progress.
