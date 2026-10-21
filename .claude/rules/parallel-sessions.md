---
tier: always
review-date: 2026-10-23
---

# Parallel Session Awareness (Always-on)

## PSA Scope Axes — Operator-Session vs In-Run
Independent operator sessions share a working copy, index, filesystem and STATE.md. Messaging is information, never isolation/write permission; delivery unguaranteed (CSM-004). Agent Teams is per-process/in-run, provides no automatic isolation, and cannot replace operator-session locks, disjoint wave file scopes or STATE.md serialization. PSA-005 spans both axes; PSA-006 is orthogonal.

## Decision Tree — What To Do When You Detect Parallel Signals
No signal: continue. Otherwise first confirm against the wave plan/coordinator whether it belongs to a sibling in THIS dispatch round, inside that sibling's declared scope and outside yours: note and continue, without pausing. A file in both scopes is a real collision, never this exception.
Exclusively foreign scope: if a live peer is demonstrably reachable, inform it per CSM-001, then keep working only in your scope; do not wait or interpret silence as consent/refusal. Otherwise note and continue (PSA-001). Coordinators discover peers; subagents only reach coordinator, never guess sideways. Any overlap with your scope: PSA-002; peer messaging is only additional, never a replacement.
Before file-disjoint in-place work with a reachable peer, request Peer-Scope-Union: send complete paths, adopt peer resource rules, probe with one real edit, announce before committing. Protocol: `skills/_shared/parallel-aware-auq.md` § Peer-Scope-Union.

## PSA-001 — Aware (Passive Detection, No Pause)
Recognize unexpected modified/staged/untracked files, unfamiliar commits, spontaneous build/type/test errors in untouched code, and content changing between reads. In isolation:none, disambiguate same-round sibling ownership first. Note the signal; when no owned scope overlaps, do NOT pause, ask the user or fix foreign changes. Continue your task within scope.

## PSA-002 — Pause (Active Conflict, Stop and Ask)
Unexpected edits in owned files, unfamiliar staged changes in `git diff --cached`, a required file locked by another session, or external changes blocking your task trigger a stop. Apply the sibling exception only with confirmed exclusive ownership. Stop immediately: do not overwrite, merge, revert/reset or work around conflicts. Ask the user via AskUserQuestion per `ask-via-tool.md`, then wait before touching affected files. Never fix outside scope; ask when external changes block you. Track your own footprint; commits contain only your changes.

## PSA-003 — Destructive Action Safeguards (Never Destroy What You Didn't Create)
Explicit user confirmation is required even normally, and approval is mandatory with suspected parallel work, for: `git reset` (any form), `git checkout -- <file>`, `git clean -f`, `git stash`, rm/delete of files you did not create, reverting commits you did not make, and `git push --force`. First ask yourself whether you created the file/commit/change; otherwise it is not yours to touch.

## PSA-004 — Commit Discipline (Isolate Your Changes)
Stage individually (`git add <file>`), never `git add .`/`git add -A`. Review `git diff --cached` before committing: every change must be yours. Unstage unfamiliar changes and ask the user. Never amend another author's commit.

## PSA-005 — Mechanical STATE.md Write Protection (#518)
With `state-md-lock.enabled: true` (default), EVERY STATE.md writer in skills or hooks uses `withStateMdLock(repoRoot, fn)` from `scripts/lib/session-lock.mjs`; readers (`parseStateMd`, `readMissionStatus`) do not lock. It serializes frontmatter/writes across both axes, preventing concurrent overwrites/lost updates. The orthogonal session lock means the working copy is occupied, NOT STATE.md currently being written. SessionStart `bootstrapLock()` acquires it mechanically; schema v2 uses heartbeat liveness (`last_heartbeat`), UUID `session_id` and Claude Code `semantic_session_id`. Full schema: `skills/_shared/state-ownership.md` § Session Lock Schema.
STATE lock: atomic tmp+rename, PID stale detection, default timeout 10s (`state-md-lock.timeout-ms`); dead PID permits atomic override with stderr WARN; genuine contention returns `{ ok: false, reason: 'timeout' }`, caller retries or aborts. See "gsd Pattern Adoption Quick-Wins" (#518; archived in private Meta-Vault) § Pattern 1 and Issue #518.

## PSA-006 — Discovery Grep-Verification (#555 FL-2)
Any agent asserting counts, percentages, distributions, adoption or zero references of code OR repo state (including W1 Discovery and W3 unaffected-callsite claims) MUST EXECUTE an appropriate measurement (`rg`/`grep`/`find`, `git`/`wc`/`jq`/`ls`/`node`). Quote exact command, tool file scope, result/count or zero matches, and ISO measurement time or SHA/HEAD. Percentages require numerator AND denominator from output. Reused facts describe the past unless dated. Inference, partial sampling and LLM recall are forbidden evidence. Coordinators MUST REJECT missing quoted transcripts and request re-verification even for plausible claims (RCR-003).
Exceptions: single-file Read results verify inline reads; single-function behavior needs a focused test; explicitly hypothetical claims are not facts. DONE/gate-green reports also need a RUN RECEIPT (pass/fail count, typecheck file count or exit code) or adjacent measurement command. Opt-in discovery-validator (default false) only logs/warns; measurement time is advisory in that hook, not in this rule. It never replaces coordinator REJECT.

## PSA-007 — Subagent Git-Write Prohibition (#724)
The shared index/stash belongs to the coordinator. Dispatched subagents MUST NEVER run `git add`, `git commit`, `git stash` (ANY form), `git mv`, `git rm`, `git push`, `git reset`, or `git checkout -- <file>`, even on own files; only write channel: Edit/Write in declared scope. Baseline: `git show HEAD:<file>`. If blocked, report; never stash or commit to unblock. Exception (`code-implementer` only): a prompt line `WORKTREE-MODE: <abs path> <branch>` matching toplevel and branch permits only `git add <file>`/`git commit` there; never the coordinator's worktree, one agent per worktree, never in waves. Detail: `docs/agent-authoring.md` § Git-Write Ban Requirement.

Mechanics: `parallel-session-mechanics.md`; all obligations above are universal.

## See Also
development.md · security.md · testing.md · mvp-scope.md · cli-design.md · receiving-review.md · cross-session-messaging.md (CSM-001..005 — the send decision the Decision Tree routes to) · `../../skills/_shared/state-ownership.md` (concurrency) · ADR-0010 § Native-Overlap Refresh (Agent Teams = Stay; PSA re-scoped) · "Native-Overlap Verdicts" research (#665; archived in the private Meta-Vault) § PSA re-scope
