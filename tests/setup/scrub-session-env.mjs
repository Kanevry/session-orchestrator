/**
 * Isolate fixture identity from the harness running Vitest (#1274).
 * A real CODEX_THREAD_ID combined with a fixture CLAUDE_CODE_SESSION_ID is
 * correctly ambiguous in production, but made 17 existing consumer tests
 * depend on which harness started them. Clear inherited identity before test
 * imports; individual tests can still set any native IDs or platform explicitly.
 */
for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'SO_PLATFORM']) {
  delete process.env[key];
}
