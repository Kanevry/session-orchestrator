---
tier: coordinator-only
review-date: 2026-10-23
---

# Owner Persona Layer (Always-on)

The Owner Persona Layer is a per-user (not per-project) tonality + efficiency dial that propagates across every repo on the same host: a single `owner.yaml` lets the operator configure language, tone, and verbosity once, picked up automatically at session-start without baking personal data into any version-controlled file.

**Path + schema (SSOT is code, not this file).** `~/.config/session-orchestrator/owner.yaml` — per-user, per-machine, never inside any repo, never committed. Schema, defaults, and the 4 soul.md slot resolvers live in `scripts/lib/owner-yaml.mjs` (`OWNER_YAML_PATH`, `loadOwnerConfig`, `writeOwnerConfig`, `getDefaults`) + `scripts/lib/soul-resolve.mjs` (slots resolved in-memory each session, never persisted). First-run interview / reset run via `/bootstrap` (`scripts/lib/owner-interview.mjs`) and `/bootstrap --owner-reset`.

**Privacy guarantee.** This rule file carries **zero** owner data — only the path convention and schema shape. `owner.yaml` lives outside every repo and is appended to `~/.gitignore` at first-run, so it cannot surface in any repo commit under any normal or misconfigured workflow; generated soul.md content is never written to disk. `paths.confidential-names-file` (#728a; env `SO_CONFIDENTIAL_NAMES_FILE` overrides) follows the same committed-path / host-local-data contract — only the PATH lives in `owner.yaml`, the names in a never-committed JSON file, and the owner-leakage scanner's CP11 rule **redacts** any matched name, so a CP11 hit in a public CI log never prints the confidential name itself.

## See Also
development.md · security.md · cli-design.md · mvp-scope.md · parallel-sessions.md
