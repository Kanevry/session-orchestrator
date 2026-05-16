import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@lib': path.resolve(__dirname, 'scripts/lib'),
    },
  },
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
    // CI override (30 s) tolerates concurrent-Claude CPU starvation on the
    // shared Mac shell-executor runner (testing.md > Shared-Hardware Runner
    // Contention, #392 cautionary tale, #408 mitigation). Local dev keeps
    // 10 s for fast hang detection. Per testing.md: 30 s is the ceiling
    // — do not push higher as a default.
    testTimeout: process.env.CI ? 30000 : 10000,
    // pool: 'forks' + teardownTimeout are belt+suspenders hardening against
    // tinypool worker-exit hangs. Integration tests spawn subprocesses (hooks,
    // registry, snapshots); process-fork pool has cleaner teardown than the
    // default thread pool, and the timeout kills a stuck worker in 15s
    // instead of letting the CI job hit its 15m timeout.
    pool: 'forks',
    teardownTimeout: 15000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['scripts/lib/**/*.mjs', 'hooks/**/*.mjs'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.mjs',
        '**/*.spec.mjs',
        'scripts/lib/vault-sync/**',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
});
