# Install, Upgrade, Uninstall

Everything the README's short install block leaves out: the full requirement
matrix, the per-harness install commands with their caveats, how an upgrade is
detected and performed, and exactly what remains in your repository after an
uninstall.

- [Requirements](#requirements)
- [Install](#install)
- [Upgrade](#upgrade)
- [Uninstall](#uninstall)

## Requirements

| | |
|---|---|
| **Node.js** | **24 or later** (`node --version`) ; `package.json` `engines.node` is `>=24.0.0`. The plugin is ES modules and needs a real Node runtime. [Install Node.js](https://nodejs.org/). |
| **A coding agent** | Claude Code, Codex CLI, Cursor IDE, or Pi. This is a workflow layer *on top of* one of them, not a replacement. |
| **Harness version** | Codex CLI **0.144.4 or later** ([codex-setup.md](codex-setup.md)). No minimum is pinned for Claude Code, Cursor, or Pi; if `/plugin` (or the Cursor/Pi installer) runs, the plugin loads. |
| **OS** | macOS and Linux are tested in CI. Windows is untested and best-effort; shell hooks and the optional Bash/`jq` MCP server need WSL or Git Bash. |
| **Git** | A git repository. Session-orchestrator reads git state at every session start and commits at close. |

## Install

### Native Windows MCP (opt-in, #1522)

With the updated package installed, find its `installPath` using
`claude plugin list --json`, then run in PowerShell:

```powershell
node scripts/windows-setup.mjs "C:\path\to\installed\session-orchestrator"
```

Run the setup script from the updated checkout. It changes only that installed
plugin's MCP command to the current native Node executable and the absolute
`scripts/mcp-server.mjs` path, preserving other servers and keeping the original
configuration in `.mcp.json.before-windows-setup`. Restart the agent to load it.
Restore that backup to roll back. Reinstalling the plugin replaces this local
configuration; run setup again for the new install path. This opt-in avoids
accidentally selecting Windows' `bash.exe` WSL launcher. The native server has
the same two read-only tools and needs neither Bash nor jq.

Windows package staging also launches npm through its JavaScript entrypoint;
Node and npm must be installed together or npm must be on an absolute PATH.
This does **not** establish native Windows hook/guard parity: Git Bash remains
necessary for the existing shell hooks, tracked separately in #1394. The
repository-wide validation currently has a POSIX-only jq discovery step.

| Platform | Install |
|---|---|
| **Claude Code** | `/plugin marketplace add Kanevry/session-orchestrator` then `/plugin install session-orchestrator@kanevry` (run both inside Claude Code). |
| **Codex CLI** | `git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator && cd ~/Projects/session-orchestrator && npm install && node scripts/codex-install.mjs` |
| **Cursor IDE** | `git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator && cd ~/Projects/session-orchestrator && npm install && node scripts/cursor-install.mjs /path/to/your/project` |
| **Pi** | `pi install npm:session-orchestrator` ; dev fallback: `git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator && cd ~/Projects/session-orchestrator && npm install && node scripts/pi-install.mjs /path/to/your/project --settings-only` |

### Headless Claude Code (`claude -p`): two commands need the namespaced form

`session` and `plan` are reserved terminal-only built-in names in non-interactive
sessions. Under `claude -p` the bare form answers `"/session isn't available in
this environment."` — that is the harness, not the plugin, and no frontmatter or
manifest field overrides it (claude 2.1.273, measured 2026-09-16). Use the
namespaced form:

```bash
claude -p "/session-orchestrator:session deep"
claude -p "/session-orchestrator:plan feature"
```

Every other command keeps its bare form (`/go`, `/close`, `/test`, …), and
interactive sessions are unaffected.

### Claude Code: install the Node dependencies once

For Claude Code, also install the package's Node dependencies **once** and
restart Claude Code. First locate the installed plugin:

```bash
claude plugin list --json
```

Find the enabled `session-orchestrator@kanevry` entry, then replace the
placeholder below with its `installPath` value:

```bash
cd "/absolute/installPath/from/the/list" && npm install
```

If that entry is missing or disabled, resolve it through `/plugin` first. Use
the path reported for that entry; another cached version or a nested dependency
is not the installed plugin.

Setup guides: [Codex](codex-setup.md) · [Cursor IDE](cursor-setup.md) ·
[Pi](pi-setup.md). Per-IDE notes on which instruction file each harness reads:
[instruction-file-resolution](../skills/_shared/instruction-file-resolution.md).

## Upgrade

```text
/plugin update session-orchestrator@kanevry     # Claude Code
```

Restart the harness afterwards. Then check that the plugin directory (the
`installPath` from `claude plugin list --json`) has a `node_modules/`: since
Claude Code 2.1.287 the harness refuses to install dependencies for a package
whose `package.json` sets `overrides` — releases up to and including 5.4.0 do —
and reports it only as `noteDetails: [{"type": "dependencies-refused"}]` in that
JSON (measured 2026-10-02). Later releases dropped the `overrides` block. If
`node_modules/` is missing, run `npm ci --omit=dev` in that directory.

**From a clone, one command does all of it:** `npm run update:local`
(`scripts/self-update.mjs`) fast-forwards the clone, packs it with `npm pack`
into `~/.cache/session-orchestrator/plugin-package/` (`$XDG_CACHE_HOME` if set),
updates the Claude Code marketplace and plugin from that packed copy, installs
missing runtime dependencies in the plugin directory, and re-runs the Codex
installer if the plugin is installed in Codex (it installs from the same packed
copy, #1518). The marketplace must read the
packed copy, never the clone: a directory marketplace on the working checkout
copies every file of it into the plugin cache, `.env.local` included (#1515).
The Claude step refuses while any `directory` marketplace reads the clone and
prints the exact `claude plugin marketplace remove <name>` and
`claude plugin marketplace add ~/.cache/session-orchestrator/plugin-package`
commands; a GitHub- or npm-sourced marketplace updates as before.
`--dry-run` shows the commands first; old cache folders are never deleted,
because the running session still uses them until the restart. On Cursor and the Pi clone fallback, upgrade
with `git pull` in your clone followed by the same install script you originally
ran. Manage npm-installed Pi packages through Pi's package manager. For Codex,
follow the [refresh instructions](codex-setup.md#refresh-and-explicit-cache-invalidation)
for your marketplace source, then reload the skill picker or restart Codex.

### How you learn that you are behind

Session-start tells you when the running copy is behind:
`scripts/lib/plugin-update-banner.mjs` compares the version of the code **that
is actually loaded** against the published npm version and warns in the
session-start banner (minor or major; patch-only updates stay silent). It fails
silent: offline, a non-2xx response, or a malformed answer produces *no
statement*, never a false "up to date".

### Across a major version

**[migration-v5.md](migration-v5.md)** covers the current release: the
agent-status reader API changes and close-time discovery is enabled by default.
If upgrading from before v4, also follow **[migration-v4.md](migration-v4.md)**
for the removed skills, commands and scripts and their replacements.
[migration-v3.md](migration-v3.md) documents the older v2 → v3 path and the
shape both guides follow (what changes · prerequisites · per-platform steps ·
what stays · known issues · rollback).

## Uninstall

Remove the plugin through your harness's own plugin manager: `/plugin` in Claude
Code (marketplace entry `session-orchestrator@kanevry`), `codex plugin remove`
on Codex CLI ([codex-setup.md](codex-setup.md)), or Pi's package manager for an
npm-installed Pi package. On Cursor and the Pi clone fallback, delete the files
the installer wrote into your project.

### What stays behind in your repo

None of it is removed by uninstalling, and all of it is plain text you can
delete by hand:

- `.orchestrator/`: `bootstrap.lock`, `metrics/` (your session and learning JSONL records), `policy/`, `steering/`, `runtime/`, `peers/`, `session.lock`
- `STATE.md` under your harness's state directory (`.claude/STATE.md` on Claude Code; see [Platform support](../README.md#platform-support)) <!-- path-check: example -->
- The `## Session Config` block you added to your instruction file
- `.claude/rules/*.md` if you vendored the rule library via `/bootstrap --sync-rules`

Deleting `.orchestrator/metrics/` deletes your session history. Telemetry
requires explicit consent ([telemetry.md](telemetry.md)). The session-start
update check (`scripts/lib/plugin-update-banner.mjs`) makes an anonymous `GET`
to the npm registry to compare your installed version against the latest
release. Successful results are cached for 24 hours per repo; failed checks can
retry at the next session start. Set `SO_DISABLE_UPDATE_CHECK=1` (or
`DO_NOT_TRACK=1`) to turn it off.
