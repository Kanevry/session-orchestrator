/**
 * confidential-names.test.mjs — Unit tests for scripts/lib/validate/confidential-names.mjs (#728a)
 *
 * TWO entry points since the W4 fix pass (#1264):
 *   loadConfidentialNames({ namesPath, deps? })    → string[] | null   (4.0.0 shape)
 *   inspectConfidentialNames({ namesPath, deps? }) → { status, names } (discriminated)
 *
 * `loadConfidentialNames` is the PUBLIC 4.0.0 contract — `package.json` carries no
 * `exports` map, so consumer repos can deep-import it and a PATCH release must not
 * change its shape (W4 finding F2). The discriminated shape lives on the ADDITIVE
 * `inspectConfidentialNames`, which is what the scanner consumes.
 *
 * All fs + warn dependencies are INJECTED so the tests never touch the real
 * filesystem or the operator's ~/.config. Fixture names are invented
 * ('acme-corp', 'zenith-dynamics') — NEVER a real confidential customer/repo
 * name (confidentiality invariant, mirrors pseudonym-map.test.mjs).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadConfidentialNames,
  inspectConfidentialNames,
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
// Unconfigured path → silent 'unconfigured'
// ---------------------------------------------------------------------------

describe('inspectConfidentialNames — unconfigured path is a silent no-op', () => {
  it("returns status 'unconfigured' for an empty-string namesPath without warning", () => {
    const { deps, warn } = makeDeps({});
    expect(inspectConfidentialNames({ namesPath: '', deps })).toEqual({
      status: 'unconfigured',
      names: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns status 'unconfigured' for a whitespace-only namesPath without warning", () => {
    const { deps, warn } = makeDeps({});
    expect(inspectConfidentialNames({ namesPath: '   ', deps })).toEqual({
      status: 'unconfigured',
      names: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns status 'unconfigured' for a non-string namesPath (undefined) without warning", () => {
    const { deps, warn } = makeDeps({});
    expect(inspectConfidentialNames({ namesPath: undefined, deps })).toEqual({
      status: 'unconfigured',
      names: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Valid list
// ---------------------------------------------------------------------------

describe('inspectConfidentialNames — valid list', () => {
  it('returns the string array for a well-formed JSON array', () => {
    const path = '/tmp/names-valid.json';
    const { deps } = makeDeps({
      [path]: JSON.stringify(['acme-corp', 'zenith-dynamics']),
    });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'ok',
      names: ['acme-corp', 'zenith-dynamics'],
    });
  });

  it('trims surrounding whitespace on each entry', () => {
    const path = '/tmp/names-trim.json';
    const { deps } = makeDeps({ [path]: JSON.stringify(['  acme-corp  ']) });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'ok',
      names: ['acme-corp'],
    });
  });
});

// ---------------------------------------------------------------------------
// Missing / unreadable / malformed → a classifying status + WARN
// ---------------------------------------------------------------------------

describe('inspectConfidentialNames — fallback with WARN', () => {
  it("missing file (path set) → status 'missing' + WARN", () => {
    const { deps, warn } = makeDeps({});
    expect(inspectConfidentialNames({ namesPath: '/tmp/absent.json', deps })).toEqual({
      status: 'missing',
      names: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/does not exist/);
  });

  it("read error → status 'malformed' + WARN", () => {
    const path = '/tmp/unreadable.json';
    const warn = vi.fn();
    const deps = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EACCES');
      },
      warn,
    };
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'malformed',
      names: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/failed to read/);
  });

  it("malformed JSON → status 'malformed' + WARN", () => {
    const path = '/tmp/malformed.json';
    const { deps, warn } = makeDeps({ [path]: '[ not valid json' });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'malformed',
      names: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/malformed JSON/);
  });

  it("non-array JSON (object) → status 'malformed' + WARN", () => {
    const path = '/tmp/object.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify({ a: 'b' }) });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'malformed',
      names: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/must be a JSON array/);
  });

  // Fix 3 (security-reviewer): the malformed-JSON WARN must NOT embed err.message —
  // V8's JSON.parse error text echoes the first ~10 chars of the file body (a
  // would-be confidential-name prefix). The WARN carries only err.name + basename.
  it('malformed-JSON WARN never leaks file content — only err.name + basename', () => {
    const path = '/tmp/leaky-malformed.json';
    const { deps, warn } = makeDeps({ [path]: 'ACMELEAK not valid json' });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'malformed',
      names: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0][0];
    expect(msg).not.toMatch(/ACMELEAK/);
    expect(msg).toMatch(/SyntaxError/);
    expect(msg).toContain('leaky-malformed.json');
  });

  // #1250: 'empty' is an OPERATOR CHOICE and must stay distinguishable from
  // 'missing'/'malformed' — the scanner treats it as inactive, not as a guard
  // that failed to run.
  it("empty array → status 'empty' (operator opt-out), no WARN", () => {
    const path = '/tmp/empty.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify([]) });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'empty',
      names: [],
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F1 (W4 panel): NO WARN may carry the host-local names-file PATH
//
// These WARNs fire on exactly the branches the scanner turns into FAIL + exit 1,
// i.e. output an operator pastes into a PUBLIC CI log. A `/Users/<name>/…` path
// there is the very leak CP1 exists to block. Only the basename survives.
// ---------------------------------------------------------------------------

describe('inspectConfidentialNames — WARNs never carry the host-local path (F1)', () => {
  const SECRET_DIR = '/Users/someone/SECRET-CUSTOMER-DIR';

  /** @param {Record<string,string>} files @param {string} path */
  function warnsFor(files, path) {
    const { deps, warn } = makeDeps(files);
    inspectConfidentialNames({ namesPath: path, deps });
    return warn.mock.calls.map((c) => c[0]).join('');
  }

  it('missing-file WARN carries the basename, never the directory', () => {
    const path = `${SECRET_DIR}/names.json`;
    const msg = warnsFor({}, path);
    expect(msg).not.toContain(path);
    expect(msg).not.toContain(SECRET_DIR);
    expect(msg).toContain('names.json');
  });

  it('malformed-JSON WARN carries the basename, never the directory', () => {
    const path = `${SECRET_DIR}/names.json`;
    const msg = warnsFor({ [path]: '[ broken' }, path);
    expect(msg).not.toContain(path);
    expect(msg).not.toContain(SECRET_DIR);
  });

  it('non-array WARN carries the basename, never the directory', () => {
    const path = `${SECRET_DIR}/names.json`;
    const msg = warnsFor({ [path]: '{"a":"b"}' }, path);
    expect(msg).not.toContain(path);
    expect(msg).not.toContain(SECRET_DIR);
  });

  it('dropped-entries WARN carries the basename, never the directory', () => {
    const path = `${SECRET_DIR}/names.json`;
    const msg = warnsFor({ [path]: JSON.stringify(['acme-corp', 42]) }, path);
    expect(msg).not.toContain(path);
    expect(msg).not.toContain(SECRET_DIR);
  });

  it('read-error WARN carries the basename, never the directory', () => {
    const path = `${SECRET_DIR}/names.json`;
    const warn = vi.fn();
    inspectConfidentialNames({
      namesPath: path,
      deps: {
        existsSync: () => true,
        readFileSync: () => {
          throw new Error('EACCES');
        },
        warn,
      },
    });
    const msg = warn.mock.calls.map((c) => c[0]).join('');
    expect(msg).not.toContain(path);
    expect(msg).not.toContain(SECRET_DIR);
    expect(msg).toContain('names.json');
  });
});

// ---------------------------------------------------------------------------
// Entry validation: invalid + oversized entries dropped, count-only WARN
// ---------------------------------------------------------------------------

describe('inspectConfidentialNames — entry validation', () => {
  it('drops a non-string entry, keeps the valid ones', () => {
    const path = '/tmp/mixed-type.json';
    const { deps, warn } = makeDeps({
      [path]: JSON.stringify(['acme-corp', 42, 'zenith-dynamics']),
    });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'ok',
      names: ['acme-corp', 'zenith-dynamics'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops an empty-string entry, keeps the valid ones', () => {
    const path = '/tmp/empty-entry.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify(['acme-corp', '   ']) });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'ok',
      names: ['acme-corp'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('drops an oversized entry (>256 chars), keeps the valid ones', () => {
    const path = '/tmp/oversized.json';
    const oversized = 'x'.repeat(257);
    const { deps, warn } = makeDeps({
      [path]: JSON.stringify(['acme-corp', oversized]),
    });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'ok',
      names: ['acme-corp'],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  // F3 (W4 panel, fail-open): a NON-EMPTY array whose entries are all rejected is
  // a CORRUPTED list, not the operator's `[]` opt-out. Collapsing it into 'empty'
  // made the scanner PASS silently with CP11 carrying zero patterns.
  it("returns status 'all-dropped' when EVERY entry of a non-empty array is dropped", () => {
    const path = '/tmp/all-invalid.json';
    const { deps, warn } = makeDeps({ [path]: JSON.stringify([42, '', null]) });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'all-dropped',
      names: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("oversized-only entries also yield 'all-dropped', never 'empty'", () => {
    const path = '/tmp/all-oversized.json';
    const { deps } = makeDeps({
      [path]: JSON.stringify(['x'.repeat(300), 'y'.repeat(400)]),
    });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'all-dropped',
      names: [],
    });
  });

  it('drop WARN does NOT leak the offending oversized name (count-only)', () => {
    const path = '/tmp/privacy.json';
    // A synthetic "confidential" oversized name embedding a recognizable token.
    const secret = 'SECRET-CUSTOMER-' + 'y'.repeat(260);
    const { deps, warn } = makeDeps({ [path]: JSON.stringify(['acme-corp', secret]) });
    inspectConfidentialNames({ namesPath: path, deps });
    const msg = warn.mock.calls[0][0];
    expect(msg).not.toMatch(/SECRET-CUSTOMER/);
    // The WARN carries only counts + the file basename, never the entry itself.
    expect(msg).toMatch(/ignored 0 invalid and 1 oversized/);
  });
});

// ---------------------------------------------------------------------------
// F2: the 4.0.0 `string[] | null` contract of loadConfidentialNames
// ---------------------------------------------------------------------------

describe('loadConfidentialNames — 4.0.0 public contract (string[] | null)', () => {
  it('returns the plain string array for a well-formed list', () => {
    const path = '/tmp/legacy-valid.json';
    const { deps } = makeDeps({ [path]: JSON.stringify(['acme-corp', 'zenith-dynamics']) });
    expect(loadConfidentialNames({ namesPath: path, deps })).toEqual([
      'acme-corp',
      'zenith-dynamics',
    ]);
  });

  it.each([
    ['unconfigured (empty string)', {}, ''],
    ['unconfigured (whitespace)', {}, '   '],
    ['missing file', {}, '/tmp/legacy-absent.json'],
    ['malformed JSON', { '/tmp/legacy-bad.json': '[ broken' }, '/tmp/legacy-bad.json'],
    ['non-array JSON', { '/tmp/legacy-obj.json': '{"a":"b"}' }, '/tmp/legacy-obj.json'],
    ['empty array', { '/tmp/legacy-empty.json': '[]' }, '/tmp/legacy-empty.json'],
    ['all entries dropped', { '/tmp/legacy-drop.json': '[42,""]' }, '/tmp/legacy-drop.json'],
  ])('collapses %s into null (the shape external deep-importers pin)', (_label, files, path) => {
    const { deps } = makeDeps(files);
    expect(loadConfidentialNames({ namesPath: path, deps })).toBeNull();
  });

  it('is callable with no argument at all (defaults to unconfigured → null)', () => {
    expect(loadConfidentialNames()).toBeNull();
  });

  it('shares ONE cache entry with inspectConfidentialNames — the file is read once', () => {
    const path = '/tmp/legacy-cache.json';
    const { deps, readFileSync } = makeDeps({ [path]: JSON.stringify(['acme-corp']) });
    expect(inspectConfidentialNames({ namesPath: path, deps })).toEqual({
      status: 'ok',
      names: ['acme-corp'],
    });
    expect(loadConfidentialNames({ namesPath: path, deps })).toEqual(['acme-corp']);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Per-process caching
// ---------------------------------------------------------------------------

describe('inspectConfidentialNames — per-process cache', () => {
  it('reads + parses the file at most once per path', () => {
    const path = '/tmp/cache.json';
    const { deps, readFileSync } = makeDeps({ [path]: JSON.stringify(['acme-corp']) });
    const first = inspectConfidentialNames({ namesPath: path, deps });
    const second = inspectConfidentialNames({ namesPath: path, deps });
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(second).toBe(first); // same cached result object instance
  });

  it('_resetConfidentialNamesCache forces a fresh read', () => {
    const path = '/tmp/cache-reset.json';
    const { deps, readFileSync } = makeDeps({ [path]: JSON.stringify(['acme-corp']) });
    inspectConfidentialNames({ namesPath: path, deps });
    _resetConfidentialNamesCache();
    inspectConfidentialNames({ namesPath: path, deps });
    expect(readFileSync).toHaveBeenCalledTimes(2);
  });
});
