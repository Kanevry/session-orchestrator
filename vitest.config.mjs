import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.mjs', 'skills/*/tests/**/*.test.mjs'],
    testTimeout: 10000,
  },
});
