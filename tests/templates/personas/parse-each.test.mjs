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
  // Floor/ceiling range per .claude/rules/test-quality.md
  // § "Dynamic Artifact Counts — Floor/Ceiling Carve-Out". Persona templates are a
  // dynamically-grown artifact set (6 originals + 4 added in W2 of #483 = 10 current).
  // Floor 8 = current − 2 (small-count guidance), still catches accidental deletion of
  // a template. Ceiling 50 = 5× current, catches an accidental enumeration loop.
  // A `>= 10` exact-floor (#492 L1) broke on any single template removal; the range
  // lets the catalog grow/shrink-by-one without test edits while keeping both guards live.
  const FLOOR = 8;
  const CEILING = 50;

  it('finds at least 8 template files (floor = 10 current − 2; catches accidental deletion)', () => {
    expect(templateFiles.length).toBeGreaterThanOrEqual(FLOOR);
  });

  it('does not exceed a ceiling of 50 template files (5× current; catches accidental loops)', () => {
    expect(templateFiles.length).toBeLessThanOrEqual(CEILING);
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

// ---------------------------------------------------------------------------
// Malformed-template injection canary (#492 M5)
// ---------------------------------------------------------------------------
//
// The per-file block above proves the SHIPPED templates pass. This block proves
// the negative: a malformed template carrying an injection-y / structurally-broken
// field is REJECTED by validatePersonaSpec. Without these the suite only asserts
// "valid templates pass" — it would stay green even if validation accepted hostile
// input (the exact gap that lets a malicious .v1.md ship to users unchecked).
//
// Falsification: if validatePersonaSpec dropped its preCheckOutputContract /
// SAFE_PERSONA_NAME_RE / additionalProperties guards, the malformed specs below
// would return { ok: true } and these tests would fail.

describe('persona templates — malformed-spec injection canary (#492 M5)', () => {
  /** A complete, otherwise-valid spec we mutate one field at a time. */
  const validBase = {
    name: 'canary-persona',
    schema_version: 1,
    version: '1.0.0',
    role: 'Canary reviewer',
    model: 'claude-opus-4-7',
    tier: 'reviewer',
    evaluation_criteria: ['Check the thing.'],
    output_contract: {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    },
  };

  it('rejects an output_contract that smuggles a $ref combinator (H3 schema-DoS attack surface)', () => {
    const malformed = {
      ...validBase,
      // $ref enables external/indirect schema indirection — preCheckOutputContract
      // blocks it before AJV is ever exposed to the operator-authored schema.
      output_contract: { $ref: 'https://evil.example/schema.json' },
    };
    const result = validatePersonaSpec(malformed, '/templates/personas/canary.v1.md');
    expect(result.ok).toBe(false);
    const outputContractErr = result.errors.find((e) => e.path === 'output_contract');
    expect(outputContractErr).toBeDefined();
    expect(outputContractErr.rule).toBe('shape');
    expect(outputContractErr.message).toContain('$ref');
  });

  it('rejects a name containing a path-traversal sequence (SAFE_PERSONA_NAME_RE guard)', () => {
    const malformed = { ...validBase, name: '../../etc/passwd' };
    const result = validatePersonaSpec(malformed, '/templates/personas/canary.v1.md');
    expect(result.ok).toBe(false);
    const nameErr = result.errors.find((e) => e.path === 'name');
    expect(nameErr).toBeDefined();
    expect(nameErr.rule).toBe('format');
  });

  it('rejects an unknown frontmatter key (additionalProperties is closed)', () => {
    const malformed = { ...validBase, run_arbitrary_code: 'rm -rf /' };
    const result = validatePersonaSpec(malformed, '/templates/personas/canary.v1.md');
    expect(result.ok).toBe(false);
    const unknownKeyErr = result.errors.find((e) => e.path === 'run_arbitrary_code');
    expect(unknownKeyErr).toBeDefined();
    expect(unknownKeyErr.rule).toBe('unknown-key');
  });
});
