---
description: Scaffold the minimum repo structure required by session-orchestrator
argument-hint: [--upgrade <tier>]
---

# Bootstrap

**TL;DR — for first-time users:** Run `/bootstrap` with no flags. The skill auto-detects the right tier (fast/standard/deep) from your repo, recommends one with a one-line reason, and asks **a single confirmation question**. Bestätigen → fertig. Keine weiteren Schritte.

The flags below cover special cases (re-adopting an existing repo, upgrading a tier, syncing rules). If you don't recognize the case in the description, you don't need the flag.

---

You are running the bootstrap skill directly. The user has invoked `/bootstrap` with arguments: **$ARGUMENTS**.

> **Instruction file alias:** Bootstrap creates and reads `CLAUDE.md` (or `AGENTS.md` on Codex CLI). The two are transparent aliases — pick one, never both. Resolution rule: see `skills/_shared/instruction-file-resolution.md`.

## Standard usage (no flags)

This is the path 95 % of users want.

| Invocation | Behavior |
|------------|----------|
| `/bootstrap` | Auto-detect tier (fast / standard / deep) from repo context. Present recommendation via `AskUserQuestion` with options to confirm or override. At most ONE question in the normal case. Then scaffold files + commit. |

What the user sees:

```
Skill: "Repo leer. Empfehle 'standard' weil <reason>. Passt das?"
User: [Enter on "standard (Empfohlen)"]
Skill: <writes files, commits, prints summary>
```

## Flag reference (special cases)

Only use a flag if you have one of the situations described.

| Flag | When to use it |
|------|----------------|
| `--upgrade <tier>` | You bootstrapped `fast` earlier and now need `standard` or `deep`. Idempotent — writes only the delta. Refuses downgrade. Valid: `fast → standard`, `fast → deep`, `standard → deep`. |
| `--retroactive` | The repo already has `CLAUDE.md` (or `AGENTS.md` on Codex CLI) + `## Session Config` but no `bootstrap.lock` (manually bootstrapped before the gate existed). Writes the lock based on file inventory; **makes no scaffolding changes**. Commit: `chore: bootstrap lock (retroactive)`. |
| `--sync-rules` | Pull canonical rules from the plugin's `rules/` library into `.claude/rules/`. Preserves local rules (files without the plugin source header). Standalone — does not touch `bootstrap.lock`. |
| `--ecosystem-health` | Run the ecosystem-health wizard: detects CI provider + package manager, prompts for health endpoints, pipelines, and critical issue labels. Writes the config block + `.orchestrator/policy/ecosystem.json`. No scaffolding, no auto-commit. |
| `--fast` / `--standard` / `--deep` | Skip the tier confirmation question (e.g., for scripted runs). Equivalent to running `/bootstrap` and selecting that option. |

All flag-driven flows are idempotent — running twice with no upstream change is a no-op.

## Invoke the skill

Read `skills/bootstrap/SKILL.md` and follow its instructions with `INVOCATION_MODE = direct`.

Pass the parsed flags so the skill can skip the tier confirmation question when `--fast`, `--standard`, or `--deep` is provided. `--retroactive`, `--sync-rules`, and `--ecosystem-health` are standalone short-circuit flows — they run to completion inside SKILL.md without dispatching to a tier template.

After bootstrap completes, report the files created and the git commit hash. Do NOT automatically continue to any other skill — this is a standalone invocation.
