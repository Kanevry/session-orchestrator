# Fixture — Session Config in BULLET-PLAIN form

Every top-level key rendered as a markdown list item (`- key: value`), the
indent-agnostic form (fleet: `gotzendorfer-v2`).

## Session Config

- persistence: true
- enforcement: warn
- agents-per-wave: 6
- waves: 5
- vcs: gitlab
- test-command: npm test
- cross-repos: [sven, session-orchestrator]
- vault-integration:
  enabled: true
  vault-dir: ~/Projects/vault
  mode: warn

## Other Section

Not part of the config block.
