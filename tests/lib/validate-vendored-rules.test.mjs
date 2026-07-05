/**
 * tests/lib/validate-vendored-rules.test.mjs
 *
 * Unit tests for scripts/lib/validate-vendored-rules.mjs — issue #722 Epic A
 * Wave 2. Covers the 5 vendoring probes (paths-frontmatter, provenance-header,
 * placeholder, zero-match-globs, foreign-glob), validateRulesDir(), the CLI's
 * exit-code contract, and the mandatory PLUGIN_HEADER_PREFIX identity guard
 * against scripts/lib/rules-sync.mjs's textually-duplicated copy.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRuleContent, validateRulesDir } from '@lib/validate-vendored-rules.mjs';
import { PLUGIN_HEADER_PREFIX } from '@lib/rules-sync.mjs';

// NOTE: `new URL(...)` does NOT resolve vitest's `@lib` alias — it does standard
// URL resolution. SCRIPT_PATH is passed to a spawned child Node process that has
// no `@lib` alias either. Keep this string as a raw relative path (#407 exempt).
const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/lib/validate-vendored-rules.mjs', import.meta.url));
const VALIDATOR_SOURCE_PATH = fileURLToPath(new URL('../../scripts/lib/validate-vendored-rules.mjs', import.meta.url));

// ---------------------------------------------------------------------------
// Fixture management
// ---------------------------------------------------------------------------

const tmpDirs = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'validate-vendored-rules-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

function runCLI(args = []) {
  const env = { ...process.env };
  delete env.TYPECHECK_CMD;
  delete env.TEST_CMD;
  delete env.LINT_CMD;
  delete env.FILES;
  delete env.SESSION_START_REF;
  const result = spawnSync(process.execPath, [SCRIPT_PATH, ...args], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 10 * 1024 * 1024,
    env,
  });
  if (result.error) throw result.error;
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Probe 1 — paths-frontmatter (error)
// ---------------------------------------------------------------------------

describe('validateRuleContent — paths-frontmatter probe', () => {
  it('reports an error when frontmatter declares a top-level paths: key', () => {
    const content = '---\npaths:\n  - src/**\n---\n\n# Rule\n\nBody text.\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].rule).toBe('paths-frontmatter');
    expect(result.violations[0].severity).toBe('error');
  });

  it('reports paths: after provenance comments, blank lines, and CRLF line endings', () => {
    const content =
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/foo.md) -->\r\n\r\n---\r\npaths:\r\n  - src/**\r\n---\r\n\r\n# Rule\r\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.rule === 'paths-frontmatter');
    expect(v).toBeDefined();
    expect(v.severity).toBe('error');
  });

  it('stays silent when frontmatter uses globs: instead of paths:', () => {
    const content = '---\nglobs:\n  - src/**\n---\n\n# Rule\n\nBody text.\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.ok).toBe(true);
    expect(result.violations.filter((v) => v.rule === 'paths-frontmatter')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 2 — provenance-header (error, opt-in)
// ---------------------------------------------------------------------------

describe('validateRuleContent — provenance-header probe', () => {
  it('reports an error when requireProvenance is true and the header is missing', () => {
    const content = '---\nglobs:\n  - src/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md', requireProvenance: true });

    expect(result.ok).toBe(false);
    const v = result.violations.find((x) => x.rule === 'provenance-header');
    expect(v).toBeDefined();
    expect(v.severity).toBe('error');
    expect(v.line).toBe(1);
  });

  it('stays silent when the provenance header is present on line 1', () => {
    const content =
      '<!-- source: session-orchestrator plugin (canonical: rules/always-on/foo.md) -->\n---\nglobs:\n  - src/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md', requireProvenance: true });

    expect(result.violations.filter((v) => v.rule === 'provenance-header')).toHaveLength(0);
  });

  it('does not evaluate provenance when requireProvenance is false (default)', () => {
    const content = '---\nglobs:\n  - src/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.violations.filter((v) => v.rule === 'provenance-header')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 3 — placeholder (error)
// ---------------------------------------------------------------------------

describe('validateRuleContent — placeholder probe', () => {
  it('reports an error for an unfilled handlebars token', () => {
    const content = '# Rule\n\nProject name: {{PROJECT_NAME}}\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    const v = result.violations.find((x) => x.rule === 'placeholder');
    expect(v).toBeDefined();
    expect(v.message).toContain('handlebars');
  });

  it('reports an error for an unfilled "## TODO: Customize" heading', () => {
    const content = '# Rule\n\n## TODO: Customize\n\nFill this in.\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    const v = result.violations.find((x) => x.rule === 'placeholder');
    expect(v).toBeDefined();
    expect(v.message).toContain('TODO: Customize');
  });

  it('reports an error for an unfilled "<!-- TODO:" comment', () => {
    const content = '# Rule\n\n<!-- TODO: fill in project specifics -->\n\nBody.\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    const v = result.violations.find((x) => x.rule === 'placeholder');
    expect(v).toBeDefined();
  });

  it('stays silent on a clean rule with no placeholder tokens', () => {
    const content = '# Rule\n\nThis is a finished rule with real content.\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.violations.filter((v) => v.rule === 'placeholder')).toHaveLength(0);
    expect(result.ok).toBe(true);
  });

  it('does not flag a handlebars token that appears only inside a fenced code block', () => {
    const content =
      '# Rule\n\nExplaining the convention:\n\n```\n{{PROJECT_NAME}}\n```\n\nReal content follows.\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.violations.filter((v) => v.rule === 'placeholder')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Probe 4 — zero-match-globs (warn, only with targetRoot)
// ---------------------------------------------------------------------------

describe('validateRuleContent — zero-match-globs probe (warn)', () => {
  it('warns when a glob matches 0 files under targetRoot', () => {
    const targetRoot = tmp();
    writeFileSync(join(targetRoot, 'unrelated.txt'), 'x');
    const content = '---\nglobs:\n  - src/**/*.ts\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md', targetRoot });

    const v = result.violations.find((x) => x.rule === 'zero-match-globs');
    expect(v).toBeDefined();
    expect(v.severity).toBe('warn');
  });

  it('stays silent when the glob matches at least one file under targetRoot', () => {
    const targetRoot = tmp();
    mkdirSync(join(targetRoot, 'src'), { recursive: true });
    writeFileSync(join(targetRoot, 'src', 'index.ts'), 'x');
    const content = '---\nglobs:\n  - src/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md', targetRoot });

    expect(result.violations.filter((v) => v.rule === 'zero-match-globs')).toHaveLength(0);
  });

  it('does not run the check at all when targetRoot is not provided', () => {
    const content = '---\nglobs:\n  - src/nonexistent/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.violations.filter((v) => v.rule === 'zero-match-globs')).toHaveLength(0);
  });

  it('a zero-match-globs warning never flips ok to false', () => {
    const targetRoot = tmp();
    writeFileSync(join(targetRoot, 'unrelated.txt'), 'x');
    const content = '---\nglobs:\n  - src/**/*.ts\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md', targetRoot });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Probe 5 — foreign-glob (warn)
// ---------------------------------------------------------------------------

describe('validateRuleContent — foreign-glob probe (warn)', () => {
  it('warns when a glob segment contains a PascalCase product-like token', () => {
    const content = '---\nglobs:\n  - src/FooBarTests/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    const v = result.violations.find((x) => x.rule === 'foreign-glob');
    expect(v).toBeDefined();
    expect(v.severity).toBe('warn');
    expect(v.message).toContain('FooBarTests');
  });

  it('stays silent on a generic lowercase glob', () => {
    const content = '---\nglobs:\n  - src/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.violations.filter((v) => v.rule === 'foreign-glob')).toHaveLength(0);
  });

  it('fires regardless of whether targetRoot is provided', () => {
    const targetRoot = tmp();
    const content = '---\nglobs:\n  - src/FooBarTests/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md', targetRoot });

    const v = result.violations.find((x) => x.rule === 'foreign-glob');
    expect(v).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// validateRulesDir
// ---------------------------------------------------------------------------

describe('validateRulesDir', () => {
  it('scans .md files, skips _index.md and dotfiles, sums error counts', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'clean.md'), '# Clean Rule\n\nNo issues here.\n');
    writeFileSync(join(dir, 'bad.md'), '---\npaths:\n  - src/**\n---\n\n# Bad Rule\n');
    writeFileSync(join(dir, '_index.md'), '# Index\n\n- `clean.md`\n');
    writeFileSync(join(dir, '.hidden.md'), '---\npaths:\n  - x\n---\n');

    const result = validateRulesDir({ dir });

    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.file).sort()).toEqual(['bad.md', 'clean.md']);
    expect(result.errorCount).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('returns ok: true and errorCount 0 when every file is clean', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'clean-a.md'), '# Clean A\n\nAll good.\n');
    writeFileSync(join(dir, 'clean-b.md'), '# Clean B\n\nAlso good.\n');

    const result = validateRulesDir({ dir });

    expect(result.ok).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.warnCount).toBe(0);
  });

  it('recursively scans category subdirectories when invoked at the rules library root', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'always-on'), { recursive: true });
    writeFileSync(join(dir, '_index.md'), '# Index\n\n- `always-on/bad.md`\n');
    writeFileSync(join(dir, 'always-on', 'bad.md'), '---\npaths:\n  - src/**\n---\n\n# Bad Rule\n');

    const result = validateRulesDir({ dir });

    expect(result.files.map((f) => f.file)).toEqual(['always-on/bad.md']);
    expect(result.errorCount).toBe(1);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI — exit-code contract + --json shape
// ---------------------------------------------------------------------------

describe('CLI — exit codes', () => {
  it('exits 0 with no violations in a clean dir', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'clean.md'), '# Clean\n\nAll good.\n');

    const { status } = runCLI(['--dir', dir]);

    expect(status).toBe(0);
  });

  it('exits 1 in hard mode (default) when an error-severity violation is present', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'bad.md'), '---\npaths:\n  - src/**\n---\n\n# Bad\n');

    const { status } = runCLI(['--dir', dir]);

    expect(status).toBe(1);
  });

  it('exits 0 in warn mode even with an error-severity violation present', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'bad.md'), '---\npaths:\n  - src/**\n---\n\n# Bad\n');

    const { status } = runCLI(['--dir', dir, '--mode', 'warn']);

    expect(status).toBe(0);
  });

  it('exits 2 when --dir does not exist', () => {
    const missing = join(tmpdir(), 'definitely-does-not-exist-validate-vendored-xyz');

    const { status, stderr } = runCLI(['--dir', missing]);

    expect(status).toBe(2);
    expect(stderr).toContain('--dir');
  });

  it('--json produces parseable output with the expected top-level shape', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'clean.md'), '# Clean\n\nAll good.\n');

    const { stdout, status } = runCLI(['--dir', dir, '--json']);

    expect(status).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      mode: 'hard',
      dir,
      errorCount: 0,
      warnCount: 0,
      ok: true,
    });
    expect(Array.isArray(parsed.files)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PLUGIN_HEADER_PREFIX identity guard (mandatory — issue #722 Epic A)
// ---------------------------------------------------------------------------

function extractPluginHeaderPrefix(sourceText) {
  const m = /const PLUGIN_HEADER_PREFIX = '([^']+)';/.exec(sourceText);
  if (!m) throw new Error('PLUGIN_HEADER_PREFIX const not found in source');
  return m[1];
}

describe('PLUGIN_HEADER_PREFIX identity guard', () => {
  it('the validator private copy is textually identical to the rules-sync.mjs export', () => {
    const validatorSource = readFileSync(VALIDATOR_SOURCE_PATH, 'utf8');
    const validatorPrefix = extractPluginHeaderPrefix(validatorSource);

    expect(validatorPrefix).toBe(PLUGIN_HEADER_PREFIX);
  });

  it('FAKE-REGRESSION: a drifted scratch copy (written to a temp dir) is detected as different', () => {
    // Simulate the exact production bug this guard exists to catch: someone
    // edits ONE of the two textually-duplicated constants and not the other.
    // We never touch the real production file — we mutate a SCRATCH COPY of
    // its source text and write THAT to a temp dir, then re-run the identical
    // extraction regex used above and assert the comparison flags the drift.
    const validatorSource = readFileSync(VALIDATOR_SOURCE_PATH, 'utf8');
    const marker = "const PLUGIN_HEADER_PREFIX = '<!-- source: session-orchestrator plugin";
    expect(validatorSource).toContain(marker); // guard: the mutation must target the real line

    const driftedSource = validatorSource.replace(
      marker,
      "const PLUGIN_HEADER_PREFIX = '<!-- DRIFTED-source: session-orchestrator plugin",
    );

    const scratchDir = tmp();
    const scratchPath = join(scratchDir, 'validate-vendored-rules.drifted.mjs');
    writeFileSync(scratchPath, driftedSource, 'utf8');

    const driftedPrefix = extractPluginHeaderPrefix(readFileSync(scratchPath, 'utf8'));

    expect(driftedPrefix).not.toBe(PLUGIN_HEADER_PREFIX);
  });

  it('FAKE-REGRESSION (meta): the identity comparison itself throws on a genuine divergence', () => {
    // Demonstrates the assertion used above is not vacuously true — feeding it
    // a deliberately wrong value must throw, proving the guard is falsifiable.
    const wrongValue = 'not-the-real-prefix-at-all';

    expect(() => expect(wrongValue).toBe(PLUGIN_HEADER_PREFIX)).toThrow();
  });
});
