---
tier: coordinator-only
---

# Owner Persona Layer (Always-on)

## Why

Every repo session runs with the same AI but a different project context. The Owner Persona Layer adds a per-user (not per-project) tonality and efficiency dial that propagates across all repos on the same host. A single `owner.yaml` on disk lets the operator configure language, tone, and verbosity once — and every session picks it up automatically at start, without baking any personal data into version-controlled files.

## Configuration

**File:** `~/.config/session-orchestrator/owner.yaml` — per-user, per-machine, never inside any repo, never committed.

**Schema + defaults:** `scripts/lib/owner-yaml.mjs` (`OWNER_YAML_PATH` constant, `loadOwnerConfig`, `writeOwnerConfig`, `getDefaults()`).

**Template slot resolution** (4 slots injected into `skills/_shared/soul.md` at session-start): `scripts/lib/soul-resolve.mjs`. Slots are resolved in-memory each session from the current `owner.yaml` — never persisted.

**First-run interview:** runs once per host via `/bootstrap` (implementation: `scripts/lib/owner-interview.mjs`) when `owner.yaml` does not exist. Covers name, language, tone style, output level, and preamble verbosity.

**Reset / re-trigger:** `/bootstrap --owner-reset` — archives the existing file and re-runs the interview.

## Privacy guarantee

- `owner.yaml` lives at `~/.config/session-orchestrator/owner.yaml` — outside every repo, always.
- This rule file contains **zero** owner data. Only the path convention and schema shape are documented here.
- Bootstrap appends `~/.config/session-orchestrator/owner.yaml` to the global `~/.gitignore` during first-run as a safety net, preventing accidental staging across all repos on the machine.
- Generated soul.md content is resolved in-memory per session and **never written to disk**.
- Repos are safe to be public. `owner.yaml` cannot appear in any repo commit under any normal or misconfigured workflow.
- `paths.confidential-names-file` (#728a) follows the SAME committed-mechanism / host-local-data contract: only the PATH lives in `owner.yaml` (env `SO_CONFIDENTIAL_NAMES_FILE` overrides), while the confidential customer/repo names live in the referenced never-committed JSON file. The owner-leakage scanner's CP11 rule matches tracked files against that list and **redacts** any matched name from its output — so even a CP11 hit surfaced in the public CI log never prints the confidential name itself.

## See Also
development.md · security.md · cli-design.md · mvp-scope.md · parallel-sessions.md
