/**
 * tests/lib/config/cycle-guard.test.mjs
 *
 * Invariant guard: no *.mjs file under scripts/lib/config/ may import from
 * '../config.mjs' (the parent orchestrator module). Doing so reforms the import
 * cycle that issue #664 broke by moving readConfigFile into config/io.mjs.
 *
 * Sub-parsers that need readConfigFile MUST import it from './io.mjs' directly.
 * Orchestrator-level callers (scripts/lib/config.mjs consumers) may keep using
 * the re-export on config.mjs — that re-export is for EXTERNAL callers only.
 *
 * Pure static read — no module imports required. Expected values are hardcoded
 * literals (testing.md anti-pattern #3 avoided).
 */

import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const CONFIG_DIR = path.resolve(
  import.meta.dirname,
  '../../../scripts/lib/config',
);

// Pattern that would re-form the cycle: any import from the parent config.mjs.
// Matches bare '../config.mjs', '../config', and variations with single or
// double quotes. Does NOT match './config/...' (sub-paths are fine).
const CYCLE_PATTERN = /from\s+['"]\.\.\/config(?:\.mjs)?['"]/;

describe('config sub-parser cycle guard (#664)', () => {
  it('no *.mjs file under scripts/lib/config/ imports from ../config.mjs', async () => {
    const entries = await fs.readdir(CONFIG_DIR);
    const mjsFiles = entries.filter((f) => f.endsWith('.mjs'));

    // Collect violations for a clear failure message
    const violations = [];

    for (const file of mjsFiles) {
      const filePath = path.join(CONFIG_DIR, file);
      const content = await fs.readFile(filePath, 'utf8');
      if (CYCLE_PATTERN.test(content)) {
        violations.push(file);
      }
    }

    // Hardcoded expected: zero violations
    expect(violations).toEqual([]);
  });

  it('the config sub-parser directory contains at least 10 files (floor guard — catches accidental mass-deletion)', async () => {
    const entries = await fs.readdir(CONFIG_DIR);
    const mjsFiles = entries.filter((f) => f.endsWith('.mjs'));
    // Floor: enough to be meaningful; ceiling large enough not to block growth
    expect(mjsFiles.length).toBeGreaterThanOrEqual(10);
    expect(mjsFiles.length).toBeLessThanOrEqual(200);
  });
});
