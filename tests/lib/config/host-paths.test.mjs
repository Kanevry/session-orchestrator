/**
 * host-paths.test.mjs — Unit tests for scripts/lib/config/host-paths.mjs (#653)
 *
 * Host-local path resolution layer. Resolves `vault-dir` / `baseline-path` with
 * precedence env-var > owner.yaml paths[key] > committedDefault, treating
 * empty/whitespace at any tier as "unset" (fall through). `loadHostPaths` wraps
 * the owner loader in try/catch.
 *
 * Behavior tests with hardcoded expecteds; mirrors the style of neighboring
 * tests/lib/config/*.test.mjs. A fake ownerLoader is injected for loadHostPaths
 * so no real owner.yaml on disk is touched.
 */

import { describe, it, expect } from 'vitest';
import { resolveHostPath, loadHostPaths } from '@lib/config/host-paths.mjs';

describe('resolveHostPath — precedence', () => {
  it('env-var wins over owner and committed', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: { SO_VAULT_DIR: '/env' },
      ownerConfig: { paths: { 'vault-dir': '/owner' } },
    });
    expect(result).toBe('/env');
  });

  it('owner wins when no env-var is set', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: {},
      ownerConfig: { paths: { 'vault-dir': '/owner' } },
    });
    expect(result).toBe('/owner');
  });

  it('committed default wins when no env and owner is empty', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: {},
      ownerConfig: {},
    });
    expect(result).toBe('/committed');
  });

  it('committed default wins when no env and ownerConfig is undefined', () => {
    const result = resolveHostPath('vault-dir', '/committed', { env: {} });
    expect(result).toBe('/committed');
  });
});

describe('resolveHostPath — committedDefault passthrough', () => {
  it('passes through null committedDefault unchanged when no overrides', () => {
    const result = resolveHostPath('vault-dir', null, { env: {}, ownerConfig: {} });
    expect(result).toBe(null);
  });

  it('passes through undefined committedDefault unchanged when no overrides', () => {
    const result = resolveHostPath('vault-dir', undefined, { env: {}, ownerConfig: {} });
    expect(result).toBe(undefined);
  });
});

describe('resolveHostPath — empty/whitespace tiers fall through', () => {
  it('falls through an empty-string env-var to the owner tier', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: { SO_VAULT_DIR: '' },
      ownerConfig: { paths: { 'vault-dir': '/owner' } },
    });
    expect(result).toBe('/owner');
  });

  it('falls through a whitespace-only env-var to the owner tier', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: { SO_VAULT_DIR: '   ' },
      ownerConfig: { paths: { 'vault-dir': '/owner' } },
    });
    expect(result).toBe('/owner');
  });

  it('falls through an empty-string owner value to the committed default', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: {},
      ownerConfig: { paths: { 'vault-dir': '' } },
    });
    expect(result).toBe('/committed');
  });

  it('falls through a whitespace-only owner value to the committed default', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: {},
      ownerConfig: { paths: { 'vault-dir': '   ' } },
    });
    expect(result).toBe('/committed');
  });
});

describe('resolveHostPath — key→env mapping', () => {
  it('baseline-path reads SO_BASELINE_PATH', () => {
    const result = resolveHostPath('baseline-path', '/committed', {
      env: { SO_BASELINE_PATH: '/env-baseline' },
      ownerConfig: { paths: { 'baseline-path': '/owner-baseline' } },
    });
    expect(result).toBe('/env-baseline');
  });

  it('SO_VAULT_DIR does NOT affect baseline-path resolution', () => {
    const result = resolveHostPath('baseline-path', '/committed', {
      env: { SO_VAULT_DIR: '/env-vault' },
      ownerConfig: {},
    });
    expect(result).toBe('/committed');
  });

  it('SO_BASELINE_PATH does NOT affect vault-dir resolution', () => {
    const result = resolveHostPath('vault-dir', '/committed', {
      env: { SO_BASELINE_PATH: '/env-baseline' },
      ownerConfig: {},
    });
    expect(result).toBe('/committed');
  });

  it('baseline-path owner override wins when no env-var is set', () => {
    const result = resolveHostPath('baseline-path', '/committed', {
      env: {},
      ownerConfig: { paths: { 'baseline-path': '/owner-baseline' } },
    });
    expect(result).toBe('/owner-baseline');
  });
});

describe('loadHostPaths', () => {
  it('returns the loaded ownerConfig and the passed env', () => {
    const fakeEnv = { SO_VAULT_DIR: '/x' };
    const ownerLoader = () => ({ config: { paths: { 'vault-dir': '/x' } } });
    const result = loadHostPaths({ env: fakeEnv, ownerLoader });
    expect(result).toEqual({
      ownerConfig: { paths: { 'vault-dir': '/x' } },
      env: { SO_VAULT_DIR: '/x' },
    });
  });

  it('returns ownerConfig undefined when the ownerLoader throws (no rethrow)', () => {
    const ownerLoader = () => {
      throw new Error('loader exploded');
    };
    const result = loadHostPaths({ env: {}, ownerLoader });
    expect(result.ownerConfig).toBe(undefined);
  });

  it('still returns the passed env when the ownerLoader throws', () => {
    const fakeEnv = { SO_BASELINE_PATH: '/y' };
    const ownerLoader = () => {
      throw new Error('loader exploded');
    };
    const result = loadHostPaths({ env: fakeEnv, ownerLoader });
    expect(result.env).toEqual({ SO_BASELINE_PATH: '/y' });
  });
});
