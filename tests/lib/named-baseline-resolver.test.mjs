/**
 * tests/lib/named-baseline-resolver.test.mjs
 *
 * Unit tests for scripts/lib/named-baseline-resolver.mjs (Issue #819).
 *
 * ownerConfig + cwd + env are injected as literal objects — no disk, no git.
 * Tests verify:
 *  - Backward-compat: absent baselines → null-fallback (source null).
 *  - parseBaselines: malformed entries dropped with WARN; valid entries preserved.
 *  - matchBaselineForPath: directory-prefix matching, first-match-wins, ambiguity WARN.
 *  - resolveNamedBaseline: the two issue ACs literally —
 *      AC1: cwd under ~/Projects/private-world → private baseline; cwd under
 *           ~/Projects/intern → aiat baseline; SO_BASELINE_PATH env yields to caller.
 *      AC2: malformed/missing baselines → null-fallback with WARN, never throws.
 */

import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  parseBaselines,
  matchBaselineForPath,
  resolveNamedBaseline,
} from '@lib/named-baseline-resolver.mjs';

// ---------------------------------------------------------------------------
// Stderr capture helper — mirrors tests/lib/named-vault-resolver.test.mjs L33-46
// ---------------------------------------------------------------------------

function captureStderr(fn) {
  const lines = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// parseBaselines
// ---------------------------------------------------------------------------

describe('parseBaselines — absent baselines section', () => {
  it('returns [] when ownerConfig is undefined', () => {
    expect(parseBaselines(undefined)).toEqual([]);
  });

  it('returns [] when ownerConfig has no baselines key', () => {
    expect(parseBaselines({ owner: { name: 'Test' } })).toEqual([]);
  });

  it('returns [] when baselines is null', () => {
    expect(parseBaselines({ baselines: null })).toEqual([]);
  });

  it('returns [] when baselines is an empty array', () => {
    expect(parseBaselines({ baselines: [] })).toEqual([]);
  });
});

describe('parseBaselines — valid entries', () => {
  it('parses a single well-formed entry', () => {
    const config = {
      baselines: [
        { name: 'private', path: '~/Projects/private-world/projects-baseline', match: { 'path-prefix': '~/Projects/private-world' } },
      ],
    };
    const result = parseBaselines(config);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('private');
    expect(result[0].path).toBe('~/Projects/private-world/projects-baseline');
    expect(result[0].match['path-prefix']).toBe('~/Projects/private-world');
  });

  it('parses multiple valid entries and preserves order', () => {
    const config = {
      baselines: [
        { name: 'private', path: '~/p/base', match: { 'path-prefix': '~/Projects/private-world' } },
        { name: 'aiat', path: '~/a/base', match: { 'path-prefix': '~/Projects/intern' } },
      ],
    };
    const result = parseBaselines(config);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('private');
    expect(result[1].name).toBe('aiat');
  });

  it('trims whitespace on name, path, and path-prefix', () => {
    const config = {
      baselines: [
        { name: '  private  ', path: '  ~/p/base  ', match: { 'path-prefix': '  ~/Projects/private-world  ' } },
      ],
    };
    const result = parseBaselines(config);
    expect(result[0].name).toBe('private');
    expect(result[0].path).toBe('~/p/base');
    expect(result[0].match['path-prefix']).toBe('~/Projects/private-world');
  });
});

describe('parseBaselines — malformed entries dropped with WARN', () => {
  it('drops an entry missing name and emits WARN', () => {
    const config = { baselines: [{ path: '~/p', match: { 'path-prefix': '~/x' } }] };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops an entry missing path and emits WARN', () => {
    const config = { baselines: [{ name: 'p', match: { 'path-prefix': '~/x' } }] };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops an entry missing match and emits WARN', () => {
    const config = { baselines: [{ name: 'p', path: '~/p' }] };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops an entry whose match lacks path-prefix and emits WARN', () => {
    const config = { baselines: [{ name: 'p', path: '~/p', match: {} }] };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops only the malformed entry; valid entries survive', () => {
    const config = {
      baselines: [
        { name: 'good', path: '~/g', match: { 'path-prefix': '~/Projects/private-world' } },
        { path: '~/p', match: { 'path-prefix': '~/x' } }, // missing name
      ],
    };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('good');
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('drops a non-object entry and emits WARN', () => {
    const config = { baselines: ['not-an-object'] };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('WARNs and returns [] when baselines: is not an array (e.g. an object)', () => {
    const config = { baselines: { name: 'oops' } };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  // LOW batch: empty-string (not just missing/wrong-type) sub-branches — each
  // field's `.trim() === ''` guard drops the entry the same way a missing field
  // does, so a blank string is not silently accepted as a "present" value.
  it.each([
    ['name', { name: '', path: '~/p', match: { 'path-prefix': '~/x' } }],
    ['path', { name: 'p', path: '   ', match: { 'path-prefix': '~/x' } }],
    ['match path-prefix', { name: 'p', path: '~/p', match: { 'path-prefix': '' } }],
  ])('drops an entry with an empty-string %s and emits WARN', (_label, entry) => {
    const config = { baselines: [entry] };
    const lines = captureStderr(() => {
      const result = parseBaselines(config);
      expect(result).toHaveLength(0);
    });
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// matchBaselineForPath
// ---------------------------------------------------------------------------

describe('matchBaselineForPath', () => {
  const baselines = [
    { name: 'private', path: '/base/private', match: { 'path-prefix': '/home/x/Projects/private-world' } },
    { name: 'aiat', path: '/base/aiat', match: { 'path-prefix': '/home/x/Projects/intern' } },
  ];

  it('matches when the path is a child of a prefix directory tree', () => {
    const result = matchBaselineForPath('/home/x/Projects/private-world/repo-a', baselines);
    expect(result).not.toBeNull();
    expect(result.name).toBe('private');
    expect(result.path).toBe('/base/private');
  });

  it('matches when the path equals the prefix exactly', () => {
    const result = matchBaselineForPath('/home/x/Projects/private-world', baselines);
    expect(result).not.toBeNull();
    expect(result.name).toBe('private');
  });

  it('selects the correct entry among multiple prefixes', () => {
    const result = matchBaselineForPath('/home/x/Projects/intern/foo', baselines);
    expect(result.name).toBe('aiat');
  });

  it('does NOT match a sibling directory that merely shares a name prefix', () => {
    // /home/x/Projects/private-world-archive must NOT match prefix /home/x/Projects/private-world
    const result = matchBaselineForPath('/home/x/Projects/private-world-archive/foo', baselines);
    expect(result).toBeNull();
  });

  it('returns null when no baseline matches the path', () => {
    expect(matchBaselineForPath('/home/x/Projects/other/repo', baselines)).toBeNull();
  });

  it('returns null for an empty path', () => {
    expect(matchBaselineForPath('', baselines)).toBeNull();
  });

  it('returns null when the baselines array is empty', () => {
    expect(matchBaselineForPath('/home/x/Projects/private-world/foo', [])).toBeNull();
  });

  it('normalizes "." path segments before comparison', () => {
    const result = matchBaselineForPath('/home/x/Projects/private-world/./repo-a', baselines);
    expect(result.name).toBe('private');
  });

  it('WARNs and returns the first match when multiple prefixes match (ambiguity)', () => {
    const ambiguous = [
      { name: 'outer', path: '/base/outer', match: { 'path-prefix': '/home/x/Projects' } },
      { name: 'inner', path: '/base/inner', match: { 'path-prefix': '/home/x/Projects/private-world' } },
    ];
    const lines = captureStderr(() => {
      const result = matchBaselineForPath('/home/x/Projects/private-world/foo', ambiguous);
      expect(result.name).toBe('outer'); // first-match-wins
    });
    expect(lines.some((l) => l.includes('WARN') && l.includes('multiple baselines match'))).toBe(true);
  });

  // MED-2: documented limitations — _normalizePath only expands tilde + strips
  // a trailing separator. It does NOT resolve relative-vs-absolute or fold case,
  // so these shapes silently never match rather than erroring.
  it('a relative path-prefix silently never matches an absolute cwd (documented limitation)', () => {
    const result = matchBaselineForPath('/home/x/Projects/pw/repo', [
      { name: 'r', path: '/b', match: { 'path-prefix': 'Projects/pw' } },
    ]);
    expect(result).toBeNull();
  });

  it('prefix comparison is case-sensitive even though macOS FS is not (documented limitation)', () => {
    const result = matchBaselineForPath('/home/x/Projects/pw/repo', [
      { name: 'r', path: '/b', match: { 'path-prefix': '/home/x/projects/pw' } },
    ]);
    expect(result).toBeNull();
  });

  // LOW batch: a trailing slash on the configured prefix still matches, because
  // _normalizePath strips a trailing separator from both sides before comparing.
  it('a trailing slash on path-prefix still matches after the _normalizePath strip', () => {
    const result = matchBaselineForPath('/home/x/Projects/pw/repo', [
      { name: 'r', path: '/b', match: { 'path-prefix': '/home/x/Projects/pw/' } },
    ]);
    expect(result).not.toBeNull();
    expect(result.name).toBe('r');
  });
});

// ---------------------------------------------------------------------------
// resolveNamedBaseline — AC1
// ---------------------------------------------------------------------------

describe('resolveNamedBaseline — AC1: per-context directory match', () => {
  // Use real homedir()-anchored paths so tilde expansion round-trips identically
  // on either side of the comparison (deterministic, host-independent).
  const ownerConfig = {
    baselines: [
      {
        name: 'private',
        path: '~/Projects/private-world/projects-baseline',
        match: { 'path-prefix': '~/Projects/private-world' },
      },
      {
        name: 'aiat',
        path: '~/Projects/intern/projects-baseline',
        match: { 'path-prefix': '~/Projects/intern' },
      },
    ],
  };

  it('cwd under ~/Projects/private-world resolves to the private baseline (source "match")', () => {
    const cwd = join(homedir(), 'Projects', 'private-world', 'repo-a');
    const result = resolveNamedBaseline({ cwd, ownerConfig, env: {} });
    expect(result.source).toBe('match');
    expect(result.name).toBe('private');
    expect(result.path).toBe('~/Projects/private-world/projects-baseline');
  });

  it('cwd under ~/Projects/intern resolves to the aiat baseline (source "match")', () => {
    const cwd = join(homedir(), 'Projects', 'intern', 'foo');
    const result = resolveNamedBaseline({ cwd, ownerConfig, env: {} });
    expect(result.source).toBe('match');
    expect(result.name).toBe('aiat');
    expect(result.path).toBe('~/Projects/intern/projects-baseline');
  });

  it('SO_BASELINE_PATH env yields the null-fallback so the caller env tier wins', () => {
    const cwd = join(homedir(), 'Projects', 'private-world', 'repo-a');
    const result = resolveNamedBaseline({
      cwd,
      ownerConfig,
      env: { SO_BASELINE_PATH: '/env/override/baseline' },
    });
    // The resolver does NOT report a match — it yields to the higher env tier.
    expect(result.source).toBeNull();
    expect(result.path).toBeNull();
  });

  // MED-1: the env-yield guard is `envVal.trim() !== ''` — a whitespace-only
  // SO_BASELINE_PATH does NOT trip it, so the match tier still wins.
  it('whitespace-only SO_BASELINE_PATH does NOT trigger the env-yield (trim-guard)', () => {
    const cwd = join(homedir(), 'Projects', 'private-world', 'repo-a');
    const result = resolveNamedBaseline({ cwd, ownerConfig, env: { SO_BASELINE_PATH: '   ' } });
    expect(result.source).toBe('match');
    expect(result.name).toBe('private');
  });
});

// ---------------------------------------------------------------------------
// resolveNamedBaseline — AC2 + fallback
// ---------------------------------------------------------------------------

describe('resolveNamedBaseline — AC2: malformed/missing baselines never throw', () => {
  it('returns the null-fallback when baselines are absent', () => {
    const result = resolveNamedBaseline({ cwd: '/anywhere', ownerConfig: undefined, env: {} });
    expect(result).toEqual({ path: null, name: null, source: null });
  });

  it('never throws and WARNs on a malformed baselines section, returning null-fallback', () => {
    const ownerConfig = { baselines: [{ path: '~/p', match: { 'path-prefix': '~/x' } }] }; // missing name
    let result;
    const lines = captureStderr(() => {
      expect(() =>
        (result = resolveNamedBaseline({ cwd: '/home/x/Projects/private-world', ownerConfig, env: {} })),
      ).not.toThrow();
    });
    expect(result.source).toBeNull();
    expect(result.path).toBeNull();
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('never throws when baselines: is not an array', () => {
    let result;
    const lines = captureStderr(() => {
      expect(() =>
        (result = resolveNamedBaseline({ cwd: '/anywhere', ownerConfig: { baselines: 'oops' }, env: {} })),
      ).not.toThrow();
    });
    expect(result.source).toBeNull();
    expect(lines.some((l) => l.includes('WARN'))).toBe(true);
  });

  it('returns the null-fallback when baselines are configured but nothing matches cwd', () => {
    const ownerConfig = {
      baselines: [{ name: 'private', path: '~/p', match: { 'path-prefix': '/home/x/Projects/private-world' } }],
    };
    const result = resolveNamedBaseline({ cwd: '/home/x/Projects/other/repo', ownerConfig, env: {} });
    expect(result.source).toBeNull();
    expect(result.path).toBeNull();
  });
});
