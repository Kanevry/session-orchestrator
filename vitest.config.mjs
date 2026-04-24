import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs', 'skills/*/tests/**/*.test.mjs'],
    testTimeout: 10000,
    // Worker threads sometimes fail to exit cleanly when integration tests
    // spawn subprocesses (hooks, registry, snapshots) — fork pool has cleaner
    // teardown than tinypool's default thread pool, preventing CI timeouts
    // at worker-exit even when all tests have actually passed (closes #268).
    pool: 'forks',
    // Hard upper bound on teardown: if a worker refuses to exit, kill it
    // after 15s instead of hanging the CI job to its 15m timeout.
    teardownTimeout: 15000,
    hookTimeout: 30000,
  },
});
