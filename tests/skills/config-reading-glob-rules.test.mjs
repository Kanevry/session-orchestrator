/**
 * tests/skills/config-reading-glob-rules.test.mjs
 *
 * Integration / behavioral tests for #336 glob-scoped rules.
 *
 * These tests invoke loadApplicableRules against the ACTUAL .claude/rules/
 * directory and assert on real-world rule-loading behavior.
 *
 * Rules with globs: frontmatter in .claude/rules/ (at time of writing):
 *   - backend.md       globs: src/app/actions/**, src/app/api/**, src/routes/**, …
 *   - backend-data.md  globs: src/lib/db/**, supabase/**, migrations/**, …
 *   - cli-design.md    globs: scripts/**, bin/**, cli/**, …
 *   - security-web.md  globs: src/app/api/**, src/middleware.*, …
 *   - test-quality.md  globs: **\/*.test.*, tests/**, …
 *   - testing.md       globs: **\/*.test.*, tests/**, vitest.config.*, …
 *
 * Always-on rules (no globs frontmatter): ask-via-tool.md, development.md,
 *   loop-and-monitor.md, mvp-scope.md, owner-persona.md, parallel-sessions.md,
 *   security.md
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadApplicableRules } from '@lib/rule-loader.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RULES_DIR = join(REPO_ROOT, '.claude', 'rules');

// ---------------------------------------------------------------------------
// Test 1: narrow scopePaths matching backend.md but NOT cli-design.md
// ---------------------------------------------------------------------------

describe('narrow scope — src/app/api/route.ts', () => {
  it('loads backend.md (its globs match src/app/api/**)', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['src/app/api/route.ts'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('backend.md');
  });

  it('does NOT load cli-design.md (its globs do not match src/app/api/**)', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['src/app/api/route.ts'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).not.toContain('cli-design.md');
  });

  it('loads always-on rules regardless of scope', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['src/app/api/route.ts'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    // security.md, development.md, parallel-sessions.md are always-on
    expect(names).toContain('security.md');
    expect(names).toContain('development.md');
    expect(names).toContain('parallel-sessions.md');
  });
});

// ---------------------------------------------------------------------------
// Test 2: empty scopePaths → only always-on rules load
// ---------------------------------------------------------------------------

describe('empty scopePaths', () => {
  it('returns only always-on rules (no glob-scoped rules trigger)', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: [],
    });

    // Every entry must be alwaysOn
    for (const rule of results) {
      expect(rule.alwaysOn).toBe(true);
    }
  });

  it('does not include backend.md, cli-design.md, or test-quality.md', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: [],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).not.toContain('backend.md');
    expect(names).not.toContain('cli-design.md');
    expect(names).not.toContain('test-quality.md');
    expect(names).not.toContain('testing.md');
    expect(names).not.toContain('security-web.md');
    expect(names).not.toContain('backend-data.md');
  });

  it('still loads the 7 always-on rules', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: [],
    });

    // At least the known always-on rules must be present
    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('ask-via-tool.md');
    expect(names).toContain('development.md');
    expect(names).toContain('security.md');
    expect(names).toContain('parallel-sessions.md');
  });
});

// ---------------------------------------------------------------------------
// Test 3: scope matching multiple rules → all matching rules load
// ---------------------------------------------------------------------------

describe('scope path matching multiple rules', () => {
  it('loads both testing.md and test-quality.md when scope is a test file', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['tests/lib/foo.test.mjs'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('testing.md');
    expect(names).toContain('test-quality.md');
  });

  it('loads backend.md and security-web.md for an API route', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['src/app/api/users/route.ts'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('backend.md');
    expect(names).toContain('security-web.md');
  });

  it('loads cli-design.md and always-on rules for a scripts/ path', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['scripts/lib/rule-loader.mjs'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('cli-design.md');
    expect(names).toContain('development.md'); // always-on
  });

  it('all matched glob-scoped entries have alwaysOn: false', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['tests/skills/foo.test.mjs'],
    });

    const globScoped = results.filter((r) => !r.alwaysOn);
    // Every glob-scoped entry must have at least one matchedGlob
    for (const entry of globScoped) {
      expect(entry.matchedGlobs.length).toBeGreaterThan(0);
    }
  });
});
