# Vault & Docs Architecture — Umbrella Narrative

**Audience:** Plugin contributors (Dev). New contributors who need to understand
how the four documentation skills, one orchestrator skill, one agent, and two
discovery probes fit together — what fires when, who owns which file, and how
to recover when something breaks.

**Status:** Living document. Tracks Epic #229 (Vault & Docs Orchestration).

---

## 1. Purpose

The session-orchestrator plugin treats documentation as a first-class side
effect of every session, not a manual afterthought. Three problems motivate
the layer:

- **Cross-session memory loss.** A session ends, the chat closes, the next
  session starts cold. Without a structured place to land decisions, status
  changes, and learnings, every session re-discovers context. The Meta-Vault
  (`~/Projects/vault`) is that place. Source: `docs/prd/2026-04-21-vault-docs-orchestration.md`
  Section 1 ("Why" — 14 active projects, daily multi-session workflow).
- **Audience-specific documentation rotting in parallel.** READMEs,
  `CLAUDE.md`, and Vault narratives drift independently because nothing
  reminds the session to update them in lock-step with the diff. Source:
  `docs/prd/2026-04-21-vault-docs-orchestration.md` Section 1 (no
  Docs-Planning step in session-start; doku only touched in session-end Phase 3.1).
- **Operational telemetry without a home.** Wave outcomes, learnings, and
  session metrics are JSONL on disk; humans need them as Markdown notes
  cross-linked into the Vault graph. Source: `skills/vault-mirror/SKILL.md`
  ("Purpose" — converts JSONL into vault-conformant Markdown).

The architecture below ties these three concerns together with deliberate
non-overlap: each component owns a narrow slice of the documentation surface,
and the lifecycle hooks ensure the slices are written, validated, and
mirrored at the right phase.

---

## 2. Architecture Diagram

Data flow within a single `/session feature → /go → /close` cycle:

```
┌──────────────────────────────────────────────────────────────────┐
│  user invokes:  /session feature  →  /go  →  /close              │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  session-start                                                   │
│   Phase 2.5  docs-orchestrator (opt-in)                          │
│     └─ audience detection → docs-tasks block in STATE.md         │
│        Source: skills/session-start/phase-2-5-docs-planning.md   │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  session-plan                                                    │
│   Step 1.5  docs-writer added to agent registry                  │
│   Step 1.8  Docs-classified tasks → docs-writer assignment       │
│        Source: skills/docs-orchestrator/SKILL.md (Invocation)    │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  wave-executor                                                   │
│   dispatches docs-writer agent with the canonical four sources:  │
│     diff │ git-log │ session-memory │ affected-files             │
│        Source: agents/docs-writer.md (Inputs)                    │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  code/diff lands; tests run; metrics written                     │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  session-end                                                     │
│   Phase 2.1  vault-sync          (frontmatter + wiki-link gate)  │
│   Phase 2.2  claude-md-drift     (5 narrative drift checks)      │
│   Phase 2.3  vault-staleness     (opt-in: stale projects)        │
│   Phase 3.2  docs-verify         (per-task ok/partial/gap)       │
│   Phase 3.7  vault-mirror        (sessions.jsonl → 50-sessions/) │
│        Source: skills/session-end/SKILL.md (phase markers)       │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  Meta-Vault (~/Projects/vault)                                   │
│   01-projects/<slug>/  ← context.md / decisions.md / people.md   │
│                          (docs-writer, Vault audience)           │
│   01-projects/<slug>/  ← _overview.md (vault-mirror, no humans)  │
│   03-daily/YYYY-MM-DD.md  (daily skill, idempotent)              │
│   40-learnings/<slug>.md  (vault-mirror, evolve hook)            │
│   50-sessions/<id>.md     (vault-mirror, session-end Phase 3.7)  │
└──────────────────────────────────────────────────────────────────┘
                                ↓
┌──────────────────────────────────────────────────────────────────┐
│  /discovery vault — on-demand staleness probes                   │
│     vault-staleness.mjs + vault-narrative-staleness.mjs          │
│        Source: skills/discovery/probes-vault.md                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Component Table

| Component | Owner | Trigger | Input | Output | Audience |
|-----------|-------|---------|-------|--------|----------|
| `vault-sync` | `skills/vault-sync/SKILL.md` | session-end Phase 2.1 (hard gate) | `VAULT_DIR/**/*.md` frontmatter + wiki-links | JSON report (`status`, `errors`, `warnings`) on stdout, exit code 0/1/2 | Dev (validation) |
| `claude-md-drift-check` | `skills/claude-md-drift-check/SKILL.md` | session-end Phase 2.2 (opt-in gate) | `CLAUDE.md`, `_meta/**/*.md` | JSON report with 5 named checks (path-resolver, project-count-sync, issue-reference-freshness, session-file-existence, command-count) | Dev (validation) |
| `vault-staleness` probes | `skills/discovery/probes-vault.md` + `skills/discovery/probes/vault-staleness.mjs` | `/discovery vault` (on-demand) and session-end Phase 2.3 (opt-in close-time gate) | `VAULT_DIR/01-projects/*/` `_overview.md` + narrative files | JSONL findings under `.orchestrator/metrics/vault-staleness.jsonl` and `vault-narrative-staleness.jsonl` | Vault/Ops (telemetry) |
| `docs-orchestrator` | `skills/docs-orchestrator/SKILL.md` | session-start Phase 2.5, session-plan Step 1.5/1.8, session-end Phase 3.2 (all gated on `enabled: true`) | Session scope + Session Config audience list | `docs-tasks` block in STATE.md (write side); `### Documentation Coverage` block in final report (verify side) | All three (User / Dev / Vault) |
| `docs-writer` agent | `agents/docs-writer.md` | Dispatched by `wave-executor` for each `Docs`-classified task | `diff`, `git-log`, `session-memory`, `affected-files` | Audience-targeted Markdown writes (Edit/Write); `[docs-orchestrator] Docs task complete` report line | All three (per task) |
| `daily` | `skills/daily/SKILL.md` | User-invocable (`/daily`), idempotent | `VAULT_DIR/03-daily/`, `templates/daily.md.tpl` | `<vault>/03-daily/YYYY-MM-DD.md` (created or no-op) | Vault/Ops (PKM anchor) |
| `vault-mirror` | `skills/vault-mirror/SKILL.md` + `scripts/vault-mirror.mjs` | session-end Phase 3.7 (sessions); evolve Phase 3.5 (learnings) | `.orchestrator/metrics/sessions.jsonl`, `.orchestrator/metrics/learnings.jsonl` | `<vault>/50-sessions/<id>.md`, `<vault>/40-learnings/<slug>.md` (`_generator` marker `session-orchestrator-vault-mirror@1`) | Vault/Ops (telemetry → Markdown) |
| `vault-backfill` CLI | `scripts/vault-backfill.mjs` | Manual, also surfaced via `/plan retro vault-backfill` sub-mode | `vault-integration.gitlab-groups` config + GitLab API | `.vault.yaml` per repo + Vault stub directories | Vault/Ops (one-shot migration) |

---

## 4. Audience Model

Three audiences, three documentation surfaces. The split is enforced by
`skills/docs-orchestrator/audience-mapping.md` (Audiences & File Patterns
table), which is the **single source of truth** for which files belong to
which audience. Never inline this table elsewhere — always cross-link.

- **User** — external/internal users of the repo. Targets: `README.md`,
  `docs/user/**/*.md`, `docs/getting-started.md`, `examples/**/*.md`. Source:
  `skills/docs-orchestrator/audience-mapping.md` § Audiences & File Patterns.
- **Dev** — contributors to the repo, including future Claude sessions.
  Targets: `CLAUDE.md`, `docs/dev/**/*.md`, `docs/adr/**/*.md`. Source: same.
- **Vault/Ops** — strategic continuity across sessions. Targets:
  `<vault>/01-projects/<slug>/context.md`, `decisions.md`, `people.md`.
  Source: same.

The Session Config field `docs-orchestrator.audiences` accepts any subset of
`[user, dev, vault]`; narrowing it (e.g., `[user, dev]` on a project without a
Vault) suppresses Vault-targeted docs without disabling the orchestrator
entirely. Source: `docs/session-config-reference.md` § Docs Orchestrator.

---

## 5. Source-Cited Content Rule

The `docs-writer` agent operates under a **hallucination ban**: every
substantive paragraph must trace to one of the canonical four sources, or
carry an inline `<!-- REVIEW: source needed -->` marker. The four sources are
defined once and reused everywhere:

1. **diff** — `git diff $SESSION_START_REF..HEAD`
2. **git-log** — `git log $SESSION_START_REF..HEAD --format="%H %s%n%b"`
3. **session-memory** — `~/.claude/projects/<project>/memory/session-*.md` and
   `.orchestrator/` outputs
4. **affected-files** — files in the wave-scope `allowedPaths` block

Source: `agents/docs-writer.md` § Inputs / Source Citation Rules and
`skills/docs-orchestrator/SKILL.md` Phase 4 (Source Grounding).

The `<!-- REVIEW: source needed -->` marker is **load-bearing**: it signals
to the human reviewer that a section needs verification before the next
release. The agent is explicitly forbidden from removing the marker to make
output appear cleaner. Source: `skills/docs-orchestrator/SKILL.md` Phase 5
("Sourceless content").

**Hard guard in Phase 4:** if ALL four source blocks are empty or absent in
the dispatched task prompt, the docs-writer aborts rather than producing
silent REVIEW-marker-only output. Source:
`skills/docs-orchestrator/SKILL.md` Phase 4 step 1.

---

## 6. Non-Overlap Discipline

Three forbidden cross-writes are enforced by the architecture, not just by
convention:

- **`<vault>/01-projects/*/_overview.md` is owned by `vault-mirror`.** The
  file is regenerated from JSONL metrics on every session-end Phase 3.7. A
  second writer would corrupt the metrics-derived content or introduce human
  prose that vault-mirror's next run overwrites silently. Source:
  `skills/docs-orchestrator/audience-mapping.md` § Non-Overlap (vault-mirror
  row) and `skills/vault-mirror/SKILL.md` § Idempotency (the `_generator`
  marker `session-orchestrator-vault-mirror@1` is the discriminator).
- **`<vault>/03-daily/YYYY-MM-DD.md` is owned by `daily`.** Idempotent by
  design — re-running `/daily` opens the existing note, never overwrites.
  Source: `skills/daily/SKILL.md` § Idempotency Guarantee. A second writer
  would corrupt the day's scratch notes. Source:
  `skills/docs-orchestrator/audience-mapping.md` § Non-Overlap (daily row).
- **`CLAUDE.md` may be remediated by `docs-writer` (Dev audience), but
  `claude-md-drift-check` only diagnoses it.** The two skills must not run
  on `CLAUDE.md` in parallel within the same wave. Source:
  `skills/docs-orchestrator/audience-mapping.md` § Non-Overlap
  (claude-md-drift-check row).

The forbidden patterns are checked in `skills/docs-orchestrator/SKILL.md`
Phase 3 with an abort-on-match guard before any write occurs.

---

## 7. Lifecycle

Concrete answer to "when does each component fire":

| Phase | Skill / Probe | Gating |
|-------|---------------|--------|
| `/session` start, Phase 2.5 | `docs-orchestrator` audience detection | `docs-orchestrator.enabled: true` |
| `/session` start, Phase 4.5 | resource-health probe | always (env-aware) |
| session-plan Step 1.5/1.8 | `docs-writer` registered + Docs role classified | `docs-orchestrator.enabled: true` |
| `/go` waves | `docs-writer` agent dispatched per Docs task | task present in plan |
| `/close` Phase 2.1 | `vault-sync` validator | `vault-sync.enabled: true` (hard gate by mode) |
| `/close` Phase 2.2 | `claude-md-drift-check` | `drift-check.enabled: true` |
| `/close` Phase 2.3 | `vault-staleness` + `vault-narrative-staleness` probes | `vault-staleness.enabled: true` |
| `/close` Phase 3.2 | `docs-orchestrator` verification | `docs-orchestrator.enabled: true` AND `docs-tasks` block present |
| `/close` Phase 3.7 | `vault-mirror` (sessions) | `vault-integration.enabled: true` AND `mode != off` |
| evolve Phase 3.5 | `vault-mirror` (learnings) | same as above |
| `/discovery vault` | `vault-staleness` probes (on-demand) | `.vault.yaml` present OR `vault-integration.enabled: true` |
| `/daily` | `daily` skill | user-invocable; no Session Config gate |

Sources: `skills/session-end/SKILL.md` (Phase markers), `docs/session-config-reference.md`
(per-skill enabled-flag semantics), `skills/discovery/probes-vault.md` (probe
activation rules).

The **opt-in default** is the design contract: when no Session Config block
is present for a given skill, that skill's hook short-circuits silently —
zero overhead. Source: `docs/prd/2026-04-21-vault-docs-orchestration.md`
Section 5 (Risk: "Marketplace-Kompatibilität — alle neuen Config-Felder
opt-in mit sicherem Default → zero-impact für bestehende Plugin-User").

---

## 8. Failure Modes & Escape Hatches

| What breaks | Symptom | Recovery |
|-------------|---------|----------|
| `vault-sync` finds invalid frontmatter, `mode: hard` | session-end Phase 2.1 blocks `/close` | Fix the offending file, re-run `/close`. Or temporarily set `vault-sync.mode: warn` to unblock and file an issue. Source: `skills/vault-sync/SKILL.md` § "How session-end invokes it" (exit 1 → block). |
| `claude-md-drift-check` finds stale issue refs, `mode: hard` | Phase 2.2 blocks `/close` | Update CLAUDE.md to reflect actual state, or set `drift-check.mode: warn`. Source: `skills/claude-md-drift-check/SKILL.md` § "Session-End Phase 2.2". |
| `vault-staleness` probe finds stale projects, `mode: strict` | Phase 2.3 blocks `/close` with interactive override | Run `/discovery vault` to triage; update narrative files, or use the AskUserQuestion override (logged to STATE.md). Source: `docs/session-config-reference.md` § Vault Staleness ("Mode behavior" table). |
| `docs-writer` cannot find a source for a section | Section is written with `<!-- REVIEW: source needed -->` | Human review before next release; do NOT remove the marker. Source: `skills/docs-orchestrator/SKILL.md` Phase 5. |
| `docs-writer` is dispatched with **all four** source blocks empty | Agent aborts with `docs-writer: no grounding sources available` | Coordinator surfaces the failure; fix the task spec to include at least one source. Source: `skills/docs-orchestrator/SKILL.md` Phase 4 step 1 (Hard guard). |
| `vault-mirror` finds a hand-written file at the target path | `skipped-handwritten` action emitted; file untouched | Intentional safety: human files are never overwritten. If the file should be regenerated, delete it manually. Source: `skills/vault-mirror/SKILL.md` § Idempotency item 4. |
| Session Config block absent | All hooks skip silently | Default behavior. To enable, add the relevant block per `docs/session-config-reference.md`. |
| `docs-orchestrator.mode: off` | Phase 2.5 / 3.2 read config but skip all execution | Lighter than `enabled: false` (config still parsed). Useful during onboarding. Source: `skills/docs-orchestrator/SKILL.md` § "Session Config Reference". |
| Repo lacks `.vault.yaml` but `vault-integration.enabled: true` | vault-sync warns "kein .vault.yaml gefunden" but does not block | Run `scripts/vault-backfill.mjs` (dry-run default) to generate. Source: `docs/prd/2026-04-21-vault-docs-orchestration.md` § Edge Cases. |

---

## 9. Future Direction

**Epic #229 (Vault & Docs Orchestration) is in-progress.** Closed slices to
date (per CLAUDE.md "Current State"):

- docs-orchestrator skill + docs-writer agent (foundation #230, hooks #233 /
  #234 / #235, config #236).
- vault-staleness probes + Phase 2.3 integration (#232, #242).
- vault-backfill CLI + `/plan retro vault-backfill` sub-mode (#241).
- vault-mirror auto-commit phase via `--session-id` (GH#31).

Source: `CLAUDE.md` § "Current State" and `docs/prd/2026-04-21-vault-docs-orchestration.md`
§ Sub-Epic A/B/C tracking lists.

**Open work:** Sub-Epic B (projects-baseline `setup-project.sh` Vault auto-
provisioning) lives in a sibling repo and ships independently. CLAUDE.md
narrative-sync remediation across consumer repos remains a recurring
maintenance load. Source: `docs/prd/2026-04-21-vault-docs-orchestration.md`
§ Sub-Epic B.

**Explicit non-goals** — these are not on the roadmap:

- **Team-Vault sharing.** Today single-user-local under
  `~/Projects/vault`. Team sharing requires its own infra (sync, permissions,
  conflict resolution) and is a separate epic.
- **Two-way sync (Vault → Repo).** Today one-way (Repo → Vault via
  `.vault.yaml` + Clank). Reversal would break the ownership model.
- **LLM-autogenerated User-Docs without source.** docs-writer writes only
  from the canonical four sources. Sourceless sections get
  `<!-- REVIEW: source needed -->`, never invented content.
- **Full ADR autogeneration.** ADRs remain human-authored decisions;
  docs-writer may suggest skeletons but never commits autonomously.
- **Migration of historical 50-sessions / 40-learnings entries.** vault-mirror
  is forward-compatible only.

Source: `docs/prd/2026-04-21-vault-docs-orchestration.md` § Out-of-Scope.

---

## See Also

- `docs/session-config-reference.md` — authoritative config reference for all
  fields mentioned above (Vault Sync, CLAUDE.md Drift Check, Vault
  Integration, Vault Staleness, Docs Orchestrator).
- `docs/prd/2026-04-21-vault-docs-orchestration.md` — PRD for the umbrella
  epic, including layering diagram and ownership table this document
  derives from.
- `skills/docs-orchestrator/audience-mapping.md` — single source of truth
  for audience → file-pattern mapping and non-overlap rules.
- `agents/docs-writer.md` — the sole agent permitted to write audience-
  targeted documentation within a session.
- `CLAUDE.md` § "Current State" — running ledger of which umbrella-epic
  slices have shipped.
