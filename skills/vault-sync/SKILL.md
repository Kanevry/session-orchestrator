---
name: vault-sync
description: DESIGN BRIEF -- Future helper skill for validating and syncing project vault contents (markdown knowledge base) at session boundaries and during wave execution. Spec only; not yet implemented.
---

# Vault Sync Skill

## Status

STATUS: DESIGN BRIEF -- NOT YET IMPLEMENTED (as of 2026-04-11)

This file is a contract for a future implementation session. It captures the design decisions for a 3-layer vault validation architecture where the vault concept was prototyped end-to-end in a reference project but the session-orchestrator integration layer was deliberately deferred. The reference validator runs locally via `pnpm vault:validate`, and a CI job enforces it on every push. What is missing is the continuous in-session check described below. Treat every section as a commitment: when this skill is implemented, it must match this spec or the spec must be updated first.

## Purpose

A "project vault" is a markdown-based knowledge base living under `vault/` at the project root. Each file carries strict YAML frontmatter (id, title, tags, status, created, expires, sources) and uses wiki-style links to cross-reference peer notes. The vault is consumed by two audiences: humans browsing the knowledge base, and Sophie-style RAG agents that embed and retrieve notes during chat. Because both audiences depend on the same content, drift is expensive: a stale `status: verified` note with a dead source URL quietly poisons retrieval results, and a broken wiki-link breaks both navigation and graph traversal.

Automated validation is therefore mandatory, not optional. The vault needs four kinds of checks: frontmatter schema conformance, wiki-link integrity, source whitelist enforcement (especially for regulated content like `austrian-law` that must cite only approved government URLs), and freshness (`expires` date in the past). Session-orchestrator is the right home for the in-session layer because every project with a vault will eventually want this, and session lifecycle hooks (wave boundaries, session end, evolve) are exactly the points where drift becomes visible.

The reference architecture is 3 layers:

- **Layer A: local git hooks** (pre-commit, pre-push) -- IMPLEMENTED in reference project. Fast, fail-early, blocks bad commits.
- **Layer B: session-orchestrator:vault-sync skill** (THIS SPEC) -- PENDING. Continuous freshness inside normal session flow.
- **Layer C: remote CI job** -- IMPLEMENTED in reference project's `.gitlab-ci.yml`. Final gate, catches anything the other two miss.

Layer B is the continuous freshness layer. Its job is to run inside normal session flow without requiring developers to remember to validate. If Layers A and C are the bookends, Layer B is the spine.

## Invocation Points

### 3.1 Session-End Hard Gate

- **Trigger**: called by `session-orchestrator:session-end` skill as part of Phase 1 (quality gates), alongside typecheck / lint / test.
- **Behavior**: full validation run over the entire vault. No incremental mode here -- a clean session close must prove the whole vault is valid.
- **Error handling**: validation errors block the session close. The session-end skill surfaces them in the quality gate report and refuses to commit until they are fixed.
- **Rationale**: a clean session must leave the vault in a valid state. This is the one place where the hard gate is non-negotiable.
- **Timeout budget**: ~30s for typical vaults (<500 files). Projects with larger vaults should override via `full-validation-threshold` (see Inputs).

### 3.2 Wave-Executor Incremental Check

- **Trigger**: called by `session-orchestrator:wave-executor` after any wave whose agents modified files under `vault/**` (detected via `git diff --name-only`).
- **Behavior**: incremental validation scoped to the files changed in that wave (diff against `$WAVE_START_REF..HEAD`). Frontmatter and wiki-link resolution run on the touched files only; the source whitelist check runs on touched files only.
- **Error handling**: findings are reported inline in the wave progress output. Warnings do not block. Errors trigger a fix task for the next wave rather than aborting the current one -- the vault is a living document and incremental corrections are normal.
- **Rationale**: catch drift within a single session, not only at session end. A wave that introduces a broken wiki-link should surface it in the next wave's plan, not at the finish line.

### 3.3 Evolve Advisory Scan

- **Trigger**: called by `session-orchestrator:evolve` as part of learning extraction.
- **Behavior**: read-only freshness audit. Flags notes with `status: verified` whose `expires` date has passed, and optionally (opt-in via config) probes source URLs for 404s.
- **Error handling**: output is an advisory section in the evolve report. Never blocks.
- **Rationale**: learning extraction is the moment when patterns surface. Staleness is a pattern. Surfacing it here turns vault maintenance into a natural byproduct of the evolve cycle.

## Inputs

- **Environment variables**:
  - `VAULT_ROOT` (default: `<project-root>/vault`)
  - `VAULT_VALIDATOR_CMD` (default: `pnpm vault:validate`)
- **Session Config** -- optional `vault-sync` section:
  - `enabled: true|false` (default: `true` if `VAULT_ROOT` exists, else `false`)
  - `strict: true|false` (default: `true`; when `false`, errors downgrade to warnings in Layer B)
  - `full-validation-threshold: N` (files above this trigger incremental instead of full even in session-end; default: `500`)
  - `network-source-check: true|false` (default: `false`; controls the opt-in URL probe in Layer C)
- **Runtime context**: current git HEAD, session-start ref (for incremental diff in wave-executor)

## Outputs

- **Return value**: JSON object with the shape:
  ```
  { ok: boolean, scanned: number, validated: number, skipped: number, errors: FileError[] }
  ```
  where `FileError = { path, rule, severity, message, line?, suggestedFix? }`.
- **Exit codes**:
  - `0` -- vault is valid (or scan was skipped for a legitimate reason)
  - `1` -- validation errors (one or more files failed a rule)
  - `2` -- infrastructure error (validator command not found, `VAULT_ROOT` missing when `enabled: true`, validator crashed)
- **Surface points**:
  - Layer B (wave-executor): inline in the wave progress output, next to typecheck / lint results
  - Layer A (session-end): in the quality gate report, same format as other gates
  - Layer C (evolve): in the evolve report under "Vault Advisory"

## Error Handling Matrix

| Error Type                                                              | Severity     | Action                                                        |
| ----------------------------------------------------------------------- | ------------ | ------------------------------------------------------------- |
| Frontmatter schema violation (missing required field)                   | ERROR        | Block (hard gate) / add fix task (wave-executor)              |
| Wiki-link resolution failure                                            | ERROR        | Block (hard gate) / add fix task (wave-executor)              |
| Source whitelist violation (austrian-law without approved URL)          | ERROR        | Block (hard gate) / add fix task (wave-executor)              |
| Stale note (`expires` date in past)                                     | WARNING      | Advisory only -- never blocks                                 |
| Validator command not found (`pnpm vault:validate` missing)             | INFRA ERROR  | Skip with clear warning; do NOT fail the session              |
| Vault directory does not exist                                          | INFO         | Skip silently (project may not use vault)                     |

## Open Design Questions

1. Should incremental mode include wiki-link validation across the FULL vault, or only the files touched in this wave? Cross-reference bugs can hide in untouched files (note X suddenly has no backlinks because note Y was renamed), which argues for full scan. Performance argues for incremental. Probably hybrid: incremental for schema + touched-file links, full for the backlink graph.
2. Should the skill auto-fix trivial issues (missing `created:` date, tag case normalization, trailing whitespace) or always error out and leave fixes to humans? Auto-fix is convenient but risky inside an AI-driven session because it writes to files that agents are simultaneously editing.
3. How does this skill integrate with a future pgvector embeddings pipeline (a later roadmap phase)? Should it trigger re-embedding of changed notes, or stay strictly validation-only and leave embedding to a separate skill?
4. Should validation failures in wave-executor block the NEXT wave from starting, or only be reported as a fix task? Blocking is safer but reduces parallelism; reporting is faster but risks compounding errors across waves.
5. What is the contract for projects that have no vault at all? Skip silently (current default) or require an explicit `vault-sync.enabled: false` opt-out in Session Config? Silent skip is user-friendly but masks misconfiguration.
6. How do we handle multi-repo vaults -- e.g. a monorepo where each package has its own `vault/`, or a project that references a sibling repo's vault via a git submodule? Is there a single `VAULT_ROOT` or a list?
7. Should the skill learn from previous findings (cache last-known-clean state, skip files whose mtime has not changed) or always run fresh? Caching is a significant perf win on big vaults but introduces its own correctness risks.
8. How are secrets in vault files handled? If a note contains an accidentally-committed token in its `sources` field, should the skill block on it (SEC-type check) or is that strictly the job of the existing secret-scan pre-commit hook?

## References

- `<project>/scripts/vault/validate.ts` -- reference implementation of the validator (Layer A/C entry point)
- `<project>/scripts/vault/schema.ts` -- frontmatter schema (Zod)
- `<project>/.husky/pre-commit` STEP 3.1 -- Layer A local gate example
- `<project>/.gitlab-ci.yml` `vault:validate` job -- Layer C remote gate example
- `<project>/vault/_meta/frontmatter-schema.md` -- human-readable schema doc

## Implementation Roadmap

- **Phase 1 -- Minimal hard gate**: session-end integration only. Full validation, no incremental, no caching. Must ship as a single wave. Reads `VAULT_VALIDATOR_CMD`, executes it, parses exit code + JSON output, surfaces errors in the quality gate report. *Acceptance*: a session with a broken vault file refuses to close; a session with a clean vault closes with a "vault: valid (N files)" line in the report.
- **Phase 2 -- Incremental wave-executor integration**: add incremental diff-based scan. Wire into the wave-executor post-wave hook so it runs only when `vault/**` was touched. Wave progress reports findings inline. Introduce `full-validation-threshold` config. *Acceptance*: a wave that edits one vault file triggers a scan of exactly that file (plus its backlink graph); findings appear in the wave summary; errors generate a fix task for the next wave.
- **Phase 3 -- Advisory evolve integration + staleness**: add evolve hook, `expires` date check, optional network source check (gated behind `network-source-check: true`). Output goes to the evolve report as a non-blocking advisory. *Acceptance*: an evolve run over a vault with 3 expired notes produces an advisory listing all 3, with no impact on session success or exit code.
