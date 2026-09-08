# Codex Setup Guide

Guide for using Session Orchestrator with OpenAI Codex through Codex's public plugin lifecycle.

## Prerequisites

- Codex CLI 0.144.4 or newer
- Node.js 24 or newer
- Git and an initialized project repository
- `plugins` and `hooks` reported as `stable true` by `codex features list`

## Installation

**Recommended:** the short remote form (`codex plugin marketplace add <owner>/<repo>`) needs no local clone — see "Short-Form Marketplace Add" below. The steps below are the maintainer/local-clone path used by `scripts/codex-install.mjs`.

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

### Short-Form Marketplace Add (Recommended — Verified 2026-09-04, codex-cli 0.144.4)

`codex plugin marketplace add --help` documents a short remote form:

```
codex plugin marketplace add owner/repo --ref main
```

This is the recommended install path — no local clone needed. Confirmed end-to-end on codex-cli **0.144.4** (2026-09-04), against this repo's unchanged flat layout (`.codex-plugin/plugin.json` + `.claude-plugin/marketplace.json` at repo root, no `plugins/<name>/`):

```
$ codex plugin add session-orchestrator@kanevry --json
{"pluginId":"session-orchestrator@kanevry","version":"3.22.1+codex.20260825125233","installedPath":"~/.codex/plugins/cache/kanevry/session-orchestrator/<version>","authPolicy":"ON_INSTALL"}
$ echo $?
0
```

`codex plugin list --available --json --marketplace kanevry` confirms `installed: true, enabled: true` for the same layout — no `plugins/<name>/` restructuring was needed.

**Historical note:** on codex-cli 0.141.0 (2026-08-28), the identical `plugin add` command failed against this same layout with `Error: plugin session-orchestrator was not found in marketplace kanevry`; upgrading to 0.144.4+ resolves it.

### Switching Marketplace Sources

`codex plugin marketplace add owner/repo` silently **replaces** an already-registered marketplace of the same declared name — the name comes from `marketplace.json`'s `name` field, not the `owner/repo` argument — with a fresh git clone under `~/.codex/.tmp/marketplaces/<name>`. Re-adding the original local path afterward then fails with `marketplace '<name>' is already added from a different source; remove it before adding this source`. To switch sources deliberately, run `codex plugin marketplace remove <name>` first.

## Understand the Three States

Codex reports three distinct states that must not be conflated:

1. **Marketplace configured** — `kanevry` points at this clone, so the plugin is discoverable. This alone does not install or enable the plugin.
2. **Plugin installed and enabled** — `codex plugin list --available --json` shows exactly one `session-orchestrator@kanevry` entry with `installed: true`, `enabled: true`, and the version from `.codex-plugin/plugin.json`.
3. **Hooks trusted and executing** — after installation, start a fresh Codex task or fully restart Codex, run `/hooks`, review the Session Orchestrator hook bundle, and approve it if appropriate. Hook trust remains operator-controlled; the installer never writes or bypasses it.

## Refresh and Explicit Cache Invalidation

**If you installed via the short remote form** (`codex plugin marketplace add owner/repo`), refresh the Git marketplace snapshot before updating the installed plugin. Measured 2026-09-06 on codex-cli 0.144.4 — `codex plugin marketplace upgrade --help`: *"Refresh configured Git marketplace snapshots. Omit MARKETPLACE_NAME to upgrade all configured Git marketplaces."*

```bash
codex plugin marketplace upgrade kanevry   # or omit the name to refresh all
codex plugin add session-orchestrator@kanevry
```

`upgrade` re-fetches the Git snapshot; `plugin add` then re-installs the bundle from that refreshed snapshot. There is no local clone in this path, so "re-run the installer" does not apply to it.

**If you installed from a local clone** (the maintainer path), rerun the installer after pulling:

```bash
git pull
npm install
node scripts/codex-install.mjs
```

Every installer run executes `codex plugin marketplace add` and `codex plugin add`, even when the marketplace is already configured. The repeated `plugin add` refreshes Codex's installed bundle from the current clone instead of treating installation as a one-time copy.

After either refresh path, confirm the installed version with `codex plugin list --available --json` and start a fresh task. Reopen the skill picker and search for `go` or `close`; if the updated entries are still missing, fully restart Codex. Editing the source clone or regenerating skills alone does not refresh the installed bundle.

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

### What Codex actually exposes (measured 2026-09-06, codex-cli 0.144.4)

The Codex runtime knows **ten** hook events. This is read out of the shipped binary, which embeds one JSON-Schema pair per event, not quoted from release notes:

```
$ strings -a "$(npm root -g)/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex" \
    | grep '"title": "'
  "title": "post-tool-use.command.input" / ".output"
  "title": "permission-request.command.input" / ".output"
  "title": "post-compact.command.input" / ".output"
  "title": "pre-tool-use.command.input" / ".output"
  "title": "pre-compact.command.input" / ".output"
  "title": "session-start.command.input" / ".output"
  "title": "subagent-start.command.input" / ".output"
  "title": "subagent-stop.command.input" / ".output"
  "title": "user-prompt-submit.command.input" / ".output"
  "title": "stop.command.input" / ".output"
```

| Event | 0.144.4 | Wired here |
|---|---|---|
| `SessionStart` | yes | yes — banner + `on-session-start.mjs` |
| `PostToolUse` | yes | yes — `loop-guard.mjs` |
| `SubagentStop`, `Stop` | yes | yes — `on-stop.mjs` |
| `PreToolUse`, `SubagentStart` | yes | declared, **empty** (see below) |
| `UserPromptSubmit`, `PermissionRequest`, `PreCompact`, `PostCompact` | yes | no — this repo has no handler for them |
| `SessionEnd`, `Interrupt` | **no — event does not exist** | n/a |
| `PostToolUseFailure`, `PostToolBatch`, `CwdChanged` | no — Claude-only | n/a |

**`SessionEnd` is not "Claude-only", it is absent**, and that distinction is load-bearing: the manifest deserializer rejects unknown keys (`unexpected map key` in the same binary), so adding one does not skip a hook — it can reject the whole manifest and take every already-working hook with it. `Interrupt` arrives in 0.150.0+ and async handlers (`"async": true`) in 0.148+; both are **documented upstream but unverified here**, because this host runs 0.144.4. Re-measure against the shipped binary before widening the set — the machine-readable copy is `CODEX_NATIVE_EVENTS` in `scripts/lib/codex/plugin-contract.mjs`.

For the day `SessionEnd` does land: upstream caps it (and `Interrupt`) at a **1 s default / 3 s maximum** timeout, where every other event gets 600 s. `hooks/on-session-end.mjs` measures ~221 ms median, so it fits — but only just, and only while it stays that fast.

### Why our PreToolUse guards stay unwired — the reason, corrected

Earlier revisions of this page said the handlers were unwired because "no Codex bridge delivers `tool_name`". **That was measuring the wrong thing** — it grepped our own adapter code rather than the Codex payload contract. There is no bridge because none is needed:

- `pre-tool-use.command.input` REQUIRES `tool_name` and `tool_input`, alongside `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_use_id`, `transcript_path`, `turn_id`.
- The deny envelope is `hookSpecificOutput.{hookEventName, permissionDecision, permissionDecisionReason}` — byte-identical to what `emitDeny()` already writes, and Codex enforces exactly that shape (its own error text: *"PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason"*). Codex additionally rejects `permissionDecision: "allow"` and `"ask"`; our allow path is a bare `exit 0` with no stdout, so it is compatible.

The real blocker is the **tool-name vocabulary**. Codex has no `Bash`, `Edit`, `Write` or `MultiEdit` tool — `strings -a <codex> | grep -c '"Bash"'` returns `0`; its tools are `shell`, `exec_command`, `unified_exec`, `apply_patch`, `update_plan`, `view_image`. Every PreToolUse guard in `hooks/` opens with an equality gate on a Claude tool name and returns `emitAllow()` otherwise, so wiring `pre-bash-destructive-guard.mjs` or `enforce-scope.mjs` today produces a hook that runs, matches nothing, and allows everything — **false enforcement, which is worse than a registered gap** (#919-P2 class).

Consequence to state plainly: **PSA-003 (destructive-command guard) and the file-scope guard are behavioural only on Codex today.** The repair is a tool-name map (`shell`/`exec_command`/`unified_exec` → `Bash`) for the Bash guards, plus an `apply_patch` payload adapter for the Edit/Write matchers specifically. Only the second half needs the adapter.

These per-event gaps are tracked as documented asymmetries in `scripts/lib/validate/check-hooks-symmetry.mjs` (Check 6, `handlerAsymmetries`) — an UNDOCUMENTED one-platform-only handler fails validation.

An empty `PreToolUse` or `SubagentStart` array means the event belongs to the validated Codex surface but currently has no payload-compatible handler. It does not mean installation or hook trust failed.

## Usage

After installation or refresh, start a fresh task. In the desktop composer, open the skill picker, search for `go` or `close`, and select the matching **Session Orchestrator** entry. In Codex CLI or the IDE extension, use `/skills` or mention the namespaced skill directly in your prompt. [OpenAI skill invocation](https://learn.chatgpt.com/docs/build-skills)

```text
$session-orchestrator:session feature   # start a session (housekeeping, feature or deep)
$session-orchestrator:go                # execute the agreed plan
$session-orchestrator:close             # verify and close the session
$session-orchestrator:plan feature      # plan a project or feature (new, feature or retro)
$session-orchestrator:discovery         # run quality probes; optionally add a scope
$session-orchestrator:evolve analyze    # manage learnings (analyze, review or list)
```

These are skill invocations in the Codex prompt, not shell commands. Invoking `go` reads the full canonical `commands/go.md`, including its Express Path and prechecks; invoking `close` reads `commands/close.md`, including its state and ledger checks before the session-end workflow. Codex's native `/goal` is a separate feature. Typing `/go` or `/close` alone is not a portable invocation contract; select the skill or use its explicit namespaced form.

### Manifest Compatibility

The plugin uses `.codex-plugin/plugin.json` for Codex and `.cursor-plugin/plugin.json` for Cursor. It does not ship a root Agent Plugins `plugin.json`: on Codex CLI 0.153.3 and desktop runtime 0.153.4, that standard manifest takes precedence, fixes skill discovery to conventional `skills/`, and supplies the root version. The Codex overlay can supply hooks, apps and interface metadata, but cannot override that skill path or version. This was verified with read-only `plugin/read` probes on 2026-09-07. [Codex manifest parser](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/agent_plugin_manifest.rs)

Moving the former root metadata to the native Cursor manifest lets Codex load its generated entrypoints and cache suffix. Cursor keeps the declared skills and MCP paths; the manifest explicitly disables discovery of extra rules, agents, commands and hooks. Its existing installer supplies the Cursor command and hook adapters. This follows the [Cursor manifest reference](https://cursor.com/docs/reference/plugins); native Cursor loading has not been runtime-tested as part of this change.

### Generated Command Skills

The Codex manifest registers one generated skill tree at `.codex-plugin/skills/`. It contains the union of names from `commands/` and `skills/`: when both contain the same name, the command takes precedence, giving the plugin one public entry for that name. OpenAI recommends converting reusable Markdown commands into skills. [OpenAI conversion guidance](https://developers.openai.com/plugins/guides/submit-claude-plugin)

The manifest also declares top-level `"commands": []` to suppress the installer's automatic command migration. When that field was omitted, a public install with Codex 0.153.3 added nine `source-command-*` aliases alongside the generated entries, including `source-command-close`, without preserving invocation policy. The empty array selects no command sources; it does not register native slash commands. The generated skill tree remains the public invocation surface. [Codex 0.153.3 command-path parser](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core-plugins/src/manifest.rs#L203), [installer migration](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core-plugins/src/command_migration/plugin.rs)

The generated files are adapters, not separate workflow bodies. Each links to its canonical command or skill using a package-relative path, so it also works from the installed bundle. Command adapters read the full command first and resolve internal skill calls directly to `skills/<name>/SKILL.md`, avoiding a recursive call to the public entry. Trailing prompt text supplies the command's `$ARGUMENTS` as data; the adapter does not shell-expand arguments or globally substitute them into command documents.

Commands declaring `disable-model-invocation: true`, including `go` and `close`, receive `policy.allow_implicit_invocation: false` in `agents/openai.yaml`. This preserves explicit selection while disabling implicit skill invocation. Other commands retain their source setting. [OpenAI invocation policy](https://learn.chatgpt.com/docs/build-skills#optional-metadata)

Maintainers edit the canonical files, then regenerate and check the Codex surface from the plugin root:

```bash
node scripts/generate-codex-skills.mjs
node scripts/generate-codex-skills.mjs --check
node scripts/validate-plugin.mjs
```

`--check` reports stale generated files without writing them. Plugin validation also checks manifest wiring, command coverage, canonical targets and invocation policy. Commit the generated output with its source change, then follow [Refresh and Explicit Cache Invalidation](#refresh-and-explicit-cache-invalidation) to update the installed copy.

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

Repository skills under `.agents/skills/` and installed-plugin skills can both appear in the picker. The generated union prevents duplicate names within the plugin; it does not remove pre-existing entries from other discovery scopes. Select the installed command entry whose path is under `.codex-plugin/skills/` when a repository also offers a same-named internal skill.

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
- **`go` or `close` is missing from the skill picker:** follow [the refresh steps](#refresh-and-explicit-cache-invalidation), verify the installed version, and restart Codex if reopening the picker does not load the new entries. Use the namespaced skill form from [Usage](#usage), rather than selecting the unrelated native Goal command.
- **Plugin is installed and enabled but hooks do not fire:** start a fresh task or fully restart Codex, run `/hooks`, and review the trust state. Installation does not imply hook approval.
- **No import-probe warning after an edit:** the post-edit import probe is currently **unwired in Codex**. Reinstalling the same bundle does not add it. Use normal project lint and tests; see [the probe's harness wiring and ESLint requirements](USER-GUIDE.md#import-probe-warnings-and-missing-eslint).
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

1. **Codex copies the plugin; it does not run it from your clone.** A marketplace install lands at `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/` — measured here as `~/.codex/plugins/cache/local/session-orchestrator/<version>+codex.<stamp>/`, a full self-contained tree with its own `.mcp.json`, `package.json` and `scripts/mcp-server.sh`. Claude Code uses the same shape under `~/.claude/plugins/cache/`.
2. **The MCP child gets no plugin-root variable and no working directory of its own.** Probing a registered MCP server launched from `/tmp` showed `PWD=/private/tmp` (the launch directory, verbatim) and `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `PLUGIN_ROOT` and `CODEX_HOME` **all unset**; `codex mcp list` prints `Env: -` and `Cwd: -` for the entry. `HOME` *is* set. So from `$HOME` — not a git repository — every locator the entrypoint had was blind, and `$(git rev-parse --show-toplevel)` collapsed the path to `/scripts/mcp-server.sh`.
3. **Codex does not expand `${...}` in the registered command, and the registration is a snapshot.** `codex mcp list` shows the launch string verbatim, `${CLAUDE_PLUGIN_ROOT:-…}` and all — bash expands it, not Codex. It comes from the *cached* `.mcp.json`, taken at install time: a fix committed to this repo reaches an existing install only after a reinstall.

The entrypoint therefore scans those cache roots itself, matching on `package.json` `"name": "session-orchestrator"` rather than on the directory name, and preferring the most recently installed copy. A directory that merely *sits* under a `session-orchestrator/` marketplace folder is rejected.

**If your install predates this fix, reinstall — the fix cannot reach a cached copy on its own:**

```bash
codex plugin marketplace add Kanevry/session-orchestrator
codex mcp list | grep session-orchestrator   # the launch string should mention plugins/cache
```

The 0.144.4 minimum-version caveat above still stands: everything in this section was measured on **0.141.0**, below the documented minimum, and has not been re-verified on 0.144.4+ or on the reporter's 0.149.0-alpha.4.3.
