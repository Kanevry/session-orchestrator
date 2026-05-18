/**
 * tests/lib/harness-audit/categories/category8.test.mjs
 *
 * Vitest suite for scripts/lib/harness-audit/categories/category8.mjs
 *
 * Category 8: Large-Codebase Readiness — checks layered-claude-md,
 * codebase-map-present, lsp-configured, scoped-test-lint,
 * permissions-deny-present, lean-root.
 *
 * status field is only 'pass'/'fail' — partial tiers use reduced-points pass().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runCategory8 } from '@lib/harness-audit/categories/category8.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'cat8-'));
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/** Write a nested CLAUDE.md with a heading and a convention/test/lint marker. */
function writeNestedClaudeMd(root, rel, content) {
  const parts = rel.split('/');
  ensureDir(join(root, ...parts.slice(0, -1)));
  writeFileSync(join(root, rel), content);
}

/** Scaffold a fully-passing category 8 run. */
function scaffoldHappyPath(root) {
  // c8.1 + c8.4: nested CLAUDE.md with structural marker and scoped test/lint
  writeNestedClaudeMd(
    root,
    'skills/session-start/CLAUDE.md',
    '# session-start — Local Conventions\n\n## Testing\n\nLocal test command: `npm run test:session-start`\n\n## Lint\n\nLocal lint: `npm run lint`\n\n## Conventions\n\nPhase order is fixed; do not reorder.\n',
  );

  // c8.2: codebase-map with ≥10 lines
  ensureDir(join(root, '.orchestrator/steering'));
  writeFileSync(
    join(root, '.orchestrator/steering/structure.md'),
    '# Structure\n\n## Top-Level Directory Map\n\n| Path | Purpose |\n|---|---|\n| skills/ | skills |\n| scripts/ | automation |\n| .orchestrator/ | runtime |\n\n## Inventory\n\n- Skills: 1\n- Commands: 1\n- Agents: 1\n',
  );

  // c8.3: .mcp.json with serena LSP server
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { serena: { command: 'serena', args: ['start', '--lsp'] } } }, null, 2),
  );

  // c8.5: .claude/settings.json with non-empty deny array
  ensureDir(join(root, '.claude'));
  writeFileSync(
    join(root, '.claude/settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm -rf /)', 'Bash(git push --force)'] } }, null, 2),
  );

  // c8.6: root CLAUDE.md with delegation link and no section >60 lines
  writeFileSync(
    join(root, 'CLAUDE.md'),
    '# Root\n\n> See [README.md](./README.md) and `.orchestrator/steering/structure.md` for the codebase map.\n\n## Session Config\n\npersistence: true\n',
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('runCategory8', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Happy path — all 6 checks pass
  // -------------------------------------------------------------------------
  it('returns 6 passing checks totalling 10 points for a fully-configured repo', () => {
    scaffoldHappyPath(root);

    const checks = runCategory8(root);

    expect(checks).toHaveLength(6);
    expect(checks.every((c) => c.status === 'pass')).toBe(true);
    expect(checks.map((c) => c.check_id)).toEqual([
      'layered-claude-md',
      'codebase-map-present',
      'lsp-configured',
      'scoped-test-lint',
      'permissions-deny-present',
      'lean-root',
    ]);
    const total = checks.reduce((s, c) => s + c.points, 0);
    expect(total).toBe(10);
  });

  // =========================================================================
  // c8.1 layered-claude-md (max 2)
  // =========================================================================

  it('c8.1 pass(2): nested CLAUDE.md with a ## heading and convention marker earns 2 points', () => {
    scaffoldHappyPath(root);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'layered-claude-md');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
    expect(c.evidence.withMarker).toBe(true);
    expect(c.evidence.nestedFiles).toHaveLength(1);
  });

  it('c8.1 pass(1): nested CLAUDE.md with no structural/convention marker earns 1 point', () => {
    // nested file present but no '## ' heading, no convention/test/lint keyword
    writeNestedClaudeMd(root, 'skills/my-skill/CLAUDE.md', '# Info\n\nSome plain text with no headings.\n');
    // c8.2, c8.5, c8.6 — minimal to avoid unrelated failures
    ensureDir(join(root, '.orchestrator/steering'));
    writeFileSync(join(root, '.orchestrator/steering/structure.md'), '# Structure\n\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\n');
    ensureDir(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { serena: { command: 'serena', args: [] } } }));
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n> See [README.md](./README.md) for the codebase map.\n\n## Section\n\nshort\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'layered-claude-md');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.withMarker).toBe(false);
    expect(c.evidence.nestedFiles.length).toBeGreaterThan(0);
  });

  it('c8.1 fail(0): no nested CLAUDE.md or AGENTS.md at all earns 0 points', () => {
    // No nested instruction files — only root CLAUDE.md
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n> See [README.md](./README.md).\n');
    ensureDir(join(root, '.orchestrator/steering'));
    writeFileSync(join(root, '.orchestrator/steering/structure.md'), '# Codebase Map\n\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\n');
    ensureDir(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }));
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { serena: { command: 'serena' } } }));

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'layered-claude-md');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.nestedFiles).toHaveLength(0);
    expect(c.message).toContain('no nested CLAUDE.md');
  });

  it('c8.1 ignores CLAUDE.md inside node_modules', () => {
    // CLAUDE.md inside node_modules must not be counted
    ensureDir(join(root, 'node_modules/some-pkg'));
    writeFileSync(join(root, 'node_modules/some-pkg/CLAUDE.md'), '# Nested\n\n## Testing\ntest command: npm test\n');
    // No other nested files
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'layered-claude-md');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
  });

  it('c8.1 ignores CLAUDE.md inside .git directory', () => {
    ensureDir(join(root, '.git/some-dir'));
    writeFileSync(join(root, '.git/some-dir/CLAUDE.md'), '# Nested\n\n## Testing\ntest: npm test\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'layered-claude-md');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
  });

  // =========================================================================
  // c8.2 codebase-map-present (max 2)
  // =========================================================================

  it('c8.2 pass(2): .orchestrator/steering/structure.md with ≥10 lines earns 2 points', () => {
    scaffoldHappyPath(root);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'codebase-map-present');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
    expect(c.evidence.matched).toBe('.orchestrator/steering/structure.md');
    expect(c.evidence.lineCount).toBeGreaterThanOrEqual(10);
  });

  it('c8.2 fail(0): no codebase map file at any candidate path earns 0 points', () => {
    // No structure.md, no docs/architecture.md, etc.
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'codebase-map-present');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.matched).toBeNull();
    expect(c.message).toContain('no codebase map found');
  });

  it('c8.2 fail(0): structure.md present but fewer than 10 lines (< 10) earns 0 points', () => {
    ensureDir(join(root, '.orchestrator/steering'));
    // 7 non-empty lines + trailing newline → lineCount is 7 (< 10 threshold)
    writeFileSync(
      join(root, '.orchestrator/steering/structure.md'),
      '# Structure\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7',
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'codebase-map-present');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.lineCount).toBeLessThan(10);
    expect(c.message).toContain('< 10');
  });

  it('c8.2 accepts docs/architecture.md as a valid codebase-map candidate', () => {
    ensureDir(join(root, 'docs'));
    writeFileSync(
      join(root, 'docs/architecture.md'),
      '# Architecture\n\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11\n',
    );
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'codebase-map-present');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
    expect(c.evidence.matched).toBe('docs/architecture.md');
  });

  // =========================================================================
  // c8.3 lsp-configured (max 2)
  // =========================================================================

  it('c8.3 pass(2): .mcp.json with serena server earns 2 points', () => {
    scaffoldHappyPath(root);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
    expect(c.evidence.mcpConfigured).toBe(true);
    expect(c.evidence.docFallback).toBe(false);
  });

  it('c8.3 pass(1): no .mcp.json but a .claude/rules doc mentioning "language server" earns 1 point', () => {
    // No .mcp.json; doc fallback via .claude/rules file
    ensureDir(join(root, '.claude/rules'));
    writeFileSync(join(root, '.claude/rules/lsp.md'), '# LSP Setup\n\nWe use a language server for TypeScript via the LSP protocol.\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.mcpConfigured).toBe(false);
    expect(c.evidence.docFallback).toBe(true);
    expect(c.message).toContain('language server');
  });

  it('c8.3 fail(0): no .mcp.json and no doc mentioning language server earns 0 points', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.mcpConfigured).toBe(false);
    expect(c.evidence.docFallback).toBe(false);
    expect(c.message).toContain('no LSP MCP server');
  });

  it('c8.3 fail(0): .mcp.json present but no LSP-related key/command earns 0 points', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'my-tool': { command: 'my-tool', args: [] } } }),
    );
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.mcpConfigured).toBe(false);
  });

  it('c8.3 recognises typescript-language-server in mcp server command as LSP', () => {
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { ts: { command: 'typescript-language-server', args: ['--stdio'] } } }),
    );
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lsp-configured');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
    expect(c.evidence.mcpConfigured).toBe(true);
  });

  // =========================================================================
  // c8.4 scoped-test-lint (max 1)
  // =========================================================================

  it('c8.4 pass(1): nested CLAUDE.md with test-command key earns 1 point', () => {
    scaffoldHappyPath(root);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'scoped-test-lint');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.scoped).toBe(true);
  });

  it('c8.4 fail(0): no nested instruction file with a test or lint command earns 0 points', () => {
    // nested CLAUDE.md exists but has no test/lint command reference
    writeNestedClaudeMd(root, 'skills/my-skill/CLAUDE.md', '# Conventions\n\nSome notes about the skill.\n');
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'scoped-test-lint');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.scoped).toBe(false);
  });

  it('c8.4 fail(0): no nested instruction files at all earns 0 points', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'scoped-test-lint');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
  });

  it('c8.4 pass(1): nested CLAUDE.md with npm test co-located under a ## heading earns 1 point', () => {
    // Uses the heading + npm + test pattern instead of the explicit key
    writeNestedClaudeMd(
      root,
      'scripts/CLAUDE.md',
      '# Scripts Conventions\n\n## Testing\n\nRun `npm test` to execute the test suite.\n',
    );
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'scoped-test-lint');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.scoped).toBe(true);
  });

  // =========================================================================
  // c8.5 permissions-deny-present (max 1)
  // =========================================================================

  it('c8.5 pass(1): .claude/settings.json with non-empty deny array earns 1 point', () => {
    scaffoldHappyPath(root);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'permissions-deny-present');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.denyCount).toBe(2);
  });

  it('c8.5 fail(0): .claude/settings.json missing entirely earns 0 points', () => {
    writeFileSync(join(root, 'CLAUDE.md'), '# Root\n');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'permissions-deny-present');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.denyCount).toBeNull();
    expect(c.message).toContain('missing a non-empty permissions.deny');
  });

  it('c8.5 fail(0): .claude/settings.json with empty deny array earns 0 points', () => {
    ensureDir(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(ls:*)'], deny: [] } }),
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'permissions-deny-present');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.denyCount).toBe(0);
  });

  it('c8.5 fail(0): .claude/settings.json with no permissions field earns 0 points', () => {
    ensureDir(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6' }),
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'permissions-deny-present');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
  });

  it('c8.5 fail(0): .claude/settings.json with malformed JSON earns 0 points', () => {
    ensureDir(join(root, '.claude'));
    writeFileSync(join(root, '.claude/settings.json'), '{ "permissions": { broken json');

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'permissions-deny-present');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
  });

  it('c8.5 pass(1): single-entry deny array earns 1 point', () => {
    ensureDir(join(root, '.claude'));
    writeFileSync(
      join(root, '.claude/settings.json'),
      JSON.stringify({ permissions: { deny: ['Bash(rm -rf /)'] } }),
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'permissions-deny-present');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.denyCount).toBe(1);
  });

  // =========================================================================
  // c8.6 lean-root (max 2)
  // =========================================================================

  it('c8.6 pass(2): CLAUDE.md has delegation link and all sections ≤60 lines earns 2 points', () => {
    scaffoldHappyPath(root);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
    expect(c.evidence.delegationLink).toBe(true);
    expect(c.evidence.maxSectionLines).toBeLessThanOrEqual(60);
  });

  it('c8.6 pass(1): CLAUDE.md has delegation link but a section exceeds 60 lines earns 1 point', () => {
    // Create a CLAUDE.md with a delegation link but one section > 60 lines
    const longSection = Array.from({ length: 62 }, (_, i) => `- item ${i + 1}`).join('\n');
    writeFileSync(
      join(root, 'CLAUDE.md'),
      `# Root\n\n> See [README.md](./README.md) for the codebase map.\n\n## Big Section\n\n${longSection}\n`,
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.delegationLink).toBe(true);
    expect(c.evidence.maxSectionLines).toBeGreaterThan(60);
  });

  it('c8.6 fail(0): CLAUDE.md with no delegation link earns 0 points', () => {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      '# Root\n\n## Section A\n\nSome content with no links.\n',
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.delegationLink).toBe(false);
    expect(c.message).toContain('no delegation links');
  });

  it('c8.6 fail(0): CLAUDE.md missing entirely earns 0 points', () => {
    // No CLAUDE.md at all
    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('fail');
    expect(c.points).toBe(0);
    expect(c.evidence.delegationLink).toBe(false);
    expect(c.message).toContain('CLAUDE.md');
  });

  it('c8.6 accepts .orchestrator/steering/*.md as a valid delegation link target', () => {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      '# Root\n\n> See [structure.md](.orchestrator/steering/structure.md) for layout.\n\n## Section\n\nshort\n',
    );

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('pass');
    expect(c.points).toBeGreaterThanOrEqual(1);
    expect(c.evidence.delegationLink).toBe(true);
  });
});
