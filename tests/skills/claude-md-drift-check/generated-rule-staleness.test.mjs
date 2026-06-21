/**
 * tests/skills/claude-md-drift-check/generated-rule-staleness.test.mjs
 *
 * Tests for Check 8 ("generated-rule-staleness") inside
 * skills/claude-md-drift-check/checker.mjs (FA4 #697).
 *
 * Behaviour under test:
 *   - Produces a WARNING (never an error) when an auto-generated rule's
 *     learning-key is absent from .orchestrator/metrics/learnings.jsonl.
 *   - Produces a WARNING when the matching learning entry is expired
 *     (expires_at < now).
 *   - Does NOT produce an error — the check is WARN-only, so exit code stays 0
 *     and status stays 'ok' or 'skipped' regardless of staleness findings.
 *   - When no auto-generated rules exist, the check is silently skipped
 *     (generated-rule-staleness is absent from checks_run).
 *   - A valid, non-expired learning → no warning.
 *
 * Strategy: spawn checker.mjs via spawnSync with VAULT_DIR pointing at
 * an ephemeral tmpdir, following the exact pattern used in checker.test.mjs.
 * The vault receives .claude/rules/*.md fixtures AND optionally a
 * .orchestrator/metrics/learnings.jsonl fixture.
 * --skip-* flags suppress every other check so only generated-rule-staleness
 * output needs to be asserted.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHECKER = resolve(process.cwd(), 'skills/claude-md-drift-check/checker.mjs');

// Suppress all checks except generated-rule-staleness (and skip issue-refs
// which requires glab). The checker still runs Check 8 unconditionally.
const SKIP_OTHERS = [
  '--skip-path-resolver',
  '--skip-project-count',
  '--skip-issue-refs',
  '--skip-session-files',
  '--skip-surface-count',
  '--skip-session-config-parity',
  '--skip-vault-dir-parity',
];

function runChecker(vaultDir, extraArgs = []) {
  const r = spawnSync('node', [CHECKER, ...SKIP_OTHERS, ...extraArgs], {
    env: { ...process.env, VAULT_DIR: vaultDir, PATH: process.env.PATH },
    encoding: 'utf8',
    timeout: 15_000,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function parseJson(out) {
  const line = out.trim().split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line);
}

let vault;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'drift-staleness-'));
  // Create a minimal CLAUDE.md so the checker finds at least one scope file
  // (otherwise status='skipped' and Check 8 still runs before the scope scan).
  writeFileSync(join(vault, 'CLAUDE.md'), '# Minimal\nNo paths here.\n');
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRulesDir() {
  const rulesDir = join(vault, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  return rulesDir;
}

function makeLearningsDir() {
  const dir = join(vault, '.orchestrator', 'metrics');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Write a minimal auto-generated rule with the given learning-key.
 * Provides a valid globs + expires-at so only the staleness check fires.
 */
function writeGeneratedRule(rulesDir, filename, learningKey, expiresAt = '2099-12-31') {
  const content = [
    '---',
    'auto-generated: true',
    `globs: ["src/**/*.ts"]`,
    `learning-key: ${learningKey}`,
    `expires-at: ${expiresAt}`,
    '---',
    '# Generated rule',
    'Content.',
    '',
  ].join('\n');
  writeFileSync(join(rulesDir, filename), content, 'utf8');
}

/**
 * Write a learnings.jsonl file containing a single entry.
 * The checker derives the key as: `${type}/${kebab(title || subject)}`.
 */
function writeLearningsJsonl(dir, entries) {
  const lines = entries.map((e) => JSON.stringify(e)).join('\n');
  writeFileSync(join(dir, 'learnings.jsonl'), lines + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Case 1: no auto-generated rules → check silently skipped
// ---------------------------------------------------------------------------

describe('generated-rule-staleness — no auto-generated rules', () => {
  it('does not appear in checks_run when no auto-generated rules exist', () => {
    const rulesDir = makeRulesDir();
    // Write a handwritten rule only (no auto-generated: true).
    writeFileSync(
      join(rulesDir, 'handwritten.md'),
      '---\ndescription: Handwritten rule\nglobs: ["src/**"]\n---\n# Handwritten\n',
      'utf8',
    );

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('generated-rule-staleness');
  });

  it('does not appear in checks_run when .claude/rules/ directory is absent', () => {
    // No .claude/rules/ directory created.
    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('generated-rule-staleness');
  });

  it('does not appear in checks_run when rules dir has no .md files', () => {
    makeRulesDir(); // dir exists but is empty

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('generated-rule-staleness');
  });
});

// ---------------------------------------------------------------------------
// Case 2: generated rule whose learning-key is absent from learnings.jsonl
// → WARNING produced, exit stays 0, errors array unchanged
// ---------------------------------------------------------------------------

describe('generated-rule-staleness — absent learning-key', () => {
  it('pushes a warning when the learning-key is absent from learnings.jsonl', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'gen-rule.md', 'anti-pattern/use-strict');
    // Write a learnings.jsonl that does NOT contain the key 'anti-pattern/use-strict'.
    writeLearningsJsonl(learningsDir, [
      { type: 'anti-pattern', title: 'Different Rule', confidence: 0.8 },
    ]);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('generated-rule-staleness');
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0].extracted).toBe('anti-pattern/use-strict');
    expect(staleWarnings[0].message).toContain('anti-pattern/use-strict');
    expect(staleWarnings[0].message).toContain('absent');
  });

  it('warning message names the learnings.jsonl file', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'my-rule.md', 'recurring-issue/cache-miss');
    // Empty learnings file — all keys absent.
    writeLearningsJsonl(learningsDir, []);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0].message).toContain('learnings.jsonl');
  });

  it('does not add to the errors array — staleness is warnings-only', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'missing-key.md', 'fragile-pattern/missing-fixture');
    writeLearningsJsonl(learningsDir, []);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleErrors = j.errors.filter((e) => e.check === 'generated-rule-staleness');
    expect(staleErrors).toHaveLength(0);
  });

  it('warns when learnings.jsonl is entirely absent', () => {
    const rulesDir = makeRulesDir();
    // No .orchestrator/metrics/learnings.jsonl created.

    writeGeneratedRule(rulesDir, 'no-learnings.md', 'anti-pattern/no-file');

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0].extracted).toBe('anti-pattern/no-file');
  });
});

// ---------------------------------------------------------------------------
// Case 3: generated rule whose learning IS present and not expired → no warning
// ---------------------------------------------------------------------------

describe('generated-rule-staleness — present non-expired learning', () => {
  it('produces no staleness warning when the learning key matches and is not expired', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    // Rule key = 'anti-pattern/use-strict'
    // Checker derives: `${type}/${kebab(title)}` = 'anti-pattern/use-strict'
    writeGeneratedRule(rulesDir, 'valid-rule.md', 'anti-pattern/use-strict');
    writeLearningsJsonl(learningsDir, [
      {
        type: 'anti-pattern',
        title: 'Use Strict',
        confidence: 0.8,
        expires_at: '2099-12-31',
      },
    ]);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('generated-rule-staleness');
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(0);
  });

  it('appears in checks_run when a generated rule exists, even with no warnings', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'clean-rule.md', 'fragile-pattern/clean-fixture');
    writeLearningsJsonl(learningsDir, [
      {
        type: 'fragile-pattern',
        title: 'Clean Fixture',
        confidence: 0.9,
        expires_at: '2099-01-01',
      },
    ]);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('generated-rule-staleness');
  });
});

// ---------------------------------------------------------------------------
// Case 4: generated rule whose learning IS present but expired → warning
// ---------------------------------------------------------------------------

describe('generated-rule-staleness — expired learning', () => {
  it('pushes a warning when the matching learning entry is expired', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    // Rule's expires-at is also in the past (redundant but consistent fixture).
    writeGeneratedRule(rulesDir, 'expired-rule.md', 'anti-pattern/expired-one', '2020-01-01');
    writeLearningsJsonl(learningsDir, [
      {
        type: 'anti-pattern',
        title: 'Expired One',
        confidence: 0.7,
        expires_at: '2020-01-01',
      },
    ]);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0].extracted).toBe('anti-pattern/expired-one');
    expect(staleWarnings[0].message).toContain('expired');
    expect(staleWarnings[0].message).toContain('anti-pattern/expired-one');
  });

  it('does not add to the errors array for expired learnings', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'expired-entry.md', 'recurring-issue/stale-entry', '2019-06-01');
    writeLearningsJsonl(learningsDir, [
      {
        type: 'recurring-issue',
        title: 'Stale Entry',
        confidence: 0.6,
        expires_at: '2019-06-01',
      },
    ]);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleErrors = j.errors.filter((e) => e.check === 'generated-rule-staleness');
    expect(staleErrors).toHaveLength(0);
  });

  it('exit code stays 0 in warn mode (default) even with an expired learning', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'hard-expired.md', 'anti-pattern/hard-case', '2010-01-01');
    writeLearningsJsonl(learningsDir, [
      { type: 'anti-pattern', title: 'Hard Case', confidence: 0.9, expires_at: '2010-01-01' },
    ]);

    const r = runChecker(vault, ['--mode', 'warn']);

    expect(r.code).toBe(0);
  });

  it('exit code stays 0 in hard mode for generated-rule-staleness (it is WARN-only)', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'hard-mode-stale.md', 'anti-pattern/hard-mode', '2010-01-01');
    writeLearningsJsonl(learningsDir, [
      { type: 'anti-pattern', title: 'Hard Mode', confidence: 0.9, expires_at: '2010-01-01' },
    ]);

    // Even in hard mode, generated-rule-staleness only produces warnings,
    // so the exit code must stay 0 (hard mode only elevates *errors* to exit 1).
    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Case 5: multiple generated rules — per-rule warning granularity
// ---------------------------------------------------------------------------

describe('generated-rule-staleness — multiple generated rules', () => {
  it('produces one warning per absent learning-key when multiple rules exist', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'rule-a.md', 'anti-pattern/alpha');
    writeGeneratedRule(rulesDir, 'rule-b.md', 'anti-pattern/beta');
    // Empty learnings — both keys absent.
    writeLearningsJsonl(learningsDir, []);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(2);
    const extractedKeys = staleWarnings.map((w) => w.extracted).sort();
    expect(extractedKeys).toEqual(['anti-pattern/alpha', 'anti-pattern/beta']);
  });

  it('warns only for the absent rule when one learning exists and one is missing', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    writeGeneratedRule(rulesDir, 'present-rule.md', 'anti-pattern/present');
    writeGeneratedRule(rulesDir, 'absent-rule.md', 'anti-pattern/absent');
    writeLearningsJsonl(learningsDir, [
      { type: 'anti-pattern', title: 'Present', confidence: 0.8, expires_at: '2099-12-31' },
    ]);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(1);
    expect(staleWarnings[0].extracted).toBe('anti-pattern/absent');
  });
});

// ---------------------------------------------------------------------------
// Case 6: generated rule without learning-key frontmatter is silently skipped
// (avoid false positives on malformed rules — the CLI gate covers these)
// ---------------------------------------------------------------------------

describe('generated-rule-staleness — rule without learning-key skipped silently', () => {
  it('does not warn when a generated rule has no learning-key field', () => {
    const rulesDir = makeRulesDir();
    const learningsDir = makeLearningsDir();

    // An auto-generated rule that is missing learning-key entirely.
    const content = [
      '---',
      'auto-generated: true',
      'globs: ["src/**"]',
      'expires-at: 2099-01-01',
      '---',
      '# No learning-key',
      '',
    ].join('\n');
    writeFileSync(join(rulesDir, 'no-key.md'), content, 'utf8');
    // Learnings file present but doesn't matter here.
    writeLearningsJsonl(learningsDir, []);

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    // Check ran (rule with auto-generated: true was found), but no warning.
    expect(j.checks_run).toContain('generated-rule-staleness');
    const staleWarnings = j.warnings.filter((w) => w.check === 'generated-rule-staleness');
    expect(staleWarnings).toHaveLength(0);
  });
});
