---
description: Multi-story autopilot orchestrator — runs N parallel issue pipelines in isolated git worktrees (v3.6 Phase D thin-slice)
argument-hint: "[--dry-run|--apply] [--max-stories=N] [--max-hours=H] [--inactivity-timeout=S] [--stall-seconds=S] [--draft-mr=off|on-loop-start|on-green] [--json] [--verbose]"
---

# /autopilot-multi

Use the Session Orchestrator command definition at `commands/autopilot-multi.md`.

Arguments: $@

Read that command file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
