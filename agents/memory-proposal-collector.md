---
name: memory-proposal-collector
description: Reference documentation (NOT a dispatchable agent) for the coordinator-direct AUQ rendering flow at session-end Phase 3.6.3. The coordinator collects proposals from `.orchestrator/metrics/proposals.jsonl` via `collectProposals()` and renders the multiSelect AUQ in batches of 4. Approved proposals flow to `learnings.jsonl` with `_provenance: agent-proposed@<wave-id>` via `sink.writeApproved()`. AUQ is a coordinator-only tool — this flow does NOT dispatch as a subagent. <example>Context: session-end Phase 3.6.3, proposals.jsonl contains 5 entries from W2/W3 agents. user "Close the session." assistant "I'll render the AUQ in 2 batches of 4 + 1, then route the user's choices through writeApproved + archiveRejected per agents/memory-proposal-collector.md." <commentary>The collector flow is coordinator-direct because AskUserQuestion is unavailable inside subagents per .claude/rules/ask-via-tool.md AUQ-004.</commentary></example>
model: inherit
color: cyan
tools: Read, Grep, Glob
sandbox-tier: read-only
---

# Memory Proposal Collector (Reference Documentation)

**NOT a dispatchable subagent.** This file documents the coordinator-direct AUQ rendering flow
that runs at session-end Phase 3.6.3. Do not attempt to dispatch `memory-proposal-collector` as
an agent — the coordinator will receive "agent type not found" and that is by design. See
[Why this is documentation, not an agent](#why-this-is-documentation-not-an-agent) for rationale.

---

## Overview

At session-end Phase 3.6.3 the coordinator presents pending memory proposals to the user for
approval or rejection. Proposals are short learning candidates queued by the
`memory-propose.mjs` CLI during the session (typically from hook invocations, auto-generated
by subagents that detected a repeatable pattern worth recording).

The flow runs **coordinator-direct**: the coordinator calls library functions, renders an
`AskUserQuestion` picker, and writes results — no subagent dispatch involved.

---

## Gate Conditions

This flow runs only when ALL of the following are true:

1. **`persistence: true`** is set in Session Config (CLAUDE.md `## Session Config` block).
2. **`memory.proposals.enabled: true`** is set in Session Config (default when the
   `pre-bash-memory-propose-audit` hook is active).
3. **`.orchestrator/metrics/proposals.jsonl`** exists and is non-empty (≥1 line).

If any condition fails, the coordinator emits a single info-line
(`[3.6.3] Memory proposals: skip — <reason>`) and continues to Phase 3.6.5.

---

## Coordinator Step-by-Step

### Step 1 — Load proposal queue

```js
import { collectProposals } from '../scripts/lib/memory-proposals/collector.mjs';
const { queue, stats, perWaveSummaries } = await collectProposals({ repoRoot });
```

> **Note:** `sessionId` is supplied by the coordinator at the call site (e.g., read from
> STATE.md frontmatter); it is NOT returned by `collectProposals`.

`collectProposals()` reads `.orchestrator/metrics/proposals.jsonl`, parses each line as a
`ProposalRecord`, and returns them in **FIFO order** (insertion order, not sorted by
confidence). This matches the D3 decision locked in Wave 1.

### Step 2 — Empty-queue short-circuit

```js
if (queue.length === 0) {
  log.info('[3.6.3] Memory proposals: queue empty — skip');
  return;
}
```

Silent skip. No user interaction.

### Step 3 — Determine batch layout

| Queue size | Batches | AUQ calls |
|---|---|---|
| 1 – 4 | 1 batch (all proposals) | 1 |
| 5 – 8 | 2 batches of ≤4 | 2 |
| 9 – 12 | 3 batches of ≤4 | 3 |
| N | `ceil(N / 4)` batches | `ceil(N / 4)` |

Batches are sequential, not parallel. The coordinator waits for the user's response to batch
N before presenting batch N+1.

### Step 4 — Render AUQ per batch

For each batch of up to 4 proposals, call `AskUserQuestion` with the template documented in
[AUQ Question Template](#auq-question-template) below.

### Step 5 — Collect and persist results

After all batches are resolved:

```js
import { promoteAndClear, archiveRejected }
  from '../scripts/lib/memory-proposals/sink.mjs';

// sessionId is read by the coordinator from STATE.md frontmatter (e.g. session_id field),
// NOT returned by collectProposals — see Step 1 note above.
const sessionId = parseStateMd(repoRoot).session_id;

const writeResult = await sink.promoteAndClear({ approved, sessionId, repoRoot });
await sink.archiveRejected({ rejected, repoRoot, reason: 'user-declined' });
```

`promoteAndClear()` composes `writeApproved()` + `clearProposalsJsonl()` behind a single
mechanical guard (#797/#828): it calls `writeApproved({ approved, repoRoot, sessionId })`
first, computes `expected` from `approved.length`, and clears `proposals.jsonl` — via
`clearProposalsJsonl()` internally — ONLY when `written === expected && errors.length === 0`.
There is no separate write-then-clear call sequence for the coordinator to reorder or forget
to gate; the guard is now IN-CODE. The coordinator's job is to inspect the returned
`{ written, expected, errors, cleared, summariesCleared, skippedReason }` and warn when
`cleared === false` (see [Clear the queue](#clear-the-queue) below). `promoteAndClear()`
throws a `TypeError` before ever calling `writeApproved()` when `sessionId` is missing/blank,
or when `approved` is omitted alongside an unrecognised key (arg-name-typo guard, mirroring
`writeApproved()`'s own #797 guard one layer up).

`clearProposalsJsonl()` — invoked internally by `promoteAndClear()` on the success path —
performs an **atomic clear** (write empty content to a tmp file, then rename over the target)
so a concurrent hook invocation cannot read a partially-cleared file. It ALSO removes every
`proposals-summary-<wave-id>.json` sidecar in the same metrics directory — those per-wave
summaries are what `collectProposals()` sums into `stats.queued` (see
`scripts/lib/memory-proposals/collector.mjs` `accumulateSummaryStats()`), so leaving them
behind after a JSONL-only clear caused a stale `queued > 0` count against a genuinely empty
proposals.jsonl on every subsequent session-end (issue #723 B3). `promoteAndClear()` never
throws on the write/clear path itself (only on the two argument guards above) — see
`sink.mjs` for the full contract.

---

## AUQ Question Template

The following is verbatim and copy-pasteable. The coordinator substitutes `{{N}}`, `{{M}}`,
and `{{options}}` at render time.

```
AskUserQuestion({
  questions: [{
    header: "Memory — Confirm Proposals (Batch {{N}} of {{M}})",
    question: "Select the learnings you want to store permanently. Unselected proposals will be archived as declined.",
    options: [
      // one entry per proposal in this batch — see label format below
      { label: "{{label}}", description: "{{description}}" },
      ...
    ],
    multiSelect: true
  }]
})
```

**When there is only one batch** (`M === 1`), omit the batch suffix:

```
header: "Memory — Confirm Proposals"
```

### Option label format

Locked by D3 (Wave 1 decision):

```
[type   ] | subject(40) | conf=X.XX
```

- `type` is left-padded/right-padded to a fixed 7-character field (e.g. `[pattern]`,
  `[process]`, `[insight]`).
- `subject` is truncated to 40 characters with `…` if longer.
- `conf` is the confidence value formatted to 2 decimal places (`0.75` → `conf=0.75`).

Example labels:

```
[pattern] | reducer always re-evaluates on unrelate… | conf=0.85
[process] | npm audit --prod before every deploy     | conf=0.92
[insight] | tsgo 3-5x faster than tsc for type check | conf=0.78
```

### Option description format

```
evidence: <60 chars
```

The `evidence` field from the `ProposalRecord`, truncated to 60 characters with `…` if
longer. Prefixed with the literal `evidence: ` label so the user can distinguish the
evidence snippet from the label above.

Example:

```
evidence: 3 consecutive sessions hit the same pattern in W2
```

---

## Result Handling

The `AskUserQuestion` multiSelect response returns an array of selected option labels. The
coordinator maps selections back to `ProposalRecord` objects by matching label strings.

### Approved proposals

Proposals whose label appears in the selection are passed to `sink.promoteAndClear()`, which
delegates the write half to `writeApproved()` internally:

1. Converts each `ProposalRecord` to a `LearningRecord` (strips proposal-specific fields,
   keeps `type`, `subject`, `insight`, `evidence`, `confidence`, `tags`).
2. Appends `_provenance: "agent-proposed@<wave-id>"` to each record (the `wave-id` comes from
   the `sessionId` supplied by the coordinator from STATE.md frontmatter — see Step 1 note).
3. Appends to `.orchestrator/metrics/learnings.jsonl` using the same atomic-append pattern
   used by the `evolve` skill.

### Rejected proposals

Proposals NOT selected are passed to `sink.archiveRejected()` with `reason: 'user-declined'`.
The sink appends each rejected record (with timestamp + reason) to
`.orchestrator/proposals.rejected.log`. This call is independent of `promoteAndClear()` — order
between the two does not matter.

### Clear the queue

`promoteAndClear()` clears `.orchestrator/metrics/proposals.jsonl` itself — via an internal
`clearProposalsJsonl()` call — but ONLY when the write half fully succeeded
(`written === expected && errors.length === 0`). On success this atomically truncates
`proposals.jsonl` to zero bytes, preventing the same proposals from appearing again at the
next session-end. On a partial write, the clear is SKIPPED entirely: `promoteAndClear()`
returns `cleared: false` with a `skippedReason` (`'write-errors'` or a
`'partial-write: <written>/<expected> written'` string), the queue is left intact, and the
coordinator surfaces a warning so the discrepancy carries over to the next session's
Phase 3.6.3 pass instead of silently losing the un-written proposals (#828).

---

## Why This Is Documentation, Not an Agent

### AUQ-004: Subagent constraint

`AskUserQuestion` is a coordinator-only tool. Per `.claude/rules/ask-via-tool.md` §AUQ-004:

> **Subagents.** `AskUserQuestion` is not available inside dispatched `Agent()` calls.
> Subagents must bubble the decision back to the coordinator, which then asks the user.
> Never paper over this by putting a prose question in a subagent.

The entire value of Phase 3.6.3 is presenting a structured picker to the user so they can
approve or decline proposals with a single keystroke. That picker is `AskUserQuestion`. Since
a dispatched subagent cannot call `AskUserQuestion`, the flow cannot run inside a subagent
without degrading to prose questions in agent output — which violates AUQ-001 and defeats
the purpose of the flow entirely.

The correct architecture is: the coordinator runs the flow inline, calling the library
modules (`collector.mjs`, `sink.mjs`) directly, and rendering the AUQ itself. There is no
intermediate agent dispatch.

### Why the file lives in `agents/`

Issue #501 mandates this file as part of the memory-proposal-collector component. Placing it
in `agents/` alongside the other behavioural specifications is the natural location for
anyone tracing the session-end flow — it documents what the coordinator does at Phase 3.6.3
in the same directory where all other coordinator-invoked agent patterns live. The file uses
`sandbox-tier: read-only` and `tools: Read, Grep, Glob` to unambiguously mark itself as
non-dispatchable. Any dispatch attempt using this name will fail at the harness's agent-type
resolver, which is the correct failure mode.

---

## Cross-References

| Resource | Purpose |
|---|---|
| Issue #501 | Original spec and acceptance criteria for this component |
| "Learning Memory Modernization" (F2.1) — moved to the vault for privacy (#462); canonical in-repo spec reference is tracking issue #501 | PRD section describing the AUQ approval flow |
| `skills/session-end/SKILL.md` Phase 3.6.3 | The session-end skill step that invokes this flow |
| `scripts/lib/memory-proposals/schema.mjs` | `ProposalRecord` and `LearningRecord` type definitions |
| `scripts/lib/memory-proposals/store.mjs` | Low-level JSONL read/write for proposals queue |
| `scripts/lib/memory-proposals/collector.mjs` | `collectProposals()` — loads and validates the queue |
| `scripts/lib/memory-proposals/sink.mjs` | `promoteAndClear()` (composes `writeApproved()` + `clearProposalsJsonl()` behind the write-before-clear guard, #797/#828), `archiveRejected()` |
| `agents/dialectic-deriver.md` | Similar coordinator-invoked pattern (compare: deriver dispatches as a subagent because it only reads files; this flow does not dispatch because it calls AUQ) |
| `.claude/rules/ask-via-tool.md` §AUQ-004 | Authoritative rule prohibiting AUQ inside subagents |
| `.claude/STATE.md` Wave History — D3 | Locked decisions: pagination=4, FIFO order, label format, decision tree |

---

## Design Decisions (Locked — D3, Wave 1)

These decisions are recorded in `.claude/STATE.md` Wave History line D3 and are not open
for revision within this session:

- **Batch size**: 4 proposals per AUQ call (not 3, not 5).
- **Decision tree**: 0→silent skip, 1-4→single multiSelect, 5+→sequential batches of 4.
- **Order**: FIFO (insertion order). Not sorted by confidence — simpler implementation and
  fairer to proposals generated early in the session.
- **Label format**: `[type   ] | subject(40) | conf=X.XX` — fixed-width type field,
  40-char subject truncation, 2-decimal confidence.
- **Rejected log**: `.orchestrator/proposals.rejected.log` (append-only flat log, not JSONL).
- **Provenance tag**: `agent-proposed@<wave-id>` appended by sink at write time.

Any change to the above requires a new D-decision entry in STATE.md and a corresponding
deviation note before implementation.
