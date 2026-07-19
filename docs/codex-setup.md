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

Claude-only events (`SessionEnd`, `PostToolUseFailure`, `PostToolBatch`, and `CwdChanged`) are intentionally absent because Codex 0.144.4 does not expose them as supported project events. Claude Edit/Write payload handlers are also absent: Codex emits canonical `apply_patch` data, while those handlers currently expect Claude's Edit/Write payload shape. They will remain unwired until a real `apply_patch` adapter exists; pretending the payloads are compatible would create false enforcement.

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

Both platforms share session history and learnings through `.orchestrator/metrics/`.

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
