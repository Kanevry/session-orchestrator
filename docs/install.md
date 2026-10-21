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

“Required” means the core workflow needs it. “Feature requirement” means you
need it only when using the named feature. Install Node packages with npm; the
committed lockfile is `package-lock.json`. Do not run `pnpm install` in this
checkout. <!-- sources: package.json:26; scripts/check-package-manager.mjs:140-158,193-235 -->

Claude Code on native Windows is supported with Node.js 24 and Git for Windows
(which Claude Code itself requires). Git for Windows supplies `sh` for the hook
wrappers; the MCP server starts directly with Node and needs neither Bash, jq
nor `scripts/windows-setup.mjs`. <!-- sources: .claude-plugin/plugin.json:15-17; hooks/hooks.json:14; hooks/run-node.sh:1-29 -->

Measured on 2026-10-14 with Windows 11 (10.0.26200), Node 24.14.0, Windows
PowerShell 5.1, Git for Windows 2.55 and Claude Code 2.1.296:
<!-- sources: scripts/ci/windows-smoke.mjs:2-3,53-89,101-150; .claude-plugin/plugin.json:15-17 -->

- `claude --plugin-dir <checkout> mcp list` reported the Node MCP server as
  connected. <!-- sources: .claude-plugin/plugin.json:15-17 -->
- All 31 configured hook commands exited 0 through Git Bash, each in under
  1.5 seconds; the destructive guard denied a hard reset. <!-- sources: hooks/hooks.json:1-270; scripts/ci/windows-smoke.mjs:101-150 -->
- Quality gates captured UTF-8 output and correct exit codes, reported a missing
  command as `fail`, and ended the process tree on timeout with `taskkill /T /F`.
  Survivor reporting uses measured PIDs, or `null` when measurement is unavailable.
  Windows PowerShell 5.1 suffices; PowerShell 7 is not required.
  <!-- sources: scripts/ci/windows-smoke.mjs:53-89; scripts/lib/process-group.mjs:1010-1040 -->
- Plugin validation passed 239 checks with 0 failures; the native
  `scripts/ci/windows-smoke.mjs` probes passed 49/49 on the measurement machine.
  <!-- sources: scripts/validate-plugin.mjs:1-37; scripts/ci/windows-smoke.mjs:18-25 -->

The contributor test suite does not pass on Windows yet: 19,651 passed and 881
failed natively (2026-10-14), almost all of them POSIX assumptions inside the
tests (`sh`, `/` separators, symlinks); tracked in #1613. GitHub Actions runs it
in the informational `test-windows-suite` job and the product checks above in
`test-windows-smoke` (`windows-latest`, both non-blocking for now).

Not yet measured: a complete Claude Code run with model calls, and Codex CLI /
Cursor / Pi on native Windows. WSL counts as Linux.
<!-- sources: .github/workflows/test.yml:153-164,198-214; scripts/ci/windows-smoke.mjs:2-3 -->

### Core and installation

| Dependency | Status / version | Without it, you cannot... |
|---|---|---|
| **Node.js** | Required, **>=24.0.0**. Check `node --version`. | Run the ES-module scripts and Node hooks. <!-- sources: package.json:25-27,64-78; hooks/run-node.sh:22-29 --> |
| **Git and a git repository** | Required. | Read session-start repository state or use git-based workflow operations. <!-- sources: hooks/on-session-start.mjs:605-612; scripts/lib/quality-gate.mjs:403-468 --> |
| **A coding agent** | Required: Claude Code, Codex CLI, Cursor IDE or Pi; use the matching setup guide below. | Load commands, skills and platform integration. <!-- sources: package.json:4,112-121; .claude-plugin/plugin.json:5; scripts/codex-install.mjs:1-18; scripts/cursor-install.mjs:3-9; scripts/pi-install.mjs:1-18 --> |
| **Codex CLI version** | Feature requirement for the Codex route: **0.144.4 or later**, as documented in its setup guide. | Use the documented marketplace installation route. <!-- source: docs/codex-setup.md:7,37-56 --> |
| **Claude Code plugin support** | Required for the Claude Code route; **no minimum version is declared** in `package.json` or `.claude-plugin/plugin.json`. | Use `/plugin` installation and the Claude Code hooks. <!-- sources: package.json:25-27; .claude-plugin/plugin.json:1-19; hooks/hooks.json:6-18 --> |
| **POSIX sh** | Required for shell-wrapped hooks; Claude Code on Windows uses `sh` from Git for Windows. | Launch the configured hook wrappers, including scope and destructive-command guards. <!-- sources: hooks/hooks.json:14,49,69; hooks/run-node.sh:1-29 --> |
| **npm** | Required for clone-based dependency setup and manual dependency repair; expose it on the harness PATH. | Install missing packages, run npm scripts or update a local clone. <!-- sources: package.json:64-78; scripts/self-update.mjs:200,299; .mcp.json:8 --> |
| **Runtime Node packages** | Required, installed from `package.json`: `@babel/parser`, `ajv`, `js-yaml`, `mdast-util-to-string`, `picomatch`, `remark`, `remark-parse`, `unified`, `yaml`, `zod`, `zx`. | Load scripts importing these parsers, validators and utilities. No separate global installation is needed. <!-- source: package.json:80-92 --> |
| **Development Node packages** | Contributor requirement: `@commitlint/cli`, `@commitlint/config-conventional`, `@eslint/js`, `@vitest/coverage-v8`, `eslint`, `husky`, `lint-staged`, `prettier`, `vitest`. | Run the corresponding lint, test, coverage, formatting and git-hook tooling from the checkout. Runtime-only installs can omit them. <!-- sources: package.json:64-78,93-103 --> |
| **pnpm** | Optional, for consumer projects whose quality commands use it; this plugin checkout is npm-canonical. | Run those consumer quality commands. It is not required to install this plugin. <!-- sources: scripts/check-package-manager.mjs:140-158,193-235; .claude/rules/development.md:36-37 --> |
| **tsgo** | Optional, for a consumer project's TypeScript gate. Not declared as a dependency here. | Run a consumer gate configured to use `tsgo`; this repo's typecheck uses `node --check` instead. <!-- sources: package.json:73,80-103; scripts/typecheck.mjs:8,28 --> |

### Dependencies for individual features

| Dependency | Status / scope | Without it, you cannot... |
|---|---|---|
| **Bash** | Feature requirement for the `.mcp.json` MCP server used by Codex CLI, Cursor and Pi. Claude Code starts its MCP server with Node. | Start the shell MCP server. The [native Node MCP setup](#native-windows-mcp-opt-in) avoids Bash and jq for that server. <!-- sources: .mcp.json:4-8; .claude-plugin/plugin.json:15-17; scripts/windows-setup.mjs:7-29 --> |
| **jq** | Feature requirement for the `.mcp.json` shell MCP server (Codex CLI, Cursor and Pi); Claude Code's Node MCP does not need it. Also used by plugin validation and the shell grounding helper. | Parse MCP requests with the shell server or run `validate-plugin.mjs`; the grounding helper skips when jq is absent. The native Node MCP server does not need jq. <!-- sources: .mcp.json:4-8; .claude-plugin/plugin.json:15-17; scripts/mcp-server.sh:41-55; scripts/validate-plugin.mjs:32-37; scripts/compute-grounding-injection.sh:31-33; scripts/mcp-server.mjs:111-154 --> |
| **GitLab and authenticated glab** | Optional GitLab integration; only needed for repositories using GitLab. | Use GitLab API-backed issue and merge-request operations. GitLab is not needed for a GitHub repository. <!-- sources: scripts/lib/vault-backfill/glab.mjs:29,53; scripts/lib/autopilot/mr-draft.mjs:144 --> |
| **GitHub and authenticated gh** | Optional GitHub integration; only needed for repositories using GitHub. | Use GitHub API-backed issue, pull-request and protection-audit operations. <!-- sources: scripts/lib/autopilot/mr-draft.mjs:167; scripts/github-protection-audit.mjs:248-279 --> |
| **A Markdown notes vault (`vault-dir` / `SO_VAULT_DIR`)** | Optional: enable it in Session Config with `vault-integration.enabled: true` and `vault-integration.vault-dir`. `SO_VAULT_DIR`, a `vault-dirs:` entry in your host-local `owner.yaml` that matches the working directory, or `paths.vault-dir` there (in that order) overrides the committed path on one machine. | Run `/portfolio` (with `gitlab-portfolio` enabled it exits with an error), mirror session and learning records into the vault at `/close` and `/evolve`, keep the live-status board `01-projects/_active-sessions.md`, or get the untracked-vault-files note at `/close`. <!-- sources: scripts/lib/config/host-paths.mjs:38; scripts/lib/config.mjs:88-89,114-133; skills/portfolio/SKILL.md:34,39; scripts/lib/gitlab-portfolio/cli.mjs:193-199,211-216; skills/vault-mirror/SKILL.md:26-32,277-279; skills/session-start/SKILL.md:117-119; skills/session-start/references/phase-1-7-vault-status-board.md:7,42; skills/session-end/SKILL.md:321,323; skills/session-end/references/phase-3-documentation-updates.md:208; skills/session-end/references/phase-3-7e-vault-orphans.md:11 --> |
| **npx, Playwright and browser binaries** | Feature requirement for web end-to-end tests; install Playwright in the **target project**. | Run the web test driver. It refuses to download a missing Playwright package implicitly; install the target's browser binaries explicitly. <!-- sources: scripts/lib/playwright-driver/runner.mjs:89,258-271,301 --> |
| **@axe-core/playwright** | Optional package in the web test target. | Collect axe accessibility violations; that check is skipped when the package is absent. <!-- source: scripts/lib/playwright-driver/runner.mjs:61-80,224 --> |
| **peekaboo, macOS 15+ and UI permissions** | Feature requirement for native macOS UI tests; Screen Recording and Accessibility permissions are required. | Drive native UI tests and capture their screenshots / accessibility tree. Other platforms skip this driver. <!-- sources: skills/peekaboo-driver/SKILL.md:49-58,63-84 --> |
| **offload and a configured remote host** | Optional remote wave execution and remote pre-push gate. | Dispatch those jobs to the declared host. The coordinator invokes `offload`; its transport setup belongs to that external tool. <!-- sources: scripts/lib/wave-executor/remote-dispatch.mjs:45-47,180-184; scripts/lib/pre-push-remote-gate.mjs:58-70 --> |
| **tmux** | Optional session side-channel layout. | Create the tmux panes used to observe session progress. <!-- source: scripts/lib/tmux-layout/tmux-shell.mjs:24,64 --> |
| **ps** | Feature requirement for process and resource probes on supported POSIX hosts. | Collect the process snapshots used by resource monitoring and orphan detection. <!-- sources: scripts/lib/resource-probe/probe-platform.mjs:167; scripts/lib/orphan-reaper/ps-snapshot.mjs:164 --> |
| **sysctl, memory_pressure and vm_stat (macOS); cat (Linux); tasklist (Windows)** | Optional host resource probes, using the OS-specific tools. | Collect the corresponding swap, memory-pressure and process measurements; unsupported or failed probes return unknown. <!-- sources: scripts/lib/resource-probe/probe-platform.mjs:115-128,245-299 --> |
| **du** | Feature requirement for project hygiene size measurements. | Measure directories in that hygiene check. <!-- source: scripts/lib/project-hygiene.mjs:284 --> |
| **tar** | Feature requirement for package staging and vault-consolidation backups. | Extract the npm package during staging or create a consolidation backup. <!-- sources: scripts/lib/plugin-package-stage.mjs:129; scripts/lib/vault-consolidate-fs.mjs:294 --> |
| **awk, grep, sed and sort** | Feature requirement for the shell documentation-consistency check. | Run that check's text extraction and comparison pipeline. <!-- sources: scripts/check-doc-consistency.sh:5,117-139 --> |

The Node and shell binaries must be visible to the agent process, not just your
interactive terminal. Hook shells do not read your shell startup files; use
`SO_NODE_BIN=/absolute/path/to/node` if Node cannot be resolved on the inherited
PATH. <!-- source: hooks/run-node.sh:5-18,22-29 -->

## Install

### Native Windows MCP (opt-in)

Claude Code does not need this setup: its manifest starts the MCP server with
Node directly. This opt-in is only for harnesses that read `.mcp.json` (Codex
CLI, Cursor and Pi); their native Windows operation has not yet been measured.
<!-- sources: .claude-plugin/plugin.json:15-17; .mcp.json:4-8; scripts/windows-setup.mjs:7-29 -->

For an installed plugin in `plugins/cache`, run from the updated checkout in
PowerShell: <!-- sources: scripts/windows-setup.mjs:9-18,37-40 -->

```powershell
node scripts/windows-setup.mjs "C:\path\to\installed\session-orchestrator"
```

Run the setup script from the updated checkout, targeting the installed plugin
inside `plugins/cache` (never a Git checkout). It changes only that installed
plugin's MCP command to the current native Node executable and the absolute
`scripts/mcp-server.mjs` path, preserving other servers and keeping the original
configuration in `.mcp.json.before-windows-setup`. Restart the agent to load it.
To roll back, inspect the backup first and restore its original contents to
`.mcp.json`. Remove `.mcp.json.before-windows-setup` before running setup again.
Reinstalling the plugin replaces this local
configuration; run setup again for the new install path. This opt-in avoids
accidentally selecting Windows' `bash.exe` WSL launcher. The native server has
the same two read-only tools and needs neither Bash nor jq.
<!-- sources: scripts/windows-setup.mjs:7-34; .mcp.json:4-8; scripts/mcp-server.mjs:111-154 -->

Windows package staging launches npm through its JavaScript entrypoint, so Node
and npm must be installed together or npm must be on an absolute PATH.

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

### Claude Code: check the Node dependencies

Current Claude Code installs the plugin's Node dependencies itself during
`/plugin install` (measured 2026-09-13: a clean install of plugin 5.0.0 left a
populated `node_modules/` in the install path). Older versions did not, so
check once. First locate the installed plugin:

```bash
claude plugin list --json
```

Find the enabled `session-orchestrator@kanevry` entry, then replace the
placeholder below with its `installPath` value. The command installs only when
the dependencies are missing:

```bash
cd "/absolute/installPath/from/the/list" && { [ -d node_modules/js-yaml ] && echo "dependencies present, nothing to do" || npm install; }
```

If it ran `npm install`, restart Claude Code. If the entry is missing or
disabled, resolve it through `/plugin` first. Use the path reported for that
entry; another cached version or a nested dependency is not the installed
plugin.

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
copy). The marketplace must read the
packed copy, never the clone: a directory marketplace on the working checkout
copies every file of it into the plugin cache, `.env.local` included.
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
