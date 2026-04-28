# Owner Persona Schema (`owner.yaml`)

> Per-user configuration for the session-orchestrator plugin. Lives at
> `~/.config/session-orchestrator/owner.yaml`. Never committed to a project repo.
>
> Issue [#174](../../../-/issues/174) — D1 of Sub-Epic [#161](../../../-/issues/161) (Owner Persona Layer).
> Parent epic: [#157](../../../-/issues/157) (v3.1.0 Environment-Aware Sessions).

## Path Resolution

The loader (`scripts/lib/owner-config-loader.mjs`) resolves the canonical path as:

```
${XDG_CONFIG_HOME ?? <homedir>/.config}/session-orchestrator/owner.yaml
```

| Platform   | Default path                                            |
|------------|---------------------------------------------------------|
| macOS      | `~/.config/session-orchestrator/owner.yaml`             |
| Linux      | `${XDG_CONFIG_HOME:-~/.config}/session-orchestrator/owner.yaml` |
| Windows    | `%USERPROFILE%\.config\session-orchestrator\owner.yaml` |

A missing file is **not an error** — it signals the user has not opted in.
The loader returns `{ok: false, source: 'missing'}` in that case and consumers
fall back to plugin defaults.

## Schema (`schema-version: 1`)

| Section / Field                          | Type                          | Required | Default       | Notes                                              |
|------------------------------------------|-------------------------------|----------|---------------|----------------------------------------------------|
| `schema-version`                         | integer                       | yes      | —             | Must equal `1`.                                    |
| `owner.name`                             | string (1-100)                | yes      | —             | Display name.                                      |
| `owner.email-hash`                       | hex (64 chars) or `null`      | no       | `null`        | SHA256 of email; cross-host identity correlation.  |
| `owner.language`                         | ISO-639-1 (`de`, `en`, ...)   | yes      | —             | Drives soul.md default language.                   |
| `tone.style`                             | `direct\|neutral\|friendly`   | no       | `neutral`     |                                                    |
| `tone.tonality`                          | string (≤200) or `null`       | no       | `null`        | Free-form descriptor.                              |
| `efficiency.output-level`                | `lite\|full\|ultra`           | no       | `full`        | Caveman-inspired token dial.                       |
| `efficiency.preamble`                    | `minimal\|verbose`            | no       | `minimal`     | Pre-tool-call narration.                           |
| `efficiency.comments-in-code`            | `minimal\|full`               | no       | `minimal`     | Inline code comments.                              |
| `hardware-sharing.enabled`               | boolean                       | no       | `false`       | Consent gate for hardware-pattern export.          |
| `hardware-sharing.hash-salt`             | hex (64 chars) or `null`      | no       | `null`        | Per-host random salt. Required when `enabled=true`.|
| `defaults.preferred-test-command`        | string (≤200) or `null`       | no       | `null`        | Override CLAUDE.md `test-command`.                 |
| `defaults.preferred-editor`              | string (≤50) or `null`        | no       | `null`        |                                                    |
| `metadata.created_at`                    | ISO 8601 string or `null`     | no       | `null`        | Auto-set on first write.                           |
| `metadata.updated_at`                    | ISO 8601 string or `null`     | no       | `null`        | Auto-bumped on every save.                         |

### Privacy Contract

- `hardware-sharing.enabled = true` **requires** `hardware-sharing.hash-salt`
  to be a valid 64-char hex string. The validator rejects `enabled=true` with
  `hash-salt=null` so consent is never recorded without the means to
  anonymise per-host learnings.
- `owner.email-hash` is the only field carrying potential cross-host identity;
  it is hashed (never plaintext email) and remains optional.

## Example

See [`scripts/lib/owner-config.example.yaml`](../scripts/lib/owner-config.example.yaml)
for an annotated, copyable example.

## API Surface

`scripts/lib/owner-config.mjs` (pure, no I/O):

```js
import { validate, coerce, defaults, merge } from './scripts/lib/owner-config.mjs';

// Defensive, never throws. Use this in skill code paths.
const result = validate(rawObj);
//   → { ok: true, value: <normalized>, errors: [] }
//   → { ok: false, value: null, errors: ["owner.name must be ..."] }

// Strict mode: throws OwnerConfigError on failure. Use in tests / CLI.
const value = coerce(rawObj);

// Default-filled config. owner.name and owner.language remain blank
// (the bootstrap interview in D2 fills them in).
const def = defaults();

// Deep-merge two configs. `override` wins on every defined leaf.
const merged = merge(baseFromOwnerYaml, perSessionOverrides);
```

`scripts/lib/owner-config-loader.mjs` (filesystem I/O):

```js
import { loadOwnerConfig, resolveOwnerConfigPath } from './scripts/lib/owner-config-loader.mjs';

const result = await loadOwnerConfig();
// {
//   ok: true|false,
//   value: <normalized> | null,
//   errors: string[],
//   source: 'file' | 'missing' | 'parse-error' | 'validation-error',
//   path: '<absolute path>',
// }

// Test override
const result2 = await loadOwnerConfig({ path: '/tmp/test-owner.yaml' });
```

## Where this gets read

D1 only ships the schema + validator + loader. The downstream tasks consume
these primitives:

- **[#175 D2](../../../-/issues/175) — bootstrap interview**: writes the file via
  `coerce()` then a YAML serializer, stamping `metadata.created_at` /
  `metadata.updated_at`.
- **[#176 D3](../../../-/issues/176) — `soul.md` runtime-merge**: calls
  `loadOwnerConfig()` from the session-start hook, then `merge()` with any
  per-session overrides, then resolves `{{tone.style}}` /
  `{{efficiency.output-level}}` / `{{owner.language}}` template slots.
- **[#177 D4](../../../-/issues/177) — projects-baseline propagation**: stamps a
  reference to the canonical path into every consumer repo's CLAUDE.md
  frontmatter (path reference only — never the content).
- **[#168 C4](../../../-/issues/168) — hardware-sharing consent prompt**: writes
  `hardware-sharing.enabled = true` + a freshly-generated `hash-salt` after
  the user accepts the consent dialogue.

## Validation Rules (rejection examples)

```yaml
# REJECTED — schema-version missing
owner: { name: x, language: en }

# REJECTED — schema-version mismatch (refuses to load future versions)
schema-version: 2
owner: { name: x, language: en }

# REJECTED — name empty
schema-version: 1
owner: { name: "", language: en }

# REJECTED — language not ISO-639-1
schema-version: 1
owner: { name: x, language: "english" }

# REJECTED — enum violation
schema-version: 1
owner: { name: x, language: en }
tone: { style: "snarky" }

# REJECTED — privacy contract: enabled=true without hash-salt
schema-version: 1
owner: { name: x, language: en }
hardware-sharing: { enabled: true }

# ACCEPTED — minimal valid config
schema-version: 1
owner:
  name: Bernhard
  language: de
```
