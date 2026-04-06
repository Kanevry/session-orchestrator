# Session Config Reading

Run `bash "$CLAUDE_PLUGIN_ROOT/scripts/parse-config.sh"` to get the validated config JSON. If it exits with code 1, read stderr for the error and report to the user.

Store the JSON output as `$CONFIG` for use throughout this skill — extract fields with `echo "$CONFIG" | jq -r '.field-name'`.

If the script is not available, fall back to reading CLAUDE.md manually per `docs/session-config-reference.md`.
