# Rules Library — Canonical Index

Source of truth for `.claude/rules/` vendored into consumer repos via `/bootstrap --sync-rules`.

## always-on (vendored to every consumer repo)

- `always-on/parallel-sessions.md` — PSA-001/002/003/004 multi-session discipline
- `always-on/commit-discipline.md` — atomic commits, stage-by-name, no `git add .`
- `always-on/npm-quality-gates.md` — the typecheck + test + lint triad before commit

## opt-in-stack (vendored on match)

(none yet — add as patterns emerge from advanced-repo observation)

## opt-in-domain (vendored on match)

(none yet)

## Sync mechanism

Consumer repos receive these files via `/bootstrap --sync-rules`. Re-running the command overwrites plugin-sourced files while preserving any local rules the consumer added (copy-on-write via a `<!-- source: plugin vX.Y.Z -->` header comment on plugin files).
