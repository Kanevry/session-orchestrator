---
name: docs-orchestrator
user-invocable: false
tags: [docs, orchestration, audiences]
model-preference: sonnet
description: >
  Opt-in orchestration for documentation generation and updates within a
  session. Maps session scope to audience-specific docs tasks (User / Dev /
  Vault), dispatches the docs-writer agent with source-grounded prompts, and
  reports coverage gaps to session-end. Gated on
  `docs-orchestrator.enabled: true` in Session Config. Zero overhead when
  disabled.
---

# Docs Orchestrator Skill

docs-orchestrator coordinates the full documentation lifecycle inside a session: it
detects which audiences (User, Dev, Vault) are touched by the agreed scope, generates
audience-specific task definitions, threads them into the session-plan pipeline, and
verifies that docs tasks produced diffs once waves complete. The skill is opt-in and
default-off — when `docs-orchestrator.enabled: false`, all three hook points
short-circuit with no output and no cost. docs-orchestrator fills the generative-content
gap that sibling skills leave open: `vault-sync` validates but does not write, `vault-mirror`
writes metrics-derived `_overview.md` entries but not narratives, `claude-md-drift-check`
diagnoses CLAUDE.md drift but does not remediate it, and `daily` exclusively owns
`03-daily/*`. docs-orchestrator is the only skill that produces new prose grounded in
session output.

## Invocation

Not user-invocable. Triggered at three hook points within the session lifecycle:

1. **session-start Phase 2.5 "Docs Planning"** — after user alignment, before handing
   off to session-plan. Reads the agreed scope, runs audience detection (Phase 2 below),
   and threads the detected audience list into the plan context so session-plan can
   classify tasks correctly.
2. **session-plan Step 1.5 Agent Registry** — `docs-writer` is added to the agent
   registry when docs tasks are present; tasks carrying role `Docs` are assigned to it
   (see session-plan Step 1.8).
3. **session-end Phase 3.2 "Docs Verify"** — after waves complete, verifies that each
   `Docs`-classified task produced a diff in the expected file-pattern target and reports
   gaps per `docs-orchestrator.mode`.

All three hook points are gated on `docs-orchestrator.enabled: true`. When disabled,
every hook exits immediately after the config read.

## Phase 1: Read Session Config

Read Session Config per `skills/_shared/config-reading.md`. Extract:

- `docs-orchestrator.enabled` (boolean, default `false`)
- `docs-orchestrator.audiences` (list, default `[user, dev, vault]`)
- `docs-orchestrator.mode` (`warn` | `strict`, default `warn`)

If `enabled: false`, exit immediately with no output. Do not log, do not query scope.

## Phase 2: Audience Scope Detection

Given the agreed session scope (from the session-start Q&A), determine which audiences
are touched by the planned work:

- **User** — new CLI flags or commands, breaking API changes, install-flow changes,
  new user-facing features, changed examples.
- **Dev** — architecture decisions, major refactors, new modules or subsystems, test
  coverage changes, dependency upgrades, ADR-level choices.
- **Vault** — project status changes, ownership transitions, stack or infra decisions,
  cross-project dependencies, migrations, archival events.

See `audience-mapping.md` (in this directory) for the authoritative file-pattern table,
source rules per audience, and the non-overlap contracts with sibling skills.

Intersect the detected audiences with the `docs-orchestrator.audiences` config value.
Subset selection is supported — e.g., `audiences: [user, dev]` omits Vault writing even
when Vault signals are present in scope.

## Phase 3: Task Generation

For each selected audience, generate one or more docs tasks and thread them into the
wave plan:

Each task must specify:
- **audience** — `user`, `dev`, or `vault`
- **file-pattern target** — the glob from `audience-mapping.md` that bounds where the
  docs-writer may write
- **trigger** — which scope element motivates this task (e.g., "new `--dry-run` flag
  added to CLI")
- **allowed sources** — `diff`, `git-log`, `session-memory`, `affected-files` (see
  `audience-mapping.md` Source Rules)

Tasks flow through the standard session-plan pipeline. They are role-classified as
`Docs` and assigned to the `docs-writer` agent at Step 1.8. No custom dispatch path
is required.

## Phase 4: Docs-Writer Dispatch (via wave-executor)

docs-orchestrator does not dispatch the docs-writer directly. Dispatch happens inside
wave-executor's normal `Agent()` tool call flow, the same path all other roles follow.
This skill's job in Phase 4 is to ensure each task's prompt is fully specified before
hand-off.

Each docs-writer task prompt must include:

1. The task description and the file-pattern target (from Phase 3).
2. The allowed sources list: diff (`git diff $SESSION_START_REF..HEAD`), git-log,
   session-memory, affected-files. No other sources are permitted.
3. The hallucination ban: any section without a traceable source gets
   `<!-- REVIEW: source needed -->`. The docs-writer NEVER invents content.
4. Explicit forbidden targets:
   - `<vault>/01-projects/*/_overview.md` — owned by vault-mirror, must not be edited.
   - `<vault>/03-daily/*` — owned by daily, must not be edited.

See `audience-mapping.md` "Example Prompt Skeleton for docs-writer" for a concrete
template to copy.

## Phase 5: Verification (session-end Phase 3.2)

After waves complete, session-end Phase 3.2 calls back into this skill:

1. Collect every task classified as `Docs` in the plan.
2. For each task, resolve the expected file-pattern target and check for a diff:
   ```bash
   git diff --name-only $SESSION_START_REF..HEAD
   ```
   Match the output against the task's file-pattern target using glob matching.
3. Classify gaps by severity:
   - **missing diff** — no matching file was changed; the task did not run.
   - **partial** — a matching diff exists but one or more sections contain
     `<!-- REVIEW: source needed -->` markers; the file needs human review before
     the next release.
4. Report per `docs-orchestrator.mode`:
   - `warn` — log all gaps as advisories in the session final report. Non-blocking;
     `/close` proceeds normally.
   - `strict` — block `/close` until every gap is either resolved (diff exists, no
     REVIEW markers) or explicitly overridden by the user via AskUserQuestion.

## Non-Overlap with Sibling Skills

- **vault-sync** — validates frontmatter schema; docs-orchestrator generates content.
  Complementary: vault-sync runs after docs-writer writes, catching any schema drift
  introduced by new docs.
- **vault-mirror** — writes `_overview.md` from JSONL metrics records; docs-orchestrator
  writes human-readable narratives in `context.md`, `decisions.md`, and `people.md`.
  Non-overlapping targets by design.
- **claude-md-drift-check** — detects drift in CLAUDE.md (diagnostic only);
  docs-orchestrator remediates via the Dev audience path (generative). Complementary:
  drift-check can flag what docs-writer fixes. They must not run on CLAUDE.md in parallel
  within the same session.
- **daily** — exclusively owns `<vault>/03-daily/YYYY-MM-DD.md`. This is a forbidden
  target for docs-orchestrator; the docs-writer prompt must carry this constraint
  explicitly (see Phase 4).

## Session Config Reference

The three fields below are parsed in `scripts/lib/config.mjs` (`_parseDocsOrchestrator`)
and validated in `scripts/lib/config-schema.mjs` (`validateDocsOrchestrator`). Defaults
apply when the block is absent.

```yaml
docs-orchestrator:
  enabled: false          # opt-in, default off
  audiences: [user, dev, vault]  # subset selection supported
  mode: warn              # warn | strict (canonical enum, #217)
```

- `enabled` — master switch. When `false`, all three hook points short-circuit.
- `audiences` — which audiences to generate tasks for. Any subset of
  `[user, dev, vault]` is valid.
- `mode` — verification strictness. `warn` surfaces gaps as advisories;
  `strict` blocks `/close` until gaps are cleared.

## Anti-Patterns

- **DO NOT write docs without a traceable source.** Every section must trace to diff,
  git-log, session-memory, or affected-files, or carry `<!-- REVIEW: source needed -->`.
- **DO NOT edit `_overview.md` or `03-daily/*`.** These are owned by vault-mirror and
  daily respectively. The docs-writer prompt must list them as forbidden targets.
- **DO NOT duplicate the audience-mapping table.** Always reference `audience-mapping.md`
  in this directory — never inline the table into a task prompt or another skill.
- **DO NOT dispatch docs-writer outside the wave-executor flow.** Docs tasks must go
  through the standard task → wave-executor → Agent() path so they appear in STATE.md,
  metrics, and the session final report.
