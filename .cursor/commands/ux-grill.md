---
description: "Use when a running web app's UX has to be audited reproducibly rather than by feel — a deterministic mechanical pass over routes and viewports (axe, target size, horizontal overflow, page title, scripted journeys) followed by a screenshot-grounded interrogation of the operator, journey by journey, with two persona lenses from the target repo's manifest. Triggered by \"grill the UX\", \"roast the dashboard\", \"UX-Audit\", \"/ux-grill\". Bootstraps its own manifest from a loopback URL on the first run, so it never requires a hand-written file to start."
argument-hint: "[url | manifest-path]"
---

# /ux-grill

Use the Session Orchestrator skill definition at `skills/ux-grill/SKILL.md`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references `$ARGUMENTS`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read `skills/<skill-name>/SKILL.md` and follow it. Supporting files (`soul.md`, phase docs) live in that same `skills/<skill-name>/` directory.
