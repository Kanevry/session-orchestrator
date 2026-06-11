# Spike #639 — pi Harness Adapter (earendil-works/pi)

**Date:** 2026-06-11 · **Status:** research **complete**; implementation deferred to issue #639 · **Decides:** whether/how session-orchestrator gains a third harness adapter (pi) at the same support level as Codex CLI and Cursor IDE.

## Goal

Run session-orchestrator under **pi** as a harness, the way it already runs under Claude Code (native) and Codex CLI (installer + hooks-codex.json + agent roles). This spike collects everything needed to scope that adapter: what pi is, what seams it offers, how they map onto our Claude-Code-specific surface, and a phased implementation plan.

## What pi is (key facts)

| Fact | Value |
|---|---|
| Project | Minimal, self-extensible coding agent + harness (CLI, TUI, SDK, RPC) by Mario Zechner |
| Repo | **`earendil-works/pi`** — formerly `badlogic/pi-mono`, transferred 2026-05-07 (old URL redirects) |
| npm CLI | **`@earendil-works/pi-coding-agent`** v0.79.1 (2026-06-09); predecessor scope `@mariozechner/*` deprecated at 0.73.1 but still resolvable (jiti loader aliases old imports) |
| Install | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` → binary `pi` |
| License / activity | MIT · 61.7k stars · created 2025-08, last push 2026-06-11 |
| Docs | <https://pi.dev/docs/latest> (source: `packages/coding-agent/docs/*.md`) |
| Global dir | `~/.pi/agent/` — `settings.json`, `auth.json`, `extensions/`, `skills/`, `prompts/`, `themes/`, `sessions/`, `AGENTS.md`, `SYSTEM.MD` |
| Project dir | `.pi/` — `settings.json`, `extensions/`, `skills/`, `prompts/`, `SYSTEM.md` — **trust-gated** (`defaultProjectTrust: ask\|always\|never`) |
| Monorepo packages | `pi-ai` (multi-provider LLM API), `pi-agent-core` (agent loop), `pi-tui`, `pi-coding-agent` (the CLI) |
| Default tools | `read`, `write`, `edit`, `bash` (+ optional `grep`, `find`, `ls`); system prompt < 1k tokens |
| Philosophy | No built-in MCP (CLI-tools + progressive disclosure instead; `pi-mcp-adapter` package exists), no permission theater (YOLY default, `--approve` flag), file-based state |
| Ecosystem context | Powers OpenClaw; Armin Ronacher's primary harness; `pi-skills` companion repo is cross-harness (Claude Code / Codex / Amp / Droid) |

Full dossier sources at the bottom; UNVERIFIED items flagged inline.

## Existing adapter pattern (what "wie in Claude Code und Codex" means)

Today's multi-harness support is deliberate and thin (see `docs/codex-setup.md`, `docs/cursor-setup.md`):

- **Claude Code (native):** `.claude-plugin/plugin.json` manifest, `hooks/hooks.json` (12 hook event types), 40 skills, 13 typed agents, AUQ/Agent/ToolSearch native tools.
- **Codex CLI:** `scripts/codex-install.mjs` rsyncs the bundle to the Codex plugin store, registers marketplace JSON, upserts `~/.codex/config.toml`. `hooks/hooks-codex.json` + `.codex-plugin/` manifest + 3 agent role definitions. AUQ degrades to numbered Markdown lists.
- **Cursor IDE:** `scripts/cursor-install.mjs` symlinks 9 `.mdc` rules into the target's `.cursor/rules/`. No parallel agents, post-hoc scope enforcement only.

Harness-agnostic and reusable as-is: all 40 skills (SKILL.md), `scripts/parse-config.mjs` + Session-Config parsing, STATE.md/`.orchestrator/` persistence, VCS libs, learnings/memory JSONL, quality gates. The seam variables: `CLAUDE_PLUGIN_ROOT` → `CODEX_PLUGIN_ROOT` → filesystem-walk fallback in `scripts/lib/plugin-root.mjs`; instruction file via `resolveInstructionFile()` (CLAUDE.md wins ties, per `skills/_shared/instruction-file-resolution.md`).

A pi adapter at "Codex level" therefore means: installer + setup doc + hook bridge + AUQ story + README platform-matrix row + tests.

## Feature mapping: Claude Code → pi

| Claude Code surface | pi equivalent | Fit |
|---|---|---|
| Instruction file (CLAUDE.md/AGENTS.md) | pi reads **both natively**, hierarchically (global → ancestors → cwd) | ✅ zero change |
| `## Session Config` via `parse-config.mjs` | plain file read, harness-agnostic | ✅ zero change |
| Skills (SKILL.md, 40×) | **native Agent-Skills-spec support**: frontmatter `name`/`description`/`allowed-tools`/`disable-model-invocation`, progressive disclosure, `/skill:name` commands; load via `~/.pi/agent/skills/`, `.pi/skills/`, `.agents/skills/`, `settings.skills[]`, pi-package `pi.skills` | ✅ near 1:1 (docs even recommend mounting `~/.claude/skills`) |
| Commands (`commands/*.md`, 20×) | **prompt templates**: Markdown + frontmatter (`description`, `argument-hint`), args `$1…$n`, `$@`, `${1:-default}`; load via `.pi/prompts/`, `settings.prompts[]`, package `pi.prompts` | ✅ light transform (arg syntax) |
| PreToolUse hooks (destructive-guard, scope-fence, config-protection…) | extension event **`tool_call`** — can `{ block: true, reason }` and mutate `event.input` | ✅ exact equivalent |
| PostToolUse hooks (post-edit-validate, loop-guard) | **`tool_result`** (result patchable), `tool_execution_start/update/end` | ✅ |
| SessionStart (banner, lock-bootstrap, steering injection) | **`session_start`** (reason: startup/reload/new/resume/fork) + **`before_agent_start`** (inject message, modify system prompt) | ✅ |
| SessionEnd / Stop | `session_shutdown` / `agent_end` | ✅ (no exit-2 blocking semantics; `/goal`-style Stop-blocking would need `agent_end` + re-prompt via `pi.sendMessage`) |
| UserPromptSubmit | `input` event (intercept/transform) | ✅ |
| PreCompact | `session_before_compact` (adjustable/cancelable) | ✅ |
| SubagentStart/Stop + telemetry | **no native subagents** → no native events; depends on chosen subagent strategy | ⚠️ gap |
| AskUserQuestion (AUQ-001) | `ctx.ui.select / confirm / input / editor / notify` + `ctx.ui.custom<T>()`; in RPC mode tunneled as `extension_ui_request`/`extension_ui_response` (works headless) | ✅ |
| Agent tool (wave dispatch, 13 typed agents) | none built-in (deliberate: "sub-agents are a black box"). Options: **`pi-subagents`** / `@gotgenes/pi-subagents` / `pi-crew` packages; SDK `createAgentSession()` (parallel in-process sessions); child procs `pi --mode json -p` | ⚠️ the big design decision |
| ToolSearch / model frontmatter routing | `pi.setActiveTools`, `pi.setModel`, `model_select` event; skills' `model:` frontmatter is advisory | 🟡 partial |
| EnterWorktree/ExitWorktree, CwdChanged | none; `pi-crew` does worktrees (community) | 🟡 degrade (skip Phase 0.5 promotion) |
| TaskCreate/TaskUpdate | none → STATE.md checklists (same as Codex/Cursor) | ✅ existing fallback |
| Monitors / OTel (`experimental.monitors`) | none | 🟡 skip; `.orchestrator/metrics/*.jsonl` telemetry is harness-agnostic anyway |
| Plugin manifest + marketplace | **pi packages**: `pi install npm:<pkg>` / `git:<url>` / local path; `package.json` key `pi: { extensions, skills, prompts, themes }`, keyword `pi-package`; core packages as `peerDependencies "*"` | ✅ cleaner than the Codex rsync store |
| Plugin-root env (`CLAUDE_PLUGIN_ROOT`) | no equivalent env; extension knows its own `import.meta.url`, can export `SO_PLUGIN_ROOT`/`PI_PLUGIN_ROOT` to spawned hook subprocesses | ✅ extend `plugin-root.mjs` chain |
| Headless / autopilot | `-p/--print`, `--mode json` (JSONL events), `--mode rpc` (stdin/stdout commands: prompt, steer, fork, get_state, …), full SDK (`SessionManager`, `DefaultResourceLoader`) | ✅ richer than Claude Code's `-p` |

## Recommended adapter architecture

**Ship the adapter as a pi package** (one `pi install`-able unit), not as an rsync'd store copy:

1. **`package.json` additions** — `pi: { extensions: ["pi/extension/index.ts"], skills: ["skills"], prompts: ["pi/prompts"] }` + keyword `pi-package`. Skills mount as-is; `pi/prompts/` holds the 20 commands with `$@` arg-syntax transforms (generated, not hand-maintained — small build step or transform in the installer).
2. **One TypeScript extension as hook bridge** (`pi/extension/index.ts`): subscribes to `tool_call` / `tool_result` / `session_start` / `before_agent_start` / `session_shutdown` / `input`, **synthesizes the Claude-Code hook JSON payload** and spawns the existing `hooks/*.mjs` as subprocesses (stdin JSON, exit-code contract). This reuses all 12+ hook scripts unchanged — same trick as `hooks-codex.json`, but mechanically richer because `tool_call` can actually block. Env to set for children: `SO_WAVE_AGENT`, `SO_*`, synthesized plugin root.
3. **AUQ adapter**: a small lib that the coordinator-facing skills call; under pi the extension registers a tool (or intercepts) that renders `ctx.ui.select()`. Headless-safe via the RPC UI tunnel.
4. **`scripts/pi-install.mjs`**: thin — verifies `pi` binary, runs `pi install <local path>` or writes `settings.packages[]`, optionally seeds `.pi/settings.json` with `skills`/`prompts` paths for non-package installs. Plus `tests/scripts/pi-install.test.mjs` (mirror codex/cursor smoke-test pattern).
5. **Subagent strategy (decision needed before implementation):**
   - **Option A — depend on `pi-subagents`** (community package; chains, parallel exec, TUI clarification). Fastest; external dependency risk.
   - **Option B — own dispatch via SDK** `createAgentSession()` / child `pi --mode json`: full control, matches wave-executor semantics (typed agents = system-prompt presets from `agents/*.md`), more work.
   - **Option C — degrade to sequential** (Cursor level) for v1.
   - Recommendation: **C for v1, B as the target** — v1 proves skills/hooks/AUQ; wave parallelism is the follow-up once the extension bridge is stable.
6. **Docs**: `docs/pi-setup.md`, README badges + Platform-Support matrix row, update `skills/_shared/instruction-file-resolution.md` (pi reads both CLAUDE.md and AGENTS.md; CLAUDE.md-wins-ties still holds for our own `resolveInstructionFile()`).

### Phased plan

| Phase | Scope | Outcome |
|---|---|---|
| **P0** | Mount skills + prompts via `.pi/settings.json` (no code), verify CLAUDE.md/Session-Config pickup, manual smoke | "session-orchestrator skills run under pi" — hours, zero risk |
| **P1** | Extension hook bridge (`tool_call` destructive-guard + `session_start` banner + `before_agent_start` steering injection) | mechanical guards at parity with Claude Code |
| **P2** | AUQ adapter + session lifecycle (STATE.md writers, locks, session-end flow) + `scripts/pi-install.mjs` + tests + docs | "Codex-level" support; README badge |
| **P3** | Subagent/wave strategy (Option B), telemetry events for SubagentStart/Stop | deep/feature sessions with waves |

## Risks & open questions

- **0.x API stability**: pi is pre-1.0, the extension API can break; the scope/repo rename already happened once (mitigation: pin version in adapter docs, CI smoke against latest).
- **Trust gating**: `.pi/extensions` and `.pi/skills` require project trust — first-run UX needs documenting in `docs/pi-setup.md`.
- **Stop-hook semantics**: pi has no exit-2 "block the stop" contract; `/goal`-equivalents need `agent_end` + `pi.sendMessage(deliverAs: followUp)` emulation — behavioral, not mechanical. Verify in P1.
- **Subagent telemetry**: `subagent-telemetry.mjs` and PSA-006 discovery-validator assume SubagentStop events; under Option B we emit these ourselves from the dispatch lib.
- **UNVERIFIED** (from the research dossier): `.claude/commands` direct compatibility; Anthropic cache-breakpoint handling inside `pi-ai`; current status of `pi-proxy`/`pi-web-ui` under the new scope. None of these block P0–P2.

## Sources

pi docs (repo `packages/coding-agent/docs/`): [extensions](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md) · [skills](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md) · [prompt-templates](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/prompt-templates.md) · [settings](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/settings.md) · [packages](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/packages.md) · [rpc](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/rpc.md) · [sdk](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md) · [session-format](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session-format.md) · [usage](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/usage.md) · [providers](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md) · [json](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/json.md)
· [pi.dev news: "Pi Has a New Home"](https://pi.dev/news/2026/5/7/pi-has-a-new-home) · [pi.dev/packages](https://pi.dev/packages) · [pi-mcp-adapter](https://pi.dev/packages/pi-mcp-adapter) · npm registry (`@earendil-works/pi-coding-agent`, `@mariozechner/pi-coding-agent`) · [mariozechner.at 2025-11-30 (pi announcement)](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) · [2025-11-02 (no-MCP)](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/) · [2026-04-08 (Earendil)](https://mariozechner.at/posts/2026-04-08-ive-sold-out/) · [lucumr 2026-01-31 (Ronacher on pi)](https://lucumr.pocoo.org/2026/1/31/pi/) · [badlogic/pi-skills](https://github.com/badlogic/pi-skills) · [Syntax #976](https://syntax.fm/show/976/pi-the-ai-harness-that-powers-openclaw-w-armin-ronacher-and-mario-zechner/transcript)

Repo-side facts: `scripts/codex-install.mjs`, `scripts/cursor-install.mjs`, `scripts/lib/plugin-root.mjs`, `skills/_shared/instruction-file-resolution.md`, `hooks/hooks.json` / `hooks-codex.json` / `hooks-cursor.json`, `docs/codex-setup.md`, `docs/cursor-setup.md`, README § Platform Support.
