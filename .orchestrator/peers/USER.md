---
id: owner-card
type: peer-card
target: user
created: "2026-05-25T17:34:29.831Z"
updated: "2026-09-22T13:55:37.786Z"
source_sessions: ["evolve-2026-05-25T1638", "evolve-2026-05-30-0913", "evolve-2026-08-05-deep-1-reviewed-no-changes", "main-2026-09-13-session-45-readme-reduction", "main-2026-09-22-housekeeping-0834", "main-2026-09-21-session-4", "main-2026-09-20-session-3", "main-2026-09-19-session-18", "main-2026-09-19-session-9", "main-2026-09-19-session-1", "main-2026-09-18-session-10", "main-2026-09-18-session-1", "main-2026-09-17-session-23", "main-2026-09-16-session-6", "main-2026-09-13-session-42", "c33eb804-46cd-47b8-9392-b98c0a5b2598", "main-2026-09-12-session-26", "5de6560c-ae9c-4c4a-8212-f102c4576ff0", "main-2026-09-13-session-9", "main-2026-09-07-session-11", "main-2026-09-11-session-25"]
---

<!-- BEGIN MANAGED: session-preferences -->
## Session preferences

- Prefers work organized in waves with parallel subagents. Use the current request and resolved configuration to choose the shape; historical 5-wave sessions and their agent counts are examples, not a fixed dispatch requirement. An explicit request for housekeeping in waves overrides the single-wave Express default.
- Preserve the user's selected model, reasoning effort, and service tier unless the user asks for a change. Historical role names or model choices in session records do not authorize a switch.
- An instruction to execute the approved scope in full and end to end includes verification and session close. Continue authorized work without asking for the same approval again.
- Aim to finish the agreed scope. Report verified completion separately from follow-ups or unresolved acceptance criteria; do not turn missing evidence into a completed item to meet a completion-rate target.
- Accepts follow-up issues for findings outside the agreed scope. Classify findings by their effect and owner boundary before deciding whether they block; severity alone does not authorize an unrelated repair.
- When a reviewer finds a blocker, fold its verified repair into the next suitable wave where dependencies allow, then re-verify before landing.
<!-- END MANAGED: session-preferences -->

<!-- BEGIN MANAGED: wave-structure-preferences -->
## Wave structure preferences

- Agents in every parallel wave must have file-disjoint scopes, regardless of worktree isolation. Materialize each agent's scope and the aggregate including coordinator edits before dispatch.
- Use the current resource gate and the best host signal available. On macOS, memory pressure takes precedence over raw free RAM; a historical free-RAM threshold does not justify dropping isolation or changing the plan.
- Keep shared CLAUDE.md edits with the coordinator in finalization; concurrent agents may return proposed additions.
- Classify findings against the agreed scope before folding them into a later wave. A repair requiring a new contract or owner boundary must be routed explicitly rather than absorbed because its severity is MEDIUM.
<!-- END MANAGED: wave-structure-preferences -->

<!-- BEGIN MANAGED: discovery-and-scope -->
## Discovery and scope

- Wave 1 Discovery findings that warrant scope adjustment must surface via AUQ before Wave 2 dispatch — never silently absorbed.
- When Discovery reveals a task was already shipped, scope is reduced immediately rather than re-implemented.
- For empty-backlog sessions, dispatching 6 parallel Explore probes (architecture, test-coverage, doc-drift, hooks-config, tech-debt, perf-health) reliably surfaces enough candidates for a full W2 parallel batch.
- W1 agents must grep-verify all file-location claims and API-shape assumptions from the issue body before W2 scope is finalized. Quote the exact grep pattern, file scope, and result count in the report. This catches mismatches (CLI-only vs importable, file renames, missing exports, SUT mis-attribution) before W2 dispatch.
<!-- END MANAGED: discovery-and-scope -->

<!-- BEGIN MANAGED: quality-and-verification -->
## Quality and verification

- CI status at session-start is authoritative; local `npm test` green does not substitute for CI green.
- Quality-Lite after Impl-Core must include relevant tests when the production fix touches files with adjacent tests.
- Run the Full Gate before commit. A passing gate establishes its measured checks; it does not replace an independent review of the actual session diff.
- Brief reviewers to try to refute the implementation and the coordinator's premises. Recent sessions repeatedly found HIGH defects and same-session regressions behind a green gate.
- Choose review depth from the changed behavior and risk. A count of new tests, or a known-good base, is no reason to skip review; documentation still needs its claims checked against the implementation it describes.
<!-- END MANAGED: quality-and-verification -->

<!-- BEGIN MANAGED: resource-management -->
## Resource management

- Use the current resource gate rather than a remembered tier table. Idle processes, cumulative swap, and a transient one-minute CPU spike are not sufficient evidence for reducing a wave.
- Prefer the OS memory-pressure verdict, then available RAM, then raw free RAM when better signals are absent. Report the signal that actually determined the decision.
- Coordinator-direct execution is viable when the gate sets cap=0. Preserve the user's selected model, reasoning effort, and service tier while adapting concurrency.
<!-- END MANAGED: resource-management --><!-- BEGIN MANAGED: crashed-session-recovery -->
## Crashed session recovery

- When resuming a crashed session, grep-verify the STATE.md mission premise against the issue tracker + PRDs + actual code in the repo. A crashed STATE.md can encode hallucinated work (e.g., referencing closed/unrelated issues). Verify before continuing.
- The crashed session's `.claude/wave-scope.json` (if present) is the reliable artifact showing planned file scope. Diff `.allowedPaths` against `git status` (modified+untracked) to separate completed work from the crash gap.
- When resuming, run the existing test suite against the crashed work to verify it is sound before planning next steps.
<!-- END MANAGED: crashed-session-recovery --><!-- BEGIN MANAGED: public-surfaces -->
## Public surfaces and tone

- Everything with outward effect follows the `eli5` register: plain words, no analogies, no noun the system does not contain. Simplifying removes words, never facts — anything greppable (a path, a number, an error code, an identifier) stays. Source: `skills/eli5/SKILL.md`, applied to README, plugin manifests and repo metadata on 2026-09-13.
- When in doubt, point at session-orchestrator.com rather than explaining at length in the repo. The landing page carries the short version; the site carries the long one.
- Prefers visual explanation that carries information over decoration. On 2026-09-13 an animated illustration was replaced by a flow diagram of the actual command sequence; the criterion was "understandable at a glance", not "looks nice".
- Judges landing-page quality against comparable state-of-the-art repositories rather than in isolation, and expects the comparison measured (line/word/section counts), not asserted.
- Repository metadata is a public surface too: topics, the About description, and the package description on npm and in the plugin manifests are held to the same plainness standard as the README, and kept consistent with each other.
<!-- END MANAGED: public-surfaces -->
<!-- BEGIN MANAGED: commit-discipline -->
## Commit discipline and VCS

- When referencing an issue in a commit that must stay open, use `refs #N` or `part of #N` in the subject line. NEVER use close-keywords (`close`, `closes`, `fixes`, `resolves`) anywhere in the commit message — GitLab's issue-closing matcher treats these keywords in the body as permission to auto-close, regardless of surrounding negation (e.g., "does NOT fully close #N" still triggers auto-close). For issues requiring documented rationale to stay open, omit close-keywords entirely.
<!-- END MANAGED: commit-discipline -->