/**
 * tests/lib/session-token-rollup.test.mjs
 *
 * Unit tests for scripts/lib/session-token-rollup.mjs (Epic #644).
 *
 * Covered:
 *   rollupSessionTokens — sums token_input/token_output for a given
 *     parent_session_id, skipping null values; counts distinct agent_ids
 *     with non-null tokens; returns null totals (not 0) when no token data
 *     is present; tolerates absent file; skips malformed JSONL lines;
 *     excludes records with a different parent_session_id.
 *
 * Fixture strategy: write JSONL to a tmp directory per test, pass as
 * subagentsPath. Cleaned up in afterEach.
 *
 * Testing-rule compliance (testing.md):
 *   - All expected values are hardcoded literals (no computed mirrors).
 *   - Every test has ≥1 meaningful assertion that would fail if the
 *     function body were deleted (falsification-check passed).
 *   - Error paths and boundary conditions covered alongside happy path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rollupSessionTokens } from '@lib/session-token-rollup.mjs';

// ---------------------------------------------------------------------------
// Temp-dir lifecycle
// ---------------------------------------------------------------------------

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'session-token-rollup-'));
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write JSONL lines to a file inside `tmp` and return its absolute path. */
function writeJsonl(filename, records) {
  const p = join(tmp, filename);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Happy-path: sums tokens for matching parent_session_id
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — token summation', () => {
  it('sums token_input and token_output across all records matching parent_session_id', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 100, token_output: 200 },
      { parent_session_id: 'sess-abc', agent_id: 'agent-2', token_input: 50, token_output: 60 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBe(150);
    expect(result.total_token_output).toBe(260);
  });

  it('returns matched_records equal to the count of records with the matching parent_session_id', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 100, token_output: 200 },
      { parent_session_id: 'sess-abc', agent_id: 'agent-2', token_input: 50, token_output: 60 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.matched_records).toBe(2);
  });

  it('skips records with null token_input and null token_output but still counts them in matched_records', () => {
    // 2 records with tokens (100/200 + 50/60), 1 with both null → totals 150/260
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 100, token_output: 200 },
      { parent_session_id: 'sess-abc', agent_id: 'agent-2', token_input: 50, token_output: 60 },
      { parent_session_id: 'sess-abc', agent_id: 'agent-3', token_input: null, token_output: null },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBe(150);
    expect(result.total_token_output).toBe(260);
    expect(result.matched_records).toBe(3);
  });

  it('treats a record with only token_input present (token_output null) correctly — partial non-null', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 300, token_output: null },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBe(300);
    expect(result.total_token_output).toBeNull();
  });

  it('treats a record with only token_output present (token_input null) correctly', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: null, token_output: 400 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBeNull();
    expect(result.total_token_output).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// subagents_with_tokens — distinct agent coverage count
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — subagents_with_tokens', () => {
  it('counts distinct agent_ids that have at least one non-null token field', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 100, token_output: 200 },
      { parent_session_id: 'sess-abc', agent_id: 'agent-2', token_input: 50, token_output: 60 },
      // agent-3 has null tokens — should NOT be counted
      { parent_session_id: 'sess-abc', agent_id: 'agent-3', token_input: null, token_output: null },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(2);
  });

  it('counts the same agent_id only once even when it has multiple records with tokens', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 100, token_output: 200 },
      // Same agent_id appearing twice
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 50, token_output: 60 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(1);
  });

  it('counts an agent with only token_input (output null) as having tokens', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-only-input', token_input: 100, token_output: null },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(1);
  });

  it('returns subagents_with_tokens: 0 when all records have null tokens', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: null, token_output: null },
      { parent_session_id: 'sess-abc', agent_id: 'agent-2', token_input: null, token_output: null },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Null-total sentinel — the "no token data" invariant
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — null sentinel when no token data', () => {
  it('returns total_token_input: null (NOT 0) when no matching records exist', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'OTHER-session', agent_id: 'agent-1', token_input: 100, token_output: 200 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    // Critically: null, not 0.  A result of 0 would misrepresent "no data" as "free session".
    expect(result.total_token_input).toBeNull();
  });

  it('returns total_token_output: null (NOT 0) when no matching records exist', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'OTHER-session', agent_id: 'agent-1', token_input: 100, token_output: 200 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_output).toBeNull();
  });

  it('returns matched_records: 0 when no records match parent_session_id', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'OTHER-session', agent_id: 'agent-1', token_input: 100, token_output: 200 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.matched_records).toBe(0);
  });

  it('returns the full null/zero sentinel shape when file has no records for this session', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'OTHER-session', agent_id: 'agent-1', token_input: 100, token_output: 200 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result).toEqual({
      total_token_input: null,
      total_token_output: null,
      subagents_with_tokens: 0,
      matched_records: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Absent file — no throw, null/zero result
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — absent subagents file', () => {
  it('does not throw when the subagents file does not exist', () => {
    const missingPath = join(tmp, 'nonexistent', 'subagents.jsonl');

    expect(() =>
      rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: missingPath })
    ).not.toThrow();
  });

  it('returns null totals and zero counts when the file is absent', () => {
    const missingPath = join(tmp, 'nonexistent', 'subagents.jsonl');

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: missingPath });

    expect(result).toEqual({
      total_token_input: null,
      total_token_output: null,
      subagents_with_tokens: 0,
      matched_records: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL — resilience, no crash
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — malformed JSONL lines', () => {
  it('skips malformed lines and still sums tokens from valid lines', () => {
    const p = join(tmp, 'subagents.jsonl');
    const valid1 = JSON.stringify({ parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 100, token_output: 200 });
    const valid2 = JSON.stringify({ parent_session_id: 'sess-abc', agent_id: 'agent-2', token_input: 50, token_output: 60 });
    writeFileSync(p, [
      valid1,
      'THIS IS NOT JSON }{{{',
      valid2,
      '',
    ].join('\n'), 'utf8');

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: p });

    expect(result.total_token_input).toBe(150);
    expect(result.total_token_output).toBe(260);
    expect(result.matched_records).toBe(2);
  });

  it('does not throw when every line in the file is malformed JSON', () => {
    const p = join(tmp, 'subagents.jsonl');
    writeFileSync(p, 'not json\nalso not json\n', 'utf8');

    expect(() =>
      rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: p })
    ).not.toThrow();
  });

  it('returns null totals when all lines are malformed (no valid records)', () => {
    const p = join(tmp, 'subagents.jsonl');
    writeFileSync(p, 'garbage1\ngarbage2\n', 'utf8');

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: p });

    expect(result.total_token_input).toBeNull();
    expect(result.total_token_output).toBeNull();
    expect(result.matched_records).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-session exclusion — different parent_session_id must be ignored
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — cross-session isolation', () => {
  it('excludes records that belong to a different parent_session_id', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-1', token_input: 100, token_output: 200 },
      { parent_session_id: 'sess-DIFFERENT', agent_id: 'agent-other', token_input: 9999, token_output: 9999 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    // Only sess-abc records contribute — the 9999 values must not appear
    expect(result.total_token_input).toBe(100);
    expect(result.total_token_output).toBe(200);
    expect(result.matched_records).toBe(1);
  });

  it('counts subagents_with_tokens for the requested session only, not other sessions', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: 'sess-abc', agent_id: 'agent-abc-1', token_input: 100, token_output: 200 },
      { parent_session_id: 'sess-OTHER', agent_id: 'agent-other-1', token_input: 500, token_output: 600 },
      { parent_session_id: 'sess-OTHER', agent_id: 'agent-other-2', token_input: 700, token_output: 800 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases — empty string parentSessionId, empty file
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — edge cases', () => {
  it('returns null/zero sentinel when parentSessionId is an empty string', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      { parent_session_id: '', agent_id: 'agent-1', token_input: 100, token_output: 200 },
    ]);

    const result = rollupSessionTokens({ parentSessionId: '', subagentsPath });

    // Empty string parentSessionId is treated as invalid — sentinel returned
    expect(result.total_token_input).toBeNull();
    expect(result.total_token_output).toBeNull();
    expect(result.matched_records).toBe(0);
  });

  it('handles an empty file without throwing', () => {
    const p = join(tmp, 'empty.jsonl');
    writeFileSync(p, '', 'utf8');

    expect(() =>
      rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: p })
    ).not.toThrow();
  });

  it('returns null/zero sentinel for an empty file', () => {
    const p = join(tmp, 'empty.jsonl');
    writeFileSync(p, '', 'utf8');

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: p });

    expect(result).toEqual({
      total_token_input: null,
      total_token_output: null,
      subagents_with_tokens: 0,
      matched_records: 0,
    });
  });

  it('handles a file with only blank lines without throwing', () => {
    const p = join(tmp, 'blanks.jsonl');
    writeFileSync(p, '\n\n\n', 'utf8');

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath: p });

    expect(result.total_token_input).toBeNull();
    expect(result.matched_records).toBe(0);
  });
});
