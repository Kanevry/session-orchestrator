# Phase 3.7: Write Session Metrics

> Sub-file of the session-end skill. Executed as part of Phase 3 (Documentation Updates) when `persistence` is enabled.
> For the full session close-out flow, see `SKILL.md`.

### 3.7 Write Session Metrics

> Gate: Only run if `persistence` is enabled in Session Config.
>
> This step writes the session JSONL entry, verifies it, then optionally mirrors the session summary to the configured Obsidian vault via `scripts/vault-mirror.mjs`.

1. Ensure `.orchestrator/metrics/` directory exists: `mkdir -p .orchestrator/metrics`
2. Append the prepared JSONL entry (from Phase 1.7) as a single line to `.orchestrator/metrics/sessions.jsonl`
   > **Concurrent write safety**: Use shell `>>` append for the single JSONL line — this is atomic on POSIX systems for writes under PIPE_BUF (typically 4096 bytes). Do NOT read-modify-write the file.
3. Create the file if it does not exist
4. Verify: read back the last line to confirm valid JSON
5. **Vault Mirror** — mirror the session entry to the Obsidian vault (if configured):

   ```bash
   VM_ENABLED=$(echo "$CONFIG" | jq -r '."vault-integration".enabled // false')
   VM_MODE=$(echo "$CONFIG" | jq -r '."vault-integration".mode // "warn"')

   if [[ "$VM_ENABLED" == "true" && "$VM_MODE" != "off" ]]; then
     # Resolve vault directory: config field takes precedence, env var as fallback
     VM_DIR=$(echo "$CONFIG" | jq -r '."vault-integration"."vault-dir" // empty')
     : "${VM_DIR:=$VAULT_DIR}"

     VM_OUTPUT=$(node "$PLUGIN_ROOT/scripts/vault-mirror.mjs" \
       --vault-dir "$VM_DIR" \
       --source .orchestrator/metrics/sessions.jsonl \
       --kind session 2>&1)
     VM_EXIT=$?

     # Surface script output so user can see skipped-handwritten results
     if [[ -n "$VM_OUTPUT" ]]; then
       echo "$VM_OUTPUT"
     fi

     if [[ $VM_EXIT -ne 0 ]]; then
       if [[ "$VM_MODE" == "strict" ]]; then
         echo "ERROR: vault-mirror failed (exit $VM_EXIT) — session close blocked (vault-integration.mode=strict)"
         echo "Fix the vault mirror issue or set vault-integration.mode: warn to downgrade to a warning."
         exit 1
       else
         # mode: warn (default) — surface warning but do not block
         echo "WARNING: vault-mirror exited $VM_EXIT — session metrics were NOT mirrored to the vault. Set vault-integration.mode: strict to block on this error."
       fi
     else
       # Parse the destination path from the script's JSON output (one JSON line per action)
       VM_DEST=$(echo "$VM_OUTPUT" | jq -r 'select(.action == "created" or .action == "updated") | .path' 2>/dev/null | head -1)
       if [[ -n "$VM_DEST" ]]; then
         echo "Mirrored session summary to $VM_DEST"
       fi
     fi
   fi
   ```

   **Behaviour matrix:**

   | `enabled` | `mode`  | Result |
   |-----------|---------|--------|
   | `false` or missing | any | Skip entirely — no-op, no output |
   | `true` | `off`   | Skip entirely — no-op, no output |
   | `true` | `warn`  | Run mirror; on failure surface a warning but do NOT block close |
   | `true` | `strict` | Run mirror; on failure block session close with an error message |

   > **Hand-written note protection:** `vault-mirror.mjs` checks for a `_generator: session-orchestrator-vault-mirror@1` marker before overwriting any existing file. When it skips an existing hand-written note it emits a JSON line `{"action":"skipped-handwritten","path":"<path>","kind":"<kind>","id":"<id>"}` — the step above surfaces this output so the user can see the result. Action names: `created`, `updated`, `skipped-noop`, `skipped-handwritten`, `skipped-collision-resolved`, `skipped-invalid` (entry failed required-field validation).
