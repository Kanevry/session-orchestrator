---
paths: [".claude/loop.md", "monitors/**", "hooks/loop-guard.mjs", "scripts/lib/autopilot/**", "skills/autopilot/**", "skills/convergence-monitoring/**", "skills/_shared/monitor-patterns.md", "skills/wave-executor/**", "docs/adr/0010-native-autonomy-commands.md"]
tier: coordinator-only
review-date: 2026-10-23
---

# Monitor Mechanics
Universal LM-001–008 routing/limits remain in loop-and-monitor.md. Build filters from skills/_shared/monitor-patterns.md: progress plus EVERY failure/terminal signature; widen if uncertain. Expiry notices re-arm, never mark success. Native version/auth/provider gates and full delta provenance: docs/adr/0010-native-autonomy-commands.md § Upstream Reference and Delta-Sync Provenance. Project loop body .claude/loop.md; runtime truncates it past 25,000 bytes.
## See Also
loop-and-monitor.md · docs/adr/0010-native-autonomy-commands.md · skills/_shared/monitor-patterns.md
