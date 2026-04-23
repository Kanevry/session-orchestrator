import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs', 'skills/*/tests/**/*.test.mjs'],
    testTimeout: 10000,
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
