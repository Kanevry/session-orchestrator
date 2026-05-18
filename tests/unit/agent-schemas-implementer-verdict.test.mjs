/**
 * tests/unit/agent-schemas-implementer-verdict.test.mjs
 *
 * Issue #472 — additive `verdict` on 4 implementer schemas.
 * Verifies that code-implementer, db-specialist, test-writer, ui-developer
 * all carry a unified verdict block that is additive (not in `required`).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAjv2020 } from '@lib/ajv-loader.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const IMPLEMENTERS = ['code-implementer', 'db-specialist', 'test-writer', 'ui-developer'];
const CANONICAL_ENUM = ['PROCEED', 'PROCEED_WITH_FOLLOWUPS', 'FIX_REQUIRED', 'BLOCKED'];
const MAPPING_TRIPLE = 'done→PROCEED, partial→PROCEED_WITH_FOLLOWUPS, blocked→BLOCKED';

function readSchema(name) {
  return JSON.parse(readFileSync(join(REPO, 'agents/schemas', `${name}.schema.json`), 'utf8'));
}
function readBody(name) {
  return readFileSync(join(REPO, 'agents', `${name}.md`), 'utf8');
}

// =============================================================================
// Structural: verdict property declared additively on all 4 implementer schemas
// =============================================================================

describe('verdict property — 4 implementer schemas (#472)', () => {
  it.each(IMPLEMENTERS)('%s schema declares verdict property additively', (name) => {
    const schema = readSchema(name);
    expect(schema.properties.verdict).toBeDefined();
    expect(schema.properties.verdict.type).toBe('string');
    expect(schema.properties.verdict.enum).toEqual(CANONICAL_ENUM);
    expect(Array.isArray(schema.required)).toBe(true);
    expect(schema.required).not.toContain('verdict');
    expect(schema.additionalProperties).toBe(false);
  });
});

// =============================================================================
// Vocabulary unification: 4 implementer schemas share byte-identical verdict block
// (security-reviewer's description is reviewer-phrased and intentionally diverges,
//  per W4-Q3 MED-3 fix — implementer/reviewer roles use specialised descriptions
//  while still sharing the same 4-value enum.)
// =============================================================================

describe('verdict vocabulary unification (#472)', () => {
  it('all 5 schemas share byte-identical verdict enum (4 implementers + security-reviewer)', () => {
    const names = [...IMPLEMENTERS, 'security-reviewer'];
    const enums = names.map((n) => readSchema(n).properties.verdict.enum);
    for (const e of enums) {
      expect(e).toEqual(CANONICAL_ENUM);
    }
  });

  it('4 implementer schemas share byte-identical verdict description', () => {
    const descs = IMPLEMENTERS.map((n) => readSchema(n).properties.verdict.description);
    const ref = descs[0];
    expect(typeof ref).toBe('string');
    expect(ref.length).toBeGreaterThan(20);
    // Pin the canonical implementer-phrasing tokens (so a global search-replace can't
    // silently drift all 4 in lockstep — addresses W4-Q4 MED-2 tautology concern).
    expect(ref).toContain('implementer mapping');
    expect(ref).toContain('status=done');
    expect(ref).toContain('status=blocked');
    expect(ref).toContain('reserved for reviewers');
    for (const d of descs.slice(1)) {
      expect(d).toBe(ref);
    }
  });

  it('implementer schema description differs from security-reviewer (intentional Q3-MED-3 specialisation)', () => {
    const impl = readSchema(IMPLEMENTERS[0]).properties.verdict.description;
    const rev = readSchema('security-reviewer').properties.verdict.description;
    expect(impl).not.toBe(rev);
    // Implementer description does NOT mention "findings" (a reviewer concept)
    expect(impl).not.toContain('findings');
  });
});

// =============================================================================
// AJV compile + validate against verdict enum
// =============================================================================

describe('AJV compile + validate against verdict enum (#472)', () => {
  const BASE = { status: 'done', task_id: 't1', files_changed: [], blockers: [] };

  it.each(IMPLEMENTERS)('%s — example without verdict is valid (backward-compat)', async (name) => {
    const ajv = await getAjv2020({ allErrors: true, strict: false });
    const schema = readSchema(name);
    const validate = ajv.compile(schema);
    expect(validate({ ...BASE })).toBe(true);
  });

  it.each(IMPLEMENTERS)('%s — verdict=PROCEED is valid', async (name) => {
    const ajv = await getAjv2020({ allErrors: true, strict: false });
    const schema = readSchema(name);
    const validate = ajv.compile(schema);
    expect(validate({ ...BASE, verdict: 'PROCEED' })).toBe(true);
  });

  it.each(IMPLEMENTERS)('%s — verdict=MAYBE is invalid', async (name) => {
    const ajv = await getAjv2020({ allErrors: true, strict: false });
    const schema = readSchema(name);
    const validate = ajv.compile(schema);
    expect(validate({ ...BASE, verdict: 'MAYBE' })).toBe(false);
  });
});

// =============================================================================
// Agent body: JSON example + status→verdict mapping documented
// =============================================================================

describe('agent body emits verdict + status→verdict mapping (#472)', () => {
  it.each(IMPLEMENTERS)('%s.md JSON example contains "verdict": "PROCEED"', (name) => {
    expect(readBody(name)).toContain('"verdict": "PROCEED"');
  });

  it.each(IMPLEMENTERS)('%s.md documents status→verdict mapping triple', (name) => {
    expect(readBody(name)).toContain(MAPPING_TRIPLE);
  });
});
