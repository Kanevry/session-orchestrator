# Example: Express API + GitLab

This example shows Session Config for a backend API project using Express.js, hosted on a self-managed GitLab instance.

## Session Config

```
## Session Config

- **session-types:** [housekeeping, feature, deep]
- **agents-per-wave:** 4
- **waves:** 5
- **ssot-files:** [docs/API-STATUS.md, .claude/STATE.md]
- **cli-tools:** [glab, docker]
- **ecosystem-health:** true
- **vcs:** gitlab
- **gitlab-host:** gitlab.company.com
- **health-endpoints:** [{name: "API Staging", url: "https://api-staging.company.com/health"}, {name: "API Production", url: "https://api.company.com/health"}, {name: "Database", url: "https://api-staging.company.com/health/db"}]
- **cross-repos:** [api-shared-types, deployment-configs]
- **special:** "Always run `npm run test:integration` after database-related changes. Use docker-compose for local dev."
```

## What this enables

- **GitLab integration**: Uses `glab` CLI with your self-managed GitLab instance
- **Health monitoring**: Checks staging API, production API, and database health at session start
- **Cross-repo awareness**: Monitors `api-shared-types` for type changes that affect this API, and `deployment-configs` for infrastructure changes
- **SSOT tracking**: Flags if API-STATUS.md or STATE.md haven't been updated in >5 days
- **Lower agent count**: 4 agents per wave suits a focused backend project

## Typical session flow

1. `/session feature` — checks GitLab issues, API health, cross-repo status
2. Discovery: Validates existing API endpoints, test coverage, database schema
3. Impl-Core + Impl-Polish: Implements new endpoints, updates shared types if needed
4. Quality: Runs integration tests, checks TypeScript, security review
5. `/close` — commits, updates GitLab issues, mirrors to GitHub if configured
