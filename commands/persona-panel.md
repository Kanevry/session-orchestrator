---
description: Run a parallel multi-persona domain-expert review panel against a file, directory, or output range
argument-hint: "<target> [--personas <names,...>] [--mode <voting|hard-gate|summary>] [--threshold <M-of-N|all|any>] [--dry-run]"
disable-model-invocation: false
---

# Persona Panel

Dispatches N personas from the per-repo `.claude/personas/` catalog in parallel (one `Agent()` call per persona), consolidates their outputs, persists a sidecar to `.orchestrator/persona-panel/`, and reports the final verdict. Invoke the `persona-panel` skill with arguments: **$ARGUMENTS**

## Argument Validation

Parse `$ARGUMENTS` before doing anything else.

**Positional argument (required):**

- `<target>` — file path, directory, or range to review. Must be resolvable via `validatePathInsideProject` against the current project root. Relative paths are resolved from the project root. Globs are accepted (e.g., `src/app/api/*.ts`).

**Recognized flags:**

- `--personas <names,...>` — comma-separated subset of catalog names to include (e.g., `physicist,ai-expert`). Default: all personas discovered in `.claude/personas/`. Names are matched case-insensitively against `<name>.md` catalog files.
- `--mode <voting|hard-gate|summary>` — consolidation mode. Default: `voting`.
  - `voting` — M-of-N quorum; deterministic. Requires `--threshold M-of-N` or defaults to `all`.
  - `hard-gate` — all N personas must PASS; deterministic. `--threshold all` is the default; `--threshold N-of-N` is also accepted.
  - `summary` — coordinator LLM-aggregate of heterogeneous outputs. Emits an explicit WARN that this mode adds one additional LLM call.
- `--threshold <spec>` — quorum spec. Accepted forms: `M-of-N` where M and N are integers 1..20, `all`, or `any`. Parsed by `scripts/lib/persona-panel/threshold.mjs::parseThreshold()`. Default: `all`.
- `--dry-run` — resolve catalog, print dispatch plan, do NOT call `Agent()`, do NOT write sidecar. Exit 0 on success.

**Validation errors (all exit 1):**

- Missing `<target>`: `missing required arg <target>`.
- Unknown flag (starts with `--` but not in the list above): `unknown flag: --<name>. Valid: --personas, --mode, --threshold, --dry-run`.
- `--mode` value not in enum: `invalid --mode value: '<value>'. Valid: voting, hard-gate, summary`.
- `--threshold` value fails `parseThreshold()`: echo the parser error verbatim, e.g., `invalid threshold 'foo': expected M-of-N (M,N integers 1..20), 'all', or 'any'`.
- `<target>` outside project root: `target path outside project: <path>`.

If `<target>` is missing, print the usage line and exit 1 without invoking the skill.

## Behavior

**Phase 1 — Catalog Discovery**

The skill scans `.claude/personas/*.md` in the current repo. Each file must have YAML frontmatter with at minimum `name`, `role`, and `tier`. If `--personas` is given, only matching files are loaded; unmatched names produce a warning but do not abort (the remaining personas proceed). If zero personas are resolved after filtering, exit 1 with: `no personas resolved — check .claude/personas/ or --personas filter`.

**Phase 2 — Target Resolution**

`<target>` is validated via `validatePathInsideProject`. Globs are expanded; directories are passed as-is for the skill to recurse. The resolved target is attached to each persona's prompt context.

**Phase 3 — Parallel Dispatch**

One `Agent()` call per resolved persona. Agents run with the persona's `model` frontmatter field (default `claude-opus-4-7`). Each agent receives the persona body as its system prompt and the target file content (or directory listing) as context. Agent outputs are collected in an `outputs[]` array keyed by persona name.

**Phase 4 — Consolidation**

Mode determines the consolidation strategy:

- `voting` — count PASS verdicts. Apply `--threshold` to determine final verdict. Dissenting personas (FAIL or UNCLEAR) are listed explicitly.
- `hard-gate` — all resolved personas must return PASS. Any single FAIL or UNCLEAR produces a final verdict of FAIL. Dissenting personas are listed.
- `summary` — coordinator LLM call aggregates heterogeneous outputs into a structured narrative. A WARN is emitted before dispatch: `summary mode adds one additional LLM call`.

**Phase 5 — Sidecar Persist + Report**

Unless `--dry-run`, a sidecar is written to `.orchestrator/persona-panel/<isoTs>-<run-id>.json` matching the schema at `agents/schemas/persona-panel-sidecar.schema.json`. The sidecar includes `run_id`, `target`, `personas_invoked[]`, `outputs[]`, and `consolidation` (mode, final-verdict, dissenting-personas, audit-reason).

The command emits a summary line to stdout:

```
persona-panel: <final-verdict> (<M>/<N> PASS) — sidecar: .orchestrator/persona-panel/<filename>.json
Dissenting: <name1>, <name2>  [omitted when none]
```

## Examples

**1. Default — all catalog personas, voting mode:**

```
/persona-panel src/app/api/invoices.ts
```

Loads all `.claude/personas/*.md`, dispatches one agent per persona, applies voting with threshold `all`, writes sidecar.

**2. Specific personas:**

```
/persona-panel src/app/api/invoices.ts --personas physicist,ai-expert
```

Only the `physicist` and `ai-expert` catalog entries are dispatched. Others are skipped.

**3. Hard-gate mode, unanimous threshold:**

```
/persona-panel notes/draft.md --mode hard-gate --threshold all
```

All resolved personas must return PASS. A single FAIL produces a final FAIL verdict.

**4. Dry-run — inspect dispatch plan without executing:**

```
/persona-panel src/ --dry-run
```

Resolves catalog and target, prints the planned dispatch list (persona names, models, target), exits 0 without calling `Agent()` or writing a sidecar.

## Related

- `skills/persona-panel/SKILL.md` — skill spec: 6 phases, catalog format, dispatch mechanics, consolidation logic, sidecar schema
- `agents/schemas/persona-panel-sidecar.schema.json` — AJV Draft 2020-12 sidecar schema
- Issue #458 — wave-hook integration (persona-panel as inter-wave quality gate)
- Issue #460 — trend tracking across persona-panel runs
