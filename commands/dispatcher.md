---
description: Pick the next-best repo to work on across the portfolio — rank free repos, recommend one, claim its lease atomically, and route to the entry command
argument-hint: "[--dry-run] [--repo <name>]"
---

# Dispatcher

Enumerates candidate repos below the confinement root, resolves free/busy from each repo's `session.lock` lease, ranks the FREE ones by backlog priority × staleness × readiness, recommends the single most worthwhile one, claims its lease atomically, and routes you to the chosen entry command. Invoked with arguments: **$ARGUMENTS**

## Argument Parsing

Parse `$ARGUMENTS` before doing anything else.

Recognized flags:

- `--dry-run` — run the non-mutating rank only; print the recommendation and the free-candidate table; do NOT claim any lease.
- `--repo <name>` — limit the human-readable output to a single `repoName` (informational; does not change ranking). Useful for previewing where one repo lands.
- `--start-dir <path>` — override the scan root (defaults to the confinement root).
- `--json` — emit the full `{ candidates, free, ranked, warnings, recommended }` object to stdout.

If `$ARGUMENTS` contains an unrecognized flag (starts with `--` but is not one of the above), inform the user:

```
Unknown flag '<flag>'. Recognized flags: --dry-run, --repo <name>, --start-dir <path>, --json.
```

Then continue with the remaining valid arguments.

## Handoff

**Invoke the `dispatcher` skill via the `Skill` tool.** Follow `skills/dispatcher/SKILL.md` precisely:

1. **Enumerate + Rank** — run `node scripts/lib/dispatcher/cli.mjs --json` and surface every warning.
2. **Owner-AUQ** — present the top-ranked free repo as option 1 `(Recommended)` via `AskUserQuestion` (coordinator-only).
3. **Atomic claim** — `acquire(...)` BEFORE launching; on `ok:false`, exclude the repo and re-rank.
4. **Route** — invoke the chosen entry command (`/session`, `/plan`, `/discovery`) for the claimed repo.
5. **Edge cases** — no free repo ⇒ report "all busy", offer resume/wait; never force a selection.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User/input error (bad args, bad `--start-dir`) |
| `2` | System error (unexpected dispatch failure) |

Exit codes follow `.claude/rules/cli-design.md` conventions.

## Related

- `skills/dispatcher/SKILL.md` — skill spec: enumerate → rank → AUQ → atomic claim → route (issue #678)
- `scripts/lib/dispatcher/enumerate.mjs` — candidate enumeration + free/busy resolution (#676)
- `scripts/lib/dispatcher/rank.mjs` — backlog priority × staleness × readiness scorer (#677)
- `scripts/lib/session-lock.mjs` — `acquire(...)` atomic-claim primitive (`linkSync` create-or-fail)
- `commands/portfolio.md` — cross-repo read-only health dashboard (the dispatcher's read-only sibling)
