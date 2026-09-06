---
name: hook-development
description: Use when creating, modifying, or debugging Claude Code hooks — PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, UserPromptSubmit, PreCompact, Notification. Covers the plugin `hooks/hooks.json` wrapper format vs. the user `settings.json` direct format, matchers, security patterns, `$CLAUDE_PLUGIN_ROOT` portability, lifecycle limitations, and debugging. Trigger on "add a hook", "validate tool use", "block dangerous commands", "enforce completion", "hook-based automation".
metadata:
  model: sonnet
---

# hook-development

> **Portable mirror — generated, do not edit.** The canonical skill body lives at
> [`skills/hook-development/SKILL.md`](../../../skills/hook-development/SKILL.md); read that file for the full instructions.
> This mirror carries only agentskills.io-spec-legal frontmatter so harnesses that
> discover skills under `.agents/skills/` can find and route to the skill.
>
> Regenerate with `node scripts/generate-agents-skills.mjs`.
