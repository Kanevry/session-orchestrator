---
description: Scaffold the minimum repo structure required by session-orchestrator
argument-hint: "[--fast|--standard|--deep] [--upgrade <tier>] [--retroactive]"
---

# Bootstrap

You are running the bootstrap skill directly. The user has invoked `/bootstrap` with arguments: **$ARGUMENTS**.

**Parse $ARGUMENTS before invoking the skill:**

| Flag | Behavior |
|------|----------|
| _(no flags)_ | Auto-detect tier from context using intensity heuristic. Ask one confirmation question. |
| `--fast` | Skip tier selection. Use Fast tier directly. No confirmation question. |
| `--standard` | Skip tier selection. Use Standard tier directly. No confirmation question. |
| `--deep` | Skip tier selection. Use Deep tier directly. No confirmation question. |
| `--upgrade <tier>` | Idempotent upgrade from current tier to target (`fast → standard`, `fast → deep`, or `standard → deep`). Reads existing `bootstrap.lock`, computes the file delta (only what the target tier adds over the current tier), writes missing files, updates `bootstrap.lock` with the new tier. Refuses downgrade (e.g., `deep → fast`) with a non-zero exit. Safe to run twice — second run is a no-op. |
| `--retroactive` | For repos that already have `CLAUDE.md` + `## Session Config` but no `bootstrap.lock` (bootstrapped manually before the gate existed). Infers tier from file inventory: CI file + CHANGELOG.md → `deep`; package manifest (`package.json`/`pyproject.toml`) → `standard`; else → `fast`. Writes `.orchestrator/bootstrap.lock` with `source: retroactive`. Makes NO scaffolding changes. Commits: `chore: bootstrap lock (retroactive)`. Idempotent: if lock already exists, reports "Nothing to do" and exits 0. |
| `--sync-rules` | Copy canonical rules from the plugin's `rules/` library into the consumer repo's `.claude/rules/`. Preserves local rules (files without the plugin source header). Standalone flow — does not scaffold or modify `bootstrap.lock`. |

**Invoke the bootstrap skill.** Read `skills/bootstrap/SKILL.md` and follow its instructions with `INVOCATION_MODE = direct`.

Pass the parsed flags so the skill can skip the tier confirmation question when `--fast`, `--standard`, or `--deep` is provided. `--retroactive` and `--sync-rules` are standalone short-circuit flows — they run to completion inside SKILL.md without dispatching to a tier template.

After bootstrap completes, report the files created and the git commit hash. Do NOT automatically continue to any other skill — this is a standalone invocation.
