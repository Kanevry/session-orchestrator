/**
 * tests/lib/vault-sync-baseline.test.mjs
 *
 * Unit tests for scripts/lib/vault-sync-baseline.mjs (issue #327).
 *
 * Coverage matrix:
 *   computeSchemaHash  — determinism, distinct inputs, empty string
 *   writeBaseline      — creates parent dir, writes required header fields,
 *                        no temp file residue after success (atomic rename)
 *   readBaseline       — null on missing file, null on invalid JSON,
 *                        returns parsed object on valid file
 *   diffBaseline       — all-new, all-resolved, identical, partial overlap,
 *                        (file, path, message) triple identity for same-file different-path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSchemaHash,
  writeBaseline,
  readBaseline,
  diffBaseline,
} from '@lib/vault-sync-baseline.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vsb-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// computeSchemaHash
// ---------------------------------------------------------------------------

describe('computeSchemaHash', () => {
  it('returns deterministic 8-char hex for the same input', () => {
    const a = computeSchemaHash('hello world');
    const b = computeSchemaHash('hello world');
    expect(a).toBe(b);
    expect(a).toHaveLength(8);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('different inputs produce different hashes', () => {
    const a = computeSchemaHash('schema v1');
    const b = computeSchemaHash('schema v2');
    expect(a).not.toBe(b);
  });

  it('empty string returns deterministic non-empty 8-char hex hash', () => {
    const h = computeSchemaHash('');
    // SHA-256('') is well-known — first 8 chars are 'e3b0c442'
    expect(h).toBe('e3b0c442');
    expect(h).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// writeBaseline
// ---------------------------------------------------------------------------

describe('writeBaseline', () => {
  it('creates parent directory if it does not exist', () => {
    const nested = join(tmp, 'a', 'b', 'c', 'baseline.json');
    writeBaseline(nested, {
      errors: [],
      warnings: [],
      schemaHash: 'abc12345',
      isoTimestamp: '2026-05-08T00:00:00.000Z',
      vaultDir: '/fake/vault',
    });
    expect(existsSync(nested)).toBe(true);
  });

  it('writes valid JSON with all required header fields', () => {
    const filePath = join(tmp, 'baseline.json');
    writeBaseline(filePath, {
      errors: [{ file: 'a.md', path: 'id', message: 'missing id' }],
      warnings: [{ file: 'b.md', type: 'dangling-wiki-link', message: 'link not found' }],
      schemaHash: 'deadbeef',
      isoTimestamp: '2026-05-08T12:00:00.000Z',
      vaultDir: '/tmp/vault',
    });

    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw.schema_hash).toBe('deadbeef');
    expect(raw.generated_at).toBe('2026-05-08T12:00:00.000Z');
    expect(raw.vault_dir).toBe('/tmp/vault');
    expect(raw.error_count).toBe(1);
    expect(raw.warning_count).toBe(1);
    expect(raw.errors).toHaveLength(1);
    expect(raw.warnings).toHaveLength(1);
  });

  it('atomic write — no .tmp residue file left after a successful write', () => {
    const filePath = join(tmp, 'baseline.json');
    writeBaseline(filePath, {
      errors: [],
      warnings: [],
      schemaHash: 'aabbccdd',
      isoTimestamp: '2026-05-08T00:00:00.000Z',
      vaultDir: '/tmp/vault',
    });

    // After success, no *.tmp* file should remain in the parent directory
    const residue = readdirSync(tmp).filter((f) => f.includes('.tmp'));
    expect(residue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// readBaseline
// ---------------------------------------------------------------------------

describe('readBaseline', () => {
  it('returns null when the file does not exist (no throw)', () => {
    const result = readBaseline(join(tmp, 'nonexistent.json'));
    expect(result).toBeNull();
  });

  it('returns null when the file contains invalid JSON (no throw)', () => {
    const filePath = join(tmp, 'bad.json');
    writeFileSync(filePath, 'this is not json { at all', 'utf8');
    const result = readBaseline(filePath);
    expect(result).toBeNull();
  });

  it('returns null when the file is valid JSON but missing required shape fields', () => {
    const filePath = join(tmp, 'wrong-shape.json');
    writeFileSync(filePath, JSON.stringify({ foo: 'bar' }), 'utf8');
    const result = readBaseline(filePath);
    expect(result).toBeNull();
  });

  it('returns parsed object with correct field mapping when file is valid', () => {
    const filePath = join(tmp, 'baseline.json');
    writeBaseline(filePath, {
      errors: [{ file: 'x.md', path: 'type', message: 'Invalid enum value' }],
      warnings: [],
      schemaHash: 'cafebabe',
      isoTimestamp: '2026-05-08T09:00:00.000Z',
      vaultDir: '/tmp/myvault',
    });

    const result = readBaseline(filePath);
    expect(result).not.toBeNull();
    expect(result.schemaHash).toBe('cafebabe');
    expect(result.generated_at).toBe('2026-05-08T09:00:00.000Z');
    expect(result.vault_dir).toBe('/tmp/myvault');
    expect(result.error_count).toBe(1);
    expect(result.warning_count).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// diffBaseline
// ---------------------------------------------------------------------------

describe('diffBaseline', () => {
  it('empty baseline + non-empty current → all current items are newErrors', () => {
    const current = [
      { file: 'a.md', path: 'id', message: 'missing id' },
      { file: 'b.md', path: 'type', message: 'Invalid enum value' },
    ];
    const result = diffBaseline({ baselineErrors: [], currentErrors: current });
    expect(result.newErrors).toHaveLength(2);
    expect(result.resolvedErrors).toHaveLength(0);
    expect(result.baselineCount).toBe(0);
    expect(result.currentCount).toBe(2);
  });

  it('non-empty baseline + empty current → all baseline items are resolvedErrors', () => {
    const baseline = [
      { file: 'a.md', path: 'id', message: 'missing id' },
    ];
    const result = diffBaseline({ baselineErrors: baseline, currentErrors: [] });
    expect(result.newErrors).toHaveLength(0);
    expect(result.resolvedErrors).toHaveLength(1);
    expect(result.baselineCount).toBe(1);
    expect(result.currentCount).toBe(0);
  });

  it('identical baseline and current → newErrors and resolvedErrors are both empty', () => {
    const errors = [
      { file: 'a.md', path: 'type', message: 'Invalid enum value' },
      { file: 'b.md', path: 'created', message: 'Ungueltiges Datum' },
    ];
    const result = diffBaseline({ baselineErrors: errors, currentErrors: errors });
    expect(result.newErrors).toHaveLength(0);
    expect(result.resolvedErrors).toHaveLength(0);
    expect(result.baselineCount).toBe(2);
    expect(result.currentCount).toBe(2);
  });

  it('partial overlap — only the non-overlapping items appear in each diff set', () => {
    const baseline = [
      { file: 'a.md', path: 'id', message: 'missing id' },        // will be resolved
      { file: 'b.md', path: 'type', message: 'Invalid enum' },    // stays
    ];
    const current = [
      { file: 'b.md', path: 'type', message: 'Invalid enum' },    // shared
      { file: 'c.md', path: 'created', message: 'bad date' },     // new
    ];
    const result = diffBaseline({ baselineErrors: baseline, currentErrors: current });
    expect(result.newErrors).toHaveLength(1);
    expect(result.newErrors[0].file).toBe('c.md');
    expect(result.resolvedErrors).toHaveLength(1);
    expect(result.resolvedErrors[0].file).toBe('a.md');
  });

  it('same file but different path → treated as two distinct errors (triple identity)', () => {
    // Two errors with the same file but different path must not cancel each other out.
    const baseline = [
      { file: 'a.md', path: 'id', message: 'missing id' },
    ];
    const current = [
      { file: 'a.md', path: 'type', message: 'missing id' },  // different path
    ];
    const result = diffBaseline({ baselineErrors: baseline, currentErrors: current });
    // The baseline one is gone (resolved), the current one is new
    expect(result.newErrors).toHaveLength(1);
    expect(result.newErrors[0].path).toBe('type');
    expect(result.resolvedErrors).toHaveLength(1);
    expect(result.resolvedErrors[0].path).toBe('id');
  });

  it('gracefully handles undefined arrays (no throw)', () => {
    // Both sides missing — should return empty diff without throwing.
    const result = diffBaseline({ baselineErrors: undefined, currentErrors: undefined });
    expect(result.newErrors).toHaveLength(0);
    expect(result.resolvedErrors).toHaveLength(0);
    expect(result.baselineCount).toBe(0);
    expect(result.currentCount).toBe(0);
  });
});
