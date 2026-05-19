/**
 * tests/templates/personas/parse-each.test.mjs
 *
 * Tests that all templates/personas/*.v1.md files parse cleanly via validatePersonaSpec.
 * Issue #483 Q4-MED-2: templates ship to users without schema verification (loadCatalog
 * rejects .v1 filenames per SAFE_PERSONA_NAME_RE). This test fills that gap.
 *
 * Frontmatter is parsed with js-yaml + CORE_SCHEMA to match the convention in
 * scripts/lib/persona-panel/catalog-loader.mjs (parseFrontmatterBlock).
 *
 * Falsification check: removing validatePersonaSpec or breaking any template's
 * frontmatter causes the per-file assertion to fail. The floor/ceiling count test
 * catches accidental deletion of templates.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { validatePersonaSpec } from '../../../scripts/lib/persona-panel/catalog-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const TEMPLATES_DIR = join(REPO_ROOT, 'templates', 'personas');

/** Match the YAML frontmatter block at the head of a markdown file (mirrors catalog-loader). */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Parse YAML frontmatter from a persona template file using the same mechanism
 * as catalog-loader.mjs::parseFrontmatterBlock (js-yaml CORE_SCHEMA).
 */
function parseFrontmatter(filePath) {
  const contents = readFileSync(filePath, 'utf8');
  const match = FRONTMATTER_RE.exec(contents);
  if (match === null) {
    throw new Error(`${filePath}: missing YAML frontmatter block (expected --- ... ---)`);
  }
  return yaml.load(match[1], { schema: yaml.CORE_SCHEMA });
}

const templateFiles = readdirSync(TEMPLATES_DIR)
  .filter((f) => f.endsWith('.v1.md'))
  .sort(); // deterministic order

// ---------------------------------------------------------------------------
// Count guard (floor/ceiling per test-quality.md dynamic-artifact-counts)
// ---------------------------------------------------------------------------

describe('persona templates — count guard', () => {
  it('finds at least 10 template files (6 originals + 4 added in W2 of #483)', () => {
    expect(templateFiles.length).toBeGreaterThanOrEqual(10);
  });

  it('does not exceed a reasonable ceiling of 50 template files', () => {
    expect(templateFiles.length).toBeLessThanOrEqual(50);
  });
});

// ---------------------------------------------------------------------------
// Per-file schema validation
// ---------------------------------------------------------------------------

describe('persona templates — each .v1.md passes validatePersonaSpec', () => {
  it.each(templateFiles)('%s has valid YAML frontmatter and passes validatePersonaSpec', (file) => {
    const filePath = join(TEMPLATES_DIR, file);
    const frontmatter = parseFrontmatter(filePath);
    const result = validatePersonaSpec(frontmatter, filePath);
    // Emit error detail on failure so the test message is actionable
    if (!result.ok) {
      const errorSummary = result.errors.map((e) => `${e.path}: ${e.message}`).join('\n  ');
      expect(result.ok, `validatePersonaSpec failed for ${file}:\n  ${errorSummary}`).toBe(true);
    } else {
      expect(result.ok).toBe(true);
    }
  });
});
