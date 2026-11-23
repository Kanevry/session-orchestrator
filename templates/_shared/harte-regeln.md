<!-- source: session-orchestrator plugin (canonical: templates/_shared/harte-regeln.md) -->
## Hard Rules

Non-negotiable. These hold no matter how this repo grows, even below the point
where rules move into `.claude/rules/`:

1. Never commit secrets or API keys (not even in `.env.example` comments).
2. No `git push --force` to the default branch without explicit confirmation.
3. No `git add -A` / `git add .` — stage files one by one.
4. Destructive commands (`rm -rf`, `git reset --hard`, discarding file changes
   with `git checkout`) only after explicit confirmation.
5. Status documents (STATE.md, README status sections, dashboards) are an INDEX,
   never a HISTORY. Keep them short and link to the detail.
6. Test, typecheck and lint commands in Session Config must be real checks,
   not stubs (`echo` / `noop`).
7. No `console.log` / `debugger` in committed production files.
