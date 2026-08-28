# Fixture — Session Config in YAML-FENCE form

The whole block wrapped in a fenced code block with an `yaml` info string
(fleet: `EventDrop`).

## Session Config

```yaml
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
```

## Other Section

Not part of the config block.
