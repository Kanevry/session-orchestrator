/**
 * pseudonym-map.test.mjs — Unit tests for scripts/lib/vault-mirror/pseudonym-map.mjs (#725 D5)
 *
 * loadPseudonymMap({ mapPath, deps? }) → Map<string,string> | null
 *
 * All fs + leak-check + warn dependencies are INJECTED so the tests never touch
 * the real filesystem, the real owner-leakage patterns, or the operator's
 * ~/.config. Fixture slugs are invented ('acme-internal', 'flagged-pseudo') —
 * never the real private CP6 slugs (privacy invariant).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadPseudonymMap, _resetPseudonymMapCache } from '@lib/vault-mirror/pseudonym-map.mjs';

beforeEach(() => {
  _resetPseudonymMapCache();
});

/**
 * Build injectable deps backed by an in-memory file table.
 * @param {Record<string,string>} files - path → raw content
 * @param {(v: string) => (string|null)} [isLeaky]
 */
function makeDeps(files, isLeaky = () => null) {
  const warn = vi.fn();
  const readFileSync = vi.fn((p) => {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  });
  const existsSync = vi.fn((p) => p in files);
  return { deps: { readFileSync, existsSync, isLeaky, warn }, warn, readFileSync, existsSync };
}

// ---------------------------------------------------------------------------
// Unconfigured path → silent null
// ---------------------------------------------------------------------------

describe('loadPseudonymMap — unconfigured path is a silent no-op', () => {
  it('returns null for an empty-string mapPath without warning', () => {
    const { deps, warn } = makeDeps({});
    expect(loadPseudonymMap({ mapPath: '', deps })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null for a whitespace-only mapPath without warning', () => {
    const { deps, warn } = makeDeps({});
    expect(loadPseudonymMap({ mapPath: '   ', deps })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null for a non-string mapPath (undefined) without warning', () => {
    const { deps, warn } = makeDeps({});
    expect(loadPseudonymMap({ mapPath: undefined, deps })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Valid map
// ---------------------------------------------------------------------------

describe('loadPseudonymMap — valid map', () => {
  it('returns a Map of real-slug → pseudonym for a well-formed JSON object', () => {
    const path = '/tmp/map-valid.json';
    const { deps } = makeDeps({
      [path]: JSON.stringify({ 'acme-internal': 'alpha-team', 'beta-private': 'beta-team' }),
    });
    const map = loadPseudonymMap({ mapPath: path, deps });
    expect(map).toBeInstanceOf(Map);
    expect(map.get('acme-internal')).toBe('alpha-team');
    expect(map.get('beta-private')).toBe('beta-team');
    expect(map.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Missing / unreadable / malformed → null + WARN
// ---------------------------------------------------------------------------

describe('loadPseudonymMap — fallback with WARN', () => {
  it('missing file (path set) → null + WARN', () => {
    const { deps, warn } = makeDeps({});
    expect(loadPseudonymMap({ mapPath: '/tmp/absent.json', deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/does not exist/);
  });

  it('read error → null + WARN', () => {
    const path = '/tmp/unreadable.json';
    const warn = vi.fn();
    const deps = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EACCES');
      },
      isLeaky: () => null,
      warn,
    };
    expect(loadPseudonymMap({ mapPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/failed to read/);
  });

  it('malformed JSON → null + WARN', () => {
    const path = '/tmp/malformed.json';
    const { deps, warn } = makeDeps({ [path]: '{ not: valid json' });
    expect(loadPseudonymMap({ mapPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/malformed JSON/);
  });

  it('non-object JSON (array) → null + WARN', () => {
    const path = '/tmp/array.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify(['a', 'b']) });
    expect(loadPseudonymMap({ mapPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/must be a JSON object/);
  });
});

// ---------------------------------------------------------------------------
// Entry validation: invalid slug + leaky pseudonym
// ---------------------------------------------------------------------------

describe('loadPseudonymMap — entry validation', () => {
  it('drops a pseudonym that is not a valid kebab slug, keeps the rest', () => {
    const path = '/tmp/mixed-slug.json';
    const { deps, warn } = makeDeps({
      [path]: JSON.stringify({ 'acme-internal': 'Alpha Team', 'beta-private': 'beta-team' }),
    });
    const map = loadPseudonymMap({ mapPath: path, deps });
    expect(map.size).toBe(1);
    expect(map.get('beta-private')).toBe('beta-team');
    expect(map.has('acme-internal')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops a pseudonym that is itself owner-leaky, keeps the rest', () => {
    const path = '/tmp/leaky-pseudo.json';
    // Injected isLeaky flags the synthetic 'flagged-pseudo' value only.
    const isLeaky = (v) => (v === 'flagged-pseudo' ? 'CP6' : null);
    const { deps, warn } = makeDeps(
      { [path]: JSON.stringify({ 'acme-internal': 'flagged-pseudo', 'beta-private': 'beta-team' }) },
      isLeaky,
    );
    const map = loadPseudonymMap({ mapPath: path, deps });
    expect(map.size).toBe(1);
    expect(map.get('beta-private')).toBe('beta-team');
    expect(map.has('acme-internal')).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/owner-leaky/);
  });

  it('returns null when EVERY entry is dropped', () => {
    const path = '/tmp/all-leaky.json';
    const isLeaky = (v) => (v === 'flagged-pseudo' ? 'CP6' : null);
    const { deps, warn } = makeDeps(
      { [path]: JSON.stringify({ 'acme-internal': 'flagged-pseudo' }) },
      isLeaky,
    );
    expect(loadPseudonymMap({ mapPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('WARN for dropped entries does NOT leak the real key or rejected value', () => {
    const path = '/tmp/privacy.json';
    const isLeaky = (v) => (v === 'flagged-pseudo' ? 'CP6' : null);
    const { deps, warn } = makeDeps(
      { [path]: JSON.stringify({ 'secret-real-slug': 'flagged-pseudo' }) },
      isLeaky,
    );
    loadPseudonymMap({ mapPath: path, deps });
    const msg = warn.mock.calls[0][0];
    expect(msg).not.toMatch(/secret-real-slug/);
    expect(msg).not.toMatch(/flagged-pseudo/);
  });
});

// ---------------------------------------------------------------------------
// Per-process caching
// ---------------------------------------------------------------------------

describe('loadPseudonymMap — per-process cache', () => {
  it('reads + parses the file at most once per path', () => {
    const path = '/tmp/cache.json';
    const { deps, readFileSync } = makeDeps({ [path]: JSON.stringify({ 'acme-internal': 'alpha' }) });
    const first = loadPseudonymMap({ mapPath: path, deps });
    const second = loadPseudonymMap({ mapPath: path, deps });
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same cached Map instance
  });

  it('_resetPseudonymMapCache forces a fresh read', () => {
    const path = '/tmp/cache-reset.json';
    const { deps, readFileSync } = makeDeps({ [path]: JSON.stringify({ 'acme-internal': 'alpha' }) });
    loadPseudonymMap({ mapPath: path, deps });
    _resetPseudonymMapCache();
    loadPseudonymMap({ mapPath: path, deps });
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});
