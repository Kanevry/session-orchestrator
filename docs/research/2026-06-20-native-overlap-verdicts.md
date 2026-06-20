# Native-Overlap Verdicts — Research & Remediation Backing (#665)

> **Status:** research / working doc. The authoritative decisions live in the
> **ADR-0010 refresh** (owned by a sibling agent — see
> [`docs/adr/0010-native-autonomy-commands.md`](../adr/0010-native-autonomy-commands.md)).
> This doc holds the full evidence trail plus the **actionable deliverables**
> that become W5 remediation issues. Where the two disagree, the ADR wins.

## Intro — what #665 asked

Issue #665 asks whether the steady drip of **native Claude Code primitives**
(v2.1.139–179, surfaced in the 2026-06-17 external changelog research) has
**absorbed the value proposition** of several orchestrator-owned features, and
where the durable moat still sits. The framing: re-center the plugin on what is
*structurally* not absorbable, retire or thin-wrap anything the harness now does
natively, and re-scope the rules/config that the overlap touches.

This doc renders four verdicts:

1. **Dynamic Workflows vs wave-executor** — STAY (with one open follow-up).
2. **deep-research** — nothing of ours to retire; the in-repo skill never existed.
3. **PSA re-scope** — PSA's durable value is *operator-session safety*; Agent
   Teams cannot enter that domain. Lift-ready re-scope text below.
4. **Opt-in defaults re-eval** — `discovery-validator` → recommend flip-to-on
   (low risk); `verification-auto-fix` → keep opt-in (higher risk).

**Source:** 2026-06-17 external changelog research (Claude Code v2.1.139–179),
cross-referenced against the in-repo evidence cited inline below. Every
distributional claim in this doc quotes its executed grep per PSA-006.

---

## § Dynamic Workflows vs wave-executor — **STAY**

Dynamic Workflows (`Workflow` tool, v2.1.154+) is a one-shot fan-out primitive:
plan once, fan out dozens-to-hundreds of subagents, return only the final result
to the main context. It overlaps `skills/wave-executor/` (parallel subagent
fan-out) and `commands/autopilot-multi.md` (N parallel issue pipelines). The
overlap is real but **does not absorb** wave-executor, for two structural reasons.

### Evidence 1 — agent-count caps are not a stop-condition surface

Dynamic Workflows ship **agent-count bounds** (16 concurrent / 1000 total per
run) — a runaway-protection ceiling. The orchestrator's autopilot ships **ten
distinct kill-switches** that are *stop conditions*, not count limits:

`scripts/lib/autopilot/kill-switches.mjs:18-32` (`KILL_SWITCHES` frozen object):

| Phase | Switches |
|---|---|
| Pre-iteration (#295) | `max-sessions-reached`, `max-hours-exceeded`, `resource-overload`, `low-confidence-fallback`, `user-abort`, `token-budget-exceeded` |
| Post-iteration (ADR-364) | `stall-timeout` (default 600s) |
| Post-session (#300) | `spiral`, `failed-wave`, `carryover-too-high` |

A `16/1000` cap cannot express "abort if resource-overloaded", "abort if the
session is spiralling", or "abort if carryover is too high". These are
*semantic* stops; the caps are *quantitative* ceilings. They are not
substitutable.

### Evidence 2 — telemetry gap

Workflows ship no `autopilot.jsonl`-equivalent run telemetry. The orchestrator's
kill-switch decisions, stall samples, and per-iteration progress all land in
`.orchestrator/metrics/autopilot.jsonl` for post-hoc analysis and the
data-gated learning loop. A bare Workflow swap loses this entirely.

### Evidence 3 — provider availability cuts the other way

Per `.claude/rules/loop-and-monitor.md` § LM-002b, Workflows run on
Bedrock/Vertex/Foundry **as well as** Anthropic-auth — *unlike* Monitor and
Channels (Anthropic-only). So on a non-Anthropic provider, Workflows is the
**Adapter-fallback** reach where Monitor/Channels are unreachable. That makes
Workflows a *complement* on those providers, not a replacement for the
guard+telemetry surface.

### Verdict

**STAY.** Do not swap wave-executor for a bare Workflow on the assumption the
16/1000 caps substitute for the ten kill-switches — they are agent-count bounds,
not a stop-condition surface (LM-002b is explicit on this). The Adopt / Adapter /
Stay verdict for *dynamic Workflows vs wave-executor* — previously an open
ADR-0010 follow-up — is **RESOLVED to STAY by the 2026-06-20 ADR refresh**, with a
single residual clause: an Adapter-fallback on non-Anthropic providers (where
Monitor/telemetry is already degraded). The reasons a future full adapter would
have to overcome remain the kill-switches + `autopilot.jsonl` telemetry gap.

---

## § deep-research resolution — **nothing of ours to retire**

#665's deliverable framing was "retire-or-thin-wrap our deep-research skill".
**That framing rested on a skill that does not exist in-repo.** Stated honestly:

**Coordinator-verified (grep transcripts):**

- `ls skills/ | grep -ic deep-research` → **0** (0 of 42 skill dirs under `skills/`).
- 0 commands reference a deep-research command.
- 0 `.claude-plugin/` / marketplace entries reference it.

The `/deep-research` available in-harness is **EXTERNAL / bundled** and already
fully native: fan-out web searches, source fetch, adversarial claim-voting /
cross-check, cited report synthesis, and context-isolation via script-scoped
variables. There is **nothing orchestrator-owned to retire or thin-wrap** —
because there is nothing of ours.

The repo therefore **deliberately does NOT build a deep-research skill**, given
the full native overlap. Building one would be pure duplication.

**Optional future idea (NOT a current gap):** the only conceivable
differentiator is an **orchestrator-side sink** — piping a `/deep-research`
cited report into a learning entry (`learnings.jsonl`) or a vault note, so a
research run feeds the durable memory loop. This is a *nice-to-have*, low
priority, and explicitly **not** a hole in current capability.

**Verdict:** No retire/thin-wrap issue needed. At most a 1-line tracking note for
the optional vault-sink idea (see Remediation §, issue (c), low prio).

---

## § PSA re-scope — operator-session safety is the durable, non-obsoleted moat

### Context: ADR-0002 isolation premise

ADR-0002 classified Agent Teams as an **Adapter**. Its isolation premise is
**CONFIRMED FALSE**: Agent Teams provides no automatic file isolation — "two
teammates editing the same file leads to overwrites." Agent Teams is
**per-process** ("one team per session"), **not per-repo**. It structurally
cannot witness an independent parallel *operator* session in the same working
copy.

### PSA classification (`.claude/rules/parallel-sessions.md`)

| Rule | Lines | Domain |
|---|---|---|
| PSA-001 Aware | :33–47 | Operator-session safety (passive detection) |
| PSA-002 Pause | :51–69 | Operator-session safety (active conflict) |
| PSA-003 Destructive safeguards | :72–83 | Operator-session safety |
| PSA-004 Commit discipline | :85–90 | Operator-session safety |
| PSA-005 STATE.md write-lock | :92–112 | **Spans BOTH** operator-session AND in-run wave-executor checkpoints |
| PSA-006 Discovery grep-discipline | :114–141 | Orthogonal (Discovery verification, unrelated to Teams) |

### Re-scope statement (lift-ready for a future `parallel-sessions.md` edit)

> PSA's durable, non-obsoleted value is **operator-session safety**: independent
> parallel operator/Claude sessions in the **same working copy**. PSA-001..004,
> plus the per-repo session lock (`scripts/lib/session-lock.mjs` `acquire()` /
> `session.lock`, heartbeat-liveness schema v2), guard this domain. **Agent
> Teams structurally cannot enter it** — Teams is per-process / in-run only, so
> its graduation to native affects **only the in-run multi-agent coordination
> slice**, never the operator-session slice.
>
> Even within the in-run slice, our own machinery remains necessary because
> Agent Teams provides **no automatic isolation**: file-scope deconfliction
> (`skills/session-plan/SKILL.md:434-436` — "verify that NO two agents in the
> same wave modify the same file") plus `withStateMdLock` STATE.md serialization
> still do the work Teams does not. Of PSA-005's two halves, **only the
> session-lock half is purely operator-scoped**; the STATE.md write-lock half
> also protects in-run wave-executor checkpoints.

**Verdict:** PSA is **not obsoleted** by Agent Teams going native. Recommend a
follow-up issue to edit `parallel-sessions.md` with this operator-vs-in-run
framing made explicit (see Remediation §, issue (a)).

---

## § Team Memory divergence — deliberate, not obsolescence

Native Team Memory (`CLAUDE_MEMORY_STORES`) is **server-synced and
Anthropic-auth-only**. This repo's memory is **git / host-local**
`.orchestrator/metrics/learnings.jsonl`, public-repo-safe under a three-tier
model (local / private / public; the public tier requires `anonymized=true` +
`host_class`, and owner-leakage is blocked in CI per #653).

**Grep:** `grep -rc "CLAUDE_MEMORY_STORES"` over `*.mjs` + `*.md` → **0 hits**.
The repo does not consume native Team Memory at all.

This is a **deliberate divergence** on a **different trust boundary**
(host-local + public-repo-safe vs server-synced + Anthropic-auth), **not** an
obsolescence the native feature absorbs. No action needed.

---

## § Opt-in defaults re-eval

Two opt-in Session Config flags were flagged for a default re-evaluation in the
wake of the native-overlap review. The per-flag verdicts:

| Flag | Current default | What it does | Recommendation | Risk |
|---|---|---|---|---|
| `discovery-validator` | `false` (off) | `SubagentStop` hook; scans transcript tail for distributional claims lacking an adjacent grep transcript; records `discovery_validator_violation` in `events.jsonl` + stderr WARN | **FLIP to default-on** | **LOW** (observational) |
| `verification-auto-fix` | `false` (off) | On inter-wave Quality-Gate failure, dispatches up to `max-retries` (default 2) fixer-agents that **mutate code**, then hard-abort | **KEEP opt-in** | **HIGHER** (interventional) |

### discovery-validator → FLIP-TO-DEFAULT-ON (low risk)

It is **log + warn-only** and **EXIT 0 ALWAYS** — it never blocks the agent
(`hooks/post-subagent-discovery-validator.mjs:6-7` header contract; `:333`
`main().catch(() => {}).finally(() => process.exit(0))`;
`.claude/rules/parallel-sessions.md:141` "v1 is log + warn only and never blocks
the agent"). The worst case from a false positive is **one stderr WARN + one
`events.jsonl` row** — purely observational.

> **CRITICAL HONESTY CAVEAT — the "5×-recurring" premise is UNSUPPORTED.**
> #665's framing implied PSA-006 violations are "5×-recurring". **In-repo
> evidence does not support this figure:**
> - `grep -rl "5×-recurring" .` → **0 files**.
> - `grep -c discovery_validator_violation .orchestrator/metrics/events.jsonl`
>   → **0** (the hook has never been enabled, so it has produced zero rows).
> - `grep -ci PSA-006 .orchestrator/metrics/learnings.jsonl` → **0**.
> - Documented incidents = **exactly one**: the deep-1647 W1-D3 → W3-P2
>   "4 of 4 callers opt-in" mismatch, referenced 3× across the rules as *the*
>   canonical example.
>
> The flip recommendation therefore stands on **near-zero flip risk**, NOT on a
> frequency claim. The "5×" figure must be sourced from the live #665 thread or
> external logs, or the justification restated — it must **not** be repeated as
> fact. A useful side effect of flipping the flag on: it would finally generate
> **real recurrence telemetry** (currently 0 rows) so a future decision can be
> evidence-driven instead of anecdote-driven.

### verification-auto-fix → KEEP-OPT-IN (higher risk)

Flipping this changes **execution behaviour**: from abort-on-fail to an
auto-retry loop that **mutates code**. Its only defense against the BE-012
"test-the-mock" silent-pass vector is a **prompt-level reminder, not a
mechanical gate** (`.claude/rules/quality-gates-autofix.md:15-27` — "MUST say:
'Do NOT change test mocks to make tests pass.'"). The doc's own **"When NOT to
enable"** list (`:29-34`) covers **architectural decisions, first-pass
implementations, and security-sensitive code paths** — a large fraction of deep
sessions.

The asymmetry vs discovery-validator is the decisive factor:
**observational** (one WARN row) vs **interventional** (mutates the working tree
behind a prompt-only guard). Keep it opt-in.

---

## § Recommended remediation issues (for the W5 Finalization agent to file)

Concrete, lift-ready issue stubs. Each is title + 1-line scope.

**(a) PSA re-scope edit — `parallel-sessions.md` operator-vs-in-run framing**
> *Title:* `docs(rules): re-scope PSA — operator-session safety is the durable moat (Agent Teams cannot enter it)`
> *Scope:* Edit `.claude/rules/parallel-sessions.md` to add the lift-ready
> re-scope statement (PSA § above): PSA-001..004 + session-lock = operator-scoped
> and non-obsoleted; Agent Teams' native graduation affects only the in-run slice
> where file-scope deconfliction + `withStateMdLock` still do the isolation Teams
> does not provide. Priority: medium.

**(b) discovery-validator default-on config flip — LOW risk**
> *Title:* `config: flip discovery-validator.enabled default false → true (log+warn-only, exit-0-always)`
> *Scope:* Change the committed Session Config default in `CLAUDE.md` +
> `docs/session-config-template.md`; update `claude-md-drift-check` parity
> expectations if needed. Justification = near-zero flip risk (observational,
> never blocks), NOT the unsupported "5×" claim. Side benefit: generates the
> first real `discovery_validator_violation` telemetry. Priority: low/small.

**(c) Optional deep-research vault-sink idea — LOW priority tracking note**
> *Title:* `idea: orchestrator-side sink for /deep-research cited reports → learnings/vault entry`
> *Scope:* Tracking note only. Explore piping a native `/deep-research` cited
> report into `learnings.jsonl` or a vault note so research feeds the durable
> memory loop. NOT a current gap — the only conceivable differentiator over the
> fully-native bundled skill. Priority: low (idea/backlog).

> **Explicitly NOT recommended:** a deep-research retire/thin-wrap issue (nothing
> of ours exists to retire); a verification-auto-fix default flip (interventional,
> prompt-only guard against BE-012 — keep opt-in); a wave-executor→Workflow swap
> (STAY; the kill-switch / telemetry deltas are an open ADR-0010 follow-up, not a
> decided migration).

---

## Verification provenance

Every grep in this doc was executed against the working tree on 2026-06-20:
`deep-research skill dirs` = 0/42, `CLAUDE_MEMORY_STORES` = 0 files,
`5×-recurring` = 0 files, `discovery_validator_violation` (events.jsonl) = 0,
`PSA-006` (learnings.jsonl) = 0. File:line citations
(`kill-switches.mjs:18-32`, `post-subagent-discovery-validator.mjs:6-7,333`,
`quality-gates-autofix.md:15-34`, `parallel-sessions.md:33-141`,
`session-plan/SKILL.md:434-436`) were spot-checked by reading the cited ranges.
