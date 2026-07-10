<!-- source: session-orchestrator plugin (canonical: templates/_shared/harte-regeln.md) -->
## Harte Regeln

Nicht verhandelbar — gilt unabhängig vom Wachstum dieses Repos, auch unterhalb
der `.claude/rules/`-Graduationsschwelle (#730/H6):

1. Keine Secrets/API-Keys committen (auch nicht in `.env.example`-Kommentaren).
2. Kein `git push --force` auf den Default-Branch ohne explizite Rückfrage.
3. Kein `git add -A` / `git add .` — Dateien einzeln stagen.
4. Destruktive Kommandos (`rm -rf`, `git reset --hard`, `git checkout -- <file>`)
   nur nach expliziter Bestätigung.
5. Status-Dokumente (STATE.md, README-Status-Sections, Dashboards) sind INDEX,
   nie HISTORIE — CCU-009 (see `skills/_shared/state-ownership.md` in the plugin).
6. Test-/Typecheck-/Lint-Commands in Session Config müssen echte Checks sein,
   keine Stubs (`echo`/`noop`).
7. Kein `console.log`/`debugger` in committeten Production-Files.
