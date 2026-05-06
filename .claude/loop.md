# Bare `/loop` — Session Orchestrator Maintenance Prompt

> Replaces Anthropic's built-in `/loop` maintenance prompt with an
> orchestrator-aware variant. Picked up automatically by `/loop` (no args)
> per https://code.claude.com/docs/en/scheduled-tasks#customize-the-default-prompt-with-loop-md.

You are tending the Session Orchestrator working tree. Each iteration, walk through
the five checks below in order and report findings in **one short summary** at the
end. Skip a check silently when it has nothing to surface — do **not** narrate empty
sections. Do **not** start new initiatives outside this checklist; do **not** push,
delete, or amend without explicit authorisation in the conversation transcript.

## 1. Active-session check

If `<state-dir>/STATE.md` exists (`.claude/` on Claude Code, `.codex/` on Codex CLI):

- Read its frontmatter `status`. If not `completed`, the session is live.
- Inspect the `## Deviations` section. Surface **only entries added since the last
  iteration that are not yet acknowledged in the transcript** — older or
  already-discussed deviations stay silent.
- If `status: active` and `current-wave` is set, mention current wave + total.

## 2. Branch / MR babysitting

If `git rev-parse --abbrev-ref HEAD` is not `main`:

- Run `glab mr list -R infrastructure/session-orchestrator --source-branch "$(git rev-parse --abbrev-ref HEAD)" --output json` (or `gh pr list --head "$(git rev-parse --abbrev-ref HEAD)"`).
- For the matching MR/PR: pipeline status, unresolved review threads, merge conflicts.
- If a pipeline is running, prefer **Monitor** over re-polling next iteration —
  see `.claude/rules/loop-and-monitor.md`.

If on `main`: list any commits ahead of `origin/main` via `git log origin/main..HEAD --oneline`. Mention only — do **not** push.

## 3. Vault-mirror backlog

If `~/Projects/vault` exists:

- Count diff in `40-learnings/` and `50-sessions/`:
  `git -C ~/Projects/vault status --short 40-learnings/ 50-sessions/ | wc -l`.
- If `> 0`, surface the count and remind: GH#31 auto-commit fires at session-end
  and `evolve` runs. Manual catch-up via `node scripts/vault-mirror.mjs --since-last-commit --session-id <id>`.

## 4. Top-3 priority:high backlog

Run `glab issue list -R infrastructure/session-orchestrator --label priority:high --state opened --per-page 3 --output json` and surface `iid` + `title`. Up to three lines.

Skip silently only when the query returns zero results — surface any `priority:high` issue that exists, even a single one.

## 5. Idle path

If checks 1–4 produced nothing: emit one line — `Everything quiet on main; no MRs, no vault backlog, no high-priority issues.` Then end.

## Constraints

- **No destructive actions.** No `git push`, `git reset`, `git stash`, `rm`, `glab mr merge`, `glab issue close`, `gh pr merge` unless the conversation transcript already authorised the specific action.
- **Read-only by default.** When unsure, observe and report — let the operator decide.
- **PSA-003 applies.** This file is loaded into a coordinator session that may run in parallel with other sessions. Do not touch files you do not own.
- **Token discipline.** One short summary per iteration. No headers, no bullet lists in the output unless a check found ≥ 2 distinct items.

## See also

- `.claude/rules/loop-and-monitor.md` — when to use `/loop` vs `Monitor` vs `Routines`
- `skills/_shared/monitor-patterns.md` — vetted Monitor filter snippets
- `.claude/rules/parallel-sessions.md` — PSA discipline
