# Parallel Session Awareness (Always-on)

Multiple Claude Code sessions may be active in the same working directory simultaneously. Another agent may be editing files, creating commits, or running builds right now. Treat the repo as a shared workspace, not a private sandbox.

## Decision Tree — What To Do When You Detect Parallel Signals

```
Did I detect any parallel-session signal?
│
├─ No  →  Continue normally.
│
└─ Yes →  Does the signal touch files/scope I own in this task?
          │
          ├─ No  →  PSA-001 (Aware): note the signal, continue working.
          │          Do NOT pause. Do NOT "fix" the foreign change.
          │
          └─ Yes →  PSA-002 (Pause): stop current action, ask the user
                    via AskUserQuestion before proceeding.
```

**Scope overlap examples (triggers PSA-002):**
- A file you are about to edit is already modified by someone else.
- Staged changes in `git diff --cached` include files you did not touch.
- A build error appears in a file you just edited — but the error is in a line you didn't change.

**No-overlap examples (stay at PSA-001):**
- Unfamiliar commits in `git log` for modules you are not working on.
- New untracked files in directories outside your file scope.
- A test failure in a file not in your task's file-scope list.

---

## PSA-001 — Aware (Passive Detection, No Pause)

Detect and note parallel-session signals without interrupting your work. Continue normally when the signal does not overlap your owned files.

**Signals to recognise:**
- **Unexpected git status changes:** Files modified or staged that are not part of your current task likely belong to another session.
- **Unfamiliar commits:** New entries in `git log` that you did not create mean another agent (or the user manually) committed work.
- **Spontaneous errors:** Build failures, type errors, or test failures in code you did not touch may be in-progress work from another session — not pre-existing bugs.
- **Files changed between reads:** If a file's content differs from what you read moments ago, another session likely edited it.
- **New untracked files:** Files appearing in `git status` that you did not create belong to someone else's work.

**PSA-001 behaviour:**
- Log the observation mentally (or in your response narrative).
- Do NOT pause, do NOT ask the user, do NOT "fix" foreign changes.
- Continue with your assigned task in your own file scope.

---

## PSA-002 — Pause (Active Conflict, Stop and Ask)

When a parallel-session signal **directly overlaps your owned scope**, stop the current action and ask the user before proceeding.

**Triggers (overlap = PSA-002):**
- A file in your task's file-scope list has unexpected modifications you did not make.
- `git diff --cached` includes staged changes you did not stage.
- A file you need to write or edit is locked in an in-progress state by another session.
- External changes block your task (e.g., a merge conflict in one of your files).

**PSA-002 behaviour:**
- Stop immediately — do not overwrite, merge, or work around the conflict.
- Ask the user: *"I notice changes I didn't make in [file(s)] that are in my task scope. Is another session active?"*
- Use the `AskUserQuestion` tool per the AUQ rules (see `ask-via-tool.md`).
- Wait for user guidance before touching the affected file(s).
- **Never "fix" code outside your task scope.** Errors in files you are not working on may be intentional intermediate states from another session.
- **If blocked by external changes, ask the user** rather than reverting, resetting, or working around them.
- **Track your own footprint.** Be aware of which files you have created or modified. Your commits should contain only your changes.

---

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

## PSA-005 — Mechanical STATE.md Write Protection (#518)

Pattern 1 of the gsd Adoption Quick-Win Bundle (Issue #518) complements the PSA-003/PSA-004 behavioural rules with mechanical enforcement. When `state-md-lock.enabled: true` (default since v3.6.0) is set in Session Config, `withStateMdLock(repoRoot, fn)` from `scripts/lib/session-lock.mjs` protects every STATE.md write via an `.orchestrator/state.lock` lockfile using atomic tmp-file + rename acquisition with PID-liveness stale-detection.

**What this mechanically enforces:**
- **PSA-003 — Destructive Action Safeguards:** a concurrent writer cannot overwrite STATE.md while another writer holds the lock. The race condition is structurally impossible — not merely discouraged.
- **PSA-004 — Commit Discipline:** STATE.md updates are serialised; no frontmatter update from one `setMissionStatus()` call can be silently lost between two concurrent callers.

**Bypass mechanics:** Lock timeout default 10s (`state-md-lock.timeout-ms`). On stale lock (PID no longer alive) → atomic override + WARN on stderr. On genuine contention timeout → caller receives `{ ok: false, reason: 'timeout' }` and must decide whether to retry or abort.

**When to use:**
- All STATE.md writers in skill bodies (session-start Phase 1.5/1b, wave-executor inter-wave checkpoints, session-end Phase 3.7)
- Hooks that mutate STATE.md (rare — most hooks are read-only)

**When NOT to use:**
- STATE.md readers (`parseStateMd`, `readMissionStatus`) — locking readers serialises them unnecessarily with no safety benefit
- Other lock domains: the session lock (`acquire()` in `session-lock.mjs`) is orthogonal — session lock means "this repo working copy is occupied by an active session"; state lock means "STATE.md is being written right now"

See `docs/prd/2026-05-22-gsd-pattern-adoption-quickwins.md` § Pattern 1 and Issue #518.

**Epic #583 mechanical extension.** Since Epic #583, `session.lock` acquisition is also wired mechanically via `hooks/_lib/lock-bootstrap.mjs` (`bootstrapLock()`) invoked from `on-session-start.mjs` on every `SessionStart`. This closes the complementary gap in session-lock wiring: previously, `session.lock` was only written when the coordinator-LLM executed Phase 1.2 prose — a Disziplin-statt-Mechanik risk identical to the STATE.md write-race. Lock schema v2 also replaces PID-liveness with heartbeat-based liveness (`last_heartbeat` field), and surfaces `semantic_session_id` alongside the UUID `session_id` on Claude Code. See `skills/_shared/state-ownership.md § Session Lock Schema` for the full v2 field contract.

## PSA-006 — Discovery Grep-Verification (#555 FL-2)

Discovery agents and W1 explorers MUST verify any distributional claim — "100% of callers opt-in", "N of M sites use pattern X", "no remaining references to Y", "all instances replaced", etc. — with an EXECUTED `grep` or `rg` invocation. The Discovery output MUST quote:

1. The exact pattern executed (e.g., `grep -rn "pathMatchesPattern" hooks/ scripts/ tests/`)
2. The file scope passed to the tool
3. The resulting count or zero-match assertion

Untestable adoption claims based on inference, partial sampling, or LLM recall are **forbidden** — they previously triggered a mid-session STATE.md correction (deep-1647 W1-D3 → W3-P2 mismatch: claimed "4 of 4 callers opt-in" to `canonicalizeRoot`, actual state was "10 default + 4 opt-in", surfaced only when a W3 polish agent grep-verified `pathMatchesPattern` callers).

Coordinators reviewing Discovery output MUST REJECT claims that lack a quoted grep transcript and ask the Discovery agent to re-verify. Per `receiving-review.md` § RCR-003 skeptical-posture rule, this applies even when the claim is plausible — verification cost is cheap, mid-session correction cost is expensive.

**When PSA-006 applies:**
- W1 Discovery scope-mapping claims ("all callers do X", "no test exercises Y", "every consumer imports Z").
- W3 Impl-Polish "this caller is unaffected" claims (the W3-P2 deep-1647 incident class).
- Any agent that asserts a count, percentage, or distribution of code locations.

**When PSA-006 does NOT apply:**
- Inline single-file reads — the `Read` tool result IS the verification.
- Claims about behaviour of a SINGLE function — a focused test verifies, not a grep.
- Hypotheticals stated as such ("if all callers opted in, ..." is a question, not a claim).

**PSA-006 anti-patterns:**
- "All 4 callers already use pattern X" — without a quoted grep transcript and the file scope grepped.
- "There are no remaining references to the old API" — without `grep -rn` evidence pinned to the current SHA.
- "100% adoption" — a percentage is a distributional claim. Quote the numerator AND denominator from grep output.

**Mechanical enforcement (#567).** When `discovery-validator.enabled: true` in Session Config (default `false`), the `SubagentStop` hook `hooks/post-subagent-discovery-validator.mjs` scans the subagent's transcript tail for the distributional-claim patterns above and records a `discovery_validator_violation` event in `.orchestrator/metrics/events.jsonl` (plus a stderr WARN) whenever such a claim lacks an adjacent fenced grep/rg/find transcript. v1 is log + warn only and never blocks the agent — it complements the behavioural rule rather than replacing the coordinator's REJECT obligation above.

## Anti-Patterns
- Seeing unfamiliar changes and assuming they are "leftover mess" to clean up — they are likely active work.
- Running `git reset --hard` to "start fresh" — this destroys all uncommitted work across all sessions.
- Fixing type errors or lint issues in files outside your scope — the other session will handle their own files.
- Using `git add .` in a shared workspace — you will commit another session's partial work.
- Reverting "broken" commits without asking — another session may have intentionally pushed incremental progress.
- Pausing at PSA-001 signals when your scope is unaffected — unnecessary interruptions slow the session.

## See Also
development.md · security.md · security-web.md · security-compliance.md · testing.md · test-quality.md · frontend.md · backend.md · backend-data.md · infrastructure.md · swift.md · mvp-scope.md · cli-design.md · ai-agent.md · receiving-review.md · `../../skills/_shared/state-ownership.md` (concurrency)
