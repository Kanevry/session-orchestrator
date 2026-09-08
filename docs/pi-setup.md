# Pi Setup Guide

Guide for using Session Orchestrator with [Pi](https://pi.dev/docs/latest).

## Prerequisites

- Pi installed: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`
- Node.js 24 or later for this repository's hook/runtime scripts
- A project repository with git initialized

## Installation

### Option 1: npm package (primary, once published)

```bash
pi install npm:session-orchestrator
```

This is the primary install path — the package is published to npm (since v3.16.0, 2026-07-19) and carries the `pi-package` keyword for the [Pi packages gallery](https://pi.dev/packages) index; no local checkout required. The dev-fallback options below remain available for working against a local checkout.

The short git form for Pi packages is `pi install git:github.com/user/repo@ref`. Two separate questions were previously collapsed into one "unverified" verdict; they are split here because only one of them is still open (measured 2026-09-06, W1 d10):

- **Is the syntax real?** Yes — the `git:` short form, including the `@ref` suffix, is documented upstream. The 2026-08-28 line that called the *syntax* unverified was stale and is corrected here.
- **Does it work against THIS repo?** Still unverified. The `pi` CLI is not installed on the verifying host (`which pi` → not found), so no install attempt has been made against `github.com/Kanevry/session-orchestrator`. The npm form above remains the only *measured* install path.

Do not elevate the `git:` form to README as a recommended install line until it has been run against this repo and the result dated. Citing it as valid Pi syntax is fine; citing it as a verified install path for this package is not.

### Option 2: Project-local registration (dev fallback)

```bash
git clone https://github.com/Kanevry/session-orchestrator.git ~/Projects/session-orchestrator
cd ~/Projects/session-orchestrator
npm install
node scripts/pi-install.mjs /path/to/your/project --settings-only
```

This writes `/path/to/your/project/.pi/settings.json` with a `packages` entry pointing at the local checkout. Restart or reload Pi after registration.

If you want Pi's native package installer to do the registration as well:

```bash
cd /path/to/your/project
pi install ~/Projects/session-orchestrator -l
```

### Option 3: Global registration (dev fallback)

```bash
cd ~/Projects/session-orchestrator
node scripts/pi-install.mjs --global --settings-only
```

Global mode writes `~/.pi/agent/settings.json`.

## Configuration

Pi reads `AGENTS.md` and `CLAUDE.md` natively. For Session Orchestrator on Pi, prefer `AGENTS.md` when creating a new project file; existing `CLAUDE.md` files continue to work via the shared alias rule.

Add a `## Session Config` section:

```markdown
## Session Config

agents-per-wave: 6
waves: 5
persistence: true
enforcement: warn
test-command: npm test
typecheck-command: npm run typecheck
lint-command: npm run lint
```

## What Loads

The package manifest in `package.json` exposes:

- `pi.extensions`: `./pi/extensions/session-orchestrator.ts`
- `pi.skills`: `./skills`
- `pi.prompts`: `./pi/prompts/*.md` generated from `commands/*.md`

The extension uses `hooks/hooks-pi.json` and `scripts/lib/pi-hook-bridge.mjs` to translate Pi events into the existing hook stdin contract.

## Hook Coverage

| Pi event | Session Orchestrator equivalent | Status |
|---|---|---|
| `session_start` | `SessionStart` | enabled |
| `session_shutdown` | `SessionEnd` | enabled |
| `tool_call` | `PreToolUse` | enabled for `bash`, `edit`, `write` |
| `tool_result` | `PostToolUse` | enabled |
| `agent_end` | `Stop` | enabled |

Not yet mapped in v1: `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, and `CwdChanged`.

## Usage

After reload, use the same commands:

- `/session [housekeeping|feature|deep]`
- `/go`
- `/close`
- `/plan [new|feature|retro]`
- `/discovery [scope]`
- `/evolve [analyze|review|list]`

## Differences From Claude Code And Codex

| Aspect | Claude Code | Codex | Pi |
|---|---|---|---|
| Package format | Claude plugin manifest | Codex plugin manifest | `package.json.pi` package |
| Config file | `CLAUDE.md` | `AGENTS.md` | `AGENTS.md` preferred; `CLAUDE.md` supported |
| State directory | `.claude/` | `.codex/` | `.pi/` |
| Tool guard event | `PreToolUse` | `PreToolUse` | `tool_call` bridge |
| Agent dispatch | Native Agent tool | Codex subagents / typed roles | Sequential v1 |

## Troubleshooting

- **Prompts or skills not visible**: verify the project is trusted in Pi, then restart or reload.
- **Package not loaded**: confirm `.pi/settings.json` or `~/.pi/agent/settings.json` contains the local checkout path under `packages`.
- **Hooks not firing**: confirm `package.json` still has the `pi.extensions` entry and `hooks/hooks-pi.json` exists.
- **No import-probe warning after an edit**: Pi wires the probe through `tool_result`; file eligibility, ESLint resolution, and `no-undef` configuration still apply. See [import-probe coverage and ESLint troubleshooting](USER-GUIDE.md#import-probe-warnings-and-missing-eslint).
- **Config ignored**: ensure the file has a `## Session Config` header in `AGENTS.md` or `CLAUDE.md`.
- **Runtime error from hooks**: run `npm install` in the Session Orchestrator checkout so hook dependencies are present.
