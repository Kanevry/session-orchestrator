# Test Project

Some project description with code examples and documentation.

## Session Config

- **agents-per-wave:** 4
- **waves:** 3
- **recent-commits:** 15
- **special:** "Test project with special chars: `backtick` and 'quotes'"
- **vcs:** github
- **gitlab-host:** gitlab.example.com
- **mirror:** github
- **cross-repos:** [project-a, project-b]
- **pencil:** designs/main.pen
- **ecosystem-health:** true
- **health-endpoints:** [{name: API, url: https://api.example.com}]
- **issue-limit:** 25
- **stale-branch-days:** 5
- **stale-issue-days:** 14
- **test-command:** npm test
- **typecheck-command:** npx tsc --noEmit
- **lint-command:** npx eslint .
- **ssot-files:** [STATUS.md, ROADMAP.md]
- **ssot-freshness-days:** 3
- **plugin-freshness-days:** 14
- **discovery-on-close:** true
- **discovery-probes:** [code, arch]
- **discovery-exclude-paths:** [node_modules, dist]
- **discovery-severity-threshold:** medium
- **discovery-confidence-threshold:** 70
- **persistence:** false
- **memory-cleanup-threshold:** 3
- **enforcement:** strict
- **enforcement-gates:** { path-guard: true, command-guard: false, post-edit-validate: true }
- **reasoning-output:** true
- **grounding-check:** false
- **isolation:** worktree
- **max-turns:** 15
- **plan-baseline-path:** ~/Projects/projects-baseline
- **plan-default-visibility:** private
- **plan-prd-location:** docs/specs/
- **plan-retro-location:** docs/retros/

## Other Section

This content should not be parsed as config. It contains things like:

- **not-a-config:** this should be ignored because it's outside Session Config
- Random markdown content
