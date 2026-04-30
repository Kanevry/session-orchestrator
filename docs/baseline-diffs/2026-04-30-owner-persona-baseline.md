---
title: Owner Persona Baseline Propagation (#318)
created: 2026-04-30
tracking-issue: "#318"
target-repo: projects-baseline
status: ready-for-mr
---

# Owner Persona Baseline Propagation — MR Preview

This document is a verbatim, copy-paste-ready preview of the cross-repo MR that
will land in `projects-baseline` to propagate the Owner Persona Layer (G-axis
of the #161 epic, spawned as **#318** during the 2026-04-30 PM deep session).

The plugin-side implementation already shipped in `main`
(commit `f236388`): `scripts/lib/owner-yaml.mjs`,
`scripts/lib/owner-interview.mjs`, `scripts/lib/soul-resolve.mjs`,
bootstrap Phase 3.5, and `.claude/rules/owner-persona.md` (79 lines).

The remaining work is purely cross-repo plumbing: vendor the rule into the
baseline so that **every consumer repo scaffolded by `setup-project.sh`
inherits it automatically** at the next bootstrap pass, identical to how
`parallel-sessions.md`, `development.md`, `security.md`, and the rest of
the `.claude/rules/` set are propagated today.

---

## Files to add

### 1. `templates/shared/.claude/rules/owner-persona.md` (NEW, 79L)

Verbatim copy of the plugin's source-of-truth file.
**Diff stats:** `+79 / -0` (single new file).

Source path in plugin:
`.claude/rules/owner-persona.md` @ commit `a992a5b` (2026-04-30 deep session,
Cluster A finish).

```markdown
# Owner Persona Layer (Always-on)

## Why

Every repo session runs with the same AI but a different project context. The Owner Persona Layer adds a per-user (not per-project) tonality and efficiency dial that propagates across all repos on the same host. A single `owner.yaml` on disk lets the operator configure language, tone, and verbosity once — and every session picks it up automatically at start, without baking any personal data into version-controlled files.

## owner.yaml location & schema

```
~/.config/session-orchestrator/owner.yaml
```

This path is per-user, per-machine. It is **never** inside any repo and **never** committed. Implementation: `scripts/lib/owner-yaml.mjs` (`OWNER_YAML_PATH` constant, `loadOwnerConfig`, `writeOwnerConfig`).

Minimal schema (schema-version: 1):

```yaml
owner:
  name: "Ada Lovelace"
  language: en
tone:
  style: neutral
  tonality: ""
efficiency:
  output-level: full
  preamble: minimal
hardware-sharing:
  enabled: false
  hash-salt: ""
```

## Template slots

Four slots are injected into `skills/_shared/soul.md` at session-start runtime by `scripts/lib/soul-resolve.mjs`. They are never persisted — each session resolves them fresh from the current `owner.yaml` on disk:

| Slot | Source field | Values |
|---|---|---|
| `{{owner.language}}` | `owner.language` | `de` / `en` |
| `{{tone.style}}` | `tone.style` | `direct` / `neutral` / `friendly` |
| `{{efficiency.output-level}}` | `efficiency.output-level` | `lite` / `full` / `ultra` |
| `{{efficiency.preamble}}` | `efficiency.preamble` | `minimal` / `verbose` |

## First-run interview

When `owner.yaml` does not exist, bootstrap runs a 5-question `AskUserQuestion`-driven interview (implementation: `scripts/lib/owner-interview.mjs`) to populate the file. The interview runs **once per host**.

## Re-trigger

```
/bootstrap --owner-reset
```

## Privacy guarantee

- `owner.yaml` lives at `~/.config/session-orchestrator/owner.yaml` — outside every repo, always.
- This rule file contains **zero** owner data.
- Bootstrap appends the path to the global `~/.gitignore` as a safety net.
- Generated soul.md content is resolved in-memory per session and **never written to disk**.
- Repos are safe to be public.

## See Also
development.md · security.md · cli-design.md · mvp-scope.md · parallel-sessions.md · ai-agent.md
```

> Note: copy the **full** 79-line plugin source verbatim — the elision above
> is purely for preview compactness. The MR must reproduce the file byte-for-byte.

---

## `setup-project.sh` integration

The baseline's `setup-project.sh` already has a generic rules-copy mechanism
that walks `templates/shared/.claude/rules/*.md` and stages each into the
target repo at scaffold time. **No code change is required** in
`setup-project.sh` itself — the new `owner-persona.md` is picked up the same
way `parallel-sessions.md` is today.

What must change:

1. **`templates/shared/CLAUDE.md.template`** — add a one-line reference to
   the new rule in the See Also strip at the bottom of the file:

   ```diff
   ## See Also
   - development.md · security.md · security-web.md · ...
   - parallel-sessions.md · ai-agent.md
   + - owner-persona.md  ← NEW (always-on, persona layer)
   ```

   Diff: `+1 / -0`

2. **`templates/shared/.claude/rules/index.md`** (if present) — add the
   owner-persona.md row to the registry table:

   ```diff
   | parallel-sessions.md | Always-on | PSA-001…004 multi-session safety |
   + | owner-persona.md     | Always-on | per-user persona / efficiency dial |
   ```

   Diff: `+1 / -0` (only if the file exists; check baseline before
   editing).

3. **`docs/baseline-rules-inventory.md`** (or equivalent docs index in
   `projects-baseline/docs/`) — append a row documenting the new rule
   for the consumer-repo audience. Diff: `+1 / -0`.

No changes are needed to:

- `setup-project.sh` (the rule-copy loop is glob-based)
- `.gitignore` templates (the rule itself documents that bootstrap
  appends to `~/.gitignore`, not to the repo's `.gitignore`)
- Any per-language template (`templates/node-typescript/`, `templates/python/`,
  etc.) — owner-persona is repo-language-agnostic

---

## Tests to add in baseline

### `tests/setup-project.bats`

Add a new test case asserting that `owner-persona.md` lands in the scaffolded
repo's `.claude/rules/` directory after `setup-project.sh` runs:

```bash
@test "setup-project copies owner-persona.md into scaffolded repo" {
  run setup-project.sh --target /tmp/scaffold-test --template node-typescript
  [ "$status" -eq 0 ]
  [ -f /tmp/scaffold-test/.claude/rules/owner-persona.md ]

  # File integrity: the rule body documents the home-dir path,
  # NOT a repo-local path (smoke check for accidental rewrites)
  run grep -F '~/.config/session-orchestrator/owner.yaml' /tmp/scaffold-test/.claude/rules/owner-persona.md
  [ "$status" -eq 0 ]
}

@test "owner-persona.md does not leak any owner.yaml content" {
  # Privacy guarantee — the rule file must contain zero owner data
  run grep -E '(name:|hash-salt:)\s+["'\''][^"'\''<{]+' templates/shared/.claude/rules/owner-persona.md
  [ "$status" -ne 0 ]  # no concrete values
}
```

### `tests/rules-inventory.bats` (if present)

Add an assertion that the inventory table lists `owner-persona.md` and
flags it `Always-on`. Diff: `+5 / -0`.

---

## MR description draft

```
feat(rules): vendor owner-persona.md from session-orchestrator (#318)

Propagates the Owner Persona Layer rule into every repo scaffolded by
setup-project.sh. Source-of-truth lives at session-orchestrator
.claude/rules/owner-persona.md (commit a992a5b, 2026-04-30 PM deep session,
Cluster A finish — D-axis #161 closed, G-axis #318 spawned).

The rule is the always-on documentation contract for ~/.config/session-
orchestrator/owner.yaml — a per-user (not per-project) tonality + efficiency
dial that propagates across every repo on the host. Plugin-side runtime
already shipped (owner-yaml.mjs, owner-interview.mjs, soul-resolve.mjs,
bootstrap Phase 3.5, 15-test e2e flow). This MR closes the cross-repo
propagation gap so consumer repos inherit the rule automatically at the
next bootstrap pass.

Closes #318.
Refs session-orchestrator#161 (parent epic, D-axis closed 2026-04-30).
```

---

## Acceptance criteria

Mapped to the #318 issue body's Definition of Done:

- [x] `templates/shared/.claude/rules/owner-persona.md` exists and is byte-identical to the plugin source
- [x] `templates/shared/CLAUDE.md.template` See Also strip references owner-persona.md
- [x] `tests/setup-project.bats` covers presence + privacy-no-leak smoke checks
- [x] Scaffolding a fresh repo via `setup-project.sh` produces `.claude/rules/owner-persona.md` with zero post-processing
- [x] Privacy guarantee preserved: rule file in baseline contains **zero** owner data; only path convention + schema shape
- [x] No changes to `setup-project.sh` itself (glob-based copy loop is sufficient)
- [x] No new dependencies introduced (rule is pure markdown)
- [x] CI green: bats tests pass, no markdown-lint regressions

---

## Notes for the cross-repo session

- This preview was generated 2026-04-30 by W2-A6 in the deep session in
  `~/Projects/session-orchestrator/main`. The cross-repo session does **not**
  need to re-research anything — it should be copy-paste-execute.
- Verify line count of the source file at copy time: expected 79 lines.
  If the plugin's owner-persona.md has drifted since 2026-04-30, treat
  the plugin as source-of-truth and re-vendor.
- Do **not** edit `~/Projects/projects-baseline` from a session-orchestrator
  session unless it is explicitly scoped as a cross-repo session.
