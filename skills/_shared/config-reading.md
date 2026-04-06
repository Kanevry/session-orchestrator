# Session Config Reading

## Resolving the Plugin Root

`$CLAUDE_PLUGIN_ROOT` may not be set (depends on how hooks/skills are loaded). Resolve the script path with this fallback chain:

1. If `$CLAUDE_PLUGIN_ROOT` is set and non-empty, use it.
2. Otherwise, search for the plugin install location:
   ```bash
   PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
   if [[ -z "$PLUGIN_ROOT" ]]; then
     # Check common install locations
     for candidate in \
       "$HOME/Projects/session-orchestrator" \
       "$HOME/.claude/plugins/session-orchestrator" \
       "$(dirname "$(dirname "$(realpath "${BASH_SOURCE[0]}" 2>/dev/null || echo "")")")" \
     ; do
       if [[ -n "$candidate" && -f "$candidate/scripts/parse-config.sh" ]]; then
         PLUGIN_ROOT="$candidate"
         break
       fi
     done
   fi
   ```

## Parsing Config

Run `bash "$PLUGIN_ROOT/scripts/parse-config.sh"` to get the validated config JSON. If it exits with code 1, read stderr for the error and report to the user.

Store the JSON output as `$CONFIG` for use throughout this skill — extract fields with `echo "$CONFIG" | jq -r '.field-name'`.

### Handling `agents-per-wave` Overrides

`agents-per-wave` may be a plain integer (`6`) or a JSON object with session-type overrides (`{"default": 6, "deep": 18}`). To get the effective value for the current session type:

```bash
# Plain integer → use directly. Object → check for session-type override, fall back to .default
APW=$(echo "$CONFIG" | jq -r '."agents-per-wave"')
if echo "$APW" | jq -e 'type == "object"' > /dev/null 2>&1; then
  EFFECTIVE_APW=$(echo "$APW" | jq -r --arg st "$SESSION_TYPE" '.[$st] // .default')
else
  EFFECTIVE_APW="$APW"
fi
```

## Fallback

If the script is not available (missing file, `$PLUGIN_ROOT` unresolvable), fall back to reading CLAUDE.md manually per `docs/session-config-reference.md`.
