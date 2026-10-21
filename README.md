<picture>
  <source media="(prefers-color-scheme: dark)" srcset="site/brand/a3-terminalmodule/mark-on-dark.svg">
  <img src="site/brand/a3-terminalmodule/mark-on-light.svg" alt="Session Orchestrator logo: a person at a workbench with three terminal modules" width="64" align="left" hspace="12">
</picture>

# Session Orchestrator

**Your coding agents get an agreed plan, a check after each round of changes and a handover to the next session.**

A free, MIT-licensed workflow plugin for Claude Code, Codex CLI, Cursor IDE and Pi. It runs on your machine and writes plain text into your repository. No account, no server.

**[Install](#install)** · **[Website](https://session-orchestrator.com)** ([Deutsch](https://session-orchestrator.com/de)) · **[User guide](docs/USER-GUIDE.md)** · [Changelog](CHANGELOG.md)

[![Tests](https://github.com/Kanevry/session-orchestrator/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/Kanevry/session-orchestrator/actions/workflows/test.yml)
[![Version](https://img.shields.io/badge/version-5.13.0-blue.svg)](CHANGELOG.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-session--orchestrator.com-blue)](https://session-orchestrator.com)

<br clear="left">

<img src="site/img/agent-production-1536.webp" width="720" alt="Illustration: a person in an elevated control room directs small agents at separate workstations below, with a conveyor carrying finished parts to inspection and handover">

*Plan, Go, Close: one person directs, the agents work at separate stations. AI-generated illustration, not a product screenshot.*

## Why

On their own, coding agents drift from the plan, overwrite each other's files and call work done before it is checked.

| Without it | With it |
|---|---|
| You paste your working rules into every session | `/session` reads git, issues and the last session first |
| Two agents edit the same file | Each agent gets a declared file list; overlaps are rejected |
| "Done" before the tests ran | Tests and typecheck run after each implementation wave |
| A crash loses the plan | `STATE.md` records each wave; the next `/session` offers to resume |

It is built for one person running a coding agent on a git repository, possibly in several sessions at once. It runs on top of your agent and does not replace it.

## How it works

You type three commands:

- **`/session`** reads your repository, your open issues and the last session, proposes what to work on, and waits for your correction. Nothing changes in your code until you agree.
- **`/go`** runs the agreed work in waves of parallel agents, each with its own list of files. After each implementation wave your tests and typecheck run, and failures become fix tasks for the next wave.
- **`/close`** runs the full test, typecheck and lint gate, checks every planned item against what happened, commits, and files the rest as GitLab or GitHub issues for next time.

```mermaid
flowchart LR
    B["/bootstrap<br/>once per repo"] --> S["/session<br/>reads repo, proposes scope"]
    S --> A{"you agree?"}
    A -- no --> S
    A -- yes --> W1["wave 1"] --> Q1["tests + typecheck"] --> W2["wave 2 ..."]
    W2 --> F["full gate<br/>test, typecheck, lint"]
    F --> C["/close<br/>verify, commit, file the rest as issues"]
    C -. next session resumes from STATE.md .-> S
```

The session type sets the number of waves: housekeeping 1, feature 3, deep 5, the ultradeep profile 7.

<details>
<summary>What it writes into your repository</summary>

All of it plain text, all of it local:

```text
.orchestrator/bootstrap.lock        # written by /bootstrap, the gate for every later run
.orchestrator/current-session.json  # which session owns this working copy right now
.orchestrator/session.lock          # heartbeat lock; stops two sessions colliding in one checkout
.orchestrator/host.json             # host-local identity for peer-session detection
.orchestrator/metrics/*.jsonl       # append-only session, learning, event and subagent records
.orchestrator/steering/             # stable product/tech/structure context injected each session
.claude/STATE.md                    # wave progress and deviations (harness-specific directory)
```

</details>

## Install

You need Node.js 24 or later, a git repository and one of Claude Code, Codex CLI, Cursor IDE or Pi. In Claude Code:

```text
/plugin marketplace add Kanevry/session-orchestrator
/plugin install session-orchestrator@kanevry
```

| Platform | Install |
|---|---|
| **Claude Code** | The two commands above. Current Claude Code installs the Node dependencies with the plugin; on older versions [check them once](docs/install.md#claude-code-check-the-node-dependencies). |
| **Codex CLI** | `git clone` this repository, `npm install`, then `node scripts/codex-install.mjs` ([guide](docs/codex-setup.md)). |
| **Cursor IDE** | `git clone` this repository, `npm install`, then `node scripts/cursor-install.mjs /path/to/your/project` ([guide](docs/cursor-setup.md)). |
| **Pi** | `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`, then `pi install npm:session-orchestrator` ([guide](docs/pi-setup.md)). |

Optional extras, upgrade and uninstall: [docs/install.md](docs/install.md). On Claude Code, `/plugin install so-hud@kanevry` adds a status line and gates that refuse secret-printing commands and ask before pushes to `main`, merges, releases, publishes and deploys ([so-hud](mods/so-hud/README.md)).

## First session

1. **Run `/bootstrap --fast --no-interview` once in your project.** It writes `.orchestrator/bootstrap.lock` and a Session Config into your instruction file (`CLAUDE.md` on Claude Code and Cursor, `AGENTS.md` on Codex CLI and Pi).
2. **Set the three gate commands** in that Session Config to what your project actually uses:

   ```yaml
   test-command: npm test
   typecheck-command: npm run typecheck
   lint-command: npm run lint
   ```

   Every other key is optional: [template](docs/session-config-template.md) · [reference](docs/session-config-reference.md).
3. **Run `/session feature`** and describe the task. The agent reads the repository and presents a scope. Correct it, then run **`/go`** and, when the work is done, **`/close`**.

On Codex the commands are `$session-orchestrator:bootstrap`, `$session-orchestrator:session feature`, `$session-orchestrator:go` and `$session-orchestrator:close` ([Codex usage](docs/codex-setup.md#usage)). In headless Claude Code (`claude -p`), use `/session-orchestrator:session` and `/session-orchestrator:plan`; the bare names are reserved there.

## What you get

- **Know what to work on.** `/session` starts from git, open issues, recent commits and the last session record, and recommends one scope. `/plan`, `/brainstorm` and `/grill` help while an idea is still vague.
- **Errors stop at the next check.** Each wave is checked with your tests and typecheck; lint and the full suite run before the commit. `/debug` looks for the root cause before a fix.
- **Agents keep to their files.** Overlapping file lists are rejected before dispatch. A guard blocks 12 destructive command patterns (hard reset, `rm -rf`, force-push, `DROP TABLE`, …) and warns on 4.
- **Pick up where you stopped.** A crash or a second session in the same folder does not cost you the work: `STATE.md` and a heartbeat lock keep the thread.
- **It learns from your sessions, with your approval.** `/evolve` proposes learnings with a confidence score and `/reconcile` drafts rules from them; you approve or delete each one.
- **Audit and test on demand.** `/test` drives web and macOS flows end to end, `/ux-grill` audits a running web app, `/repo-audit` and `/harness-audit` score a repository, `/test-audit` removes tests that catch nothing.
- **Longer runs.** `/autopilot` chains sessions and stops on any of 10 kill-switches; `/dispatcher` and `/portfolio` work across repositories.

Every skill, command, agent and hook: [docs/components.md](docs/components.md).

## Platform support

| | Claude Code | Codex CLI | Cursor IDE | Pi |
|---|---|---|---|---|
| Commands | Native slash commands | Skills (`$session-orchestrator:<name>`) | Native slash commands | Prompt templates |
| Parallel agents | Yes | Yes | One after another | One after another |
| Destructive-command guard | Hook | Hook | Bridge for supported commands | Bridge for supported commands |
| File-scope guard | Hook (blocks in `strict`) | Instructions only | Bridge (blocks in `strict`) | Bridge (blocks in `strict`) |
| Quality gates | Full | Full | Full | Full |

All four share the same skills, commands and scripts; only the hooks differ, because each harness fires different events. Codex edits files through `apply_patch`, which the scope guard does not read ([why](docs/codex-setup.md#which-pretooluse-guards-run-on-codex--the-reason-corrected)). Event-coverage limits: [Cursor](docs/cursor-setup.md), [Pi](docs/pi-setup.md).

## Recent highlights (v5.13.0)

Highlights of the v5.13.0 line:

- **so-hud guards the session.** The optional mod refuses commands that would print a secret and asks before pushes to `main`, merges, releases, publishes and deploys.
- **Every agent names its model and effort.** No agent inherits the session model any more. On Codex the agents use `gpt-6.1-sol`; change the `model` line in `.codex-plugin/agents/*.toml` if you have no access to it.
- **Pre-push on a merge-request branch** runs a local partial gate when no remote host is free; main and tags keep the full gate.
- **Learnings from a second host** go to a separate inbox file, so two machines no longer rewrite the same `learnings.jsonl`.

Everything else: [CHANGELOG.md](CHANGELOG.md).

## Documentation

- [User guide](docs/USER-GUIDE.md): a walkthrough of one session, config, troubleshooting, FAQ
- [Install, upgrade, uninstall](docs/install.md) · [Components and design choices](docs/components.md) · [Telemetry](docs/telemetry.md) (off unless you turn it on)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [All docs](docs/README.md)

Running several sessions across repositories? The sibling project [lead-session-orchestrator](https://session-orchestrator.com/lead) coordinates them: who runs next, one queue for your decisions, one stop for everything.

## Support

Provided as-is: a community project with best-effort maintenance and no SLA. Questions, ideas and bugs go to [Issues](https://github.com/Kanevry/session-orchestrator/issues). Independent, and not affiliated with or endorsed by Anthropic, OpenAI or Cursor.

The method behind it is taught at [agenticbuilders.at](https://agenticbuilders.at); the plugin is free and does not need the courses.

## License

[MIT](LICENSE) · [Privacy policy](https://session-orchestrator.com/datenschutz) · [npm](https://www.npmjs.com/package/session-orchestrator)
