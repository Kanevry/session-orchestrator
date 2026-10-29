# Install, Upgrade, Uninstall

Everything the README's short install block leaves out: the full requirement
matrix, the per-harness install commands with their caveats, how an upgrade is
detected and performed, and exactly what remains in your repository after an
uninstall.

- [Requirements](#requirements)
- [Install](#install)
- [Platform support](#platform-support)
- [Upgrade](#upgrade)
- [Uninstall](#uninstall)
- [Add-on: lead-session-orchestrator](#add-on-lead-session-orchestrator)

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
  The process table is read with PowerShell 7 when it is installed
  (`%ProgramFiles%\PowerShell\7\pwsh.exe`), otherwise with Windows PowerShell
  5.1, which sufficed on the measurement machine. On one external Windows 11 host
  5.1 crashed or timed out; survivors are then reported as not measurable
  (`null`), never as zero (#1859).
  <!-- sources: scripts/ci/windows-smoke.mjs:53-89; scripts/lib/process-group.mjs:1010-1040; scripts/lib/win-process-tree.mjs -->
- Plugin validation passed 239 checks with 0 failures; the native
  `scripts/ci/windows-smoke.mjs` probes passed 49/49 on the measurement machine;
  an external host reported 45 to 48 of 49 on 5.13.0, caused by the process-table
  query (#1859).
  <!-- sources: scripts/validate-plugin.mjs:1-37; scripts/ci/windows-smoke.mjs:18-25 -->

The SessionStart hook timeout is 10 s (it was 5 s; #1859). Configured gate
commands (`test-command`, `typecheck-command`, `lint-command`) run through
`cmd.exe` on Windows, so POSIX forms such as `VAR=1 cmd` or `2>/dev/null` fail
(closed). Write gate commands that work in `cmd.exe`, for example a
`package.json` script (GH#80 point 3).
<!-- sources: hooks/hooks.json; scripts/lib/process-group.mjs:1042-1044; scripts/lib/gates/gate-helpers.mjs:446 -->

The contributor test suite does not pass on Windows yet: 19,651 passed and 881
failed natively (2026-10-14), almost all of them POSIX assumptions inside the
tests (`sh`, `/` separators, symlinks); tracked in #1613. The 18 test files named in GH#81 now pass natively (#1860). The full suite runs on
GitLab only: the GitHub mirror carries no `tests/` directory. GitHub Actions runs
the product checks above in the informational `test-windows-smoke` job
(`windows-latest`, non-blocking for now): `npm run test:mirror`, then
`scripts/ci/windows-smoke.mjs`.

Not yet measured: a complete Claude Code run with model calls, and Codex CLI /
Cursor / Pi on native Windows. WSL counts as Linux.
<!-- sources: .github/workflows/test.yml:88-133; scripts/ci/windows-smoke.mjs:2-3 -->

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
| **Pi** | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, then `pi install npm:session-orchestrator` ; dev fallback: `git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator && cd ~/Projects/session-orchestrator && npm install && node scripts/pi-install.mjs /path/to/your/project --settings-only` |

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
`/plugin install`. Measured 2026-10-28 on macOS (Apple M4, Node 24.22.1) with
Claude Code 2.1.312 in an empty profile, against the slim snapshot the GitHub
mirror publishes for plugin 5.14.0: `claude plugin marketplace add
Kanevry/session-orchestrator` and `claude plugin install
session-orchestrator@kanevry` both exited 0, and 11 of 11 runtime packages
resolved from the install path. `/session-orchestrator:bootstrap --fast
--no-interview` wrote `.orchestrator/bootstrap.lock` and the `## Session
Config` block (149-223 s across five runs). `/session-orchestrator:session
feature ...` ended at a plan offering `/go` with no project file changed, after
the session asked one or two questions that the run answered with "1". The
questions were the scope of the change, a CI setup choice, or, in one run, the
Dispatcher Autonomy choice of session-start Phase 1.1. The model route was an
Anthropic-compatible endpoint (model `gpt-6-sol`). Without
`SO_TELEMETRY_DISABLED=1` the first session stopped at the one-time telemetry
consent question instead, because the hook asks it in headless `claude -p` runs
too (tracked in #1872). In 2 of 5 runs the plugin's SEC-008 detector reported
that a command the model chose had printed the session's own
`CLAUDE_CODE_MESSAGING_TOKEN`. That token belonged to the throwaway session and
ended with it; the cause is tracked in #1873, and those two runs are not
counted as clean. Older Claude Code versions did not install the dependencies,
so check once. First locate the installed plugin:

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

From the release after 5.14.0 on, the plugin ships `scripts/runtime-readiness.mjs`
(#1848), which does the same check without guessing. It reads one install:
declared runtime dependencies (Node's `node_modules` lookup), two import probes
in a fresh child process, and the owner-config source. Exit 0 means ready, 3 not
ready, 1 usage or target error, 2 system error (also when the import probe
itself crashed while every dependency is present). It installs nothing unless
you pass `--repair`, which runs `npm ci` (or `npm install` without a lockfile)
with `--ignore-scripts`, and with `--omit=dev` only for a plugin install: in a
git checkout it keeps the dev dependencies, so vitest and eslint survive.
`--codex` and `--claude` pick the enabled install and stop when there is more
than one:

```bash
node <installPath>/scripts/runtime-readiness.mjs [--root <dir> | --codex | --claude] [--repair] [--json]
```

Session start also runs a `runtime-readiness` banner probe (22 probes now). It
warns at every start when the install the harness loaded lacks runtime
dependencies, so a new version cache is re-checked automatically. It installs
nothing.

### Re-running the install smoke (maintainers)

`scripts/install-smoke.mjs` (#1764) repeats the measurement above from an empty
throwaway profile. Rerun it after each release:

```bash
node scripts/install-smoke.mjs --harness <claude|codex|codex-clone> --model <id> [--repair] [--json] [--out <file>]
```

Credentials come only from `SMOKE_ANTHROPIC_BASE_URL` / `SMOKE_ANTHROPIC_API_KEY`
(Claude Code) or `SMOKE_OPENAI_BASE_URL` / `SMOKE_OPENAI_API_KEY` (Codex), and
the endpoint must be Anthropic- or OpenAI-compatible. The smoke installs from
the GitHub mirror, runs the readiness check, `/bootstrap --fast
--no-interview`, and one feature session. It answers a session's questions with
"1" (up to 3), but not after the plugin's SEC-008 detector reported a secret in
a command output. It sets `SO_TELEMETRY_DISABLED=1` in the profile. It passes
only when the session ends at a plan offering `/go`, has changed no project file
(committed or not) since bootstrap, and shows a successful tool call that opened
the session skill. A `secret-hygiene` step fails the run when the detector fired.
A model that writes the requested file without planning fails the smoke; that is
recorded as model behaviour (see [Codex setup](codex-setup.md)). A readiness
step that finds missing dependencies stays failed even after `--repair` fixed
them: the documented install path alone was not runnable, and the `repair`
step records separately that the repair works.

**The smoke is not a sandbox.** The profile, caches and temp files live in a
throwaway directory, but the model steps run with
`--dangerously-skip-permissions` (Claude Code) or
`--dangerously-bypass-approvals-and-sandbox` (Codex) as your OS user. A tool
call can read or change any file you can reach by absolute path. Whoever
answers the model calls and the plugin source you install therefore act with
your rights. Run it only against an endpoint and a source you trust, or as a
separate OS user or in a VM. The model key is kept out of every tool call's
environment, but a deliberate read of the key file is not prevented.

Setup guides: [Codex](codex-setup.md) · [Cursor IDE](cursor-setup.md) ·
[Pi](pi-setup.md). Per-IDE notes on which instruction file each harness reads:
[instruction-file-resolution](../skills/_shared/instruction-file-resolution.md).

### Optional: so-hud (Claude Code)

On Claude Code, `/plugin install so-hud@kanevry` adds a status line and gates
that refuse secret-printing commands and ask before pushes to `main`, merges,
releases, publishes and deploys ([so-hud](../mods/so-hud/README.md)).

## Platform support

| | Claude Code | Codex CLI | Cursor IDE | Pi |
|---|---|---|---|---|
| Commands | Native slash commands | Skills (`$session-orchestrator:<name>`) | Native slash commands | Prompt templates |
| Parallel agents | Yes | Yes | One after another | One after another |
| Destructive-command guard | Hook | Hook | Bridge for supported commands | Bridge for supported commands |
| File-scope guard | Hook (blocks in `strict`) | Instructions only | Bridge (blocks in `strict`) | Bridge (blocks in `strict`) |
| Quality gates | Full | Full | Full | Full |
| Lead Inbox pane (add-on) | Yes (mod) | Sessions are led; the pane runs in Claude Code | Not documented | Not documented |

All four share the same skills, commands and scripts; only the hooks differ,
because each coding tool fires different events. Codex edits files through
`apply_patch`, which the scope guard does not read
([why](codex-setup.md#which-pretooluse-guards-run-on-codex--the-reason-corrected)).
On Codex the agents use `gpt-6.1-sol`; change the `model` line in
`.codex-plugin/agents/*.toml` if you have no access to it. Event-coverage
limits: [Cursor](cursor-setup.md), [Pi](pi-setup.md).

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
`node_modules/` is missing, run `npm ci --omit=dev` in that directory (older
versions), or `node <installPath>/scripts/runtime-readiness.mjs --repair` once
your installed version ships it.

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
- `STATE.md` under your harness's state directory (`.claude/STATE.md` on Claude Code; see [Platform support](#platform-support)) <!-- path-check: example -->
- The `## Session Config` block you added to your instruction file
- `.claude/rules/*.md` if you vendored the rule library via `/bootstrap --sync-rules`

Deleting `.orchestrator/metrics/` deletes your session history. Telemetry
requires explicit consent ([telemetry.md](telemetry.md)). The session-start
update check (`scripts/lib/plugin-update-banner.mjs`) makes an anonymous `GET`
to the npm registry to compare your installed version against the latest
release. Successful results are cached for 24 hours per repo; failed checks can
retry at the next session start. Set `SO_DISABLE_UPDATE_CHECK=1` (or
`DO_NOT_TRACK=1`) to turn it off.

## Add-on: lead-session-orchestrator

Running three or four sessions side by side? Then a job shows up that no single
session can do: deciding which one goes next, and answering the questions they
all ask you at the same time. That is what
[lead-session-orchestrator](https://www.npmjs.com/package/lead-session-orchestrator)
is for. One lead session sits above your sessions, prepares the decisions and
puts them into one queue for you. Session-orchestrator makes one session good
(plan, waves, gates, handover); lead-session-orchestrator keeps several of them
in line.

What you get on top:

- **One inbox instead of a row of terminals.** Open questions from every session land in one queue; in Claude Code the Inbox mod shows it in a side pane.
- **Written rules for what needs no asking.** A signed authority file per repository lists what is free, what needs your yes and what never happens. Anything not on the list asks you.
- **Checks before a run and before a merge.** Busy repository, low disk or memory, a pipeline that is not green on this exact commit: the lead refuses. It also refuses when it cannot measure.
- **A trail you can check.** Decisions and merges go into an append-only, hash-chained log.

Install with `npm i -g lead-session-orchestrator`, then run `navigator --help`.
Each works on its own. Together they talk only through files, and a session
never waits for the lead. Worth knowing before you try it: version 0.x, GitLab
only for now, tested on macOS. Setup:
[npm page](https://www.npmjs.com/package/lead-session-orchestrator) ·
[session-orchestrator.com/lead](https://session-orchestrator.com/lead).

The Inbox pane is a Claude Code mod in the same npm package (early access, not
sandboxed, Claude Code 2.1.296 or newer). Add it once from a shell, then type
`/inbox` in a new Claude Code session:

```sh
claude plugin marketplace add "$(npm root -g)/lead-session-orchestrator"
claude plugin install owner-inbox@navigator-mods
```
