/**
 * tests/lib/validate/check-peekaboo-driver-canary.test.mjs
 *
 * Tests for scripts/lib/validate/check-peekaboo-driver-canary.mjs.
 *
 * The canary is a CLI script (not an importable module), so tests exercise it
 * via spawnSync and by reading the source to verify structural contracts.
 *
 * Coverage:
 *   - Canary file exists
 *   - Exits 0 when invoked against a clean plugin root (skills/peekaboo-driver
 *     and scripts/lib/test-runner contain no bare "peekaboo-mcp" references)
 *   - Exits 0 when a scan root does not exist (graceful absent handling)
 *   - Exits 1 when a scanned file contains a bare "peekaboo-mcp" reference
 *   - HARD-GATE-marked lines are skipped (no false positives)
 *   - Non-scanned file extensions (.yaml) are not processed
 *   - Output contains "peekaboo" or "peekaboo-mcp" in the check header
 *   - Output reports "passed" count when clean
 *
 * Violation-path DI approach: we create a temporary directory tree with known
 * content using node:fs and node:os, then point the canary at that tmpdir.
 * No vi.mock needed — the canary script reads from disk, so injecting fake files
 * is the correct DI vector for this CLI.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const CANARY_PATH = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-peekaboo-driver-canary.mjs');

// ---------------------------------------------------------------------------
// Helper: run the canary synchronously
// ---------------------------------------------------------------------------

function runCanary(pluginRoot) {
  return spawnSync('node', [CANARY_PATH, pluginRoot], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

// ---------------------------------------------------------------------------
// Helper: build a minimal fake plugin root in tmpdir
// ---------------------------------------------------------------------------

function makeTmpRoot(setupFn) {
  const tmpRoot = mkdtempSync(join(os.tmpdir(), 'canary-peekaboo-'));
  setupFn(tmpRoot);
  return tmpRoot;
}

// ---------------------------------------------------------------------------
// Test 1: canary file exists
// ---------------------------------------------------------------------------

describe('check-peekaboo-driver-canary.mjs', () => {
  it('exists at scripts/lib/validate/check-peekaboo-driver-canary.mjs', () => {
    expect(existsSync(CANARY_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 2: exits 0 against the real plugin root (production clean state)
// ---------------------------------------------------------------------------

describe('canary against real plugin root', () => {
  it('exits 0 when run against the actual repo (no peekaboo-mcp violations)', () => {
    const result = runCanary(REPO_ROOT);
    expect(result.status).toBe(0);
  });

  it('stdout contains "peekaboo" in the check header when run against real repo', () => {
    const result = runCanary(REPO_ROOT);
    expect(result.stdout.toLowerCase()).toContain('peekaboo');
  });
});

// ---------------------------------------------------------------------------
// Test 3: exits 0 when scan roots are absent in tmpdir
// ---------------------------------------------------------------------------

describe('canary with absent scan roots', () => {
  it('exits 0 when neither skills/peekaboo-driver nor scripts/lib/test-runner exist', () => {
    const tmpRoot = makeTmpRoot(() => {/* empty dir */});
    const result = runCanary(tmpRoot);
    expect(result.status).toBe(0);
  });

  it('stdout contains "does not exist yet" message for each missing root', () => {
    const tmpRoot = makeTmpRoot(() => {});
    const result = runCanary(tmpRoot);
    expect(result.stdout).toContain('does not exist yet');
  });
});

// ---------------------------------------------------------------------------
// Test 4: exits 1 + FAIL line when a bare peekaboo-mcp reference appears
// ---------------------------------------------------------------------------

describe('canary violation detection', () => {
  it('exits 1 when skills/peekaboo-driver/ contains a bare "peekaboo-mcp" reference', () => {
    const tmpRoot = makeTmpRoot((root) => {
      mkdirSync(join(root, 'skills', 'peekaboo-driver'), { recursive: true });
      writeFileSync(
        join(root, 'skills', 'peekaboo-driver', 'bad.md'),
        '# test\nUse peekaboo-mcp for transport layer integration.\n',
      );
    });
    const result = runCanary(tmpRoot);
    expect(result.status).toBe(1);
  });

  it('stdout contains "FAIL:" when a violation is detected', () => {
    const tmpRoot = makeTmpRoot((root) => {
      mkdirSync(join(root, 'skills', 'peekaboo-driver'), { recursive: true });
      writeFileSync(
        join(root, 'skills', 'peekaboo-driver', 'bad.md'),
        'peekaboo-mcp adapter installed\n',
      );
    });
    const result = runCanary(tmpRoot);
    expect(result.stdout).toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Test 5: HARD-GATE lines are exempt (no false positives)
// ---------------------------------------------------------------------------

describe('canary documentation marker exemption', () => {
  it('exits 0 when a line contains both "peekaboo-mcp" and "HARD-GATE"', () => {
    const tmpRoot = makeTmpRoot((root) => {
      mkdirSync(join(root, 'skills', 'peekaboo-driver'), { recursive: true });
      writeFileSync(
        join(root, 'skills', 'peekaboo-driver', 'ok.md'),
        '<!-- HARD-GATE: do not use peekaboo-mcp here -->\n',
      );
    });
    const result = runCanary(tmpRoot);
    expect(result.status).toBe(0);
  });

  it('exits 0 when a line contains both "peekaboo-mcp" and "check-peekaboo-driver-canary"', () => {
    const tmpRoot = makeTmpRoot((root) => {
      mkdirSync(join(root, 'skills', 'peekaboo-driver'), { recursive: true });
      writeFileSync(
        join(root, 'skills', 'peekaboo-driver', 'ok.md'),
        '# check-peekaboo-driver-canary exemption for peekaboo-mcp\n',
      );
    });
    const result = runCanary(tmpRoot);
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 6: non-scanned extensions are ignored
// ---------------------------------------------------------------------------

describe('canary file extension filtering', () => {
  it('exits 0 when only a .yaml file contains peekaboo-mcp (not scanned)', () => {
    const tmpRoot = makeTmpRoot((root) => {
      mkdirSync(join(root, 'skills', 'peekaboo-driver'), { recursive: true });
      writeFileSync(
        join(root, 'skills', 'peekaboo-driver', 'config.yaml'),
        'adapter: peekaboo-mcp\n',
      );
    });
    const result = runCanary(tmpRoot);
    expect(result.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 7: stdout reports passed count
// ---------------------------------------------------------------------------

describe('canary output format', () => {
  it('stdout contains "passed" in the results summary line when clean', () => {
    const tmpRoot = makeTmpRoot(() => {});
    const result = runCanary(tmpRoot);
    expect(result.stdout).toContain('passed');
  });
});
