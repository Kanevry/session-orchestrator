---
description: Grill a running web app's UX — a deterministic mechanical pass (axe, target size, overflow, journeys) followed by a screenshot-grounded interrogation of the operator.
argument-hint: "[url | manifest-path]"
---

# UX-Grill

Invokes the `ux-grill` skill (`skills/ux-grill/SKILL.md`). Stufe 1 measures a running loopback build route-by-route and viewport-by-viewport without any model judgment, writing `findings.jsonl` plus screenshots under `.orchestrator/metrics/ux-grill/<run-id>/` <!-- path-check: example -->. Stufe 2 then grills the operator journey by journey — one question per journey finding, every claim carrying a screenshot path. The user invoked `/ux-grill` with arguments: **$ARGUMENTS**

## Argument Validation

Parse `$ARGUMENTS` before anything else. Exactly one positional argument is recognised:

- **An absolute `http(s)` URL** (e.g. `http://127.0.0.1:3100`) → bootstrap path. The target repo has no manifest yet; the skill asks for the env names, crawls the navigation and writes one. The URL must be loopback — anything else is refused before a browser starts.
- **A file path** (ends in `.md`, or resolves to an existing file) → treat it as the manifest path, repo-relative to the target repo.
- **Empty** → the manifest at `DEFAULT_MANIFEST_PATH` (`.orchestrator/ux-manifest.md` <!-- path-check: example -->). If that file does not exist, say so and name the bootstrap form `/ux-grill <url>` — do not invent a manifest from nothing.
- **Anything else** → stop with: `ux-grill: argument must be a loopback URL or a manifest path (default .orchestrator/ux-manifest.md)`.

Examples:
- `/ux-grill` — runs against the target repo's existing manifest
- `/ux-grill http://127.0.0.1:3100` — first run: AUQ for env names, crawl, write the manifest, stop with a fill-in hint
- `/ux-grill .orchestrator/ux-manifest.md` — explicit manifest path

## Behavior

1. **Phase 0 — Target + Stufe 1** — resolve the argument, bootstrap or `loadManifest()`, run the mechanical pass as one coordinator-direct Bash call, then compare against the last run with the same `manifest_hash`.
2. **Phase 1 — Journey map** — understand / decide / act / recover per journey step, from the step screenshots; mechanical findings tabled per route.
3. **Phase 2 — Grill loop** — at most one `AskUserQuestion` per JOURNEY finding, option 1 `(Recommended)` with its cost, screenshot path in the description.
4. **Phase 3 — Recap** — resolved decisions, contradictions between screens (the primary output), open questions, mechanical counts including everything skipped.
5. **Phase 4 — Hand-off** — AUQ: audit dossier in the target repo, vault note, issues only, or done.

## No CI, no HARD-GATE

Stufe 1 is built CI-shaped (deterministic, exit-coded, LLM-free) but is deliberately not wired into any pipeline — the PRD's dose argument. `/ux-grill` gates nothing: it writes measurement artefacts, an optional dossier and — only through `reconcile.mjs` <!-- path-check: planned #1327 --> — issues. It never commits, never pushes, never edits product code.

## When to use vs. /test and /grill

| Situation | Use |
|-----------|-----|
| A running web app's UX and journeys need measuring and interrogating | `/ux-grill` |
| A CI-shaped end-to-end run with driver + `ux-evaluator` over an existing profile | `/test` |
| A plan, PRD or design needs stress-testing before any build | `/grill` |
| Per-wave design drift against the design source | `design-reviewer` (SO#1300) |

## Related

- `skills/ux-grill/SKILL.md` — full skill specification (phases, budgets, hand-off)
- `skills/ux-grill/rubric-v2.md` — check catalogue, severity table, skip reasons
- `templates/_shared/ux-manifest.template.md` — the manifest a target repo commits
- `skills/test-runner/SKILL.md` — severity routing and batched AUQ triage, adopted here
- `.claude/rules/ask-via-tool.md` — AUQ usage convention (AUQ-001..006)
