---
name: hook-development
description: Use when creating, modifying, or debugging Claude Code hooks — PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, Notification. Covers the plugin `hooks/hooks.json` wrapper format vs. the user `settings.json` direct format, matchers, security patterns, `$CLAUDE_PLUGIN_ROOT` portability, lifecycle limitations, and debugging. Trigger on "add a hook", "validate tool use", "block dangerous commands", "enforce completion", "hook-based automation".
model: sonnet
---

# Hook Development for Claude Code Plugins

Use the [official Claude Code hooks reference](https://code.claude.com/docs/en/hooks) as the source of truth for current events and schemas. This skill keeps only the conventions needed to author this plugin's hooks.

## Hook types used in this plugin

Claude Code also documents `http`, `mcp_tool`, and experimental `agent` handlers. Use those only after checking their current fields and event support in the official reference.

### Prompt-based (LLM-driven, for complex reasoning)

```json
{
  "type": "prompt",
  "prompt": "Evaluate whether this event should proceed: $ARGUMENTS",
  "timeout": 30
}
```

Prompt hooks are supported only on events documented for that handler type. `$ARGUMENTS` contains the hook input JSON.

Use for: context-aware decisions, flexible evaluation, natural-language reasoning.

### Command (deterministic, for fast checks)

```json
{
  "type": "command",
  "command": "${CLAUDE_PLUGIN_ROOT}/hooks/validate.mjs",
  "timeout": 60
}
```

Use for: fast deterministic validations, file-system ops, external tools, performance-critical paths.

**Our convention:** hook logic lives in `.mjs` files — see `hooks/pre-bash-destructive-guard.mjs` and `hooks/enforce-scope.mjs`. The manifest invokes them through the repository's runtime wrapper.

## Configuration formats

Keep the file location and its outer document shape explicit when copying an example.

### Plugin `hooks/hooks.json` — wrapper format

```json
{
  "description": "Plugin hook description (optional)",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/hooks/validate.mjs" }
        ]
      }
    ]
  }
}
```

- `hooks` wrapper is required
- `description` is optional

### User or project `.claude/settings.json` — settings format

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          { "type": "command", "command": "~/my-hook.sh" }
        ]
      }
    ]
  }
}
```

- The top-level `hooks` key is required in settings.
- Plugin `hooks/hooks.json` may additionally carry a top-level `description`.

The distinction is registration and scope: settings hooks belong to a user, project, or managed policy; plugin hooks run while the plugin is enabled. The nested event → matcher group → handler shape is the same.

## Hook events

| Event | When | Use for |
|-------|------|---------|
| `PreToolUse` | Before tool runs | Validate, modify, block |
| `PostToolUse` | After tool completes | React to result, log |
| `UserPromptSubmit` | User submits prompt | Add context, validate |
| `Stop` | Main agent stopping | Completeness check |
| `SubagentStop` | Subagent stopping | Task validation |
| `SessionStart` | Session begins or resumes | Context load |
| `SessionEnd` | Session ends | Cleanup, logging |
| `PreCompact` | Before compaction | Preserve critical state |
| `Notification` | User notified | Logging, reactions |

### PreToolUse output schema

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Why this decision was made",
    "updatedInput": { "field": "modified_value" }
  },
  "systemMessage": "Explanation shown to Claude"
}
```

### Stop / SubagentStop output

```json
{
  "decision": "block",
  "reason": "Why Claude should continue",
  "systemMessage": "Additional context"
}
```

Omit `decision` to allow stopping. `approve` is not a valid Stop decision. For non-error feedback that keeps the conversation running, use `hookSpecificOutput.additionalContext` with `hookEventName` set to `Stop` or `SubagentStop`.

### SessionStart: persist env vars

```bash
echo "export PROJECT_TYPE=nodejs" >> "$CLAUDE_ENV_FILE"
```

`$CLAUDE_ENV_FILE` is unique to SessionStart hooks.

## Input schema

All hooks receive JSON on stdin:

```json
{
  "session_id": "abc123",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse"
}
```

Event-specific extras:
- `PreToolUse`: `tool_name`, `tool_input`, `tool_use_id`
- `PostToolUse`: `tool_name`, `tool_input`, `tool_response`, `tool_use_id`
- `UserPromptSubmit`: `prompt`
- `Stop`: `stop_hook_active`, `last_assistant_message`; `SubagentStop` also carries agent identity and transcript fields

Event fields vary and evolve. Parse only fields needed by the hook and consult the official event section before depending on one. The `UserPromptSubmit` field name above was last checked against the official reference on 2026-09-15 (branch `codex/ecc-systematic-review`); this plugin registers no `UserPromptSubmit` handler, so no code here exercises either spelling — verify before depending on it. Prompt and agent hooks receive the complete input through `$ARGUMENTS`.

## Environment variables

| Var | Scope | Purpose |
|-----|-------|---------|
| `$CLAUDE_PROJECT_DIR` | All | Project root |
| `$CLAUDE_PLUGIN_ROOT` | Plugin hooks | Plugin directory — **use this, never hardcode paths** |
| `$CLAUDE_ENV_FILE` | SessionStart only | Persist env vars |
| `$CLAUDE_CODE_REMOTE` | All (conditional) | Set if running remote |

### Portability rule

```json
// ✅ Portable — works everywhere the plugin installs
{ "command": "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs" }

// ❌ Broken — only works on the operator's machine
{ "command": "~/Projects/.../guard.mjs" }
```

## Matchers

```json
"matcher": "Write"                       // Exact tool
"matcher": "Read|Write|Edit"             // Multiple
"matcher": "*"                           // All tools
"matcher": "mcp__.*__delete.*"           // Regex — all MCP delete tools
"matcher": "mcp__gitlab_.*"              // Specific MCP server
```

Matchers are **case-sensitive**.

## Security best practices

### Validate inputs (command hooks)

```bash
#!/bin/bash
set -euo pipefail

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name')

if [[ ! "$tool_name" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo '{"decision": "deny", "reason": "Invalid tool name"}' >&2
  exit 2
fi
```

In Node/`.mjs` hooks (our convention), same principle — parse stdin JSON, validate structure before trusting.

### Path safety

```bash
file_path=$(echo "$input" | jq -r '.tool_input.file_path')

# Deny path traversal
[[ "$file_path" == *".."* ]] && { echo '{"decision":"deny","reason":"Path traversal"}' >&2; exit 2; }

# Deny sensitive files
[[ "$file_path" == *".env"* ]] && { echo '{"decision":"deny","reason":"Sensitive file"}' >&2; exit 2; }
```

Our `enforce-scope.mjs` implements this for wave-scope boundaries.

### Quote variables

```bash
echo "$file_path"        # ✅
cd "$CLAUDE_PROJECT_DIR" # ✅
echo $file_path          # ❌ unquoted injection risk
```

### Timeouts

Current defaults are 600 seconds for command/HTTP/MCP-tool hooks, 30 seconds for prompt hooks, and 60 seconds for agent hooks, with shorter defaults for some events. `SessionEnd` also has a shared time budget. Set a short explicit timeout appropriate to the hook; a timed-out `PreToolUse` command hook does not block the tool call.

```json
{ "type": "command", "command": "...", "timeout": 10 }
```

## Parallel execution

All matching hooks run **in parallel** — they don't see each other's output, ordering is non-deterministic. Design for independence.

## Registration and reload behavior

Installed capability and active registration are different. A plugin can ship hook files without those hooks running when the plugin is disabled. Settings hooks merge with plugin and managed hooks; `/hooks` shows the active sources.

Direct edits to hooks in settings files are normally picked up by Claude Code's file watcher. Plugin registration changes may require disabling/re-enabling the plugin or starting a fresh session. A command hook's script is launched when the event fires, so editing the script itself can affect the next invocation without re-registering the manifest.

To test a registration change, inspect `/hooks`, trigger the matching event, and use `claude --debug` when the source, matcher, output, or timeout remains unclear.

## Debugging

### Debug mode

```bash
claude --debug
```

Surfaces hook registration, execution logs, stdin/stdout JSON, timing.

### Test a command hook directly

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"/test"}}' | \
  ${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs
echo "Exit code: $?"
```

### Validate JSON output

```bash
output=$(./your-hook.mjs < test-input.json)
echo "$output" | jq .
```

Invalid structured output is normally reported as a non-blocking hook error and the action proceeds, so always verify the output and the resulting decision.

## Conditional activation

Pattern: check for a flag file or config before running:

```bash
#!/bin/bash
FLAG_FILE="$CLAUDE_PROJECT_DIR/.enable-strict-validation"
[[ ! -f "$FLAG_FILE" ]] && exit 0   # Flag not present, skip
# ... validation logic
```

Or config-based (matches our Session-Config pattern):

```bash
CONFIG_FILE="$CLAUDE_PROJECT_DIR/.claude/config.json"
enabled=$(jq -r '.strictMode // false' "$CONFIG_FILE" 2>/dev/null)
[[ "$enabled" != "true" ]] && exit 0
```

## Our in-house examples (read these, not the upstream `examples/`)

- `hooks/pre-bash-destructive-guard.mjs` — policy-driven command blocker backed by `.orchestrator/policy/blocked-commands.json`
- `hooks/enforce-scope.mjs` — scope enforcement using `wave-scope.json` in the platform's state directory
- `hooks/on-session-start.mjs` — banner + session init
- `hooks/post-edit-validate.mjs` — validates edits after the fact
- `hooks/on-stop.mjs` — session-event capture + metrics

## Do / Don't

**Do:**
- Prompt-based hooks for complex logic, command hooks for fast deterministic checks
- Always `${CLAUDE_PLUGIN_ROOT}` for paths
- Validate every input field before trusting it
- Quote all shell variables
- Set explicit timeouts for known-slow work
- Return only schema-valid structured JSON when the event needs a decision or context; emit nothing on a silent allow

**Don't:**
- Hardcoded paths
- Trust `tool_input` without validation
- Long-running hooks (blocks the tool call)
- Rely on execution order (hooks run in parallel)
- Mutate global state
- Log sensitive data to stdout/stderr

## Runtime Profile Control (#211)

All hook handlers support runtime opt-out via two environment variables without any settings-file changes. This is implemented in `hooks/_lib/profile-gate.mjs`.

### Env vars

| Variable | Values | Behaviour |
|----------|--------|-----------|
| `SO_HOOK_PROFILE` | `full` \| `minimal` \| `off` | Preset bundle (default `full` = all on). |
| `SO_DISABLED_HOOKS` | Comma-separated names | Disable individual hooks; overrides profile. |

### Profile bundles

- **`full`** (default): all hooks run — identical to pre-#211 behaviour when env is unset.
- **`minimal`**: only `on-session-start` + `pre-bash-destructive-guard`.
- **`off`**: no hooks run.

### Wiring a new hook into the gate

Every new hook handler **must** add the gate call as the very first executable statement after imports. The pattern is two lines at the top of the file, immediately after the import block:

```js
import { shouldRunHook } from './_lib/profile-gate.mjs';
if (!shouldRunHook('your-hook-name')) process.exit(0);
```

Use the kebab-case file stem without the `.mjs` extension as the hook name (e.g. `my-hook` for `hooks/my-hook.mjs`). When the hook exits 0 here it is **silent** — no stdout, no stderr — so Claude Code sees a clean allow.

### Failure modes

- Unknown `SO_HOOK_PROFILE` value → falls back to `full` + single stderr warning.
- `SO_DISABLED_HOOKS` with extra whitespace or mixed case is normalised automatically.
- `defaultEnabled` param of `shouldRunHook` is for future opt-in hooks; pass `false` for any handler that should be off by default in `full` profile.

### Tests

`tests/hooks/profile-gate.test.mjs` (10 tests) covers: full/minimal/off profiles, disabled-list override, unknown-profile fallback + warning, defaultEnabled=false, whitespace normalisation, empty disabled-list.

## Robust Plugin Root Resolution (#212)

Hook handlers and scripts that need the plugin directory must NOT read
`process.env.CLAUDE_PLUGIN_ROOT` directly. Use `resolvePluginRoot()` from
`scripts/lib/plugin-root.mjs` instead, which implements a 4-level fallback
so manual installs (where the env var is absent) still work.

### Fallback order

| Level | Source | Condition |
|-------|--------|-----------|
| 1 | `CLAUDE_PLUGIN_ROOT` env var | Returned immediately when set and is a directory |
| 2 | `CODEX_PLUGIN_ROOT` env var | Returned immediately when set and is a directory |
| 3 | Walk up from `import.meta.url` | Looks for `package.json` with `name: "session-orchestrator"` |
| 4 | Walk up from `process.cwd()` | Same marker; catches manual install paths outside the repo tree |

Levels 1 and 2 are **fast paths** — no filesystem walk is performed when either
env var is set. This preserves backward compat with all existing deployments.

When all four levels fail a `PluginRootResolutionError` is thrown with a
`triedPaths` array listing what was attempted.

### Usage in hook handlers

```js
import { resolvePluginRoot, PluginRootResolutionError } from '../scripts/lib/plugin-root.mjs';

// Throws on failure — handle or let it bubble (hooks have top-level catch)
const pluginRoot = resolvePluginRoot();
```

`scripts/lib/platform.mjs`'s `resolvePluginRoot()` delegates to this helper
internally, so any caller already using the platform module gets the 4-level
fallback transparently.

### Tests

`tests/lib/plugin-root.test.mjs` (10 tests) covers: env-claude, env-codex,
walk-from-import-meta, walk-from-cwd, all-fail-throws-named-error,
env-precedence, PluginRootResolutionError class shape.

## Implementation checklist

- [ ] Event chosen (PreToolUse / Stop / …) matches intent
- [ ] Prompt-based vs. command decided based on whether reasoning is needed
- [ ] `hooks/hooks.json` uses **wrapper** format, NOT settings direct format
- [ ] `${CLAUDE_PLUGIN_ROOT}` for all paths
- [ ] Input validation on every field you read from stdin
- [ ] Timeout set if work is known-slow
- [ ] Tested directly via `echo '...' | hook.mjs`
- [ ] Tested in-session with `claude --debug`
- [ ] README/docs updated

## References

- [Official hooks reference](https://code.claude.com/docs/en/hooks)
- Upstream: [patterns.md](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/plugin-dev/skills/hook-development/references/patterns.md), [advanced.md](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/plugin-dev/skills/hook-development/references/advanced.md) — read these for edge cases we haven't hit yet
