/**
 * confidential-names.test.mjs — Unit tests for scripts/lib/validate/confidential-names.mjs (#728a)
 *
 * loadConfidentialNames({ namesPath, deps? }) → string[] | null
 *
 * All fs + warn dependencies are INJECTED so the tests never touch the real
 * filesystem or the operator's ~/.config. Fixture names are invented
 * ('acme-corp', 'zenith-dynamics') — NEVER a real confidential customer/repo
 * name (confidentiality invariant, mirrors pseudonym-map.test.mjs).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadConfidentialNames,
  _resetConfidentialNamesCache,
} from '@lib/validate/confidential-names.mjs';

beforeEach(() => {
  _resetConfidentialNamesCache();
});

/**
 * Build injectable deps backed by an in-memory file table.
 * @param {Record<string,string>} files - path → raw content
 */
function makeDeps(files) {
  const warn = vi.fn();
  const readFileSync = vi.fn((p) => {
    if (!(p in files)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  });
  const existsSync = vi.fn((p) => p in files);
  return { deps: { readFileSync, existsSync, warn }, warn, readFileSync, existsSync };
}

// ---------------------------------------------------------------------------
// Unconfigured path → silent null
// ---------------------------------------------------------------------------

describe('loadConfidentialNames — unconfigured path is a silent no-op', () => {
  it('returns null for an empty-string namesPath without warning', () => {
    const { deps, warn } = makeDeps({});
    expect(loadConfidentialNames({ namesPath: '', deps })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null for a whitespace-only namesPath without warning', () => {
    const { deps, warn } = makeDeps({});
    expect(loadConfidentialNames({ namesPath: '   ', deps })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null for a non-string namesPath (undefined) without warning', () => {
    const { deps, warn } = makeDeps({});
    expect(loadConfidentialNames({ namesPath: undefined, deps })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Valid list
// ---------------------------------------------------------------------------

describe('loadConfidentialNames — valid list', () => {
  it('returns the string array for a well-formed JSON array', () => {
    const path = '/tmp/names-valid.json';
    const { deps } = makeDeps({
      [path]: JSON.stringify(['acme-corp', 'zenith-dynamics']),
    });
    expect(loadConfidentialNames({ namesPath: path, deps })).toEqual([
      'acme-corp',
      'zenith-dynamics',
    ]);
  });

  it('trims surrounding whitespace on each entry', () => {
    const path = '/tmp/names-trim.json';
    const { deps } = makeDeps({ [path]: JSON.stringify(['  acme-corp  ']) });
    expect(loadConfidentialNames({ namesPath: path, deps })).toEqual(['acme-corp']);
  });
});

// ---------------------------------------------------------------------------
// Missing / unreadable / malformed → null + WARN
// ---------------------------------------------------------------------------

describe('loadConfidentialNames — fallback with WARN', () => {
  it('missing file (path set) → null + WARN', () => {
    const { deps, warn } = makeDeps({});
    expect(loadConfidentialNames({ namesPath: '/tmp/absent.json', deps })).toBeNull();
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
      warn,
    };
    expect(loadConfidentialNames({ namesPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/failed to read/);
  });

  it('malformed JSON → null + WARN', () => {
    const path = '/tmp/malformed.json';
    const { deps, warn } = makeDeps({ [path]: '[ not valid json' });
    expect(loadConfidentialNames({ namesPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/malformed JSON/);
  });

  it('non-array JSON (object) → null + WARN', () => {
    const path = '/tmp/object.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify({ a: 'b' }) });
    expect(loadConfidentialNames({ namesPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/must be a JSON array/);
  });

  // Fix 3 (security-reviewer): the malformed-JSON WARN must NOT embed err.message —
  // V8's JSON.parse error text echoes the first ~10 chars of the file body (a
  // would-be confidential-name prefix). The WARN carries only err.name + the path.
  it('malformed-JSON WARN never leaks file content — only err.name + path', () => {
    const path = '/tmp/leaky-malformed.json';
    const { deps, warn } = makeDeps({ [path]: 'ACMELEAK not valid json' });
    expect(loadConfidentialNames({ namesPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).not.toMatch(/ACMELEAK/);
    expect(msg).toMatch(/SyntaxError/);
    expect(msg).toContain(path);
  });

  it('empty array → null (no names configured), no WARN', () => {
    const path = '/tmp/empty.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify([]) });
    expect(loadConfidentialNames({ namesPath: path, deps })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Entry validation: invalid + oversized entries dropped, count-only WARN
// ---------------------------------------------------------------------------

describe('loadConfidentialNames — entry validation', () => {
  it('drops a non-string entry, keeps the valid ones', () => {
    const path = '/tmp/mixed-type.json';
    const { deps, warn } = makeDeps({
      [path]: JSON.stringify(['acme-corp', 42, 'zenith-dynamics']),
    });
    expect(loadConfidentialNames({ namesPath: path, deps })).toEqual([
      'acme-corp',
      'zenith-dynamics',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops an empty-string entry, keeps the valid ones', () => {
    const path = '/tmp/empty-entry.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify(['acme-corp', '   ']) });
    expect(loadConfidentialNames({ namesPath: path, deps })).toEqual(['acme-corp']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops an oversized entry (>256 chars), keeps the valid ones', () => {
    const path = '/tmp/oversized.json';
    const oversized = 'x'.repeat(257);
    const { deps, warn } = makeDeps({
      [path]: JSON.stringify(['acme-corp', oversized]),
    });
    expect(loadConfidentialNames({ namesPath: path, deps })).toEqual(['acme-corp']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('returns null when EVERY entry is dropped', () => {
    const path = '/tmp/all-invalid.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify([42, '', null]) });
    expect(loadConfidentialNames({ namesPath: path, deps })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drop WARN does NOT leak the offending oversized name (count-only)', () => {
    const path = '/tmp/privacy.json';
    // A synthetic "confidential" oversized name embedding a recognizable token.
    const secret = 'SECRET-CUSTOMER-' + 'y'.repeat(260);
    const { deps, warn } = makeDeps({ [path]: JSON.stringify(['acme-corp', secret]) });
    loadConfidentialNames({ namesPath: path, deps });
    const msg = warn.mock.calls[0][0];
    expect(msg).not.toMatch(/SECRET-CUSTOMER/);
    // The WARN carries only counts + the file path, never the entry itself.
    expect(msg).toMatch(/ignored 0 invalid and 1 oversized/);
  });
});

// ---------------------------------------------------------------------------
// Per-process caching
// ---------------------------------------------------------------------------

describe('loadConfidentialNames — per-process cache', () => {
  it('reads + parses the file at most once per path', () => {
    const path = '/tmp/cache.json';
    const { deps, readFileSync } = makeDeps({ [path]: JSON.stringify(['acme-corp']) });
    const first = loadConfidentialNames({ namesPath: path, deps });
    const second = loadConfidentialNames({ namesPath: path, deps });
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same cached array instance
  });

  it('_resetConfidentialNamesCache forces a fresh read', () => {
    const path = '/tmp/cache-reset.json';
    const { deps, readFileSync } = makeDeps({ [path]: JSON.stringify(['acme-corp']) });
    loadConfidentialNames({ namesPath: path, deps });
    _resetConfidentialNamesCache();
    loadConfidentialNames({ namesPath: path, deps });
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});
