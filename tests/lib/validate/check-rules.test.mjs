/**
 * tests/lib/validate/check-rules.test.mjs
 *
 * Tests for scripts/lib/validate/check-rules.mjs (FA4 #697).
 *
 * The gate validates every .claude/rules/*.md that carries `auto-generated: true`
 * against three invariants:
 *   (a) never-always-on: must have globs or host-class
 *   (b) learning-key must be present
 *   (c) expires-at must be present
 *
 * Rules WITHOUT `auto-generated: true` are silently skipped.
 * No auto-generated rules found → exit 0.
 * Any invariant violation → exit 1.
 * Missing plugin-root arg → exit 1 (usage error).
 *
 * Strategy: spawn the CLI via spawnSync with a tmp plugin-root that contains
 * .claude/rules/ fixtures, matching the pattern used by check-rules-references.test.mjs.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-rules.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const tmpRoots = [];

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'check-rules-'));
  tmpRoots.push(root);
  const rulesDir = join(root, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  return { root, rulesDir };
}

function writeRule(rulesDir, name, content) {
  writeFileSync(join(rulesDir, name), content, 'utf8');
}

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Case 1: no .claude/rules/ directory → exit 0
// ---------------------------------------------------------------------------

describe('check-rules — absent rules directory', () => {
  it('exits 0 when .claude/rules/ directory does not exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-rules-no-dir-'));
    tmpRoots.push(root);
    // No .claude/rules/ directory created.

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 2: .claude/rules/ exists but contains no auto-generated rules → exit 0
// ---------------------------------------------------------------------------

describe('check-rules — no auto-generated rules', () => {
  it('exits 0 when rules dir has no .md files', () => {
    const { root, rulesDir } = makeFixture();
    // rulesDir exists but contains no files.
    void rulesDir;

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });

  it('exits 0 when all .md files lack auto-generated: true', () => {
    const { root, rulesDir } = makeFixture();
    // A handwritten rule with no auto-generated key.
    writeRule(rulesDir, 'handwritten.md', '---\ndescription: A handwritten rule\nglobs: ["src/**"]\n---\n# Rule\nSome content.\n');

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 3: always-on auto-generated rule (no globs, no host-class) → exit 1
// ---------------------------------------------------------------------------

describe('check-rules — always-on auto-generated rule', () => {
  it('exits 1 and names the file when auto-generated rule has no activation axis', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'generated-always-on.md',
      '---\nauto-generated: true\nlearning-key: anti-pattern/use-strict\nexpires-at: 2099-01-01\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL:');
    expect(r.stdout).toContain('.claude/rules/generated-always-on.md');
    expect(r.stdout).toContain('always-on');
    expect(r.stdout).toContain('Results:');
  });

  it('FAIL line mentions never-always-on invariant violation', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'bad-always-on.md',
      '---\nauto-generated: true\nlearning-key: anti-pattern/no-globs\nexpires-at: 2099-06-01\n---\n# Bad\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    // The FAIL line must identify the file AND name the invariant.
    expect(r.stdout).toMatch(/FAIL:.*\.claude\/rules\/bad-always-on\.md/);
    expect(r.stdout).toContain('never-always-on');
  });
});

// ---------------------------------------------------------------------------
// Case 4: auto-generated rule missing learning-key → exit 1
// ---------------------------------------------------------------------------

describe('check-rules — missing learning-key', () => {
  it('exits 1 and names learning-key in the FAIL line', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'no-learning-key.md',
      '---\nauto-generated: true\nglobs: ["src/**/*.ts"]\nexpires-at: 2099-01-01\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL:');
    expect(r.stdout).toContain('.claude/rules/no-learning-key.md');
    expect(r.stdout).toContain('learning-key');
  });
});

// ---------------------------------------------------------------------------
// Case 5: auto-generated rule missing expires-at → exit 1
// ---------------------------------------------------------------------------

describe('check-rules — missing expires-at', () => {
  it('exits 1 and names expires-at in the FAIL line', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'no-expires.md',
      '---\nauto-generated: true\nglobs: ["scripts/**"]\nlearning-key: anti-pattern/missing-expiry\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL:');
    expect(r.stdout).toContain('.claude/rules/no-expires.md');
    expect(r.stdout).toContain('expires-at');
  });
});

// ---------------------------------------------------------------------------
// Case 6: VALID auto-generated rule (globs + learning-key + expires-at) → exit 0
// ---------------------------------------------------------------------------

describe('check-rules — valid auto-generated rule', () => {
  it('exits 0 and emits a PASS line when all invariants are satisfied', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'valid-generated.md',
      '---\nauto-generated: true\nglobs: ["src/**/*.ts"]\nlearning-key: anti-pattern/use-strict\nexpires-at: 2099-12-31\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('.claude/rules/valid-generated.md');
    expect(r.stdout).toContain('Results:');
    expect(r.stdout).not.toContain('FAIL:');
  });

  it('emits the correct pass/fail summary when the rule is valid', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'valid-gen.md',
      '---\nauto-generated: true\nglobs: ["tests/**"]\nlearning-key: fragile-pattern/test-fixture\nexpires-at: 2099-06-01\n---\n# Rule\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Case 7: host-class-only auto-generated rule (no globs but host-class present)
// → exit 0. host-class is a valid activation axis.
// ---------------------------------------------------------------------------

describe('check-rules — host-class-only activation axis', () => {
  it('exits 0 when auto-generated rule has host-class instead of globs', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'host-class-rule.md',
      '---\nauto-generated: true\nhost-class: mac-m-series\nlearning-key: recurring-issue/m-series-path\nexpires-at: 2099-01-01\n---\n# Rule\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('.claude/rules/host-class-rule.md');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 8: handwritten always-on rule (no auto-generated key) → exit 0
// The gate must NOT audit handwritten rules.
// ---------------------------------------------------------------------------

describe('check-rules — handwritten always-on rule is not flagged', () => {
  it('exits 0 for a handwritten rule that has no activation axis', () => {
    const { root, rulesDir } = makeFixture();
    // A rule WITHOUT auto-generated: true, also without globs/host-class
    // (i.e., always-on). The gate must ignore it.
    writeRule(
      rulesDir,
      'always-on-handwritten.md',
      '---\ndescription: A handwritten always-on rule\nalwaysApply: true\n---\n# Always-on\nThis is intentionally always-on.\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL:');
  });

  it('exits 0 even when handwritten and generated rules coexist and only generated violates', () => {
    const { root, rulesDir } = makeFixture();
    // Handwritten rule — always-on, no auto-generated. Must be ignored.
    writeRule(
      rulesDir,
      'handwritten.md',
      '---\ndescription: Handwritten\n---\n# Handwritten\n',
    );
    // Generated rule — valid.
    writeRule(
      rulesDir,
      'valid-gen.md',
      '---\nauto-generated: true\nglobs: ["src/**"]\nlearning-key: anti-pattern/foo\nexpires-at: 2099-01-01\n---\n# Gen\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Case 9: missing plugin-root argument → exit 1 (usage error)
// ---------------------------------------------------------------------------

describe('check-rules — missing plugin-root argument', () => {
  it('exits 1 and writes usage to stderr when no argument is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });

    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Usage:');
    expect(r.stderr).toContain('check-rules.mjs');
  });
});

// ---------------------------------------------------------------------------
// Case 10: multiple violations in one rule — all three fail lines appear
// ---------------------------------------------------------------------------

describe('check-rules — multiple violations in a single rule', () => {
  it('emits three FAIL lines when a rule violates all three invariants', () => {
    const { root, rulesDir } = makeFixture();
    // auto-generated: true, but no globs/host-class, no learning-key, no expires-at
    writeRule(
      rulesDir,
      'fully-broken.md',
      '---\nauto-generated: true\n---\n# Broken\nContent.\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    // Three separate FAIL lines: always-on, missing learning-key, missing expires-at.
    const failLines = r.stdout.split('\n').filter((l) => l.includes('FAIL:'));
    expect(failLines).toHaveLength(3);
    expect(r.stdout).toContain('Results: 0 passed, 3 failed');
  });
});

// ---------------------------------------------------------------------------
// Case 11: mixed valid and invalid auto-generated rules
// ---------------------------------------------------------------------------

describe('check-rules — mixed valid and invalid auto-generated rules', () => {
  it('exits 1 and reports exactly one FAIL when one valid and one invalid rule exist', () => {
    const { root, rulesDir } = makeFixture();
    // Valid generated rule.
    writeRule(
      rulesDir,
      'aaaa-valid.md',
      '---\nauto-generated: true\nglobs: ["src/**"]\nlearning-key: anti-pattern/correct\nexpires-at: 2099-01-01\n---\n# Valid\n',
    );
    // Invalid generated rule — missing expires-at.
    writeRule(
      rulesDir,
      'zzzz-invalid.md',
      '---\nauto-generated: true\nglobs: ["tests/**"]\nlearning-key: anti-pattern/broken\n---\n# Broken\n',
    );

    const r = run(root);

    expect(r.status).toBe(1);
    // The valid rule passes, the invalid rule fails.
    const failLines = r.stdout.split('\n').filter((l) => l.includes('FAIL:'));
    expect(failLines).toHaveLength(1);
    expect(failLines[0]).toContain('zzzz-invalid.md');
    expect(r.stdout).toContain('PASS:');
    expect(r.stdout).toContain('aaaa-valid.md');
    expect(r.stdout).toContain('Results: 1 passed, 1 failed');
  });
});
