# Owner Persona Schema (`owner.yaml`)

> Per-user configuration for the session-orchestrator plugin. Lives at
> `~/.config/session-orchestrator/owner.yaml`. Never committed to a project repo.
>
> Issue [#174](../../../-/issues/174) — D1 of Sub-Epic [#161](../../../-/issues/161) (Owner Persona Layer).
> Parent epic: [#157](../../../-/issues/157) (v3.1.0 Environment-Aware Sessions).
>
> **SSOT is code, not this file:** `scripts/lib/owner-yaml.mjs` (schema,
> validator, loader, writer) + `scripts/lib/config/private-config-dir.mjs`
> (path resolution). This page describes that module; when the two disagree,
> the module wins.

## Path Resolution

The loader (`scripts/lib/owner-yaml.mjs`, via `resolvePrivateConfigDir()` in
`scripts/lib/config/private-config-dir.mjs`) resolves the canonical path as:

```
${SO_CONFIG_HOME ?? XDG_CONFIG_HOME ?? <homedir>/.config}/session-orchestrator/owner.yaml
```

| Platform   | Default path                                            |
|------------|---------------------------------------------------------|
| macOS      | `~/.config/session-orchestrator/owner.yaml`             |
| Linux      | `${XDG_CONFIG_HOME:-~/.config}/session-orchestrator/owner.yaml` |
| Windows    | `%USERPROFILE%\.config\session-orchestrator\owner.yaml` |

A missing file is **not an error** — it signals the user has not opted in.
`loadOwnerConfig()` then returns `getDefaults()` with `source: 'defaults'`.

## Schema

Four **required** sections (`owner`, `tone`, `efficiency`, `hardware-sharing`)
and the optional sections below. An invalid required section discards the whole
file (defaults are returned, errors reported); an invalid optional object
section is replaced by its default and reported via `droppedSections`
(`source: 'partial'`).

| Section / Field                     | Type / enum                          | Required | Default   | Notes                                              |
|-------------------------------------|--------------------------------------|----------|-----------|----------------------------------------------------|
| `owner.name`                        | non-empty string                     | yes      | `''`      | Display name.                                      |
| `owner.language`                    | `de` \| `en`                         | yes      | `en`      | Drives soul.md default language.                   |
| `tone.style`                        | `direct` \| `neutral` \| `friendly`  | yes      | `neutral` |                                                    |
| `tone.tonality`                     | string or absent                     | no       | `''`      | Free-form descriptor.                              |
| `efficiency.output-level`           | `lite` \| `full` \| `ultra`          | yes      | `full`    | Token dial.                                        |
| `efficiency.preamble`               | `minimal` \| `verbose`               | yes      | `minimal` | Pre-tool-call narration.                           |
| `hardware-sharing.enabled`          | boolean                              | yes      | `false`   | Consent gate for hardware-pattern export.          |
| `hardware-sharing.hash-salt`        | string                               | no       | `''`      | Required (non-empty) when `enabled = true`.        |
| `paths.vault-dir`                   | string                               | no       | `''`      | `''` = no override; beats the committed `vault-integration.vault-dir`. |
| `paths.baseline-path`               | string                               | no       | `''`      | Host-local `plan-baseline-path` override (#653).   |
| `paths.namespace-map-path`          | string                               | no       | `''`      | Host-local repo-pseudonym JSON map (#725 D5).      |
| `paths.confidential-names-file`     | string                               | no       | `''`      | Host-local JSON array of names for the CP11 leakage rule (#728a). Names live in that file only, never inline here. |
| `dispatcher.autonomy`               | `off` \| `advisory` \| `autonomous-gated` \| `''` | no | `''` | `''` = no override (#679).                         |
| `vaults`, `baselines`               | lists                                | no       | absent    | Passed through untouched; parsed leniently at point of use. |

### Privacy Contract

- `hardware-sharing.enabled = true` **requires** a non-empty
  `hardware-sharing.hash-salt`. The validator rejects consent without the means
  to anonymise per-host learnings.
- Only PATHS live in `owner.yaml`; the host-local data they point at
  (confidential names, namespace map) is never inlined and never committed.

## Example

See [`scripts/lib/owner-config.example.yaml`](../scripts/lib/owner-config.example.yaml)
for an annotated, copyable example.

## API Surface

`scripts/lib/owner-yaml.mjs` — the live SSOT. **Synchronous**; every call site
consumes it without `await`. `js-yaml` is imported lazily, so the module is
safe on the hook import graph.

```js
import { loadOwnerConfig, resolveOwnerYamlPath, validateOwnerConfig, getDefaults }
  from './scripts/lib/owner-yaml.mjs';

const result = loadOwnerConfig();
// {
//   config: <merged with getDefaults()>,
//   source: 'file' | 'partial' | 'defaults' | ...,
//   path: '<absolute path>',
//   errors: string[], warnings: string[], droppedSections: string[],
// }

// Test override
const result2 = loadOwnerConfig({ path: '/tmp/test-owner.yaml' });

// Pure validation, no I/O, never throws.
const { valid, errors } = validateOwnerConfig(rawObj);
```

Also exported: `validateOwnerSections()` (per-section buckets),
`writeOwnerConfig()`, `OPTIONAL_OBJECT_SECTIONS`, `resolvePrivateConfigDir`.

## Where this gets read

`loadOwnerConfig()` has 10 live consumers outside its own module
(`rg -ln "loadOwnerConfig" scripts hooks`, 2026-09-09) — two hooks
(`hooks/on-session-start.mjs`, `hooks/skill-invocation-telemetry.mjs`), the
session-start owner-config banner (`scripts/lib/owner-config-banner.mjs`), the
host-path + dispatcher-autonomy resolvers (`scripts/lib/config/host-paths.mjs`,
`scripts/lib/config/dispatcher-autonomy.mjs`), the named-vault resolver, the
owner-leakage scanner, telemetry, and vault-mirror. For the behavioural
contract of the persona layer itself see
[`.claude/rules/owner-persona.md`](../.claude/rules/owner-persona.md).

## Validation Rules (rejection examples)

```yaml
# REJECTED — owner.name empty
owner: { name: "", language: en }

# REJECTED — language outside the de|en enum
owner: { name: x, language: "english" }

# REJECTED — enum violation
owner: { name: x, language: en }
tone: { style: "snarky" }

# REJECTED — privacy contract: enabled=true without hash-salt
owner: { name: x, language: en }
hardware-sharing: { enabled: true }

# ACCEPTED — all four required sections present and valid
owner:
  name: Bernhard
  language: de
tone:
  style: direct
efficiency:
  output-level: full
  preamble: minimal
hardware-sharing:
  enabled: false
```
