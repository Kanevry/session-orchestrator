# /persona-panel — Multi-Persona Content Review

> Standalone skill + command for running N domain-expert, buyer-persona, or compliance personas
> against a target artifact in parallel, with deterministic consolidation, hard-gate semantics,
> and timestamped sidecar records for audit and trend-tracking.

## When to use

- Reviewing a research statement or technical document from multiple expert angles simultaneously
  (e.g. a climate-research brief reviewed by a physicist and an AI expert)
- Validating AI-generated accountant output from a domain-expert lens plus a compliance lens
  before presenting it to a client
- Running a Buyer-Panel Hard-Gate on a B2B product landing page: all N buyer personas must PASS
  before the page goes live
- Any "Multi-Pair-of-Eyes" review where you want structured, auditable output from N perspectives
  without manually prompting each reviewer in turn

The panel runs personas **in parallel** — wall-clock time is roughly the slowest single persona,
not N times the slowest.

---

## Quick Start

### 1. Create the catalog directory

```bash
mkdir -p .claude/personas
```

### 2. Copy a starter template

Templates ship with the plugin at `templates/personas/`. Copy one as a starting point:

```bash
cp "$(claude plugin dir session-orchestrator)/templates/personas/klima-physicist.v1.md" \
   .claude/personas/klima-physicist.md
```

Edit the file: update `name`, `role`, `evaluation_criteria`, and the `## Mission` body section
to match your reviewer's perspective.

### 3. Confirm the catalog loads

```bash
/persona-panel docs/research/my-draft.md --dry-run
```

`--dry-run` resolves the catalog and prints the planned dispatch list without making any Agent
calls or writing any sidecar. Use it to verify setup before a real run.

### 4. Run the panel

```bash
/persona-panel docs/research/my-draft.md
```

The command dispatches one agent per persona in parallel, consolidates verdicts using the
default voting mode, and prints a Markdown table summary to stdout. A timestamped sidecar is
written to `.orchestrator/persona-panel/`.

---

## Reference Examples

### Example 1 — Research Statement Review (klima, 2-persona panel)

**Scenario:** A climate-research brief (`wfk-2.1.5.md`) needs sign-off from a domain physicist
and an AI/ML expert before it is submitted. Both must agree.

**Catalog files:** `.claude/personas/klima-physicist.md`,
`.claude/personas/klima-ai-expert.md`

```bash
/persona-panel docs/research/wfk-2.1.5.md \
  --personas klima-physicist,klima-ai-expert \
  --mode voting \
  --threshold 2-of-2
```

The `2-of-2` threshold means both personas must return `pass`. A single `fail` or `warn` from
either produces a final `fail` verdict.

**Typical stdout output:**

```
Dispatching 2 persona agents in parallel. Target: .../docs/research/wfk-2.1.5.md. Mode: voting.

## Persona Panel Report

Target: docs/research/wfk-2.1.5.md
Personas: 2 invoked | Mode: voting (threshold: 2-of-2)
Final verdict: PASS

| Persona          | Tier          | Verdict | Rationale (excerpt)                          |
|------------------|---------------|---------|----------------------------------------------|
| klima-physicist  | domain-expert | pass    | Physical assumptions consistent with AR6 ... |
| klima-ai-expert  | domain-expert | pass    | Model claims grounded, no hallucinated ...   |

Dissenting: none
Sidecar: .orchestrator/persona-panel/2026-05-20T14-30-00Z-a1b2c3d4.json
```

**Sidecar excerpt:**

```json
{
  "run_id": "a1b2c3d4",
  "target": "/abs/path/docs/research/wfk-2.1.5.md",
  "personas_invoked": [
    { "name": "klima-physicist", "version": 2, "model": "claude-opus-4-7", ... },
    { "name": "klima-ai-expert",  "version": 1, "model": "claude-opus-4-7", ... }
  ],
  "consolidation": {
    "mode": "voting-quorum",
    "final_verdict": "pass",
    "pass_count": 2,
    "fail_count": 0,
    "dissenting_personas": []
  }
}
```

---

### Example 2 — Buyer-Panel Hard-Gate (products/gotzendorfer-v2)

**Scenario:** A landing page component must pass review from all 6 buyer personas before the
copy is considered launch-ready. One `fail` blocks the whole gate.

**Catalog files:** `.claude/personas/` contains
`gotzendorfer-buyer-p1-cto.md` through `gotzendorfer-buyer-p6-*.md`.

```bash
/persona-panel src/landing-page.tsx --mode hard-gate --threshold all
```

Because `--threshold all` is the default for `hard-gate`, this is equivalent to:

```bash
/persona-panel src/landing-page.tsx --mode hard-gate
```

**If 5 of 6 personas pass (one fails):**

```
Consolidation (hard-gate-threshold): 5 pass / 1 fail / 0 warn — Final: FAIL
Dissenting: gotzendorfer-buyer-p3-kanzlei

## Persona Panel Report

Target: src/landing-page.tsx
Personas: 6 invoked | Mode: hard-gate (threshold: all)
Final verdict: FAIL

| Persona                       | Tier          | Verdict | Rationale (excerpt)                    |
|-------------------------------|---------------|---------|----------------------------------------|
| gotzendorfer-buyer-p1-cto     | buyer-persona | pass    | Value proposition clear for CTO ...   |
| gotzendorfer-buyer-p2-kanzlei | buyer-persona | pass    | Compliance language acceptable ...    |
| gotzendorfer-buyer-p3-kanzlei | buyer-persona | fail    | DSGVO section too vague for ...       |
| ...                           | ...           | pass    | ...                                   |

Dissenting: gotzendorfer-buyer-p3-kanzlei
Sidecar: .orchestrator/persona-panel/2026-05-20T16-00-00Z-b2c3d4e5.json
```

The command exits with code 1. CI pipelines and wave-executor hooks can gate on this exit code.

**To re-run after revisions:**

```bash
# After fixing the DSGVO section:
/persona-panel src/landing-page.tsx --mode hard-gate --threshold all
```

---

### Example 3 — AI Accountant Output Compliance Review (accounting)

**Scenario:** An AI accountant (Sophie) produces invoice analysis JSON. A tax-advisor persona
and a DSGVO-compliance persona must both approve before the output is delivered to the client.

**Catalog files:** `.claude/personas/accounting-tax-advisor.md`,
`.claude/personas/accounting-compliance.md`

```bash
/persona-panel sophie-outputs/2026-05-19/invoice-12345.json \
  --personas accounting-tax-advisor,accounting-compliance \
  --mode voting \
  --threshold 2-of-2
```

If the compliance persona returns `warn` (not `fail`), the tax-advisor returns `pass`, and the
threshold is `2-of-2` (pass-only):

```
Consolidation (voting-quorum): 1 pass / 0 fail / 1 warn — Final: FAIL
Dissenting: accounting-compliance (warn treated as non-pass under 2-of-2 threshold)
```

`warn` counts as a non-pass vote for quorum purposes. The sidecar records the full rationale
and recommendations from the compliance persona so the issue can be addressed specifically.

**Dry-run before dispatching (recommended for expensive Opus calls):**

```bash
/persona-panel sophie-outputs/2026-05-19/invoice-12345.json \
  --personas accounting-tax-advisor,accounting-compliance \
  --dry-run
```

---

## Configuration

### Catalog directory structure

```
.claude/personas/
  klima-physicist.md
  klima-ai-expert.md
  accounting-tax-advisor.md
  accounting-compliance.md
  gotzendorfer-buyer-p1-cto.md
  gotzendorfer-buyer-p2-kanzlei.md
```

Each file is a Markdown document with YAML frontmatter. All six frontmatter fields are required.

### Persona file structure

Full specification: `skills/persona-panel/persona-format.md`. Minimum shape:

```yaml
---
name: my-reviewer
schema_version: 1
version: 1
role: "Domain expert in [field] — evaluates [aspect] of the target"
model: claude-opus-4-7
tier: domain-expert
output_contract:
  type: object
  required: [verdict, rationale]
  properties:
    verdict:
      type: string
      enum: [pass, fail, warn]
    rationale:
      type: string
      maxLength: 4096
    recommendations:
      type: array
      items:
        type: string
evaluation_criteria:
  - "Claim X is accurate and verifiable"
  - "No contradictions with established standard Y"
---

## Mission

You are [role]. Your goal is to review the target and determine whether it meets the standards
defined in your evaluation criteria. Return a structured verdict.

## Context Files

None.

## Evaluation Criteria

[Expanded prose descriptions matching the frontmatter criteria.]

## Output Template

\```json
{
  "verdict": "pass|fail|warn",
  "rationale": "Detailed rationale (max 4096 chars).",
  "recommendations": []
}
\```
```

### Tier values

| Tier | Typical use |
|---|---|
| `domain-expert` | Technical reviewers: physicist, AI expert, legal, medical |
| `buyer-persona` | Buyer-panel hard-gates: CTO, procurement, compliance officer |
| `compliance` | DSGVO, SEC, HIPAA, ISO reviewers |
| `custom` | Any other structured reviewer |

`domain-expert` and `compliance` tiers default to `claude-opus-4-7` for model selection
(Opus finds real issues Sonnet misses — see vault learning `[[persona-opus-finds-real-failing-cibadge]]`).

### output_contract security rules

The `output_contract` field in each persona's YAML frontmatter is compiled by AJV at catalog
load time. Three structural rules are enforced before compilation:

- `$ref`, `$defs`, `allOf`, `anyOf` are **forbidden** — they enable attacker-controlled schema
  complexity attacks (ReDoS via pathological schemas)
- The schema MUST declare `verdict` in its `required` array
- The AJV compile call is wrapped in a 2-second AbortSignal timeout

A persona with a forbidden key in `output_contract` is rejected at Phase 1 (catalog load) with
an informative error. Fix the frontmatter before running the panel.

---

## Consolidation Modes

Three modes are available via `--mode`:

| Mode | Flag | Deterministic | Extra LLM call |
|---|---|---|---|
| `voting` | `--mode voting` | Yes | No |
| `hard-gate` | `--mode hard-gate` | Yes | No |
| `summary` | `--mode summary` | No | Yes (coordinator aggregate) |

**`voting` (default):** Counts PASS verdicts against `--threshold`. Suitable for panels where
a majority or supermajority is sufficient.

**`hard-gate`:** All N personas must return PASS. Any single FAIL (or WARN) produces FAIL.
Exit code 1 on FAIL — suitable for CI gates and wave-executor integration.

**`summary`:** Coordinator LLM aggregates heterogeneous outputs into a narrative. Emits a
warning before dispatch: `summary mode adds one additional LLM call`. Use voting or hard-gate
for cost-sensitive pipelines.

### Threshold spec

The `--threshold` flag accepts:

- `M-of-N` — e.g. `2-of-3`, `5-of-6`. M and N are integers 1..20.
- `all` — equivalent to `N-of-N`. Default for `hard-gate`.
- `any` — first PASS is sufficient. Unusual; use with care.

Default when omitted: `all`.

---

## Wave-Gate Integration (Issue #458)

After issue #458 ships, `persona-panel` can be configured as an inter-wave gate inside
`wave-executor`. A `persona-gate-wave` block in Session Config (in `CLAUDE.md` or `AGENTS.md`)
will run the panel automatically after the Quality wave:

```yaml
persona-gate-wave:
  enabled: true
  after: quality
  threshold: all
  mode: strict
```

Cross-reference: `docs/session-config-reference.md` will gain a `persona-gate-wave` section
when #458 is implemented. Until then, run `/persona-panel` manually between waves or at
session-end.

---

## Security Notes

**Per-repo catalog only.** The `.claude/personas/` directory is per-repo and never stored in
the plugin. This is intentional: climate-research repos need physicists; SaaS repos need buyer
personas; compliance repos need auditors. A plugin-central catalog would block that diversity.

**Flat output_contract schemas.** The `output_contract` in each persona's YAML frontmatter must
be a flat inline JSON Schema Draft 2020-12 object. The keywords `$ref`, `$defs`, `allOf`, and
`anyOf` are forbidden. This guards against pathological schemas that could cause the AJV
compiler to hang (schema-complexity DoS).

**Sidecar path confinement.** Sidecar files are written exclusively to
`.orchestrator/persona-panel/` inside the project root. The path is validated via
`validatePathInsideProject` from `scripts/lib/path-utils.mjs` before any write. Sidecars
cannot be written outside the repo boundary.

**Model field validation.** Each persona's `model:` field is validated at catalog load time
against `MODEL_ID_RE` and `ALLOWED_MODEL_ALIASES` from `scripts/lib/agent-frontmatter.mjs`. A
persona declaring an unrecognized model string is rejected with an informative error.

**Concurrency cap.** A maximum of 20 personas can run in a single panel invocation. If the
active set exceeds 20, the run is truncated alphabetically and a warning is emitted.

---

## Trend Tracking (Future — Issue #459)

Issue #459 will add a `--trend` sub-command that compares sidecar records across runs and flags
verdict drift (a persona that was passing now fails, or vice versa). The `prompt_hash` field in
each sidecar entry — a sha256 over the canonicalized persona inputs — enables detecting whether
a change in persona content or model caused the drift, or whether the target artifact changed.

Trend tracking is data-gated on at least 3 runs against the same target with the same persona
set. It will not be useful before that threshold.

---

## Sidecar Location

All runs write a JSON sidecar to:

```
.orchestrator/persona-panel/<isoTimestamp>-<runId>.json
```

Example: `.orchestrator/persona-panel/2026-05-20T14-30-00Z-a1b2c3d4.json`

The sidecar schema is at `agents/schemas/persona-panel-sidecar.schema.json` (AJV Draft
2020-12). The file is written atomically via `writeJsonAtomic()` from `scripts/lib/io.mjs`
(tmp-then-rename, prevents partial writes). Schema validation runs against the sidecar object
before write — an invalid sidecar causes exit 1, nothing is written.

Add `.orchestrator/persona-panel/` to `.gitignore` to keep run records out of version control,
or commit them if you want an auditable history.

---

## See Also

- `commands/persona-panel.md` — command reference: argument syntax, flag validation, examples
- `skills/persona-panel/SKILL.md` — full skill spec: 6 phases, catalog format, dispatch
  mechanics, consolidation logic, sidecar schema
- `skills/persona-panel/persona-format.md` — persona file format specification: frontmatter
  fields, body sections, verdict contract, security rationale for criteria delimiters
- `templates/personas/*.v1.md` — 6 catalog templates: `klima-physicist`, `klima-ai-expert`,
  `accounting-tax-advisor`, `accounting-compliance`, `gotzendorfer-buyer-p1-cto`,
  `gotzendorfer-buyer-p2-kanzlei`
- `agents/schemas/persona-panel-sidecar.schema.json` — sidecar JSON Schema (Draft 2020-12)
- Issue #457 (foundation), #458 (wave-hook integration), #459 (trend tracking), #460 (catalog
  templates)
