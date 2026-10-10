# Role-profile evidence contract v1

Refs #1469. This additive offline contract records role-selection evidence; it does not
select a model, dispatch an agent, load a registry, start an adapter, or change a pin.
The test-profile registry under `scripts/lib/profiles/` is a separate contract.

## API and meaning

`scripts/lib/role-profile/schema.mjs` exports `ROLE_PROFILE_CONTRACT_VERSION` (1)
and `roleProfileEvidenceSchema.safeParse(value)`:

- Success: `{ success: true, data, diagnostics }`. `data` is the original input,
  unchanged, without defaults, normalization or alias resolution.
- Failure: `{ success: false, error: { issues } }`. Each issue has a fixed `code`,
  field-addressing `path` array and `message`. Messages never interpolate raw input.
- Codes: `INVALID_TYPE`, `MISSING_FIELD`, `UNKNOWN_FIELD`, `INVALID_VALUE`,
  `INVALID_RELATION`, `UNSUPPORTED_VERSION`. Diagnostics can contain `UNSUPPORTED_EFFORT`.

Success means internal structural consistency only. A source reference is a claim
by the recorder: the validator does not read it, authenticate it, check revocation,
verify permissions, or confirm that the harness actually used the recorded model.
No result asserts host availability, account access, quota, cost, quality, or model
acceptance. An `authorized` record is not an execution authorization issued by this API.
No I/O, environment lookup, current-clock read, provider call or input mutation occurs.

## Fields

All fields below are required, including null-valued fields. Objects must have only
the specified own data properties; arrays, accessors and class instances are rejected.
Strings must contain a non-whitespace character but are preserved byte for byte.
IDs and version strings are opaque; unlisted model IDs are accepted without substitution.

| Field | Shape and relationship |
|---|---|
| `contractVersion` | Integer literal `1`; separate from harness/profile/registry versions |
| `role`, `taskClass` | Nonempty role name and task classification; no role registry lookup |
| `provider`, `transport` | Separate nonempty IDs; never inferred from a model name |
| `binding` | `{status, sourceRef, reason}`; known bindings in v1 are `openai`/`codex-cli` and `anthropic`/`claude-code` |
| `model` | `{requested, observed, resolution}`; details below |
| `effort` | `{requested, effective, support}`; details below |
| `harness` | `{name, version}`; name is a string, version is evidence with `value` |
| `profile` | `{id, version}`; id is a string, version is evidence with `value` |
| `registryVersion` | Evidence with `value`; records provenance without creating a registry |
| `selection` | `{mode, escalationReason}`; mode `profile`, `owner-override`, or `escalation` |
| `authorization` | `{status, authority, sourceRef, scope, reason}`; details below |
| `evidence` | Evidence with `timestamp`; known timestamps are real calendar dates in UTC, exactly `YYYY-MM-DDTHH:mm:ss.sssZ` |

An evidence object has `{status, <field>, sourceRef, reason}`. With `known`, the
value and source reference are nonempty strings and reason is null. With `unknown`,
value and source reference are null and reason is nonempty. Missing evidence is not
an unknown state. Binding uses the same source/reason convention without a value.
Unrecognized provider/transport pairs require binding `unknown`, retaining the raw IDs;
known contradictory pairs are rejected. Binding validity is not transport availability.

## Model request, observation and resolution

`requested` is `{kind, value}`: `id` or `alias` requires the original string;
`inherit` requires null. `observed` is evidence with `id`, independently collected.
Unknown observation requires resolution `unknown`; no requested ID is copied into it.
A known observation may still have unknown resolution when the relationship is unproven.

`resolution` has `{status, baselineId, parent, sourceRef, reason}`:

| Status | Required relationship |
|---|---|
| `unknown` | baselineId, parent and sourceRef null; reason nonempty |
| `exact` | Requested kind id, requested value equals observed ID |
| `alias-resolved` | Requested kind alias, known observation; no drift assertion |
| `alias-drift` | Requested kind alias, known observation, nonempty baselineId different from observed ID; sourceRef must identify the resolution/baseline evidence |
| `parent-inherit` | Requested kind inherit; parent `{id, sourceRef}` names the observed ID with separate parent evidence |

All non-unknown resolutions require known observation, nonempty sourceRef and null
reason. baselineId is null outside alias-drift; parent is null outside parent-inherit.
A changed alias without a documented baseline is not proof of drift. Inheritance
without parent evidence remains unknown. The validator checks equality and structure,
not whether any source genuinely proves the relationship.

## Effort and capability evidence

`requested` is `{provider, dialect, value}`; value is a nonempty string or null
(no explicit effort requested). `effective` is `{provider, dialect, status, value,
sourceRef, reason}` with the known/unknown evidence rules above. Both providers must
match the record provider. Recognized dialects are `openai-reasoning` for openai and
`anthropic-effort` for anthropic. Unrecognized dialects require both support and
effective evidence to be unknown, preserving requested values.

`support` is `{status, sourceRef, reason}` with `supported`, `unsupported`, or
`unknown`. The first two require a source and null reason; unknown requires null
source and a reason. This describes support for the requested effort, as asserted
by the source, not a live capability table maintained by this validator. Values
are never translated or ranked numerically across vendors. A familiar label such
as medium alone proves no support on a particular harness/version/model.

Unsupported requests emit `UNSUPPORTED_EFFORT`. An identical value cannot also be
claimed effective; explicitly unknown effective effort or a different documented
value can be recorded. Unknown support does not become supported merely because
a syntactically valid record contains a known effective value.

## Escalation and owner authorization

Escalation requires a nonempty escalationReason; other selection modes require null.
Owner-override and escalation require authorization status `authorized`, authority
`owner`, nonempty sourceRef, null reason and explicit scope:

```json
{
  "role": "worker", "provider": "openai", "transport": "codex-cli",
  "model": {"kind": "id", "value": "unlisted-model/2030"},
  "effort": {"provider": "openai", "dialect": "openai-reasoning", "value": "medium"}
}
```

Every scope value must match the record's role, provider, transport and original
model/effort requests. This is an internal coverage comparison, not external policy
verification. Profile selection can record `unknown` or `not-required`: authority,
sourceRef and scope are null and reason is nonempty. Neither status grants permission.
Any authorized record, including profile mode, must carry the full matching scope.
Historical narratives, cost labels or model preferences never supply missing evidence.
References must not include tokens, account names, mail addresses or other secrets.

## Unknown example and versioning

The following fragments belong to an otherwise complete v1 record:

```json
{
  "requested": {"kind": "id", "value": "unlisted-model/2030"},
  "observed": {"status": "unknown", "id": null, "sourceRef": null, "reason": "Not measured"},
  "resolution": {"status": "unknown", "baselineId": null, "parent": null, "sourceRef": null, "reason": "Not resolved"}
}
```

This can be contract-valid; it never proves successful resolution or model acceptance.
Inline executable complete records live in `tests/lib/role-profile/schema.test.mjs`.
Unknown contract versions are rejected before interpreting nested evidence. Unknown
field names are rejected; unknown opaque IDs are retained. New fields or changed
semantics require a new contract version, explicit handling and migration policy;
there is no automatic upgrade. This offline slice leaves runtime smokes, dispatch
integration, precedence measurement, billing, access and rollout acceptance open.
