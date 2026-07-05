/**
 * tests/skills/claude-md-drift-check/rule-scoping.test.mjs
 *
 * Tests for Check 9 ("rule-scoping") inside
 * skills/claude-md-drift-check/checker.mjs (issue #722 Epic A).
 *
 * Behaviour under test:
 *   - paths-presence      → errors[]:   a top-level `paths:` frontmatter key.
 *   - cited-but-missing    → errors[]:   (a) CLAUDE.md/AGENTS.md citations of a
 *     `.claude/rules/<name>.md` file that does not exist on disk; (b) a rule's
 *     own "## See Also" footer citing a bare `<name>.md` token that does not
 *     exist in .claude/rules/.
 *   - zero-match-globs    → warnings[]: a `globs:` pattern matching 0 tracked
 *     files.
 *   - foreign-glob        → warnings[]: a glob containing a PascalCase
 *     product-like token.
 *   - silent-skip when `.claude/rules/` is absent (no checks_run entry, no
 *     checks_skipped entry).
 *   - `--skip-rule-scoping` suppression.
 *   - unreadable-file      → warnings[]: a rule file that cannot be read.
 *
 * Strategy mirrors generated-rule-staleness.test.mjs: spawn checker.mjs via
 * spawnSync with VAULT_DIR pointing at an ephemeral tmpdir, suppressing every
 * other check via --skip-* flags so only rule-scoping output needs assertion.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isRoot } from '../../_helpers/perms.mjs';

const CHECKER = resolve(process.cwd(), 'skills/claude-md-drift-check/checker.mjs');

// Suppress every other check family; rule-scoping is left enabled by default
// (each test that wants it disabled passes --skip-rule-scoping explicitly).
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
  const env = { ...process.env, VAULT_DIR: vaultDir, PATH: process.env.PATH };
  delete env.TYPECHECK_CMD;
  delete env.TEST_CMD;
  delete env.LINT_CMD;
  delete env.FILES;
  delete env.SESSION_START_REF;
  const r = spawnSync('node', [CHECKER, ...SKIP_OTHERS, ...extraArgs], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

function parseJson(out) {
  const line = out.trim().split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line);
}

let vault;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'drift-rule-scoping-'));
  writeFileSync(join(vault, 'CLAUDE.md'), '# Minimal\nNo paths here.\n');
});

afterEach(() => {
  if (vault && existsSync(vault)) rmSync(vault, { recursive: true, force: true });
});

function makeRulesDir() {
  const rulesDir = join(vault, '.claude', 'rules');
  mkdirSync(rulesDir, { recursive: true });
  return rulesDir;
}

// ---------------------------------------------------------------------------
// Probe 1 — paths-presence (error)
// ---------------------------------------------------------------------------

describe('rule-scoping — paths-presence probe', () => {
  it('reports an error when a rule declares a top-level paths: key', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'bad.md'), '---\npaths:\n  - src/**\n---\n\n# Bad Rule\n');

    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    expect(j.checks_run).toContain('rule-scoping');
    const errs = j.errors.filter((e) => e.check === 'rule-scoping' && e.extracted === 'paths:');
    expect(errs).toHaveLength(1);
    expect(errs[0].file).toBe('.claude/rules/bad.md');
  });

  it('reports paths: even when a provenance comment precedes frontmatter', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(
      join(rulesDir, 'bad.md'),
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/bad.md) -->\n---\npaths:\n  - src/**\n---\n\n# Bad Rule\n',
    );

    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'rule-scoping' && e.extracted === 'paths:');
    expect(errs).toHaveLength(1);
    expect(errs[0].file).toBe('.claude/rules/bad.md');
  });

  it('stays silent when the rule uses globs: instead of paths:', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'good.md'), '---\nglobs:\n  - src/**\n---\n\n# Good Rule\n');
    mkdirSync(join(vault, 'src'), { recursive: true });
    writeFileSync(join(vault, 'src', 'index.ts'), '// x\n');

    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.errors.filter((e) => e.check === 'rule-scoping')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 2a — cited-but-missing (CLAUDE.md / AGENTS.md citations)
// ---------------------------------------------------------------------------

describe('rule-scoping — cited-but-missing probe (instruction-file citation)', () => {
  it('reports an error when CLAUDE.md cites a .claude/rules/*.md file that does not exist', () => {
    makeRulesDir();
    writeFileSync(
      join(vault, 'CLAUDE.md'),
      '# Minimal\n\nSee `.claude/rules/nonexistent.md` for details.\n',
    );

    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'rule-scoping' && e.extracted === 'nonexistent.md');
    expect(errs).toHaveLength(1);
    expect(errs[0].file).toBe('CLAUDE.md');
    expect(errs[0].message).toContain('nonexistent.md');
  });

  it('stays silent when the cited file exists on disk', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'real.md'), '# Real Rule\n');
    writeFileSync(join(vault, 'CLAUDE.md'), '# Minimal\n\nSee `.claude/rules/real.md` for details.\n');

    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.errors.filter((e) => e.check === 'rule-scoping')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 2b — cited-but-missing (rule's own "## See Also" footer)
// ---------------------------------------------------------------------------

describe('rule-scoping — cited-but-missing probe (## See Also footer)', () => {
  it('reports an error per bare <name>.md token that does not exist in .claude/rules/', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(
      join(rulesDir, 'foo.md'),
      '# Foo Rule\n\nSome content.\n\n## See Also\nbar.md · baz.md\n',
    );

    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(1);
    const j = parseJson(r.stdout);
    const errs = j.errors.filter((e) => e.check === 'rule-scoping');
    expect(errs.map((e) => e.extracted).sort()).toEqual(['bar.md', 'baz.md']);
  });

  it('stays silent when every See Also citation exists in .claude/rules/', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'bar.md'), '# Bar Rule\n');
    writeFileSync(join(rulesDir, 'foo.md'), '# Foo Rule\n\nSome content.\n\n## See Also\nbar.md\n');

    const r = runChecker(vault, ['--mode', 'hard']);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.errors.filter((e) => e.check === 'rule-scoping')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 3 — zero-match-globs (warn)
// ---------------------------------------------------------------------------

describe('rule-scoping — zero-match-globs probe (warning)', () => {
  it('warns when a glob matches 0 tracked files', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'scoped.md'), '---\nglobs:\n  - src/nonexistent/**\n---\n\n# Scoped Rule\n');

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const warns = j.warnings.filter(
      (w) => w.check === 'rule-scoping' && w.extracted === 'src/nonexistent/**',
    );
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain('0 tracked files');
  });

  it('stays silent when the glob matches at least one tracked file', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'scoped.md'), '---\nglobs:\n  - src/**\n---\n\n# Scoped Rule\n');
    mkdirSync(join(vault, 'src'), { recursive: true });
    writeFileSync(join(vault, 'src', 'index.ts'), '// x\n');

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const warns = j.warnings.filter((w) => w.check === 'rule-scoping' && w.extracted === 'src/**');
    expect(warns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 4 — foreign-glob (warn)
// ---------------------------------------------------------------------------

describe('rule-scoping — foreign-glob probe (warning)', () => {
  it('warns when a glob contains a PascalCase product-like token', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'scoped.md'), '---\nglobs:\n  - src/FooBarTests/**\n---\n\n# Scoped Rule\n');
    mkdirSync(join(vault, 'src', 'FooBarTests'), { recursive: true });
    writeFileSync(join(vault, 'src', 'FooBarTests', 'index.ts'), '// x\n');

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const warns = j.warnings.filter((w) => w.check === 'rule-scoping' && w.message.includes('PascalCase'));
    expect(warns).toHaveLength(1);
    expect(warns[0].extracted).toBe('src/FooBarTests/**');
  });

  it('stays silent on a generic lowercase glob', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'scoped.md'), '---\nglobs:\n  - src/**\n---\n\n# Scoped Rule\n');
    mkdirSync(join(vault, 'src'), { recursive: true });
    writeFileSync(join(vault, 'src', 'index.ts'), '// x\n');

    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    const warns = j.warnings.filter((w) => w.check === 'rule-scoping' && w.message.includes('PascalCase'));
    expect(warns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Silent-skip when .claude/rules/ is absent
// ---------------------------------------------------------------------------

describe('rule-scoping — silent-skip when .claude/rules/ is absent', () => {
  it('does not appear in checks_run and is not listed in checks_skipped', () => {
    const r = runChecker(vault);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('rule-scoping');
    expect(j.checks_skipped.some((s) => s.startsWith('rule-scoping'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// --skip-rule-scoping suppression
// ---------------------------------------------------------------------------

describe('rule-scoping — --skip-rule-scoping suppression', () => {
  it('does not run the check and records an explicit-skip reason', () => {
    const rulesDir = makeRulesDir();
    writeFileSync(join(rulesDir, 'bad.md'), '---\npaths:\n  - src/**\n---\n\n# Bad Rule\n');

    const r = runChecker(vault, ['--skip-rule-scoping']);

    expect(r.code).toBe(0);
    const j = parseJson(r.stdout);
    expect(j.checks_run).not.toContain('rule-scoping');
    expect(j.checks_skipped).toContain('rule-scoping: explicitly skipped');
    expect(j.errors.filter((e) => e.check === 'rule-scoping')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 5 — unreadable-file (warn)
// ---------------------------------------------------------------------------

describe('rule-scoping — unreadable-file probe (warning)', () => {
  it.skipIf(isRoot)('warns when a rule file cannot be read (chmod 000)', () => {
    const rulesDir = makeRulesDir();
    const badPath = join(rulesDir, 'locked.md');
    writeFileSync(badPath, '# Locked Rule\n');
    chmodSync(badPath, 0o000);

    try {
      const r = runChecker(vault);

      expect(r.code).toBe(0);
      const j = parseJson(r.stdout);
      const warns = j.warnings.filter(
        (w) => w.check === 'rule-scoping' && w.file === '.claude/rules/locked.md',
      );
      expect(warns).toHaveLength(1);
      expect(warns[0].message).toContain('unreadable');
    } finally {
      chmodSync(badPath, 0o644);
    }
  });
});
