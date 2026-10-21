---
tier: coordinator-only
review-date: 2026-10-23
---

# Owner Persona Layer (Always-on)

Host-wide per-user language/tone/verbosity config, never project data: `~/.config/session-orchestrator/owner.yaml` must stay outside every repo and never be committed. Resolver: `scripts/lib/config/private-config-dir.mjs` `resolvePrivateConfigDir()` (`SO_CONFIG_HOME` > `XDG_CONFIG_HOME` > homedir), wrapped by `resolveOwnerYamlPath()`. Schema/defaults/loading: `scripts/lib/owner-yaml.mjs` (`resolveOwnerYamlPath`, `loadOwnerConfig`, `writeOwnerConfig`, `getDefaults`); no separate slot resolver.

Session-start uses `loadOwnerConfig()` and `efficiency.output-level` / `tone.style` to render `skills/session-start/soul.md` only in memory, never on disk. Interview/reset: `/bootstrap` / `/bootstrap --owner-reset` (`scripts/lib/owner-interview.mjs`).

Privacy: this rule contains zero owner data; first-run adds owner.yaml to `~/.gitignore`. `paths.confidential-names-file` (#728a; override `SO_CONFIDENTIAL_NAMES_FILE`) stores only the PATH in owner.yaml; names stay in host-local, never-committed JSON. Owner-leakage CP11 MUST redact matched names so public CI logs never print them.

## See Also
development.md · security.md · cli-design.md · mvp-scope.md · parallel-sessions.md
