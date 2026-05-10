# ADR-365 — MCP / tool-adapter debugging guideline

- **Status:** proposed
- **Date:** 2026-05-10
- **Issue:** #365
- **Author:** session main-2026-05-10-deep-1 W2 B2

## Context

Session-orchestrator increasingly relies on MCP servers and MCP-shaped adapters at runtime. `.mcp.json` already wires a `session-orchestrator` stdio server (single entry, dispatches via `scripts/mcp-server.sh`), and `hooks/hooks.json:32–46` matches `mcp__.*` tool names through the destructive-guard + scope-enforcement chain. Contributors that need to add a new tool, change a tool schema, or diagnose a flaky tool call today have **no documented inner loop**. The closest reference, `skills/mcp-builder/SKILL.md`, covers greenfield server design (research → implementation → eval), but says nothing about *debugging an existing wired tool* — no list-tools recipe, no restart story, no raw-JSON-from-CLI workflow.

The internal codebase audit (W1-A4 §4 + W1-A6) made the gap concrete:

- `scripts/lib/tool-adapter.mjs` does **not exist**. There is no shared place to land tracing, retry, or fallback routing for tool invocations.
- No MCP health check at session-start. A broken `.mcp.json` server surfaces only when the user tries to call a tool mid-wave.
- No tool-error classification. Failures get logged into `events.jsonl` as opaque tool-name + outcome strings, no structured cause field.
- All hook handlers run with a uniform 5s timeout (W1-A6 cross-cutting gap §2). Debug-heavy tool inspections (e.g. `list-tools` against a server that warms up models on first request) blow past it without a per-hook override.

reloaderoo (`cameroncooke/reloaderoo`, MIT, Node 18+, no peer deps — W1-A4 §1) directly answers the contributor-loop side of this gap with two stateless modes: `inspect` (one-shot CLI: `server-info`, `list-tools`, `call-tool --params <JSON>`, `ping`, `list-resources`, `get-prompt`) and `proxy` (transparent stdio MCP proxy that auto-injects a `restart_server` tool so a connected client can hot-reload the wrapped server without losing its session). Zero-install via `npx reloaderoo …` makes adoption a documentation move, not a dependency move.

This ADR records the contributor-facing standard. Implementation work — a new `skills/mcp-debug/` skill, a `scripts/lib/tool-adapter.mjs` abstraction, and a per-hook timeout override in `hooks/hooks.json` — is **deferred to follow-up issues** so this ADR stays focused on the question the spike was asked to answer: "adopt, adapt, or inspire?"

## Decision

### 1. Adopt reloaderoo as the canonical MCP debug tool

**Verdict: ADOPT directly.** Document `npx reloaderoo proxy` and `npx reloaderoo inspect` as the standard inner loop for any contributor working on MCP servers exposed by — or consumed by — session-orchestrator.

Justification (W1-A4 §1, §3):

- Zero-install (`npx`), MIT-licensed, no transitive peer deps. Adding it as a *recommendation* costs us nothing and contributors cannot accidentally bake a runtime dependency on it.
- Satisfies all three issue-#365 acceptance criteria: **inspectable** (`list-tools` / `call-tool` / `ping` over CLI), **restartable** (`proxy` mode injects `restart_server`), **raw-JSON-testable** (`--quiet` flag emits parseable JSON for CI / agent evals).
- Mature upstream — stable command surface, semver-tagged releases — which makes adapt/vendor unnecessary.

**Known caveat: Claude Code manual schema refresh (W1-A4 §2 open-question §1).** When `restart_server` is used through the proxy and the server's tool list changes shape (added/removed tool, changed Zod schema), Claude Code does not auto-re-discover capabilities. The contributor must trigger a manual refresh. Document the workaround in the follow-up `mcp-debug` skill: *(a) keep restarts that change the schema rare during a single Claude Code session, (b) when unavoidable, run `/restart` or close+reopen the session before exercising the new tool*. Cursor and the MCP Inspector are not affected.

### 2. New skill: `skills/mcp-debug/SKILL.md` (deferred to follow-up issue)

Propose a new skill, sibling to `skills/mcp-builder/`. **Out of scope for this ADR's writes** — the implementation lands in a separate issue. Outline the contents now so the follow-up has a contract:

- **When to use** — debugging an already-wired MCP tool, before opening a bug or changing schemas.
- **Recipes** — `npx reloaderoo inspect server-info -- <cmd>`, `… list-tools --quiet -- <cmd>`, `… call-tool <name> --params '<json>' -- <cmd>`, `… ping -- <cmd>`.
- **Hot-reload loop** — `npx reloaderoo proxy --max-restarts 10 --restart-delay 500 -- <cmd>`, with notes on when to use `--no-auto-restart`.
- **Troubleshooting** — Claude Code schema-refresh limitation; env-var precedence (W1-A4 open-Q §4); `--working-dir` for repo-rooted servers.
- **CI usage** — `--quiet` JSON in scripts, exit-code conventions.

mcp-builder stays the *authoring* skill; mcp-debug becomes the *operating* skill. No edits to mcp-builder are required for this ADR.

### 3. Tool-adapter seam (deferred — separate issue)

`scripts/lib/tool-adapter.mjs` is the right home for tracing, retry, and fallback routing across every tool invocation, but **building it is out of scope for this ADR**. Record the design surface so a follow-up issue can pick it up:

```ts
// scripts/lib/tool-adapter.mjs (proposed surface)
inspectTool(server, tool)            // → schema + annotations, structured
callTool(server, tool, params)       // → { ok, data?, error?: { code, retryable } }
restartServer(server, opts?)         // proxy-mode hot-reload
healthCheck(server)                  // ping with timeout, classified result
```

Implementation MUST log every invocation to `.orchestrator/metrics/events.jsonl` with at minimum `{ts, tool_name, server, outcome, duration_ms, error_code?}`. This finally turns the opaque tool-name strings noted in W1-A6 §A6 into something queryable.

### 4. Per-hook timeout override in `hooks/hooks.json` (deferred — separate issue)

W1-A6 cross-cutting gap §2: all hook handlers run with a uniform 5s timeout. Debug-heavy tool inspections (especially `inspect server-info` against a server that initialises a model client on first request) reliably exceed that. Record the recommendation here so it isn't lost:

- Extend the hooks.json schema with an optional per-hook `timeout` override (already partially honoured: `on-session-start.mjs` already declares `timeout: 5`, the field exists, only its uniformity is the problem).
- For hooks that wrap MCP tool inspection or call-tool, allow `timeout: 30`.
- Land this together with the tool-adapter so the timeout has something to protect.

No edits to `hooks/hooks.json` in this ADR.

## Standards (the actual guideline)

**Scope.** These rules cover MCP **tools**. Resource and prompt debug standards (`list-resources`, `read-resource`, `list-prompts`, `get-prompt`) are deferred to a follow-up annex once we have a consumer for them.

These are the rules that become the contract once the follow-up issues land. Each rule is implementable as written:

- **MCP-DBG-1.** Every MCP server registered in `.mcp.json` MUST be inspectable via `npx reloaderoo inspect server-info -- <command>` from a clean `cwd`. *Rationale:* satisfies issue-#365 acceptance #1; gives contributors a no-Claude-required smoke test.
- **MCP-DBG-2.** Every MCP server MUST expose at least one `list-tools` response that survives `npx reloaderoo inspect list-tools --quiet -- <command> 2>/dev/null | grep -v "^Error:" | jq -e '.tools | length > 0'`. *Rationale:* a server that lists zero tools is silently broken; the stderr-redirect + `grep -v "^Error:"` filter survives the `--quiet` stdout-warning quirk documented in MCP-DBG-13 (B6 probe 2).
- **MCP-DBG-4.** Hot-reload during local development uses `npx reloaderoo proxy -- <server-cmd>`, never a hand-rolled wrapper. *Rationale:* one supported path; keeps the `restart_server` contract identical across contributors.
- **MCP-DBG-5.** When a tool's input/output schema changes, the contributor MUST restart the Claude Code session (not just `restart_server` through the proxy) before exercising the new shape. *Rationale:* documents the W1-A4 §2 manual-refresh caveat as a rule rather than tribal knowledge.
- **MCP-DBG-6.** A new MCP tool ships with at least one verified `npx reloaderoo inspect call-tool <name> --params <JSON> -- <command>` example pasted into the tool's authoring PR description. *Rationale:* addresses issue-#365 acceptance #3 ("ein lokales Beispielkommando verifiziert einen Adapter ohne vollwertigen Client").
- **MCP-DBG-7.** Failure paths in tool handlers MUST surface an `error.code` from a closed enum (`AUTH`, `INPUT`, `RATE_LIMITED`, `UPSTREAM`, `TIMEOUT`, `INTERNAL`). *Rationale:* enables the tool-adapter seam's retry/fallback layer and downstream alerting; mirrors `backend.md` SaaS error conventions.
- **MCP-DBG-8.** Hook handlers wrapping MCP inspection/call-tool MUST be allowed `timeout: 30` (vs. the default 5s) once the per-hook override lands. *Rationale:* removes the false-positive timeouts called out in W1-A6 cross-cutting gap §2.
- **MCP-DBG-9.** The session-orchestrator MCP server's tool list MUST be inspected in CI via the following pipeline on every PR that touches `scripts/mcp-server.sh` or anything it sources:

  ```bash
  npx reloaderoo inspect list-tools --quiet -- bash scripts/mcp-server.sh \
    2>/dev/null \
    | grep -v "^Error:" \
    | jq -e '.tools | length > 0'
  ```

  *Rationale:* turns "did I break the wire-up?" from a runtime discovery into a pre-merge gate. The `2>/dev/null` redirect drops the benign "Server does not support completions" stderr warning; the `grep -v "^Error:"` line filter strips the same warning when it leaks onto stdout under `--quiet` (B6 probe 2 — `--quiet` collapses streams). `jq -e` exits non-zero on `false`/`null`, so an empty tools list correctly fails the gate.
- **MCP-DBG-10.** No vendored copy of reloaderoo. Always invoke via `npx`. *Rationale:* keeps the dependency surface zero; pins us to upstream's lifecycle. (Cross-ref MCP-DBG-14: pin the *version* even though the binary is not vendored.)
- **MCP-DBG-11.** Use `--working-dir` (or `-w`) on every `inspect`/`proxy` invocation that depends on repo-relative paths. *Rationale:* prevents subtle "works on my laptop" failures when the contributor's shell `cwd` differs from the server's expected root.
- **MCP-DBG-12.** Health checks MUST use `npx reloaderoo inspect server-info -- <command>` (presence of a non-empty `protocolVersion` field = healthy), NOT `npx reloaderoo inspect ping`, until our MCP server upgrades past protocol `2024-11-05`. *Rationale:* B6 probe 2 confirmed `mcp-server.sh` returns `MCP error -32601: Method not found: ping` because protocol `2024-11-05` predates the ping spec. `server-info` is the equivalent reachability signal that the current handshake actually supports. Re-evaluate this rule when the server's `protocolVersion` is bumped (track via MCP-DBG-9 CI gate output).
- **MCP-DBG-13.** Scripted `--quiet` consumers (CI gates, automation, agent eval harnesses) MUST redirect stderr (`2>/dev/null`) AND tolerate non-JSON warning lines on stdout via a leading `grep -v "^Error:"` filter, until upstream reloaderoo fixes the stream-split bug. *Rationale:* B6 probe 2 documented that `--quiet` collapses stderr warnings onto stdout instead of suppressing them; an unfiltered `jq` on the raw stdout fails on the warning line before reaching the JSON payload. This rule formalises the workaround so MCP-DBG-9 and any `call-tool` automation are reproducibly green. Remove the filter once the upstream bug is closed and reloaderoo is bumped per MCP-DBG-14.
- **MCP-DBG-14.** Pin reloaderoo to `~1.1.5` everywhere it is invoked: (a) all `npx reloaderoo …` examples in `skills/mcp-debug/SKILL.md` MUST use `npx --yes reloaderoo@~1.1.5 …` (or the equivalent `npx reloaderoo@~1.1.5 …` once a lockfile-backed devDependency exists); (b) CI invocations MUST add `reloaderoo` to `devDependencies` with the exact `~1.1.5` pin so `pnpm-lock.yaml` governs the binary actually executed by the MCP-DBG-9 gate. Bump intentionally — a version bump MUST re-validate MCP-DBG-1 through MCP-DBG-13 (especially MCP-DBG-12 + MCP-DBG-13, which are version-coupled to upstream behaviour) before landing. *Rationale:* the standards target reloaderoo's *current* CLI surface and the documented `--quiet` quirk. An unpinned `npx reloaderoo` would silently float to a future release that fixes (or shifts) those quirks, breaking the gate either way.

### Future Standards (deferred)

- **MCP-DBG-3 (deferred until OQ-6 resolves).** Every tool-adapter integration MUST log invocations with `{tool_name, server, outcome, duration_ms}`. The destination — `.orchestrator/metrics/events.jsonl` (overload existing file) vs. a new `tool-invocations.jsonl` (separate stream) — is gated on OQ-6 below. Promoted out of this annex once OQ-6 has a verdict; until then, tool-adapter implementers SHOULD emit the fields and route them to a temporary location their PR proposes. *Rationale:* standardising a path now would either lock us into an overloaded events.jsonl (already 1,425 lines, no retention policy — B6 probe 4) or pre-empt the cross-spike events.jsonl retention discussion (cross-connections doc).

## Open questions

1. ~~Should we publish the session-orchestrator MCP server through reloaderoo proxy by default in dev mode?~~ **Resolved:** opt-in via `SESSION_ORCH_MCP_PROXY=1`, never default-on. Default-on adds a process hop and a moving part to every dev session for a debugging convenience that contributors can flip on themselves; the cost-benefit doesn't pencil out. Document the opt-in env var in the follow-up `mcp-debug` skill alongside the proxy recipes.
2. What is the cost in tokens of a Claude Code manual schema refresh after `restart_server` (W1-A4 open-Q §1)? If it's small, MCP-DBG-5 can soften from "restart session" to "trigger refresh"; if it's large, the rule stays strict.
3. Does `reloaderoo`'s `--max-restarts` reset on `proxy` re-launch, or persist across invocations within the same shell (W1-A4 open-Q §2)? Determines whether MCP-DBG-4 needs a "reset between debugging runs" sub-rule.
4. Are reloaderoo's `list-resources` / `read-resource` / `list-prompts` / `get-prompt` modes feature-complete enough to drop the MCP Inspector entirely (W1-A4 open-Q §3), or do we keep both in the docs?
5. What is the right env-var precedence for an MCP server invoked via `npx reloaderoo proxy -- bash scripts/mcp-server.sh` (W1-A4 open-Q §4)? Specifically: `CLAUDE_PLUGIN_ROOT` is set inside `.mcp.json`'s shell pipeline but not in a fresh contributor terminal — do we document a sourcing pattern, or set defaults inside `mcp-server.sh`?
6. **(Gates MCP-DBG-3 — see Future Standards.)** Should tool-adapter invocation logging extend to a new file (`tool-invocations.jsonl`) instead of overloading `events.jsonl`, given B6 probe 4 (events.jsonl at 1,425 lines / 184 KB with no retention policy)? Owner: cross-spike cross-connections doc, in coordination with the cluster-level events.jsonl retention question. MCP-DBG-3 promotes out of the Future Standards annex once this is decided.

## Risks

- **R1 — Claude Code schema-refresh limitation (W1-A4 §2).** Contributors who don't read MCP-DBG-5 will hit confusing behaviour where `restart_server` succeeds but the new schema isn't visible. *Mitigation:* surface the rule in the new `mcp-debug` skill's "Troubleshooting" section as the first FAQ entry; cross-link from `mcp-builder/SKILL.md` Phase 2.3 (Annotations) once the follow-up lands.
- **R2 — MCP version drift breaks `reloaderoo inspect`.** A future MCP spec revision could change handshake / capability framing in a way reloaderoo lags on. *Mitigation:* MCP-DBG-9 in CI catches it pre-merge; if reloaderoo blocks an upgrade, fall back temporarily to `@modelcontextprotocol/inspector` and revisit MCP-DBG-4.
- **R3 — Upstream abandonment.** reloaderoo is one maintainer; bus factor = 1. *Mitigation:* the rules are written against the *behaviour* (inspect, list-tools, call-tool, ping, restart), not the binary. If reloaderoo goes dark, swap to a fork or to `@modelcontextprotocol/inspector` CLI mode without rewriting the standards. **Concrete fork-or-swap runbook:**
  1. **Trigger conditions** (any one): no commits to `cameroncooke/reloaderoo` for 90+ days AND open security advisory; OR an MCP protocol bump that reloaderoo cannot inspect (MCP-DBG-9 gate red against unmodified server); OR npm `reloaderoo` package is unpublished/yanked.
  2. **Primary swap target:** `@modelcontextprotocol/inspector` CLI mode. Verify equivalent commands exist for `server-info`, `list-tools`, `call-tool`. Update MCP-DBG-1, -2, -6, -9 invocations; keep the standards' rule numbers and rationale intact (rules describe behaviour, not the binary).
  3. **Fork fallback** (if Inspector CLI cannot cover `--quiet` JSON for CI): fork `cameroncooke/reloaderoo` to the `Kanevry/` org, pin `devDependencies` to the fork tarball URL, and document the fork's maintenance scope (CI-blocking bugs only, not feature work).
  4. **Re-validation:** run MCP-DBG-1 through MCP-DBG-13 against the swapped binary before flipping CI; bump the version pin in MCP-DBG-14 to match the new tool's semver.
  5. **Rule updates:** re-evaluate MCP-DBG-13 (the `--quiet` quirk is reloaderoo-specific; Inspector CLI may not need the workaround) and MCP-DBG-12 (ping support depends on the new tool's protocol version handling).
- **R4 — Per-hook timeout override increases hook latency tail.** Allowing `timeout: 30` on debug-heavy hooks (MCP-DBG-8) lets a misbehaving server stall a session for 30s instead of 5s. *Mitigation:* apply the override only to MCP/tool-adapter hooks; pair with the destructive-command guard so an override + abuse can't combine into something silently destructive.

## Cross-references

- **ADR-364 (`docs/adr/2026-05-10-364-remote-agent-substrate.md`) — managed-agent dispatchers route through this seam.** The proposed `scripts/lib/tool-adapter.mjs` (Decision §3 — "Tool-adapter seam") is the *single* dispatch surface for both local-direct tool calls and managed-agent → MCP tool calls. Per ADR-364, any managed-agent substrate that emits MCP-shaped tool invocations MUST route through this adapter, not invent a parallel one. This keeps tracing (MCP-DBG-3, once promoted out of Future Standards), retry classification (MCP-DBG-7's closed `error.code` enum), and timeout policy (MCP-DBG-8) consistent across both call paths. Adapter implementation is gated on ADR-365 follow-up issues; ADR-364 consumes the seam, does not duplicate it.
- **PRD-366 (`docs/prd/2026-05-10-366-stop-hook-verification-loop.md`) — hooks.json timeout coordination.** PRD-366's Phase 1 bumps the uniform Stop+SubagentStop timeout from 5s to 65s. ADR-365's MCP-DBG-8 (per-hook `timeout: 30` for MCP inspection hooks) is an additive, non-overlapping schema extension layered on top in a separate follow-up — both spikes touch `hooks/hooks.json` but at different keys, so the order is: PRD-366 uniform bump first, ADR-365 per-matcher override second.
- **Cross-connections doc (`docs/adr/2026-05-10-spike-cluster-cross-connections.md`) — Session Config blocks.** **ADR-365 introduces no Session Config keys** (this ADR is docs-only — standards + a proposed skill + a proposed adapter file, all gated on follow-up issues). The cross-connections doc therefore MUST drop any `mcp-debug.*` ownership claim from its Conflict-avoidance rules. If a future MCP-debug feature does need a config block (e.g. `mcp-debug.timeout-overrides`, `mcp-debug.default-version`), it will land in a separate ADR that explicitly registers the block under cross-connections rule 1 at that time.

## Verdict summary

| Question | Verdict |
|---|---|
| Adopt reloaderoo as canonical? | YES |
| Create new mcp-debug skill? | YES (follow-up issue) |
| Build tool-adapter abstraction? | DEFER (separate issue) |
| Extend hook-timeout schema? | DEFER (separate issue) |

## Sources

- W1-A4 §1–§3 + open questions — reloaderoo capability matrix, install profile, adoption-tier rationale.
- W1-A4 §2 — Claude Code manual-refresh limitation in proxy mode.
- W1-A6 §A6 (#365 part) — gap inventory: missing `scripts/lib/tool-adapter.mjs`, `.mcp.json` single-server entry, hooks.json `mcp__.*` matchers.
- W1-A6 cross-cutting gap §1 — `events.jsonl` unbounded (86K entries, no retention).
- W1-A6 cross-cutting gap §2 — uniform 5s hook timeout.
- Issue #365 (`spike(devex): MCP/tool-adapter inspection and hot-reload debug loop`) — acceptance criteria and scope.
- reloaderoo upstream — `https://github.com/cameroncooke/reloaderoo` (MIT, Node 18+); npm registry entry `reloaderoo`.
- `.mcp.json` (current) — single `session-orchestrator` server entry via `scripts/mcp-server.sh`.
- `hooks/hooks.json:21–46` — current `PreToolUse` matchers and uniform `timeout: 5`.
- `skills/mcp-builder/SKILL.md` — read-only baseline; this ADR adds an *operating* skill rather than amending the *authoring* skill.

### Findings (no fixes applied per scope rule)

- None on `skills/mcp-builder/SKILL.md`; the file is internally consistent.
