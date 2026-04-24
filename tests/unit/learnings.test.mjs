/**
 * tests/unit/learnings.test.mjs
 *
 * Vitest suite for `schema_version` hardening in scripts/lib/learnings.mjs
 * (Meta-Audit M1 + M7 track).
 *
 * Companion to the broader validator/reader/writer coverage in
 * tests/lib/learnings.test.mjs — this file focuses specifically on the
 * schema_version write-injection + read backward-compat contract.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateLearning,
  readLearnings,
  appendLearning,
  CURRENT_SCHEMA_VERSION,
  ValidationError,
} from '../../scripts/lib/learnings.mjs';

const LEGACY = () => ({
  id: 'schema-test-1',
  type: 'recurring-issue',
  subject: 'test-subject',
  insight: 'test insight',
  evidence: 'test evidence',
  confidence: 0.5,
  source_session: 'test-session',
  created_at: '2026-04-24T00:00:00Z',
  expires_at: '2026-05-24T00:00:00Z',
});

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'learnings-schema-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

describe('schema_version — write path injection (M7)', () => {
  it('appendLearning auto-injects schema_version when absent on input', async () => {
    const path = join(tmp, 'learnings.jsonl');
    const input = LEGACY();
    expect(input).not.toHaveProperty('schema_version');
    const written = await appendLearning(path, input);
    expect(written.schema_version).toBe(CURRENT_SCHEMA_VERSION);
    // and it actually landed on disk
    const raw = readFileSync(path, 'utf8').trim();
    const parsed = JSON.parse(raw);
    expect(parsed.schema_version).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('appendLearning preserves schema_version if already present on input', async () => {
    const path = join(tmp, 'learnings.jsonl');
    const pinned = { ...LEGACY(), schema_version: 0 };
    const written = await appendLearning(path, pinned);
    // explicit 0 must survive — nullish coalescing treats 0 as present
    expect(written.schema_version).toBe(0);
    const parsed = JSON.parse(readFileSync(path, 'utf8').trim());
    expect(parsed.schema_version).toBe(0);
  });
});

describe('schema_version — validator backward compat (M7)', () => {
  it('validateLearning accepts records with schema_version: 0 (legacy)', () => {
    const legacy = { ...LEGACY(), schema_version: 0 };
    expect(() => validateLearning(legacy)).not.toThrow();
    const v = validateLearning(legacy);
    expect(v.schema_version).toBe(0);
  });

  it('validateLearning accepts records with schema_version: 1 including all required fields', () => {
    const v1 = { ...LEGACY(), schema_version: 1 };
    const v = validateLearning(v1);
    expect(v.schema_version).toBe(1);
    // spot-check the required legacy fields came through intact
    expect(v.id).toBe(v1.id);
    expect(v.expires_at).toBe(v1.expires_at);
  });

  it('validateLearning rejects unknown schema_version values', () => {
    const bad = { ...LEGACY(), schema_version: 2 };
    expect(() => validateLearning(bad)).toThrow(ValidationError);
    expect(() => validateLearning(bad)).toThrow(/schema_version/);
  });
});

describe('schema_version — mixed v0 + v1 read path (M7)', () => {
  it('reading a file with mixed v0 + v1 records normalizes both without crashing', async () => {
    const path = join(tmp, 'learnings.jsonl');
    // one legacy record (no schema_version at all, simulating pre-versioning)
    // and one v1 record (schema_version: 1 tagged explicitly).
    const legacyNoTag = LEGACY();
    const v1Tagged = { ...LEGACY(), id: 'schema-test-2', schema_version: 1 };
    writeFileSync(
      path,
      JSON.stringify(legacyNoTag) + '\n' + JSON.stringify(v1Tagged) + '\n'
    );

    // spy on console.error so we can assert the WARN fires for the untagged
    // record AND we keep test output clean.
    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { entries, malformed } = await readLearnings(path);
      expect(malformed).toEqual([]);
      expect(entries.length).toBe(2);
      // untagged record becomes v0; tagged stays v1
      expect(entries[0].schema_version).toBe(0);
      expect(entries[1].schema_version).toBe(1);
      // WARN was emitted exactly once (for the untagged record only)
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/missing schema_version/);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
