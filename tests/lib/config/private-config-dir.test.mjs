// Tests for scripts/lib/config/private-config-dir.mjs (#1223).
//
// Two contracts, and the second is the one a future edit is likely to break:
//   1. Precedence SO_CONFIG_HOME (the dir itself) > XDG_CONFIG_HOME (its parent)
//      > ~/.config/session-orchestrator, each `.trim()`ed so a whitespace-only
//      value falls THROUGH instead of short-circuiting the `||`.
//   2. The module is a ZERO-IMPORT leaf: `node:os` + `node:path` only. Anything
//      else on its import graph reaches `host-identity.mjs` -> `session-lock.mjs`
//      -> live hooks, where a bare specifier breaks the GH#63 "degrade without
//      node_modules" contract (that is exactly how `js-yaml` got there).

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { resolvePrivateConfigDir } from '../../../scripts/lib/config/private-config-dir.mjs';

const MODULE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/config/private-config-dir.mjs',
);

describe('resolvePrivateConfigDir — precedence (#1223)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honours SO_CONFIG_HOME as the private dir ITSELF (no session-orchestrator segment appended)', () => {
    vi.stubEnv('SO_CONFIG_HOME', '/so/dir');
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg');
    expect(resolvePrivateConfigDir()).toBe('/so/dir');
  });

  it('appends session-orchestrator to XDG_CONFIG_HOME (its PARENT)', () => {
    vi.stubEnv('SO_CONFIG_HOME', '');
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg');
    expect(resolvePrivateConfigDir()).toBe(join('/xdg', 'session-orchestrator'));
  });

  it('falls back to ~/.config/session-orchestrator when neither override is set', () => {
    vi.stubEnv('SO_CONFIG_HOME', '');
    vi.stubEnv('XDG_CONFIG_HOME', '');
    expect(resolvePrivateConfigDir()).toBe(join(homedir(), '.config', 'session-orchestrator'));
  });

  it('falls THROUGH a whitespace-only SO_CONFIG_HOME to XDG_CONFIG_HOME', () => {
    vi.stubEnv('SO_CONFIG_HOME', '   ');
    vi.stubEnv('XDG_CONFIG_HOME', '/xdg');
    expect(resolvePrivateConfigDir()).toBe(join('/xdg', 'session-orchestrator'));
  });

  it('falls THROUGH a whitespace-only XDG_CONFIG_HOME to the homedir default', () => {
    vi.stubEnv('SO_CONFIG_HOME', '');
    vi.stubEnv('XDG_CONFIG_HOME', '  \t ');
    expect(resolvePrivateConfigDir()).toBe(join(homedir(), '.config', 'session-orchestrator'));
  });

  it('accepts an injected env object instead of process.env', () => {
    vi.stubEnv('SO_CONFIG_HOME', '/from-process-env');
    expect(resolvePrivateConfigDir({ env: { XDG_CONFIG_HOME: '/injected' } })).toBe(
      join('/injected', 'session-orchestrator'),
    );
  });

  it('reads env at CALL time, so a stub applied after import still takes effect', () => {
    vi.stubEnv('SO_CONFIG_HOME', '/late-stub');
    expect(resolvePrivateConfigDir()).toBe('/late-stub');
  });
});

/**
 * Every module specifier `source` pulls in — static `import … from`, re-export
 * `export … from`, and dynamic `import('…')`.
 *
 * TV-001, the bug this shape exists for: the previous regex was
 * `/^\s*import[^'"]*['"]…/gm`, which sees only the first form. Measured
 * 2026-09-05: `export { x } from 'js-yaml'` and `await import('zx')` both slipped
 * through, so the leaf could have grown a bare dependency with the guard green.
 *
 * @param {string} source
 * @returns {string[]} specifiers, unsorted, with duplicates
 */
function moduleSpecifiers(source) {
  // Comments first: this file's own doc block quotes `'js-yaml'` in prose, and an
  // apostrophe-free run from any preceding `import` word would otherwise capture
  // it as a specifier (measured — the guard went red on its own documentation).
  const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const specs = [];
  const patterns = [
    /(?:^|[\s;}])(?:import|export)[^'"]*?['"]([^'"]+)['"]/g, // import/export … from 'x'; bare import 'x'
    /import\s*\(\s*['"]([^'"]+)['"]/g, // dynamic import('x')
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

describe('resolvePrivateConfigDir — zero-import leaf (hook-graph contract)', () => {
  it('imports node:os and node:path ONLY — no repo-local and no bare specifiers', () => {
    const src = readFileSync(MODULE_PATH, 'utf8');
    expect([...new Set(moduleSpecifiers(src))].sort()).toEqual(['node:os', 'node:path']);
  });

  it('the detector sees all three import forms (guard-blindness pin)', () => {
    const fixture = [
      "import { a } from 'node:os';",
      "export { b } from './sibling.mjs';",
      "const { $ } = await import('zx');",
    ].join('\n');
    expect([...new Set(moduleSpecifiers(fixture))].sort()).toEqual([
      './sibling.mjs',
      'node:os',
      'zx',
    ]);
  });
});
