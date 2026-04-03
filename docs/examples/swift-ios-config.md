# Example: Swift iOS (Minimal)

This example shows a minimal Session Config for a Swift iOS project. Session Orchestrator works with any language — it orchestrates the session, not the build.

## Session Config

```
## Session Config

- **session-types:** [feature, housekeeping]
- **agents-per-wave:** 3
- **waves:** 3
- **vcs:** github
- **test-command:** xcodebuild test -scheme MyApp -destination 'platform=iOS Simulator,name=iPhone 16'
- **typecheck-command:** skip
- **special:** "Build with `xcodebuild build -scheme MyApp`."
```

## What this enables

- **Reduced scope**: 3 agents, 3 waves — appropriate for a focused iOS project
- **GitHub integration**: Uses `gh` CLI for issues and PRs
- **Custom test command**: The `special` field tells the orchestrator how to run tests
- **No TypeScript checks**: Skipped via special instructions

## What's intentionally NOT configured

- **No `pencil`**: Design reviews handled separately (Figma/Sketch workflow)
- **No `cross-repos`**: Standalone app, no shared libraries
- **No `health-endpoints`**: No backend to monitor (or backend is a separate repo)
- **No `ssot-files`**: No SSOT tracking needed
- **No `ecosystem-health`**: Disabled

## Typical session flow

1. `/session feature` — checks GitHub issues, recent commits, branch state
2. Discovery + Impl-Core wave: Reviews Swift code, implements feature across model/view/controller layers
3. Impl-Polish + Quality wave: Fixes issues, runs xcodebuild tests, quality review
4. Finalization wave: Documentation, issue updates, commit preparation
5. `/close` — commits, updates GitHub issues
