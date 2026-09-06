/**
 * tests/skills/frontmatter-guard.test.mjs
 *
 * Unit tests for scripts/lib/frontmatter-guard.mjs (#328).
 *
 * Covered:
 *   readVaultSchema   — returns null on missing file, returns parsed schema with expected fields
 *   computeSchemaHash — 8-char hex, different inputs → different hashes
 *   generateFrontmatterSnippet — contains enum values, required fields, ≥3 YAML examples,
 *                                valid markdown fences, is deterministic
 *   detectVaultTaskScope — vault path rules, subdirectory rules, taskDescription heuristic,
 *                          non-vault paths return false
 */

import { describe, it, expect } from 'vitest';
import {
  readVaultSchema,
  computeSchemaHash,
  generateFrontmatterSnippet,
  detectVaultTaskScope,
} from '@lib/frontmatter-guard.mjs';

// ---------------------------------------------------------------------------
// Minimal schema fixture used by generateFrontmatterSnippet tests
// ---------------------------------------------------------------------------

const MINIMAL_SCHEMA = {
  typeEnum: ['reference', 'session', 'learning', 'daily', 'project', 'adr', 'retro', 'note'],
  statusEnum: ['active', 'archived', 'draft', 'deprecated', 'evergreen'],
  requiredFields: ['id', 'type', 'created', 'updated'],
  idRegex: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
  tagsRegex: '^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$',
};

// ---------------------------------------------------------------------------
// readVaultSchema
// ---------------------------------------------------------------------------

describe('readVaultSchema', () => {
  it('returns null when the source file is missing — does not throw', () => {
    // The module reads from a hardcoded path in ~/Projects/projects-baseline/.
    // In CI / test environments that path likely does not exist — we rely on
    // that to exercise the null-return path. If it DOES exist we verify shape.
    const result = readVaultSchema();
    // Either null (file missing) or an object with the expected fields.
    if (result === null) {
      expect(result).toBeNull();
    } else {
      expect(typeof result).toBe('object');
    }
  });

  it('returns an object with typeEnum array when source present', () => {
    const result = readVaultSchema();
    if (result === null) return; // file not present in this environment — skip shape checks
    expect(Array.isArray(result.typeEnum)).toBe(true);
    expect(result.typeEnum.length).toBeGreaterThanOrEqual(1);
  });

  it('returns statusEnum array when source present', () => {
    const result = readVaultSchema();
    if (result === null) return;
    expect(Array.isArray(result.statusEnum)).toBe(true);
    expect(result.statusEnum.length).toBeGreaterThanOrEqual(1);
  });

  it('returns requiredFields array containing id and type when source present', () => {
    const result = readVaultSchema();
    if (result === null) return;
    expect(Array.isArray(result.requiredFields)).toBe(true);
    expect(result.requiredFields).toContain('id');
    expect(result.requiredFields).toContain('type');
  });

  it('returns idRegex string when source present', () => {
    const result = readVaultSchema();
    if (result === null) return;
    expect(typeof result.idRegex).toBe('string');
    expect(result.idRegex.length).toBeGreaterThan(0);
  });

  it('typeEnum has at least 5 values when source present', () => {
    const result = readVaultSchema();
    if (result === null) return;
    expect(result.typeEnum.length).toBeGreaterThanOrEqual(5);
  });

  it('statusEnum has at least 5 values when source present', () => {
    const result = readVaultSchema();
    if (result === null) return;
    expect(result.statusEnum.length).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// computeSchemaHash
// ---------------------------------------------------------------------------

describe('computeSchemaHash', () => {
  it('returns an 8-character hex string', () => {
    const hash = computeSchemaHash('hello world');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('same input produces the same hash (deterministic)', () => {
    const h1 = computeSchemaHash('schema text v1');
    const h2 = computeSchemaHash('schema text v1');
    expect(h1).toBe(h2);
  });

  it('different inputs produce different hashes', () => {
    const h1 = computeSchemaHash('schema text v1');
    const h2 = computeSchemaHash('schema text v2');
    expect(h1).not.toBe(h2);
  });

  // NAMED BUG (2026-09-06 Wave 1): with no projects-baseline checkout,
  // `readVaultSchema()` returns null and the caller passed the absent schemaText
  // straight in. `digestSha256Short('')` produced `e3b0c442` — the SHA-256 of the
  // empty string — a real-LOOKING token that is IDENTICAL on every baseline-less
  // host, so a cache keyed on it reports "schema unchanged" having measured
  // nothing. The previous version of this test asserted that hash was fine.
  it('returns null for the empty string — never the empty-string hash e3b0c442', () => {
    expect(computeSchemaHash('')).toBeNull();
    expect(computeSchemaHash('')).not.toBe('e3b0c442');
  });

  it('returns null for null/undefined (the no-schema state)', () => {
    expect(computeSchemaHash(null)).toBeNull();
    expect(computeSchemaHash(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Degraded mode — no projects-baseline checkout reachable
// ---------------------------------------------------------------------------
//
// NAMED BUG (2026-09-06 Wave 1): `SCHEMA_SOURCE_PATH` was hardcoded to
// `$HOME/Projects/projects-baseline/...`, which does not exist on hosts whose
// (optional, private) checkout lives elsewhere. `readVaultSchema()` degraded to
// `null` correctly — and `generateFrontmatterSnippet()` then destructured it and
// died with `Cannot destructure property 'typeEnum' of 'schema' as it is
// undefined`, taking the pre-dispatch hook down with it.

describe('generateFrontmatterSnippet degraded mode', () => {
  it('does not throw when the schema is null', () => {
    expect(() => generateFrontmatterSnippet(null)).not.toThrow();
  });

  it('does not throw when called with no argument at all', () => {
    expect(() => generateFrontmatterSnippet()).not.toThrow();
  });

  it('the fallback snippet is a usable schema block, not a stub', () => {
    const snippet = generateFrontmatterSnippet(null);
    expect(typeof snippet).toBe('string');
    expect(snippet).toContain('Vault Frontmatter Schema');
    // Required fields and a representative type enum member must survive.
    for (const field of ['id', 'type', 'created', 'updated']) {
      expect(snippet).toContain(`\`${field}\``);
    }
    for (const t of ['reference', 'session', 'learning', 'daily', 'project']) {
      expect(snippet).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// generateFrontmatterSnippet
// ---------------------------------------------------------------------------

describe('generateFrontmatterSnippet', () => {
  it('output contains all typeEnum values', () => {
    const snippet = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    for (const typeVal of MINIMAL_SCHEMA.typeEnum) {
      expect(snippet, `expected snippet to contain type value "${typeVal}"`).toContain(typeVal);
    }
  });

  it('output contains all statusEnum values', () => {
    const snippet = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    for (const statusVal of MINIMAL_SCHEMA.statusEnum) {
      expect(snippet, `expected snippet to contain status value "${statusVal}"`).toContain(statusVal);
    }
  });

  it('output includes all required fields', () => {
    const snippet = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    for (const field of MINIMAL_SCHEMA.requiredFields) {
      expect(snippet, `expected snippet to mention required field "${field}"`).toContain(field);
    }
  });

  it('output contains at least 3 YAML code block examples', () => {
    const snippet = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    // Each example is wrapped in ```yaml ... ``` fences
    const fenceMatches = snippet.match(/```yaml/g);
    expect(fenceMatches).not.toBeNull();
    expect(fenceMatches.length).toBeGreaterThanOrEqual(3);
  });

  it('all opened yaml code fences are closed (no broken fences)', () => {
    const snippet = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    const opens = (snippet.match(/```yaml/g) ?? []).length;
    // Match closing fences followed by newline OR end-of-string
    const closes = (snippet.match(/```(?:\s*\n|\s*$)/gm) ?? []).length;
    // Every ```yaml must have a matching closing ```
    expect(closes).toBeGreaterThanOrEqual(opens);
  });

  it('output is deterministic — identical input produces byte-identical output', () => {
    const s1 = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    const s2 = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    expect(s1).toBe(s2);
  });

  it('output includes the idRegex pattern', () => {
    const snippet = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    expect(snippet).toContain(MINIMAL_SCHEMA.idRegex);
  });

  it('output is a non-empty string', () => {
    const snippet = generateFrontmatterSnippet(MINIMAL_SCHEMA);
    expect(typeof snippet).toBe('string');
    expect(snippet.length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// detectVaultTaskScope
// ---------------------------------------------------------------------------

describe('detectVaultTaskScope', () => {
  it('returns true when fileScope contains a path with /Projects/vault/', () => {
    const result = detectVaultTaskScope('write a note', [
      '/Users/ada/Projects/vault/40-learnings/my-note.md',
    ]);
    expect(result).toBe(true);
  });

  it('returns true when fileScope contains a path under 40-learnings/', () => {
    const result = detectVaultTaskScope('', ['40-learnings/some-learning.md']);
    expect(result).toBe(true);
  });

  it('returns true when fileScope contains a path under 50-sessions/', () => {
    const result = detectVaultTaskScope('', ['50-sessions/session-2026-05-08.md']);
    expect(result).toBe(true);
  });

  it('returns true when fileScope contains a path under 03-daily/', () => {
    const result = detectVaultTaskScope('', ['03-daily/2026-05-08.md']);
    expect(result).toBe(true);
  });

  it('returns true when fileScope contains a path under 01-projects/', () => {
    const result = detectVaultTaskScope('', ['01-projects/session-orchestrator.md']);
    expect(result).toBe(true);
  });

  it('returns true when taskDescription says "write to vault"', () => {
    const result = detectVaultTaskScope('write to vault the session notes', []);
    expect(result).toBe(true);
  });

  it('returns true when taskDescription says "mirror vault learnings"', () => {
    const result = detectVaultTaskScope('mirror vault learnings to disk', []);
    expect(result).toBe(true);
  });

  it('returns true when taskDescription says "emit vault note"', () => {
    // "emit" matches the WRITE_INTENT_RE; "vault" satisfies the mentionsVault check
    const result = detectVaultTaskScope('emit vault note for today', []);
    expect(result).toBe(true);
  });

  it('returns false for non-vault fileScope (src/components/)', () => {
    const result = detectVaultTaskScope('update component', ['src/components/Button.tsx']);
    expect(result).toBe(false);
  });

  it('returns false when taskDescription mentions vault but has no write intent', () => {
    // "vault" present but no write-intent word
    const result = detectVaultTaskScope('read the vault schema definition', []);
    expect(result).toBe(false);
  });

  it('returns false for empty inputs', () => {
    const result = detectVaultTaskScope('', []);
    expect(result).toBe(false);
  });

  it('returns false for generic task description without vault mention', () => {
    const result = detectVaultTaskScope('write a unit test for the auth module', [
      'src/auth/auth.test.ts',
    ]);
    expect(result).toBe(false);
  });
});
