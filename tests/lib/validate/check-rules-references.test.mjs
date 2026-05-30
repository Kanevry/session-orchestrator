/**
 * tests/lib/validate/check-rules-references.test.mjs
 *
 * Tests for scripts/lib/validate/check-rules-references.mjs (#445).
 *
 * The validator asserts every bare-basename rule reference inside
 * `.claude/rules/*.md` resolves to an existing sibling rule file. It excludes
 * path-qualified refs, the file's own basename, and lines carrying the
 * `check-rules-references:ignore` marker. Exit 0 = all resolve, 1 = dangling
 * reference, 2 = tool error (rules dir unreadable).
 *
 * Two surfaces are exercised:
 *   - The exported `collectRuleReferences(rulesDir)` collector (pure) against
 *     tmpdir fixtures.
 *   - The full `runCheckRulesReferences(pluginRoot)` runner via spawnSync
 *     (exit-code + PASS/FAIL output shape) against tmpdir plugin roots, plus a
 *     load-bearing regression pin against the REAL repo `.claude/rules/`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  collectRuleReferences,
  runCheckRulesReferences,
} from '@lib/validate/check-rules-references.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-rules-references.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers — build a tmp plugin-root with .claude/rules/ scaffolding.
// ---------------------------------------------------------------------------

const tmpRoots = [];

/** Make a tmp plugin-root and return { root, rulesDir }. */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'check-rules-refs-'));
  tmpRoots.push(root);
  const rulesDir = join(root, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  return { root, rulesDir };
}

function writeRule(rulesDir, name, content) {
  writeFileSync(join(rulesDir, name), content, 'utf8');
}

/** Spawn the CLI against a plugin root; returns the spawnSync result. */
function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Test 1: a good (resolving) reference → PASS, exit 0
// ---------------------------------------------------------------------------

describe('check-rules-references — resolving reference', () => {
  it('collectRuleReferences records a See-Also ref to an existing sibling', () => {
    const { rulesDir } = makeFixture();
    writeRule(rulesDir, 'a.md', '# A\n\n## See Also\nfoo · b.md\n');
    writeRule(rulesDir, 'b.md', '# B\n');

    const refs = collectRuleReferences(rulesDir);

    expect(refs).toEqual([
      { ref: 'b.md', file: join(rulesDir, 'a.md'), line: 4 },
    ]);
  });

  it('runCheckRulesReferences exits 0 and emits a PASS line when the ref resolves', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(rulesDir, 'a.md', '# A\n\n## See Also\nfoo · b.md\n');
    writeRule(rulesDir, 'b.md', '# B\n');

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS: b.md (1 ref)');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
    expect(r.stdout).not.toContain('FAIL:');
  });
});

// ---------------------------------------------------------------------------
// Test 2: a dangling reference → FAIL, exit 1, FAIL line names the dead ref
// ---------------------------------------------------------------------------

describe('check-rules-references — dangling reference', () => {
  it('collectRuleReferences still records the dangling ref (resolution is the runner job)', () => {
    const { rulesDir } = makeFixture();
    writeRule(rulesDir, 'a.md', '# A\n\nrefs `nonexistent-rule.md` here\n');

    const refs = collectRuleReferences(rulesDir);

    expect(refs).toEqual([
      { ref: 'nonexistent-rule.md', file: join(rulesDir, 'a.md'), line: 3 },
    ]);
  });

  it('runCheckRulesReferences exits 1 and the FAIL line names the dangling ref + file:line', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(rulesDir, 'a.md', '# A\n\nrefs `nonexistent-rule.md` here\n');

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL: nonexistent-rule.md NOT FOUND in .claude/rules/');
    expect(r.stdout).toContain('.claude/rules/a.md:3');
    expect(r.stdout).toContain('Results: 0 passed, 1 failed');
  });
});

// ---------------------------------------------------------------------------
// Test 3: path-qualified refs are NOT flagged (out of this guard's scope)
// ---------------------------------------------------------------------------

describe('check-rules-references — path-qualified references excluded', () => {
  it('collectRuleReferences ignores `docs/api.md` and `skills/_shared/state-ownership.md`', () => {
    const { rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'a.md',
      '# A\n\nSee `docs/api.md` and `skills/_shared/state-ownership.md` for detail.\n',
    );

    const refs = collectRuleReferences(rulesDir);

    expect(refs).toEqual([]);
  });

  it('runCheckRulesReferences exits 0 — path-qualified refs never dangle this guard', () => {
    const { root, rulesDir } = makeFixture();
    // Both targets are deliberately absent from .claude/rules/; they must still
    // NOT be flagged because they are path-qualified (contain a slash).
    writeRule(
      rulesDir,
      'a.md',
      'See Also\n`docs/api.md` · `skills/_shared/state-ownership.md`\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
    expect(r.stdout).not.toContain('FAIL:');
    expect(r.stdout).not.toContain('api.md');
    expect(r.stdout).not.toContain('state-ownership.md');
  });
});

// ---------------------------------------------------------------------------
// Test 4: inline-ignore marker suppresses an otherwise-dangling ref
// ---------------------------------------------------------------------------

describe('check-rules-references — inline-ignore marker', () => {
  it('collectRuleReferences skips a line carrying check-rules-references:ignore', () => {
    const { rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'a.md',
      '# A\n\nhistorical `retired-rule.md` <!-- check-rules-references:ignore -->\n',
    );

    const refs = collectRuleReferences(rulesDir);

    expect(refs).toEqual([]);
  });

  it('runCheckRulesReferences exits 0 when a dead ref sits on an ignored line', () => {
    const { root, rulesDir } = makeFixture();
    writeRule(
      rulesDir,
      'a.md',
      '# A\n\nhistorical `retired-rule.md` <!-- check-rules-references:ignore -->\n',
    );

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('retired-rule.md');
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Test 5: tool-error path — rules dir absent → exit 2
// ---------------------------------------------------------------------------

describe('check-rules-references — tool-error path', () => {
  it('runCheckRulesReferences returns 2 when the rules dir does not exist (in-process)', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-rules-refs-norules-'));
    tmpRoots.push(root);
    // No .claude/rules/ directory created → tool error.

    const code = runCheckRulesReferences(root);

    expect(code).toBe(2);
  });

  it('CLI exits 2 and writes a tool-error to stderr when the rules dir is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-rules-refs-norules-cli-'));
    tmpRoots.push(root);

    const r = run(root);

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('tool-error: rules directory not found');
  });

  it('CLI exits 2 when no plugin-root argument is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: check-rules-references.mjs <plugin-root>');
  });
});

// ---------------------------------------------------------------------------
// Test 6: REGRESSION PIN (load-bearing) — real repo .claude/rules/ must resolve
//
// This pins the W2 cleanup that removed the dangling `security-compliance.md`,
// `ai-agent.md`, `infrastructure.md`, and `observability.md` See-Also refs.
// If any future rule edit re-introduces a dangling bare-basename ref, this test
// fails — the guard cannot silently regress.
// ---------------------------------------------------------------------------

describe('check-rules-references — REGRESSION PIN against the real repo', () => {
  it('the real .claude/rules/ has zero dangling bare-basename refs (exit 0)', () => {
    const r = run(REPO_ROOT);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL:');
    expect(r.stdout).toMatch(/Results: \d+ passed, 0 failed/);
  });

  it('none of the historically-dangling targets reappear as a FAIL', () => {
    const r = run(REPO_ROOT);

    // These four basenames were the original #445 dangling refs. The guard must
    // never re-flag them — i.e. they are either absent or now vendored.
    expect(r.stdout).not.toContain('security-compliance.md NOT FOUND');
    expect(r.stdout).not.toContain('ai-agent.md NOT FOUND');
    expect(r.stdout).not.toContain('infrastructure.md NOT FOUND');
    expect(r.stdout).not.toContain('observability.md NOT FOUND');
  });
});
