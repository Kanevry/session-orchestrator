/**
 * tests/unit/category8-mcp-edge-cases.test.mjs
 *
 * Issue #479 MED — c8.3 malformed .mcp.json + empty mcpServers + c8.1 depth-5 boundary.
 *
 * Gaps from the qa-strategist audit:
 *   c8.3:
 *     - malformed .mcp.json (invalid JSON) → c8.3 behaviour unpinned
 *     - .mcp.json with mcpServers: {} (empty object) → c8.3 behaviour unpinned
 *     - .mcp.json with mcpServers field absent → c8.3 behaviour unpinned
 *   c8.1:
 *     - depth-4 nested CLAUDE.md → pass (at the limit; previously uncovered boundary)
 *     - depth-5 nested CLAUDE.md → must NOT be found (impl enforces depth ≤4; uncovered)
 *
 * Implementation details (from category8.mjs):
 *   c8.3: safeJson(safeRead('.mcp.json')) returns null on parse failure.
 *         When mcpJson is null OR mcpJson.mcpServers is absent/non-object,
 *         mcpMatch stays false and the check falls through to the doc-fallback path.
 *         If no doc references "language server" or "LSP", the check fails.
 *   c8.1: walk() guards with `if (depth > NESTED_SCAN_MAX_DEPTH) return` where
 *         NESTED_SCAN_MAX_DEPTH = 4. Depth 4 = file at root/a/b/c/d/CLAUDE.md
 *         (4 path parts); depth 5 = root/a/b/c/d/e/CLAUDE.md → blocked.
 *
 * Falsification check:
 *   c8.3 malformed: if safeJson silently returned {} instead of null, the check
 *     would erroneously pass doc-fallback checks. This test pins the null-returns-fail
 *     contract. ✓
 *   c8.3 empty: if the loop iterated a non-existent key and set mcpMatch=true,
 *     this test would catch it by expecting fail. ✓
 *   c8.1 depth-5: if NESTED_SCAN_MAX_DEPTH were changed to 5, the depth-5 fixture
 *     would be found and the c8.1 fail assertion would break. ✓
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

import { runCategory8 } from '@lib/harness-audit/categories/category8.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  // realpathSync resolves macOS /var → /private/var symlink (learning conf 0.85)
  return realpathSync(mkdtempSync(join(tmpdir(), 'cat8-mcp-')));
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

// ---------------------------------------------------------------------------
// Suite 1: c8.3 — .mcp.json edge cases
// ---------------------------------------------------------------------------

describe('c8.3 lsp-configured — .mcp.json edge cases', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
    // Write root CLAUDE.md for tests that only care about c8.3
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('c8.3 fail(0): malformed .mcp.json (invalid JSON) does not silently pass', () => {
    // safeJson() returns null for invalid JSON.
    // null mcpJson → mcpMatch stays false → falls through to doc-fallback.
    // No doc references LSP → fail.
    writeFileSync(join(root, '.mcp.json'), '{ "mcpServers": { broken json ');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.mcpConfigured).toBe(false);
    expect(c.evidence.docFallback).toBe(false);
  });

  it('c8.3 fail(0): .mcp.json with mcpServers: {} (empty object) earns 0 points', () => {
    // Empty mcpServers: Object.entries({}) = [] → loop body never executes → mcpMatch = false.
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: {} }),
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.mcpConfigured).toBe(false);
  });

  it('c8.3 fail(0): .mcp.json with no mcpServers field earns 0 points', () => {
    // mcpJson exists but mcpJson.mcpServers is undefined → falsy → loop skipped.
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ tools: {}, version: '1' }),
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.mcpConfigured).toBe(false);
    expect(c.message).toContain('no LSP MCP server');
  });
});

// ---------------------------------------------------------------------------
// Suite 2: c8.1 — depth boundary tests
// ---------------------------------------------------------------------------

describe('c8.1 layered-claude-md — nesting depth boundary', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('c8.1 pass: CLAUDE.md at depth-4 (root/a/b/c/d/CLAUDE.md) IS found', () => {
    // Depth boundary: NESTED_SCAN_MAX_DEPTH = 4.
    // walk(depth) fires when > 4; depth 4 still executes.
    // Path a/b/c/d has 4 parts → depth 4 when listing d's entries → found.
    ensureDir(join(root, 'a', 'b', 'c', 'd'));
    writeFileSync(
      join(root, 'a', 'b', 'c', 'd', 'CLAUDE.md'),
      '# Deep Nested\n\n## Testing\n\ntest-command: npm test\n',
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'layered-claude-md');

    expect(c.status).toBe('pass');
    expect(c.evidence.nestedFiles).toContain('a/b/c/d/CLAUDE.md');
  });

  it('c8.1 fail: CLAUDE.md at depth-5 (root/a/b/c/d/e/CLAUDE.md) is NOT found', () => {
    // Depth 5 > NESTED_SCAN_MAX_DEPTH (4) → walk returns before reading e's entries.
    // The CLAUDE.md at depth 5 must be invisible to c8.1.
    // This is the critical boundary: depth-4 is found, depth-5 is not.
    ensureDir(join(root, 'a', 'b', 'c', 'd', 'e'));
    writeFileSync(
      join(root, 'a', 'b', 'c', 'd', 'e', 'CLAUDE.md'),
      '# Too Deep\n\n## Testing\n\ntest-command: npm test\n',
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'layered-claude-md');

    // No nested instruction files found at depth ≤ 4 → fail
    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.nestedFiles).toHaveLength(0);
    expect(c.message).toContain('no nested CLAUDE.md');
  });
});
