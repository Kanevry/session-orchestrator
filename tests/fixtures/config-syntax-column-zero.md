# Fixture — Session Config in COLUMN-ZERO form

Plain YAML at column zero, no list dash, no bold. The form this repo's own
CLAUDE.md uses (and `agents/sven` in the fleet).

## Session Config

persistence: true
enforcement: warn
agents-per-wave: 6
waves: 5
vcs: gitlab
test-command: npm test
cross-repos: [sven, session-orchestrator]
vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn

## Other Section

Not part of the config block.
