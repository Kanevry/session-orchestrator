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
   contract aborts. Do not scaffold or apply rules in this retroactive flow.
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

6. **Patch Session Config (#182).** Run the validator against the current `## Session Config` block; append any missing mandatory fields with defaults. The 7 mandatory fields (per `scripts/lib/config-schema.mjs`) are: `test-command`, `typecheck-command`, `lint-command`, `agents-per-wave`, `waves`, `persistence`, `enforcement`.

   ```bash
   CONFIG_OUT="$(node "$PLUGIN_ROOT/scripts/parse-config.mjs" 2>&1 >/dev/null)"
   # parse-config.mjs emits validation warnings to stderr when enforcement=warn.
   # Grep for 'must be' lines (issued by validate-config.mjs) to detect missing fields.
   MISSING_FIELDS="$(echo "$CONFIG_OUT" | grep -oE '(test-command|typecheck-command|lint-command|agents-per-wave|waves|persistence|enforcement)' | sort -u || true)"
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

     CONFIG_FILE="CLAUDE.md"
     [[ -f "AGENTS.md" ]] && CONFIG_FILE="AGENTS.md"

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

   This patch is best-effort: existing fields are never overwritten. If no fields are missing, this step is a no-op.

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

