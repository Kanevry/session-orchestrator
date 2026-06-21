/**
 * namespace.test.mjs — Unit tests for scripts/lib/vault-mirror/namespace.mjs
 *
 * Tests resolveRepoNamespace({ vaultName?, cwd? }) → string contract:
 *  - vaultName override → sanitised slug (deterministic)
 *  - Leak redaction: CP1 (personal home path), CP6 (private slug), CP10 (personal Projects path)
 *  - Degenerate input (all special chars) → 'unknown-repo'
 *  - No vaultName → falls back to deriveRepo() path; result is a non-empty valid kebab slug
 *
 * All expected values are hardcoded literals derived empirically from subjectToSlug()
 * and isOwnerLeakySegment() so a bug in the production function fails the assertion.
 */

import { describe, it, expect } from 'vitest';
import { resolveRepoNamespace } from '@lib/vault-mirror/namespace.mjs';

// ---------------------------------------------------------------------------
// vault-name override → sanitised slug
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — vaultName override', () => {
  it('simple kebab name passes through unchanged', () => {
    expect(resolveRepoNamespace({ vaultName: 'test-vault' })).toBe('test-vault');
  });

  it('spaces are STRIPPED (not converted to hyphens) — matches subjectToSlug behavior', () => {
    // "My Repo" → lowercase → strip non-[a-z0-9-] (space is stripped) → "myrepo"
    expect(resolveRepoNamespace({ vaultName: 'My Repo' })).toBe('myrepo');
  });

  it('uppercase is lowercased', () => {
    expect(resolveRepoNamespace({ vaultName: 'MyVault' })).toBe('myvault');
  });

  it('dots and underscores are replaced with hyphens', () => {
    // "my.vault_name" → "my-vault-name"
    expect(resolveRepoNamespace({ vaultName: 'my.vault_name' })).toBe('my-vault-name');
  });

  it('a plain lowercase kebab slug is returned as-is', () => {
    expect(resolveRepoNamespace({ vaultName: 'session-orchestrator' })).toBe('session-orchestrator');
  });

  it('whitespace-only vaultName falls back to deriveRepo() (treated as absent)', () => {
    // "   " trims to "", which is falsy — falls through to deriveRepo()
    const result = resolveRepoNamespace({ vaultName: '   ' });
    // Result must be non-empty and a valid kebab slug
    expect(result).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Leak redaction: CP1 / CP6 / CP10
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — owner-privacy leak redaction', () => {
  it('CP6: private slug "launchpad-ai-factory" is redacted to "redacted-repo"', () => {
    // isOwnerLeakySegment('launchpad-ai-factory') returns 'CP6'
    expect(resolveRepoNamespace({ vaultName: 'launchpad-ai-factory' })).toBe('redacted-repo');
  });

  it('CP1: personal home path "/Users/bernhardg/x" is redacted to "redacted-repo"', () => {
    // isOwnerLeakySegment('/Users/bernhardg/x') returns 'CP1'
    expect(resolveRepoNamespace({ vaultName: '/Users/bernhardg/x' })).toBe('redacted-repo');
  });

  it('CP10: personal Projects path "~/Projects/Bernhard" is redacted to "redacted-repo"', () => {
    // isOwnerLeakySegment('~/Projects/Bernhard') returns 'CP10'
    expect(resolveRepoNamespace({ vaultName: '~/Projects/Bernhard' })).toBe('redacted-repo');
  });
});

// ---------------------------------------------------------------------------
// Degenerate / empty slug
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — degenerate inputs', () => {
  it('vaultName with only special chars collapses to empty slug → "unknown-repo"', () => {
    // "!@#$" → subjectToSlug strips all → "" → fallback
    expect(resolveRepoNamespace({ vaultName: '!@#$' })).toBe('unknown-repo');
  });

  it('null vaultName falls back to deriveRepo() and returns a non-empty slug', () => {
    const result = resolveRepoNamespace({ vaultName: null });
    expect(result.length).toBeGreaterThan(0);
    // Must be a valid kebab slug (may include slashes from org/repo form — accept either)
    expect(result).not.toBe('');
  });

  it('no argument at all falls back to deriveRepo() and returns a non-empty string', () => {
    const result = resolveRepoNamespace();
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('');
  });
});

// ---------------------------------------------------------------------------
// Default path: no vaultName → deriveRepo() result passes leak + slug validation
// ---------------------------------------------------------------------------

describe('resolveRepoNamespace — default (no vaultName)', () => {
  it('returns a non-empty string when vaultName is omitted', () => {
    const result = resolveRepoNamespace({});
    expect(result.length).toBeGreaterThan(0);
  });

  it('does not return "unknown-repo" in the default case (repo name is present)', () => {
    // deriveRepo() falls back to path.basename(process.cwd()) at minimum,
    // so the slug will not be empty in a real repo context.
    const result = resolveRepoNamespace({});
    expect(result).not.toBe('unknown-repo');
  });

  it('result is lowercase only (no uppercase chars)', () => {
    const result = resolveRepoNamespace({});
    expect(result).toBe(result.toLowerCase());
  });
});
