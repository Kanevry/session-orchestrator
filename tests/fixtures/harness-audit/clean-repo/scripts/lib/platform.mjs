// Fixture platform-detection helper — exercises the env-var fallback chain.
export function detectPlatform() {
  if (process.env.CLAUDE_PLUGIN_ROOT) return 'claude';
  if (process.env.CODEX_PLUGIN_ROOT) return 'codex';
  if (process.env.CURSOR_RULES_DIR) return 'cursor';
  return 'unknown';
}
