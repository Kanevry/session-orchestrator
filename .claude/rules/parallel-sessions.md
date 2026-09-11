---
tier: always
review-date: 2026-10-23
---

# Parallel Session Awareness (Always-on)

Multiple Claude Code sessions may be active in the same working directory simultaneously. Another agent may be editing files, creating commits, or running builds right now. Treat the repo as a shared workspace, not a private sandbox.

## PSA Scope Axes — Operator-Session vs In-Run

PSA rules span two distinct axes. Naming them keeps the durable moat clear where native
multi-agent primitives (the experimental `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, and now
native cross-session messaging) overlap this surface.

- **Operator-session axis (the durable moat):** independent parallel operator /
  Claude sessions in the **same working copy**. Guarded by PSA-001..004 plus the
  per-repo session lock (`scripts/lib/session-lock.mjs` `acquire()` /
  `session.lock`, heartbeat-liveness schema v2). **Agent Teams structurally
  cannot enter it** — Teams is per-process / in-run only ("one team per
  session"), NOT per-repo, so its graduation to native affects **only the in-run
  multi-agent coordination slice**. Native cross-session messaging *does* reach
  across this axis: two independent sessions in the same working copy exchanged
  full round-trips (measured 2026-08-16). Hence the axis is defined by the
  working copy, not by reachability.
- **In-run axis:** multiple agents coordinated inside a single session/run. Our own
  machinery stays necessary because Agent Teams provides **no automatic isolation**:
  file-scope deconfliction (`skills/session-plan/SKILL.md` — "verify that NO two agents
  in the same wave modify the same file") and `withStateMdLock` STATE.md serialization
  do work Teams does not.

**Why the split survives native messaging.** The moat was never "peer sessions cannot
talk to each other" — that half is measurably false. It is that they share one working
copy: one git index, one filesystem, one STATE.md, and a message arbitrates none of them.
What crosses is *information*, never isolation — telling a peer what you found changes
what it knows, not what it may write, and delivery is never guaranteed (CSM-004). So
messaging spans both axes and dissolves neither, which is why the Decision Tree routes a
reachable-peer signal to *inform and keep working* and still routes an overlap with my
own scope to PSA-002.

PSA-005 spans **both** axes; only its session-lock half is purely
operator-scoped. PSA-006 is **orthogonal** to both (Discovery grep-discipline).
See ADR-0010 § Native-Overlap Refresh (Agent Teams = Adapter; PSA re-scoped).

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
          ├─ Yes →  NOT a PSA-002 case. Consult the wave plan / coordinator
          │          knowledge to confirm the sibling's file-scope ownership,
          │          then continue working — note it PSA-001-style, do not
          │          pause. (See PSA-007 for the in-run axis git-write rule.)
          │
          └─ No  →  Does the signal touch files/scope I own in this task?
                    │
                    ├─ No  →  The finding is EXCLUSIVELY in foreign scope. Does
                    │         that scope belong to a REACHABLE peer session — a
                    │         live session I can name and address right now (see
                    │         CSM-001 in cross-session-messaging.md)?
                    │         │
                    │         ├─ Yes →  Inform the peer, then keep working in MY
                    │         │          scope. Do NOT edit in their scope, do
                    │         │          NOT pause. Sending is a report, not a
                    │         │          request: I neither wait for a reply nor
                    │         │          read its absence as agreement (CSM-004).
                    │         │          Behaviour otherwise stays PSA-001.
                    │         │
                    │         └─ No  →  PSA-001 (Aware): note the signal, continue
                    │                    working. Do NOT pause. Do NOT "fix" the
                    │                    foreign change.
                    │
                    └─ Yes →  PSA-002 (Pause): stop current action, ask the user
                              via AskUserQuestion before proceeding. Reachability
                              does NOT downgrade this branch — the conflict is in
                              MY OWN scope, so messaging the peer is at most an
                              ADDITION to asking the user, never a replacement
                              for it, and peer silence is neither refusal nor
                              consent (CSM-004). This branch also catches a file
                              assigned to BOTH my scope AND a sibling's scope per
                              the wave plan (a wave-plan deconfliction bug) —
                              that overlap is a genuine in-run collision, never a
                              benign sibling signal, so neither the sibling branch
                              nor the peer-inform branch above may mask it.
```

**Reachability is a property you check, never one you assume** — and it is asymmetric by role: a coordinator can enumerate live peer sessions and address one by name; a dispatched subagent can send *upward* to its own coordinator but cannot discover sideways at all. For a subagent the only reachable address is the coordinator; every other peer is "not reachable" and the branch falls through to plain PSA-001 rather than to a guess. CSM-001 owns the send decision; the tree only routes to it.

Where the branch hangs keeps it honest: BELOW the sibling check, so an in-run sibling signal still resolves as a sibling signal, and on the leg where the signal touches nothing I own, so it can never intercept a PSA-002 case. A finding partly in my own scope is not "exclusively foreign" and does not enter this branch at all.

**Peer-inform examples (message the peer, stay at PSA-001):**
- A bug plainly visible entirely inside a file a live peer session owns — inform, do not patch it for them.
- A fact that invalidates a peer's premise (a shared config you just changed, a branch they are about to build on) — inform, then keep working.
- The inverse case: MY planned scope is file-disjoint from a reachable peer's and I am about to work in-place in the same checkout. Declaring beats discovering — request a **Peer-Scope-Union** (send the complete path list, adopt the peer's resource rules, probe with one real edit, announce before committing) so the peer carries my paths in its scope manifest. Working in-place without a manifest turns every one of my writes into a finding in the peer's guard. Protocol: `skills/_shared/parallel-aware-auq.md` § Peer-Scope-Union.

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

*Axis: operator-session safety — the durable moat Agent Teams structurally cannot enter (per-process / in-run only).*

Detect and note parallel-session signals without interrupting your work. Continue normally when the signal does not overlap your owned files.

**Signals to recognise:**
- **Unexpected git status changes:** files modified or staged outside your current task likely belong to another session.
- **Unfamiliar commits:** entries in `git log` you did not create mean another agent (or the user) committed work.
- **Spontaneous errors:** build failures, type errors or test failures in code you did not touch may be another session's in-progress work, not pre-existing bugs.
- **Files changed between reads:** content differing from what you read moments ago means another session edited it.
- **New untracked files:** files in `git status` you did not create are someone else's work.

**In-run caveat (isolation:none waves):** in a wave dispatched with `isolation: none`, unfamiliar modifications outside your own scope or unexpected untracked files may belong to a sibling wave-agent's declared file-scope in the SAME dispatch round — disambiguate against the wave plan before logging a generic parallel-session signal (see PSA-007).

**PSA-001 behaviour:**
- Log the observation mentally (or in your response narrative).
- Do NOT pause, do NOT ask the user, do NOT "fix" foreign changes.
- Continue with your assigned task in your own file scope.

---

## PSA-002 — Pause (Active Conflict, Stop and Ask)

*Axis: operator-session safety — the durable moat Agent Teams structurally cannot enter (per-process / in-run only).*

When a parallel-session signal **directly overlaps your owned scope**, stop the current action and ask the user before proceeding.

**Triggers (overlap = PSA-002):**
- A file in your task's file-scope list has unexpected modifications you did not make.
- `git diff --cached` includes staged changes you did not stage.
- A file you need to write or edit is locked in an in-progress state by another session.
- External changes block your task (e.g., a merge conflict in one of your files).

**In-run caveat (isolation:none waves):** before pausing, check whether the unexpected modification or untracked file belongs to a sibling wave-agent's declared file-scope in the wave plan (same dispatch round) — if so this is NOT a PSA-002 case; follow the Decision Tree's sibling-check branch instead (see PSA-007).

**PSA-002 behaviour:**
- Stop immediately — do not overwrite, merge, or work around the conflict.
- Ask the user: *"I notice changes I didn't make in [file(s)] that are in my task scope. Is another session active?"* — via the `AskUserQuestion` tool per the AUQ rules (`ask-via-tool.md`), then wait for guidance before touching the affected file(s).
- **Never "fix" code outside your task scope.** Errors in files you are not working on may be intentional intermediate states from another session.
- **If blocked by external changes, ask the user** rather than reverting, resetting, or working around them.
- **Track your own footprint.** Know which files you created or modified; your commits contain only your changes.

---

## PSA-003 — Destructive Action Safeguards (Never Destroy What You Didn't Create)

*Axis: operator-session safety — the durable moat Agent Teams structurally cannot enter (per-process / in-run only).*

These commands require explicit user confirmation even in normal operation; when parallel work is suspected they are **forbidden** without user approval:
- **`git reset` (any form)** — destroys staged or committed work that may belong to another session.
- **`git checkout -- <file>`** — discards uncommitted changes another session is actively building.
- **`git clean -f`** — deletes untracked files another session created.
- **`git stash`** — captures another session's changes into a stash they cannot find.
- **`rm` / delete of files you did not create** — may remove another session's work-in-progress.
- **`git revert` of commits you did not make** — undoes another session's completed work.
- **`git push --force`** — rewrites shared history (dangerous even without parallel sessions).

Before running any of the above, ask: "Did I create this file/commit/change? If not, it is not mine to touch."

## PSA-004 — Commit Discipline (Isolate Your Changes)

*Axis: operator-session safety — the durable moat Agent Teams structurally cannot enter (per-process / in-run only).*

- **Stage files individually** (`git add <file>`), never `git add .` / `git add -A` — those sweep in another session's work.
- **Review `git diff --cached` before committing**; every staged change must be yours.
- **If you see unfamiliar changes in the diff, unstage them** and ask the user.
- **Never amend a commit you did not create.**

## PSA-005 — Mechanical STATE.md Write Protection (#518)

Pattern 1 of the gsd Adoption Quick-Win Bundle (Issue #518) gives the PSA-003/PSA-004 behavioural rules mechanical enforcement. With `state-md-lock.enabled: true` (default since v3.6.0) in Session Config, `withStateMdLock(repoRoot, fn)` from `scripts/lib/session-lock.mjs` protects every STATE.md write via an `.orchestrator/state.lock` lockfile, atomic tmp-file + rename acquisition with PID-liveness stale-detection.

**What this mechanically enforces:**
- **PSA-003 — Destructive Action Safeguards:** a concurrent writer cannot overwrite STATE.md while another holds the lock. The race is structurally impossible, not merely discouraged.
- **PSA-004 — Commit Discipline:** STATE.md updates are serialised; no frontmatter update from one `setMissionStatus()` call is silently lost between two concurrent callers.

**Bypass mechanics:** lock timeout default 10s (`state-md-lock.timeout-ms`). Stale lock (PID no longer alive) → atomic override + WARN on stderr. Genuine contention timeout → caller receives `{ ok: false, reason: 'timeout' }` and decides retry or abort.

**When to use:**
- All STATE.md writers in skill bodies (session-start Phase 1.5/1b, wave-executor inter-wave checkpoints, session-end Phase 3.7)
- Hooks that mutate STATE.md (rare — most hooks are read-only)

**When NOT to use:**
- STATE.md readers (`parseStateMd`, `readMissionStatus`) — locking readers serialises them with no safety benefit
- Other lock domains: the session lock (`acquire()` in `session-lock.mjs`) is orthogonal — session lock means "this repo working copy is occupied by an active session"; state lock means "STATE.md is being written right now"

See "gsd Pattern Adoption Quick-Wins" (#518; archived in the private Meta-Vault) § Pattern 1 and Issue #518.

**Epic #583 mechanical extension.** Since Epic #583, `session.lock` acquisition is wired mechanically too: `hooks/_lib/lock-bootstrap.mjs` (`bootstrapLock()`) invoked from `on-session-start.mjs` on every `SessionStart`. Previously `session.lock` was written only when the coordinator-LLM executed Phase 1.2 prose — the same Disziplin-statt-Mechanik risk as the STATE.md write-race. Lock schema v2 also replaces PID-liveness with heartbeat-based liveness (`last_heartbeat`) and surfaces `semantic_session_id` alongside the UUID `session_id` on Claude Code. Full v2 field contract: `skills/_shared/state-ownership.md § Session Lock Schema`.

**Scope axis.** PSA-005 spans **both** axes (see § PSA Scope Axes). Its
**session-lock half** (`acquire()` / `session.lock`) is purely operator-scoped —
"this repo working copy is occupied by an active session". Its **STATE.md
write-lock half** (`withStateMdLock`) also protects **in-run** wave-executor
checkpoints (session-start, inter-wave, session-end); Agent Teams' native
graduation touches only the in-run half and provides no automatic STATE.md
serialization, so the lock stays necessary there too.

## PSA-006 — Discovery Grep-Verification (#555 FL-2)

*Axis: orthogonal — Discovery grep-verification discipline, unrelated to operator-session vs in-run isolation (and unaffected by Agent Teams).*

Discovery agents and W1 explorers MUST verify any distributional claim — "100% of callers opt-in", "N of M sites use pattern X", "no remaining references to Y", "all instances replaced" — **and any bare number describing repo state** ("14 commits since the ref", "92 learnings", "5 dirty files", "412 lines") with an EXECUTED measurement command: `grep`/`rg`/`find` for code locations, `git`/`wc`/`jq`/`ls`/`node` for repo state. The output MUST quote:

1. The exact command executed (e.g., `grep -rn "pathMatchesPattern" hooks/ scripts/ tests/`)
2. The file scope passed to the tool
3. The resulting count or zero-match assertion
4. WHEN it was measured — an ISO date, or the SHA / `HEAD` it was measured at. A fact re-used by a downstream wave hours later is a claim about the PAST unless it carries its measurement time (#908: Discovery counts briefed as current for 9 hours were already 5 commits and 52 learnings stale)

Untestable adoption claims from inference, partial sampling or LLM recall are **forbidden** — they triggered a mid-session STATE.md correction (deep-1647 W1-D3 → W3-P2 mismatch: claimed "4 of 4 callers opt-in" to `canonicalizeRoot`, actual state "10 default + 4 opt-in", surfaced only when a W3 polish agent grep-verified `pathMatchesPattern` callers).

Coordinators reviewing Discovery output MUST REJECT claims lacking a quoted grep transcript and ask the agent to re-verify. Per `receiving-review.md` § RCR-003 skeptical-posture rule this holds even when the claim is plausible — verification is cheap, mid-session correction is expensive.

**When PSA-006 applies:**
- W1 Discovery scope-mapping claims ("all callers do X", "no test exercises Y", "every consumer imports Z").
- W3 Impl-Polish "this caller is unaffected" claims (the W3-P2 deep-1647 incident class).
- Any agent asserting a count, percentage or distribution — of code locations OR repo state (commits, learnings, issues, branches, dirty files, line counts).

**When PSA-006 does NOT apply:**
- Inline single-file reads — the `Read` tool result IS the verification.
- Claims about behaviour of a SINGLE function — a focused test verifies, not a grep.
- Hypotheticals stated as such ("if all callers opted in, ..." is a question, not a claim).

**PSA-006 anti-patterns:**
- "All 4 callers already use pattern X" / "100% adoption" — without a quoted transcript and the file scope grepped. A percentage is a distributional claim: quote numerator AND denominator from the tool output.
- "There are no remaining references to the old API" — without `grep -rn` evidence pinned to the current SHA.
- "The repo has 14 commits since the ref" — a bare repo-state count re-briefed downstream without the `git`/`wc`/`jq` command that produced it and the time it ran.

**Mechanical enforcement (#567, #908).** With `discovery-validator.enabled: true` in Session Config (default `false`), the `SubagentStop` hook `hooks/post-subagent-discovery-validator.mjs` scans the subagent's transcript tail for the claim patterns above — six quantifier-triggered distributional patterns plus the #908 bare-cardinal repo-state fact — and records a `discovery_validator_violation` event in `.orchestrator/metrics/events.jsonl` (plus a stderr WARN) whenever such a claim lacks an adjacent measurement transcript (`grep`/`rg`/`find`/`git`/`wc`/`jq`/`ls`/`node`/`npm`, fenced or inline-quoted). Item 4 (measurement time) is ADVISORY there: an undated-but-verified claim is counted and surfaced in the warn text, never recorded as a violation. The hook is log + warn only and never blocks — it complements the behavioural rule, it does not replace the coordinator's REJECT obligation above.

## PSA-007 — Subagent Git-Write Prohibition (#724)

*Axis: in-run — multiple agents coordinated inside a single session/run (see § PSA Scope Axes). Distinct from PSA-003/PSA-004, which govern the COORDINATOR's own destructive-op and commit discipline; PSA-007 governs what a DISPATCHED SUBAGENT may touch of the shared VCS state.*

The git index and stash are **shared resources of the working copy**, not a private workspace per dispatched agent. When a wave dispatches subagents in parallel (via the `Agent` tool / wave-executor), a subagent running a git-write command competes with its siblings for the SAME `.git/index` and stash stack. Fleet evidence (2026-07, 2 repos, confidence ≥0.9) recorded concurrent subagent git-writes causing `index.lock` collisions and stash operations that silently discarded sibling work-in-progress.

**Subagents dispatched via the Agent tool / wave-executor MUST NEVER run:**
- `git add` / `git commit` — index writes race a sibling's concurrent index write, even when each agent stages only its own files.
- `git stash` (any form) — captures (and can drop) a sibling's uncommitted work, which the sibling cannot find or recover.
- `git mv` / `git rm` — index-mutating, same race class as `git add`.
- `git push` — no subagent has authority to publish; also destructive at the remote-history layer.
- `git reset` / `git checkout -- <file>` — destructive to sibling work (already covered by the destructive-ops guard) AND an index-write race; PSA-007 bans them from subagents unconditionally, not only "when parallel work is suspected."

**The only write channel a subagent has is `Edit`/`Write` on files inside its own declared file scope.** All VCS operations — staging, committing, pushing — belong to the coordinator. That makes the PSA-004 commit-discipline guarantee structural rather than behavioural at the subagent layer: an agent that never touches the index cannot violate PSA-004 by construction.

**Anti-patterns:**
- A code-implementer subagent running `git add <its own files>` "to be helpful" before reporting done — even scoped to its own files it races the coordinator's staging pass and any sibling's index write.
- A subagent running `git stash` to "save progress" before switching tasks — the coordinator does not mid-task-switch a live agent; report `blocked` and let the coordinator decide, never stash.
- A subagent running `git commit --no-verify` "just this once to unblock the wave" — commits are the coordinator's exclusive responsibility per every `agents/*.md` authoring convention (`docs/agent-authoring.md` § Authoring Convention carries the mandatory ban-line every repo-write agent definition must have).

## Anti-Patterns
- Treating unfamiliar changes as "leftover mess" to clean up — they are likely active work.
- `git reset --hard` to "start fresh" — destroys all uncommitted work across all sessions.
- Fixing type errors or lint issues outside your scope — the other session handles its own files.
- `git add .` in a shared workspace — you will commit another session's partial work.
- Reverting "broken" commits without asking — another session may have pushed incremental progress intentionally.
- Pausing at PSA-001 signals when your scope is unaffected — needless interruptions slow the session.

## See Also
development.md · security.md · testing.md · mvp-scope.md · cli-design.md · receiving-review.md · cross-session-messaging.md (CSM-001..005 — the send decision the Decision Tree routes to) · `../../skills/_shared/state-ownership.md` (concurrency) · ADR-0010 § Native-Overlap Refresh (Agent Teams = Adapter; PSA re-scoped) · "Native-Overlap Verdicts" research (#665; archived in the private Meta-Vault) § PSA re-scope
