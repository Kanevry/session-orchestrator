# Rules Library — Canonical Index

Source of truth for `.claude/rules/` vendored into consumer repos via `/bootstrap --sync-rules`.

## Entry syntax (issue #722 Epic A Wave 3)

Each bullet is:

```
- `<category>/<file>.md` — description
- `<category>/<file>.md` — description [archetypes: archetype-a, archetype-b]
```

The optional trailing `[archetypes: ...]` tag is an allowlist, matched
case-insensitively against the consumer repo's resolved archetype (see
`scripts/lib/rules-sync.mjs` § archetype resolution). Known values include
`static-html`, `node-minimal`, `nextjs-minimal`, `python-uv`, plus any
baseline project type (`nextjs-saas`, `express-service`, `docker-service`,
`monorepo-oss`, `swift-app`, `cli-tool`, `swift-menubar-app`,
`tauri-desktop`, `astro-content-site`, `go-service`).

- **Absent tag** — universal. Vendored to every consumer repo regardless of
  archetype. This is the default and is fully backward compatible with every
  entry written before Wave 3.
- **Present tag** — scoped. Vendored ONLY when the consumer repo's resolved
  archetype matches one of the listed values (case-insensitive). Skipped
  otherwise, with a `skipped[]` reason of `archetype-mismatch` (known,
  non-matching archetype) or `archetype-unknown` (no resolvable archetype on
  the target).

## always-on (vendored to every consumer repo)

- `always-on/parallel-sessions.md` — PSA-001/002/003/004 multi-session discipline
- `always-on/commit-discipline.md` — atomic commits, stage-by-name, no `git add .`
- `always-on/npm-quality-gates.md` — the typecheck + test + lint triad before commit

## opt-in-stack (vendored on match)

(none yet — add as patterns emerge from advanced-repo observation)

## opt-in-domain (vendored on match)

(none yet)

## Sync mechanism

Consumer repos receive these files via `/bootstrap --sync-rules`. Re-running the command syncs every manifest category that has entries: universal entries always vendor, and archetype-tagged entries vendor only when the consumer repo's resolved archetype matches. Plugin-sourced files are overwritten while local rules are preserved (copy-on-write via the `<!-- source: session-orchestrator plugin ... -->` header on plugin files). Category entries must not share a basename, because all synced files flatten into `.claude/rules/`.
