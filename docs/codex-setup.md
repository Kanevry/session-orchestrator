# Codex Setup Guide

Guide for using Session Orchestrator with OpenAI Codex through Codex's public plugin lifecycle.

## Prerequisites

- Codex CLI 0.144.4 or newer
- Node.js 24 or newer
- Git and an initialized project repository
- `plugins` and `hooks` reported as `stable true` by `codex features list`

## Installation

Clone the repository, install its runtime dependencies, and run the installer from the plugin root:

```bash
git clone https://github.com/Kanevry/session-orchestrator.git
cd session-orchestrator
npm install
node scripts/codex-install.mjs
```

The installer validates the local Codex manifest and hook contract, then uses the same public commands an operator can run manually:

```bash
codex plugin marketplace add "$PWD"
codex plugin add session-orchestrator@kanevry
codex plugin list --available --json
```

It operates only through public Codex plugin commands; hook trust remains untouched.

## Understand the Three States

Codex reports three distinct states that must not be conflated:

1. **Marketplace configured** — `kanevry` points at this clone, so the plugin is discoverable. This alone does not install or enable the plugin.
2. **Plugin installed and enabled** — `codex plugin list --available --json` shows exactly one `session-orchestrator@kanevry` entry with `installed: true`, `enabled: true`, and the version from `.codex-plugin/plugin.json`.
3. **Hooks trusted and executing** — after installation, start a fresh Codex task or fully restart Codex, run `/hooks`, review the Session Orchestrator hook bundle, and approve it if appropriate. Hook trust remains operator-controlled; the installer never writes or bypasses it.

## Refresh and Explicit Cache Invalidation

After pulling changes, rerun the installer:

```bash
git pull
npm install
node scripts/codex-install.mjs
```

Every installer run executes `codex plugin marketplace add` and `codex plugin add`, even when the marketplace is already configured. The repeated `plugin add` refreshes Codex's installed bundle from the current clone instead of treating installation as a one-time copy.

The tracked Codex manifest uses a version such as `3.14.0+codex.20260717175716`. The base must match `package.json`; the `+codex.<YYYYMMDDHHmmss>` UTC suffix is the repository's explicit invalidation marker. When a shipped bundle needs a new cache identity, maintainers commit a new timestamp in `.codex-plugin/plugin.json`. The installer validates that committed value and never mutates the tracked manifest.

## Configuration

### Session Config in AGENTS.md

Add a `## Session Config` section to your project's `AGENTS.md`. The format is identical to the Claude Code `CLAUDE.md` config:

```markdown
## Session Config

test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
agents-per-wave: 6
waves: 5
persistence: true
enforcement: warn
vcs: github
```

See `docs/templates/AGENTS-session-config.md` for a complete template.

### Agent Roles

The plugin bundle includes the Codex role definitions under `.codex-plugin/agents/`. Project-level roles under the project's `.codex/agents/` may override or extend them when a repository needs more specialized prompts.

## Hook Surface and Trust

`hooks/hooks-codex.json` declares the curated six-event Codex project subset:

- `SessionStart`
- `PreToolUse`
- `PostToolUse`
- `SubagentStart`
- `SubagentStop`
- `Stop`

The Codex hook command uses Codex's native `${PLUGIN_ROOT}` expansion. The wrapper also exports `CODEX_PLUGIN_ROOT="${PLUGIN_ROOT}"` for shared compatibility code and sets `SO_PLATFORM=codex` so Codex wins when multiple harness variables are present.

Claude-only events (`SessionEnd`, `PostToolUseFailure`, `PostToolBatch`, and `CwdChanged`) are intentionally absent because Codex 0.144.4 does not expose them as supported project events. Claude Edit/Write payload handlers are also absent: Codex emits canonical `apply_patch` data, while those handlers currently expect Claude's Edit/Write payload shape. They will remain unwired until a real `apply_patch` adapter exists; pretending the payloads are compatible would create false enforcement. The same applies to the Bash-payload handlers, including `post-bash-write-verify.mjs` (#942): they gate on Claude's `tool_name === 'Bash'`, which no Codex bridge delivers, so wiring them today would be a silent no-op (the #919-P2 class). These per-event gaps are tracked as documented asymmetries in `scripts/lib/validate/check-hooks-symmetry.mjs` (Check 6, `handlerAsymmetries`) — an UNDOCUMENTED one-platform-only handler now fails validation.

An empty `PreToolUse` or `SubagentStart` array means the event belongs to the validated Codex surface but currently has no payload-compatible handler. It does not mean installation or hook trust failed.

## Usage

After installation and hook review, start a fresh task. Session Orchestrator exposes the shared skill surface, including:

- `/session [housekeeping|feature|deep]` — start a session
- `/go` — execute the agreed plan
- `/close` — end the session with verification
- `/plan [new|feature|retro]` — plan a project or feature
- `/discovery [scope]` — run quality probes
- `/evolve [analyze|review|list]` — manage learnings

## Key Differences from Claude Code

| Aspect | Claude Code | Codex |
|--------|-------------|-------|
| Interactive choices | AskUserQuestion tool | Numbered Markdown lists |
| Agent dispatch | Agent tool | Codex subagents / typed roles |
| State directory | `.claude/` | `.codex/` |
| Config file | `CLAUDE.md` | `AGENTS.md` |
| Task tracking | TaskCreate/TaskUpdate | Text-based checklists |
| Hook root | `$CLAUDE_PLUGIN_ROOT` | native `${PLUGIN_ROOT}` plus `CODEX_PLUGIN_ROOT` compatibility export |
| MCP server root | `$CLAUDE_PLUGIN_ROOT`, injected into the server process | resolved by `.mcp.json` itself — Codex expands no root variable inside `mcpServers.args` and injects none into the MCP child's environment |

Both platforms share session history and learnings through `.orchestrator/metrics/`.

`CODEX_PLUGIN_ROOT` is **session-orchestrator's own compatibility export, not a variable Codex provides.** The hook wrapper in `hooks/hooks-codex.json` assigns it from Codex's native `${PLUGIN_ROOT}` so that shared code (`scripts/lib/plugin-root.mjs`) can read one name on every harness. Nothing outside a hook command string sets it — in particular an MCP server started by Codex inherits neither `CODEX_PLUGIN_ROOT` nor `PLUGIN_ROOT`. That is why `.mcp.json` resolves the plugin root on its own instead of relying on a harness-provided variable: it tries `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `PLUGIN_ROOT`, then `git rev-parse --show-toplevel`, and finally asks Node to resolve the installed `session-orchestrator` package (which reaches `resolvePluginRoot()` and with it the `CURSOR_RULES_DIR` / `PI_PLUGIN_ROOT` roots too). Each candidate must actually contain `scripts/mcp-server.sh` before it is used.

## Platform Limitations

Claude Code dispatches role-specialized agents with dedicated definitions. Codex maps implementation work through its configured roles, so task prompts carry specialization that is not represented by a dedicated role. A project can add more specific TOML definitions under `.codex/agents/` when needed.

Hook enforcement is limited to the validated payload-compatible Codex subset described above. In particular, the absence of Claude-only events and Edit/Write handlers is deliberate rather than an installation workaround.

## Troubleshooting

Start every Codex plugin diagnosis with the public state view:

```bash
codex plugin list --available --json
```

- **Marketplace is configured but the plugin is only available:** run `codex plugin add session-orchestrator@kanevry`, then run the plugin list again.
- **The target is missing, disabled, duplicated, or at the wrong version:** run `codex plugin marketplace list --json`, remove the exact target with `codex plugin remove session-orchestrator@kanevry` when present, and rerun `node scripts/codex-install.mjs` to reinstall and verify it.
- **A `session-orchestrator@openai-curated` or `session-orchestrator@local` installation remains:** these are the only allowlisted legacy IDs. Remove the exact stale ID with `codex plugin remove session-orchestrator@openai-curated` or `codex plugin remove session-orchestrator@local`; unrelated plugins remain untouched.
- **The `kanevry` marketplace points at another source:** confirm the conflict with `codex plugin marketplace list --json`, run `codex plugin marketplace remove kanevry`, then rerun the installer from the intended clone so it performs the public marketplace add and plugin add lifecycle.
- **Plugin is installed and enabled but hooks do not fire:** start a fresh task or fully restart Codex, run `/hooks`, and review the trust state. Installation does not imply hook approval.
- **Other pre-public plugin/config/cache/hook-state residue is suspected:** this state is unsupported. Do not modify private Codex files. File an issue with `codex --version`, `codex plugin list --available --json`, and `codex plugin marketplace list --json` output so the public recovery path can be diagnosed.
- **Agent dispatch fails:** verify Codex multi-agent support and inspect the bundled or project-level role TOMLs.
- **Hooks report that Node is unavailable:** expose Node 24+ on the Codex hook PATH or set `SO_NODE_BIN` to the absolute Node executable.
- **`MCP startup failed: handshaking with MCP server failed: connection closed: initialize response`:** the MCP entrypoint could not locate the plugin, or could not run. Read the server's **stderr** — since GH#64 it names itself. Two diagnostics exist:
  - `session-orchestrator: cannot locate the plugin root` — no plugin-root variable was set, the working directory was outside any git checkout, and Node could not resolve an installed `session-orchestrator` package. This is the common case when Codex is started from `$HOME`. Fix: add `CODEX_PLUGIN_ROOT` (or `CLAUDE_PLUGIN_ROOT`) pointing at the plugin directory to that server's `env` block in your MCP configuration, or start Codex from inside the session-orchestrator checkout. Do not expect Codex to supply the variable — see the note under *Key Differences* above.
  - `session-orchestrator: 'jq' not found in PATH` — the plugin was found but `jq` is missing. Fix: install `jq` and restart Codex. (Before GH#64 this case wrote a JSON-RPC error to *stdout* with `id: null`, which is not a valid `initialize` response either, so a missing `jq` and a missing plugin were indistinguishable from the client side.)
- **The MCP tools answer `Error: not inside a git repository`:** expected, not a failure. The handshake succeeded; `session_config` and `session_metrics` read the *project* you are working in, so they need Codex's working directory to be inside a git repository. Start Codex from the project, or `cd` into it.
