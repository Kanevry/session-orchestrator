# Bootstrap — Ecosystem-Health Flow (`--ecosystem-health`)

> Reference of the `bootstrap` skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.

## Ecosystem-Health Flow (`--ecosystem-health`)

Entered when `$ARGUMENTS` contains `--ecosystem-health`. This is a **standalone flow** — it does not scaffold repo structure and does not write `bootstrap.lock`. Dispatch immediately; do not proceed to Phase 1.

**Purpose:** Populate the `health-endpoints`, `pipelines`, and `criticalIssueLabels` configuration consumed by `skills/ecosystem-health/SKILL.md`. Runs the interactive wizard in `scripts/lib/ecosystem-wizard.mjs`, which detects CI provider + package manager automatically and prompts the user for the remaining values.

**Steps:**

1. **Run the wizard.**

   ```bash
   node "$PLUGIN_ROOT/scripts/lib/ecosystem-wizard.mjs" --repo-root "$(pwd)"
   ```

   The wizard will:
   - Detect CI provider (`.gitlab-ci.yml` → `gitlab`; `.github/workflows/` → `github`; else `none`)
   - Detect package manager from lockfile
   - Prompt for health endpoints (format: `Name|URL`, comma-separated)
   - Prompt for CI pipeline identifiers (format: `id` or `id:label`, comma-separated)
   - Prompt for critical issue labels (comma-separated strings)

2. **Wizard writes two files** (or skips each if already present):
   - `CLAUDE.md` (or `AGENTS.md`) — appends `ecosystem-health:` block inside `## Session Config`
   - `.orchestrator/policy/ecosystem.json` — full policy file (schema: `.orchestrator/policy/ecosystem.schema.json`)

3. **No auto-commit.** The wizard prints what it wrote. The user reviews with `git status && git diff` and commits manually.

**Report:** The wizard prints a one-line summary per file:

```
Ecosystem-Health Wizard complete.
Written: .orchestrator/policy/ecosystem.json, CLAUDE.md
Skipped (already present): (none)

Review changes with: git status && git diff
```

**Idempotency:** Safe to re-run. If both output files are already present with matching content, the wizard exits 0 with "Nothing to do." To update, remove the existing `ecosystem-health:` key from Session Config and delete `.orchestrator/policy/ecosystem.json`, then re-run.

See `skills/ecosystem-health/wizard.md` for the full prompt spec and schema details.

---

