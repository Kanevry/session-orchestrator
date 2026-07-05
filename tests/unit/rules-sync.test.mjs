/**
 * tests/unit/rules-sync.test.mjs
 *
 * Vitest tests for scripts/lib/rules-sync.mjs
 * Issue #191 — canonical rules library + /bootstrap --sync-rules
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncRules } from '@lib/rules-sync.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// NOTE: `new URL(...)` does NOT resolve vitest's `@lib` alias — it does standard
// URL resolution. SCRIPT_PATH is passed to a spawned child Node process that has
// no `@lib` alias either. Keep this string as a raw relative path (#407 exempt).
const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/lib/rules-sync.mjs', import.meta.url));

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'rules-sync-'));
}

/**
 * Creates a minimal fake plugin root with a valid _index.md and the three always-on rule files.
 * Returns the pluginRoot path.
 */
function makeFakePluginRoot(dir) {
  const rulesDir = join(dir, 'rules', 'always-on');
  mkdirSync(rulesDir, { recursive: true });

  writeFileSync(
    join(dir, 'rules', '_index.md'),
    [
      '# Rules Library — Canonical Index',
      '',
      '## always-on (vendored to every consumer repo)',
      '',
      '- `always-on/parallel-sessions.md` — PSA-001/002/003/004 multi-session discipline',
      '- `always-on/commit-discipline.md` — atomic commits, stage-by-name, no `git add .`',
      '- `always-on/npm-quality-gates.md` — the typecheck + test + lint triad before commit',
      '',
      '## opt-in-stack (vendored on match)',
      '',
      '(none yet)',
    ].join('\n'),
  );

  for (const name of ['parallel-sessions.md', 'commit-discipline.md', 'npm-quality-gates.md']) {
    writeFileSync(
      join(rulesDir, name),
      `<!-- source: session-orchestrator plugin (canonical: rules/always-on/${name}) -->\n# Rule: ${name}\n\nContent for ${name}.\n`,
    );
  }

  return dir;
}

/**
 * Spawn the rules-sync CLI with given args.
 * Returns { stdout, stderr, status }.
 */
function runCLI(args = []) {
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    timeout: 20000,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let dirs = [];

function tmp() {
  const d = makeTmp();
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  dirs = [];
});

// ---------------------------------------------------------------------------
// Test 1 — Fresh consumer repo → always-on files copied
// ---------------------------------------------------------------------------

describe('syncRules — fresh consumer repo', () => {
  it('copies all 3 always-on rules, written=3, skipped=0, preserved=0, errors=0', () => {
    const pluginRoot = makeFakePluginRoot(tmp());
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.written).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
    expect(result.preserved).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    // Verify all three files exist in the consumer repo
    const rulesDir = join(repoRoot, '.claude', 'rules');
    for (const name of ['parallel-sessions.md', 'commit-discipline.md', 'npm-quality-gates.md']) {
      const content = readFileSync(join(rulesDir, name), 'utf8');
      expect(content).toContain('<!-- source: session-orchestrator plugin');
    }
  });
});

// ---------------------------------------------------------------------------
// Test 2 — Re-run on same consumer (files up to date) → written=0, no errors
// ---------------------------------------------------------------------------

describe('syncRules — re-run idempotency', () => {
  it('second run: written=0, skipped=3, preserved=0, errors=0', () => {
    const pluginRoot = makeFakePluginRoot(tmp());
    const repoRoot = tmp();

    // First run
    syncRules({ pluginRoot, repoRoot });
    // Second run
    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toHaveLength(3);
    expect(result.preserved).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — Consumer has local rule without plugin header → preserved
// ---------------------------------------------------------------------------

describe('syncRules — local rule preservation', () => {
  it('does not overwrite a rule file that lacks the plugin source header', () => {
    const pluginRoot = makeFakePluginRoot(tmp());
    const repoRoot = tmp();

    // Pre-create a local parallel-sessions.md without the plugin header
    const rulesDir = join(repoRoot, '.claude', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const localContent = '# My Custom Parallel Sessions Rule\n\nThis is locally maintained.\n';
    writeFileSync(join(rulesDir, 'parallel-sessions.md'), localContent);

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.preserved).toContain('parallel-sessions.md');
    // Other two files should still be written
    expect(result.written).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    // Local file must not be overwritten
    const actual = readFileSync(join(rulesDir, 'parallel-sessions.md'), 'utf8');
    expect(actual).toBe(localContent);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — Consumer has plugin-header rule with stale content → overwritten
// ---------------------------------------------------------------------------

describe('syncRules — stale plugin-owned rule overwrite', () => {
  it('overwrites a plugin-owned rule that has stale content', () => {
    const pluginRoot = makeFakePluginRoot(tmp());
    const repoRoot = tmp();

    // Pre-create a stale version of commit-discipline.md with plugin header
    const rulesDir = join(repoRoot, '.claude', 'rules');
    mkdirSync(rulesDir, { recursive: true });
    const staleContent =
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/commit-discipline.md) -->\n# Old content\n';
    writeFileSync(join(rulesDir, 'commit-discipline.md'), staleContent);

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.written).toContain('commit-discipline.md');
    expect(result.preserved).not.toContain('commit-discipline.md');
    expect(result.errors).toHaveLength(0);

    // Content should now match the source
    const srcContent = readFileSync(
      join(pluginRoot, 'rules', 'always-on', 'commit-discipline.md'),
      'utf8',
    );
    const actual = readFileSync(join(rulesDir, 'commit-discipline.md'), 'utf8');
    expect(actual).toBe(srcContent);
  });
});

// ---------------------------------------------------------------------------
// Test 5 — Dry-run mode → result computed, files NOT touched
// ---------------------------------------------------------------------------

describe('syncRules — dry-run mode', () => {
  it('returns computed result but does not write any files', () => {
    const pluginRoot = makeFakePluginRoot(tmp());
    const repoRoot = tmp();
    const rulesDir = join(repoRoot, '.claude', 'rules');

    const result = syncRules({ pluginRoot, repoRoot, dryRun: true });

    // Result says files would be written
    expect(result.written).toHaveLength(3);
    expect(result.errors).toHaveLength(0);

    // But no files actually exist
    for (const name of ['parallel-sessions.md', 'commit-discipline.md', 'npm-quality-gates.md']) {
      let exists = true;
      try {
        statSync(join(rulesDir, name));
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }
  });

  it('dry-run does not modify existing files (mtime check)', () => {
    const pluginRoot = makeFakePluginRoot(tmp());
    const repoRoot = tmp();
    const rulesDir = join(repoRoot, '.claude', 'rules');

    // First real run to create the files
    syncRules({ pluginRoot, repoRoot });

    // Patch source to differ from target
    const srcPath = join(pluginRoot, 'rules', 'always-on', 'npm-quality-gates.md');
    const origSrc = readFileSync(srcPath, 'utf8');
    writeFileSync(srcPath, origSrc + '\n<!-- updated -->\n', 'utf8');

    const targetPath = join(rulesDir, 'npm-quality-gates.md');
    const mtimeBefore = statSync(targetPath).mtimeMs;

    // Dry-run should not touch target
    syncRules({ pluginRoot, repoRoot, dryRun: true });

    const mtimeAfter = statSync(targetPath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

// ---------------------------------------------------------------------------
// Test 6 — Missing _index.md → returns error, CLI exits 1
// ---------------------------------------------------------------------------

describe('syncRules — missing _index.md', () => {
  it('returns errors array with one entry when _index.md is absent', () => {
    const pluginRoot = tmp(); // no rules/_index.md
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('_index.md');
    expect(result.written).toHaveLength(0);
  });
});

// Test 6 CLI variant: the CLI resolves pluginRoot from the script location (real plugin root).
// The unit-level test above covers the "missing _index.md" API path.
// The CLI's own exit-1 path is verified via the --repo-root missing test (test 8 below).

// ---------------------------------------------------------------------------
// Test 7 — Corrupted _index.md (no ## always-on section) → errors for zero sources
// ---------------------------------------------------------------------------

describe('syncRules — corrupted _index.md', () => {
  it('returns errors when _index.md has no matching category section', () => {
    const pluginRoot = tmp();
    mkdirSync(join(pluginRoot, 'rules'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      '# Rules Library\n\nNo category sections here.\n',
    );
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].reason).toMatch(/no sources resolved/);
    expect(result.written).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pre-write validation gate (issue #722 Epic A Wave 2) — validate: true default
// ---------------------------------------------------------------------------

describe('syncRules — pre-write validation gate', () => {
  it('blocks the write and records an error for a file with an error-severity violation', () => {
    const pluginRoot = tmp();
    const rulesDir = join(pluginRoot, 'rules', 'always-on');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      [
        '# Rules Library — Canonical Index',
        '',
        '## always-on (vendored to every consumer repo)',
        '',
        '- `always-on/bad-rule.md` — a rule with a paths: mistake',
        '- `always-on/good-rule.md` — a clean rule',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(rulesDir, 'bad-rule.md'),
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/bad-rule.md) -->\n---\npaths:\n  - src/**\n---\n\n# Bad Rule\n',
    );
    writeFileSync(
      join(rulesDir, 'good-rule.md'),
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/good-rule.md) -->\n# Good Rule\n\nClean content.\n',
    );
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].file).toBe('rules/always-on/bad-rule.md');
    expect(result.errors[0].reason).toContain('validation-failed');
    expect(result.written).toEqual(['good-rule.md']);

    let exists = true;
    try {
      statSync(join(repoRoot, '.claude', 'rules', 'bad-rule.md'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('does not block the write for a warn-severity violation but surfaces it in warnings[]', () => {
    const pluginRoot = tmp();
    const rulesDir = join(pluginRoot, 'rules', 'always-on');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      [
        '# Rules Library — Canonical Index',
        '',
        '## always-on (vendored to every consumer repo)',
        '',
        '- `always-on/warn-rule.md` — a rule with a foreign glob',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(rulesDir, 'warn-rule.md'),
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/warn-rule.md) -->\n---\nglobs:\n  - src/FooBarTests/**\n---\n\n# Warn Rule\n',
    );
    const repoRoot = tmp();
    // Give the repo a matching file so only foreign-glob fires (not zero-match-globs too).
    mkdirSync(join(repoRoot, 'src', 'FooBarTests'), { recursive: true });
    writeFileSync(join(repoRoot, 'src', 'FooBarTests', 'index.ts'), '// x\n');

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.errors).toHaveLength(0);
    expect(result.written).toContain('warn-rule.md');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].file).toBe('rules/always-on/warn-rule.md');
    expect(result.warnings[0].reason).toContain('foreign-glob');
  });

  it('validate: false restores pre-Wave-2 behavior — writes even a paths: violating file', () => {
    const pluginRoot = tmp();
    const rulesDir = join(pluginRoot, 'rules', 'always-on');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      [
        '# Rules Library — Canonical Index',
        '',
        '## always-on (vendored to every consumer repo)',
        '',
        '- `always-on/bad-rule.md` — a rule with a paths: mistake',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(rulesDir, 'bad-rule.md'),
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/bad-rule.md) -->\n---\npaths:\n  - src/**\n---\n\n# Bad Rule\n',
    );
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot, validate: false });

    expect(result.errors).toHaveLength(0);
    expect(result.written).toContain('bad-rule.md');
  });

  it('requireProvenance: false permits a headerless source file to pass the gate', () => {
    const pluginRoot = tmp();
    const rulesDir = join(pluginRoot, 'rules', 'always-on');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      [
        '# Rules Library — Canonical Index',
        '',
        '## always-on (vendored to every consumer repo)',
        '',
        '- `always-on/headerless.md` — a rule without a provenance header',
        '',
      ].join('\n'),
    );
    writeFileSync(join(rulesDir, 'headerless.md'), '# Headerless Rule\n\nClean content, no header.\n');
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot, requireProvenance: false });

    expect(result.errors).toHaveLength(0);
    expect(result.written).toContain('headerless.md');
  });

  it('requireProvenance default (true) blocks a headerless source file', () => {
    const pluginRoot = tmp();
    const rulesDir = join(pluginRoot, 'rules', 'always-on');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      [
        '# Rules Library — Canonical Index',
        '',
        '## always-on (vendored to every consumer repo)',
        '',
        '- `always-on/headerless.md` — a rule without a provenance header',
        '',
      ].join('\n'),
    );
    writeFileSync(join(rulesDir, 'headerless.md'), '# Headerless Rule\n\nClean content, no header.\n');
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain('provenance-header');
  });
});

// ---------------------------------------------------------------------------
// Archetype filtering (issue #722 Epic A Wave 3)
// ---------------------------------------------------------------------------

describe('syncRules — archetype filtering', () => {
  function makeArchetypeFixture() {
    const pluginRoot = tmp();
    const rulesDir = join(pluginRoot, 'rules', 'opt-in-stack');
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      [
        '# Rules Library — Canonical Index',
        '',
        '## opt-in-stack (vendored on match)',
        '',
        '- `opt-in-stack/nextjs-only.md` — a Next.js-specific rule [archetypes: nextjs-minimal, nextjs-saas]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(rulesDir, 'nextjs-only.md'),
      '<!-- source: session-orchestrator plugin (canonical: rules/opt-in-stack/nextjs-only.md) -->\n# Next.js Only Rule\n\nClean content.\n',
    );
    return pluginRoot;
  }

  it('vendors a scoped entry when the explicit archetype arg matches', () => {
    const pluginRoot = makeArchetypeFixture();
    const repoRoot = tmp();

    const result = syncRules({
      pluginRoot,
      repoRoot,
      categories: ['opt-in-stack'],
      archetype: 'nextjs-minimal',
    });

    expect(result.written).toContain('nextjs-only.md');
    expect(result.skipped).toHaveLength(0);
  });

  it('skips a scoped entry with reason archetype-mismatch when the explicit archetype does not match', () => {
    const pluginRoot = makeArchetypeFixture();
    const repoRoot = tmp();

    const result = syncRules({
      pluginRoot,
      repoRoot,
      categories: ['opt-in-stack'],
      archetype: 'python-uv',
    });

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      file: 'rules/opt-in-stack/nextjs-only.md',
      reason: 'archetype-mismatch',
    });
  });

  it('skips a scoped entry with reason archetype-unknown when no archetype can be resolved', () => {
    const pluginRoot = makeArchetypeFixture();
    const repoRoot = tmp(); // no .orchestrator/bootstrap.lock, no explicit archetype

    const result = syncRules({ pluginRoot, repoRoot, categories: ['opt-in-stack'] });

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      file: 'rules/opt-in-stack/nextjs-only.md',
      reason: 'archetype-unknown',
    });
  });

  it('resolves the archetype from .orchestrator/bootstrap.lock when no explicit arg is given', () => {
    const pluginRoot = makeArchetypeFixture();
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, '.orchestrator', 'bootstrap.lock'), 'archetype: nextjs-saas\n');

    const result = syncRules({ pluginRoot, repoRoot, categories: ['opt-in-stack'] });

    expect(result.written).toContain('nextjs-only.md');
  });

  it('skips a scoped entry with archetype-unknown when bootstrap.lock has archetype: null', () => {
    const pluginRoot = makeArchetypeFixture();
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, '.orchestrator', 'bootstrap.lock'), 'archetype: null\n');

    const result = syncRules({ pluginRoot, repoRoot, categories: ['opt-in-stack'] });

    expect(result.written).toHaveLength(0);
    expect(result.skipped).toContainEqual({
      file: 'rules/opt-in-stack/nextjs-only.md',
      reason: 'archetype-unknown',
    });
  });

  it('a universal (untagged) entry still vendors regardless of archetype resolution', () => {
    const pluginRoot = makeFakePluginRoot(tmp());
    const repoRoot = tmp(); // no bootstrap.lock, no explicit archetype

    const result = syncRules({ pluginRoot, repoRoot });

    // All 3 always-on entries in makeFakePluginRoot are untagged (universal).
    expect(result.written).toHaveLength(3);
    expect(result.skipped).toHaveLength(0);
  });

  it('defaults to every manifest category with entries, including matching opt-in rules', () => {
    const pluginRoot = makeArchetypeFixture();
    const repoRoot = tmp();

    const result = syncRules({
      pluginRoot,
      repoRoot,
      archetype: 'nextjs-minimal',
    });

    expect(result.errors).toHaveLength(0);
    expect(result.written).toContain('nextjs-only.md');
  });

  it('parses quoted bootstrap.lock archetype values with inline comments', () => {
    const pluginRoot = makeArchetypeFixture();
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(repoRoot, '.orchestrator', 'bootstrap.lock'),
      'archetype: "nextjs-saas" # selected by bootstrap\n',
    );

    const result = syncRules({ pluginRoot, repoRoot, categories: ['opt-in-stack'] });

    expect(result.errors).toHaveLength(0);
    expect(result.written).toContain('nextjs-only.md');
  });

  it('reports duplicate target filenames across applicable manifest categories', () => {
    const pluginRoot = tmp();
    mkdirSync(join(pluginRoot, 'rules', 'always-on'), { recursive: true });
    mkdirSync(join(pluginRoot, 'rules', 'opt-in-stack'), { recursive: true });
    writeFileSync(
      join(pluginRoot, 'rules', '_index.md'),
      [
        '# Rules Library — Canonical Index',
        '',
        '## always-on (vendored to every consumer repo)',
        '',
        '- `always-on/shared.md` — universal rule',
        '',
        '## opt-in-stack (vendored on match)',
        '',
        '- `opt-in-stack/shared.md` — stack rule [archetypes: nextjs-minimal]',
        '',
      ].join('\n'),
    );
    for (const rel of ['always-on/shared.md', 'opt-in-stack/shared.md']) {
      writeFileSync(
        join(pluginRoot, 'rules', rel),
        `<!-- source: session-orchestrator plugin (canonical: rules/${rel}) -->\n# Rule\n\nContent.\n`,
      );
    }
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot, archetype: 'nextjs-minimal' });

    expect(result.errors.some((e) => e.reason.includes('duplicate target filename'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 8 — CLI with missing --repo-root flag → exit 1, stderr hint
// ---------------------------------------------------------------------------

describe('CLI — missing --repo-root', { timeout: 30000 }, () => {
  it('exits with status 1 and writes a hint to stderr', () => {
    const { stderr, status } = runCLI([]);
    expect(status).toBe(1);
    expect(stderr).toContain('--repo-root');
  });
});

// ---------------------------------------------------------------------------
// CLI integration — happy path
// ---------------------------------------------------------------------------

describe('CLI — happy path with real plugin root', () => {
  it('exits 0 and outputs valid JSON with written array', () => {
    const repoRoot = tmp();
    const { stdout, status } = runCLI(['--repo-root', repoRoot]);
    expect(status).toBe(0);

    let parsed;
    expect(() => {
      parsed = JSON.parse(stdout);
    }).not.toThrow();

    expect(Array.isArray(parsed.written)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
    expect(Array.isArray(parsed.preserved)).toBe(true);
    expect(Array.isArray(parsed.errors)).toBe(true);
    // Real plugin has 3 always-on rules
    expect(parsed.written).toHaveLength(3);
    expect(parsed.errors).toHaveLength(0);
  });

  it('dry-run flag exits 0 and reports written without creating files', () => {
    const repoRoot = tmp();
    const { stdout, status } = runCLI(['--repo-root', repoRoot, '--dry-run']);
    expect(status).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.written).toHaveLength(3);

    // No files should have been created
    let exists = true;
    try {
      statSync(join(repoRoot, '.claude', 'rules', 'parallel-sessions.md'));
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});
