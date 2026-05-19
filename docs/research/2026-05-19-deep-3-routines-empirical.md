# Routines Empirical Test Plan + Stop-Condition Watch

> Status: **PENDING-EMPIRICAL** — research-only artifact (deep-3, 2026-05-19)
> Issue: #485 Tasks 1 + 3 (merged: W3 P3 + W3 P4)
> Source docs: https://code.claude.com/docs/en/routines
> ADR: docs/adr/0003-routines-cloud-execution.md (Adapter verdict, ACCEPTED)

---

## 1. Background

ADR 0003 (`docs/adr/0003-routines-cloud-execution.md`) landed on **Adapter** — not Adopt, not Stay.
The core constraint: `/autopilot`'s `runLoop` runs exactly one bounded session per Routine fire. A
multi-iteration in-cloud loop is explicitly forbidden because Routines expose no stop-condition
primitive to feed the 10 kill-switches into.

**Why Adapter, not Adopt.**
`scripts/lib/autopilot/kill-switches.mjs:18-32` enumerates 10 `Object.freeze`-d kill-switches:
`SPIRAL`, `CARRYOVER_TOO_HIGH`, `STALL_TIMEOUT`, `MAX_SESSIONS_REACHED`, `TOKEN_BUDGET_EXCEEDED`,
and five additional guards. Routines have no max-iteration cap, no per-run budget gate, no
halt-on-condition expression — the entire autonomy-safety surface lives locally. Adopting Routines
as the loop brain would forfeit all 10 guards to gain one durability property from a research-preview
surface. The Adapter preserves the loop brain locally and uses a single Routine fire as a
walk-away-durable trigger for exactly one bounded session.

**Hard preconditions for production wiring (from ADR 0003 Consequences).**
The Adapter must not be wired into production until an empirical spin-up confirms three facts:
(a) repo-committed hooks (`hooks/hooks.json` substrate) fire during a cloud Routine session,
(b) `autopilot.jsonl` + STATE.md writes survive ephemeral-clone reclamation via a `claude/`-prefixed
branch commit, and (c) the per-account daily run cap is quantified.

**This session (deep-3 / #485).**
The operator does NOT have Routines access in this session. This document is the RESEARCH-ONLY
artifact: a complete test plan and observation framework, status `PENDING-EMPIRICAL`. Live empirical
execution is deferred until Routines access becomes available.

---

## 2. Verified Anthropic Routines Status (as of 2026-05-19)

Source: https://code.claude.com/docs/en/routines (verified 2026-05-19)

### 2.1 Status & Plans

> *"Routines are a research preview feature in Claude Code. Behavior, limits, and the API surface
> may change."*

Available on: Pro, Max, Team, Enterprise — with Claude Code on the web enabled. Team and Enterprise
admins can disable Routines globally for their organization.

### 2.2 Billing Model

Routines draw down subscription usage identically to interactive sessions. Each fire consumes from
the per-account monthly allowance. A per-account daily run cap exists; the exact number is not
published in the docs and is visible only at `claude.ai/code/routines` or
`claude.ai/settings/usage`. One-off manual fires are exempt from the daily cap but still consume
subscription usage. Overage requires usage credits.

### 2.3 Trace Artifact + Green-Status Caveat

Each Routine fire produces a full Claude Code session transcript, accessible via a URL in the run
list. The caveat is load-bearing for the test plan:

> *"A green status in the run list means the session started and exited without an infrastructure
> error. It does not mean the task in your prompt succeeded."*

Operators must read the transcript to verify task success. Automated correctness assertions are
not available in the current surface.

### 2.4 Hook Firing In-Cloud

**CONFIRMED by docs.** Repo-committed `.claude/settings.json` hooks (including `hooks/hooks.json`)
and repo-declared plugins clone into the ephemeral environment. The cloud-config carry-over table
at https://code.claude.com/docs/en/claude-code-on-the-web confirms:
- `.claude/settings.json` hooks → **"Yes → Part of the clone"**
- Repo-declared plugins → **"Yes → Installed at session start from the marketplace"**

Critical constraint: *only* committed hooks run. User-level `~/.claude/*` hooks do NOT carry over.
The `hooks/hooks.json` destructive-guard substrate (`pre-bash-destructive-guard.mjs`,
`enforce-scope.mjs`, `enforce-commands.mjs`) is therefore preservable in-cloud — this is the
load-bearing fact for the Adapter verdict.

### 2.5 Stop-Condition Primitive

**DOES NOT EXIST.** Verbatim from the docs:

> *"Routines run autonomously as full Claude Code cloud sessions: there is no permission-mode picker
> and no approval prompts during a run."*

No max-iteration cap, no max-turn cap, no per-run budget gate, no halt-on-condition expression, no
STOP signal from within the Routine script. The single hard bound is the per-account daily run cap.
This absence is the load-bearing gap for the one-bounded-session-per-fire constraint in ADR 0003.

### 2.6 Triggers

Three types:
- **Scheduled** — minimum 1-hour interval between fires (not 1-minute like `/loop`).
- **API** — bearer token; trigger via web UI or direct HTTP with header
  `anthropic-beta: experimental-cc-routine-2026-04-01`. The `/fire` endpoint returns
  `{ type: "routine_fire", claude_code_session_id, claude_code_session_url }`.
- **GitHub** — PR and release events with configurable filters.

### 2.7 Repo Access

Routines perform a fresh clone from the default branch on every fire. Commits default to
`claude/`-prefixed branches. Unrestricted push to arbitrary branches requires a per-repo opt-in
toggle: **Allow unrestricted branch pushes** (disabled by default).

### 2.8 Environment / Network

Default network policy = "Trusted" — a curated allowlist of package registries, cloud providers,
and dev domains. Requests to non-allowlisted hosts return `403 x-deny-reason: host_not_allowed`.
Custom network policies are not documented in the current surface.

### 2.9 Connectors

All connected MCP connectors are included by default. Connectors execute without permission prompts
during a Routine session — writes included. This is a material difference from interactive sessions
where per-write approval is available.

---

## 3. Empirical Hypotheses

Stated for a FUTURE empirical run when Routines access is available.

**H1 — Hook firing.** A Routine fire with `hooks/hooks.json` registering `pre-bash-destructive-guard.mjs`
and `enforce-scope.mjs` will trigger those hooks during the cloud session, producing observable hook
output in the transcript.

**H2 — Telemetry durability.** A Routine fire that runs `/autopilot --dry-run` and writes
`.orchestrator/metrics/autopilot.jsonl` will commit that JSONL to a `claude/`-prefixed branch
BEFORE environment reclamation, AND that branch will be visible on origin after the run ends.

**H3 — Daily-cap quantification.** Firing 10-15 sequential trivial Routines via API will surface
the per-account daily-run cap (HTTP 429 or equivalent) — capturing the exact number for ADR 0003.

**H4 — Hook input contract.** The `claude-code` cloud environment matches the local hook input
contract: PreToolUse, PostToolUse, and Stop events fire with the same JSON shape as local sessions,
making the committed hook scripts correct without modification.

---

## 4. Test Plan

**FUTURE-EXECUTION** — execute when Routines access becomes available. Steps are copy-paste-ready.

### 4.1 Setup Phase

1. Visit `claude.ai/code/routines` and connect the Anthropic account to the GitHub repo
   `github.com/Kanevry/session-orchestrator`.
2. Verify **Allow unrestricted branch pushes: OFF** (default — do not change for this test).
3. Verify Connectors are set to default (no custom MCP connectors added).
4. Confirm `.claude/settings.json` and `hooks/hooks.json` are committed to the default branch
   (they are as of deep-3 / commit `a061b92`).
5. Note the current daily-run cap counter at `claude.ai/settings/usage` (baseline reading).

### 4.2 Trivial Routine Spec (H1 + H2)

Create this Routine via the web UI:

```json
{
  "name": "session-orchestrator-empirical-h1-h2-2026-05-19",
  "description": "deep-3 W3 P3 empirical: verify in-cloud hook firing + claude/ branch telemetry durability",
  "repositories": ["github.com/Kanevry/session-orchestrator"],
  "connectors": [],
  "prompt": "Run exactly one /autopilot --dry-run iteration. Do NOT modify any source file. After dry-run, verify .orchestrator/metrics/autopilot.jsonl was written, then commit it to claude/empirical-h1-h2 branch with message 'chore(autopilot): durable telemetry empirical fire'. Push the branch. Then /close and exit.",
  "triggers": [{"type": "api", "frequency": "manual"}]
}
```

### 4.3 H1 + H2 Observation Phase

1. Fire via web UI or API — capture `claude_code_session_url` from the response:
   ```bash
   curl -X POST https://api.anthropic.com/v1/routines/<routine_id>/fire \
     -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
     -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
     -H "Content-Type: application/json"
   ```

2. Wait for completion. **Read the full transcript** — do NOT rely on green-status (Section 2.3).
   - H1: search for `pre-bash-destructive-guard` and `enforce-scope` in hook output sections.
   - H2: search for `claude/empirical-h1-h2` branch push confirmation.

3. Verify branch on origin:
   ```bash
   git fetch origin && git branch -r | grep empirical-h1-h2
   git log origin/claude/empirical-h1-h2 --oneline -3
   ```

4. Record in `.orchestrator/research/routines-h1-h2-results.jsonl`:
   ```json
   {"timestamp":"<ISO>","hypothesis":"H1","observation":"<text>","verdict":"pass|fail|partial","evidence_url":"<transcript URL>"}
   ```

### 4.5 Daily-Cap Measurement (H3)

1. Note the usage counter at `claude.ai/settings/usage` before starting.
2. Fire 15 sequential trivial Routines via API (1-minute spacing):
   ```bash
   for i in $(seq 1 15); do
     echo "Fire $i at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
     curl -X POST https://api.anthropic.com/v1/routines/<trivial_routine_id>/fire \
       -H "anthropic-beta: experimental-cc-routine-2026-04-01" \
       -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
       -H "Content-Type: application/json" \
       -w "\nHTTP %{http_code}\n"
     sleep 60
   done
   ```
   The trivial Routine prompt: `"Echo 'empirical h3 fire ${i}' and exit immediately."`

3. Observe: first HTTP 429 response (or web-UI block message) reveals the cap number.
4. Capture: cap number, full error message text, reset window (hourly vs daily).
5. Record in `.orchestrator/research/routines-h3-cap-results.json`:
   ```json
   {"measured_at":"<ISO>","fires_before_cap":<n>,"error_message":"<text>","reset_window":"<text>"}
   ```

### 4.6 H4 Hook Input Contract Observation

During H1 execution, capture a hook invocation payload from the transcript and compare the JSON
shape of PreToolUse / PostToolUse / Stop events against the local format in `hooks/hooks.json`.
Any schema divergence = H4 PARTIAL or FAIL.

---

## 5. Verdict Criteria

### Per-Hypothesis

| Hypothesis | PASS | PARTIAL | FAIL |
|---|---|---|---|
| H1 Hook firing | Hook output lines for both `pre-bash-destructive-guard` and `enforce-scope` visible in transcript | Only one hook fires, or fires on subset of expected events | No hook output observed; hook invocation absent from transcript |
| H2 Telemetry durability | `claude/empirical-h1-h2` branch present on origin, JSONL committed, readable | Branch present but JSONL absent or empty | Branch not pushed; ephemeral clone reclaimed before commit |
| H3 Daily-cap | Exact cap number captured, reset window confirmed | Cap hit but error message incomplete | No rate-limit response observed in 15 fires |
| H4 Hook input contract | PreToolUse / PostToolUse / Stop JSON shape identical to local | Minor schema delta (extra fields) — scripts still run | Breaking schema delta — hook scripts would fail on cloud events |

### Overall Readiness

- **PROD-READY:** H1 PASS + H2 PASS + H4 PASS. Flip `durable-telemetry.mjs` to `enabled: true`, set Session Config `routines-adapter: true`, file issue to promote.
- **CONDITIONALLY-READY:** H1 PASS + H2 PARTIAL. Fix telemetry commit path before wiring. Do not flip `enabled: true` until H2 is PASS.
- **NOT-READY:** H1 FAIL or H4 FAIL. ADR 0003 Adapter path is closed. Re-file as won't-do. `/loop` + local `runLoop` stays the only production path.

---

## 6. Stop-Condition Watch

**Watch condition.** Re-evaluate ADR 0003 if Anthropic ships ANY of the following in the Routines
surface:

- Halt-on-condition expression language (e.g., `halt_on: "confidence < 0.5"` in the Routine config)
- Max-iteration cap (e.g., `max_iterations: 3` on the run config)
- Max-turn cap within a single session (per-session token or step budget gate)
- Per-run budget gate — a pre-execution check that blocks fire when quota would be exceeded, not
  just a post-hoc usage page
- An explicit STOP signal emittable from within the Routine script that halts the session cleanly

**Impact if shipped.** A verified stop-condition primitive is the ONLY evidence that would upgrade
the ADR 0003 verdict from one-bounded-session-per-fire toward a guarded multi-iteration cloud loop
(the issue #438 "attractive if…" case). ADR 0003 explicitly gates this:

> *Re-open ADR 0003 only on positive empirical evidence. Do not re-litigate on docs speculation.*

Upgrading to a guarded multi-iteration path would require: (a) the primitive ships and is
documented with clear semantics, (b) the empirical tests in Section 4 pass, and (c) a separate ADR
amendment is filed with the spiral-detection wiring design.

**Watch cadence.** Quarterly (every 90 days). Check https://code.claude.com/docs/en/routines for new sections under "Limits & quotas" or "Run control". Absence of those headings as of 2026-05-19 is the baseline. Append entries to Section 7 as the watch progresses.

---

## 7. Watch Log

| Date | Finding | Next Check |
|---|---|---|
| 2026-05-19 | Initial check. NO stop-condition primitive present in docs. No "Limits & quotas" or "Run control" section. Watch baseline established. | 2026-08-19 |

---

## 8. Current Session Status

**Status:** `PENDING-EMPIRICAL`

The operator does not have Routines access in deep-3 (2026-05-19). This document is the
research-only artifact for #485 Tasks 1 + 3. Live empirical execution is deferred to a future
session when Routines access becomes available.

**Framework code already shipped (W2 I5):**
`scripts/lib/autopilot/durable-telemetry.mjs` — inert (`enabled: false`). H1 PASS + H2 PASS + H4 PASS is the gate for flipping `enabled: true` and wiring the Session Config `routines-adapter` flag.

**Next action when Routines access is available:**
1. Execute the test plan in Section 4 (setup → H1/H2 fire → H3 cap → H4 schema check).
2. Record results in `.orchestrator/research/routines-h1-h2-results.jsonl` and `routines-h3-cap-results.json`.
3. Update Section 5 verdict rows and Section 7 watch log with actual observations.
4. If PROD-READY: file issue to wire `durable-telemetry.mjs` (`enabled: true`) and update ADR 0003.
5. If NOT-READY: file issue to close the Adapter path as won't-do and update ADR 0003.
