/**
 * Isolate fixture identity from the harness running Vitest (#1274).
 * A real CODEX_THREAD_ID combined with a fixture CLAUDE_CODE_SESSION_ID is
 * correctly ambiguous in production, but made 17 existing consumer tests
 * depend on which harness started them. Clear inherited identity before test
 * imports; individual tests can still set any native IDs or platform explicitly.
 *
 * SO_VAULT_INTEGRATION (SO#1448) is the host-local, lower-only vault-integration
 * switch. An operator who exports `SO_VAULT_INTEGRATION=off` would otherwise flip
 * every fixture that asserts the COMMITTED `vault-integration.mode` — measured:
 * 2 failures in tests/integration/parse-config-validator.test.mjs, whose child
 * process inherits this env. Tests that exercise the switch pass it explicitly.
 * SO_VAULT_DIR is deliberately NOT cleared here: tests/setup/vault-guard.mjs
 * repoints it at a temp dir instead, which is the stronger guard for that key.
 */
for (const key of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'SO_PLATFORM', 'SO_VAULT_INTEGRATION']) {
  delete process.env[key];
}
