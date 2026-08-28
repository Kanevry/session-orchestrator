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

### Short-Form Marketplace Add (Verified 2026-08-28, codex-cli 0.141.0)

`codex plugin marketplace add --help` documents a short remote form:

```
codex plugin marketplace add owner/repo --ref main
```

Tested against this repo in a scoped throwaway `CODEX_HOME` (2026-08-28, codex-cli 0.141.0):

```
$ codex plugin marketplace add Kanevry/session-orchestrator --json
{
  "marketplaceName": "kanevry",
  "installedRoot": ".../.tmp/marketplaces/kanevry",
  "alreadyAdded": false
}
$ echo $?
0
```

This succeeds and clones the repo via git — no `--ref`/`owner/repo` string is needed beyond the short form; the resulting marketplace name (`kanevry`) is read from `.claude-plugin/marketplace.json`'s `name` field, not from the `owner/repo` argument.

**However**, the subsequent install step fails identically for both this short remote form *and* the long-form local install documented above (`codex plugin marketplace add "$PWD"`, same as `scripts/codex-install.mjs` runs):

```
$ codex plugin add session-orchestrator@kanevry --json
Error: plugin `session-orchestrator` was not found in marketplace `kanevry`
$ echo $?
1
```

`codex plugin list --available --json --marketplace kanevry` returns `{"installed": [], "available": []}` for both forms — the marketplace is configured, but no plugin is discoverable inside it, contradicting item 1 under "Understand the Three States" below. A synthetic marketplace root mirroring this repo's exact layout (`.codex-plugin/plugin.json` directly at root, no `.claude-plugin/marketplace.json`) reproduces the same empty discovery; by contrast, a directory scanned via a `<root>/plugins/<name>/.codex-plugin/plugin.json` layout (the shape `codex plugin marketplace add --help`'s `--sparse plugins/foo` example implies, and the shape this host's own pre-existing `local` marketplace uses via `~/plugins/session-orchestrator`) resolves correctly. This suggests codex's own plugin-discovery convention expects a `plugins/<name>/` marketplace layout that this repo's flat root does not provide, though `.claude-plugin/marketplace.json` (Claude Code's schema) is independently accepted as "a supported manifest" at the `marketplace add` step, without resolving to a discoverable Codex plugin at `list` time.

**Caveat that limits this finding:** this host's installed codex-cli is **0.141.0**, older than the "0.144.4 or newer" prerequisite this guide states above. This failure was not re-verified against 0.144.4+, so it may be specific to running below the documented minimum rather than a defect in this repo's layout on a supported version. Until re-verified on 0.144.4+, treat both the short remote form and the long-form local install (`node scripts/codex-install.mjs`) as **unconfirmed end-to-end on this host** — the `marketplace add` step succeeds either way, but `plugin add` does not, on 0.141.0. Do not elevate either form to a README-level recommended command until a `plugin add` success is measured and dated.

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

`CODEX_PLUGIN_ROOT` is **session-orchestrator's own compatibility export, not a variable Codex provides.** The hook wrapper in `hooks/hooks-codex.json` assigns it from Codex's native `${PLUGIN_ROOT}` so that shared code (`scripts/lib/plugin-root.mjs`) can read one name on every harness. Nothing outside a hook command string sets it — in particular an MCP server started by Codex inherits neither `CODEX_PLUGIN_ROOT` nor `PLUGIN_ROOT`. That is why `.mcp.json` resolves the plugin root on its own instead of relying on a harness-provided variable: it tries `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `PLUGIN_ROOT`, then `git rev-parse --show-toplevel`, then asks Node to resolve the installed `session-orchestrator` package (which reaches `resolvePluginRoot()` and with it the `CURSOR_RULES_DIR` / `PI_PLUGIN_ROOT` roots too), and as the last tier scans the client plugin caches (`${CODEX_HOME:-$HOME/.codex}` and `$HOME/.claude` under `plugins/cache/*/session-orchestrator/*`, accepted only when the copy's `package.json` names `session-orchestrator`; newest by mtime wins). The tier order is documented once, in `scripts/lib/plugin-root.mjs` § TIER ORDER, and `.mcp.json` mirrors it. Each candidate must actually contain `scripts/mcp-server.sh` before it is used.

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
  - `session-orchestrator: cannot locate the plugin root` — no plugin-root variable was set, the working directory was outside any git checkout, no cached copy of the plugin was found, and Node could not resolve an installed `session-orchestrator` package. Fix: reinstall the plugin so a cached copy exists (see *Where the plugin actually lives* below), or add `CODEX_PLUGIN_ROOT` (or `CLAUDE_PLUGIN_ROOT`) pointing at the plugin directory to that server's `env` block. Do not expect Codex to supply the variable — see the note under *Key Differences* above.
  - `session-orchestrator: 'jq' not found in PATH` — the plugin was found but `jq` is missing. Fix: install `jq` and restart Codex. (Before GH#64 this case wrote a JSON-RPC error to *stdout* with `id: null`, which is not a valid `initialize` response either, so a missing `jq` and a missing plugin were indistinguishable from the client side.)
- **The MCP tools answer `Error: not inside a git repository`:** expected, not a failure. The handshake succeeded; `session_config` and `session_metrics` read the *project* you are working in, so they need Codex's working directory to be inside a git repository. Start Codex from the project, or `cd` into it.
- **"another session holds the lock" right after `resume`/`compact` in Codex:** the session lock appears to be self-collision across a resume/compact boundary rather than a real second session. Cause: before v3.23.0 (unreleased at time of writing), `parseSessionId()`'s UUID matcher was pinned to version nibble `4` (Claude Code's format), so every native session id Codex CLI mints — UUIDv7 — failed to parse; `hooks/on-session-start.mjs` fell through to a freshly generated `randomUUID()` on each `SessionStart`, and the new mint then collided with the lock the previous mint still held (Kanevry#66 / #1091). Fixed in v3.23.0 by widening `UUID_RE` in `scripts/lib/session-id.mjs` to accept any RFC 9562 UUID version 1–8, not only `4`. Check: `node -e "import('./scripts/lib/session-id.mjs').then(m=>console.log(m.parseSessionId('017f22e2-79b0-7cc3-98c4-dc0c0c07398f')))"` must print `format: 'uuid'` and `version: 7` (verified 2026-08-28 @ 30940cb — it does).

### Where the plugin actually lives (measured 2026-08-28, codex-cli 0.141.0)

Three facts explain why launching Codex from `$HOME` used to kill the MCP server before `initialize` (GH Kanevry/session-orchestrator#64), and none of them is guessable from the docs:

1. **Codex copies the plugin; it does not run it from your clone.** A marketplace install lands at `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/` — measured here as `~/.codex/plugins/cache/local/session-orchestrator/3.22.0+codex.20260822193811/`, a full self-contained tree with its own `.mcp.json`, `package.json` and `scripts/mcp-server.sh`. Claude Code uses the same shape under `~/.claude/plugins/cache/`.
2. **The MCP child gets no plugin-root variable and no working directory of its own.** Probing a registered MCP server launched from `/tmp` showed `PWD=/private/tmp` (the launch directory, verbatim) and `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `PLUGIN_ROOT` and `CODEX_HOME` **all unset**; `codex mcp list` prints `Env: -` and `Cwd: -` for the entry. `HOME` *is* set. So from `$HOME` — not a git repository — every locator the entrypoint had was blind, and `$(git rev-parse --show-toplevel)` collapsed the path to `/scripts/mcp-server.sh`.
3. **Codex does not expand `${...}` in the registered command, and the registration is a snapshot.** `codex mcp list` shows the launch string verbatim, `${CLAUDE_PLUGIN_ROOT:-…}` and all — bash expands it, not Codex. It comes from the *cached* `.mcp.json`, taken at install time: a fix committed to this repo reaches an existing install only after a reinstall.

The entrypoint therefore scans those cache roots itself, matching on `package.json` `"name": "session-orchestrator"` rather than on the directory name, and preferring the most recently installed copy. A directory that merely *sits* under a `session-orchestrator/` marketplace folder is rejected.

**If your install predates this fix, reinstall — the fix cannot reach a cached copy on its own:**

```bash
codex plugin marketplace add Kanevry/session-orchestrator
codex mcp list | grep session-orchestrator   # the launch string should mention plugins/cache
```

The 0.144.4 minimum-version caveat above still stands: everything in this section was measured on **0.141.0**, below the documented minimum, and has not been re-verified on 0.144.4+ or on the reporter's 0.149.0-alpha.4.3.

