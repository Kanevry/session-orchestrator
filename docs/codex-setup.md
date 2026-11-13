# Codex Setup Guide

Guide for using Session Orchestrator with OpenAI Codex through Codex's public plugin lifecycle.

## Prerequisites

- Codex CLI 0.160 or newer (since #1919: the plugin wires `SessionEnd`, which 0.144.4 rejects and 0.160.1 fires; the first version in between that accepts it is unmeasured, so 0.160 is the measured floor, not a tight one)
- Node.js 24 or newer
- Git and an initialized project repository
- `plugins` and `hooks` reported as `stable true` by `codex features list`
- Bash and `jq` for the MCP server: the Codex manifest points at `.mcp.json`, which starts `scripts/mcp-server.sh` through `bash`, and that script exits 1 with `'jq' not found in PATH` when `jq` is missing. On native Windows use the Node-based setup instead; see [`docs/install.md`](./install.md#native-windows-mcp-opt-in)

## Installation

Two paths. The clone below is the complete install: it puts the runtime dependencies next to the plugin. The short remote form (`codex plugin marketplace add <owner>/<repo>`) needs no clone and takes two commands, but the installed plugin has no `node_modules`, so part of the plugin falls back or stops until you run `npm install` there — see "Short-Form Marketplace Add" below.

Clone the repository, install its runtime dependencies, and run the installer from the plugin root:

```bash
git clone https://github.com/Kanevry/session-orchestrator.git
cd session-orchestrator
npm install
node scripts/codex-install.mjs
```

The installer never registers the clone itself. It packs the clone with `npm pack --ignore-scripts` into `~/.cache/session-orchestrator/plugin-package/` (`$XDG_CACHE_HOME` if set; the same packed copy `npm run update:local` uses for Claude Code), installs the runtime dependencies there with `npm ci --omit=dev --ignore-scripts`, validates the Codex manifest and hook contract of that packed copy, then uses the same public commands an operator can run manually (the packing and staging steps are not part of that list: `npm pack` never includes `package-lock.json`, so a hand-staged copy needs the clone's `package-lock.json` copied into the unpacked `package/` directory before `npm ci --omit=dev --ignore-scripts` can run there; the installer does this copy itself, `scripts/lib/plugin-package-stage.mjs`. Only the installer is the supported way to stage):

```bash
codex plugin marketplace add ~/.cache/session-orchestrator/plugin-package
codex plugin add session-orchestrator@kanevry
codex plugin list --available --json
```

A marketplace on the working checkout copies all of it into the Codex plugin cache — measured 2026-10-03: 15742 files, `.env.local`, `.orchestrator/` and `tests/` included (#1518). The installer therefore refuses while any local marketplace reads the clone and prints the exact `codex plugin marketplace remove <name>` command to run once before re-running it.

It operates only through public Codex plugin commands; hook trust remains untouched.

**Verified 2026-10-28 (codex-cli 0.160.1, macOS on Apple M4, Node 24.22.1, plugin 5.14.0), including a model session.** Both paths were run from the public GitHub mirror with `scripts/install-smoke.mjs` (see [install.md](install.md#re-running-the-install-smoke-maintainers)), each in an empty profile, with an OpenAI-compatible endpoint as the model route. The passing runs used `--dangerously-bypass-hook-trust`, because a fresh `CODEX_HOME` holds no hook trust; the plugin's hooks ran as after a user trusts them.

- **Clone path** (`--harness codex-clone`, model `gpt-5.6-sol`): `npm ci --ignore-scripts`, then `node scripts/codex-install.mjs --json` exited 0. 11 of 11 runtime dependencies resolved, because the clone path installs them. Bootstrap succeeded, and the feature session ended at a plan after two questions the run answered with "1" (a warning that the bootstrap run still looked like a live parallel session, then the scope of the change): pass.
- **Short marketplace form** (`--harness codex`): `marketplace add ... --ref main` and `plugin add ... --json` exited 0, version `5.14.0+codex.20261026070538`. The new cache had 0 of 11 runtime dependencies (`runtime-readiness` exit 3), measured six times; `--repair` brought it to 11 of 11 in 1-3 s. The skill and script reads all came from that cache (105 path references, none from the marketplace clone). `bootstrap --fast --no-interview` completed in 4 of 6 runs; in the other 2 (both `gpt-5.6-sol`) it asked for the bootstrap tier and project archetype instead. With model `gpt-5.6-sol` the feature session ended at a plan offering `$session-orchestrator:go` in 2 of 3 runs, after two or three answered questions, and no project file changed; in the third, bootstrap finished only during the session and its scaffold files counted as changes. With model `gpt-6-sol` the session wrote the requested file directly, without a plan (3 of 3 runs; in the 2 runs that recorded tool calls it had read the skill first); this is model behaviour, recorded as such. The smoke is not a sandbox: see [install.md](install.md#re-running-the-install-smoke-maintainers) for the residual risk.

### Short-Form Marketplace Add (Verified 2026-09-04, codex-cli 0.144.4; dependencies measured 2026-10-21, codex-cli 0.160.1)

`codex plugin marketplace add --help` documents a short remote form:

```
codex plugin marketplace add owner/repo --ref main
```

This is the shortest install path — no local clone needed. Confirmed end-to-end on codex-cli **0.144.4** (2026-09-04), against this repo's unchanged flat layout (`.codex-plugin/plugin.json` + `.claude-plugin/marketplace.json` at repo root, no `plugins/<name>/`):

```
$ codex plugin add session-orchestrator@kanevry --json
{"pluginId":"session-orchestrator@kanevry","version":"3.22.1+codex.20260825125233","installedPath":"~/.codex/plugins/cache/kanevry/session-orchestrator/<version>","authPolicy":"ON_INSTALL"}
$ echo $?
0
```

`codex plugin list --available --json --marketplace kanevry` confirms `installed: true, enabled: true` for the same layout — no `plugins/<name>/` restructuring was needed.

**No runtime dependencies on this path (measured 2026-10-21, codex-cli 0.160.1, isolated `CODEX_HOME`).** `marketplace add` and `plugin add` both exit 0, but the installed path (`~/.codex/plugins/cache/kanevry/session-orchestrator/<version>`) has no `node_modules`. That holds for this `kanevry` short-form path only: re-measured 2026-11-02 on codex-cli 0.160.1, a local-clone install (marketplace `local`, version `5.17.0+codex.20261101111338`) carried `node_modules` (241 entries), `.git`, `.env.local` and `.orchestrator` into its cache, as in the #1518 note above. The SessionStart hook, the Bash guards and `scripts/parse-config.mjs` still run (the destructive-command guard's `git stash` check falls back to a warning, because it needs `zx`). Everything else that needs a runtime dependency (`zx`, `zod`, `js-yaml`, `ajv`, `remark`, …) either falls back or stops:

- `owner.yaml` loads `js-yaml` lazily: when the file exists, owner preferences fall back to defaults and the process prints `WARN owner-yaml: 'js-yaml' is not installed … Run 'npm install' in the plugin directory`.
- Scripts that import a dependency at the top stop with `ERR_MODULE_NOT_FOUND` and no warning: the worktree helpers (`zx`), the learnings index (`zod`), the persona panel and the PRD archive (`js-yaml`), among others (18 files import `js-yaml` that way).

Re-measured 2026-10-28 on plugin 5.14.0: the new cache again had 0 of 11 runtime dependencies. Session start now reports the gap at every start (the `runtime-readiness` banner probe), so a new version cache is checked without you remembering to. To restore the dependencies, take the `installedPath` that `codex plugin add --json` prints and run:

- From the release after 5.14.0 on: `node <installedPath>/scripts/runtime-readiness.mjs --repair`. It runs `npm ci --omit=dev --ignore-scripts` (or `npm install ...` without a lockfile) in that install and re-checks. Without `--repair` it installs nothing; `--codex` finds the enabled Codex install by itself. Exit 0 means ready, 3 not ready.
- For 5.14.0 caches: `npm install --omit=dev --ignore-scripts` in the `installedPath`.

Each version gets a new cache directory, so the check applies again after every update. The clone path above avoids this.

Re-measured 2026-10-29 on plugin 5.16.0 (codex-cli 0.160.1): the new cache had 0 of 11 dependencies, and `--repair` brought it to 11 of 11. After the first `codex exec` the cache had no `node_modules` again, and its directory had been rewritten after the repair. Until #1878 is resolved, run the readiness check again after the first Codex start. Measured on 2026-11-02 with codex-cli 0.160.1 and plugin 5.17.0 from `ref=main`: the first `codex exec` rebuilds the version directory once from a fresh marketplace clone under `<CODEX_HOME>/.tmp/marketplaces/`, which has no `node_modules`. This happened even when that exec failed. A `--repair` made after the first exec survived the next exec, so one repair after the first Codex start is enough. The model sessions on both paths failed with `gpt-6-sol`: on the short form the model wrote the file without a plan, and on the clone path no `/go` plan came after three answered questions. Details: [install.md](install.md#re-running-the-install-smoke-maintainers).

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

Every installer run executes `codex plugin marketplace add` and `codex plugin add`, even when the marketplace is already configured. The repeated `plugin add` refreshes Codex's installed bundle from a freshly packed copy of the current clone instead of treating installation as a one-time copy.

After either refresh path, confirm the installed version with `codex plugin list --available --json` and start a fresh task. Reopen the skill picker and search for `go` or `close`; if the updated entries are still missing, fully restart Codex. Editing the source clone or regenerating skills alone does not refresh the installed bundle.

### Command entry points missing after an update (GH#68)

**Symptom:** the skill picker shows `session-start` but not `session`, `go`, or `close`.

**Cause:** Codex caches a plugin snapshot at install time; in our 0.153.x probes, running `codex plugin update` alone did not refresh `.codex-plugin/skills/`.

**Check before reinstalling:** verify with `codex plugin list --json` that the plugin is installed and enabled, then inspect the skill picker for `session`, `go`, and `close`. A native `skills/list` probe with `forceReload: true` distinguishes a missing entry from a stale picker. The generated surface changes over time; verify the required names rather than a fixed total count. If those entries really are missing from an old installed bundle, refresh it using the commands above. 4.0.1+ ships the generated entrypoints (`scripts/generate-codex-skills.mjs`).

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

`hooks/hooks-codex.json` declares the curated seven-event Codex project subset:

- `SessionStart`
- `PreToolUse`
- `PostToolUse`
- `SubagentStart`
- `SubagentStop`
- `Stop`
- `SessionEnd`

The Codex hook command uses Codex's native `${PLUGIN_ROOT}` expansion. The wrapper also exports `CODEX_PLUGIN_ROOT="${PLUGIN_ROOT}"` for shared compatibility code and sets `SO_PLATFORM=codex` so Codex wins when multiple harness variables are present.

On native Windows Codex runs `commandWindows` instead (#1849), through `%COMSPEC% /C`, i.e. cmd.exe (codex-rs `hooks/src/engine/command_runner.rs`, read 2026-10-28). That POSIX hull cannot start there: cmd.exe has no env prefix (PowerShell reads `SO_PLATFORM=codex` as a command name). Each handler's `commandWindows` is `set NoDefaultCurrentDirectoryInExePath=1&& node -e "require(require('path').join(require('path').isAbsolute(process.env.PLUGIN_ROOT||'')?process.env.PLUGIN_ROOT:process.exit(1),'hooks','codex-win.cjs'))" <handler>.mjs`: the `set` keeps cmd.exe from running a `node` from the session directory, and only an absolute `PLUGIN_ROOT` is used; `hooks/codex-win.cjs` sets the same two variables and runs the handler. Measured 2026-10-28 on Windows 11 with PowerShell 5.1.26100 and cmd.exe (Node 24.14.0, plugin root with spaces): the destructive guard denies and allows as on macOS. Not yet measured: a full Codex session on Windows after trusting the hooks. `node` must be on `PATH`; unlike `run-node.sh`, the Windows entry has no fallback search.

### What Codex actually exposes (measured 2026-09-06, codex-cli 0.144.4; re-measured 2026-11-02, codex-cli 0.160.1)

On 0.144.4 (2026-09-06) the Codex runtime knew **ten** hook events; on 0.160.1 (2026-11-02) it knows twelve (see the re-measurement below the table). This is read out of the shipped binary, which embeds one JSON-Schema pair per event, not quoted from release notes:

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

| Event | 0.144.4 (2026-09-06) | Wired here |
|---|---|---|
| `SessionStart` | yes | yes — banner + `on-session-start.mjs` |
| `PostToolUse` | yes | yes — `loop-guard.mjs`; `Bash`: `post-bash-write-verify.mjs` (warn-only, #1691) |
| `SubagentStop`, `Stop` | yes | yes — `on-stop.mjs` |
| `PreToolUse` | yes | yes — `Bash`: destructive guard, staging fence, memory-propose audit, sessions-ledger guard, issue budget, `enforce-commands.mjs` (#1691); `pre-bash-templates-first.mjs` stays unwired; the Edit/Write guards run through the `apply_patch` adapter since #1913 (see below) |
| `SubagentStart` | yes | declared, **empty** |
| `UserPromptSubmit`, `PermissionRequest`, `PreCompact`, `PostCompact` | yes | no — this repo has no handler for them |
| `SessionEnd` | **no — event did not exist on 0.144.4**; fires on 0.160.1 (below) | yes — `on-session-end.mjs`, `timeout: 3` (Codex maximum), measured on 0.160.1 (#1919). `"matcher": ""` kept for parity with `Stop`; a manifest with that matcher loaded and fired on 0.160.1 (measured 2026-11-02, below) |
| `Interrupt` | **no — event did not exist on 0.144.4**; exists on 0.160.1, firing unmeasured | no — no handler, not measured |
| `PostToolUseFailure`, `PostToolBatch`, `CwdChanged` | no — Claude-only | n/a |

On 0.144.4 (2026-09-06) **`SessionEnd` was not "Claude-only", it was absent**, and that distinction is load-bearing: the manifest deserializer rejects unknown keys (`unexpected map key` in the same binary), so adding one does not skip a hook — it can reject the whole manifest and take every already-working hook with it. At that date `Interrupt` (upstream: 0.150.0+) and async handlers (`"async": true`, upstream: 0.148+) were documented upstream but unverified here, because the host then ran 0.144.4; async handlers are still unmeasured. Re-measure against the shipped binary before widening the set — the machine-readable copy is `CODEX_NATIVE_EVENTS` in `scripts/lib/codex/plugin-contract.mjs`.

**Re-measured 2026-11-02 (codex-cli 0.160.1).** The same `strings -a <codex binary> | grep '"title": "'` now lists twelve events: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

- `session-end.command.input` has the fields `cwd`, `hook_event_name: "SessionEnd"`, `reason` (the schema allows only `"other"`), `session_id` and a nullable `transcript_path`. `SessionEnd` **fires** at the end of a `codex exec` run. Under `--ephemeral` the payload was `{"session_id":"…","transcript_path":null,"cwd":"…","hook_event_name":"SessionEnd","reason":"other"}`; in a non-ephemeral run `transcript_path` pointed at the rollout JSONL, whose line 0 is a `session_meta` record with `payload.source: "exec"`, `originator: "codex_exec"` and `cli_version: 0.160.1` (the shape `scripts/lib/codex/rollout-meta.mjs` reads for the #1889 Stop release).
- `interrupt.command.input` and `.output` exist; the output carries only `systemMessage`. Whether `Interrupt` fires was **not measured** (it needs an interrupted turn).
- Since #1919 `hooks/hooks-codex.json` registers `SessionEnd` (handler `hooks/on-session-end.mjs`) and `CODEX_NATIVE_EVENTS` includes it; `Interrupt` stays excluded. Codex 0.144.4 (measured 2026-09-06) rejects unknown hook keys and the first version that accepts `SessionEnd` is unmeasured (somewhere in 0.145–0.160.1), so the documented minimum is now **0.160** — the measured version, not a pinned floor.

Upstream caps `SessionEnd` (and `Interrupt`) at a **1 s default / 3 s maximum** timeout, where every other event gets 600 s, so the manifest sets `"timeout": 3`. `hooks/on-session-end.mjs` measures ~221 ms median, but its worst case is bounded by a 500 ms stdin cap, a backfill with an ~845 ms median, and the telemetry flush: under `SO_PLATFORM=codex` the flush is capped at 700 ms instead of the 2 s used on Claude Code, which keeps the sum under 3 s. An expired internal flush queues the record; a harness kill at 3 s would lose it. The abandoned-session backfill still runs on every Codex `SessionEnd` (reason is always `"other"`), including a one-shot `codex exec` run.

**Wiring measured live 2026-11-02 (codex-cli 0.160.1, #1919/#1874).** Plugin packed by `scripts/codex-install.mjs` from the `feat/so-ee-deep-2026-11-02d` worktree (uncommitted `hooks/hooks-codex.json` with the `SessionEnd` group, byte-identical in the installed cache `5.17.0+codex.20261101111338`, 60 `node_modules` entries) into a throwaway `CODEX_HOME`, `HOME` and `XDG_CONFIG_HOME`; target a fresh one-commit repo. Two consecutive `codex exec -s read-only --dangerously-bypass-hook-trust` runs, 19:41:12Z and 19:41:53Z. The throwaway home had no model credentials, so both turns ended in `401 Unauthorized` (exit 1) and `Stop` did not fire; the hooks were measured, the model turn was not. Per run:

- stderr showed `hook: SessionStart` / `hook: SessionStart Completed` and no `hook: … Failed` line. Codex printed no `hook: SessionEnd` line, but the hook ran: `events.jsonl` carries `orchestrator.session.ended` (`reason: "other"`) and `orchestrator.session.lock.released` with `caller: "on-session-end"`, `outcome: "deleted"`, `verified: true`, about 20 ms after `session.ended` and within the run's last second.
- Read back after each run: `.orchestrator/session.lock` absent; the registry directory `<XDG_CONFIG_HOME>/session-orchestrator/sessions/` empty. Its mtime stayed at the first run's start, so this measurement does not separate "registered, then deregistered" from "never written"; the absence of a leftover entry is measured, the deregistration itself is not.
- The second run's `orchestrator.session.started` had `peer_count: 0`, `peers_superseded: 0`, `recent_starts_count: 0`, and no peer or worktree-promotion line appeared (#1874 AC 2).

Because `Stop` never ran here, the lock release came from `SessionEnd` alone; with a working model route `Stop` releases first and `SessionEnd` finds no lock.

### Which PreToolUse guards run on Codex — the reason, corrected

Earlier revisions of this page said the handlers were unwired because "no Codex bridge delivers `tool_name`". **That was measuring the wrong thing** — it grepped our own adapter code rather than the Codex payload contract. There is no bridge because none is needed:

- `pre-tool-use.command.input` REQUIRES `tool_name` and `tool_input`, alongside `cwd`, `hook_event_name`, `model`, `permission_mode`, `session_id`, `tool_use_id`, `transcript_path`, `turn_id`.
- The deny envelope is `hookSpecificOutput.{hookEventName, permissionDecision, permissionDecisionReason}` — byte-identical to what `emitDeny()` already writes, and Codex enforces exactly that shape (its own error text: *"PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason"*). Earlier revisions of this page added that Codex rejects `permissionDecision: "allow"` and `"ask"`. That claim carried no date or version and has not been re-measured, so treat it as unverified. Our allow path is a bare `exit 0` with no stdout, which does not depend on it.

Until 2026-10-20 this page named the **tool-name vocabulary** as the real blocker: Codex's model-facing tools are `shell`, `exec_command`, `unified_exec`, `apply_patch`, `update_plan`, `view_image`, and `strings -a <codex> | grep -c '"Bash"'` returned `0` (codex-cli 0.144.4). **For the shell tool that is refuted** (#1669, measured 2026-10-20 on codex-cli 0.160.1 with a logging PreToolUse hook under `codex exec`): a shell call reaches the hook as `"tool_name":"Bash"` with `"tool_input":{"command":"<string>"}`, and `matcher: "Bash"` fires. Codex maps its shell tool to the Claude name at the hook boundary, so the Bash guards need no tool-name map. The allow-only `pre-bash-staging-fence.mjs` is wired on that basis. For the Edit/Write matchers (`apply_patch`) the vocabulary is measured since #1914 (codex-cli 0.160.1, 2026-11-02, see "Measured payload" below): `tool_name` is `"apply_patch"`.

**Codex honours a deny** (#1691, measured 2026-10-20 on codex-cli 0.160.1). `codex exec` with `pre-bash-destructive-guard.mjs` as the only PreToolUse hook and the prompt `printf x > CLAUDE.md` logged `Command blocked by PreToolUse hook: Destructive command blocked: '> CLAUDE.md' (rule: redirect-truncate-protected)`, and `CLAUDE.md` stayed unchanged. The control run with `hooks.PreToolUse=[]` ran the command and the file became `x`. The measured payload carries `session_id`, `turn_id`, `cwd` (the session workdir, which is also the hook's process cwd), `tool_name: "Bash"`, `tool_input.command` and `transcript_path: null`; PostToolUse adds `tool_response: ""`. (The `null` was that run; the #1914 run on 2026-11-02, same codex-cli 0.160.1, logged `transcript_path` **set** on both the `apply_patch` and the `Bash` payload. Treat it as optional.) A real Codex session exports no `CLAUDE_*` variables.

Each Bash hook was then fed that payload and wired only where it enforces on it:

| Hook | On Codex | Why |
|---|---|---|
| `pre-bash-destructive-guard.mjs` | wired | denies `> CLAUDE.md` |
| `pre-bash-sessions-ledger-guard.mjs` | wired | denies a direct write to `.orchestrator/metrics/sessions.jsonl` |
| `pre-bash-issue-budget.mjs` | wired | with a cap of 1 the second `glab issue create` is denied and parked |
| `enforce-commands.mjs` | wired | applies `blockedCommands` from `.codex/wave-scope.json` |
| `pre-bash-memory-propose-audit.mjs` | wired | appends its audit event (observe-only by design) |
| `post-bash-write-verify.mjs` (PostToolUse) | wired | reports a write outside `allowedPaths` (warn-only by design) |
| `pre-bash-templates-first.mjs` | **not wired** | it can only deny there: the template-Read proof needs `transcript_path`, which the measured Codex payloads carry only in some runs (`null` on 2026-10-20, set on 2026-11-02, both codex-cli 0.160.1), and `/templates-ack` needs a `claude` parent process |
| `post-bash-issue-budget-refund.mjs` | n/a | runs on `PostToolUseFailure`, which Codex does not have; a failed create keeps its budget slot |

Since #1913 the Edit/Write PreToolUse guards (`enforce-scope.mjs`, `config-protection.mjs`, `pre-edit-sessions-ledger-guard.mjs`, the edit side of `pre-tool-state-md-path-guard.mjs`) run on Codex through the adapter `hooks/codex-apply-patch-guard.mjs` (matcher `apply_patch`). It parses the patch strictly (`scripts/lib/codex/apply-patch-parse.mjs`), runs each guard per touched file (Add, Update, Delete, both ends of a Move) on a synthesized payload, and denies the whole patch on the first deny, on any patch it cannot read, and on any guard failure. Every payload is a Write of the whole file Codex would produce, never a per-hunk Edit: Codex finds a hunk leniently (one trailing CR dropped, then exact, trailing-whitespace-trimmed, fully trimmed and Unicode-punctuation-folded matching), while `config-protection.mjs` skips an Edit whose `old_string` is not a verbatim substring, so per-hunk Edits let a strict-mode loosening through. The adapter applies the hunks with the same passes (`applyHunksToText` in `scripts/lib/codex/apply-patch-parse.mjs`, keeping the file's CRLF endings) and denies with `hunk context not found in <path>` when a hunk matches nowhere. Every `file_path` is absolute against the session cwd (a relative patch path resolves against the payload `cwd`). The adapter reads only `tool_input.command` as a string, and any other `tool_input` key is denied.

**Measured payload** (#1914, codex-cli 0.160.1, macOS, `codex exec` with a logging hook, 2026-11-02):

- **Tool route.** Matcher `apply_patch` fires for PreToolUse and PostToolUse; `applypatch`, `Bash` and `shell` do not. The payload keys are `session_id, turn_id, transcript_path` (set), `cwd, hook_event_name, model, permission_mode, tool_name, tool_input, tool_use_id`. `tool_name` is `"apply_patch"`, and `tool_input` is exactly `{ command: "<raw patch string>" }`. PostToolUse adds `tool_response` (a string). Header paths may be relative or absolute.
- **Shell route.** If the model sends `apply_patch <<'EOF' … EOF` through the shell tool, only the `Bash` matcher fires, and only for PreToolUse. The payload has `tool_name: "Bash"` and the whole heredoc in `tool_input.command`, and the paths are relative. There is no PostToolUse. Codex recognises the heredoc itself (tree-sitter query `(#any-of? @apply_name "apply_patch" "applypatch")` in the binary) and applies the patch without running a shell. So the adapter is registered on the `Bash` matcher too. It reads the heredoc (`<<'EOF'`, `<<"EOF"`, `<<EOF`, `<<-EOF`, any delimiter, optional `command`/`env` prefix) and judges the patch like the tool route. A Bash command that does not invoke `apply_patch`/`applypatch` as its command word is allowed at once, with no guard child: about 48 ms per call (median of 20, the same as `pre-bash-staging-fence.mjs`, measured 2026-11-02). An invocation the adapter cannot read is denied with `apply_patch-Form nicht lesbar`, which names the way out (the heredoc as the whole command, or the apply_patch tool). Such forms include a pipe, a file redirect, `cd … &&`, `bash -c`, or text after the heredoc. Since #1917 the command word is decided per statement by the shared tokenizer (`scripts/lib/command-blocker.mjs`, loaded lazily only when the command text may name `apply_patch`): every verb reading of every statement counts, after quotes, backslashes and `$'…'` are undone and a directory prefix is cut, including `bash -c`/`eval` payloads up to depth 4, and a word left unexpanded (`apply_${p}atch`) that still carries the name. So a quoted mention (`git commit -m "fix; apply_patch handling"`, `echo "(apply_patch)"`, a line inside another heredoc) and the lookups `command -v apply_patch`, `which apply_patch`, `grep -rn apply_patch src` are allowed, while every invocation that is not the plain heredoc form is denied as unreadable: `time apply_patch < p.diff`, `x=1 apply_patch < p.diff`, `sudo -u me apply_patch < p.diff`, `sudo -X val apply_patch < p.diff` (unknown option with an argument), `$'apply_patch' < p.diff`, `apply_${p}atch < p.diff`, `bash -c 'apply_patch < p.diff'`. A heredoc behind a prefix (`nice -n 5 apply_patch <<'EOF'`) is not read and is denied: Codex's recogniser reads only the plain form, and `env -C dir` or `sudo -D dir` would move the base directory. Cost, measured 2026-11-02 in one process: `ls -la` 0.0004 ms per call without loading the tokenizer; a 40-section heredoc (3.4 KB) 0.06 ms. **Ceiling:** the tokenizer sees only the command text. A name that exists only at run time (`$CMD < p.diff` with `CMD=apply_patch`, a name built by `printf` or read from a file), an expansion inside the name other than a bare `${x}`, `$x` or `$( )`, and another program that runs it (`xargs apply_patch`, `find -exec`, `python -c`, `perl -e`) are not seen and allow. Revisit trigger: one such invocation in a real Codex session.
- **Array form.** A shell call with `["apply_patch","<patch>"]` is a router error (`invalid type: sequence, expected a string`) and runs 0 hooks. The `input`/`patch` keys and the array `command` from GitHub #83 were never observed, so the adapter no longer reads them, and they deny.

**Not measured:** a run under a fresh `CODEX_HOME` (without a login the call ends 401 before any hook runs); live runs of the `<<-EOF` heredoc, the pipe form and `apply-patch`; Add/Delete/Move patches on the shell route; the TUI instead of `exec`; Windows.

**Measured (2026-11-02, codex-cli 0.160.1):** a `Bash` PreToolUse deny stops Codex's **internal** application of the heredoc completely. The file stays unchanged, there is no `file_change` event, and the model gets the router error `Command blocked by PreToolUse hook: <reason>` as a tool error; the turn still exits 0. All three deny forms work: `hookSpecificOutput.permissionDecision: "deny"` (what `emitDeny` writes), `{"decision":"block"}`, and exit 2 with stderr. The real adapter denied a heredoc patch on `.orchestrator/metrics/sessions.jsonl` under profile `standard`, and one on `.orchestrator/STATE.md` under `SO_HOOK_PROFILE=strict`. **Ceiling:** the shell route protects only with the guards the host profile switches on. Under profile `standard` a heredoc patch on `.orchestrator/STATE.md` goes through, because `pre-tool-state-md-path-guard` is in `STANDARD_OFF_HOOKS` (the same as for Claude Edit/Write). `tests/hooks/codex-apply-patch-guards-wiring.test.mjs` runs the registered adapter command on both routes. `tests/hooks/codex-bash-guards-wiring.test.mjs` runs every registered Bash command on the measured payload.

These per-event gaps are tracked as documented asymmetries in `scripts/lib/validate/check-hooks-symmetry.mjs` (Check 6, `handlerAsymmetries`) — an UNDOCUMENTED one-platform-only handler fails validation.

An empty `SubagentStart` array means the event belongs to the validated Codex surface but currently has no payload-compatible handler. It does not mean installation or hook trust failed.

## Usage

After installation or refresh, start a fresh task. In the desktop composer, open the skill picker, search for `go` or `close`, and select the matching **Session Orchestrator** entry. In Codex CLI or the IDE extension, use `/skills` or mention the namespaced skill directly in your prompt. [OpenAI skill invocation](https://learn.chatgpt.com/docs/build-skills)

```text
$session-orchestrator:bootstrap         # once per repository, before the first session
$session-orchestrator:session           # start with the deep default
$session-orchestrator:session housekeeping  # maintenance session
$session-orchestrator:session deep      # explicit deep session
$session-orchestrator:go                # execute the agreed plan
$session-orchestrator:close             # verify and close the session
$session-orchestrator:plan feature      # plan a project or feature (new, feature or retro)
$session-orchestrator:discovery         # run quality probes; optionally add a scope
$session-orchestrator:evolve analyze    # manage learnings (analyze, review or list)
```

These are skill invocations in the Codex prompt, not shell commands. Invoking `go` reads the full canonical `skills/go/SKILL.md`, including its Express Path and prechecks; invoking `close` reads `skills/close/SKILL.md`, including its state and ledger checks before the session-end workflow. Codex's native `/goal` is a separate feature. Typing `/go` or `/close` alone is not a portable invocation contract; select the skill or use its explicit namespaced form.

**First session on Codex.** The README's three steps map to `$session-orchestrator:bootstrap`, `$session-orchestrator:session feature`, `$session-orchestrator:go` and `$session-orchestrator:close`. In headless Claude Code (`claude -p`), use `/session-orchestrator:session` and `/session-orchestrator:plan`; the bare names are reserved there ([details](install.md#headless-claude-code-claude--p-two-commands-need-the-namespaced-form)).

### Start, modes, and free-text instructions

The public start entry is named **`session`**. There is no separate `start`, `housekeeping`, or `deep` skill: the latter two are arguments to `session`. `session-start` is the internal workflow and bypasses the public entry's argument resolution when invoked directly. Use `session` for the normal start → go → close flow. Claude Code exposes `/session-orchestrator:session housekeeping`; Codex exposes the skill invocation shown above. [Official skill invocation guidance](https://learn.chatgpt.com/docs/build-skills)

An empty argument selects `deep`; this is a command default, not a missing setting in `config.toml`. `auto-skill-dispatch` controls optional implicit routing and does not register commands or change the default. An explicit mode is the first token; the remaining text supplies task context, for example `$session-orchestrator:session housekeeping mit parallelen Subagents in Wellen`. `ultradeep` resolves to `deep` with the `ultradeep` profile.

Ordinary housekeeping resolves to one coordinator-direct maintenance wave. An explicit request for parallel agents or multiple waves overrides that execution shape for the current run; record the deviation and actual plan instead of silently changing the mode or global configuration. Native parallel execution is available in Codex and Claude Code; Cursor and Pi retain their documented execution limits in [the platform tool reference](../skills/_shared/platform-tools.md).

Measured on macOS with Codex Desktop/CLI **0.153.4**, 2026-09-19: the enabled installed plugin returned `session`, `go`, and `close` through native `skills/list`, with no loading errors. The repository-local `.agents/skills/` surface omitted the command-only `session` entry before the portable generator repair. This is distinct from an installation failure. The portable generator now includes command-only entries and carries native invocation policy in `agents/openai.yaml`; `go` and `close` remain explicitly invoked workflows. Native discovery verifies loading, not the completion of an entire session or the live desktop picker's cached state.

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

`CODEX_PLUGIN_ROOT` is **session-orchestrator's own compatibility export, not a variable Codex provides.** The hook wrapper in `hooks/hooks-codex.json` assigns it from Codex's native `${PLUGIN_ROOT}` so that shared code (`scripts/lib/plugin-root.mjs`) can read one name on every harness. Nothing outside a hook command string sets it — in particular an MCP server started by Codex inherits neither `CODEX_PLUGIN_ROOT` nor `PLUGIN_ROOT`. That is why `.mcp.json` resolves the plugin root on its own instead of relying on a harness-provided variable: it tries `PLUGIN_ROOT`, then `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `CURSOR_RULES_DIR` and `PI_PLUGIN_ROOT` (the one matching `SO_PLATFORM` first), then a global npm install (`$(npm root -g)/session-orchestrator`), and as the last tier scans the client plugin caches (`${CODEX_HOME:-$HOME/.codex}` and `$HOME/.claude` under `plugins/cache/*/session-orchestrator/*`, accepted only when the copy's `package.json` names `session-orchestrator`; newest by mtime wins). The working directory is never searched: the server starts inside your project, and nothing in that project is taken as the plugin. The tier order is documented once, in `scripts/lib/plugin-root.mjs` § TIER ORDER, together with the points where `.mcp.json` differs from it. Each candidate must actually contain `scripts/mcp-server.sh` before it is used.

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
- **The `kanevry` marketplace points at another source:** confirm the conflict with `codex plugin marketplace list --json`, run `codex plugin marketplace remove kanevry`, then rerun the installer from the intended clone so it re-packs it and performs the public marketplace add and plugin add lifecycle.
- **`go` or `close` is missing from the skill picker:** follow [the refresh steps](#refresh-and-explicit-cache-invalidation), verify the installed version, and restart Codex if reopening the picker does not load the new entries. Use the namespaced skill form from [Usage](#usage), rather than selecting the unrelated native Goal command.
- **Plugin is installed and enabled but hooks do not fire:** start a fresh task or fully restart Codex, run `/hooks`, and review the trust state. Installation does not imply hook approval.
- **No import-probe warning after an edit:** the post-edit import probe is currently **unwired in Codex**. Reinstalling the same bundle does not add it. Use normal project lint and tests; see [the probe's harness wiring and ESLint requirements](USER-GUIDE.md#import-probe-warnings-and-missing-eslint).
- **Other pre-public plugin/config/cache/hook-state residue is suspected:** this state is unsupported. Do not modify private Codex files. File an issue with `codex --version`, `codex plugin list --available --json`, and `codex plugin marketplace list --json` output so the public recovery path can be diagnosed.
- **Agent dispatch fails:** verify Codex multi-agent support and inspect the bundled or project-level role TOMLs.
- **Hooks report that Node is unavailable:** expose Node 24+ on the Codex hook PATH or set `SO_NODE_BIN` to the absolute Node executable.
- **`MCP startup failed: handshaking with MCP server failed: connection closed: initialize response`:** the MCP entrypoint could not locate the plugin, or could not run. Read the server's **stderr** — since GH#64 it names itself. Two diagnostics exist:
  - `session-orchestrator: cannot locate the plugin root` — no plugin-root variable pointed at a directory with `scripts/mcp-server.sh`, there was no global npm install, and no cached copy of the plugin was found. Fix: reinstall the plugin so a cached copy exists (see *Where the plugin actually lives* below), or add `PLUGIN_ROOT` (or `CODEX_PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`) pointing at the plugin directory to that server's `env` block. Do not expect Codex to supply the variable — see the note under *Key Differences* above.
  - **Running the MCP server from a development clone:** the entrypoint no longer picks up the clone just because Codex was started inside it. Either set `PLUGIN_ROOT` to the clone in the server's `env` block, or install the clone as a local marketplace (`node scripts/codex-install.mjs` from the clone) so a cached copy exists.
  - `session-orchestrator: 'jq' not found in PATH` — the plugin was found but `jq` is missing. Fix: install `jq` and restart Codex. (Before GH#64 this case wrote a JSON-RPC error to *stdout* with `id: null`, which is not a valid `initialize` response either, so a missing `jq` and a missing plugin were indistinguishable from the client side.)
- **The MCP tools answer `Error: not inside a git repository`:** expected, not a failure. The handshake succeeded; `session_config` and `session_metrics` read the *project* you are working in, so they need Codex's working directory to be inside a git repository. Start Codex from the project, or `cd` into it.
- **"another session holds the lock" right after `resume`/`compact` in Codex:** the session lock appears to be self-collision across a resume/compact boundary rather than a real second session. Cause: before v3.23.0 (unreleased at time of writing), `parseSessionId()`'s UUID matcher was pinned to version nibble `4` (Claude Code's format), so every native session id Codex CLI mints — UUIDv7 — failed to parse; `hooks/on-session-start.mjs` fell through to a freshly generated `randomUUID()` on each `SessionStart`, and the new mint then collided with the lock the previous mint still held (Kanevry#66 / #1091). Fixed in v3.23.0 by widening `UUID_RE` in `scripts/lib/session-id.mjs` to accept any RFC 9562 UUID version 1–8, not only `4`. Check: `node -e "import('./scripts/lib/session-id.mjs').then(m=>console.log(m.parseSessionId('017f22e2-79b0-7cc3-98c4-dc0c0c07398f')))"` must print `format: 'uuid'` and `version: 7` (verified 2026-08-28 @ 30940cb — it does).
- **A one-shot `codex exec` run and its lock (#1889):** at Stop, `hooks/on-stop.mjs` releases the run's own `.orchestrator/session.lock` when line 0 of the rollout named by `transcript_path` is a `session_meta` record whose `payload.source` is the string `"exec"` (a subagent thread carries an object there and does not count). The release is owner-proven against the raw stdin `session_id`, and the Stop record carries `codex_exec` and `lock_released` (see `docs/events-schema.md`). Since #1919 (codex-cli 0.160+) `SessionEnd` also releases the lock and deregisters the session through `hooks/on-session-end.mjs`, for interactive sessions as well; when the Stop release already ran, SessionEnd finds no lock and does nothing (benign). A crash or Ctrl-C still leaves the lock to the Codex lock TTL of 0.5 h (`hooks/on-session-start.mjs`; Claude Code keeps 4 h). Rollouts live under the active `CODEX_HOME`, not necessarily `~/.codex/sessions/`: measured 2026-11-02 on codex-cli 0.160.1 with a managed `CODEX_HOME` (a CodexBar `managed-codex-homes/<uuid>/` home), they sat under that home, so take the path from `transcript_path` rather than assuming `~/.codex/sessions/`.
- **A `codex exec` lock that stays behind (#1874):** plugin 5.17.0 has neither the Stop release above nor `SessionEnd`, so every Codex run on it leaves its lock until the 4 h TTL; the 0.5 h Codex TTL arrives together with the fix (measured 2026-11-09: 8 Codex locks acquired in this repo's ledger, 0 released; `hooks-codex.json` of `v5.17.0` has no `SessionEnd`). Both are fixed in the first release after 5.17.0. After updating to it, open `/hooks` and review the new `SessionEnd` entry: the trust state in `~/.codex/config.toml` is kept per hook entry, and a host trusted on 5.17.0 has no `session_end` entry. The `Stop` definition is byte-identical between `v5.17.0` and the first version carrying the Stop release, so `codex exec` runs should keep releasing through `Stop`; that comparison is measured, a real upgrade on a trusted host is not.

### Where the plugin actually lives (measured 2026-08-28, codex-cli 0.141.0; re-measured 2026-11-02, codex-cli 0.160.1)

Three facts explain why launching Codex from `$HOME` used to kill the MCP server before `initialize` (GH Kanevry/session-orchestrator#64), and none of them is guessable from the docs:

1. **Codex copies the plugin; it does not run it from your clone.** A marketplace install lands at `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/` — measured here as `~/.codex/plugins/cache/local/session-orchestrator/<version>+codex.<stamp>/`, a full self-contained tree with its own `.mcp.json`, `package.json` and `scripts/mcp-server.sh`. Claude Code uses the same shape under `~/.claude/plugins/cache/`.
2. **The MCP child gets no plugin-root variable and no working directory of its own.** Probing a registered MCP server launched from `/tmp` showed `PWD=/private/tmp` (the launch directory, verbatim) and `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `PLUGIN_ROOT` and `CODEX_HOME` **all unset**; `codex mcp list` prints `Env: -` and `Cwd: -` for the entry. `HOME` *is* set. (That was 0.141.0 on 2026-08-28; the 0.160.1 re-measurement below did not reproduce the `PWD` value.) So from `$HOME` — not a git repository — every locator the entrypoint had was blind, and `$(git rev-parse --show-toplevel)` collapsed the path to `/scripts/mcp-server.sh`.
3. **Codex does not expand `${...}` in the registered command, and the registration is a snapshot.** `codex mcp list` shows the launch string verbatim, `${CLAUDE_PLUGIN_ROOT:-…}` and all — bash expands it, not Codex. It comes from the *cached* `.mcp.json`, taken at install time: a fix committed to this repo reaches an existing install only after a reinstall.

The entrypoint therefore scans those cache roots itself, matching on `package.json` `"name": "session-orchestrator"` rather than on the directory name, and preferring the most recently installed copy. A directory that merely *sits* under a `session-orchestrator/` marketplace folder is rejected.

**If your install predates this fix, reinstall — the fix cannot reach a cached copy on its own:**

```bash
codex plugin marketplace add Kanevry/session-orchestrator
codex mcp list | grep session-orchestrator   # the launch string should mention plugins/cache
```

Facts 1–3 were first measured on **0.141.0** (2026-08-28), below the minimum documented at the time (0.144.4). **Re-measured 2026-11-02 on codex-cli 0.160.1** (the reporter's 0.149.0-alpha.4.3 was not re-measured):

- **Cache path:** unchanged form `<CODEX_HOME>/plugins/cache/<marketplace>/session-orchestrator/<version>/`, depth 3; the version is `<semver>+codex.<stamp>` (example `5.17.0+codex.20261101111338` under marketplace `local`). The cached `.mcp.json` is byte-identical to the repo's. A local-clone install carries `node_modules` (241 entries), `.git`, `.env.local` and `.orchestrator` (see #1518 above); the `kanevry` short-form path has no `node_modules`.
- **MCP child environment:** a probe MCP server (`codex exec -C <tmp> --ephemeral --sandbox read-only -c 'mcp_servers.envprobe.command="node"' -c 'mcp_servers.envprobe.args=[...]'`; the server wrote `Object.keys(process.env)`) received exactly 9 variables: `HOME LANG LOGNAME PATH SHELL TERM TMPDIR USER __CF_USER_TEXT_ENCODING`. None of `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `CODEX_PLUGIN_ROOT`, `CODEX_HOME`, `PWD` was set, so the earlier `PWD=/private/tmp` is not reproduced: `PWD` is absent. Caveats: default `shell_environment_policy`, the parent was a sandboxed shell, and the child's cwd was not measured.
- **Registration:** `codex mcp list` still prints the launch string verbatim with `Env: -` and `Cwd: -`. On 0.160.1 it has no `--json`; the `codex mcp` subcommands are `list`, `get`, `add`, `remove`, `login`, `logout`.
