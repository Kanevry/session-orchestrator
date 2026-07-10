/**
 * tests/skills/config-reading-glob-rules.test.mjs
 *
 * Integration / behavioral tests for #336 glob-scoped rules.
 *
 * These tests invoke loadApplicableRules against the ACTUAL .claude/rules/
 * directory and assert on real-world rule-loading behavior.
 *
 * Rules with globs: frontmatter in .claude/rules/ (at time of writing, post
 * #743 Option A — backend.md, backend-data.md, frontend.md, swift.md, and
 * security-web.md were hoisted out of .claude/rules/ into the opt-in library
 * at rules/opt-in-stack/ — see .claude/rules/README or CLAUDE.md for the
 * rationale. Only two stable glob-scoped rules remain in .claude/rules/):
 *   - cli-design.md    globs: scripts/**, bin/**, cli/**, …
 *   - testing.md       globs: **\/*.test.*, tests/**, vitest.config.*, …
 *
 * Always-on rules (no globs frontmatter): ask-via-tool.md, development.md,
 *   loop-and-monitor.md, mvp-scope.md, owner-persona.md, parallel-sessions.md,
 *   security.md
 *
 * Design note (Wave 3 fix-pass, #743 follow-up): these tests intentionally
 * still assert against the LIVE .claude/rules/ directory rather than a
 * synthetic tmp fixture. A fixture rewrite was considered (mkdtemp + 2-3
 * synthetic rule files) for structural immunity to future curation, but
 * every describe block in this file already pins live rule names/paths —
 * a fixture conversion would rewrite ~100% of the file, not a targeted
 * subset. Given the narrow Wave-3 fix-pass scope, the minimal fix was
 * chosen instead: swap the two hoisted-out rule names (backend.md,
 * security-web.md) for the two glob-scoped rules that still live in
 * .claude/rules/ (cli-design.md, testing.md), preserving the same
 * multi-rule-overlap assertions this file exists to cover. A future
 * broader test-hardening pass MAY still want the fixture approach (see
 * testing.md's floor/ceiling guidance for the same "don't pin to live
 * inventory" principle) — tracked as a follow-up, not done here.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadApplicableRules } from '@lib/rule-loader.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RULES_DIR = join(REPO_ROOT, '.claude', 'rules');

// ---------------------------------------------------------------------------
// Test 1: narrow scopePaths matching cli-design.md but NOT testing.md
// ---------------------------------------------------------------------------

describe('narrow scope — scripts/lib/foo.mjs', () => {
  it('loads cli-design.md (its globs match scripts/**)', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['scripts/lib/foo.mjs'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('cli-design.md');
  });

  it('does NOT load testing.md (its globs do not match a non-test scripts/ file)', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['scripts/lib/foo.mjs'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).not.toContain('testing.md');
  });

  it('loads always-on rules regardless of scope', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['scripts/lib/foo.mjs'],
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

  it('does not include cli-design.md or testing.md', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: [],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).not.toContain('cli-design.md');
    expect(names).not.toContain('testing.md');
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
  it('loads testing.md when scope is a test file (test-quality.md merged in via #445)', () => {
    // #445 merged test-quality.md into testing.md (both were path-scoped with a
    // shared glob set — the only safe merge). The Swift-test globs (`**/*Tests*`,
    // `**/WalkAITalkieTests/**`) were unioned into testing.md so the merged rule
    // still loads for both JS/TS and Swift test files.
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['tests/lib/foo.test.mjs'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('testing.md');
  });

  it('loads testing.md for a Swift test file (merged WalkAITalkieTests glob from #445)', () => {
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['Sources/App/WalkAITalkieTests/EngineTests.swift'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('testing.md');
  });

  it('loads cli-design.md and testing.md for a scripts/ test file (glob overlap)', () => {
    // #743 Option A hoisted backend.md/security-web.md out of .claude/rules/ —
    // this scope now exercises overlap between the two remaining glob-scoped
    // rules instead: `scripts/**` (cli-design.md) intersects `**/*.test.*`
    // (testing.md) at a path like scripts/foo.test.mjs.
    const results = loadApplicableRules({
      rulesDir: RULES_DIR,
      scopePaths: ['scripts/foo.test.mjs'],
    });

    const names = results.map((r) => r.path.split('/').pop());
    expect(names).toContain('cli-design.md');
    expect(names).toContain('testing.md');
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
