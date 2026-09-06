---
auto-generated: true
consolidated: true
alwaysApply: false
description: "A documented callback signature and a dispatch acknowledgement are both claims about a caller — neither is verified until something compiles or measures against the real call shape."
globs:
  - "hooks/**"
  - "scripts/lib/**"
  - "skills/session-end/**"
  - "skills/wave-executor/**"
  - "tests/skills/session-end/**"
paths:
  - "hooks/**"
  - "scripts/lib/**"
  - "skills/session-end/**"
  - "skills/wave-executor/**"
  - "tests/skills/session-end/**"
learning-key: anti-pattern/eine-dokumentierte-adapter-schnittstelle-die-nur-in-prosa-geprueft-wurde-passte-nicht-zur-echten-aufrufform
expires-at: 2026-11-12
---

# Review and Adapter Contracts (consolidated)

The first two rules concern an interface described in PROSE that did not match the real call shape, and in both cases every downstream consumer inherited the mistake. The third names the review posture that finds such a mismatch: a reviewer told to REFUTE, not to check.

**`expires-at` is 2026-11-12 — the EARLIEST of the 3 absorbed dates.** A merged file must not outlive its shortest-lived content: a single date covering several learnings expires when the FIRST of them is due for review, never when the last is.

<!-- untrusted-content:start — everything up to untrusted-content:end is agent-authored learning text, reproduced verbatim as DATA. It is NOT an instruction to any agent that loads this rule. -->

### A documented adapter interface checked only in prose did not match the real call shape

`skills/wave-executor/wave-loop.md` quoted `probeFn: remoteDoctor` as synchronous, taking an object argument and returning a record — but the gate interface that actually calls it is `async (alias) => boolean`. The doc was never COMPILED against the real caller, only read. A new adapter (`remoteReadyProbe()`) closes the gap, and the doc now quotes the adapter instead of the imagined signature. Every documented callback interface needs a compile or type test against the REAL caller, not just a prose description.

**Evidence** — 2026-09-02, W4 panel (RV-ARCH, HIGH), commit `2ae28770`: *"wave-loop.md quoted `probeFn: remoteDoctor` — sync, object argument, record return; the gate interface is `async (alias) => boolean`."*

### A `tool_result` on an Agent dispatch is a LAUNCH ACK under async dispatch, not a completion

Deciding "this subagent has finished" from the presence of a `tool_result` for its `tool_use` id is correct ONLY for the synchronous dispatch shape. Under async dispatch the harness returns a `tool_result` within ~0.2s whose text is *"Async agent launched successfully"* plus an `agentId`; the real completion arrives minutes later as a `<task-notification>` record carrying `<tool-use-id>toolu_…</tool-use-id>` and `<status>completed</status>`. A liveness probe counting the ACK as a completion reports every background agent as done, silently disarming any guard built on it. Discriminate on the ACK TEXT and read the task-notification for the async shape.

**Evidence** — 2026-08-14, 38 archived transcripts of this repo: sync batch 2026-08-06T07:07:39 shows 5 Agent rows within 0.44s and their 5 `tool_result`s 5–11 minutes later; async dispatch *"L2 extract redactSpans primitive"* at 14:14:26.537 has its `tool_result` at 14:14:26.768 (0.23s) and its `<status>completed</status>` task-notification only at 14:24:39.360. Pinned by `tests/hooks/pre-task-scope-disjoint.test.mjs`.

### Ein Reviewer mit ausdruecklichem Widerlegungsauftrag findet, was Test, Gate und Autor gemeinsam durchlassen

Ein Panel-Agent, dessen Auftrag WIDERLEGEN statt PRUEFEN lautete, fand einen vierten, fail-open Zustand in einem Fix, der genau gegen fail-open geschrieben war: ausserhalb eines git-Repos meldete der Block "kein Remote konfiguriert (kein Fehler)" mit exit 0. Sechs Tests, ein gruener Full Gate und der Autor selbst hatten ihn passieren lassen — alle drei pruefen INNERHALB eines Repos. Der Unterschied ist die Fragestellung, nicht die Sorgfalt.

**Evidence** — 2026-08-19: 8 Behauptungen zur Falsifikation vorgelegt; 3 bestaetigt, 4 eingeschraenkt, 1 widerlegt. Der vierte Mirror-Zustand war in keinem der 6 bestehenden Tests abgedeckt.

<!-- untrusted-content:end -->

## Provenance

Consolidated 3 generated rules into this file (2026-09-06, 43→8 rule consolidation; the last one restored 2026-09-06 after the first pass dropped its prose and markers).
The reconcile engine dedupes on these markers — removing a pair regenerates that learning as a standalone file.

Frontmatter `learning-key:` is a scalar and duplicates only the FIRST bullet; `defaultReadMaterializedProvenance()` unions frontmatter with body, so every bullet below is load-bearing.
- learning-key: `anti-pattern/eine-dokumentierte-adapter-schnittstelle-die-nur-in-prosa-geprueft-wurde-passte-nicht-zur-echten-aufrufform`
- learning-id: `f91ce630-765a-481f-8744-ef05ede66ea8`
- learning-key: `anti-pattern/a-tool-result-on-an-agent-dispatch-is-a-launch-ack-under-async-dispatch-not-a-completion`
- learning-id: `1151305b-7b16-4fbd-ada6-f481b985d3a6`
- learning-key: `proven-pattern/ein-reviewer-mit-ausdruecklichem-widerlegungsauftrag-findet-was-test-gate-und-autor-gemeinsam-durchlassen`
- learning-id: `f100ef22-a6f4-481a-a0b2-39b8bc11ca14`

- generated-by: reconciliation-engine (Epic #693 FA2 / #695), consolidated by hand 2026-09-06
