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

- `always-on/parallel-sessions.md` — PSA-001..007 multi-session discipline (detect / pause / destructive-ops / commit / STATE.md lock / grep-verification / subagent git-write ban)
- `always-on/commit-discipline.md` — atomic commits, stage-by-name, no `git add .`
- `always-on/npm-quality-gates.md` — the typecheck + test + lint triad before commit
- `always-on/verification-before-completion.md` — VBC-001..005: no completion claim without fresh, quoted verification evidence
- `always-on/receiving-review.md` — RCR-001..009: the 6-step review-handling pattern, four-class finding triage, push-back posture
- `always-on/ask-via-tool.md` — AUQ-001..006: route before you ask; structured options over prose question lists
- `always-on/test-value.md` — TV-001..005: name the bug a test catches, or do not write it; deletion is a feature
- `always-on/build-value.md` — BV-001..004: the seven-rung build ladder, the four protections never simplified away
- `always-on/cross-session-messaging.md` — CSM-001..005: messaging is transport, not shared state; no permission laundering
- `always-on/loop-and-monitor.md` — LM-001..008: routing between `/goal`, Workflows, Channels, Monitor, `/loop`, and Routines
- `always-on/bash-harness-pitfalls.md` — six false-green shell-harness failure classes (path-scoped via its own `globs:`/`paths:` frontmatter)

## opt-in-stack (vendored on match)

- `opt-in-stack/backend.md` — server actions, API routes, Express services, AI provider abstraction, observability [archetypes: nextjs-saas, express-service, docker-service]
- `opt-in-stack/backend-data.md` — Supabase/Postgres, RLS performance, migrations, caching, N+1 prevention [archetypes: nextjs-saas]
- `opt-in-stack/frontend.md` — React/Next.js, component design, styling, accessibility, forms [archetypes: nextjs-saas, nextjs-minimal]
- `opt-in-stack/swift.md` — Swift 5.9+/SwiftUI, Swift Testing, networking, error handling, SPM [archetypes: swift-app, swift-menubar-app]
- `opt-in-stack/security-web.md` — CSRF, CSP/security headers, rate limiting, output encoding [archetypes: nextjs-saas, nextjs-minimal, express-service]

## opt-in-domain (vendored on match)

- `opt-in-domain/prompt-caching.md` — Anthropic prompt caching (breakpoint placement, TTL selection, pre-warming, verification) [archetypes: nextjs-saas, express-service, docker-service, monorepo-oss, cli-tool]

## Sync mechanism

Consumer repos receive these files via `/bootstrap --sync-rules`. Re-running the command syncs every manifest category that has entries: universal entries always vendor, and archetype-tagged entries vendor only when the consumer repo's resolved archetype matches. Plugin-sourced files are overwritten while local rules are preserved (copy-on-write via the `<!-- source: session-orchestrator plugin ... -->` header on plugin files). Category entries must not share a basename, because all synced files flatten into `.claude/rules/`.
