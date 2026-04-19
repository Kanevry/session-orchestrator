# Test Project

## Session Config

persistence: true
enforcement: warn
recent-commits: 20
test-command: for f in scripts/test/test-*.sh; do bash "$f" || exit 1; done
typecheck-command: false
lint-command: false
stale-branch-days: 7
plugin-freshness-days: 30
