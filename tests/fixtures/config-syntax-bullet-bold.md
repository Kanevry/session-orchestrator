# Fixture — Session Config in BULLET-BOLD form

Every top-level key rendered as a bold markdown list item (`- **key:** value`),
the form a fleet consumer repo uses.

## Session Config

- **persistence:** true
- **enforcement:** warn
- **agents-per-wave:** 6
- **waves:** 5
- **vcs:** gitlab
- **test-command:** npm test
- **cross-repos:** [sven, session-orchestrator]
- **vault-integration:**
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn

## Other Section

Not part of the config block.
