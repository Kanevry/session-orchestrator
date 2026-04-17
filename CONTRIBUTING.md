# Contributing to Session Orchestrator

This guide explains how to extend and modify the Session Orchestrator plugin for Claude Code. It covers the plugin architecture, conventions, and step-by-step instructions for adding new components.

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
13. [Code of Conduct](#code-of-conduct)

---

## Overview

Session Orchestrator is a **Claude Code plugin** that adds session-level orchestration to any project. It manages wave planning, VCS integration (GitHub and GitLab), parallel subagent dispatch, and quality gates. For user-facing documentation, see [README.md](README.md) and [User Guide](docs/USER-GUIDE.md).

How it works:

- The plugin is loaded by Claude Code at startup. There is no build step.
- Skills, commands, agents, and hooks are all **Markdown or JSON files** that Claude Code reads directly.
- You extend the plugin by editing or adding files. Changes take effect the next time Claude Code loads the plugin.

The user workflow is:

```
/session [type] --> Research --> Q&A --> Plan --> /go --> 5 Waves --> /close --> Verify --> Commit
```

## Development Setup

1. **Clone the repository:**

   ```bash
   git clone https://github.com/Kanevry/session-orchestrator.git
   ```

2. **Install as a local plugin** — run these slash commands inside a Claude Code session (not in your shell):

   ```text
   /plugin marketplace add /absolute/path/to/your/clone
   /plugin install session-orchestrator@kanevry
   ```

   Use the absolute path to your clone. After the install confirmation, reload Claude Code so the commands register.

3. **Test your changes:**

   Open any project repository and run `/session feature`. This invokes the full session flow and exercises most plugin components.

   For targeted testing:
   - `/session housekeeping` -- tests the lightweight session path
   - `/go` -- tests wave execution (requires an active session plan)
   - `/close` -- tests session close-out and verification
   - `/discovery [scope]` -- tests systematic quality discovery
   - `/plan new` -- tests structured project planning and PRD generation

There is no build step, no compilation, and no dependency installation. Edit the files, reload Claude Code, and test.

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
- Loaded by Claude Code when invoked by commands or other skills
- Self-contained -- each skill includes all the context it needs to operate
- Skills can invoke other skills (e.g., `session-start` invokes `session-plan`)
- A skill directory may contain supporting files (e.g., `soul.md` alongside `SKILL.md`)

**Current skills:** `session-start`, `session-plan`, `wave-executor`, `session-end`, `ecosystem-health`, `gitlab-ops`, `quality-gates`, `discovery`, `plan`, `evolve`, `vault-sync` (design brief)

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

**Current commands:** `/session`, `/go`, `/close`, `/discovery`, `/plan`

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

**Current agents:** `session-reviewer`

### Hooks (`hooks/hooks.json`)

Hooks fire on specific Claude Code events (startup, clear, compact).

**Format:** JSON following the Claude Code hooks specification.

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "echo '🎯 Session Orchestrator v2.0.0 — /session [housekeeping|feature|deep] | /plan [new|feature|retro] | /discovery [scope] | /evolve [analyze|review|list]'",
            "async": false
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PLUGIN_ROOT/hooks/enforce-scope.sh\"",
            "timeout": 5
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$CLAUDE_PLUGIN_ROOT/hooks/enforce-commands.sh\"",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Current hooks:**
- `SessionStart` — notification displaying plugin version and usage hint
- `PreToolUse` (Edit/Write) — scope enforcement via `enforce-scope.sh`
- `PreToolUse` (Bash) — command restrictions via `enforce-commands.sh`

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
   argument-hint: [arg1|arg2]
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
   argument-hint: [all|services|pipelines]
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

Session Orchestrator includes 5 generic base agents (code-implementer, test-writer, ui-developer, db-specialist, security-reviewer) that work in any project. For domain-specific needs, define custom agents in your project's `.claude/agents/` directory.

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

1. **Add the field to the Field Reference table** in `docs/USER-GUIDE.md` Section 4 (the authoritative reference for all Session Config fields). Include: field name, type, default value, and description.

2. **Add the field to `session-start` Phase 0** where all config fields are listed with brief descriptions.

3. **Use graceful degradation.** If the field is not present in a repo's config, the skill should either skip the related functionality or use a sensible default. Never fail because a config field is missing.

4. **Example:** To add a `test-command` field, add it to USER-GUIDE.md Section 4 Field Reference table, add it to session-start Phase 0 config list, and in the consuming skill write: "Read `test-command` from Session Config. If not set, default to `pnpm test --run`."

## Label Taxonomy

The standard label taxonomy is defined in the **Label Taxonomy** section of `skills/gitlab-ops/SKILL.md`. This is the single source of truth for all label definitions.

When your skill or agent interacts with VCS labels, reference the gitlab-ops taxonomy. If you need to add a new label category, add it to gitlab-ops first, then use it in your skill.

## Platform Abstraction

Session Orchestrator supports Claude Code, Codex CLI, and Cursor IDE. When contributing, follow these guidelines to maintain cross-platform compatibility:

### File Location Conventions

| Category | Location | Notes |
|----------|----------|-------|
| Plugin manifests | `.claude-plugin/`, `.codex-plugin/` | Platform-specific, separate files |
| Skills | `skills/` | Shared — one SKILL.md serves all platforms |
| Commands | `commands/` | Shared — Claude Code native, Codex via AGENTS.md, Cursor via rules |
| Hooks (Claude Code) | `hooks/hooks.json` | Uses `$CLAUDE_PLUGIN_ROOT` |
| Hooks (Codex) | `hooks/hooks-codex.json` | Uses `$CODEX_PLUGIN_ROOT` |
| Hooks (Cursor) | `hooks/hooks-cursor.json` | Reference; configure in Cursor Settings |
| Rules (Cursor) | `.cursor/rules/*.mdc` | Cursor-native format, one per skill |
| Agents (Claude Code) | `agents/` | Markdown format |
| Agents (Codex) | `.codex-plugin/agents/` | TOML format |
| Shell scripts | `scripts/` | Shared — use `$SO_*` variables from `platform.sh` |

### Writing Platform-Portable Skills

1. **Reference `skills/_shared/platform-tools.md`** for tool mappings between platforms
2. **Model preferences**: Add `model-preference`, `model-preference-codex`, and `model-preference-cursor` to SKILL.md frontmatter
3. **AskUserQuestion**: Add fallback note: "On Codex CLI / Cursor, present as numbered list"
4. **Agent dispatch**: Document all three patterns — Claude Code (`Agent()` tool), Codex (agent roles), Cursor (sequential execution)
5. **State paths**: Use `<state-dir>/` (`.claude/`, `.codex/`, `.cursor/`) — never hardcode a single platform
6. **Metrics paths**: Use `.orchestrator/metrics/` (shared) for learnings and sessions
7. **Config file**: Reference "Session Config in CLAUDE.md or AGENTS.md" — not just CLAUDE.md

### Writing Platform-Portable Shell Scripts

1. **Source `platform.sh`**: `source "$(dirname "${BASH_SOURCE[0]}")/../lib/platform.sh"` (or `|| true` for graceful fallback)
2. **Use `$SO_*` variables**: `$SO_PLATFORM`, `$SO_PLUGIN_ROOT`, `$SO_STATE_DIR`, `$SO_CONFIG_FILE`, `$SO_SHARED_DIR`
3. **Never hardcode `.claude/`** in new scripts — always use `$SO_STATE_DIR`
4. **Check all three env vars** for project root: `$CLAUDE_PROJECT_DIR`, `$CODEX_PROJECT_DIR`, `$CURSOR_PROJECT_DIR`

## Scripts & Testing

### Script Infrastructure

| Script | Purpose |
|--------|---------|
| `scripts/parse-config.sh` | Parse Session Config from CLAUDE.md/AGENTS.md into validated JSON |
| `scripts/run-quality-gate.sh` | Run quality gate checks (4 variants: baseline, incremental, full-gate, per-file) |
| `scripts/validate-wave-scope.sh` | Validate wave-scope.json before enforcement hooks consume it |
| `scripts/token-audit.sh` | Cross-project token efficiency audit |
| `scripts/cursor-install.sh` | Install Cursor rules via symlinks |
| `scripts/lib/platform.sh` | Platform detection — exports SO_PLATFORM, SO_STATE_DIR, SO_CONFIG_FILE |
| `scripts/lib/common.sh` | Shared utilities — die(), warn(), find_project_root() |
| `scripts/lib/worktree.sh` | Git worktree helpers for isolated agent work |

### Running Tests

```bash
bash scripts/test/run-all.sh    # Run all test suites
bash scripts/test/test-parse-config.sh  # Run specific suite
```

Test files are in `scripts/test/`. Each `test-*.sh` file is self-contained with setup/teardown. Add new tests by creating `scripts/test/test-<name>.sh` following existing patterns.

### Platform Variables

Scripts use these environment variables (set by `platform.sh`):
- `SO_PLATFORM`: `claude` | `codex` | `cursor`
- `SO_STATE_DIR`: `.claude` | `.codex` | `.cursor`
- `SO_CONFIG_FILE`: `CLAUDE.md` | `AGENTS.md`
- `SO_SHARED_DIR`: `.orchestrator` (all platforms)

## Pull Request Guidelines

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

## Code of Conduct

This project follows a simple standard: be respectful, constructive, and welcoming.

- Provide constructive feedback in code reviews. Focus on the change, not the person.
- Welcome newcomers. Answer questions patiently.
- Assume good intent. If a contribution seems off, ask for clarification before criticizing.
- Keep discussions technical and focused. Disagreements about design are healthy; personal attacks are not.

We are building a tool that helps developers work more effectively. The same principle applies to how we work with each other.
