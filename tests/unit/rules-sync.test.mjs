/**
 * tests/unit/rules-sync.test.mjs
 *
 * Vitest tests for scripts/lib/rules-sync.mjs
 * Issue #191 — canonical rules library + /bootstrap --sync-rules
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncRules, scanVendoringLeaks } from '@lib/rules-sync.mjs';

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

/**
 * Basenames registered under `## always-on` in the LIVE rules/_index.md.
 *
 * Derived, never hand-typed: three assertions below used to carry a literal
 * `3`, which turned "the library grew" into a red test (issue #1098 added 8
 * entries and broke all three). A count that describes the corpus has to be
 * read from the corpus.
 * @returns {string[]}
 */
function liveAlwaysOnBasenames() {
  const index = readFileSync(
    fileURLToPath(new URL('../../rules/_index.md', import.meta.url)),
    'utf8',
  );
  const start = /^##\s+always-on\b[^\n]*$/m.exec(index);
  if (!start) return [];
  const rest = index.slice(start.index + start[0].length);
  const next = /^##\s+/m.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  return [...body.matchAll(/^-\s+`always-on\/([^`]+\.md)`/gm)].map((m) => m[1]);
}

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
    // Count comes from rules/_index.md, not from a literal — see
    // liveAlwaysOnBasenames() for why.
    expect(parsed.written.sort()).toEqual(liveAlwaysOnBasenames().sort());
    expect(parsed.errors).toHaveLength(0);
  });

  it('dry-run flag exits 0 and reports written without creating files', () => {
    const repoRoot = tmp();
    const { stdout, status } = runCLI(['--repo-root', repoRoot, '--dry-run']);
    expect(status).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.written.sort()).toEqual(liveAlwaysOnBasenames().sort());

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

// ---------------------------------------------------------------------------
// Issue #1060 — two rival vendoring paths wrote the same target file.
//
// Before the fix, `/bootstrap` vendored .claude/rules/parallel-sessions.md by a
// literal `cp` from templates/_shared/rules/ (PSA-001..006), while
// `/bootstrap --sync-rules` vendored the SAME target from rules/always-on/
// (PSA-001..004). Running bootstrap and then --sync-rules silently downgraded a
// consumer repo by two rules, with no error and no diff the operator would see.
//
// These tests pin the invariant that broke: whatever the canonical rules/ copy
// delivers must never carry FEWER PSA codes than the bootstrap path used to.
// ---------------------------------------------------------------------------

// PSA codes the pre-#1060 bootstrap path (templates/_shared/rules/) delivered.
const BOOTSTRAP_PSA_FLOOR = [
  'PSA-001',
  'PSA-002',
  'PSA-003',
  'PSA-004',
  'PSA-005',
  'PSA-006',
];

// The mechanical contract floor asserted by the harness audit's c7.3
// `parallel-sessions-rules` check (scripts/lib/harness-audit/categories/category7.mjs).
const HARNESS_AUDIT_PSA_FLOOR = ['PSA-001', 'PSA-002', 'PSA-003', 'PSA-004'];

const REAL_PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** @param {string} text @returns {string[]} sorted unique PSA codes found in text */
function psaCodes(text) {
  return [...new Set(text.match(/PSA-00\d/g) ?? [])].sort();
}

describe('syncRules — #1060 bootstrap-then-sync must not reduce PSA coverage', () => {
  it('vendors every PSA code the bootstrap path used to deliver', () => {
    const repoRoot = tmp();

    // Bootstrap Step 3a — now itself a rules-sync call (skills/bootstrap/*-template.md).
    const bootstrap = syncRules({ pluginRoot: REAL_PLUGIN_ROOT, repoRoot });
    expect(bootstrap.errors).toEqual([]);

    const target = join(repoRoot, '.claude', 'rules', 'parallel-sessions.md');
    const afterBootstrap = psaCodes(readFileSync(target, 'utf8'));

    // `/bootstrap --sync-rules` over the same repo — the second writer in #1060.
    const resync = syncRules({ pluginRoot: REAL_PLUGIN_ROOT, repoRoot });
    expect(resync.errors).toEqual([]);

    const afterResync = psaCodes(readFileSync(target, 'utf8'));

    // The regression: the re-sync silently REMOVED PSA codes from the target.
    for (const code of afterBootstrap) {
      expect(afterResync).toContain(code);
    }

    // And the absolute floor — the canonical copy may never fall below what the
    // deleted templates/_shared/rules/ copy delivered, nor below the audit floor.
    for (const code of BOOTSTRAP_PSA_FLOOR) {
      expect(afterResync).toContain(code);
    }
    for (const code of HARNESS_AUDIT_PSA_FLOOR) {
      expect(afterResync).toContain(code);
    }
  });

  it('leaves no second writer to .claude/rules/ in the bootstrap templates', () => {
    // Catches the reintroduction of a literal `cp` into .claude/rules/. Such a
    // copy bypasses the pre-write validator AND lands a file with no
    // `<!-- source: session-orchestrator plugin ... -->` header — which the next
    // --sync-rules classifies as a repo-private override and preserves forever,
    // so the plugin can never update that rule again.
    const CP_INTO_RULES = /^\s*cp\s+.*\.claude\/rules/m;

    for (const rel of ['skills/bootstrap/_shared-template.md', 'skills/bootstrap/fast-template.md']) {
      const body = readFileSync(join(REAL_PLUGIN_ROOT, rel), 'utf8');
      expect(body, `${rel} must not cp into .claude/rules/`).not.toMatch(CP_INTO_RULES);
      expect(body, `${rel} must vendor rules via rules-sync.mjs`).toContain('rules-sync.mjs');
    }

    // The rival source directory itself must stay gone.
    expect(
      existsSync(join(REAL_PLUGIN_ROOT, 'templates/_shared/rules/parallel-sessions.md')),
      'templates/_shared/rules/parallel-sessions.md was deleted in #1060 — do not restore it',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Vendoring sanitizer (issue #1098)
//
// Bug class this covers: a rule that reads correctly INSIDE this plugin repo
// (it cites `scripts/lib/x.mjs`, or a `## See Also` sibling that lives only in
// `.claude/rules/`) is vendored verbatim into a consumer repo, where both
// citations dangle. Before #1098 nothing reported that, and — the harder half —
// nothing guaranteed the report stays a REPORT: a sanitizer that "helpfully"
// stripped the offending text would silently change a rule's meaning at
// vendoring time, invisible to author and consumer alike.
// ---------------------------------------------------------------------------

/**
 * Fake plugin root carrying ONE always-on rule whose body is supplied by the
 * caller, plus a real `scripts/lib/fake-helper.mjs` file so the repo-local
 * probe has something to resolve against.
 */
function makeSanitizerPluginRoot(dir, ruleBody) {
  mkdirSync(join(dir, 'rules', 'always-on'), { recursive: true });
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'scripts', 'lib', 'fake-helper.mjs'), 'export const x = 1;\n');
  writeFileSync(
    join(dir, 'rules', '_index.md'),
    [
      '# Rules Library — Canonical Index',
      '',
      '## always-on (vendored to every consumer repo)',
      '',
      '- `always-on/sample.md` — the rule under test',
      '- `always-on/sibling.md` — a registered sibling, so See-Also to it resolves',
      '',
    ].join('\n'),
  );
  const header = '<!-- source: session-orchestrator plugin (canonical: rules/always-on/%s) -->\n';
  writeFileSync(join(dir, 'rules', 'always-on', 'sample.md'), header.replace('%s', 'sample.md') + ruleBody);
  writeFileSync(
    join(dir, 'rules', 'always-on', 'sibling.md'),
    header.replace('%s', 'sibling.md') + '# Sibling\n\nContent.\n',
  );
  return dir;
}

describe('syncRules — vendoring sanitizer reports without altering content', () => {
  it('reports a planted repo-local path and still writes the file byte-for-byte unchanged', () => {
    const pluginRoot = tmp();
    const repoRoot = tmp();
    const body = [
      '# Sample Rule',
      '',
      'See `scripts/lib/fake-helper.mjs` for the implementation.',
      '',
    ].join('\n');
    makeSanitizerPluginRoot(pluginRoot, body);

    const result = syncRules({ pluginRoot, repoRoot });

    // The finding is reported, with the exact citation and its line.
    const leaks = result.sanitizer.filter((f) => f.kind === 'repo-local-path');
    expect(leaks).toEqual([
      {
        file: 'rules/always-on/sample.md',
        line: 4, // provenance header is line 1, '# Sample Rule' line 2
        kind: 'repo-local-path',
        text: 'scripts/lib/fake-helper.mjs',
      },
    ]);

    // …and it is a REPORT, not a rewrite: the write happened, no error was
    // raised, and the bytes on the target are identical to the source. Compared
    // against the source file read from disk rather than against the `body`
    // string, so the assertion cannot be satisfied by a sanitizer that mangles
    // BOTH sides identically.
    expect(result.errors).toEqual([]);
    expect(result.written).toContain('sample.md');
    const src = readFileSync(join(pluginRoot, 'rules', 'always-on', 'sample.md'), 'utf8');
    const written = readFileSync(join(repoRoot, '.claude', 'rules', 'sample.md'), 'utf8');
    expect(written).toBe(src);
    expect(written).toContain('scripts/lib/fake-helper.mjs');
  });

  it('does NOT report a path that merely shares a plugin root prefix but resolves to no plugin file', () => {
    // The naive form of this probe is a prefix grep for `docs/`/`tests/`/…,
    // which floods the report with consumer-repo paths and code samples —
    // enough noise that a real leak is never read. The probe therefore requires
    // the citation to resolve to an actual FILE under pluginRoot.
    const pluginRoot = tmp();
    const repoRoot = tmp();
    const body = [
      '# Sample Rule',
      '',
      'Document the event catalog in `docs/api.md`; `tests/` may import SDKs directly.',
      'Package scope placeholders such as `@your-org/http-client` are the documented convention.',
      'An eslint directive like `react-hooks/exhaustive-deps` is not a path at all.',
      '',
    ].join('\n');
    makeSanitizerPluginRoot(pluginRoot, body);

    const result = syncRules({ pluginRoot, repoRoot });

    expect(result.sanitizer.filter((f) => f.kind === 'repo-local-path')).toEqual([]);
  });

  it('reports an unresolvable See-Also citation and stays silent on a registered one', () => {
    const pluginRoot = tmp();
    const repoRoot = tmp();
    const body = [
      '# Sample Rule',
      '',
      'Body.',
      '',
      '## See Also',
      '',
      'sibling.md · never-vendored.md · CLAUDE.md',
      '',
    ].join('\n');
    makeSanitizerPluginRoot(pluginRoot, body);

    const result = syncRules({ pluginRoot, repoRoot });

    const seeAlso = result.sanitizer.filter((f) => f.kind === 'unresolvable-see-also');
    // `sibling.md` is registered in _index.md; `CLAUDE.md` is a project-root
    // instruction file every consumer has, not a rule that travels through the
    // sync. Only `never-vendored.md` dangles.
    expect(seeAlso.map((f) => f.text)).toEqual(['never-vendored.md']);
    expect(seeAlso[0].file).toBe('rules/always-on/sample.md');
    expect(result.errors).toEqual([]);
  });

  it('scanVendoringLeaks() is pure — it returns findings and never touches the input string', () => {
    const pluginRoot = tmp();
    makeSanitizerPluginRoot(pluginRoot, '# x\n');
    const content = 'See `scripts/lib/fake-helper.mjs`.\n';
    const before = String(content);

    const findings = scanVendoringLeaks({
      content,
      relPath: 'rules/always-on/sample.md',
      pluginRoot,
      manifestBasenames: new Set(['sample.md']),
    });

    expect(findings).toHaveLength(1);
    expect(content).toBe(before);
  });
});

describe('syncRules — the always-on library vendors clean (issue #1098 AC)', () => {
  it('reports 0 repo-local paths and 0 unresolvable See-Also citations for always-on', () => {
    // Measures the LIVE rules/ library on purpose: the acceptance criterion of
    // #1098 is a property of that corpus, not of a fixture. Scoped to
    // `always-on` because that is the category the issue registered; the
    // archetype-scoped categories carry pre-existing findings that are reported,
    // never fixed silently.
    const pluginRoot = fileURLToPath(new URL('../..', import.meta.url));
    const repoRoot = tmp();

    const result = syncRules({ pluginRoot, repoRoot, categories: ['always-on'] });

    expect(result.errors).toEqual([]);
    expect(result.sanitizer).toEqual([]);
    expect(result.written.sort()).toEqual(liveAlwaysOnBasenames().sort());
  });
});
