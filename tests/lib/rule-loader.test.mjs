/**
 * tests/lib/rule-loader.test.mjs
 *
 * Unit tests for scripts/lib/rule-loader.mjs — issue #336 glob-scoped rules.
 *
 * Tests cover:
 *   - No frontmatter → alwaysOn: true
 *   - Matching globs → loaded with matchedGlobs populated
 *   - Non-matching globs → not loaded
 *   - Empty globs array → not loaded for any scope
 *   - Malformed YAML frontmatter → falls back to alwaysOn: true (graceful)
 *   - Multiple globs, at least one matching → loaded
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadApplicableRules } from '@lib/rule-loader.mjs';

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tmpDirs = [];

function makeTmpRulesDir() {
  const dir = mkdtempSync(join(tmpdir(), 'rule-loader-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeRule(dir, name, content) {
  writeFileSync(join(dir, name), content, 'utf8');
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 1: rule with no frontmatter → alwaysOn: true
// ---------------------------------------------------------------------------

describe('rule with no frontmatter', () => {
  it('is loaded with alwaysOn: true', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'always-on.md', '# Always-On Rule\n\nThis rule has no frontmatter.\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/api/route.ts'] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
  });

  it('is loaded even when scopePaths is empty', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'always-on.md', '# Always-On Rule\n\nNo frontmatter here.\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
  });

  it('has an empty matchedGlobs array', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'no-fm.md', '# No Frontmatter\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/index.ts'] });

    expect(results[0].matchedGlobs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test 2: rule with globs: ["src/**"] and matching scope → loaded with matchedGlobs populated
// ---------------------------------------------------------------------------

describe('rule with globs matching the scope', () => {
  it('is loaded and matchedGlobs is populated', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'src-rule.md',
      '---\nglobs:\n  - src/**\n---\n\n# Src Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/api/route.ts'] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(false);
    expect(results[0].matchedGlobs).toContain('src/**');
  });

  it('loaded entry has path pointing to the rule file', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'src-rule.md', '---\nglobs:\n  - src/**\n---\n\n# Src Rule\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/lib/util.ts'] });

    expect(results[0].path).toBe(join(dir, 'src-rule.md'));
  });

  it('loaded entry contains the raw file content', () => {
    const dir = makeTmpRulesDir();
    const content = '---\nglobs:\n  - src/**\n---\n\n# Src Rule content here\n';
    writeRule(dir, 'src-rule.md', content);

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/components/Button.tsx'] });

    expect(results[0].content).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// Test 3: rule with globs: ["src/**"] and non-matching scope → not loaded
// ---------------------------------------------------------------------------

describe('rule with globs not matching the scope', () => {
  it('is not included in the results', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'src-rule.md',
      '---\nglobs:\n  - src/**\n---\n\n# Src-only Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['docs/README.md'] });

    expect(results).toHaveLength(0);
  });

  it('returns empty array when scope is in a completely different directory', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'api-rule.md', '---\nglobs:\n  - src/app/api/**\n---\n\n# API Rule\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['tests/lib/foo.test.mjs'] });

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: rule with globs: [] (empty array) → not loaded for any scope
// ---------------------------------------------------------------------------

describe('rule with empty globs array', () => {
  it('is not loaded even when scopePaths is non-empty', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'empty-globs.md',
      '---\nglobs: []\n---\n\n# Empty Globs Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/anything.ts'] });

    expect(results).toHaveLength(0);
  });

  it('is not loaded when scopePaths is also empty', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'empty-globs.md', '---\nglobs: []\n---\n\n# Empty Globs\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 5: rule with malformed YAML frontmatter → falls back to alwaysOn: true
// ---------------------------------------------------------------------------

describe('rule with malformed YAML frontmatter', () => {
  it('falls back to alwaysOn: true instead of throwing', () => {
    const dir = makeTmpRulesDir();
    // A line with no colon at the top level triggers the parse error path
    writeRule(
      dir,
      'malformed.md',
      '---\nnot_valid_yaml_line_without_colon_somehow\nglobs:\n  - src/**\n---\n\n# Malformed\n',
    );

    // The loader must not throw — it should return the rule as always-on
    let results;
    expect(() => {
      results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/x.ts'] });
    }).not.toThrow();

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
  });

  it('marks the fallen-back entry with _parseError flag', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'malformed.md',
      '---\nbad line without colon here at all\n---\n\n# Malformed\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/x.ts'] });

    expect(results[0]._parseError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 6: multiple globs — at least one matching scope path → loaded
// ---------------------------------------------------------------------------

describe('rule with multiple globs, at least one matching', () => {
  it('is loaded when only the second glob matches', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'multi-glob.md',
      '---\nglobs:\n  - src/app/api/**\n  - src/routes/**\n---\n\n# Multi-Glob Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/routes/health.ts'] });

    expect(results).toHaveLength(1);
    expect(results[0].matchedGlobs).toContain('src/routes/**');
  });

  it('is loaded when only the first glob matches', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'multi-glob.md',
      '---\nglobs:\n  - src/app/api/**\n  - src/routes/**\n---\n\n# Multi-Glob Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/app/api/users.ts'] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(false);
  });

  it('matchedGlobs contains only the patterns that matched', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'multi-glob.md',
      '---\nglobs:\n  - src/app/api/**\n  - src/routes/**\n---\n\n# Multi-Glob Rule\n',
    );

    // Only src/routes/** matches
    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/routes/login.ts'] });

    expect(results[0].matchedGlobs).toContain('src/routes/**');
    expect(results[0].matchedGlobs).not.toContain('src/app/api/**');
  });

  it('is not loaded when no glob matches any scope path', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'multi-glob.md',
      '---\nglobs:\n  - src/app/api/**\n  - src/routes/**\n---\n\n# Multi-Glob Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['docs/architecture.md'] });

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mixed: always-on + glob-scoped rules in the same directory
// ---------------------------------------------------------------------------

describe('mixed always-on and glob-scoped rules', () => {
  it('always-on rules appear regardless of scope, glob-scoped only when matching', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'always.md', '# Always On\n');
    writeRule(dir, 'scoped.md', '---\nglobs:\n  - src/**\n---\n\n# Scoped\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['docs/guide.md'] });

    // Always-on loads, scoped does not
    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
  });

  it('both always-on and matching glob-scoped rules appear together', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'always.md', '# Always On\n');
    writeRule(dir, 'scoped.md', '---\nglobs:\n  - src/**\n---\n\n# Scoped\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/util.ts'] });

    expect(results).toHaveLength(2);
    const alwaysOnEntry = results.find((r) => r.alwaysOn === true);
    const scopedEntry = results.find((r) => r.alwaysOn === false);
    expect(alwaysOnEntry).toBeDefined();
    expect(scopedEntry).toBeDefined();
    expect(scopedEntry.matchedGlobs).toContain('src/**');
  });
});

// ---------------------------------------------------------------------------
// Non-.md files are ignored
// ---------------------------------------------------------------------------

describe('non-.md files in rulesDir', () => {
  it('ignores .json and .txt files', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'config.json', '{"not": "a rule"}');
    writeRule(dir, 'notes.txt', 'just notes');
    writeRule(dir, 'real-rule.md', '# Real Rule\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(1);
  });
});
