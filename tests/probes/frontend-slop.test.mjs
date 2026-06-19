/**
 * tests/probes/frontend-slop.test.mjs
 *
 * Integration test for the frontend-slop discovery probe against a real temp
 * repo tree (planted slop + clean files + skip-dir noise).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import frontendSlop from '../../skills/discovery/probes/frontend-slop.mjs';

let repoRoot;

beforeAll(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'frontend-slop-'));

  // The detector lives in the real repo, not the temp dir. The probe imports it
  // from `${repoRoot}/scripts/lib/frontend-detect/detect.mjs`, so symlinking the
  // real scripts dir would couple the test to layout. Instead we copy the two
  // detector modules into the temp repo so the defensive import resolves.
  mkdirSync(join(repoRoot, 'scripts', 'lib', 'frontend-detect'), { recursive: true });
});

afterAll(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

// We re-point the probe at the REAL detector by writing tiny re-export shims in
// the temp repo that import from the actual source via absolute path.
function installDetectorShim(root) {
  const realDetect = join(process.cwd(), 'scripts', 'lib', 'frontend-detect', 'detect.mjs');
  writeFileSync(
    join(root, 'scripts', 'lib', 'frontend-detect', 'detect.mjs'),
    `export * from ${JSON.stringify(realDetect)};\n`,
  );
}

describe('frontend-slop probe', () => {
  it('flags planted slop and skips clean files', async () => {
    installDetectorShim(repoRoot);

    // Planted slop
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'src', 'hero.css'),
      `.hero { background: linear-gradient(135deg, #8b5cf6, #3b82f6); }
       .alert { border-left: 4px solid #f59e0b; }
       body { font-family: Inter, sans-serif; color: #000; }`,
    );
    // Clean file
    writeFileSync(
      join(repoRoot, 'src', 'clean.css'),
      `body { color: oklch(22% 0.02 260); font-family: "Söhne", serif; }`,
    );
    // Skip-dir noise that must NOT be scanned
    mkdirSync(join(repoRoot, 'node_modules', 'junk'), { recursive: true });
    writeFileSync(join(repoRoot, 'node_modules', 'junk', 'bad.css'), `a { border-left: 8px solid red; }`);

    const result = await frontendSlop({ repoRoot });

    expect(result.probe).toBe('frontend-slop');
    expect(result.summary.total).toBeGreaterThanOrEqual(4); // gradient, side-stripe, font, black
    expect(result.summary.filesScanned).toBe(2); // hero.css + clean.css, NOT node_modules

    const rules = new Set(result.findings.map((f) => f.evidence.rule));
    expect(rules).toContain('ai-purple-gradient');
    expect(rules).toContain('side-stripe-border');
    expect(rules).toContain('overused-font');

    // node_modules slop must not appear
    const files = result.findings.map((f) => f.evidence.file);
    expect(files.every((f) => !f.includes('node_modules'))).toBe(true);
  });

  it('returns an empty result for a repo with no frontend files', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'frontend-slop-empty-'));
    mkdirSync(join(empty, 'scripts', 'lib', 'frontend-detect'), { recursive: true });
    installDetectorShim(empty);
    writeFileSync(join(empty, 'README.md'), '# nothing to scan here');

    const result = await frontendSlop({ repoRoot: empty });
    expect(result.summary.total).toBe(0);
    expect(result.findings).toHaveLength(0);

    rmSync(empty, { recursive: true, force: true });
  });

  it('emits a defensive finding when the detector module is absent', async () => {
    const noDetector = mkdtempSync(join(tmpdir(), 'frontend-slop-nodet-'));
    const result = await frontendSlop({ repoRoot: noDetector });
    expect(result.findings).toHaveLength(1);
    expect(result.summary.skipped_reason).toBe('detector-unavailable');
    rmSync(noDetector, { recursive: true, force: true });
  });
});
