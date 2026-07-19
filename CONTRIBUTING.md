# Contributing to Session Orchestrator

This guide explains how to extend and modify the Session Orchestrator plugin. It covers the plugin architecture, conventions, and step-by-step instructions for adding new components.

## Table of Contents

1. [Overview](#overview)
2. [Development Setup](#development-setup)
3. [Plugin Architecture](#plugin-architecture)
4. [Skill Anatomy](#skill-anatomy)
5. [Adding a New Skill](#adding-a-new-skill)
6. [Adding a New Command](#adding-a-new-command)
7. [Adding a New Agent](#adding-a-new-agent)
8. [Modifying Existing Skills](#modifying-existing-skills)
9. [Session Config Convention](#session-config-convention)
10. [Label Taxonomy](#label-taxonomy)
11. [Platform Abstraction](#platform-abstraction)
12. [Pull Request Guidelines](#pull-request-guidelines)
13. [Good First Contribution Areas](#good-first-contribution-areas)
14. [Code of Conduct](#code-of-conduct)

---

## Overview

Session Orchestrator is a **multi-harness local orchestration plugin** that adds session-level orchestration to any project. It works with **Claude Code, Codex CLI, Cursor IDE, and Pi** — the same skills and commands across all four, with platform-adapted hooks and enforcement. It manages wave planning, VCS integration (GitHub and GitLab), parallel subagent dispatch, and quality gates. For user-facing documentation, see [README.md](README.md) and [User Guide](docs/USER-GUIDE.md); the full component inventory lives in [docs/components.md](docs/components.md).

How it works:

- The plugin is loaded by the harness at startup. Claude Code uses its marketplace flow; Codex uses the public `codex plugin marketplace add` / `codex plugin add` lifecycle through `scripts/codex-install.mjs`; Cursor IDE and Pi use their installers under `scripts/`. There is no build or compilation step.
- Skill, command, and agent surfaces are **Markdown or JSON files** the harness reads directly. Scripts, hooks, installers, and tests are **Node ESM (`.mjs`)** and run on Node.js 24+.
- You extend the plugin by editing or adding files. Changes take effect the next time the harness loads the plugin.

The user workflow is:

```
/session [type] --> Research --> Q&A --> Plan --> /go --> 5 Waves --> /close --> Verify --> Commit
```

## Development Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/Kanevry/session-orchestrator.git
   ```

2. **Install dependencies** (requires Node.js 24 or later — check with `node --version`):

   ```bash
   cd session-orchestrator && npm install
   ```

   This repo is **npm-canonical** (`package-lock.json` is the committed lockfile) — always use `npm`, never `pnpm` or `yarn`. The runtime dependencies (`zx`, `ajv`, `remark`, …) are required by the hooks and scripts.

3. **Validate your environment:**

   ```bash
   npm test                           # full vitest suite
   npm run lint                       # ESLint
   npm run typecheck                  # typecheck
   node scripts/validate-plugin.mjs   # optional: structural plugin validation
   ```

4. **Install as a local plugin** — run these slash commands inside a Claude Code session (not in your shell):

   ```text
   /plugin marketplace add /absolute/path/to/your/clone
   /plugin install session-orchestrator@kanevry
   ```

   Use the absolute path to your clone. After the install confirmation, reload Claude Code so the commands register.

   For Codex CLI, run `node scripts/codex-install.mjs`; it validates the tracked contract, drives the public marketplace/add/list commands, and leaves hook trust to a fresh task plus `/hooks`. Use `node scripts/cursor-install.mjs /path/to/project` for Cursor IDE and `node scripts/pi-install.mjs /path/to/project --settings-only` for Pi (setup guides under `docs/`).

5. **Test your changes:**

   Open any project repository and run `/session feature`. This invokes the full session flow and exercises most plugin components.

   For targeted testing:
   - `/session housekeeping` -- tests the lightweight session path
   - `/go` -- tests wave execution (requires an active session plan)
   - `/close` -- tests session close-out and verification
   - `/discovery [scope]` -- tests systematic quality discovery
   - `/plan new` -- tests structured project planning and PRD generation

There is no build or compilation step — edit the files, reload the harness, and test. Dependency installation (`npm install`) is required once after cloning and again whenever `package-lock.json` changes.

### Git Blame Hygiene

Run once after cloning: `git config blame.ignoreRevsFile .git-blame-ignore-revs`
Skips large mechanical sweeps (import-alias rollouts, mass migrations) in
`git blame` — see `.git-blame-ignore-revs` for the current list.

## Plugin Architecture

The plugin has four component types, each in its own directory:

### Skills (`skills/<name>/SKILL.md`)

Skills are the core logic units. Each skill is a Markdown file with YAML frontmatter that provides instructions to Claude.

**Frontmatter fields:**

| Field         | Required | Description                                      |
|---------------|----------|--------------------------------------------------|
| `name`        | Yes      | Unique identifier for the skill                  |
| `description` | Yes      | Multi-line description of what the skill does     |

**Key characteristics:**
- Loaded by the harness when invoked by commands or other skills
- Self-contained -- each skill includes all the context it needs to operate
- Skills can invoke other skills (e.g., `session-start` invokes `session-plan`)
- A skill directory may contain supporting files (e.g., `soul.md` alongside `SKILL.md`)

**Current skills:** see the full inventory in [docs/components.md](docs/components.md) — the single source of truth for skill, command, agent, and hook counts.

### Commands (`commands/<name>.md`)

Commands are user-facing entry points that map slash commands to skill invocations.

**Frontmatter fields:**

| Field           | Required | Description                                         |
|-----------------|----------|-----------------------------------------------------|
| `description`   | Yes      | Shown in Claude Code's command list                  |
| `allowed-tools` | Yes      | List of tools the command can use, or `"*"` for all |
| `argument-hint` | No       | Shown as placeholder text (e.g., `[housekeeping\|feature\|deep]`) |

**Key characteristics:**
- The `$ARGUMENTS` variable receives whatever the user types after the command name
- Commands should be thin wrappers -- delegate logic to skills
- Each command maps to one primary skill

**Current commands:** see [docs/components.md](docs/components.md) for the full slash-command list.

### Agents (`agents/<name>.md`)

Agents are subagent definitions dispatched by the wave-executor during parallel execution.

**Frontmatter fields:**

| Field         | Required | Description                                                     |
|---------------|----------|-----------------------------------------------------------------|
| `name`        | Yes      | Agent identifier                                                |
| `description` | Yes      | Must include `<example>` blocks showing invocation context       |
| `model`       | Yes      | Model to use (e.g., `sonnet`)                                   |
| `color`       | Yes      | Terminal color for agent output (e.g., `cyan`)                  |
| `tools`       | Yes      | List of tools the agent can access (e.g., `["Read", "Grep"]`)  |

**Key characteristics:**
- Agents run with **zero prior context** -- they receive only the prompt from wave-executor
- Must be fully self-contained: include all review criteria, output formats, and instructions
- The `<example>` blocks in the description are required by Claude Code for agent dispatch

**Current agents:** see [docs/components.md](docs/components.md) for the full roster. The authoritative authoring spec — frontmatter contract, `sandbox-tier`, `output-schema`, validation commands — is [`agents/AGENTS.md`](agents/AGENTS.md).

### Hooks (`hooks/hooks.json`)

Hooks fire on specific harness events. The plugin currently wires 10 hook event types (see [docs/components.md](docs/components.md) for the full list); `hooks/hooks.json` is the Claude Code wiring, with platform variants in `hooks/hooks-codex.json`, `hooks/hooks-cursor.json`, and `hooks/hooks-pi.json`.

**Format:** JSON following the Claude Code hooks specification. Hook implementations are Node ESM (`.mjs`) files invoked through the `hooks/run-node.sh` shim. Excerpt from the real `hooks/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh\" \"$CLAUDE_PLUGIN_ROOT/hooks/on-session-start.mjs\"",
            "timeout": 5,
            "async": true
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "sh \"$CLAUDE_PLUGIN_ROOT/hooks/run-node.sh\" \"$CLAUDE_PLUGIN_ROOT/hooks/pre-bash-destructive-guard.mjs\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Current hook wiring** (excerpt — the full 10-event-type Claude inventory is in [docs/components.md](docs/components.md)):
- `SessionStart` — version banner + session initialization (`hooks/on-session-start.mjs`)
- `PreToolUse` (Edit/Write) — scope enforcement via `hooks/enforce-scope.mjs`
- `PreToolUse` (Bash) — destructive-command guard (`hooks/pre-bash-destructive-guard.mjs`), command restrictions (`hooks/enforce-commands.mjs`), templates-first gate, staging fence, and more

Codex deliberately exposes only the six validated project event slots in `hooks/hooks-codex.json`: `SessionStart`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, and `Stop`. Claude-only events are absent because Codex does not support them as project events. The Claude Edit/Write handlers are also absent because Codex supplies canonical `apply_patch` payloads; do not wire those handlers until a real adapter translates that payload into the contract they enforce.

Codex hook commands must use native `${PLUGIN_ROOT}` and the exact wrapper shape validated by `scripts/lib/codex/plugin-contract.mjs`: set `SO_PLATFORM=codex`, export `CODEX_PLUGIN_ROOT="${PLUGIN_ROOT}"` for shared compatibility code, then invoke `hooks/run-node.sh`. Plugin installation and hook trust are independent: contributors must test in a fresh Codex task and review `/hooks`; installers must never write or bypass trust state.

## Skill Anatomy

Skills are the most common thing you will add or modify. Here is a detailed breakdown.

### Structure

```markdown
---
name: my-skill
description: >
  Multi-line description of what the skill does
  and when it should be invoked. This text appears
  in Claude Code's skill listing.
---

# Skill Title

## Section 1: Setup / Prerequisites
Instructions for initial checks, config reading, etc.

## Section 2: Core Logic
The main work the skill performs. Be specific about
which tools to use, what commands to run, and what
output to produce.

## Section 3: Output Format
Define the exact format for the skill's output.
Use code blocks for structured output templates.
```

### Writing Principles

1. **Skills are instructions for Claude, not documentation for humans.** Write them as directives: "Run this command", "Check this condition", "Output this format".

2. **Be specific.** Include exact CLI commands, file paths, tool names, and expected outputs. Do not say "check the git state" -- say "run `git status --short` and `git log origin/main..HEAD --oneline`".

3. **Include acceptance criteria.** Each major step should define what "done" looks like. For example: "Pipeline status must be green (exit code 0). If red, report the failure and pause."

4. **Reference Session Config for configurable behavior.** If a value might differ across repos (number of agents, VCS type, CLI tools), read it from Session Config rather than hardcoding it.

5. **Use tables for structured data.** Config fields, CLI commands, label mappings -- tables make these scannable.

6. **Degrade gracefully.** If a config field is missing or a tool is unavailable, skip the relevant section and note it in the output. Do not fail the entire skill.

### Example: Minimal Skill

```markdown
---
name: lint-check
description: >
  Runs project linters and reports findings. Invoked
  during wave-executor quality checks.
---

# Lint Check

## Step 1: Detect Linter

Check `package.json` for lint scripts:

- If `scripts.lint` exists: use `pnpm lint`
- If `scripts.eslint` exists: use `pnpm eslint .`
- Otherwise: report "No linter configured" and exit

## Step 2: Run Linter

```bash
pnpm lint 2>&1 | tail -50
```

Capture the exit code. If non-zero, parse the output for error count and file locations.

## Step 3: Output

```
## Lint Report
- **Status**: PASS / FAIL
- **Errors**: [count]
- **Warnings**: [count]
- **Files**: [list of files with errors]
```
```

## Adding a New Skill

1. **Create the skill directory and file:**

   ```
   skills/my-skill/SKILL.md
   ```

2. **Add YAML frontmatter** with `name` and `description`:

   ```yaml
   ---
   name: my-skill
   description: >
     What this skill does and when it should be invoked.
   ---
   ```

3. **Write the skill instructions.** Follow the principles in [Skill Anatomy](#skill-anatomy). Structure the skill in numbered phases or steps.

4. **Add supporting files if needed.** Place them in the same directory (e.g., `skills/my-skill/templates.md`). Reference them from SKILL.md with instructions like "Read `templates.md` in this skill directory."

5. **If the skill should be user-invocable, create a command** (see [Adding a New Command](#adding-a-new-command)).

6. **Test the skill** by invoking it in a project repo. If it is called by another skill, trigger the parent skill and verify the chain works end to end.

## Adding a New Command

1. **Create the command file:**

   ```
   commands/my-command.md
   ```

2. **Add frontmatter:**

   ```yaml
   ---
   description: One-line description shown in Claude Code's command list
   allowed-tools: Bash, Read, Glob, Grep, Agent
   argument-hint: "[arg1|arg2]"
   ---
   ```

   Use `"*"` for `allowed-tools` if the command needs unrestricted tool access. Otherwise, list only the tools required.

3. **Write the command body.** Keep it short. A command should:
   - State what the user has requested
   - Reference `$ARGUMENTS` for user input
   - Invoke the corresponding skill
   - Set expectations ("Do NOT re-plan", "Follow the skill instructions precisely")

4. **Example:**

   ```markdown
   ---
   description: Run ecosystem health checks
   allowed-tools: Bash, Read, Glob, Grep
   argument-hint: "[all|services|pipelines]"
   ---

   # Ecosystem Health

   The user wants to check ecosystem health. Scope: **$ARGUMENTS** (default: all).

   Invoke the ecosystem-health skill. Report findings in the standard health report format.
   ```

5. **Test** by running `/<my-command>` in Claude Code.

## Adding a New Agent

1. **Create the agent file:**

   ```
   agents/my-agent.md
   ```

2. **Add frontmatter** with all required fields:

   ```yaml
   ---
   name: my-agent
   description: >
     What this agent does and when it is dispatched.

     <example>
     Context: Describe the situation where the agent is invoked.
     user: "User message that triggers dispatch"
     assistant: "Coordinator's response explaining the dispatch"
     <commentary>
     Why this agent is the right choice for this situation.
     </commentary>
     </example>
   model: sonnet
   color: green
   tools: ["Read", "Grep", "Glob", "Bash"]
   ---
   ```

   The `<example>` blocks are required. Include at least one. They help Claude Code understand when to dispatch the agent.

3. **Write the agent's instructions.** Remember:
   - The agent runs with **zero prior context**. It knows nothing about the session unless you tell it.
   - Include all review criteria, output formats, and decision logic in the file.
   - The wave-executor's dispatch prompt must provide the full task context.

4. **Define the output format.** Agents should produce structured output so the wave-executor can parse results.

5. **Test** by having wave-executor dispatch the agent, or by invoking it directly via the Agent tool in Claude Code.

## Custom Agents for Your Project

Session Orchestrator ships generic base agents (code-implementer, test-writer, ui-developer, db-specialist, security-reviewer, …) that work in any project — see [docs/components.md](docs/components.md) for the full roster. For domain-specific needs, define custom agents in your project's `.claude/agents/` directory.

### How Agent Resolution Works

When the wave-executor dispatches agents, it follows this priority:

1. **Project agents** (`.claude/agents/`) — highest priority
2. **Plugin agents** (`session-orchestrator:*`) — generic fallback
3. **`general-purpose`** — last resort

### Setting Up Project Agents

1. Create `.claude/agents/` in your project
2. Add agent `.md` files with YAML frontmatter (`name`, `description` with `<example>` blocks, `tools`, `model`)
3. Optionally add `agent-mapping` to your Session Config for explicit role binding:
   ```yaml
   agent-mapping: { impl: code-editor, test: test-specialist, db: database-architect }
   ```

### When to Use Project Agents vs. Plugin Agents

- **Plugin agents** are sufficient for most projects — they cover the common roles (code, tests, UI, DB, security)
- **Project agents** are valuable when you need domain-specific knowledge (e.g., Austrian tax compliance, specific design system rules, custom DB tooling)
- Projects can mix both: use project agents for specialized tasks and let plugin agents handle the rest

## Modifying Existing Skills

Before changing an existing skill:

1. **Read the entire skill file.** Understand all phases, dependencies, and output formats before making changes.

2. **Maintain backward compatibility with Session Config.** If a skill reads a config field, do not rename or remove it. Add new fields instead and handle the case where they are not present.

3. **Preserve the skill's contract.** Other skills and commands depend on specific output formats and behaviors. If `session-start` produces a findings summary that `session-plan` consumes, do not change the summary format without updating `session-plan`.

4. **Test in multiple project repos if possible.** Different repos have different Session Config values, VCS providers, and toolchains. A change that works in one repo may break in another.

5. **Key convention:** All configurable behavior flows through Session Config. If you are tempted to hardcode a value that might vary across repos, add it to Session Config instead.

## Session Config Convention

Session Config is the per-repo configuration mechanism. It lives in each project's `CLAUDE.md` under a `## Session Config` heading.

When adding new configurable behavior:

1. **Add the field to [`docs/session-config-reference.md`](docs/session-config-reference.md)** — the canonical type/default reference all skills point to. Include: field name, type, default value, and description.

2. **Add the field to [`docs/session-config-template.md`](docs/session-config-template.md).** The `claude-md-drift-check` skill (Check 6) enforces top-level-key parity between this repo's Session Config and the template — a field missing from the template will be flagged. Add usage guidance to `docs/USER-GUIDE.md` Section 4 if the field is user-facing.

3. **Use graceful degradation.** If the field is not present in a repo's config, the skill should either skip the related functionality or use a sensible default. Never fail because a config field is missing.

4. **Example:** To add a `my-tool-command` field, add it to `docs/session-config-reference.md` and `docs/session-config-template.md`, and in the consuming skill write: "Read `my-tool-command` from Session Config. If not set, default to `npm run my-tool`."

## Label Taxonomy

The standard label taxonomy is defined in the **Label Taxonomy** section of `skills/gitlab-ops/SKILL.md`. This is the single source of truth for all label definitions.

When your skill or agent interacts with VCS labels, reference the gitlab-ops taxonomy. If you need to add a new label category, add it to gitlab-ops first, then use it in your skill.

## Platform Abstraction

Session Orchestrator supports Claude Code, Codex CLI, Cursor IDE, and Pi. When contributing, follow these guidelines to maintain cross-platform compatibility:

### File Location Conventions

| Category | Location | Notes |
|----------|----------|-------|
| Plugin manifests | `.claude-plugin/`, `.codex-plugin/` | Platform-specific, separate files |
| Skills | `skills/` | Shared — one SKILL.md serves all platforms |
| Commands | `commands/` | Shared — Claude Code native, Codex via AGENTS.md, Cursor via rules |
| Hooks (Claude Code) | `hooks/hooks.json` | Uses `$CLAUDE_PLUGIN_ROOT` |
| Hooks (Codex) | `hooks/hooks-codex.json` | Uses native `${PLUGIN_ROOT}`; wrapper exports `CODEX_PLUGIN_ROOT` and `SO_PLATFORM=codex` |
| Hooks (Cursor) | `hooks/hooks-cursor.json` | Reference; configure in Cursor Settings |
| Hooks (Pi) | `hooks/hooks-pi.json` | Installed via `scripts/pi-install.mjs` |
| Extension (Pi) | `pi/extensions/session-orchestrator.ts` | Pi manifest lives in the `package.json` `pi` key |
| Rules (Cursor) | `.cursor/rules/*.mdc` | Cursor-native format, one per skill |
| Agents (Claude Code) | `agents/` | Markdown format |
| Agents (Codex) | `.codex-plugin/agents/` | TOML format |
| Node.js scripts | `scripts/` | Shared — use `detectPlatform()` from `scripts/lib/platform.mjs` |

### Writing Platform-Portable Skills

1. **Reference `skills/_shared/platform-tools.md`** for tool mappings between platforms
2. **Model preferences**: Add `model-preference`, `model-preference-codex`, and `model-preference-cursor` to SKILL.md frontmatter
3. **AskUserQuestion**: Add fallback note: "On Codex CLI / Cursor, present as numbered list"
4. **Agent dispatch**: Document all three patterns — Claude Code (`Agent()` tool), Codex (agent roles), Cursor (sequential execution)
5. **State paths**: Use `<state-dir>/` (`.claude/`, `.codex/`, `.cursor/`) — never hardcode a single platform
6. **Metrics paths**: Use `.orchestrator/metrics/` (shared) for learnings and sessions
7. **Config file**: Reference "Session Config in CLAUDE.md or AGENTS.md" — not just CLAUDE.md

### Writing Platform-Portable Scripts (Node.js)

1. **Import the actual exports from `platform.mjs`**: `detectPlatform()` returns the platform string; `SO_PLATFORM`, `SO_STATE_DIR`, `SO_CONFIG_FILE`, and `SO_PLUGIN_ROOT` are module constants computed at load time.
2. **Honor explicit hook context.** Codex wrappers set `SO_PLATFORM=codex` and `CODEX_PLUGIN_ROOT` from native `${PLUGIN_ROOT}`. Code that receives an explicit platform override must prefer it over ambient multi-harness detection.
3. **Never hardcode `.claude/`** — use `resolveStateDir(platform)` or `SO_STATE_DIR`.
4. **Use the shared project resolver** rather than inventing a new env chain. It supports `CLAUDE_PROJECT_DIR`, `CODEX_PROJECT_DIR`, `CURSOR_PROJECT_DIR`, and `PI_PROJECT_DIR`.
5. **Resolve plugin roots through shared helpers.** Native `PLUGIN_ROOT` wins first; a valid `SO_PLATFORM` then promotes its matching compatibility variable; remaining compatibility roots retain Claude → Codex → Cursor → Pi order before filesystem walk. Shell snippets should follow the same precedence.

## Scripts & Testing

### Script Infrastructure

| Script | Purpose |
|--------|---------|
| `scripts/parse-config.mjs` | Parse Session Config from CLAUDE.md/AGENTS.md into validated JSON (CLI wrapper over `scripts/lib/config.mjs`) |
| `scripts/run-quality-gate.mjs` | Run quality gate checks (4 variants: baseline, incremental, full-gate, per-file) |
| `scripts/validate-wave-scope.mjs` | Validate wave-scope.json before enforcement hooks consume it |
| `scripts/token-audit.sh` | Cross-project token efficiency audit |
| `scripts/codex-install.mjs` | Validate and install through Codex's public marketplace/add/list lifecycle |
| `scripts/cursor-install.mjs` | Install Cursor rules via symlinks |
| `scripts/lib/platform.mjs` | Platform detection and platform-specific root/state/config resolvers |
| `scripts/lib/common.mjs` | Shared ESM utilities — die(), warn(), findProjectRoot(), resolvePluginRoot(), makeTmpPath(), utcTimestamp() |
| `scripts/lib/worktree.mjs` | Git worktree helpers for isolated agent work |

### Running Tests

```bash
npm test              # Run the full vitest suite
npx vitest run <pattern>   # Run a specific test file / subset
```

Test files are in `tests/`. Add new tests as `tests/<area>/<name>.test.mjs` following existing patterns (hooks, lib, unit, integration, skills).

### Platform Variables

`scripts/lib/platform.mjs` exports these as **module constants** computed at load time via `detectPlatform()`:
- `SO_PLATFORM`: `claude` | `codex` | `cursor` | `pi`
- `SO_STATE_DIR`: `.claude` | `.codex` | `.cursor` | `.pi`
- `SO_CONFIG_FILE`: `CLAUDE.md` (Claude Code, Cursor) | `AGENTS.md` (Codex, Pi)
- `SO_SHARED_DIR`: `.orchestrator` (all platforms)

Do not confuse the exported `SO_PLATFORM` constant with the `SO_PLATFORM` environment override used by hook wrappers. Codex sets the environment value explicitly so downstream handlers can prefer Codex semantics even in a process that also exposes another harness variable.

### Codex Refresh and Versioning

`node scripts/codex-install.mjs` intentionally calls `codex plugin add session-orchestrator@kanevry` on every run. This refreshes the installed bundle after local edits or a pull. For an explicit cache identity change, commit a new UTC suffix in `.codex-plugin/plugin.json` using `<package-version>+codex.<YYYYMMDDHHmmss>`. The installer only validates this tracked value; it must never generate or write the manifest version during installation.

## Pull Request Guidelines

> **Note on process:** active planning happens on a private GitLab tracker; the public GitHub repository shows a mirrored subset of that work. Small, self-contained PRs that cite concrete observed drift (a stale path, a wrong count, a broken example) are the best entry point for external contributions.

- **One logical change per PR.** Do not bundle unrelated skill changes.

- **Use Conventional Commit messages:**

  ```
  feat(session-start): add ecosystem health integration
  fix(wave-executor): handle agent timeout gracefully
  docs(readme): update Session Config table
  refactor(gitlab-ops): extract label helpers
  ```

  Format: `type(scope): description`

  Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

- **Test in at least one project repo** before submitting. Run the full session flow (`/session` through `/close`) if your changes touch core skills.

- **Update README.md** if you add or change user-facing features (new commands, new config fields, changed behavior).

- **Update docs/USER-GUIDE.md** if you change workflow steps or configuration options.

- **Keep skills self-contained.** If your PR adds a cross-skill dependency, document it clearly in both skills.

## JSON Schema Validation

The plugin manifests (`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`) carry `$schema` keys pointing to canonical schemastore.org definitions. Local validation:

```bash
npx ajv-cli validate -c ajv-formats -s "https://json.schemastore.org/claude-code-plugin-manifest.json" -d .claude-plugin/plugin.json --strict=false
npx ajv-cli validate -c ajv-formats -s "https://json.schemastore.org/claude-code-marketplace.json" -d .claude-plugin/marketplace.json --strict=false
```

The same checks run in CI via the `plugin-schema-validate` job. Editors that respect `$schema` (VS Code, JetBrains) provide live autocomplete and on-save validation.

## Good First Contribution Areas

- **Setup-guide reproduction** — follow [Development Setup](#development-setup) on a fresh machine and file an issue/PR for any step that does not work as written.
- **Docs-drift fixes** — counts, paths, and examples drift as the plugin evolves. Mechanical guards exist (the `claude-md-drift-check` docs-parity check, the opt-in `docs-staleness` probe), but human-spotted drift with a concrete citation is always welcome.
- **Small parity tests** — tests that pin a doc claim to the filesystem (e.g. "every hook referenced in `hooks/hooks.json` exists") are low-risk and high-value.
- **Low-risk wording fixes** in `.claude/rules/` or `skills/` — clarify a confusing sentence, fix a stale cross-reference; pair the change with a test when the wording is load-bearing.

## Code of Conduct

This project follows a simple standard: be respectful, constructive, and welcoming.

- Provide constructive feedback in code reviews. Focus on the change, not the person.
- Welcome newcomers. Answer questions patiently.
- Assume good intent. If a contribution seems off, ask for clarification before criticizing.
- Keep discussions technical and focused. Disagreements about design are healthy; personal attacks are not.

We are building a tool that helps developers work more effectively. The same principle applies to how we work with each other.
