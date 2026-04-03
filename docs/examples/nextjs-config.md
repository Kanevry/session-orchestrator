# Example: Next.js + Vercel + Pencil

This example shows Session Config for a typical Next.js project with Vercel deployment, Pencil design file, and GitHub as VCS.

## Session Config

Add this to your project's `CLAUDE.md`:

```
## Session Config

- **session-types:** [housekeeping, feature, deep]
- **agents-per-wave:** 6
- **waves:** 5
- **pencil:** designs/app.pen
- **cross-repos:** [shared-ui-library]
- **ssot-files:** [.claude/STATUS.md]
- **cli-tools:** [vercel, gh]
- **mirror:** none
- **ecosystem-health:** true
- **vcs:** github
- **health-endpoints:** [{name: "Production", url: "https://myapp.vercel.app/api/health"}, {name: "Preview", url: "https://myapp-preview.vercel.app/api/health"}]
- **test-command:** pnpm test
- **typecheck-command:** pnpm typecheck
```

## What this enables

- **Pencil integration**: Design-code alignment reviews after Impl-Core and Impl-Polish waves, comparing `designs/app.pen` frames with your React components
- **Cross-repo awareness**: Checks `~/Projects/shared-ui-library` for recent changes and critical issues
- **Health monitoring**: Checks production and preview deployment health at session start
- **GitHub integration**: Uses `gh` CLI for issues, PRs, and workflow status
- **Vercel CLI**: Available for deployment-related tasks

## Typical session flow

1. `/session feature` — analyzes Next.js project state, Vercel deployments, GitHub issues
2. Wave plan accounts for frontend (React components) and backend (API routes) work
3. After Impl-Core: Pencil design review compares your implemented components with design frames
4. After Impl-Polish: Final design alignment check before Quality wave
5. `/close` — runs `pnpm typecheck`, `pnpm test`, `pnpm lint`, commits, updates GitHub issues
