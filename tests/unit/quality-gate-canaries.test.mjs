/**
 * Canary tests that guard against silent regressions in our quality-gate scaffolding.
 *
 * Surfaced by W4-Q3 (qa-strategist) audit of the 2026-05-18 deep-1 session:
 *  - HIGH-2: typecheck.mjs was just made recursive (72 → 187 files). Without a floor
 *           assertion, a future revert to non-recursive walker would silently re-emit
 *           "typecheck: N file(s) OK" with N collapsed to ~30-70 and no test would notice.
 *  - HIGH-3: .nvmrc and .github/workflows/test.yml currently both pin Node 24. A bump
 *           to either side without the other would silently leave CI on a stale runtime
 *           or break local pnpm-install. The pair must stay in lockstep.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('typecheck.mjs — recursive walker (HIGH-2 regression guard)', () => {
  it('contains a recursive walker that descends into subdirectories', () => {
    // Static contract check: the typecheck script must contain a recursive directory
    // walker. A future revert to a flat readdirSync would silently drop subdirectory
    // coverage (72 vs 187 files in this repo at #452 fold-in time). Static-string
    // analysis avoids spawning the 187 child processes that the live run requires.
    const source = readFileSync('scripts/typecheck.mjs', 'utf8');
    expect(source, 'typecheck.mjs must define a directory walker function').toMatch(
      /function\s+walk\w*\(/,
    );
    expect(source, 'walker must recurse — call itself or check isDirectory').toMatch(
      /isDirectory\(\)/,
    );
  });

  it('would discover at least 100 .mjs files under scripts/lib and hooks', () => {
    // Independent walk to verify our codebase actually has subdirectory .mjs files
    // the recursive walker needs to find. Floor 100 catches the silent regression
    // to non-recursive (would drop to ~30-70). Ceiling 1000 catches accidental
    // over-broad walking (e.g., if someone added node_modules to ROOTS).
    function countMjs(dir) {
      let n = 0;
      let entries;
      try {
        entries = readdirSync(dir);
      } catch {
        return 0;
      }
      for (const name of entries) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) {
          n += countMjs(p);
        } else if (name.endsWith('.mjs') && st.isFile()) {
          n += 1;
        }
      }
      return n;
    }
    const count = countMjs('scripts/lib') + countMjs('hooks');
    expect(count).toBeGreaterThanOrEqual(100);
    expect(count).toBeLessThanOrEqual(1000);
  });
});

describe('.nvmrc ↔ workflow Node version lockstep (HIGH-3 regression guard)', () => {
  it('.nvmrc Node version matches all node-version pins in .github/workflows/test.yml', () => {
    const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
    expect(nvmrc, '.nvmrc must declare a single Node major version').toMatch(/^\d+$/);

    const workflow = readFileSync('.github/workflows/test.yml', 'utf8');
    const versionPins = [...workflow.matchAll(/node-version:\s*['"]?([^'"\s]+)['"]?/g)].map(
      (m) => m[1],
    );
    expect(
      versionPins.length,
      'workflow must declare at least one node-version pin',
    ).toBeGreaterThanOrEqual(1);
    for (const pin of versionPins) {
      expect(
        pin,
        `workflow node-version=${pin} drifted from .nvmrc=${nvmrc}; bump both in lockstep`,
      ).toBe(nvmrc);
    }
  });

  it('package.json engines.node references the same Node major as .nvmrc', () => {
    const nvmrc = readFileSync('.nvmrc', 'utf8').trim();
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const enginesNode = pkg.engines?.node ?? '';
    expect(enginesNode, 'package.json must declare engines.node').toMatch(/\d+/);
    const engineMajor = enginesNode.match(/(\d+)/)?.[1];
    expect(
      engineMajor,
      `package.json engines.node=${enginesNode} must reference Node ${nvmrc} (matches .nvmrc)`,
    ).toBe(nvmrc);
  });
});
