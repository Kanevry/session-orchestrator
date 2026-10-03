---
description: "Use this skill when the operator wants a prepared tmux visualization layout for the session's side-channels (STATE.md tail, CI-watch, events.jsonl tail). Renders a 4-pane default layout or debug layout. Read-only side-channel observability — the coordinator chat stays in the operator's original terminal. Trigger phrases: \"tmux layout\", \"split panes for ci watch\", \"visualize session side-channels\", \"show me state-md tail and ci\"."
---

# /tmux-layout

Use the Session Orchestrator skill definition at `skills/tmux-layout/SKILL.md`.

Arguments: $@

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
