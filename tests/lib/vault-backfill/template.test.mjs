/**
 * tests/lib/vault-backfill/template.test.mjs
 *
 * Vitest suite for scripts/lib/vault-backfill/template.mjs.
 *
 * Covers:
 *   loadTemplate     — file read, caching (called once), dieFn on missing file
 *   slugToHumanName  — kebab-case → Title Case; single word; empty string
 *   pathToSlug       — directory path → slug; trailing slash; dots + underscores
 *   TEMPLATE_PATH    — env var override changes the lookup path
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_TEMPLATE_CONTENT = `# .vault.yaml template\nmetadata:\n  name: {{PROJECT_NAME}}\n`;

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'vault-backfill-template-test-'));
}

/**
 * Write a fake template file under tmpDir mirroring the real path layout:
 *   <dir>/templates/shared/.vault.yaml.template
 * Returns the dir that can be set as PROJECTS_BASELINE_DIR.
 */
function writeFakeTemplate(dir, content = FAKE_TEMPLATE_CONTENT) {
  const templateDir = join(dir, 'templates', 'shared');
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, '.vault.yaml.template'), content, 'utf8');
  return dir;
}

// ---------------------------------------------------------------------------
// slugToHumanName + pathToSlug — no side-effects; import once
// ---------------------------------------------------------------------------

import { slugToHumanName, pathToSlug } from '@lib/vault-backfill/template.mjs';

describe('slugToHumanName', () => {
  it('converts a multi-word kebab slug to Title Case', () => {
    expect(slugToHumanName('my-project-name')).toBe('My Project Name');
  });

  it('converts a two-word slug correctly', () => {
    expect(slugToHumanName('auth-service')).toBe('Auth Service');
  });

  it('leaves a single word capitalized', () => {
    expect(slugToHumanName('webapp')).toBe('Webapp');
  });

  it('returns an empty string for an empty slug', () => {
    // split('').map(capitalize).join(' ') of '' → ''
    expect(slugToHumanName('')).toBe('');
  });

  it('capitalizes each word segment independently', () => {
    expect(slugToHumanName('foo-bar-baz')).toBe('Foo Bar Baz');
  });
});

describe('pathToSlug', () => {
  it('returns the last path segment as a lowercase slug', () => {
    expect(pathToSlug('group/my-project')).toBe('my-project');
  });

  it('strips trailing slashes before deriving the slug', () => {
    expect(pathToSlug('group/my-project/')).toBe('my-project');
  });

  it('converts dots to hyphens', () => {
    expect(pathToSlug('group/my.project')).toBe('my-project');
  });

  it('converts underscores to hyphens', () => {
    expect(pathToSlug('group/my_project')).toBe('my-project');
  });

  it('collapses consecutive hyphens into a single hyphen', () => {
    expect(pathToSlug('group/my--project')).toBe('my-project');
  });

  it('lowercases uppercase characters', () => {
    expect(pathToSlug('group/MyProject')).toBe('myproject');
  });

  it('strips leading and trailing hyphens from the result', () => {
    // e.g. a segment starting/ending with dots
    expect(pathToSlug('group/.hidden.')).toBe('hidden');
  });

  it('handles a plain repo name with no path separator', () => {
    expect(pathToSlug('simple-repo')).toBe('simple-repo');
  });
});

// ---------------------------------------------------------------------------
// loadTemplate — requires module isolation to reset the internal cache
// ---------------------------------------------------------------------------

describe('loadTemplate', () => {
  let tmpDir;
  let origBaselineDir;

  beforeEach(() => {
    origBaselineDir = process.env.PROJECTS_BASELINE_DIR;
    tmpDir = makeTmpDir();
    // Reset module registry so _templateContent cache starts null each suite run
    vi.resetModules();
  });

  afterEach(() => {
    if (origBaselineDir !== undefined) {
      process.env.PROJECTS_BASELINE_DIR = origBaselineDir;
    } else {
      delete process.env.PROJECTS_BASELINE_DIR;
    }
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it('reads and returns the template file content when the file exists', async () => {
    writeFakeTemplate(tmpDir, FAKE_TEMPLATE_CONTENT);
    process.env.PROJECTS_BASELINE_DIR = tmpDir;

    const { loadTemplate } = await import('@lib/vault-backfill/template.mjs');
    const dieFn = vi.fn();
    const result = loadTemplate(dieFn);

    expect(result).toBe(FAKE_TEMPLATE_CONTENT);
    expect(dieFn).not.toHaveBeenCalled();
  });

  it('calls dieFn(2, ...) with a descriptive message when the template file is missing', async () => {
    // tmpDir has no template file written — use a fresh subdir to avoid
    // leaking state from the "reads and returns" test (different env value)
    const emptyDir = makeTmpDir();
    process.env.PROJECTS_BASELINE_DIR = emptyDir;

    try {
      const { loadTemplate } = await import('@lib/vault-backfill/template.mjs');
      const dieFn = vi.fn();
      loadTemplate(dieFn);

      // dieFn should have been called at least once with code 2
      expect(dieFn).toHaveBeenCalled();
      const [code, message] = dieFn.mock.calls[0];
      expect(code).toBe(2);
      expect(message).toContain('canonical template not found');
    } finally {
      try { rmSync(emptyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns the cached value on the second call (same string reference)', async () => {
    writeFakeTemplate(tmpDir, FAKE_TEMPLATE_CONTENT);
    process.env.PROJECTS_BASELINE_DIR = tmpDir;

    // Dynamic import after resetModules gives a fresh module with null cache
    const mod = await import('@lib/vault-backfill/template.mjs');
    const dieFn = vi.fn();

    // First call — populates cache
    const first = mod.loadTemplate(dieFn);
    expect(first).toBe(FAKE_TEMPLATE_CONTENT);

    // Second call — must return the identical cached reference
    const second = mod.loadTemplate(dieFn);
    expect(second).toBe(first);

    // dieFn never called because file exists
    expect(dieFn).not.toHaveBeenCalled();
  });

  it('uses PROJECTS_BASELINE_DIR env var to locate the template', async () => {
    const customContent = '# custom template\n';
    writeFakeTemplate(tmpDir, customContent);
    process.env.PROJECTS_BASELINE_DIR = tmpDir;

    const { loadTemplate, TEMPLATE_PATH } = await import('@lib/vault-backfill/template.mjs');
    const dieFn = vi.fn();
    const result = loadTemplate(dieFn);

    // Template path must include our custom tmpDir
    expect(TEMPLATE_PATH).toContain(tmpDir);
    expect(result).toBe(customContent);
  });
});
