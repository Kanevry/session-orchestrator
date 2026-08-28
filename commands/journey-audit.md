---
description: Outside-in product audit as a deep session — 7 read-only roles check what the site promises against what the code does, what a user experiences, what arrives by mail, and what the data says is used. Writes a dossier; needs a per-repo journey-manifest.
argument-hint: "[manifest-path]"
---

# Journey Audit

Invokes the `journey-audit` skill (`skills/journey-audit/SKILL.md`). Dispatches roles R1–R7 against
the repo's journey manifest, re-verifies every P0 claim in the coordinator thread, and writes
`docs/audits/YYYY-MM-DD-user-journey-audit.md`.

Complements `/discovery` rather than replacing it: discovery checks code quality inside-out,
journey-audit checks product truth outside-in.

## Argument Validation

The optional argument is a path to the manifest, overriding the default
`.orchestrator/journey-manifest.md`. Use it for a second manifest (e.g. a staging variant) or when
the repo keeps it elsewhere.

- `/journey-audit` — uses `.orchestrator/journey-manifest.md`
- `/journey-audit .orchestrator/journey-manifest.staging.md` — uses that file instead

If the argument names a file that does not exist, say so and stop — do NOT silently fall back to
the default path, because auditing the wrong manifest produces findings that look valid and are not.

## Behavior

1. **Gates** — bootstrap gate, then the manifest HARD-GATE: no manifest → refuse and point at
   `templates/_shared/journey-manifest.md`; no filled `## SAFETY` block → run without R5 and say so.
2. **Peer-session check** — announce the audit before dispatching (`.claude/rules/parallel-sessions.md`).
3. **Wave** — R1–R7 in parallel, all read-only except R5, each fed from the manifest.
4. **Coordinator re-verification** — every P0 re-checked with the coordinator's own command before
   it enters the dossier. This step is not optional and not delegable.
5. **Dossier + closing AUQ** — fixed section order, then fix-wave packages (multiSelect) and an
   optional issue batch via `skills/gitlab-ops/SKILL.md` label taxonomy.

## Related

- `skills/journey-audit/SKILL.md` — the skill, in full
- `templates/_shared/journey-manifest.md` — the per-repo manifest template (SAFETY block gates R5)
- `docs/prd/2026-08-28-journey-audit-skill.md` — the PRD, incl. the first-run evidence
- `commands/discovery.md` — the inside-out counterpart
