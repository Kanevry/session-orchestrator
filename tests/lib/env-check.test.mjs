/**
 * tests/lib/env-check.test.mjs
 *
 * Smoke-level direct unit tests for scripts/lib/env-check.mjs (A4 barrel split).
 * Verifies the new module path resolves and the env/runtime checks behave.
 */

import { describe, it, expect } from 'vitest';
import {
  assertNodeVersion,
  assertDepInstalled,
  checkEnvironment,
} from '@lib/env-check.mjs';

describe('env-check.mjs (direct import)', () => {
  it('assertNodeVersion resolves for a satisfied minimum', async () => {
    // The test runner requires Node >= 20, so min=18 always passes.
    await expect(assertNodeVersion(18)).resolves.toBeUndefined();
  });

  it('assertNodeVersion throws when the minimum exceeds the running major', async () => {
    await expect(assertNodeVersion(999)).rejects.toThrow(/Node\.js 999\+ is required/);
  });

  it('assertDepInstalled returns false for a non-existent module without throwing', async () => {
    await expect(assertDepInstalled('this-module-does-not-exist-xyz')).resolves.toBe(false);
  });

  it('assertDepInstalled returns true for a core builtin', async () => {
    await expect(assertDepInstalled('node:path')).resolves.toBe(true);
  });

  it('checkEnvironment returns a structured ok=true result on a supported runtime', async () => {
    const result = await checkEnvironment();
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(Array.isArray(result.warnings)).toBe(true);
  });
});
