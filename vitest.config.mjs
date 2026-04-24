import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs'],
    // skills/vault-sync/tests/schema-drift.test.mjs intentionally excluded:
    // it requires a sibling projects-baseline checkout (HAS_CANONICAL) and
    // ALL 5 tests skip in CI anyway. In vitest 2.1.9 + tinypool, discovering
    // a test file where every test is skipped leaves the worker hung at exit
    // → CI job hits 15m timeout despite all real tests passing (#268).
    // The schema-drift gate is enforced by the .gitlab-ci.yml `schema-drift`
    // stage via the sync-vault-schema.mjs script directly, not via vitest.
    // Local dev can still run: `npx vitest skills/vault-sync/tests/schema-drift.test.mjs`.
    testTimeout: 10000,
    // pool: 'forks' + teardownTimeout are belt+suspenders hardening against
    // tinypool worker-exit hangs. Integration tests spawn subprocesses (hooks,
    // registry, snapshots); process-fork pool has cleaner teardown than the
    // default thread pool, and the timeout kills a stuck worker in 15s
    // instead of letting the CI job hit its 15m timeout.
    pool: 'forks',
    teardownTimeout: 15000,
    hookTimeout: 30000,
  },
});
