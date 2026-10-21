# Bootstrap — Retroactive Flow (`--retroactive`)

> Reference of the `bootstrap` skill, split out of `SKILL.md` (#1246). Body moved **byte-identical**; only this header is new.
> **Sibling-file paths inside this body are relative to the parent directory, not to `references/`**: `SKILL.md` → `../SKILL.md`. They were deliberately NOT rewritten, so the moved bytes stay verifiable against the pre-split file.

## Retroactive Flow (`--retroactive`)

Entered when `$ARGUMENTS` contains `--retroactive`. Writes the lock file and, per #182, optionally patches missing mandatory Session Config fields with defaults.

**Purpose:** Adopt an existing repo that already has `CLAUDE.md` + `## Session Config` but was bootstrapped manually (no `bootstrap.lock`). Writes the lock so the gate passes on all future invocations, and ensures the Session Config block satisfies the validated schema defined in `scripts/lib/config-schema.mjs`.

**Steps:**

1. **Verify preconditions.** Confirm `CLAUDE.md` (or `AGENTS.md`) exists and contains `## Session Config`. If not, abort: `Error: CLAUDE.md with Session Config required for retroactive bootstrap.`

2. **Check lock not already present.** If `.orchestrator/bootstrap.lock` already exists and has valid `version` + `tier` fields, report: `bootstrap.lock already present (tier: <tier>). Nothing to do.` and exit 0 (idempotent).

3. **Infer tier from file inventory.** Examine the repo root:

   | Condition (evaluated in order) | Inferred Tier |
   |---|---|
   | CI file present (`.gitlab-ci.yml` OR `.github/workflows/`) AND `CHANGELOG.md` present | `deep` |
   | Package manifest present (`package.json` OR `pyproject.toml`) | `standard` |
   | Neither of the above | `fast` |

   Store as `INFERRED_TIER`.

4. **Infer archetype.** Run Phase 0.5's read-only source detection. For a private
   contract, use its detected `selected.id`; retain `null` with an explicit
   `insufficient-evidence` report if no markers match. An invalid configured
   contract aborts (for `producer-missing`, report its path-free `message` with
   the reason). Do not scaffold or apply rules in this retroactive flow.
   For the public path, use best-effort detection from existing files:
   - `pyproject.toml` present → `python-uv`
   - `package.json` with `next` in dependencies → `nextjs-minimal`
   - `package.json` without `next` → `node-minimal`
   - No manifest → `null`

   Store as `INFERRED_ARCHETYPE`.

5. **Write bootstrap.lock.** Create `.orchestrator/` if needed, then write:
   ```yaml
   # .orchestrator/bootstrap.lock
   version: 1
   tier: <INFERRED_TIER>
   archetype: <INFERRED_ARCHETYPE or null>
   timestamp: <current ISO 8601 UTC>
   source: retroactive
   plugin-version: <current plugin version from $PLUGIN_ROOT/package.json>
   ```

6. **Patch Session Config (#182, #1567).** Find the mandatory fields the `## Session Config` block does not carry and append them with defaults. The mandatory fields are the keys of the FIRST `## Session Config` block in `$PLUGIN_ROOT/docs/session-config-template.md` (today the 7 validated by `scripts/lib/config-schema.mjs`): `test-command`, `typecheck-command`, `lint-command`, `agents-per-wave`, `waves`, `persistence`, `enforcement`.

   Presence is read from the FILE, not from the validator: `parseSessionConfig()` fills every mandatory field with its default, so `parse-config.mjs` / `validate-config.mjs` never report an ABSENT field (a pnpm repo without `test-command` would silently run `npm test`). `missingStarterKeys()` (`scripts/lib/config/template-keys.mjs`) compares the template's starter keys against `collectTopLevelKeyLines()` — the top-level keys the runtime reads, in every accepted spelling (`key:`, `- key:`, `- **key:**`).

   ```bash
   CONFIG_FILE="CLAUDE.md"
   [[ -f "AGENTS.md" ]] && CONFIG_FILE="AGENTS.md"

   MISSING_FIELDS="$(node --input-type=module -e "
     import { readFileSync } from 'node:fs';
     import { missingStarterKeys } from '$PLUGIN_ROOT/scripts/lib/config/template-keys.mjs';
     const missing = missingStarterKeys(
       readFileSync(process.argv[1], 'utf8'),
       readFileSync('$PLUGIN_ROOT/docs/session-config-template.md', 'utf8'),
     );
     if (missing === null) { console.error('template has no Session Config block — mandatory-field check did not run'); process.exit(1); }
     console.log(missing.join(' '));
   " "$CONFIG_FILE")"
   if [[ -n "$MISSING_FIELDS" ]]; then
     # Detect package manager to pick sensible defaults for commands.
     PM_DEFAULTS="$(node --input-type=module -e "
       import {detectPackageManager, defaultQualityGateCommands} from '$PLUGIN_ROOT/scripts/lib/package-manager.mjs';
       const pm = detectPackageManager(process.cwd());
       const cmds = defaultQualityGateCommands(pm);
       console.log('test-command: ' + cmds.test.command);
       console.log('typecheck-command: ' + cmds.typecheck.command);
       console.log('lint-command: ' + cmds.lint.command);
     " 2>/dev/null)"

     # Append each missing field under the ## Session Config block.
     for field in $MISSING_FIELDS; do
       case "$field" in
         test-command|typecheck-command|lint-command)
           default_line="$(echo "$PM_DEFAULTS" | grep "^$field:")" ;;
         agents-per-wave) default_line="agents-per-wave: 6" ;;
         waves)           default_line="waves: 5" ;;
         persistence)     default_line="persistence: true" ;;
         enforcement)     default_line="enforcement: warn" ;;
       esac
       # Insert after `## Session Config` line if not already present.
       grep -q "^$field:" "$CONFIG_FILE" \
         || awk -v insert="$default_line" '/^## Session Config/ && !done { print; print ""; print insert; done=1; next } { print }' "$CONFIG_FILE" > "$CONFIG_FILE.tmp" \
         && mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
     done
     echo "Patched $CONFIG_FILE with defaults for: $MISSING_FIELDS"
   fi
   ```

   This patch is best-effort: existing fields are never overwritten, and an INVALID value of a present field is left for `parse-config.mjs` to report. If no fields are missing, this step is a no-op; if the check did not run (exit 1), report that line instead of `No config changes.`.

7. **Commit.** Stage the lock file (and the patched config file, if it changed) and commit:
   ```bash
   mkdir -p .orchestrator
   git add .orchestrator/bootstrap.lock
   # Also stage CLAUDE.md/AGENTS.md if step 6 patched it.
   git diff --name-only --cached CLAUDE.md AGENTS.md 2>/dev/null | head -1 >/dev/null || {
     [[ -f CLAUDE.md ]] && git diff --quiet CLAUDE.md || git add CLAUDE.md
     [[ -f AGENTS.md ]] && git diff --quiet AGENTS.md || git add AGENTS.md
   }
   git commit -m "chore: bootstrap lock (retroactive)"
   ```

8. **Report.** Print: `Retroactive bootstrap complete. Lock written (tier: <INFERRED_TIER>, source: retroactive).` Include a second line `Patched Session Config: <fields>` when step 6 applied any patches, otherwise `No config changes.`.

---

