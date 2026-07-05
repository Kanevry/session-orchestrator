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

// ===========================================================================
// #694 — Activation foundation: expiry / mode / host-class gating + meta
// ===========================================================================

// A fixed clock so expiry tests are deterministic. 2026-06-01T00:00:00Z.
const FIXED_NOW = Date.parse('2026-06-01T00:00:00Z');

// ---------------------------------------------------------------------------
// Expiry gating
// ---------------------------------------------------------------------------

describe('expiry gating (#694)', () => {
  it('excludes an always-on rule whose expires-at is before now', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'expired.md',
      '---\nexpires-at: 2026-01-01\n---\n\n# Expired Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], now: FIXED_NOW });

    expect(results).toHaveLength(0);
  });

  it('includes a rule whose expires-at is after now', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'fresh.md',
      '---\nexpires-at: 2026-12-31\n---\n\n# Fresh Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], now: FIXED_NOW });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
    expect(results[0].expiresAt).toBe('2026-12-31');
  });

  it('keeps a rule with a malformed expires-at (fail-open)', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'bad-expiry.md',
      '---\nexpires-at: not-a-date\n---\n\n# Bad Expiry Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], now: FIXED_NOW });

    expect(results).toHaveLength(1);
    expect(results[0].expiresAt).toBe('not-a-date');
  });

  it('writes a stderr WARN naming the expired rule path', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'expired.md', '---\nexpires-at: 2025-01-01\n---\n\n# Expired\n');

    const captured = [];
    const original = process.stderr.write;
    process.stderr.write = (chunk) => {
      captured.push(String(chunk));
      return true;
    };
    try {
      loadApplicableRules({ rulesDir: dir, scopePaths: [], now: FIXED_NOW });
    } finally {
      process.stderr.write = original;
    }

    const joined = captured.join('');
    expect(joined).toContain('expired.md');
    expect(joined).toContain('expired');
  });

  it('excludes a glob-matched rule that is also expired', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'scoped-expired.md',
      '---\nglobs:\n  - src/**\nexpires-at: 2026-01-01\n---\n\n# Scoped Expired\n',
    );

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: ['src/index.ts'],
      now: FIXED_NOW,
    });

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Mode gating
// ---------------------------------------------------------------------------

describe('mode gating (#694)', () => {
  it('includes a mode-tagged rule when the mode param matches', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'deep-only.md', '---\nmode: deep\n---\n\n# Deep Only\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], mode: 'deep' });

    expect(results).toHaveLength(1);
    expect(results[0].mode).toBe('deep');
  });

  it('excludes a mode-tagged rule when the mode param differs', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'deep-only.md', '---\nmode: deep\n---\n\n# Deep Only\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], mode: 'feature' });

    expect(results).toHaveLength(0);
  });

  it('includes a mode-tagged rule when the mode param is null (no filtering)', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'deep-only.md', '---\nmode: deep\n---\n\n# Deep Only\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], mode: null });

    expect(results).toHaveLength(1);
  });

  it('includes a rule with no mode key regardless of the mode param', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'no-mode.md', '# No Mode Key\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], mode: 'feature' });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Host-class gating
// ---------------------------------------------------------------------------

describe('host-class gating (#694)', () => {
  it('includes a host-class-tagged rule when hostClass matches', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'ci-only.md', '---\nhost-class: ci\n---\n\n# CI Only\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], hostClass: 'ci' });

    expect(results).toHaveLength(1);
    expect(results[0].hostClass).toBe('ci');
  });

  it('excludes a host-class-tagged rule when hostClass differs', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'ci-only.md', '---\nhost-class: ci\n---\n\n# CI Only\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], hostClass: 'local' });

    expect(results).toHaveLength(0);
  });

  it('includes a host-class-tagged rule when hostClass is null (no filtering)', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'ci-only.md', '---\nhost-class: ci\n---\n\n# CI Only\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], hostClass: null });

    expect(results).toHaveLength(1);
  });

  it('includes a rule with no host-class key regardless of the hostClass param', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'no-host.md', '# No Host Class Key\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], hostClass: 'ci' });

    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Combined gating — must pass ALL active gates
// ---------------------------------------------------------------------------

describe('combined gating (#694)', () => {
  it('excludes when mode matches but host-class differs', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'multi-gate.md',
      '---\nmode: deep\nhost-class: ci\n---\n\n# Multi Gate\n',
    );

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: [],
      mode: 'deep',
      hostClass: 'local',
    });

    expect(results).toHaveLength(0);
  });

  it('includes when both mode and host-class match', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'multi-gate.md',
      '---\nmode: deep\nhost-class: ci\n---\n\n# Multi Gate\n',
    );

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: [],
      mode: 'deep',
      hostClass: 'ci',
    });

    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Meta surfacing + type coercion
// ---------------------------------------------------------------------------

describe('frontmatter meta surfacing (#694)', () => {
  it('surfaces all new scalar keys with correct types and camelCase names', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'full-meta.md',
      [
        '---',
        'description: A fully specified rule',
        'mode: deep',
        'host-class: ci',
        'alwaysApply: true',
        'expires-at: 2026-12-31',
        'learning-key: my-learning-123',
        'auto-generated: false',
        'confidence: 0.85',
        '---',
        '',
        '# Full Meta Rule',
        '',
      ].join('\n'),
    );

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: [],
      mode: 'deep',
      hostClass: 'ci',
      now: FIXED_NOW,
    });

    expect(results).toHaveLength(1);
    const entry = results[0];
    expect(entry.description).toBe('A fully specified rule');
    expect(entry.mode).toBe('deep');
    expect(entry.hostClass).toBe('ci');
    expect(entry.alwaysApply).toBe(true);
    expect(entry.expiresAt).toBe('2026-12-31');
    expect(entry.learningKey).toBe('my-learning-123');
    expect(entry.autoGenerated).toBe(false);
    expect(entry.confidence).toBe(0.85);
  });

  it('coerces alwaysApply to a real boolean, not the string "true"', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'bool.md', '---\nalwaysApply: true\n---\n\n# Bool\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results[0].alwaysApply).toBe(true);
    expect(typeof results[0].alwaysApply).toBe('boolean');
  });

  it('coerces confidence to a real number, not the string "0.5"', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'conf.md', '---\nconfidence: 0.5\n---\n\n# Conf\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results[0].confidence).toBe(0.5);
    expect(typeof results[0].confidence).toBe('number');
  });

  it('omits all meta keys for a no-frontmatter rule', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'bare.md', '# Bare Rule\n\nNo frontmatter at all.\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    const entry = results[0];
    expect(Object.keys(entry).sort()).toEqual(['alwaysOn', 'content', 'matchedGlobs', 'path']);
    expect(entry.description).toBeUndefined();
    expect(entry.mode).toBeUndefined();
    expect(entry.hostClass).toBeUndefined();
    expect(entry.confidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unknown-key tolerance
// ---------------------------------------------------------------------------

describe('unknown frontmatter keys (#694)', () => {
  it('loads a glob rule with an unknown key without throwing', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'unknown-key.md',
      '---\nglobs:\n  - src/**\nfoo: bar\n---\n\n# Unknown Key Rule\n',
    );

    let results;
    expect(() => {
      results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/x.ts'] });
    }).not.toThrow();

    expect(results).toHaveLength(1);
    expect(results[0].matchedGlobs).toContain('src/**');
    expect(results[0].foo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Byte-for-byte always-on content guarantee
// ---------------------------------------------------------------------------

describe('always-on content fidelity (#694)', () => {
  it('returns content byte-identical to the file written', () => {
    const dir = makeTmpRulesDir();
    const exact = '# Exact Content\n\nLine two with trailing spaces.   \nLine three.\n';
    writeRule(dir, 'exact.md', exact);

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results[0].content).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// #687 backward-compat contract: empty scope + no gating
// ---------------------------------------------------------------------------

describe('#687 always-on contract (empty scope, no gating)', () => {
  it('returns an unexpired no-globs rule as alwaysOn with identical content', () => {
    const dir = makeTmpRulesDir();
    const content = '# Always Loaded\n\nApplies every wave.\n';
    writeRule(dir, 'always.md', content);

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: [],
      mode: null,
      hostClass: null,
      now: FIXED_NOW,
    });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
    expect(results[0].content).toBe(content);
  });

  it('excludes a glob-only rule when the scope is empty', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'scoped.md', '---\nglobs:\n  - src/**\n---\n\n# Scoped\n');

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: [],
      mode: null,
      hostClass: null,
      now: FIXED_NOW,
    });

    expect(results).toHaveLength(0);
  });
});

// ===========================================================================
// #692 — Tier gating: context param + tier frontmatter key
// ===========================================================================

describe('tier frontmatter key parsing (#692)', () => {
  it('surfaces tier on the entry as a string when frontmatter declares tier: coordinator-only', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'coord-only.md',
      '---\ntier: coordinator-only\n---\n\n# Coordinator Only Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('coordinator-only');
  });

  it('surfaces tier: wave-only on the entry', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'wave-only.md',
      '---\ntier: wave-only\n---\n\n# Wave Only Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('wave-only');
  });

  it('surfaces tier: always on the entry', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'always-tier.md',
      '---\ntier: always\n---\n\n# Always Tier Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('always');
  });

  it('does not set tier on the entry when no tier key is present in frontmatter', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'no-tier.md', '---\nmode: deep\n---\n\n# No Tier\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBeUndefined();
  });
});

describe('context: wave tier gating (#692)', () => {
  it('excludes a tier: coordinator-only rule when context is wave', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'coord-only.md',
      '---\ntier: coordinator-only\n---\n\n# Coordinator Only\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'wave' });

    expect(results).toHaveLength(0);
  });

  it('includes a tier: always rule when context is wave', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'always-tier.md',
      '---\ntier: always\n---\n\n# Always Tier\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'wave' });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('always');
  });

  it('includes a tier: wave-only rule when context is wave', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'wave-only.md',
      '---\ntier: wave-only\n---\n\n# Wave Only\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'wave' });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('wave-only');
  });
});

describe('context: coordinator tier gating (#692)', () => {
  it('excludes a tier: wave-only rule when context is coordinator', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'wave-only.md',
      '---\ntier: wave-only\n---\n\n# Wave Only\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'coordinator' });

    expect(results).toHaveLength(0);
  });

  it('includes a tier: coordinator-only rule when context is coordinator', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'coord-only.md',
      '---\ntier: coordinator-only\n---\n\n# Coordinator Only\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'coordinator' });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('coordinator-only');
  });

  it('includes a tier: always rule when context is coordinator', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'always-tier.md',
      '---\ntier: always\n---\n\n# Always Tier\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'coordinator' });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('always');
  });
});

describe('context: null tier gating backward-compat (#692)', () => {
  it('includes a tier: coordinator-only rule when context is null', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'coord-only.md',
      '---\ntier: coordinator-only\n---\n\n# Coordinator Only\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: null });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('coordinator-only');
  });

  it('includes a tier: wave-only rule when context is null', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'wave-only.md',
      '---\ntier: wave-only\n---\n\n# Wave Only\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: null });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('wave-only');
  });

  it('includes a tier: always rule when context is null', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'always-tier.md',
      '---\ntier: always\n---\n\n# Always Tier\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: null });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('always');
  });

  it('includes all tier values when context is omitted (defaults to null)', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'a.md', '---\ntier: coordinator-only\n---\n\n# A\n');
    writeRule(dir, 'b.md', '---\ntier: wave-only\n---\n\n# B\n');
    writeRule(dir, 'c.md', '---\ntier: always\n---\n\n# C\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(3);
  });
});

describe('no tier key backward-compat (#692)', () => {
  it('includes a rule with no tier key when context is wave', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'no-tier.md', '# No Tier Frontmatter At All\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'wave' });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
    expect(results[0].tier).toBeUndefined();
  });

  it('includes a rule with no tier key when context is coordinator', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'no-tier.md', '# No Tier Frontmatter At All\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [], context: 'coordinator' });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
    expect(results[0].tier).toBeUndefined();
  });
});

// ===========================================================================
// #722 Epic A Wave 2 — leading provenance-header tolerance in frontmatter parsing
// ===========================================================================

describe('leading provenance-header tolerance (#722)', () => {
  it('loads a header-prefixed rule with globs as scoped, with matchedGlobs populated', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'vendored.md',
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/vendored.md) -->\n---\nglobs:\n  - src/**\n---\n\n# Vendored Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/index.ts'] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(false);
    expect(results[0].matchedGlobs).toContain('src/**');
  });

  it('excludes a header-prefixed globs rule when the scope does not match', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'vendored.md',
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/vendored.md) -->\n---\nglobs:\n  - src/**\n---\n\n# Vendored Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['docs/readme.md'] });

    expect(results).toHaveLength(0);
  });

  it('keeps scalar meta (description) on a header-prefixed rule', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'vendored.md',
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/vendored.md) -->\n---\ndescription: A vendored rule\nglobs:\n  - src/**\n---\n\n# Vendored Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/index.ts'] });

    expect(results[0].description).toBe('A vendored rule');
  });

  it('a file starting directly with --- (no header) parses identically to before', () => {
    const dir = makeTmpRulesDir();
    writeRule(dir, 'plain.md', '---\nglobs:\n  - src/**\n---\n\n# Plain Rule\n');

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/index.ts'] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(false);
    expect(results[0].matchedGlobs).toContain('src/**');
  });

  it('a header-prefixed rule with no frontmatter at all stays always-on', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'no-fm.md',
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/no-fm.md) -->\n# No Frontmatter Rule\n\nJust prose, no frontmatter block.\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: [] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(true);
  });

  it('multiple stacked single-line comment header lines are still tolerated', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'multi-header.md',
      '<!-- source: session-orchestrator plugin -->\n<!-- canonical: rules/always-on/multi-header.md -->\n---\nglobs:\n  - src/**\n---\n\n# Multi Header Rule\n',
    );

    const results = loadApplicableRules({ rulesDir: dir, scopePaths: ['src/x.ts'] });

    expect(results).toHaveLength(1);
    expect(results[0].alwaysOn).toBe(false);
  });
});

describe('tier gate composes with glob matching (#692)', () => {
  it('excludes a tier: wave-only glob-matched rule when context is coordinator (tier gate wins over glob match)', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'wave-glob.md',
      '---\ntier: wave-only\nglobs:\n  - src/**\n---\n\n# Wave Only Glob Rule\n',
    );

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: ['src/index.ts'],
      context: 'coordinator',
    });

    expect(results).toHaveLength(0);
  });

  it('includes a tier: wave-only glob-matched rule when context is wave and glob matches', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'wave-glob.md',
      '---\ntier: wave-only\nglobs:\n  - src/**\n---\n\n# Wave Only Glob Rule\n',
    );

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: ['src/index.ts'],
      context: 'wave',
    });

    expect(results).toHaveLength(1);
    expect(results[0].tier).toBe('wave-only');
    expect(results[0].matchedGlobs).toContain('src/**');
  });

  it('excludes a tier: wave-only glob rule when context is coordinator even though glob would match', () => {
    const dir = makeTmpRulesDir();
    writeRule(
      dir,
      'wave-glob.md',
      '---\ntier: wave-only\nglobs:\n  - src/**\n---\n\n# Wave Only Glob Rule\n',
    );

    const results = loadApplicableRules({
      rulesDir: dir,
      scopePaths: ['src/lib/util.ts'],
      context: 'coordinator',
    });

    expect(results).toHaveLength(0);
  });
});
