# W1 Research Context — 2026-05-10 Spike Cluster

> Internal session-deliverable. Consolidated briefings from W1 Discovery agents (#364, #365, #366).
> W2 architects/docs-writers MUST cite this file rather than re-fetching sources.

## A1 — VibeTunnel (#364)

**What:** Browser→terminal proxy. Node.js WebSocket server multiplexing PTY sessions to web UI / iOS / CLI clients. Auth via password / SSH keys / Tailscale identity. Repo: `amantus-ai/vibetunnel`.

**Architecture:**
- WebSocket v3 binary protocol (magic `0x5654`, message types: SUBSCRIBE / INPUT_TEXT / RESIZE / KILL / SNAPSHOT_VT / STDOUT)
- Per-session control directory: `~/.vibetunnel/control/<SESSION_ID>/{session.json, stdout, stdin (FIFO), ipc.sock}`
- TerminalManager (HTTP) → WsV3Hub (WS) → PtyManager (native PTY)
- AuthManager: PAM/JWT (24h), SSH Ed25519 challenge-response, Tailscale identity injection

**Adopt:**
1. **Browser-attachable session IDs + WS v3 framing** — for future web-UI surface
2. **On-disk session artifacts** (`session.json + stdout + metadata`) — durable post-execution forensics
3. **Conditional feature visibility** (Follow Mode pattern) — features only appear when meaningful state exists
4. **Snapshot mechanism** for state reconstruction across reconnects

**Reject:**
- Native macOS menu-bar app (we're CLI plugin)
- iOS client (out of scope)
- Multi-tenant RBAC (single-user-per-instance is fine)

**Open Q:** session replay/seek? state recovery on server crash? cross-host identity delegation?

---

## A2 — Crabbox + CodexBar (#364)

### Crabbox
**What:** CLI-driven remote testbox control plane. Brokered architecture: Laptop → Cloudflare Worker (Durable Object) → Cloud (Hetzner/AWS/Azure/E2B/Daytona).

**Adopt:**
1. **Lease/TTL session model** — `/session start` → lease acquire; `/close` → release; auto-cleanup on TTL
2. **Warm-machine concept** → cache dependency installs between sessions (`warmup` analogue)
3. **Cost-cap enforcement** — broker-level spend caps, per-user/org/provider
4. **Stateless runners** — recipients hold no broker secrets; idempotent ops

**Reject:** multi-cloud abstraction, rsync sync, browser VNC.

### CodexBar
**What:** macOS menu-bar quota monitor for 40+ AI providers. Privacy-first credential reuse (OAuth, browser cookies, API keys, local CLI tokens).

**Adopt:**
1. **Quota visibility before long-running waves** — `orchestrator quota --provider claude` CLI
2. **Reset-window-aware scheduling** — defer expensive waves until quota resets
3. **Cost-scoped session tiers** (quick/standard/deep)
4. **Credential multiplexing** — reuse existing provider sessions

**Reject:** menu-bar UI, browser cookie harvesting (security/privacy), macOS-only.

**Cross-cutting:** Crabbox = resource hunger (auto-stop). CodexBar = information hunger (frequent polls). session-orchestrator should adopt **both**: pre-execution quota checks + autopilot auto-cleanup.

---

## A3 — Symphony (#364)

**What:** OpenAI work-item-driven framework (steipete fork). One issue = one Run Attempt. Per-issue isolated workspace + agent. Continuous tracker poller (Linear/GitHub).

**Three-level isolation:**
1. Workspace containment (per-issue dir, sanitized key)
2. Path validation (absolute-path, child of workspace root)
3. Single-authority dispatch (in-memory `claimed` + `running` maps)

**State (in-memory only):** `running`, `claimed`, `retry_attempts`, `completed`, `codex_totals`, `codex_rate_limits`. Reconciliation every poll tick: stall detection (default 5min), state refresh, retry expiry. **No persistent DB** — restart re-polls tracker.

**Kill-switches:** stall-timeout, concurrent-limit, turn-timeout, max-turns. (Our autopilot has 9 — Symphony has 4.)

**Symphony vs our autopilot — key difference:**
| Aspect | Symphony | Our autopilot |
|--------|----------|---------------|
| Model | Continuous service, perpetual poller | Discrete sessions, user-initiated |
| State | In-memory only | STATE.md + sessions.jsonl persistent |
| Recovery | Re-poll from scratch | Resume from last wave |
| Trigger | Tracker state change | `/session` command |

**Adoptable for Phase D (multi-story #341):**
1. **Per-work-item isolation + workspace path validation** → extend `worktree.mjs` with `validateWorkspacePath(computed, root)` (pure)
2. **Single-authority `claimed` + `retry_attempts` maps** in `autopilot-multi.mjs` (NEW)
3. **Stall-timeout reconciliation loop** — sample every 30s, 2-consecutive-strikes-then-kill (NOT one 5min timer; reduces false positives on slow tests)
4. **Proof-of-observability via JSON API** — extend `autopilot.jsonl` with `worktree_path`, `parent_run_id`, `stall_recovery_count`
5. **Hybrid concurrency cap** — static baseline (`multi-story-concurrency: 2`) + resource-probe veto on critical

**Risks:** in-memory state = hard restart recovery; stall-timeout false positives on slow tests; concurrency cap too high → memory exhaustion; cleanup failures → disk fill; tracker API rate limits with N in-flight.

---

## A4 — reloaderoo (#365)

**What:** `cameroncooke/reloaderoo` — dual-mode MCP dev tool. Inspect + Proxy. Node 18+, MIT, no peer deps.

**Modes:**
1. **Inspect** (stateless): `reloaderoo inspect <command> -- <server-cmd>`
   - Commands: `server-info`, `list-tools`, `call-tool <name> --params <JSON>`, `list-resources`, `read-resource <uri>`, `list-prompts`, `get-prompt <name>`, `ping`
   - Useful options: `--quiet` (raw JSON only), `-w/--working-dir`, `-t/--timeout`
2. **Proxy** (stateful): `reloaderoo proxy -- <server-cmd>`
   - Auto-injects `restart_server` tool — agents can self-reload
   - Client (Claude/Cursor) stays connected across restarts; **Claude Code requires manual schema refresh** on capability change (known limitation)
   - Options: `--max-restarts`, `--restart-delay`, `--restart-timeout`, `--no-auto-restart`

**Install:** `npx reloaderoo …` (zero-install, recommended), global, dev-dep.

**Adoption tiers:**
- **Adopt directly** ✓ (RECOMMENDED) — recommend `npx reloaderoo` in `mcp-builder` skill + a new MCP-debug guideline. Zero risk, satisfies all 3 acceptance criteria (inspectable, restartable, JSON-testable).
- Adapt (vendor) — defer; reloaderoo is mature enough to wrap.
- Inspire only — too vague; not single-recommended-path.

**Verdict:** Option A — directly adopt + document.

**Open Q:** schema refresh cost in Claude Code; max-restarts persist or reset; resource/prompt CLI mode coverage; env var precedence.

---

## A5 — Stop-Hook Patterns (#366)

**Anthropic Stop hook contract:**
- Event: `Stop`. Payload: `{session_id, cwd, hook_event_name: "Stop", stop_hook_active: boolean}`
- Exit codes: `0` = allow, `2` = **block** (forces continuation; stderr → Claude context)
- JSON output alternative: `{"decision": "block", "reason": "..."}` (exit 0)
- **Critical safety field:** `stop_hook_active` — if true, you're in a forced-continuation already; **MUST exit 0** to break the loop

**PostToolUse vs Stop vs SubagentStop:**
- **Stop** ✓ for whole-task verification (blockable, fires at completion)
- PostToolUse for per-file micro-validation (cannot block completion)
- SubagentStop for subagent-output verification

**Boris Cherny quotes (verbatim):**
- Every.to: *"You can just make the model keep going until the thing is done."*
- Threads: *"Give Claude a way to verify its work. If Claude has that feedback loop, it will 2-3x the quality of the final result."*
- X (Ralph Wiggum): three strategies — background agent, **agent Stop hook (most deterministic)**, ralph-wiggum plugin

**Cat Wu / DEV Community 3-layer model:**
1. PostToolUse: syntax checks (ESLint)
2. Stop prompt hook: intent verification
3. Stop command hook: regression tests — **block until tests pass**, with `stop_hook_active` guard

**Bounded loop spec:**
- **Iteration cap:** `stop_hook_active` flip = 1-iteration safety gate (ALWAYS exit 0 when true)
- **Wall-time cap:** ≤30s typical; Anthropic default 60s
- **Token budget:** 10–20% verification overhead (community-measured); pair with autopilot TOKEN_BUDGET kill-switch (#355)
- **Failure evidence:** stderr or JSON `reason` MUST capture failure reason BEFORE exit 2

**Risks + mitigations:**
| Risk | Mitigation |
|------|------------|
| Infinite loops | Mandatory `stop_hook_active` check at line 1 |
| Flaky tests | Run 2x; surface flake evidence |
| Destructive cmds | Sandbox in temp dir / git worktree |
| Token burn | Cap iterations + wall-time + alert at 80% |
| Lost failure context | Log to `.orchestrator/metrics/failures.jsonl` BEFORE block |

**Map to our infra:** 10 hook event matchers exist. 9 kill-switches in autopilot. **Gap:** failure-evidence persistence — Anthropic's stderr→Claude transcript model is ephemeral; we need `.orchestrator/metrics/failures.jsonl` per wave/iteration/`stop_hook_active` state.

---

## A6 — Internal Codebase Audit (cross-cutting)

**State files (per-platform):** `.claude/`, `.codex/`, `.cursor/` for STATE.md + wave-scope.json. Shared: `.orchestrator/metrics/` (sessions.jsonl + learnings.jsonl + events.jsonl + autopilot.jsonl + subagents.jsonl).

**Session-record schema** (sessions.jsonl, 82 entries, v1):
```json
{
  "session_id": "main-2026-04-07-1600",
  "session_type": "feature",
  "platform": "claude",
  "started_at": "...", "completed_at": "...",
  "duration_seconds": 5400,
  "total_waves": 5, "total_agents": 11,
  "agent_summary": {"complete": 11, "partial": 0, "failed": 0, "spiral": 0},
  "waves": [{"wave": 1, "role": "Foundation", "agent_count": 2, "files_changed": 4, "quality": "pass"}]
}
```

**Key files for #364:**
- `scripts/lib/session-lock.mjs:1-92` — distributed lock (atomic rename, TTL, PID liveness)
- `scripts/lib/coordinator-snapshot.mjs:1-95` — git stash refs `refs/so-snapshots/<sessionId>/...`
- `scripts/lib/worktree.mjs` (barrel) + submodules — per-agent worktrees
- session-start Phase 1.2 (lock acquire) + 1.5 (snapshot recovery)
- session-end Phase 3.4a (snapshot GC) + Phase 3.8 (lock release)

**Key files for #365:**
- `skills/mcp-builder/SKILL.md` — generic MCP guidance (NOT yet wired to plugin coordination)
- `.mcp.json` — single `session-orchestrator` server entry
- `hooks/hooks.json:24–46` — PreToolUse `mcp__.*` matcher examples
- `scripts/lib/tool-adapter.mjs` — **does NOT exist** (this is the gap)

**Key files for #366:**
- `hooks/hooks.json:60–87` — Stop + SubagentStop handlers (timeout 5s, async: false)
- `hooks/on-stop.mjs:1-80` — current Stop handler. **Always exits 0** (informational only, never blocks). Writes `events.jsonl`. Calls `deregisterSelf()`.
- `scripts/lib/autopilot/kill-switches.mjs:1-100` — 9 kill-switches: pre-iteration (MAX_SESSIONS, MAX_HOURS, RESOURCE_OVERLOAD, LOW_CONFIDENCE, USER_ABORT, TOKEN_BUDGET) + post-session (SPIRAL, FAILED_WAVE, CARRYOVER_TOO_HIGH)
- `scripts/lib/autopilot/loop.mjs` — main `runLoop(args)` driver
- `skills/quality-gates/SKILL.md` — 4 variants (Baseline, Incremental, Full Gate, Per-File). NOT wired to kill-switches yet.

**Cross-cutting gaps:**
1. Events.jsonl is unbounded (86K entries already, no retention policy)
2. Hook timeout is uniform 5s — too tight for debug-heavy tool-adapter (#365)
3. No unified "Session Recovery" mode — three different AUQ flows (stale lock / interrupted session / snapshot)
4. Mission-status enum (`brainstormed|validated|in-dev|testing|completed`) lacks documented mapping to circuit-breaker states (PARTIAL/SPIRAL/FAILED/COMPLETE)
5. Token-budget kill-switch is autopilot-only — manual session with `maxTokens` config doesn't trigger

**Recommended dispatch granularity:**
- #364: **Medium** — managed-agents dispatcher with fallback to local; extend session-record schema with `agent_identity`
- #365: **Medium** — `scripts/lib/tool-adapter.mjs` abstraction + tracing/retry + fallback routing
- #366: **Narrow + half-Medium** — unit tests for all 9 kill-switches + config-driven thresholds (don't unify recovery flows yet)
