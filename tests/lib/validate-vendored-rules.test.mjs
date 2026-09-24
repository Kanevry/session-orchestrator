/**
 * tests/lib/validate-vendored-rules.test.mjs
 *
 * Unit tests for scripts/lib/validate-vendored-rules.mjs — issue #722 Epic A
 * Wave 2. Covers the vendoring probes (globs-paths-mismatch,
 * frontmatter-not-at-top, provenance-header, placeholder, zero-match-globs,
 * foreign-glob), validateRulesDir(), the CLI's exit-code contract, and the
 * mandatory PLUGIN_HEADER_PREFIX identity guard against
 * scripts/lib/rules-sync.mjs's textually-duplicated copy.
 *
 * Also pins the globs-paths-mismatch probe's POPULATION (2026-09-16): the
 * `rules/` fleet library, never a repo's own consolidated `.claude/rules/`
 * tree, whose files are `paths:`-only by design (#1108).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRuleContent, validateRulesDir, isPluginOwnedContent } from '@lib/validate-vendored-rules.mjs';
import { PLUGIN_HEADER_PREFIX } from '@lib/rules-sync.mjs';

// NOTE: `new URL(...)` does NOT resolve vitest's `@lib` alias — it does standard
// URL resolution. SCRIPT_PATH is passed to a spawned child Node process that has
// no `@lib` alias either. Keep this string as a raw relative path (#407 exempt).
const SCRIPT_PATH = fileURLToPath(new URL('../../scripts/lib/validate-vendored-rules.mjs', import.meta.url));
const VALIDATOR_SOURCE_PATH = fileURLToPath(new URL('../../scripts/lib/validate-vendored-rules.mjs', import.meta.url));

// The provenance line exactly as a library rule carries it.
const HEADER = '<!-- source: session-orchestrator plugin (canonical: rules/opt-in-stack/foo.md) -->';

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
// Probe 1 — globs-paths-mismatch / frontmatter-not-at-top (error, #1449)
// ---------------------------------------------------------------------------

describe('validateRuleContent — globs-paths-mismatch probe', () => {
  // Bug caught (globs-only row, #1449): a library rule scoped by `globs:` alone
  // passed the gate silently, and Claude Code — which reads only `paths:` —
  // loaded it always-on in every consumer repo. Each row must name the key
  // that is missing, or the author cannot tell which one to add.
  it.each([
    ['paths: without globs:', '---\npaths:\n  - src/**\n---\n\n# Rule\n\nBody text.\n', "declares 'paths:' but no 'globs:'"],
    ['globs: without paths:', '---\nglobs:\n  - src/**\n---\n\n# Rule\n\nBody text.\n', "declares 'globs:' but no 'paths:'"],
  ])('reports exactly one error naming the missing key when frontmatter declares %s', (_label, content, missingKey) => {
    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => [v.rule, v.severity, v.line])).toEqual([['globs-paths-mismatch', 'error', 2]]);
    expect(result.violations[0].message).toContain(missingKey);
  });

  // Bug caught (#1449): the pre-#1449 library shape — provenance comment on
  // line 1, frontmatter below it — passed the gate with 0 errors, although
  // Claude Code reads frontmatter only from line 1 and so loaded every such
  // rule always-on. Reported once, at line 1: never doubled by a
  // provenance-header error (the header IS there, and isPluginOwnedContent
  // must keep such copies plugin-owned so the next sync upgrades them), nor by
  // a globs-paths-mismatch on a block no loader reads.
  it.each([
    ['header on line 1, --- on line 2 (the pre-#1449 library shape)', `${HEADER}\n---\nglobs:\n  - src/**\npaths:\n  - src/**\n---\n\n# Rule\n`],
    ['header, blank line, paths: only, CRLF line endings', `${HEADER}\r\n\r\n---\r\npaths:\r\n  - src/**\r\n---\r\n\r\n# Rule\r\n`],
    // Bug caught (#1449 review F1): a NON-comment line (a heading) before the
    // block passed the probe silently although the loader already reported
    // defect: frontmatter-not-at-top — the two detectors disagreed.
    ['header, then a heading, then the block (any text before ---)', `${HEADER}\n# Title\n---\nglobs:\n  - src/**\npaths:\n  - src/**\n---\n\nbody\n`],
  ])('reports frontmatter-not-at-top once at line 1 and no provenance-header error: %s', (_label, content) => {
    const result = validateRuleContent({ content, relPath: 'foo.md', requireProvenance: true });

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => [v.rule, v.severity, v.line])).toEqual([['frontmatter-not-at-top', 'error', 1]]);
  });

  // Bug caught (reorder row): comparing the two lists position by position
  // rejects a library rule whose keys list the same globs in another order —
  // a false error that makes syncRules() skip the rule in every consumer.
  it.each([
    ['in the same order', '---\nglobs:\n  - src/**\n  - lib/**\npaths:\n  - src/**\n  - lib/**\n---\n\n# Rule\n'],
    ['in a different order', '---\nglobs:\n  - src/**\n  - lib/**\npaths:\n  - lib/**\n  - src/**\n---\n\n# Rule\n'],
  ])('stays silent when globs: and paths: carry the identical list %s', (_label, content) => {
    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('names the entries each key carries alone when globs: and paths: differ', () => {
    // Bug caught (#1449): two different lists scope one rule differently per
    // loader (Claude Code by paths:, rule-loader.mjs by globs:) and passed the
    // gate silently. The message must say WHICH entries differ.
    const content = '---\nglobs:\n  - src/**\n  - lib/**\npaths:\n  - src/**\n  - test/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.violations.map((v) => [v.rule, v.severity, v.line])).toEqual([['globs-paths-mismatch', 'error', 2]]);
    expect(result.violations[0].message).toContain('only in globs: ["lib/**"]; only in paths: ["test/**"]');
  });
});

// ---------------------------------------------------------------------------
// Probe 1 — scope: the `rules/` fleet library, never `.claude/rules/` (F5)
// ---------------------------------------------------------------------------

describe('globs-paths-mismatch — scope is the rules/ fleet library', () => {
  const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

  it('finds no frontmatter-convention error in the live rules/ library — its only production population', () => {
    // Bug caught: a fleet-library source lands with its frontmatter below the
    // provenance line, or with only one of globs:/paths: (#1449). syncRules()
    // runs these exact probes as a pre-write gate and records an error for that
    // file, so the rule is SKIPPED in every consumer repo's .claude/rules/ — a
    // silent fleet-sync hole that surfaces only on the next
    // /bootstrap --sync-rules run in some other repo.
    const result = validateRulesDir({ dir: join(REPO_ROOT, 'rules') });

    const offenders = result.files
      .filter((f) =>
        f.violations.some((v) => v.rule === 'globs-paths-mismatch' || v.rule === 'frontmatter-not-at-top'),
      )
      .map((f) => f.file);

    expect(result.files.length).toBeGreaterThan(0);
    expect(offenders).toEqual([]);

    // #1164: the same live library must also clear the two gates rules-sync
    // applies — README.md is not a vendored rule (no provenance header), and a
    // `See Also` name with no target under rules/** dangles in every consumer.
    const strict = validateRulesDir({
      dir: join(REPO_ROOT, 'rules'),
      requireProvenance: true,
      pluginRoot: REPO_ROOT,
    });
    expect(strict.errorCount).toBe(0);
    expect(strict.sanitizer).toEqual([]);
  });

  it('scopes its remedy to vendored rules and exempts a repo-local .claude/rules/ file', () => {
    // Bug caught: an unscoped remedy ("add globs:") read by a consolidation
    // pass over .claude/rules/ — those files are paths:-only by design (#1108),
    // so obeying it there rewrites every consolidated rule to a convention it
    // was never meant to follow. The probe's population is the rules/ library
    // (module doc § Scope); the message must say so rather than address every
    // reader of every rule file.
    const content = '---\npaths:\n  - scripts/**\n---\n\n# Consolidated rule\n';

    const { violations } = validateRuleContent({ content, relPath: 'testing.md' });
    const v = violations.find((x) => x.rule === 'globs-paths-mismatch');

    expect(v).toBeDefined();
    expect(v.message).toContain('rules/ library');
    expect(v.message).toContain('.claude/rules/');
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

  it('accepts the #1449 format — frontmatter on line 1, header on the line after the closing ---', () => {
    // Bug caught: a line-1-only provenance check rejects every scoped library
    // rule in the one format Claude Code scopes correctly, so syncRules()'s
    // pre-write gate records an error and the rule is never vendored.
    const content = `---\nglobs:\n  - src/**\npaths:\n  - src/**\ntier: wave-only\n---\n${HEADER}\n\n# Rule\n`;

    const result = validateRuleContent({ content, relPath: 'foo.md', requireProvenance: true });

    expect(result.violations).toEqual([]);
  });

  it('does not evaluate provenance when requireProvenance is false (default)', () => {
    const content = '---\nglobs:\n  - src/**\n---\n\n# Rule\n';

    const result = validateRuleContent({ content, relPath: 'foo.md' });

    expect(result.violations.filter((v) => v.rule === 'provenance-header')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isPluginOwnedContent — the ownership predicate rules-sync.mjs uses (#1449)
//
// The three accepted header positions and the header-less local rule are
// pinned where a wrong answer does damage: syncRules() (Test 4, the
// "ownership across the #1449 header move" and "local rule preservation"
// blocks in tests/unit/rules-sync.test.mjs) and the provenance probe above.
// Only the two edges no caller-level test reaches are asserted here:
//   - CRLF row: splitting on '\n' leaves '---\r', so a Windows autocrlf
//     checkout of an upgraded copy is disowned and frozen again.
//   - buried row: a predicate that finds the marker anywhere claims a local
//     rule that merely quotes it, and the next sync overwrites that rule.
// ---------------------------------------------------------------------------

describe('isPluginOwnedContent', () => {
  it.each([
    ['#1449 format with CRLF line endings', true, `---\r\nglobs:\r\n  - src/**\r\npaths:\r\n  - src/**\r\n---\r\n${HEADER}\r\n\r\n# Rule\r\n`],
    ['header buried after body text', false, `---\npaths:\n  - src/**\n---\n\n# Local rule\n\nQuoting the marker:\n${HEADER}\n`],
  ])('%s → %s', (_label, expected, content) => {
    expect(isPluginOwnedContent(content)).toBe(expected);
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
    const content = '---\nglobs:\n  - src/**/*.ts\npaths:\n  - src/**/*.ts\n---\n\n# Rule\n';

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

// ---------------------------------------------------------------------------
// Live-library census (issue #1098).
//
// Bug class: a rule added to rules/ WITHOUT the provenance header is rejected
// by syncRules()'s pre-write gate and never reaches a consumer repo — and the
// only trace is one entry in the JSON `errors[]` array that nobody reads. The
// operator sees a plausible `written[]` list and concludes the sync worked.
// That is exactly how the 8 core rules #1098 registered would have failed.
//
// The population is READ FROM rules/_index.md, never hand-typed: a parity test
// whose list is typed by the author is a green tick with no coverage — it
// cannot fail for the file the author forgot.
// ---------------------------------------------------------------------------

const RULES_LIBRARY_ROOT = fileURLToPath(new URL('../../rules', import.meta.url));

/**
 * Every `<category>/<file>.md` bullet registered in the live rules/_index.md.
 * @returns {string[]}
 */
function registeredRuleEntries() {
  const index = readFileSync(join(RULES_LIBRARY_ROOT, '_index.md'), 'utf8');
  return [...index.matchAll(/^-\s+`([\w-]+\/[^`]+\.md)`/gm)].map((m) => m[1]);
}

describe('rules/_index.md census — every registered rule is vendorable', () => {
  it('registers at least the three pre-#1098 always-on rules (census parser sanity)', () => {
    // Without this, a regex that silently matched nothing would make the census
    // below vacuously green.
    const entries = registeredRuleEntries();
    expect(entries).toContain('always-on/parallel-sessions.md');
    expect(entries).toContain('always-on/commit-discipline.md');
    expect(entries).toContain('always-on/npm-quality-gates.md');
    expect(entries.length).toBeGreaterThan(3);
  });

  it('every registered entry exists on disk and passes requireProvenance with zero errors', () => {
    const failures = [];
    for (const entry of registeredRuleEntries()) {
      const abs = join(RULES_LIBRARY_ROOT, entry);
      let content;
      try {
        content = readFileSync(abs, 'utf8');
      } catch {
        failures.push(`${entry}: registered in _index.md but missing on disk`);
        continue;
      }
      const { violations } = validateRuleContent({
        content,
        relPath: `rules/${entry}`,
        requireProvenance: true,
      });
      for (const v of violations.filter((x) => x.severity === 'error')) {
        failures.push(`${entry}: ${v.rule}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('registers the eight core rules issue #1098 named', () => {
    // Deliberately named, unlike the census above: the AC of #1098 is that
    // THESE eight reach a consumer repo. Dropping one from _index.md silently
    // stops vendoring it, with no other signal anywhere.
    const entries = registeredRuleEntries();
    for (const name of [
      'verification-before-completion',
      'test-value',
      'build-value',
      'receiving-review',
      'ask-via-tool',
      'bash-harness-pitfalls',
      'cross-session-messaging',
      'loop-and-monitor',
    ]) {
      expect(entries).toContain(`always-on/${name}.md`);
    }
  });
});

// ---------------------------------------------------------------------------
// Vendoring sanitizer via the standalone CLI (#1098 review — module placement)
//
// scanVendoringLeaks() has this module's exact shape ("judge one rule file →
// findings"), but it lived in rules-sync.mjs, where only a full sync could
// reach it: the standalone validator could not report a vendoring leak at all,
// although docs/rule-authoring.md describes the two beside each other.
// ---------------------------------------------------------------------------

/**
 * A plugin root whose `rules/always-on/` holds one rule (body supplied by the
 * caller), a registered sibling, and a real `scripts/lib/helper.mjs` for the
 * repo-local probe to resolve against.
 */
function sanitizerFixture(body) {
  const root = tmp();
  mkdirSync(join(root, 'rules', 'always-on'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'lib', 'helper.mjs'), 'export const x = 1;\n');
  writeFileSync(
    join(root, 'rules', '_index.md'),
    [
      '# Rules Library — Canonical Index',
      '',
      '## always-on (vendored to every consumer repo)',
      '',
      '- `always-on/sample.md` — the rule under test',
      '- `always-on/sibling.md` — a registered sibling',
      '',
    ].join('\n'),
  );
  const header = (n) => `<!-- source: session-orchestrator plugin (canonical: rules/always-on/${n}) -->\n`;
  writeFileSync(join(root, 'rules', 'always-on', 'sample.md'), header('sample.md') + body);
  writeFileSync(join(root, 'rules', 'always-on', 'sibling.md'), header('sibling.md') + '# Sibling\n');
  return root;
}

describe('validate-vendored-rules CLI — --plugin-root enables the vendoring sanitizer', () => {
  const LEAKY_BODY = [
    '# Sample Rule',
    '',
    'See `scripts/lib/helper.mjs` for the implementation.',
    '',
    '## See Also',
    '',
    'sibling.md · never-vendored.md',
    '',
  ].join('\n');

  it('reports findings under a `sanitizer` key in --json mode', () => {
    const root = sanitizerFixture(LEAKY_BODY);
    const { stdout, status } = runCLI([
      '--dir', join(root, 'rules', 'always-on'),
      '--plugin-root', root,
      '--json',
    ]);
    const parsed = JSON.parse(stdout);

    expect(parsed.sanitizer).toEqual([
      { file: 'sample.md', line: 4, kind: 'repo-local-path', text: 'scripts/lib/helper.mjs' },
      { file: 'sample.md', line: 8, kind: 'unresolvable-see-also', text: 'never-vendored.md' },
    ]);
    // Report-only: `sibling.md` is registered so it is not a finding, and the
    // sanitizer moves neither the violation counts nor the exit code.
    expect(parsed.errorCount).toBe(0);
    expect(status).toBe(0);
  });

  it('prints findings as stderr lines in non-JSON mode, exit code unchanged', () => {
    const root = sanitizerFixture(LEAKY_BODY);
    const { stderr, status } = runCLI([
      '--dir', join(root, 'rules', 'always-on'),
      '--plugin-root', root,
    ]);

    expect(stderr).toContain(
      'validate-vendored-rules: sanitizer repo-local-path sample.md:4 — scripts/lib/helper.mjs',
    );
    expect(stderr).toContain(
      'validate-vendored-rules: sanitizer unresolvable-see-also sample.md:8 — never-vendored.md',
    );
    expect(status).toBe(0);
  });

  it('omits the scan entirely without --plugin-root (opt-in, no behaviour change)', () => {
    const root = sanitizerFixture(LEAKY_BODY);
    const { stdout, stderr, status } = runCLI([
      '--dir', join(root, 'rules', 'always-on'),
      '--json',
    ]);

    expect(JSON.parse(stdout).sanitizer).toEqual([]);
    expect(stderr).not.toContain('sanitizer');
    expect(status).toBe(0);
  });
});
