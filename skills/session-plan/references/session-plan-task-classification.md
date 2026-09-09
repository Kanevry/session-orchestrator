# Session Plan — Step 1.8: Task-to-Role Classification

> Reference of the session-plan skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`** — none needed rewriting: the moved body carries no relative markdown links, only backticked file mentions, which were deliberately left untouched so the bytes stay verifiable against the pre-split file.
> **Read after Step 1.5 (Agent Discovery) and before Step 2 (Wave Assignment) in `../SKILL.md`.** Covers the signal-to-role mapping table, disambiguation rules, the Docs-role Phase 2.5 emission block, the housekeeping short-circuit, the Docs-tasks and Wave-Plan Mission Status machine-readable emission blocks, and the Mission-Status Enum (#340).

## Step 1.8: Task-to-Role Classification

For each task from Step 1, assign exactly one role. Use these signal-to-role mappings:

| Signal in task | Role | Examples |
|---|---|---|
| Needs codebase understanding before changes; audit, explore, verify assumptions, check existing coverage | **Discovery** | "Audit auth flow", "Check test coverage for module X", "Identify affected modules" |
| New feature code, new API endpoints, DB schema changes, primary UI components, new modules | **Impl-Core** | "Add /api/users endpoint", "Create migration for invoices table", "Implement auth middleware" |
| Bug fixes from prior waves, secondary features, integration work, edge cases, polish of existing code | **Impl-Polish** | "Fix pagination edge case", "Integrate payment with billing", "Handle error states in form" |
| Documentation updates — new/changed README sections, CLAUDE.md (or AGENTS.md on Codex CLI) updates, vault context.md/decisions.md narratives, ADR edits. Audience-aware (User/Dev/Vault). Gated on `docs-orchestrator.enabled` | **Docs** | "Update README for new --no-vault flag", "Write CLAUDE.md section for new hook (or AGENTS.md on Codex CLI)", "Append vault decisions.md entry for architecture change" |
| Write/update tests, lint fixes, security review, code simplification, type errors | **Quality** | "Add tests for auth module", "Fix TypeScript errors", "Security audit of new API" |
| Documentation updates, issue cleanup, commit preparation, SSOT refresh, changelog | **Finalization** | "Update README", "Close resolved issues", "Write session handover notes" |

**Disambiguation rules:**
- If a task involves BOTH exploration AND implementation → split it: Discovery agent reads/validates, Impl-Core agent implements. Create two separate task entries.
- If a task is "fix something from a previous session" (not from this session's Impl-Core) → classify as **Impl-Core** (it is new work for this session).
- A "write tests for new feature code being built this session" task is created ONLY when Discovery or a qa-strategist run reported a **named gap** — a concrete bug or regression the current suite would let through, stated as such. When that gap exists, classify the task as **Quality** (not Impl-Core); tests run after implementation. "Feature X was built" is NOT by itself evidence of test demand: with no named gap, no Quality task is created — do not synthesize one to give the role something to do. A dispatched `test-writer` may correspondingly report `no-tests-needed` as a SUCCESS status, not a failure.
- If unsure between Impl-Core and Impl-Polish → if the task is on the critical path (other tasks depend on it), it is **Impl-Core**. If independent polish, it is **Impl-Polish**.
- **Docs role** is only active when `docs-orchestrator.enabled: true` in Session Config. When disabled (default), documentation-update tasks fall into **Impl-Polish** (inline doc changes alongside code) or **Finalization** (standalone doc/SSOT updates) as today.

#### Step 1.8 Docs-role: Consuming the Phase 2.5 Emission Block

When `docs-orchestrator.enabled: true`, session-start Phase 2.5 emits a delimited block in the conversation context. Read and parse it before synthesizing Docs-role tasks:

**Locating the block:** Search the conversation context for the header `### Docs Planning Result (Phase 2.5)`. If the header is absent, Phase 2.5 was skipped — emit **0 Docs tasks** and do not fabricate any.

**Parsing rules (apply in document order):**
- `Audiences:` — comma-separated list of active audience identifiers (e.g., `user, dev`). Trim whitespace around each value.
- `Mode:` — single enum value: `warn`, `strict`, or `off`. Store as `$docs_mode`.
- `Docs-tasks-seed:` — multi-entry bullet list. Each top-level `- audience:` bullet is **one seed task**. Parse in document order; do not merge entries. Each seed task has:
  - `audience:` — target audience (`user`, `dev`, or `vault`)
  - `rationale:` — free-text description of what needs documenting

**Synthesizing Docs-role tasks:** For each seed task entry (in document order):
1. Set `role: Docs`.
2. Set `description` derived from the `rationale` field (paraphrase as an actionable imperative, e.g., "Document the new `--no-vault` flag in user-facing README").
3. Set `audience` from the `audience` field.
4. Set `target-pattern` by looking up the audience in the `Audiences & File Patterns` table in `skills/docs-orchestrator/audience-mapping.md`. Use the glob pattern listed there for the matched audience row.
5. Resolve `subagent_type` per the Docs-role fast path in Step 1.5 point 4 above.

**If the block is absent:** Do not fabricate Docs tasks. The Docs role remains empty; apply the empty-role rule from Step 2.

- Housekeeping sessions: skip Steps 1.8, 2, and 3 — housekeeping is the **maintenance loop**, one coordinator-direct wave. `total-waves: 1` and the wave's `coordinatorDirect: true` come from the shape (`scripts/session-shape.mjs --session-type housekeeping`), not from this prose.
  - No role classification — no wave-executor dispatch, no per-role agent sizing.
  - **Default scope, in this order:**
    1. drift-check — `node skills/claude-md-drift-check/checker.mjs --mode warn`
    2. expired-learnings sweep — `node scripts/sweep-expired-learnings.mjs --json`, then `--apply --json` when the dry run reports `archived > 0`
    3. `/evolve analyze`
    4. `/reconcile`
    5. `/evolve dialectic` — dry-run first, then `--apply`
    6. `/memory-cleanup`
  - Operator-selected housekeeping issues are appended AFTER the six maintenance items, in the order the operator picked them.
  - **Why coordinator-direct:** four of the six are AUQ-gated, and `AskUserQuestion` does not exist inside a dispatched agent (`.claude/rules/ask-via-tool.md` AUQ-004) — a wave-executor dispatch would strand the decision. "Coordinator-direct" means no wave-executor, NOT zero subagents: item 5 dispatches the read-only `dialectic-deriver` subagent directly.
  - Wave plan output uses: `### Wave 1: Housekeeping (coordinator-direct, 0 agents)`

Record the assigned role next to each task before proceeding to Step 2.

### Docs-tasks persistence (for session-end Phase 3.2)

When `docs-orchestrator.enabled: true` AND the plan contains 1+ Docs tasks, session-plan MUST emit a machine-readable block **at the end of its plan output** (after the wave plan, before `Ready to execute?`). This block is the single source of truth (SSOT) consumed downstream:

- **wave-executor Pre-Wave 1b (STATE.md init):** reads this block and persists `docs-tasks: [...]` into STATE.md frontmatter.
- **session-end Phase 3.2 (docs verification):** reads `docs-tasks` back from STATE.md to verify each task produced a diff.

**Emit format:**

```yaml
### Docs Tasks (machine-readable)
docs-tasks:
  - id: docs-1
    audience: <user|dev|vault>
    target-pattern: <glob from skills/docs-orchestrator/audience-mapping.md>
    rationale: <verbatim rationale from Phase 2.5 seed>
    wave: <wave number where this docs-writer agent is dispatched>
    status: planned
  - id: docs-2
    ...
```

**Field rules:**
- `id`: sequential index-based identifier (`docs-1`, `docs-2`, …). No UUID generation required.
- `audience`: one of `user`, `dev`, `vault`.
- `target-pattern`: the glob from `skills/docs-orchestrator/audience-mapping.md` for this audience row — do not invent patterns.
- `rationale`: copy the `rationale` text from the Phase 2.5 seed entry verbatim (do not paraphrase here).
- `wave`: the actual wave number assigned in Step 2 where the `docs-writer` agent for this task is dispatched.
- `status`: always `planned` at plan time. Terminal values are set by session-end Phase 3.2 per-task verification loop: `ok` (diff substantive), `partial` (diff has `<!-- REVIEW: source needed -->` markers), or `gap` (no matching diff). wave-executor does NOT perform intermediate status updates — `status: planned` remains until session-end writes the terminal value.

**Omission rule:** When `docs-orchestrator.enabled: false` OR there are 0 Docs tasks, do NOT emit the `### Docs Tasks (machine-readable)` block. Absence of the block signals to wave-executor and session-end that no docs verification is needed for this session.

### Wave-Plan Mission Status (machine-readable)

When the wave plan contains 1 or more wave-plan items (i.e., for all non-empty plans), session-plan MUST emit a machine-readable mission-status block **at the end of its plan output** (after the Docs Tasks block if present, before `Ready to execute?`). This block is the SSOT consumed by wave-executor (for STATE.md persistence) and session-end Phase 1.9 (for enum-based classification).

- **wave-executor Pre-Wave 1b (STATE.md init):** reads this block and persists `mission-status: [...]` into STATE.md frontmatter via `writeMissionStatus` from `scripts/lib/state-md.mjs`.
- **session-end Phase 1.9:** reads `mission-status` back from STATE.md frontmatter via `parseMissionStatus` to classify items into the 1.1–1.4 buckets using enum values.

**Emit format:**

```yaml
### Wave-Plan Mission Status (machine-readable)
mission-status:
  - id: m-1
    task: <task description from wave-plan item>
    wave: <N>
    status: brainstormed
  - id: m-2
    task: <task description from wave-plan item>
    wave: <N>
    status: brainstormed
```

**Field rules:**
- `id`: sequential `m-N` identifier. No UUID generation required.
- `task`: verbatim task description from the wave-plan item (do not paraphrase).
- `wave`: the wave number where this task is dispatched.
- `status`: always `brainstormed` at plan emission. Terminal values are updated at gate transitions by wave-executor: `brainstormed` → `validated` (user confirms via `/go`) → `in-dev` (agent dispatched) → `testing` (Quality wave) → `completed` (Quality gate green). session-end Phase 1.9 reads the current value to classify the item.

**Transition gates (summary):**
At plan time, all items start at `brainstormed`. When the user runs `/go` to approve the plan, wave-executor updates each item to `validated`. When an agent for a wave-plan item is dispatched, wave-executor updates that item to `in-dev`. When the Quality wave begins, items from prior waves move to `testing`. When the Quality gate passes, items finalize at `completed`. Rollback to `brainstormed` is permitted from any state. This ordering is **coordinator convention, not a mechanical gate** — nothing validates a transition before it is written (see "Default and transitions" below).

**Omission rule:** When the plan has 0 wave-plan items (e.g., pure express-path coord-direct with no sub-agent tasks), do NOT emit the `### Wave-Plan Mission Status (machine-readable)` block.

### Mission-Status Enum (#340)

Every wave-plan item carries a `status` field drawn from a 5-value enum. The field is always present on items emitted in the `### Wave-Plan Mission Status (machine-readable)` block (see below). It is also the value persisted in STATE.md frontmatter and read back by session-end Phase 1.9 for enum-based classification.

#### Enum values

| Status | Meaning | Set when |
|---|---|---|
| `brainstormed` | Draft item from `/plan`, not yet user-confirmed | Plan emitted by session-plan (all items start here) |
| `validated` | User confirmed via AUQ in session-plan (`/go` approval) | wave-executor: user runs `/go` to approve the wave plan |
| `in-dev` | Agent picked up the task this wave | wave-executor: agent dispatched for this item |
| `testing` | Implementation done, tests passing for this task | wave-executor: Quality wave begins for this item's work |
| `completed` | Quality-Lite green for this task's wave | wave-executor: Quality gate passes for this item |

#### Default and transitions

- **Default at plan creation:** `brainstormed` — all items start here.
- **Transitions are coordinator-level orchestration** (not inside individual agent prompts). See `skills/wave-executor/SKILL.md` "Mission-Status Updates (#340)" for when each transition fires.
- **Rollback:** any item may return to `brainstormed` from any state (e.g. if work is discarded or re-planned).
- **No mechanical validation — by design.** The `status` values come from the 5-value enum in the table above, but nothing checks a transition before it is written. `setMissionStatus` (`scripts/lib/state-md/mission-status.mjs`) mirrors whatever string it is handed onto BOTH the body section and the frontmatter array, deliberately without an enum gate: gating it would reintroduce the exact body-says-X/frontmatter-says-Y divergence that sync exists to remove. An out-of-enum value therefore lands visibly on both surfaces instead of being silently rejected on one. Keeping the enum honest is the coordinator's job.

#### Status field in wave-plan items

Every item in the wave plan output carries an implicit `status: brainstormed` at plan time. The `### Wave-Plan Mission Status (machine-readable)` block below (emitted at the end of the plan output) is the machine-readable form that wave-executor and session-end Phase 1.9 consume. session-plan does NOT write STATUS transitions — it only emits the initial `brainstormed` values.
