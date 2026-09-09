/**
 * tests/lib/session-token-rollup.test.mjs
 *
 * Unit tests for scripts/lib/session-token-rollup.mjs (Epic #644).
 *
 * Covered:
 *   rollupSessionTokens — sums token_input/token_output for a given
 *     parent_session_id across TOKEN-BEARING records only (#949 provenance
 *     gate); counts distinct agent_ids with tokens; returns null totals (not 0)
 *     when no trustworthy token data is present; tolerates absent file; skips
 *     malformed JSONL lines; excludes records with a different
 *     parent_session_id.
 *
 * Fixture strategy: records are built by `stopRecord()` / `preFixStopRecord()` /
 * `phantomStopRecord()` / `startRecord()`, whose field sets are copied from REAL
 * records in `.orchestrator/metrics/subagents.jsonl` (testing.md § "Fixtures
 * Mirror Production Data"). This matters here specifically: the previous
 * fixtures were hand-shaped `{parent_session_id, agent_id, token_input,
 * token_output}` objects carrying neither `event` nor
 * `subagent_transcript_found` — a shape the producer has never written. Because
 * they encoded the reader's assumption rather than the writer's output, they
 * stayed green for the entire lifetime of the #949 defect, in which 73 sessions
 * summed to 96,148,781 tokens no agent ever spent.
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
// Golden-record fixture builders
//
// Field sets copied verbatim from real records in
// .orchestrator/metrics/subagents.jsonl (harvested 2026-08-11), with ids and
// token values substituted. Do not hand-trim these to "what the function needs"
// — that is precisely the unfaithful double that hid the #949 defect.
// ---------------------------------------------------------------------------

/**
 * A post-#949 stop record that read the subagent's OWN transcript.
 * Golden record: agent aee9b23ff10c1d54d, 2026-08-03T06:56:15.159Z.
 */
function stopRecord({ session, agent, input, output }) {
  return {
    // schema_version 2 since #1244 — the rollup sums the v2 contract only, so a
    // v1 golden here would make every summation case assert the exclusion path
    // instead of the summation it is named for. The v1 exclusion has its own
    // case at the bottom of this file.
    timestamp: '2026-08-03T06:56:15.159Z',
    event: 'stop',
    agent_id: agent,
    schema_version: 2,
    agent_type: 'Explore',
    parent_session_id: session,
    duration_ms: 340813,
    start_record_found: true,
    subagent_transcript_found: true,
    token_input: input,
    token_output: output,
    total_cost_usd: null,
    'gen_ai.usage.input_tokens': input,
    'gen_ai.usage.output_tokens': output,
    'gen_ai.system': 'anthropic',
  };
}

/**
 * A PRE-#949 stop record: carries tokens, but they are the PARENT session's
 * running totals, and it predates the `subagent_transcript_found` flag.
 * Golden record: agent a204d139a72b698d1, 2026-06-13T10:44:47.773Z — note the
 * fabricated `duration_ms: 0` and null `agent_type` of that era.
 */
function preFixStopRecord({ session, agent, input, output }) {
  return {
    timestamp: '2026-06-13T10:44:47.773Z',
    event: 'stop',
    agent_id: agent,
    schema_version: 1,
    parent_session_id: session,
    duration_ms: 0,
    token_input: input,
    token_output: output,
    total_cost_usd: null,
    'gen_ai.usage.input_tokens': input,
    'gen_ai.usage.output_tokens': output,
    'gen_ai.system': 'anthropic',
    agent_type: null,
  };
}

/**
 * A phantom stop (#939): the harness fired SubagentStop for an agent that never
 * existed. Golden record: agent ad0d22660706f6c34, 2026-08-06T05:38:03.922Z.
 */
function phantomStopRecord({ session, agent }) {
  return {
    timestamp: '2026-08-06T05:38:03.922Z',
    event: 'stop',
    agent_id: agent,
    schema_version: 1,
    parent_session_id: session,
    duration_ms: null,
    start_record_found: false,
    subagent_transcript_found: false,
    total_cost_usd: null,
    'gen_ai.usage.input_tokens': null,
    'gen_ai.usage.output_tokens': null,
    'gen_ai.system': 'anthropic',
    agent_type: null,
    token_input: null,
    token_output: null,
  };
}

/** A start record — never carries tokens. */
function startRecord({ session, agent }) {
  return {
    timestamp: '2026-08-03T06:50:34.201Z',
    event: 'start',
    agent_id: agent,
    schema_version: 1,
    agent_type: 'Explore',
    parent_session_id: session,
  };
}

/** Write JSONL lines to a file inside `tmp` and return its absolute path. */
function writeJsonl(filename, records) {
  const p = join(tmp, filename);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// Token provenance gate (#949) — the defect this module exists to prevent
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — token provenance gate (#949)', () => {
  it('excludes a pre-#949 record whose tokens are the parent transcript totals', () => {
    // The single most expensive shape in the ledger: it LOOKS like a healthy
    // record (non-null tokens, matching session) but its numbers describe the
    // parent, so summing it counts the parent once per subagent. Unfiltered,
    // this session would report 24854/3500.
    const subagentsPath = writeJsonl('subagents.jsonl', [
      preFixStopRecord({ session: 'sess-abc', agent: 'a204d139a72b698d1', input: 24854, output: 3500 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBeNull();
    expect(result.total_token_output).toBeNull();
    expect(result.subagents_with_tokens).toBe(0);
  });

  it('sums only the trustworthy half of a session that mixes pre-fix and post-fix records', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-real', input: 3532, output: 18524 }),
      preFixStopRecord({ session: 'sess-abc', agent: 'agent-legacy', input: 24854, output: 3500 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBe(3532);
    expect(result.total_token_output).toBe(18524);
    expect(result.subagents_with_tokens).toBe(1);
  });

  it('excludes a phantom stop from subagents_with_tokens but still counts it in matched_records', () => {
    // matched_records stays honest about how many records belong to the session;
    // it is simply not the denominator of a coverage ratio.
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-real', input: 3532, output: 18524 }),
      phantomStopRecord({ session: 'sess-abc', agent: 'ad0d22660706f6c34' }),
      phantomStopRecord({ session: 'sess-abc', agent: 'ac5e78c6cef713ac2' }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(1);
    expect(result.matched_records).toBe(3);
  });

  it('does not count a start record as token-bearing', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      startRecord({ session: 'sess-abc', agent: 'agent-1' }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBeNull();
    expect(result.subagents_with_tokens).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Happy-path: sums tokens for matching parent_session_id
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — token summation', () => {
  it('sums token_input and token_output across all records matching parent_session_id', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 100, output: 200 }),
      stopRecord({ session: 'sess-abc', agent: 'agent-2', input: 50, output: 60 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBe(150);
    expect(result.total_token_output).toBe(260);
  });

  it('returns matched_records equal to the count of records with the matching parent_session_id', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 100, output: 200 }),
      stopRecord({ session: 'sess-abc', agent: 'agent-2', input: 50, output: 60 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.matched_records).toBe(2);
  });

  it('skips records with null token_input and null token_output but still counts them in matched_records', () => {
    // 2 records with tokens (100/200 + 50/60), 1 with both null → totals 150/260
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 100, output: 200 }),
      stopRecord({ session: 'sess-abc', agent: 'agent-2', input: 50, output: 60 }),
      stopRecord({ session: 'sess-abc', agent: 'agent-3', input: null, output: null }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBe(150);
    expect(result.total_token_output).toBe(260);
    expect(result.matched_records).toBe(3);
  });

  it('treats a record with only token_input present (token_output null) correctly — partial non-null', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 300, output: null }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_input).toBe(300);
    expect(result.total_token_output).toBeNull();
  });

  it('treats a record with only token_output present (token_input null) correctly', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: null, output: 400 }),
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
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 100, output: 200 }),
      stopRecord({ session: 'sess-abc', agent: 'agent-2', input: 50, output: 60 }),
      // agent-3 has null tokens — should NOT be counted
      stopRecord({ session: 'sess-abc', agent: 'agent-3', input: null, output: null }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(2);
  });

  it('counts the same agent_id only once even when it has multiple records with tokens', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 100, output: 200 }),
      // Same agent_id appearing twice
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 50, output: 60 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(1);
  });

  it('counts an agent with only token_input (output null) as having tokens', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-only-input', input: 100, output: null }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.subagents_with_tokens).toBe(1);
  });

  it('returns subagents_with_tokens: 0 when all records have null tokens', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: null, output: null }),
      stopRecord({ session: 'sess-abc', agent: 'agent-2', input: null, output: null }),
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
      stopRecord({ session: 'OTHER-session', agent: 'agent-1', input: 100, output: 200 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    // Critically: null, not 0.  A result of 0 would misrepresent "no data" as "free session".
    expect(result.total_token_input).toBeNull();
  });

  it('returns total_token_output: null (NOT 0) when no matching records exist', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'OTHER-session', agent: 'agent-1', input: 100, output: 200 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.total_token_output).toBeNull();
  });

  it('returns matched_records: 0 when no records match parent_session_id', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'OTHER-session', agent: 'agent-1', input: 100, output: 200 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result.matched_records).toBe(0);
  });

  it('returns the full null/zero sentinel shape when file has no records for this session', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'OTHER-session', agent: 'agent-1', input: 100, output: 200 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    expect(result).toEqual({
      total_token_input: null,
      total_token_output: null,
      subagents_with_tokens: 0,
      matched_records: 0,
      total_token_input_uncached: null,
      total_token_cache_read: null,
      total_token_cache_creation: null,
      total_cost_usd: null,
      cost_records_priced: 0,
      cost_records_total: 0,
      legacy_v1_records: 0,
      _token_schema: 2,
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
      total_token_input_uncached: null,
      total_token_cache_read: null,
      total_token_cache_creation: null,
      total_cost_usd: null,
      cost_records_priced: 0,
      cost_records_total: 0,
      legacy_v1_records: 0,
      _token_schema: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// Malformed JSONL — resilience, no crash
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — malformed JSONL lines', () => {
  it('skips malformed lines and still sums tokens from valid lines', () => {
    const p = join(tmp, 'subagents.jsonl');
    const valid1 = JSON.stringify(stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 100, output: 200 }));
    const valid2 = JSON.stringify(stopRecord({ session: 'sess-abc', agent: 'agent-2', input: 50, output: 60 }));
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
      stopRecord({ session: 'sess-abc', agent: 'agent-1', input: 100, output: 200 }),
      stopRecord({ session: 'sess-DIFFERENT', agent: 'agent-other', input: 9999, output: 9999 }),
    ]);

    const result = rollupSessionTokens({ parentSessionId: 'sess-abc', subagentsPath });

    // Only sess-abc records contribute — the 9999 values must not appear
    expect(result.total_token_input).toBe(100);
    expect(result.total_token_output).toBe(200);
    expect(result.matched_records).toBe(1);
  });

  it('counts subagents_with_tokens for the requested session only, not other sessions', () => {
    const subagentsPath = writeJsonl('subagents.jsonl', [
      stopRecord({ session: 'sess-abc', agent: 'agent-abc-1', input: 100, output: 200 }),
      stopRecord({ session: 'sess-OTHER', agent: 'agent-other-1', input: 500, output: 600 }),
      stopRecord({ session: 'sess-OTHER', agent: 'agent-other-2', input: 700, output: 800 }),
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
      stopRecord({ session: '', agent: 'agent-1', input: 100, output: 200 }),
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
      total_token_input_uncached: null,
      total_token_cache_read: null,
      total_token_cache_creation: null,
      total_cost_usd: null,
      cost_records_priced: 0,
      cost_records_total: 0,
      legacy_v1_records: 0,
      _token_schema: 2,
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

// ---------------------------------------------------------------------------
// #1244 — the v1/v2 token contract boundary and the per-record cost estimate.
// ---------------------------------------------------------------------------

describe('rollupSessionTokens — schema_version 2 (#1244)', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rollup-v2-'));
  });

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  const write = (records) => {
    const p = join(dir, 'subagents.jsonl');
    writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return p;
  };

  const stop = (over = {}) => ({
    timestamp: '2026-09-09T10:00:00.000Z',
    event: 'stop',
    agent_id: 'a1',
    schema_version: 2,
    parent_session_id: 'S',
    subagent_transcript_found: true,
    duration_ms: 1000,
    token_input: 1100,
    token_input_uncached: 100,
    token_cache_read: 1000,
    token_cache_creation: 0,
    token_output: 10,
    model: 'claude-opus-5',
    ...over,
  });

  it('never sums a v1 record into a v2 total', () => {
    // v1 token_input is raw uncached input; v2 token_input is billable prompt
    // volume. Adding them produces a number describing neither — and the v1
    // record must still be VISIBLE, not silently dropped.
    const path = write([
      stop({ agent_id: 'v2' }),
      stop({ agent_id: 'v1', schema_version: 1, token_input: 999_999, token_output: 5 }),
    ]);

    const r = rollupSessionTokens({ parentSessionId: 'S', subagentsPath: path });
    expect(r.total_token_input).toBe(1100);
    expect(r.total_token_output).toBe(10);
    expect(r.legacy_v1_records).toBe(1);
    expect(r.subagents_with_tokens).toBe(1);
    expect(r._token_schema).toBe(2);
    expect(r.total_token_cache_read).toBe(1000);
    expect(r.total_token_input_uncached).toBe(100);
  });

  it('total_cost_usd is null when any priced record has an unknown model, with priced/total counts', () => {
    // A cost covering only part of the session reads as covering all of it —
    // so one unpriceable agent nulls the total and the counts say how much was
    // coverable.
    const path = write([
      stop({ agent_id: 'known' }),
      stop({ agent_id: 'unknown', model: 'gpt-5.6-sol' }),
    ]);

    const r = rollupSessionTokens({ parentSessionId: 'S', subagentsPath: path });
    expect(r.total_cost_usd).toBeNull();
    expect(r.cost_records_priced).toBe(1);
    expect(r.cost_records_total).toBe(2);

    // With the unknown-model record removed, the cost is a real number:
    // 100 uncached * $5/MTok + 1000 cache_read * $0.5/MTok + 10 out * $25/MTok.
    const known = rollupSessionTokens({
      parentSessionId: 'S',
      subagentsPath: write([stop({ agent_id: 'known' })]),
    });
    expect(known.total_cost_usd).toBeCloseTo(100 * 5e-6 + 1000 * 0.5e-6 + 10 * 25e-6, 12);
    expect(known.cost_records_priced).toBe(1);
    expect(known.cost_records_total).toBe(1);
  });
});
