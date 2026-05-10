# ADR-364 — Remote agent-session substrate (VibeTunnel / Crabbox / Symphony / CodexBar)

- **Status:** proposed
- **Date:** 2026-05-10
- **Issue:** #364
- **Author:** session main-2026-05-10-deep-1 W2 B1

## Context

`session-orchestrator` today is a single-host CLI plugin: each `/session` runs in one shell, owned by one user, on one machine. The substrate is built around four primitives — `session-lock.mjs:1-92` (PID-bound atomic-rename TTL lock), `coordinator-snapshot.mjs:1-95` (git stash refs `refs/so-snapshots/<sessionId>/...`), `worktree.mjs` (per-agent file-disjoint scopes), and `sessions.jsonl` (82 entries, v1 schema; see W1-A6 §"Session-record schema") — plus the autopilot driver in `scripts/lib/autopilot/loop.mjs` with 9 kill-switches in `scripts/lib/autopilot/kill-switches.mjs:1-100`.

That substrate is sufficient for one human at one keyboard, but four adjacent products show a more ambitious target shape:

- **VibeTunnel** (W1-A1): browser-attachable terminal sessions with on-disk per-session control directories (`session.json`, `stdout`, FIFO stdin, IPC socket) and a snapshot mechanism for reconnect-time state reconstruction.
- **Crabbox** (W1-A2 §Crabbox): leased remote workspaces with TTL, warm-machine caching, broker-level cost caps, and stateless runners that hold no broker secrets.
- **CodexBar** (W1-A2 §CodexBar): pre-execution quota visibility across 40+ AI providers, reset-window-aware scheduling, cost-scoped session tiers.
- **Symphony** (W1-A3): one-issue-one-run-attempt isolation with workspace path validation, in-memory `claimed`/`running`/`retry_attempts` maps, and stall-timeout reconciliation.

The gap is not "we should add a browser UI" — it is that our session-record schema, lock model, and kill-switch set were designed for a closed-loop single-host run. As soon as Phase D (multi-story #341) lands, or the v3.x plugin grows a long-lived service surface, we will need:

1. **Stable agent identity** across reattach / restart (today the snapshot ref carries `<sessionId>` but no `agent_identity`, no `parent_run_id`).
2. **Workspace path validation** as a first-class invariant (today `worktree.mjs` trusts the caller's `allowedPaths`).
3. **Stall-timeout reconciliation** as a kill-switch class (today's 9 cover overload, hours, sessions, tokens, confidence, abort, spiral, failed-wave, carryover — none cover "agent stopped emitting").
4. **Pre-execution quota visibility** (today autopilot can hit a provider 429 mid-wave with no advance warning; W1-A6 §cross-cutting gap 5: TOKEN_BUDGET is autopilot-only).
5. **Durable forensics artefacts per run** beyond `events.jsonl` (which is unbounded — 86K entries already, W1-A6 §gap 1).

This ADR maps each concept from the four sources to one of four verdicts (adopt / spike / reject / adapt), names the file or module that would be touched, and proposes a thin-slice MVP for v3.6/v3.7 that demonstrates the direction without committing to a multi-month epic.

## Decision

| Concept | Source | Verdict | Rationale | Touches |
|---------|--------|---------|-----------|---------|
| On-disk session artifacts (`session.json` + `stdout` + metadata per session) | VibeTunnel (W1-A1) | adopt | Forensics value, low effort, complements unbounded `events.jsonl`. Per-session control dir gives durable post-execution evidence and bounded retention (one dir = one session = trivially GC'd). | `scripts/lib/sessions-jsonl.mjs` (extend); new `~/.session-orchestrator/control/<sessionId>/` layout mirroring `~/.vibetunnel/control/<SESSION_ID>/` |
| Browser-attachable session IDs | VibeTunnel (W1-A1) | spike | Conceptually clean (sessions get a stable URL-safe identifier separate from PID/cwd), but unclear whether we need it before any browser surface exists. **Open Q:** does `session_id` schema field already serve this role, or do we need a separate `attach_token`? | `session-lock.mjs:1-92` (add `attach_id` alongside `session_id`) |
| WebSocket v3 binary framing (magic `0x5654`, SUBSCRIBE/INPUT/RESIZE/KILL/SNAPSHOT_VT/STDOUT) | VibeTunnel (W1-A1) | reject | Out of scope for a CLI plugin. We have no transport layer to frame, no live-attach surface to multiplex, and no PTY manager. Adopting WS v3 today would be infrastructure without a consumer. |  — |
| Snapshot mechanism for reconnect-state reconstruction | VibeTunnel (W1-A1) | adapt | We already have snapshots — `coordinator-snapshot.mjs:1-95` uses git stash refs `refs/so-snapshots/<sessionId>/...`. VibeTunnel's pattern is richer (terminal scrollback + cursor pos). Adapt their **lifecycle hooks** (capture-on-disconnect, restore-on-reattach), not their content model. | `coordinator-snapshot.mjs` (add `attachAt`/`detachAt` hooks) |
| Conditional feature visibility (Follow Mode pattern — features only appear when meaningful state exists) | VibeTunnel (W1-A1) | adopt | Direct fit: today `/session resume` always shows snapshot-recovery AUQ even when no snapshot exists. Pattern says "no snapshot ref → don't render the option." | session-start Phase 1.5 (snapshot-recovery AUQ; W1-A6 §"Key files") |
| Lease/TTL session model | Crabbox (W1-A2) | adopt | Maps cleanly to existing `session-lock.mjs:1-92` TTL semantics. Formalize as `lease_acquired_at` + `lease_ttl_seconds` + `lease_released_at` in sessions.jsonl. No transport changes; pure schema lift. | `session-lock.mjs:1-92` + `sessions-jsonl.mjs` schema |
| Warm-machine concept (cache dependency installs between sessions) | Crabbox (W1-A2) | reject | We are filesystem-resident, not VM-leased. `node_modules/` and `~/.cache/` are already warm by virtue of running on the dev's laptop. No equivalent gap to fill. | — |
| Cost-cap enforcement (broker-level spend caps) | Crabbox (W1-A2) | spike | Conceptually adjacent to TOKEN_BUDGET kill-switch (#355) but operates on $ instead of tokens. **Open Q:** do we have provider pricing data plumbed in, or does this require a CodexBar-style provider catalog first? **Ordering:** blocked on the 3-provider quota-probe spike below — quota-probe MUST land first. | `autopilot/kill-switches.mjs:1-100` (extend) — but blocked on quota-data spike below |
| Stateless runners (recipients hold no broker secrets; idempotent ops) | Crabbox (W1-A2) | adopt | Already implicit in our agent-dispatch model: subagents receive scoped `allowedPaths` + tool list, no global creds. Codify the invariant in agent-authoring rules (no-secrets-in-prompt) rather than introducing new code. | `CLAUDE.md` "Agent Authoring Rules" — *deferred to follow-up issue, not this ADR's scope* |
| Quota visibility before waves (`orchestrator quota --provider claude`) | CodexBar (W1-A2) | spike | High-value pre-execution gate. Spike is scoped to **exactly three providers**: `{Anthropic Admin API, OpenAI usage endpoint, OpenRouter /api/v1/auth/key}` — no expansion to the 40+ provider catalog. **Ordering:** the quota-probe spike MUST land before any cost-cap spike, since cost-cap enforcement depends on quota readback shape. | NEW skill `skills/quota-probe/` (not yet created) |
| Reset-window-aware scheduling (defer expensive waves until quota resets) | CodexBar (W1-A2) | spike | Depends on quota-probe spike above (3-provider scope). Worth pairing in the same follow-up so we don't do the schema work twice. | depends on quota-probe spike |
| Cost-scoped session tiers (quick / standard / deep) | CodexBar (W1-A2) | adopt | Already partially encoded in our session-type enum (`feature`, `housekeeping`, `discovery`, `deep`). Codify the cost expectation per tier in the session-record schema as `expected_cost_tier` so post-session retros can flag overruns. | `sessions-jsonl.mjs` schema |
| Credential multiplexing (reuse existing provider sessions) | CodexBar (W1-A2) | reject | Browser-cookie harvesting and OAuth-token scraping are explicitly listed as security/privacy concerns in W1-A2. Our `owner.yaml` (`.claude/rules/owner-persona.md`) already keeps creds out of the repo. No win to be had here. | — |
| macOS menu-bar UI | CodexBar / VibeTunnel | reject | We are a CLI plugin that ships across Claude Code / Codex CLI / Cursor IDE. Platform-specific GUI is out of scope. | — |
| Per-issue isolation + workspace path validation | Symphony (W1-A3) | adopt | Direct fit for Phase D #341. Symphony's `validateWorkspacePath(computed, root)` is a pure function — easy to lift, easy to test, immediately useful even without multi-story dispatch. | `worktree.mjs` (W1-A6 §"Key files for #364") — add `validateWorkspacePath()` pure helper to `scripts/lib/worktree/lifecycle.mjs:1-254` |
| Single-authority `claimed` + `retry_attempts` maps for multi-issue dispatch | Symphony (W1-A3) | spike | Phase D #341 prerequisite. **Open Q:** in-memory map is fine for one-coordinator-process, but our autopilot already persists state in STATE.md. Should multi-story state live in-memory (Symphony-style, restart-loses-state) or in `.claude/multi-story-state.json` (orchestrator-style)? | NEW `scripts/lib/autopilot/multi.mjs` (does not yet exist) |
| Stall-timeout reconciliation (sample every 30s, 2-consecutive-strikes-then-kill) | Symphony (W1-A3) | adopt | New 10th kill-switch class; reduces false positives versus a single 5-min timer (W1-A3 explicitly recommends 2-strike sampling over Symphony's default). Direct fit to existing kill-switch architecture. | `scripts/lib/autopilot/kill-switches.mjs:1-100` — add `STALL_TIMEOUT` post-iteration switch |
| In-memory-only state (no persistent DB; restart re-polls tracker) | Symphony (W1-A3) | reject | We have `STATE.md` and `sessions.jsonl` precisely so a restart can resume from the last wave (W1-A6 §"Symphony vs our autopilot": *Recovery — Re-poll from scratch* vs *Resume from last wave*). Discarding persistence loses our key advantage. | — |
| Continuous tracker poller (Linear/GitHub state-change trigger) | Symphony (W1-A3) | reject | Our model is `/session` user-initiated; W1-A3 calls this out as the architectural fork. Continuous polling pushes us toward "always-on service" which contradicts the CLI plugin shape. Reconsider only if a user-triggered cron equivalent emerges. | — |
| Proof-of-observability via JSON API (extend `autopilot.jsonl` with `worktree_path`, `parent_run_id`, `stall_recovery_count`) | Symphony (W1-A3) | adopt | These three fields are cheap to add and unblock multi-story telemetry without committing to multi-story dispatch itself. Schema-only change. | `scripts/lib/autopilot/telemetry.mjs:1-120` (relocated from `autopilot-telemetry.mjs` per deep-4) |
| Hybrid concurrency cap (static `multi-story-concurrency: 2` + resource-probe veto) | Symphony (W1-A3) | spike | Couples with multi-story dispatch spike. Worth holding until that decision lands. **Open Q:** does the existing RESOURCE_OVERLOAD kill-switch already cover the resource-probe half? | depends on multi-story dispatch spike |

**18 rows total, 4 sources covered.**

## Thin-slice MVP vNext

The proposed thin slice is deliberately schema-and-scaffold heavy — three files, no behavioural change to the autopilot loop, no new external dependencies. It can ship in 1–2 deep sessions and unblocks the multi-story (#341) and quota-probe spikes without committing to either.

1. **Extend `sessions.jsonl` schema (additive-only, schema_version stays at v1)** with optional fields `agent_identity`, `worktree_path`, `parent_run_id`, `lease_acquired_at`, `lease_ttl_seconds`, `expected_cost_tier`. **Schema-version stance:** additive-only first; the `schema_version` field stays at `v1` and the validator treats the new fields as optional. Bump to `v2` happens in a follow-up issue, only after all 82 historical entries have been read at least once with the new validator (see §Risks #1 — both clauses agree).
   - File: `scripts/lib/sessions-jsonl.mjs` + `scripts/lib/session-schema/constants.mjs:1-76` (per deep-4 split)
   - Effort: **S** (schema + validator + 1 migration test)

2. **Extend `autopilot.jsonl`** with the same `worktree_path` + `parent_run_id` + `stall_recovery_count` fields per W1-A3 recommendation #4.
   - File: `scripts/lib/autopilot/telemetry.mjs:1-120`
   - Effort: **S** (additive, no consumer changes required)

3. **Add `STALL_TIMEOUT` kill-switch scaffold** — config-only, NOT yet wired to the runLoop driver. Defines the threshold (`stall-timeout-seconds: 600`, default 2-strike sampling at 30s intervals per W1-A3) and the JSON shape it emits, but exits early in `runLoop` so it cannot trigger until a follow-up wires the sampler. **Value convention:** the kill-switch identifier follows the existing 9-switch convention — `STALL_TIMEOUT: 'stall-timeout'` (mirrors e.g. `TOKEN_BUDGET_EXCEEDED: 'token-budget-exceeded'`). **Output destination:** when (in a follow-up) the sampler fires, the resulting kill-switch event is written to `autopilot.jsonl` (existing autopilot telemetry stream) — **NOT** to `failures.jsonl` (which is owned by PRD-366; cross-connections doc rule 4).
   - File: `scripts/lib/autopilot/kill-switches.mjs:1-100`
   - Effort: **M** (config + tests + docs; sampler deferred)

4. **Add `scripts/gc-stale-worktrees.mjs`** — finds orphaned worktrees (no matching `sessions.jsonl` entry within last 7 days, no live PID in lock file), prints them with a `--dry-run` default, deletes only with `--apply`. Closes the W1-A3 risk *cleanup failures → disk fill*.
   - File: `scripts/gc-stale-worktrees.mjs` (new)
   - Effort: **M** (filesystem walk + lock-file inspection + 2-3 tests covering happy/orphan/locked paths)

5. **Add `validateWorkspacePath(computed, root)` pure helper** to `worktree/lifecycle.mjs` per W1-A3 adoption #1. No call-site changes yet; just the helper + tests.
   - File: `scripts/lib/worktree/lifecycle.mjs:1-254`
   - Effort: **S** (pure function, table-driven test)

**Total estimated effort:** 2× S + 2× M + 1× S = roughly one deep session for items 1, 2, 5 + a second deep session for items 3 and 4. No external dependencies introduced. No behavioural change to existing flows. After this slice, the multi-story #341 epic and the quota-probe spike both have a concrete schema to extend rather than designing from scratch.

### Definition of Done

Each thin-slice item ships only when its corresponding observable test/assertion passes in CI. One observable test per item, hand-checkable from a green run.

1. **Item 1 (sessions.jsonl additive fields):** unit test asserts a v1 entry with the six new fields present validates clean AND a legacy v1 entry omitting all six fields ALSO validates clean (additive-only contract). `schema_version` field on disk remains the literal string `"v1"` — assert no `"v2"` strings appear in `sessions.jsonl` after the migration test runs. File: `tests/lib/sessions-jsonl.test.mjs` (extend).
2. **Item 2 (autopilot.jsonl additive fields):** unit test asserts a fresh autopilot run writes an entry whose `worktree_path`, `parent_run_id`, and `stall_recovery_count` keys are present (values may be null/0 in the no-multi-story baseline) and a downstream consumer reading the JSONL with `JSON.parse` does not throw on the new keys. File: `tests/lib/autopilot/telemetry.test.mjs` (extend).
3. **Item 3 (`STALL_TIMEOUT` scaffold):** unit test asserts the kill-switch object exports `STALL_TIMEOUT === 'stall-timeout'` (value-convention check) AND that calling the switch's evaluator with any input returns `null` until the sampler exists (i.e., the switch never fires from the scaffold alone). This is the test promoted from §Risks #2 mitigation. File: `tests/lib/autopilot/kill-switches.test.mjs` (extend).
4. **Item 4 (`gc-stale-worktrees.mjs`):** integration test with three fixture worktrees — one matched by a fresh `sessions.jsonl` entry (must be kept), one orphaned >7 days with no live PID (must be reported in `--dry-run` and removed under `--apply`), one orphaned but with a live PID lock (must be skipped in both modes). Assert `--dry-run` is the default and `--apply` requires the explicit flag. File: `tests/scripts/gc-stale-worktrees.test.mjs` (new).
5. **Item 5 (`validateWorkspacePath` pure helper):** table-driven test with at least 6 cases — happy (computed inside root), traversal (`../etc/passwd`), absolute-outside-root, symlink escape, empty-string, root-itself. Assert helper has zero call-sites in production code post-merge (rg `validateWorkspacePath\(` outside `worktree/lifecycle.mjs` and the test file returns no hits). File: `tests/lib/worktree/validate-workspace-path.test.mjs` (new).

## Risks

1. **Schema-version drift across `sessions.jsonl` v1/v2.** Mitigation: validator accepts both shapes for at least one minor cycle; bump only after all 82 historical entries have been read at least once with the new validator. Reuses the deprecation discipline from `development.md` §"Package Lifecycle & Versioning".
2. **`STALL_TIMEOUT` config without a sampler is dead weight.** Mitigation: ship the scaffold with an explicit `// TODO: wire sampler in #<followup>` comment and a unit test that asserts the kill-switch returns `null` (never fires) until the sampler exists. Don't let the config live longer than 30 days without the sampler — fold into v3.7 or revert.
3. **`gc-stale-worktrees.mjs` deletes work-in-progress from a parallel session.** Mitigation: PSA-003 applies (`.claude/rules/parallel-sessions.md`) — `--dry-run` is the default, `--apply` requires explicit operator authorisation, and the lock-file PID liveness check from `session-lock.mjs:1-92` is the gate. Cross-cutting gap W1-A6 §3 (no unified Session Recovery mode) is acknowledged but not solved here.
4. **`agent_identity` and `parent_run_id` overlap with existing `session_id`.** Mitigation: document the three-level identity model in the schema constants file (`session-schema/constants.mjs`) — `session_id` = the human's `/session` invocation, `parent_run_id` = the autopilot run that spawned this child, `agent_identity` = the wave-agent within a run. One ADR follow-up to nail down the cardinality before locking the schema.
5. **Adopting Symphony's `validateWorkspacePath` may reveal latent path-traversal bugs in current `worktree.mjs` callers.** Mitigation: ship the pure helper first **without** wiring it to existing call sites; in a follow-up, add a single non-blocking warning log when `validateWorkspacePath()` would have rejected an existing call. Promote to blocking only **after the helper has logged zero would-have-rejected warnings across N≥3 deep sessions in `events.jsonl`, OR after 30 days, whichever is later** — measurable threshold replacing the prior vague "one quiet release cycle" criterion.

## Open questions

This ADR does NOT decide:

- **Whether session-orchestrator grows a browser/web surface at all.** The VibeTunnel "browser-attachable session IDs" verdict is `spike`, deferred to a follow-up issue once a concrete consumer exists. Without a UI, `attach_id` is theatre.
- **Whether multi-story state lives in-memory or on-disk.** Symphony adopts in-memory; we lean toward on-disk for restart-recovery parity. Defer to Phase D #341 design issue.
- **Which providers can be queried for quota.** CodexBar's 40+ provider catalog is impressive but represents engineering we cannot afford to replicate. A targeted spike on `claude` + `codex` + `openrouter` only is the next step. Defer to a new follow-up issue ("quota-probe MVP — three providers").
- **Cost-cap enforcement currency** ($ vs tokens vs requests). TOKEN_BUDGET (#355) covers tokens; Crabbox covers $. Pick one as primary before extending kill-switches further. Defer.
- **Whether `events.jsonl` retention should be solved here.** W1-A6 §gap 1 (86K entries, no retention) is real but orthogonal to the substrate question. Defer to a dedicated retention-policy issue.
- **How `validateWorkspacePath` interacts with the existing destructive-command guard** (`hooks/pre-bash-destructive-guard.mjs`). Both are path-shaped invariants but at different layers. Defer to the follow-up that wires the helper to live call sites.
- **Should `subagent_stop` events in `events.jsonl` be enriched with `session_id` + `wave` + `agent_identity` as part of this thin slice, or deferred to PRD-366's `failures.jsonl` work?** Today `subagent_stop` records lack these correlation fields, blocking post-hoc per-agent forensics. Cite: `docs/spike-probes/2026-05-10-proofs.md` probe 4 finding #3 (B6 schema gap on subagent_stop events). Resolution may live here (additive fields on `events.jsonl` `subagent_stop` records, consistent with item 1's additive-only stance) OR be folded into PRD-366's verification-failure schema work. Defer to coordinator decision before Phase 1 of either spike opens.

## Sources

Primary references — all consolidated in `docs/spike-probes/2026-05-10-w1-research-context.md`:

- **W1-A1** (VibeTunnel) §"What", §"Architecture", §"Adopt", §"Reject", §"Open Q" — `amantus-ai/vibetunnel`, https://vibetunnel.sh/
- **W1-A2** (Crabbox + CodexBar) §Crabbox, §CodexBar, §"Cross-cutting" — https://crabbox.sh/, `steipete/CodexBar`
- **W1-A3** (Symphony) §"Three-level isolation", §"State", §"Kill-switches", §"Symphony vs our autopilot" table, §"Adoptable for Phase D" #1–#5, §"Risks" — `steipete/symphony`
- **W1-A6** (Internal codebase audit) §"Session-record schema", §"Key files for #364", §"Cross-cutting gaps" #1–#5, §"Recommended dispatch granularity"

Internal anchors cited inline:
- `scripts/lib/session-lock.mjs:1-92` (atomic-rename TTL lock)
- `scripts/lib/coordinator-snapshot.mjs:1-95` (git-stash snapshots)
- `scripts/lib/worktree/lifecycle.mjs:1-254` (per deep-4 split, W1-A6)
- `scripts/lib/autopilot/kill-switches.mjs:1-100` (9 existing switches)
- `scripts/lib/autopilot/telemetry.mjs:1-120` (relocated from `autopilot-telemetry.mjs`, deep-4)
- `scripts/lib/session-schema/constants.mjs:1-76` (deep-4 split)
- `.claude/rules/parallel-sessions.md` PSA-003 (destructive-action discipline)
- `development.md` §"Package Lifecycle & Versioning" (deprecation cycle)

**Cross-spike coordination:** Schema-bump ownership coordinated with sibling spikes per `docs/adr/2026-05-10-spike-cluster-cross-connections.md` rule #2 — additive-only schema fields on `sessions.jsonl` and `autopilot.jsonl` introduced here do NOT bump `schema_version`; that bump (when it eventually happens) is owned by a dedicated follow-up issue, not this ADR.
