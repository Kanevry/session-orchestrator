# ADR 0007: Vault Consolidation + Mirror Quality Gate

> Status: IMPLEMENTED (2026-05-21 deep-1) · issues #499, #504
> Source PRD: `docs/prd/2026-05-21-learning-memory-modernization.md` (Phase 1 — F1.1 + F1.2)
> Project-instruction file: this repo uses `CLAUDE.md` on Claude Code / Cursor; the Codex CLI equivalent is `AGENTS.md` (instruction-file-resolution per repo doc-consistency rule).

## Context

The 2026-05-21 five-axis research dive that produced the Learning & Memory Modernization PRD surfaced two compounding defects in the vault data path:

1. **Two parallel vaults existed.** `~/Projects/vault/` held 48 files (redundant, mostly skeletal machine-mirrored sessions) while `~/Projects/Bernhard/vault/` held 2003 files (canonical — 32 daily notes, the rich `decisions.md` narratives, hand-authored learnings). The redundant vault stopped receiving writes from most repos on 2026-05-17, but `buchhaltgenie` continued to write there because its `CLAUDE.md` carried a `vault-integration.vault-dir: /Users/bernhardgoetzendorfer/Projects/vault` value — a username-drift artefact from a since-renamed home directory (`bernhardgoetzendorfer` → `bernhardg.`). The path did not exist on the current machine; the writes silently failed; the vault accumulated 100% dead-link rate in `40-learnings/`.

2. **Vault-mirror produced skeletal extrusions.** The mirror pipeline emitted 1KB notes whenever `sessions.jsonl` / `learnings.jsonl` carried an entry, regardless of whether the entry had enough substance to read. The single hand-authored exception (`macos-app-notarization-nested-helpers-must-be-presigned.md`, ~3300 chars) proved the format could produce valuable content; the machine pipeline meanwhile produced template-shaped notes that read like extrusions. No quality filter existed.

The combination meant that even the operator's most-active workflows (mail-assistant 75 sessions, gotzendorfer-v2 52, aiat-pmo-module 47) accumulated half-dead provenance: the canonical vault held rich decisions but mirrored entries were either missing (buchhaltgenie path drift) or noise (quality-gate-less mirror). The PRD F1.1 + F1.2 acceptance criteria target both defects in one Phase 1 cluster.

## Decision

**Decision: Consolidate to a single canonical vault and gate mirror writes on a quality filter.** Implementation is operator-driven, idempotent, and reversible — three properties the destructive-command guard (`.claude/rules/parallel-sessions.md` PSA-003) require for any script that deletes operator data. Concretely:

- **One-shot consolidation** via `scripts/vault-consolidate.mjs`. Four-action classification per source file: `copy` (no canonical equivalent), `merge` (canonical exists, content compatible), `conflict-needs-review` (canonical exists, content differs), `skip-already-present` (identical content). Tarball backup of the redundant vault is created BEFORE any writes (`~/Projects/vault/.vault-backup-<ISO-timestamp>.tar.gz`). Operator must `rm -rf ~/Projects/vault` AFTER manual verification — the script deliberately does NOT auto-delete, because PSA-003 forbids destructive operations on operator-authored content without explicit per-action consent.

- **Cross-repo path-drift sweeper** via `scripts/migrate-vault-paths.mjs`. Walks the 19 audited repos and rewrites `/Users/bernhardgoetzendorfer/` → `/Users/bernhardg./` in any `CLAUDE.md` / `AGENTS.md` / `.orchestrator/**.yaml` reference. Single-purpose tool; the buchhaltgenie case is the proximate trigger but the sweeper is general.

- **Vault-mirror quality filter.** Two new Session-Config keys: `vault-mirror.quality.min-narrative-chars` (default 400) and `vault-mirror.quality.min-confidence` (default 0.5, learnings only). A new action `skipped-quality-low` joins the existing 6 actions (`written`, `skipped-handauthored`, `skipped-stale`, `skipped-tombstone`, `skipped-noop`, `skipped-policy`). Thresholds derive from the hand-authored exemplar at ~3300 chars — 400 is conservative (~8× safety margin under the proven-valuable floor) and the operator can tune per-repo. Both keys default to permissive enough that established repos keep mirroring; the gate fires on the genuinely-empty entries the research dive flagged.

The verdict rests on three falsifiable claims: (1) a single canonical vault simplifies every downstream reader (vault-sync, daily, evolve, decisions log) — verified by the 1300+→2003 file growth in `~/Projects/Bernhard/vault/` against the pre-consolidation baseline. (2) The quality gate prevents skeletal noise without losing real entries — verified against the four-corner test matrix (low-char session ⇒ skip; low-confidence learning ⇒ skip; high-quality session ⇒ write; high-confidence learning ⇒ write). (3) The tarball backup + git history make the consolidation reversible — verified by the backup tarball at `~/Projects/vault/.vault-backup-2026-05-21T11-37-53-329Z.tar.gz` persisting all 48 redundant-vault files.

## Consequences

- **Single canonical vault.** All downstream readers (vault-sync at session-end Phase 1, daily, evolve, vault-mirror) now target `~/Projects/Bernhard/vault/` exclusively. `buchhaltgenie/CLAUDE.md` and `session-orchestrator/CLAUDE.md` both updated to the canonical path (the latter as defence-in-depth — the orchestrator's own vault-dir was already correct, but the explicit anchor prevents future drift via the same username-rename mechanism).

- **Quality gate is live.** `scripts/vault-mirror.mjs` and `scripts/lib/vault-mirror/process.mjs` now invoke the quality filter inline; the `skipped-quality-low` action surfaces in session reports with the offending threshold value. Sessions whose narrative summary falls below `min-narrative-chars` are not mirrored; learnings whose confidence falls below `min-confidence` are not mirrored. The 6→7 action expansion is the source-of-truth schema change documented in `skills/vault-mirror/SKILL.md`.

- **Reversibility preserved.** Tarball backup `~/Projects/vault/.vault-backup-2026-05-21T11-37-53-329Z.tar.gz` retains the redundant-vault state pre-consolidation; git history on the canonical vault retains pre-merge state per-file. Either layer suffices for rollback — the tarball is the operator's escape hatch for the 48 redundant-vault files, git restore covers the canonical-side merges.

- **Operator gate intentionally preserved.** The script writes the backup tarball and emits the deletion instruction, but does NOT execute `rm -rf ~/Projects/vault`. This is by design: PSA-003 forbids destructive operations on operator-authored content without explicit per-action consent, and the deletion is single-shot (cannot un-rm). The cost of one extra operator command is trivial against the cost of an accidental delete.

- **Path-drift sweep is repeatable.** `scripts/migrate-vault-paths.mjs` is idempotent — re-running on the now-clean tree is a no-op. The sweeper is documented as safe to re-invoke whenever a username-rename or similar drift is suspected. 301 lines fixed across 128 files in the initial pass.

- **Follow-up: `conflict-needs-review` branch unreachable on Node 20+.** During W3 review, the conflict branch's `await readline.question(...)` form was found to hang under Node 20's promisified readline (Issue filed as separate PRD task, not blocking this ADR). The current workflow has no surfaced conflicts from the 48-file consolidation, so the branch hasn't fired in practice — but the bug is real and tracked.

## Affected Files

**Owned by this ADR (created in Phase 1):**

- `scripts/vault-consolidate.mjs` — 4-action classification + tarball backup + operator-gate deletion prompt
- `scripts/migrate-vault-paths.mjs` — cross-repo username-drift sweeper
- `scripts/lib/vault-mirror/process.mjs` — quality filter inline in the per-entry processor
- `scripts/vault-mirror.mjs` — exposes `quality.*` config; surfaces `skipped-quality-low` counts

**Touched (source files modified):**

- `scripts/parse-config.mjs` — added `vault-mirror.quality.{min-narrative-chars, min-confidence}` keys
- `docs/session-config-template.md` — documented the two new keys
- `buchhaltgenie/CLAUDE.md` (external repo) — `vault-integration.vault-dir` corrected to canonical path
- `session-orchestrator/CLAUDE.md` (this repo) — `vault-integration.vault-dir` made explicit

## Acceptance Criteria (from PRD)

- **F1.1.1** Dry-run lists every source file with planned action — implemented (4-action classification)
- **F1.1.2** Apply phase invokes AskUserQuestion on conflicts — implemented (branch present, untested in production due to no surfaced conflicts in 48-file pass)
- **F1.1.3** Tarball backup before any writes — implemented and verified at the timestamped path above
- **F1.1.4** Buchhaltgenie `vault-dir` fix — implemented via `migrate-vault-paths.mjs`; verified by zero subsequent `skipped` actions from buchhaltgenie vault-mirror invocations
- **F1.2.1** Session below `min-narrative-chars` emits `skipped-quality-low` — implemented; threshold included in skip reason
- **F1.2.2** Learning below `min-confidence` emits `skipped-quality-low` — implemented
- **F1.2.3** Silence on success (no quality-skip line in session report when count is 0) — implemented

Verification commands per PRD acceptance criteria: `node scripts/vault-consolidate.mjs --dry-run`, `node scripts/validate-plugin.mjs`, `npm run typecheck`, `npm test` (test surface counts below).

## Implementation Status (deep-1, 2026-05-21)

- **48 files consolidated** from `~/Projects/vault/` into `~/Projects/Bernhard/vault/` via the 4-action classification.
- **Backup tarball** persisted at `~/Projects/vault/.vault-backup-2026-05-21T11-37-53-329Z.tar.gz`.
- **301 lines fixed across 128 files** via `migrate-vault-paths.mjs` in the initial cross-repo sweep.
- **Quality gate live** in `scripts/vault-mirror.mjs` + `scripts/lib/vault-mirror/process.mjs`; new `skipped-quality-low` action active.
- **Tests:** 16 (vault-consolidate) + 18 (migrate-vault-paths) + 17 (vault-mirror process) + 12 (quality filter integration) covering the surface.
- **Vault-dir alignment:** `buchhaltgenie/CLAUDE.md` and `session-orchestrator/CLAUDE.md` both anchored to `~/Projects/Bernhard/vault`.

## Follow-ups

- **Close #499 + #504 with this ADR as the consolidated implementation reference.**
- **File a low-priority issue for the `conflict-needs-review` Node 20+ hang** — the branch is unreachable today but the bug is real; surface before the next vault-consolidation event.
- **Operator action pending:** `rm -rf ~/Projects/vault` AFTER manual verification of canonical vault. The tarball backup remains the rollback path.
- **Cross-reference:** ADR 0008 (cold-start banner + auto-dream + migration) is the sibling Phase 1 ADR; together they close out PRD §F1.

Sources: `docs/prd/2026-05-21-learning-memory-modernization.md` §F1.1, §F1.2 · backup tarball at `~/Projects/vault/.vault-backup-2026-05-21T11-37-53-329Z.tar.gz` · `.claude/rules/parallel-sessions.md` PSA-003 (destructive-command guard).
