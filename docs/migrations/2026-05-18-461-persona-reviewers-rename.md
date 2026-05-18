# Migration: `persona-reviewers` → `wave-reviewers` (Issue #461)

## What

The Session Config key `persona-reviewers:` has been renamed to `wave-reviewers:` to align with
the terminology already used in `skills/wave-executor/wave-loop.md`.

## Why

`wave-reviewers` is the canonical name in wave-executor internals. The old key `persona-reviewers`
pre-dates the wave-executor's own language and caused confusion between two concepts:

- **persona-reviewers** (old/deprecated) — the Session Config sub-block that opted in inter-wave
  architecture/QA/PRD audits.
- **persona-panel** (new, Issue #457-#461) — a planned multi-persona content-review cluster
  (Domain-Experts + Buyer-Personas) with a distinct purpose.

Renaming to `wave-reviewers` disambiguates both features and matches the implementation in
`skills/wave-executor/wave-loop.md`.

## How to Migrate

Change your Session Config block:

```yaml
# Before (deprecated):
persona-reviewers:
  enabled: false
  reviewers: []
  mode: warn

# After (canonical):
wave-reviewers:
  enabled: false
  reviewers: []
  mode: warn
```

The sub-fields (`enabled`, `reviewers`, `mode`) and their semantics are unchanged.

## Backward Compatibility

The old `persona-reviewers` key is still accepted during the deprecation window. When present,
the config loader emits exactly one warning to stderr:

```
Session Config: 'persona-reviewers' is deprecated — rename to 'wave-reviewers'. Will be removed in v4.0.
```

If both `wave-reviewers` and `persona-reviewers` are present in the same file, `wave-reviewers`
wins and the warning is still emitted once (because `persona-reviewers` is present).

**Deprecation removed in:** v4.0

## Links

- Issue #461 (this rename)
- Issue #457–#461 (persona-panel pattern — distinct from wave-reviewers)
- See [project_persona_panel_pattern.md](.claude/projects/-Users-bernhardg--Projects-Bernhard-session-orchestrator/memory/project_persona_panel_pattern.md) for the new persona-panel cluster
