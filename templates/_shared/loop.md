# Bare `/loop` — Maintenance Prompt

> Vendored from session-orchestrator `templates/_shared/loop.md`. Bare `/loop`
> (no prompt) picks this file up automatically as `.claude/loop.md` per
> https://code.claude.com/docs/en/scheduled-tasks#customize-the-default-prompt-with-loop-md.
> A user-level `~/.claude/loop.md` is the host-wide fallback; this project file
> takes precedence when present.
> Content beyond 25,000 bytes is truncated (scheduled-tasks#customize-the-default-prompt-with-loop-md).

You are tending this working tree. Each iteration, walk through the checks below
in order and report findings in **one short summary** at the end. Skip a check
silently when it has nothing to surface — do **not** narrate empty sections. Do
**not** start new initiatives outside this checklist; do **not** push, delete, or
amend without explicit authorisation in the conversation transcript.

## 1. Active-session check

If a `STATE.md` exists under the platform state dir (`.claude/STATE.md` on Claude
Code, `.codex/STATE.md` on Codex CLI):

- Read its frontmatter `status`. If not `completed`, the session is live.
- Inspect the `## Deviations` section. Surface **only entries added since the last
  iteration that are not yet acknowledged in the transcript** — older or
  already-discussed deviations stay silent.
- If `status: active` and `current-wave` is set, mention current wave + total.

If no `STATE.md` exists, skip this check silently.

## 2. Branch / MR-PR babysitting

If `git rev-parse --abbrev-ref HEAD` is not `main`:

- Detect the host from `git remote -v`: a GitLab remote → use `glab`, a GitHub
  remote → use `gh`. Let the CLI infer the project from the remote — do **not**
  pass `-R`/owner flags.
  - GitLab: `glab mr list --source-branch "$(git rev-parse --abbrev-ref HEAD)" --output json`
  - GitHub: `gh pr list --head "$(git rev-parse --abbrev-ref HEAD)"`
- For the matching MR/PR: pipeline status, unresolved review threads, merge conflicts.
- If a pipeline is running, prefer **Monitor** over re-polling next iteration —
  see `.claude/rules/loop-and-monitor.md` if the repo carries it.
- If the CLI errors or is unavailable, skip this check silently — never fail the
  iteration on a tooling error.

If on `main`: list any commits ahead of `origin/main` via
`git log origin/main..HEAD --oneline`. Mention only — do **not** push.

## 3. Vault-mirror backlog

Run this check **only** if the repo's CLAUDE.md (or AGENTS.md) `## Session Config`
declares `vault-integration.enabled: true` with a `vault-dir`. If that key is
absent, skip silently — do not assume any host path.

- Resolve `vault-dir` from Session Config (expand `~` to `$HOME`).
- If the directory exists, count uncommitted changes in its learnings/sessions
  folders, e.g. `git -C "<vault-dir>" status --short | wc -l`.
- If `> 0`, surface the count and remind that the session-end auto-commit and
  `/evolve` handle catch-up. Do **not** commit the vault yourself.

## 4. Top-3 priority:high backlog

Detect the host from `git remote -v` (as in check 2) and query, without `-R`/owner flags:

- GitLab: `glab issue list --label priority:high --state opened --per-page 3 --output json`
- GitHub: `gh issue list --label priority:high --state open --limit 3`

Surface the issue id + title — up to three lines. Skip silently when the query
returns zero results or the CLI errors. Surface any `priority:high` issue that
exists, even a single one.

## 5. Idle path

If checks 1–4 produced nothing: emit one line —
`Everything quiet; no live session, no MRs/PRs, no vault backlog, no high-priority issues.`
Then end.

## Constraints

- **No destructive actions.** No `git push`, `git reset`, `git stash`, `rm`,
  `glab mr merge`, `glab issue close`, `gh pr merge`, `gh issue close` unless the
  conversation transcript already authorised the specific action.
- **Read-only by default.** When unsure, observe and report — let the operator decide.
- **PSA-aware.** This file is loaded into a coordinator session that may run in
  parallel with other sessions. Do not touch files you do not own.
- **Token discipline.** One short summary per iteration. No headers, no bullet
  lists in the output unless a check found ≥ 2 distinct items.

## See also

- `.claude/rules/loop-and-monitor.md` — when to use `/loop` vs `Monitor` vs `Routines` (if vendored)
- `.claude/rules/parallel-sessions.md` — PSA discipline (if vendored)
