import { describe, it, expect } from 'vitest';
import {
  _normalizeRemote,
  _resolveCanonicalSuffix,
} from '../../scripts/vault-mirror.mjs';

// #607 D2: scripts/vault-mirror.mjs now exports the canonicalization helpers and
// guards the CLI bootstrap (arg parsing + main()) behind an import.meta.url
// entry-check, so the logic is unit-testable directly (no subprocess required).
// End-to-end subprocess behaviour (git init + real remote) remains covered by
// tests/scripts/vault-mirror-entry-point.test.mjs.
//
// Expected values below are the ACTUAL _normalizeRemote outputs: it strips the
// `.git` suffix, rewrites `git@host:` → `host/`, strips a `scheme://` prefix,
// and trims trailing slashes — producing a `host/path` tail. The canonical-vault
// guard then matches via `.endsWith(CANONICAL_VAULT_SUFFIX)`, so a `host/path`
// form ending in `/agents/vault` passes.

describe('vault-mirror _normalizeRemote (#607 D2)', () => {
  it('rewrites an SSH remote to host/path and strips .git', () => {
    expect(_normalizeRemote('git@github.com:acme/agents.git')).toBe('github.com/acme/agents');
  });

  it('strips the scheme from an HTTPS remote, leaving host/path', () => {
    expect(_normalizeRemote('https://github.com/acme/agents.git')).toBe('github.com/acme/agents');
  });

  it('preserves a multi-segment path so the canonical suffix can match', () => {
    const normalized = _normalizeRemote('git@github.com:acme/agents/vault.git');
    expect(normalized).toBe('github.com/acme/agents/vault');
    expect(normalized.endsWith('/agents/vault')).toBe(true);
  });

  it('strips a trailing .git suffix', () => {
    expect(_normalizeRemote('git@host:org/repo.git')).toBe('host/org/repo');
  });

  it('trims trailing slashes', () => {
    expect(_normalizeRemote('https://github.com/acme/agents///')).toBe('github.com/acme/agents');
  });

  it('returns empty string for nullish input', () => {
    expect(_normalizeRemote(undefined)).toBe('');
    expect(_normalizeRemote(null)).toBe('');
  });
});

describe('vault-mirror _resolveCanonicalSuffix (#607 D2)', () => {
  it('returns the env value when set to a non-blank string', () => {
    expect(_resolveCanonicalSuffix('/custom/vault')).toBe('/custom/vault');
  });

  it('trims surrounding whitespace from the env value', () => {
    expect(_resolveCanonicalSuffix('  /custom/vault  ')).toBe('/custom/vault');
  });

  it('falls back to /agents/vault for an empty-string env value', () => {
    expect(_resolveCanonicalSuffix('')).toBe('/agents/vault');
  });

  it('falls back to /agents/vault for a whitespace-only env value', () => {
    expect(_resolveCanonicalSuffix('   ')).toBe('/agents/vault');
  });

  it('falls back to /agents/vault when the env value is undefined', () => {
    expect(_resolveCanonicalSuffix(undefined)).toBe('/agents/vault');
  });
});
