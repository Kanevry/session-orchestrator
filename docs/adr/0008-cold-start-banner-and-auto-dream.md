# ADR 0008: Cold-Start Banner + Auto-Dream + Migration

> Status: IMPLEMENTED (2026-05-21 deep-1) · issues #500, #502, #507
> Source PRD: `docs/prd/2026-05-21-learning-memory-modernization.md` (Phase 1 — F1.3 + F2.2)
> Project-instruction file: this repo uses `CLAUDE.md` on Claude Code / Cursor; the Codex CLI equivalent is `AGENTS.md` (instruction-file-resolution per repo doc-consistency rule).

## Context

The 2026-05-21 cross-repo reality audit surveyed 19 active repos and produced one headline finding: **58% cold-start abandonment.** Six repos (claude-usage-tracker, Macchiato, onenote, ai-factory-n8n, aiat-pmo, launchpad-ai-factory) had full `CLAUDE.md` + `.orchestrator/` provisioning, valid `bootstrap.lock`, and zero `sessions.jsonl` entries. The most damning case was launchpad-ai-factory: deluxe setup (`CLAUDE.md` + `AGENTS.md` + bootstrap.lock standard-tier) and zero sessions ever. Bootstrap fires, the system stays silent, the operator does not return. No surface signal nudges the operator back; the system has nothing to say between "you ran bootstrap" and "you ran a session".

A second-order defect compounded this: **memory consolidation was manual-only.** `/memory-cleanup` runs only when the operator invokes it; drift accumulates between manual runs. The Hermes Agent reverse-engineering work (PRD §Research Provenance step 3) documented the failure mode bluntly — Hermes' inactivity-triggered Curator pattern auto-applies, and its `MEMORY.md` overwrites silently destroy operator hand-edits (Hermes Issue #7826, "ALLOW-ALL security default", referenced in PRD). The two pieces — silent cold-start and manual-only memory consolidation — meet at the same architectural seam: the orchestrator has no scheduled "between sessions" voice. It speaks only when the operator opens it, and only about what the operator asks for.

The PRD F1.3 + F2.2 + F2.3 cluster targets both ends of that seam. Cold-start banner gives the orchestrator a one-shot voice for the empty-state cohort. Auto-dream gives it a periodic dry-run voice for the established cohort. The migration step is the bridge — it seeds the six dormant repos with a marker file so the banner fires on their next open, retroactively converting the audit finding into a behaviour change rather than a one-shot fix.

## Decision

**Decision: Wire a deterministic cold-start detector to the SessionStart hook, add an auto-dream phase to session-end gated on threshold OR soft-limit, and seed dormant repos via a one-shot migration script.** The verdict rests on three claims, each falsifiable independently:

1. **Cold-start detection is pure-function over filesystem state.** `scripts/lib/cold-start-detector.mjs` reads `bootstrap.lock.timestamp`, `sessions.jsonl` line count, and the optional `.orchestrator/welcome-banner-pending` marker; it returns a `{ shouldBanner: bool, reason: string }` verdict. No LLM, no network, no race condition with concurrent sessions. The hook wiring (`hooks/on-session-start.mjs`) calls the detector and emits a single banner block when `shouldBanner === true`. Auto-silence is the marker-deletion side effect: once a session closes, the marker is gone and the detector returns false forever after.

2. **Auto-dream is dry-run-default, operator-applied.** `scripts/lib/auto-dream.mjs` and `skills/session-end/SKILL.md` Phase 3.6.5 dispatch `/memory-cleanup --dry-run` when `MEMORY.md` lines > `memory-cleanup-soft-limit` OR sessions-since-last-cleanup ≥ `memory-cleanup-threshold`. The proposed consolidation diff is written to `.orchestrator/pending-dream.md`. The operator applies in the next session via `/memory-cleanup --apply-pending`. **No silent rewrite of `MEMORY.md` happens** — this is the explicit departure from Hermes' design and the direct mitigation for PRD §Risks "Hermes-style ALLOW-ALL security trap". A pending-dream file older than 14 days is rejected by `--apply-pending` on staleness grounds (the operator must re-run `--dry-run`); this prevents apply-out-of-context drift.

3. **Migration is a one-shot zero-byte marker.** `scripts/migrate-cold-start-seed.mjs` writes `.orchestrator/welcome-banner-pending` (empty file) into each of the six dormant repos identified by the audit. The cold-start detector treats the marker as an unconditional banner-trigger override (independent of the bootstrap-age / sessions-count thresholds). After the next session-end, the marker is deleted; the banner does not fire again. The six dormant repos thus receive exactly one banner each, on their next open.

The narrow Phase 1 scope is deliberate. PRD F2.3 ("Visible 'what I remembered' Session-Start Banner") is the richer Phase 2 banner — top-5 learnings, memory-stats, peer-card excerpts. **F2.3 is NOT shipped in this ADR** and is tracked separately under issue #505. The cold-start banner shipped here is the empty-state minimum: a one-shot nudge for the cohort that has nothing to surface yet. The two banners are distinct surfaces with distinct triggers; the cold-start banner is auto-silenced after first session-end, whereas the "what I remembered" banner (Phase 2) fires on every session-start until config-disabled.

Session Config keys: `cold-start.nudge-after-hours` (default 1), `cold-start.silence-after-sessions` (default 1), `memory-cleanup-soft-limit` (default 180), `memory-cleanup-threshold` (default 5). All four are conservative defaults — the banner fires after a 1h cooldown to avoid double-nudging an operator who just ran bootstrap and is mid-setup; auto-dream fires at 180 lines or every 5 sessions, both well within the established memory-cleanup intuition.

## Consequences

- **Cold-start cohort gets a one-time nudge.** The six dormant repos seeded by the migration script will banner exactly once on their next open. The banner copy includes a single-line value pitch and the timestamp of bootstrap completion — enough signal for the operator to understand the orchestrator is alive and waiting, not broken. After session-end deletes the marker, the banner does not fire again — auto-silence is structural, not a config toggle.

- **Auto-dream produces drifts without applying them.** `pending-dream.md` is the operator's preview of the proposed consolidation. The operator can read it, hand-edit, reject, or apply via `--apply-pending`. No silent rewrite of `MEMORY.md` happens, matching the PRD §Risks mitigation for "Hermes-style ALLOW-ALL security trap" and `.claude/rules/parallel-sessions.md` PSA-003 (destructive-command guard). The 14-day staleness rejection prevents apply-out-of-context — if the operator returns after a long absence, the pending dream is regenerated rather than blindly applied.

- **The cold-start surface auto-silences.** The marker-deletion side effect at session-end means no operator can be banner-spammed across multiple sessions. The detector's `shouldBanner` becomes false the moment `sessions.jsonl` has ≥ `cold-start.silence-after-sessions` entries (default 1) — a single closed session is enough to permanently silence the cold-start surface.

- **Operator overrides are explicit and Session-Config-gated.** `cold-start.nudge-after-hours: 999999` effectively disables the banner; `memory-cleanup-threshold: 0` disables auto-dream. Both kill-switches are documented in `docs/session-config-template.md`; both are honoured deterministically by the respective entry points.

- **F2.3 deferred.** The richer "what I remembered" banner (top-5 learnings + memory-stats + peer-card excerpts, PRD §F2.3) is NOT in this ADR. The cold-start banner is the empty-state minimum surface; the F2.3 banner is the established-cohort surface. They share no code path and are deliberately separable. Tracked as issue #505.

- **Migration is one-shot and idempotent.** Re-running `migrate-cold-start-seed.mjs` against the now-seeded repos is a no-op (marker exists → script skips). Re-running against a repo that has since had a session-close is also a no-op (marker would have been deleted, but cold-start detector now reads `sessions.jsonl > 0` and returns false even if the marker were re-written by mistake).

- **Pre-existing PSA-003 contract honoured.** No destructive command is issued autonomously by either subsystem. The cold-start banner only emits text; the marker deletion is a single small file owned by this subsystem. Auto-dream's `--apply-pending` requires an explicit operator command — the operator types the slash command, not an agent.

## Affected Files

**Owned by this ADR (created in Phase 1):**

- `scripts/lib/cold-start-detector.mjs` — pure-function detector returning `{ shouldBanner, reason }`
- `scripts/lib/auto-dream.mjs` — threshold/soft-limit evaluation + `/memory-cleanup --dry-run` dispatch + `pending-dream.md` writer
- `scripts/migrate-cold-start-seed.mjs` — one-shot seeder of `.orchestrator/welcome-banner-pending` markers

**Touched (source files modified):**

- `hooks/on-session-start.mjs` — wired to `cold-start-detector.mjs`; emits banner when `shouldBanner === true`
- `skills/session-end/SKILL.md` — added Phase 3.6.5 (auto-dream dispatch + pending-dream write)
- `skills/memory-cleanup/SKILL.md` — added `--dry-run` and `--apply-pending` mode documentation
- `scripts/parse-config.mjs` — added `cold-start.*` and `memory-cleanup-*` keys
- `docs/session-config-template.md` — documented all four new keys

## Acceptance Criteria (from PRD)

- **F1.3.1** SessionStart hook emits cold-start banner when `bootstrap.lock` >1h old and `sessions.jsonl` empty — implemented
- **F1.3.2** Banner NOT printed after first closed session — implemented (auto-silence via line count check)
- **F1.3.3** Migration seeds `.orchestrator/welcome-banner-pending` in dormant repos; banner fires once then marker deleted — implemented; 6 markers seeded
- **F1.3.4** Configurable `cold-start.nudge-after-hours` honoured — implemented
- **F2.2.1** Auto-dream dispatches `/memory-cleanup --dry-run` and writes `.orchestrator/pending-dream.md` — implemented
- **F2.2.2** Threshold OR soft-limit both trigger — implemented (OR semantics confirmed in tests)
- **F2.2.3** `--apply-pending` applies and deletes the pending file — implemented
- **F2.2.4** `memory-cleanup-threshold: 0` is a full kill-switch — implemented
- **F2.3** "What I Remembered" rich banner — **INTENTIONALLY DEFERRED to Phase 2** (issue #505); not in scope of this ADR

Verification commands: `node scripts/validate-plugin.mjs`, `npm run typecheck`, `npm test` (test surface counts below).

## Implementation Status (deep-1, 2026-05-21)

- **6 markers seeded** in dormant repos via `migrate-cold-start-seed.mjs` (claude-usage-tracker, Macchiato, onenote, ai-factory-n8n, aiat-pmo, launchpad-ai-factory).
- **Detector + hook wiring complete** — `scripts/lib/cold-start-detector.mjs` is the source of truth for the banner-emit verdict; `hooks/on-session-start.mjs` calls it.
- **Auto-dream lib + session-end Phase 3.6.5 + memory-cleanup CLI flags complete** — `scripts/lib/auto-dream.mjs` is the dispatcher; `skills/session-end/SKILL.md` documents Phase 3.6.5; `skills/memory-cleanup/SKILL.md` documents `--dry-run` and `--apply-pending`.
- **Tests:** 17 (cold-start-detector) + 13 (migrate-cold-start-seed) + 25 (auto-dream) covering the surface.
- **F2.3 NOT shipped** — Phase 2 banner (top-5 learnings, memory-stats, peer-card excerpts) is intentionally deferred; tracked as #505.

## Cross-References

- **PRD §F1.3** — Cold-Start Abandonment Fix
- **PRD §F2.2** — Auto-Dream Post-Session-Hook (dry-run-default)
- **PRD §F2.3** — Visible "what I remembered" Session-Start Banner (Phase 2; NOT in this ADR)
- **ADR 0007** — Vault Consolidation + Mirror Quality Gate (sibling Phase 1 ADR; together they close out PRD §F1)
- **Related Phase 2 issues:** #501 (memory.propose tool), #503 (USER.md + AGENT.md peer cards), #505 (rich "what I remembered" banner), #506 (dialectic-deriver)
- **`.claude/rules/parallel-sessions.md`** PSA-003 — destructive-command guard rationale for dry-run-default auto-dream
- **PRD §Research Provenance** Hermes Issue #7826 — the cautionary tale for why auto-dream is dry-run-default

## Follow-ups

- **Close #500 + #502 + #507 with this ADR as the consolidated implementation reference.**
- **Track #505 separately** — the Phase 2 rich banner is a distinct surface with distinct config keys; it shares no code path with the cold-start banner and must not be conflated.
- **Operator action pending:** none. Migration is one-shot, idempotent, and self-completing on the next open of each seeded repo.
- **Measurement:** revisit the 58% cold-start abandonment metric after the 6 seeded repos have all received their banner — the comparison cohort is the pre-banner audit baseline.

Sources: `docs/prd/2026-05-21-learning-memory-modernization.md` §F1.3, §F2.2, §F2.3 (deferred) · `.claude/rules/parallel-sessions.md` PSA-003 · Hermes Issue #7826 (referenced in PRD §Research Provenance).
