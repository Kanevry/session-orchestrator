# aiat-llm-eval — An Honest-Measurement Standard for LLM & Agentic-Session Evaluation

- **standard_version:** `aiat-llm-eval/1.0`
- **Date:** 2026-07-16
- **Status:** v1.0
- **Record schema:** `schema_version 1`, `record_kind "session-eval"` (see [§2](#2-record-schema-reference))
- **Reference implementation:** `scripts/lib/eval/schema.mjs` (canonical record contract)

> This document is the versioned, public specification of the `aiat-llm-eval`
> standard. It codifies evaluation practices distilled from three AIAT
> production eval programs (generically: a **PDF-Accessibility-Engine**, a
> **Doc-VLM-Benchmark**, and a **PDF-Remediation-Tool**) and from the project
> Meta-Vault. Its first consumer is the `/eval` skill, which scores each
> orchestrator session as a session-process evaluation.

## 0. Preamble

### 0.1 Purpose

Evaluation of large-language-model behaviour is easy to do dishonestly: a single
run reported as a headline number, a judge model's opinion presented as ground
truth, missing data silently coerced to zero, an aggregate index that hides
which dimension actually failed. This standard exists to make those failure
modes structurally hard to commit. It specifies:

1. a set of **principles** every conforming evaluation obeys ([§1](#1-principles));
2. an **append-only record schema** every run emits ([§2](#2-record-schema-reference));
3. a **judge doctrine** that keeps subjective scoring advisory until calibrated
   ([§3](#3-judge-doctrine));
4. a **consent & privacy doctrine** for any later submission ([§4](#4-consent--privacy-doctrine));
5. an explicit **limits** chapter stating what the standard does *not* claim
   ([§5](#5-limits--what-this-standard-does-not-claim));
6. a **governance** model for evolving the standard itself ([§6](#6-governance)).

### 0.2 Scope

`aiat-llm-eval/1.0` covers **session-process evaluation**: scoring one
orchestrator session against a pre-registered rubric, deterministically first,
with an optional advisory judge. Two adjacent uses — a golden-task model
benchmark and a public leaderboard — are explicitly out of scope for v1. The
record schema reserves the `record_kind` discriminator for those later stages,
but v1 defines only `record_kind "session-eval"`.

### 0.3 Requirements language

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in
this document are to be interpreted as described in RFC 2119 and RFC 8174 when,
and only when, they appear in all capitals. Prose that does not use these words
is explanatory, not normative.

### 0.4 Terminology

| Term | Meaning |
|---|---|
| **Run** | One evaluation of one session, producing exactly one record. |
| **Record** | The append-only JSON object a run emits (`schema_version 1`). |
| **Journal** | The append-only `eval.jsonl` stream of records — the Single Source of Truth. |
| **Report** | A derived, rebuildable view (e.g. an HTML file) rendered *from* a record. Never authoritative over the journal. |
| **Dimension** | One scored aspect of a session (e.g. `verification-evidence`), evaluated by a `deterministic` or a `judge` method. |
| **Deterministic dimension** | Scored by executable rules over source data. Reproducible bit-for-bit. |
| **Judge dimension** | Scored by an LLM. Advisory-only until κ-calibrated ([§3](#3-judge-doctrine)). |
| **Abstention** | The `cannot-determine` verdict: source data is missing, so the run declines to score rather than guess. |
| **Provenance** | The set of version/hash/commit fields that pin a run to exact inputs. |

## 1. Principles

The following principles are normative. A conforming evaluation MUST satisfy all
of them; a report or tool that violates any of them is non-conforming even if it
uses the record schema.

### 1.1 Pre-Registration is the leading principle

The checks a rubric applies MUST be defined **before** the first real run is
scored against that rubric. A rubric version (`rubric_version`) freezes the
check set, and its content hash (`provenance.rubric_sha256`) binds each record to
the exact rubric text that produced it. Defining or tuning checks after seeing
results — moving the goalposts — is forbidden: it is the single most-abused and
least-copied practice in the field, and this standard treats it as load-bearing.
Changing the checks means minting a new `rubric_version`, not editing the old
one in place.

### 1.2 Deterministic before Judge

Every dimension that *can* be scored by executable rules over source data MUST be
scored that way. An LLM judge is used only for genuinely subjective dimensions
that no deterministic rule can settle, and only as an advisory overlay
([§3](#3-judge-doctrine)). Deterministic and judge dimensions are kept strictly
separate in both the record (`method`) and every report. A judge MUST NOT be used
to score something a deterministic check already covers.

### 1.3 Per-dimension, never a global score

A record has, **by construction**, no overall/total/mean/global field. Each
dimension carries its own verdict; the record refuses to collapse them into one
number. The reference schema enforces this: `validateEvalRecord` REJECTS any
record carrying a top-level `overall`, `total`, `mean`, or `global_score` key.
Aggregation across many records — confidence intervals, trends, rankings — is a
downstream concern of later analysis, never a field inside a single record
([§5.2](#52-no-authoritative-global-score)).

### 1.4 Three-state verdicts with explicit abstention

A dimension's `status` MUST be one of exactly four values:

- `pass` — the check succeeded on real evidence;
- `fail` — the check failed on real evidence;
- `not-applicable` — the check does not apply to this session (e.g. a wave-only
  check on a housekeeping session);
- `cannot-determine` — the **abstention** verdict: the source data required to
  evaluate the check is missing, so the run declines to score.

Missing source data MUST lead to `cannot-determine` with a reason recorded in
`evidence` — **never** to a guessed `pass` or `fail`. A run that abstains on a
dimension MUST NOT fail the run: abstention is a first-class, non-error outcome.

### 1.5 Don't fake perfect

A value that is unknown MUST be represented as `null`, never as a plausible
default such as `0`. A missing token count is `null`, not zero tokens; an
un-captured KPI is `null`, not a fabricated best case. The reference schema's
`normalizeEvalRecord` fills every undefined KPI sub-field with `null`
specifically to prevent silent zero-coercion. Faking a perfect or complete
record from incomplete data is a conformance violation.

### 1.6 Infrastructure split — tech failure is not model failure

An evaluation MUST distinguish a **harness/infrastructure failure** (a crashed
runner, a missing metrics file, a timed-out CLI, a network fault) from a
**model/session failure** (the session genuinely did the wrong thing). An infra
failure MUST NOT be scored as a model `fail`; where source data is absent because
of it, the correct verdict is `cannot-determine` ([§1.4](#14-three-state-verdicts-with-explicit-abstention)).
Conflating the two poisons every downstream aggregate.

### 1.7 Full version provenance per run

Every record MUST carry enough provenance to reproduce the run and to detect
drift. At minimum:

- `standard_version` — the standard this record conforms to;
- `rubric_version` + `provenance.rubric_sha256` — the exact rubric and its content hash;
- `provenance.engine_commit` — the engine commit that produced the record (or `null`);
- `model.id` + `model.source` — the evaluated model and the honest provenance of
  that identification ([§2.4](#24-model));
- `harness.plugin_version` — the harness version.

Provenance is not decoration: a record without it cannot be trusted, re-verified,
or aggregated.

### 1.8 CI and tie honesty

Where a metric is computed over more than one observation (n > 1), a conforming
aggregate view SHOULD report a confidence interval, not a bare point estimate.
Ties MUST NOT be rounded away to manufacture a ranking: two results that are
statistically indistinguishable are reported as tied. A **single** run is n = 1
and MUST be labelled as carrying no confidence interval ([§5.4](#54-a-single-run-is-n1)).

### 1.9 Journal-as-SSOT; reports are derived views

The append-only `eval.jsonl` journal is the single source of truth. Records are
appended, never mutated or deleted in place. Every report — HTML, dashboard,
summary — is a **derived view**, rebuildable at any time from the journal. A
report MUST NOT hold state that is not in the journal, and MUST NOT be treated as
authoritative over it. If a report and the journal disagree, the journal wins and
the report is regenerated.

### 1.10 Offline re-verify — reproducibility as executable proof

Reproducibility MUST be demonstrable, not asserted. A conforming implementation
provides a **credential-free, network-free** re-verification path that
re-evaluates a stored run from the local source data and diffs the result against
the stored record. Agreement is exit-0; drift is a non-zero exit with a
per-dimension diff. Reproducibility is the *scoring* being replayable from fixed
inputs — it is **not** a claim that the model's own outputs are deterministic
([§5.3](#53-reproducibility-is-scoring-replay-not-deterministic-model-output)).

### 1.11 Cost and latency are first-class KPIs

Token cost and wall-clock latency are not afterthoughts. A conforming record
carries them as first-class KPIs (`kpis.token_input`, `kpis.token_output`,
`kpis.duration_seconds`, alongside `total_waves`, `total_agents`, `carryover`).
An evaluation that reports quality without cost and latency is incomplete: the
same quality at 10× the cost is a different result.

## 2. Record Schema Reference

This section documents the **implemented** v1 record, whose canonical contract
lives in `scripts/lib/eval/schema.mjs`. The fields below are the real fields the
validator enforces — not an idealized wish-list. A conforming run emits exactly
this shape.

### 2.1 Top-level shape

```jsonc
{
  "schema_version": 1,                         // stamped if absent
  "record_kind": "session-eval",               // discriminator (v1: only this)
  "run_id": "<session_id>-eval-<compactISO>",  // deterministic; no Date.now
  "session_id": "main-2026-07-16-deep-1",
  "standard_version": "aiat-llm-eval/1.0",
  "rubric_version": "rubric-v1",
  "provenance": { "rubric_sha256": "<hex>", "engine_commit": "<sha>|null" },
  "model":     { "id": "<model-id>", "source": "self-report|env|config" },
  "harness":   { "plugin_version": "<ver>", "platform": "<claude-code|codex|…>",
                 "host_class": "<string>|null", "hostname_hash": "<hex>|null" },
  "kpis":      { "duration_seconds": <number|null>, "total_waves": <number|null>,
                 "total_agents": <number|null>, "token_input": <number|null>,
                 "token_output": <number|null>, "carryover": <number|null> },
  "dimensions": [ /* see §2.7 */ ],
  "handle": "<string>|null",                   // default null
  "anonymized": <boolean>,
  "timestamp": "2026-07-16T10:00:00.000Z"      // ISO 8601, passed as a parameter
}
```

The **required** top-level fields (validated as present) are: `record_kind`,
`run_id`, `session_id`, `standard_version`, `rubric_version`, `provenance`,
`model`, `harness`, `kpis`, `dimensions`, `anonymized`, `timestamp`.
`schema_version` is stamped to `1` when absent, and `handle` defaults to `null`;
neither is required on input.

### 2.2 Identity fields

- **`schema_version`** — MUST be `1` for this standard version. The validator
  stamps `1` when the field is absent and rejects any other value.
- **`record_kind`** — MUST be `"session-eval"` in v1. This is the discriminator
  that lets a future benchmark stage reuse the same journal stream with a
  different kind, without a schema fork.
- **`run_id`** — a unique id, format `<session_id>-eval-<compactISO>`, where
  `compactISO` strips `-`, `:`, and `.` from the ISO timestamp (e.g.
  `2026-07-16T10:00:00.000Z` → `20260716T100000000Z`). Built via
  `buildRunId(sessionId, timestamp)` — **deterministic, never reads the clock**,
  so a re-verify pass reproduces the same id.
- **`session_id`** — the non-empty identifier of the session being evaluated.
- **`standard_version`** — the versioned standard identifier,
  `"aiat-llm-eval/1.0"` for records conforming to this document.
- **`rubric_version`** — a non-empty rubric identifier (e.g. `"rubric-v1"`),
  pre-registered before scoring ([§1.1](#11-pre-registration-is-the-leading-principle)).

### 2.3 `provenance`

```jsonc
"provenance": { "rubric_sha256": "<non-empty hex>", "engine_commit": "<sha>|null" }
```

- **`rubric_sha256`** — the content hash of the rubric that produced this record.
  Binds the record to exact check text; any rubric edit changes the hash and so
  is detectable. The engine computes it; the schema validates its shape.
- **`engine_commit`** — the commit of the engine that produced the record, or
  `null` when unavailable (e.g. a dirty working tree with no commit yet).

### 2.4 `model`

```jsonc
"model": { "id": "<model-id>", "source": "self-report" | "env" | "config" }
```

- **`id`** — the identifier of the evaluated model.
- **`source`** — the honest provenance of *how the id was captured*, one of:
  - `self-report` — the coordinator reported its own model id (least
    authoritative; the harness exposes no ground-truth model SSOT);
  - `env` — read from an environment variable (e.g. `ANTHROPIC_MODEL`);
  - `config` — read from configuration.

  Where a deterministic source (`env`/`config`) is available it SHOULD be
  preferred over `self-report`, and the record MUST label which source was used.
  Downstream analysis can then filter or weight by `source`. This field exists
  precisely because model self-report is unreliable — the standard records the
  uncertainty rather than hiding it.

### 2.5 `harness`

```jsonc
"harness": { "plugin_version": "<ver>", "platform": "<string>",
             "host_class": "<string>|null", "hostname_hash": "<hex>|null" }
```

- **`plugin_version`** — the orchestrator plugin version.
- **`platform`** — the harness the run executed on (e.g. `claude-code`, `codex`).
- **`host_class`** — a coarse host category, or `null`.
- **`hostname_hash`** — the hostname is stored **only** as a sha256 short-form hex
  string, or `null`. It MUST NOT be a cleartext hostname. The reference schema
  guards this with a hex pattern (`/^[a-f0-9]{8,}$/`) that structurally rejects a
  cleartext hostname (dots, uppercase, or non-hex letters) from ever being
  persisted in this field. See [§4](#4-consent--privacy-doctrine).

### 2.6 `kpis`

```jsonc
"kpis": { "duration_seconds": <number|null>, "total_waves": <number|null>,
          "total_agents": <number|null>, "token_input": <number|null>,
          "token_output": <number|null>, "carryover": <number|null> }
```

Every KPI sub-field is `number | null`. A number MUST be finite and
non-negative. A missing KPI MUST be `null`, never a guessed `0`
([§1.5](#15-dont-fake-perfect)); `normalizeEvalRecord` fills undefined → `null` on
the read path. Cost (`token_input`/`token_output`) and latency
(`duration_seconds`) are first-class ([§1.11](#111-cost-and-latency-are-first-class-kpis)).

### 2.7 `dimensions[]`

Each element of `dimensions` is one scored aspect:

```jsonc
{
  "id": "verification-evidence",
  "method": "deterministic" | "judge",
  "status": "pass" | "fail" | "not-applicable" | "cannot-determine",
  "evidence": "quality-gate exit 0 recorded in events.jsonl …",
  "score": <number|null>,           // optional
  "advisory": true,                 // judge dimensions ONLY (see §3)
  "calibration_status": "uncalibrated"  // judge dimensions ONLY (see §3)
}
```

- **`id`** — a non-empty dimension identifier.
- **`method`** — `deterministic` or `judge`. Governs which further fields are
  allowed (below).
- **`status`** — one of the four verdicts ([§1.4](#14-three-state-verdicts-with-explicit-abstention)).
- **`evidence`** — a string justification. It MAY embed file paths, prompts, or
  repo names, and is therefore **excluded** from the submission projection
  ([§4.2](#42-data-minimization--submission_fields)).
- **`score`** — optional `number | null`.
- **`advisory`** / **`calibration_status`** — judge dimensions only. A judge
  dimension MUST carry `advisory: true` (the literal value — it can never be
  persisted as `false`) and a `calibration_status` from the allowed set
  (`uncalibrated` in v1). A **deterministic** dimension MUST NOT carry either
  field; the validator rejects it if present.

### 2.8 `handle`, `anonymized`, `timestamp`

- **`handle`** — an optional self-chosen pseudonym, `string | null`, default
  `null`. The standard prefers a chosen handle over forced anonymity
  ([§4.1](#41-opt-in-submission-and-consent)).
- **`anonymized`** — a boolean submission-posture flag. On the read path, when
  absent it is derived from handle presence (no handle ⇒ anonymous ⇒ `true`).
- **`timestamp`** — an ISO 8601 string, passed to the writer as a **parameter**.
  No `Date.now()` sits on the validation or render path, so a re-verify pass and
  a report render stay byte-deterministic.

### 2.9 No global score, by construction

The validator rejects any record carrying a top-level `overall`, `total`,
`mean`, or `global_score` key. This is not a style preference — it is the
mechanical enforcement of [§1.3](#13-per-dimension-never-a-global-score). There
is no way to write a conforming record with an aggregated single number.

### 2.10 Contract summary and evolution policy

The reference module exposes four functions:

| Function | Contract |
|---|---|
| `validateEvalRecord(entry)` | Throws `ValidationError` on any violation (including a forbidden global-score key). Returns a new object with `schema_version` stamped. |
| `normalizeEvalRecord(entry)` | Never throws. Applies read-path defaults (`handle`→null, KPI undefined→null, judge-dim `advisory`→true / `calibration_status`→uncalibrated). |
| `buildRunId(sessionId, ts)` | Deterministic run-id builder; never reads the clock. |
| `projectSubmission(record)` | Nested-aware whitelist projection onto `SUBMISSION_FIELDS` ([§4.2](#42-data-minimization--submission_fields)). |

**Evolution is additive-only within a major version.** New optional fields MAY be
added in a minor revision; existing fields MUST NOT be removed, renamed, or have
their type or meaning changed except in a new major version
([§6](#6-governance)). A reader of an older record MUST still validate against a
newer minor schema.

## 3. Judge Doctrine

Some dimensions — the quality of a session narrative, adherence to instructions —
are genuinely subjective and no deterministic rule settles them. For these, an
LLM judge MAY be used, under strict constraints.

### 3.1 Advisory until calibrated

Every judge result is **advisory-only** until the judge has been κ-calibrated
against a gold set. In v1 no such calibration exists, so:

- every judge dimension MUST carry `advisory: true`;
- every judge dimension MUST carry `calibration_status: "uncalibrated"`.

The reference schema enforces both: a judge dimension cannot be persisted with
`advisory: false`, and its `calibration_status` MUST be from the allowed set
(`uncalibrated` in v1). This is the load-bearing firewall against presenting a
model's opinion as a measurement.

### 3.2 Calibration is a defined later stage

Calibration is not vague future work — it is a specified extension: assemble a
frozen, content-hashed **gold set**; measure judge–human agreement with **Cohen's
κ**; report **bootstrap confidence intervals** on that agreement; and only then
graduate a judge dimension out of `uncalibrated`. Until that stage ships and a
new `calibration_status` value is minted, judge output stays advisory. A judge's
agreement number without a CI is itself a violation of
[§1.8](#18-ci-and-tie-honesty).

### 3.3 Strict separation in record and report

Deterministic and judge dimensions MUST be visibly separated in both the record
(via `method`) and every report. A report MUST NOT blend a judge's advisory
verdict into a deterministic tally, and MUST label judge dimensions as advisory
and uncalibrated wherever they appear. A reader MUST be able to discard all judge
dimensions and still have a complete deterministic evaluation.

### 3.4 Off by default

The judge is opt-in. When it is disabled, a run produces **no** judge dimensions
and dispatches **no** judge — the deterministic core is complete on its own.

## 4. Consent & Privacy Doctrine

The standard is built for a future in which records MAY be submitted to a shared
leaderboard. v1 defines no transport or server; it defines the **consent and
data-minimization contract** that any such submission MUST obey.

### 4.1 Opt-in submission and consent

Submission is **opt-in**. No record leaves the local journal without an explicit
operator decision. The standard prefers an **optional self-chosen handle** over
forced anonymity: an operator MAY attach a `handle` to claim their results, or
leave it `null` (the default) to submit anonymously. Identity is a choice the
operator makes, not a condition the standard imposes.

### 4.2 Data-minimization — `SUBMISSION_FIELDS`

Data minimization is a construction principle, not a post-hoc scrub. The
reference module exports a **frozen whitelist**, `SUBMISSION_FIELDS`, and a
nested-aware projection, `projectSubmission(record)`. Anything not on the
whitelist is dropped from a submission projection. The whitelist deliberately
**excludes**:

- **dimension `evidence`** — it may embed file paths, prompts, or repo names;
- **any unhashed hostname** — only `harness.hostname_hash` (a sha256 hex string)
  is ever present, never a cleartext hostname;
- any rogue extra field the record happens to carry.

What the projection *does* include is the minimal set a leaderboard needs:
top-level identity/version fields, `provenance` (hash + public commit), `model`
(`id`, `source`), `harness` (`plugin_version`, `platform`, `host_class`,
`hostname_hash`), numeric `kpis`, and per-dimension `id`/`method`/`status`/
`score`/`advisory`/`calibration_status` — but **not** `evidence`.

Because the projection is fully data-driven from the frozen whitelist, a caller
cannot silently widen it: broadening the projection requires editing the frozen
whitelist, which is exactly the tripwire a conformance test is expected to guard.

### 4.3 No paths, prompts, or repo names on the wire

A submission MUST NOT carry file paths, prompt text, repository names, or a
cleartext hostname. These are the fields most likely to leak confidential or
personal context, and the whitelist is structured so that none of them can pass
through `projectSubmission`.

## 5. Limits — What this standard does not claim

This chapter is normative and deliberately deflationary. A conforming report MUST
carry an equivalent "what this does not prove" section. The three hard **don'ts**
below are the load-bearing honesty guarantees of the standard.

### 5.1 No superlatives

The standard makes **no** "best", "most accurate", "state-of-the-art", or
comparable superlative claim about any model, session, or itself. Conforming
tooling and reports MUST NOT use such language. An evaluation states what it
measured and under what conditions — nothing more.

### 5.2 No authoritative global score

There is **no** global score, aggregated index, or single headline number that is
authoritative. A record has no such field by construction
([§2.9](#29-no-global-score-by-construction)). Any aggregate a downstream tool
computes across many records (a trend, a ranking, a leaderboard position) is a
property of that analysis and its stated method — never a verdict the standard
blesses as *the* score. Presenting an aggregated index as authoritative is
non-conforming.

### 5.3 Reproducibility is scoring-replay, not deterministic model output

The reproducibility this standard claims is **evidence + scoring replay**: the
same source data, re-scored by the same engine and rubric, yields the same record
([§1.10](#110-offline-re-verify--reproducibility-as-executable-proof)). It is
**not**, and MUST NOT be presented as, a claim that the model's own outputs are
deterministic or reproducible. Model outputs are stochastic; only the *scoring of
captured outputs* is replayable. Conflating the two is the single most tempting
over-claim in the field, and it is forbidden here.

### 5.4 A single run is n = 1

A single run is n = 1. It carries **no** confidence interval and supports **no**
statistical claim about a distribution. A single-run report MUST label itself as
n = 1 without CIs. Confidence intervals and tie handling apply only to aggregates
over multiple observations ([§1.8](#18-ci-and-tie-honesty)).

### 5.5 Self-evaluation is labelled as such

When the evaluator and the evaluated are the same system — the orchestrator
scoring its own session — the result is a **self-evaluation** and MUST be labelled
as such. Self-measurement is legitimate and useful, but it is not an independent
audit, and the standard requires it to be named rather than dressed up as one.

## 6. Governance

### 6.1 Versioning the standard itself

The standard is versioned as `aiat-llm-eval/<major>.<minor>` and stamped on every
record as `standard_version`.

- A **minor** bump (`1.0` → `1.1`) is **additive and backward-compatible**: new
  optional record fields, new principles that do not invalidate existing
  conforming records, clarified prose. A record valid under `1.0` remains valid
  under `1.1`.
- A **major** bump (`1.x` → `2.0`) is reserved for **breaking** changes: removing
  or renaming a field, changing a field's type or meaning, or tightening
  validation such that previously-valid records become invalid. A major bump MUST
  ship a migration note.

`schema_version` (the record schema) tracks the standard's compatibility line:
v1 records use `schema_version 1`. The additive-only rule
([§2.10](#210-contract-summary-and-evolution-policy)) is what makes a minor bump
safe.

### 6.2 Rubric versioning is separate from the standard

The **rubric** — the concrete set of checks a run applies — is versioned
independently of the standard, via `rubric_version` and pinned per-record by
`provenance.rubric_sha256`. The standard defines *how* to evaluate honestly; a
rubric defines *what* checks a given evaluation runs. A rubric MAY be revised
(minting a new `rubric_version` and hash, per
[§1.1](#11-pre-registration-is-the-leading-principle)) without any change to the
standard, and the standard MAY evolve without forcing a rubric revision. This
separation lets check sets grow at their own cadence while the honesty contract
stays stable.

### 6.3 Change process

Any change to this standard follows the versioning rules above: additive changes
land as a minor revision with the `standard_version` bumped and the change noted;
breaking changes land as a major revision with a migration note. The record
schema (`scripts/lib/eval/schema.mjs`) and this document MUST move together — a
schema change without a corresponding standard revision, or vice versa, is a drift
the project treats as a defect.

---

*aiat-llm-eval/1.0 — 2026-07-16 — Status: v1.0. Reference implementation:
`scripts/lib/eval/schema.mjs`. Source-program mapping (confidential) is kept out
of tree in `docs/_private/` and is never part of any tracked or published
artifact.*
