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
2. **Verdict gate (#682)** — for the recommended repo, compute `computeSuitabilityVerdict(...)` (four-gate engine). Wire the live signals through honestly: CI as `{ status: ciStatus }` (or `null` on fetch-failure — never a bare string or synthesized-absent object), the real resource verdict string (or `null` on probe-failure — never a fabricated `'green'`), and the TRUE `readRecentAutopilotRuns(...)` count (never `limit < 5`). **Verdict-gated launch:** when the effective dispatcher autonomy is `autonomous-gated` AND the verdict is green (`suitable === true`), the dispatcher MAY launch WITHOUT per-selection confirmation (skip step 3 AUQ → straight to claim). In EVERY other case (any non-`autonomous-gated` dial OR a non-suitable verdict — incl. the `FORCED: CI red` / `FORCED: resource critical` branch, which fails regardless of confidence) it INFORMS the operator of the verdict rationale + warnings, then asks before launch. **Fail-closed: never auto-launch outside the green-verdict autonomous-gated branch.**
3. **Owner-AUQ** — present the top-ranked free repo as option 1 `(Recommended)` via `AskUserQuestion` (coordinator-only). Skipped only when step 2 green-lit an autonomous launch.
4. **Atomic claim** — `acquire(...)` BEFORE launching (in BOTH branches); on `ok:false`, exclude the repo and re-rank.
5. **Route** — invoke the chosen entry command (`/session`, `/plan`, `/discovery`) for the claimed repo.
6. **Edge cases** — no free repo ⇒ report "all busy", offer resume/wait; never force a selection.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | User/input error (bad args, bad `--start-dir`) |
| `2` | System error (unexpected dispatch failure) |

Exit codes follow `.claude/rules/cli-design.md` conventions.

## Related

- `skills/dispatcher/SKILL.md` — skill spec: enumerate → rank → verdict gate → AUQ → atomic claim → route (issues #678, #682)
- `scripts/lib/dispatcher/enumerate.mjs` — candidate enumeration + free/busy resolution (#676)
- `scripts/lib/dispatcher/rank.mjs` — backlog priority × staleness × readiness scorer (#677)
- `scripts/lib/autonomy/suitability.mjs` — `computeSuitabilityVerdict(...)` four-gate verdict engine (#680, wired into launch by #682)
- `scripts/lib/config/dispatcher-autonomy.mjs` — `resolveDispatcherAutonomy(...)` effective autonomy dial (#679); opt-in by design, fail-closed to `off`
- `scripts/lib/autopilot/recent-runs.mjs` — `readRecentAutopilotRuns(...)` per-repo kill-switch-history reader feeding the verdict's G2 gate (#682)
- `scripts/lib/session-lock.mjs` — `acquire(...)` atomic-claim primitive (`linkSync` create-or-fail)
- `commands/portfolio.md` — cross-repo read-only health dashboard (the dispatcher's read-only sibling)
