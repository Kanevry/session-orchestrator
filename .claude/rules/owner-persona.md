# Owner Persona Layer (Always-on)

## Why

Every repo session runs with the same AI but a different project context. The Owner Persona Layer adds a per-user (not per-project) tonality and efficiency dial that propagates across all repos on the same host. A single `owner.yaml` on disk lets the operator configure language, tone, and verbosity once — and every session picks it up automatically at start, without baking any personal data into version-controlled files.

## owner.yaml location & schema

```
~/.config/session-orchestrator/owner.yaml
```

This path is per-user, per-machine. It is **never** inside any repo and **never** committed. Implementation: `scripts/lib/owner-yaml.mjs` (`OWNER_YAML_PATH` constant, `loadOwnerConfig`, `writeOwnerConfig`).

Minimal schema (schema-version: 1):

```yaml
owner:
  name: "Ada Lovelace"              # required, non-empty
  language: en                      # de | en

tone:
  style: neutral                    # direct | neutral | friendly
  tonality: ""                      # optional free text

efficiency:
  output-level: full                # lite | full | ultra
  preamble: minimal                 # minimal | verbose

hardware-sharing:
  enabled: false                    # opt-in only
  hash-salt: ""                     # required when enabled: true
```

## Template slots

Four slots are injected into `skills/_shared/soul.md` at session-start runtime by `scripts/lib/soul-resolve.mjs`. They are never persisted — each session resolves them fresh from the current `owner.yaml` on disk:

| Slot | Source field | Values |
|---|---|---|
| `{{owner.language}}` | `owner.language` | `de` / `en` |
| `{{tone.style}}` | `tone.style` | `direct` / `neutral` / `friendly` |
| `{{efficiency.output-level}}` | `efficiency.output-level` | `lite` / `full` / `ultra` |
| `{{efficiency.preamble}}` | `efficiency.preamble` | `minimal` / `verbose` |

Slots are resolved left-to-right; unknown keys fall back to the defaults defined in `getDefaults()` in `scripts/lib/owner-yaml.mjs`.

## First-run interview

When `owner.yaml` does not exist, bootstrap runs a 5-question `AskUserQuestion`-driven interview (implementation: `scripts/lib/owner-interview.mjs`) to populate the file. The interview runs **once per host** and covers:

1. Preferred name (maps to `owner.name`)
2. Preferred language — `de` or `en` (maps to `owner.language`)
3. Tone style — `direct` / `neutral` / `friendly` (maps to `tone.style`)
4. Output level — `lite` / `full` / `ultra` (maps to `efficiency.output-level`)
5. Preamble verbosity — `minimal` / `verbose` (maps to `efficiency.preamble`)

After the interview, bootstrap writes `owner.yaml` via `writeOwnerConfig()` and appends the path to `~/.gitignore` as a safety net.

## Re-trigger

To update persona settings or rotate after a machine transfer:

```
/bootstrap --owner-reset
```

This archives the existing `owner.yaml` (timestamped backup in the same directory) and re-runs the 5-question interview from scratch. All 4 template slots pick up the new values at the next session-start.

## Privacy guarantee

- `owner.yaml` lives at `~/.config/session-orchestrator/owner.yaml` — outside every repo, always.
- This rule file contains **zero** owner data. Only the path convention and schema shape are documented here.
- Bootstrap appends `~/.config/session-orchestrator/owner.yaml` to the global `~/.gitignore` during first-run as a safety net, preventing accidental staging across all repos on the machine.
- Generated soul.md content is resolved in-memory per session and **never written to disk**.
- Repos are safe to be public. `owner.yaml` cannot appear in any repo commit under any normal or misconfigured workflow.

## See Also
development.md · security.md · cli-design.md · mvp-scope.md · parallel-sessions.md · ai-agent.md
