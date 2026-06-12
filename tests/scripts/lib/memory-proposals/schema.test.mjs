/**
 * tests/scripts/lib/memory-proposals/schema.test.mjs
 *
 * Unit tests for scripts/lib/memory-proposals/schema.mjs.
 *
 * Coverage targets:
 *  - PROPOSAL_TYPES constant shape
 *  - SCHEMA_VERSION constant value
 *  - createProposalRecord() factory — field mapping, auto-fields, optional field
 *  - validateProposalRecord() — happy path + all rejection modes
 *  - serializeProposal() / deserializeProposal() — roundtrip + null-safety
 *
 * Style: describe/it, hardcoded literal expected values, no branching in tests.
 * Falsification notes show which single mutation would break each test.
 */

import { describe, expect, it } from 'vitest';

import {
  PROPOSAL_TYPES,
  SCHEMA_VERSION,
  createProposalRecord,
  deserializeProposal,
  serializeProposal,
  validateProposalRecord,
} from '@lib/memory-proposals/schema.mjs';
import { LEARNING_TTL_DAYS } from '@lib/learnings/schema.mjs';

// ---------------------------------------------------------------------------
// Shared minimal-valid fixture
// ---------------------------------------------------------------------------

/**
 * Returns a minimal set of valid opts for createProposalRecord().
 * Callers may spread-override individual fields.
 */
function validOpts(overrides = {}) {
  return {
    type: 'recurring-issue',
    subject: 'A concise test subject',
    insight: 'The insight body for this proposal record.',
    evidence: 'Evidence: we observed this pattern in W3.',
    confidence: 0.85,
    waveId: 'W3',
    ...overrides,
  };
}

/**
 * Returns a complete, valid proposal record (created by the factory and
 * therefore structurally correct for validate/serialize tests).
 */
function validRecord(overrides = {}) {
  return createProposalRecord({ ...validOpts(), ...overrides });
}

// ---------------------------------------------------------------------------
// PROPOSAL_TYPES
// ---------------------------------------------------------------------------

describe('PROPOSAL_TYPES', () => {
  it('is a frozen array', () => {
    // FALSIFICATION: removing Object.freeze() in schema.mjs would let this push succeed → test fails
    expect(() => PROPOSAL_TYPES.push('injected')).toThrow();
  });

  it('contains "recurring-issue"', () => {
    // FALSIFICATION: deleting 'recurring-issue' from the array would fail this
    expect(PROPOSAL_TYPES).toContain('recurring-issue');
  });

  it('contains "proven-pattern"', () => {
    // FALSIFICATION: deleting 'proven-pattern' from the array would fail this
    expect(PROPOSAL_TYPES).toContain('proven-pattern');
  });

  it('contains "anti-pattern"', () => {
    // FALSIFICATION: deleting 'anti-pattern' from the array would fail this
    expect(PROPOSAL_TYPES).toContain('anti-pattern');
  });

  it('has at least 5 entries and no more than 50 (floor/ceiling; grows, not shrinks)', () => {
    // FALSIFICATION: emptying the array would drop below 5 → test fails
    expect(PROPOSAL_TYPES.length).toBeGreaterThanOrEqual(5);
    expect(PROPOSAL_TYPES.length).toBeLessThanOrEqual(50);
  });

  it('contains "domain-regression" (#638)', () => {
    // FALSIFICATION: deleting 'domain-regression' from PROPOSAL_TYPES would fail this
    expect(PROPOSAL_TYPES).toContain('domain-regression');
  });
});

// ---------------------------------------------------------------------------
// domain-regression registration invariant (#638)
//
// The module-comment invariant on PROPOSAL_TYPES requires every type to have a
// matching LEARNING_TTL_DAYS entry (so a promoted proposal derives a valid TTL).
// ---------------------------------------------------------------------------

describe('domain-regression registration (#638)', () => {
  it('LEARNING_TTL_DAYS defines a TTL for domain-regression', () => {
    // FALSIFICATION: omitting 'domain-regression' from LEARNING_TTL_DAYS leaves it undefined
    expect(LEARNING_TTL_DAYS['domain-regression']).toBe(60);
  });

  it('PROPOSAL_TYPES includes domain-regression', () => {
    // FALSIFICATION: omitting 'domain-regression' from PROPOSAL_TYPES would fail this
    expect(PROPOSAL_TYPES.includes('domain-regression')).toBe(true);
  });

  it('every PROPOSAL_TYPES entry has a matching LEARNING_TTL_DAYS entry (module invariant)', () => {
    // FALSIFICATION: adding a PROPOSAL_TYPES entry without a TTL entry would fail this
    for (const type of PROPOSAL_TYPES) {
      expect(LEARNING_TTL_DAYS[type], `missing LEARNING_TTL_DAYS entry for '${type}'`).toBeTypeOf(
        'number',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('SCHEMA_VERSION', () => {
  it('equals 1', () => {
    // FALSIFICATION: changing SCHEMA_VERSION = 1 to 2 in schema.mjs would fail this
    expect(SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// createProposalRecord()
// ---------------------------------------------------------------------------

describe('createProposalRecord', () => {
  it('maps type from opts into record.type', () => {
    // FALSIFICATION: removing the `type` assignment in the factory would fail this
    const record = createProposalRecord(validOpts({ type: 'anti-pattern' }));
    expect(record.type).toBe('anti-pattern');
  });

  it('maps subject from opts into record.subject', () => {
    // FALSIFICATION: removing the `subject` assignment in the factory would fail this
    const record = createProposalRecord(validOpts({ subject: 'Exact subject text' }));
    expect(record.subject).toBe('Exact subject text');
  });

  it('maps insight from opts into record.insight', () => {
    // FALSIFICATION: removing the `insight` assignment in the factory would fail this
    const record = createProposalRecord(validOpts({ insight: 'Exact insight text' }));
    expect(record.insight).toBe('Exact insight text');
  });

  it('maps evidence from opts into record.evidence', () => {
    // FALSIFICATION: removing the `evidence` assignment in the factory would fail this
    const record = createProposalRecord(validOpts({ evidence: 'Exact evidence text' }));
    expect(record.evidence).toBe('Exact evidence text');
  });

  it('maps confidence from opts into record.confidence', () => {
    // FALSIFICATION: removing the `confidence` assignment would fail this
    const record = createProposalRecord(validOpts({ confidence: 0.72 }));
    expect(record.confidence).toBe(0.72);
  });

  it('maps waveId to record.wave_id (camelCase → snake_case mapping)', () => {
    // FALSIFICATION: using `wave_id: waveId` as-is or swapping key name would fail this
    const record = createProposalRecord(validOpts({ waveId: 'W7' }));
    expect(record.wave_id).toBe('W7');
  });

  it('sets schema_version to 1', () => {
    // FALSIFICATION: omitting `schema_version: SCHEMA_VERSION` in factory would fail this
    const record = validRecord();
    expect(record.schema_version).toBe(1);
  });

  it('auto-generates a non-empty UUID v4 id', () => {
    // FALSIFICATION: hardcoding id to '' in factory would fail this
    const record = validRecord();
    expect(typeof record.id).toBe('string');
    expect(record.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('auto-generates a created_at ISO 8601 UTC timestamp', () => {
    // FALSIFICATION: omitting `created_at` or using a non-ISO string would fail this
    const record = validRecord();
    expect(typeof record.created_at).toBe('string');
    expect(record.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('sets proposed_by_agent when the optional field is provided', () => {
    // FALSIFICATION: removing the `if (proposedByAgent !== undefined)` block would never set this
    const record = createProposalRecord(validOpts({ proposedByAgent: 'test-writer-agent' }));
    expect(record.proposed_by_agent).toBe('test-writer-agent');
  });

  it('does NOT set proposed_by_agent when the optional field is omitted', () => {
    // FALSIFICATION: unconditionally assigning `record.proposed_by_agent = undefined` would fail this
    const record = validRecord();
    expect('proposed_by_agent' in record).toBe(false);
  });

  it('generates distinct ids for two records created in the same tick', () => {
    // FALSIFICATION: returning a constant id would produce equal ids → test fails
    const r1 = validRecord();
    const r2 = validRecord();
    expect(r1.id).not.toBe(r2.id);
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — happy path
// ---------------------------------------------------------------------------

describe('validateProposalRecord — happy path', () => {
  it('returns {ok:true} for a fully valid record', () => {
    // FALSIFICATION: returning {ok:false,...} unconditionally would fail this
    const result = validateProposalRecord(validRecord());
    expect(result).toEqual({ ok: true });
  });

  it('returns {ok:true} for a record with optional proposed_by_agent set', () => {
    // FALSIFICATION: treating any proposed_by_agent as an error would fail this
    const record = createProposalRecord(validOpts({ proposedByAgent: 'agent-x' }));
    const result = validateProposalRecord(record);
    expect(result).toEqual({ ok: true });
  });

  it('returns {ok:true} for confidence exactly 0.0 (lower boundary)', () => {
    // FALSIFICATION: using `< 0` as `<= 0` would reject 0.0 → fail
    const record = validRecord({ confidence: 0.0 });
    const result = validateProposalRecord(record);
    expect(result).toEqual({ ok: true });
  });

  it('returns {ok:true} for confidence exactly 1.0 (upper boundary)', () => {
    // FALSIFICATION: using `> 1` as `>= 1` would reject 1.0 → fail
    const record = validRecord({ confidence: 1.0 });
    const result = validateProposalRecord(record);
    expect(result).toEqual({ ok: true });
  });

  it('returns {ok:true} for subject exactly 100 chars (max boundary)', () => {
    // FALSIFICATION: using `> 100` as `>= 100` would reject a 100-char subject → fail
    const subject100 = 'a'.repeat(100);
    const record = validRecord({ subject: subject100 });
    const result = validateProposalRecord(record);
    expect(result).toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — non-object input
// ---------------------------------------------------------------------------

describe('validateProposalRecord — non-object input', () => {
  it('returns {ok:false} with error message for null input', () => {
    // FALSIFICATION: removing the null-check guard would crash or return wrong shape
    const result = validateProposalRecord(null);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('record must be a non-null object');
  });

  it('returns {ok:false} with error message for string input', () => {
    // FALSIFICATION: removing the typeof check would allow strings through → fail
    const result = validateProposalRecord('not-an-object');
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('record must be a non-null object');
  });

  it('returns {ok:false} with error message for numeric input', () => {
    // FALSIFICATION: removing typeof guard would allow numbers through → fail
    const result = validateProposalRecord(42);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('record must be a non-null object');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — missing required fields
// ---------------------------------------------------------------------------

describe('validateProposalRecord — missing required fields', () => {
  it('returns {ok:false} when "type" field is absent', () => {
    const record = validRecord();
    delete record.type;
    // FALSIFICATION: removing 'type' from the REQUIRED array would let this slip through → ok:true
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('missing required field: type');
  });

  it('returns {ok:false} when "subject" field is absent', () => {
    const record = validRecord();
    delete record.subject;
    // FALSIFICATION: removing 'subject' from REQUIRED would let this slip through → ok:true
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('missing required field: subject');
  });

  it('returns {ok:false} when "insight" field is absent', () => {
    const record = validRecord();
    delete record.insight;
    // FALSIFICATION: removing 'insight' from REQUIRED would let this slip through → ok:true
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('missing required field: insight');
  });

  it('returns {ok:false} when "evidence" field is absent', () => {
    const record = validRecord();
    delete record.evidence;
    // FALSIFICATION: removing 'evidence' from REQUIRED would let this slip through → ok:true
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('missing required field: evidence');
  });

  it('returns {ok:false} when "confidence" field is absent', () => {
    const record = validRecord();
    delete record.confidence;
    // FALSIFICATION: removing 'confidence' from REQUIRED would let this slip through → ok:true
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('missing required field: confidence');
  });

  it('returns {ok:false} when "wave_id" field is absent', () => {
    const record = validRecord();
    delete record.wave_id;
    // FALSIFICATION: removing 'wave_id' from REQUIRED would let this slip through → ok:true
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('missing required field: wave_id');
  });

  it('returns {ok:false} when "schema_version" field is absent', () => {
    const record = validRecord();
    delete record.schema_version;
    // FALSIFICATION: removing 'schema_version' from REQUIRED would let this slip through → ok:true
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('missing required field: schema_version');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — type enum rejection
// ---------------------------------------------------------------------------

describe('validateProposalRecord — type enum', () => {
  it('returns {ok:false} when type is not in PROPOSAL_TYPES', () => {
    const record = validRecord({ type: 'completely-invalid-type' });
    // FALSIFICATION: removing the PROPOSAL_TYPES.includes check would accept any string → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('type must be one of');
    expect(result.errors[0]).toContain('"completely-invalid-type"');
  });

  it('returns {ok:false} when type is an empty string', () => {
    // FALSIFICATION: skipping enum check for empty string would let '' through → fail
    const record = validRecord({ type: '' });
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('type must be one of');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — subject field rejections
// ---------------------------------------------------------------------------

describe('validateProposalRecord — subject field', () => {
  it('returns {ok:false} when subject is 101 chars (over limit)', () => {
    const subject101 = 'a'.repeat(101);
    const record = validRecord({ subject: subject101 });
    // FALSIFICATION: changing `> SUBJECT_MAX` to `>= SUBJECT_MAX` would accept 100 and reject 101 in a different way — but this test is about 101 being rejected
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('subject exceeds 100 chars (got 101)');
  });

  it('returns {ok:false} when subject contains a newline character', () => {
    const record = validRecord({ subject: 'line1\nline2' });
    // FALSIFICATION: removing the /[\r\n]/.test() check would accept multi-line subjects → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('subject must not contain newline characters');
  });

  it('returns {ok:false} when subject contains a carriage-return character', () => {
    const record = validRecord({ subject: 'line1\rline2' });
    // FALSIFICATION: restricting regex to /\n/ only would miss \r → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('subject must not contain newline characters');
  });

  it('returns {ok:false} when subject is an empty string', () => {
    const record = validRecord({ subject: '' });
    // FALSIFICATION: removing the `length === 0` check would allow empty subjects → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('subject must not be empty');
  });

  it('returns {ok:false} when subject is not a string', () => {
    const record = validRecord({ subject: 42 });
    // FALSIFICATION: removing the `typeof !== 'string'` check would crash downstream → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('subject must be a string');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — insight field rejections
// ---------------------------------------------------------------------------

describe('validateProposalRecord — insight field', () => {
  it('returns {ok:false} when insight exceeds 2000 chars', () => {
    const record = validRecord({ insight: 'x'.repeat(2001) });
    // FALSIFICATION: changing `> INSIGHT_MAX` to `>= INSIGHT_MAX` would produce a different count in the message
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('insight exceeds 2000 chars (got 2001)');
  });

  it('returns {ok:false} when insight contains a newline', () => {
    const record = validRecord({ insight: 'part1\npart2' });
    // FALSIFICATION: removing the newline check on insight would accept multi-line → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('insight must not contain newline characters');
  });

  it('returns {ok:false} when insight is empty', () => {
    const record = validRecord({ insight: '' });
    // FALSIFICATION: removing the length===0 check would allow empty insight → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('insight must not be empty');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — evidence field rejections
// ---------------------------------------------------------------------------

describe('validateProposalRecord — evidence field', () => {
  it('returns {ok:false} when evidence exceeds 5000 chars', () => {
    const record = validRecord({ evidence: 'e'.repeat(5001) });
    // FALSIFICATION: changing `> EVIDENCE_MAX` to `>= EVIDENCE_MAX` would change the count in the error
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('evidence exceeds 5000 chars (got 5001)');
  });

  it('returns {ok:false} when evidence contains a newline', () => {
    const record = validRecord({ evidence: 'line1\nline2' });
    // FALSIFICATION: removing the newline check on evidence would let multi-line through → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('evidence must not contain newline characters');
  });

  it('returns {ok:false} when evidence is empty', () => {
    const record = validRecord({ evidence: '' });
    // FALSIFICATION: removing length===0 check would allow empty evidence → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('evidence must not be empty');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — confidence rejections
// ---------------------------------------------------------------------------

describe('validateProposalRecord — confidence field', () => {
  it('returns {ok:false} when confidence is below 0 (e.g. -0.0001)', () => {
    const record = validRecord({ confidence: -0.0001 });
    // FALSIFICATION: changing `< 0` to `<= 0` would incorrectly reject 0.0 too — but -0.0001 must fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('confidence must be a finite number in [0, 1]');
  });

  it('returns {ok:false} when confidence exceeds 1 (e.g. 1.0001)', () => {
    const record = validRecord({ confidence: 1.0001 });
    // FALSIFICATION: changing `> 1` to `>= 1` would incorrectly reject 1.0 too — but 1.0001 must fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('confidence must be a finite number in [0, 1]');
  });

  it('returns {ok:false} when confidence is NaN', () => {
    const record = validRecord({ confidence: NaN });
    // FALSIFICATION: removing `!Number.isFinite()` check would let NaN through → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('confidence must be a finite number in [0, 1]');
  });

  it('returns {ok:false} when confidence is Infinity', () => {
    const record = validRecord({ confidence: Infinity });
    // FALSIFICATION: removing `!Number.isFinite()` check would let Infinity through → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('confidence must be a finite number in [0, 1]');
  });

  it('returns {ok:false} when confidence is a string', () => {
    const record = validRecord({ confidence: '0.8' });
    // FALSIFICATION: removing `typeof !== 'number'` check would let string '0.8' through → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('confidence must be a finite number in [0, 1]');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — schema_version rejection
// ---------------------------------------------------------------------------

describe('validateProposalRecord — schema_version', () => {
  it('returns {ok:false} when schema_version is 2 (wrong version)', () => {
    // createProposalRecord always stamps schema_version from the constant,
    // so we must mutate the returned record to simulate a v2 record.
    const record = validRecord();
    record.schema_version = 2;
    // FALSIFICATION: removing the schema_version !== SCHEMA_VERSION check would accept v2 → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('schema_version must be 1, got: 2');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — wave_id rejection
// ---------------------------------------------------------------------------

describe('validateProposalRecord — wave_id field', () => {
  it('returns {ok:false} when wave_id is empty string', () => {
    // createProposalRecord maps waveId→wave_id; passing wave_id in opts is ignored.
    // Mutate the returned record directly to test this validation path.
    const record = validRecord();
    record.wave_id = '';
    // FALSIFICATION: removing `wave_id.length === 0` check would let empty string through → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('wave_id must be a non-empty string');
  });

  it('returns {ok:false} when wave_id is a number', () => {
    // Mutate after creation — the factory does not accept wave_id directly.
    const record = validRecord();
    record.wave_id = 3;
    // FALSIFICATION: removing `typeof !== 'string'` check would let number through → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('wave_id must be a non-empty string');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — proposed_by_agent optional field
// ---------------------------------------------------------------------------

describe('validateProposalRecord — proposed_by_agent optional field', () => {
  it('returns {ok:false} when proposed_by_agent is present but is a number', () => {
    // Build a valid record then inject the invalid optional field
    const record = validRecord();
    record.proposed_by_agent = 99;
    // FALSIFICATION: removing the proposed_by_agent type check would accept number → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toBe('proposed_by_agent must be a string when present');
  });
});

// ---------------------------------------------------------------------------
// validateProposalRecord() — multiple errors accumulate
// ---------------------------------------------------------------------------

describe('validateProposalRecord — error accumulation', () => {
  it('accumulates multiple errors when several fields fail simultaneously', () => {
    // A record with invalid type AND confidence out-of-range
    const record = validRecord({ type: 'not-a-valid-type', confidence: 2.5 });
    // FALSIFICATION: short-circuiting after first error would give length === 1 → fail
    const result = validateProposalRecord(record);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// serializeProposal()
// ---------------------------------------------------------------------------

describe('serializeProposal', () => {
  it('returns a string', () => {
    // FALSIFICATION: returning null from serialize would fail the typeof check
    const serialized = serializeProposal(validRecord());
    expect(typeof serialized).toBe('string');
  });

  it('produces a single-line string (no embedded newlines)', () => {
    // FALSIFICATION: pretty-printing JSON with newlines would fail this
    const serialized = serializeProposal(validRecord());
    expect(serialized).not.toContain('\n');
  });

  it('output parses back to an object with the exact same confidence value', () => {
    const record = validRecord({ confidence: 0.72 });
    const parsed = JSON.parse(serializeProposal(record));
    // FALSIFICATION: truncating confidence on serialize would produce a different value
    expect(parsed.confidence).toBe(0.72);
  });

  it('output parses back to an object with the exact same type value', () => {
    const record = validRecord({ type: 'anti-pattern' });
    const parsed = JSON.parse(serializeProposal(record));
    // FALSIFICATION: not serializing the type field would produce undefined
    expect(parsed.type).toBe('anti-pattern');
  });

  it('output contains schema_version === 1', () => {
    const parsed = JSON.parse(serializeProposal(validRecord()));
    // FALSIFICATION: stripping schema_version in serialize would produce undefined
    expect(parsed.schema_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deserializeProposal()
// ---------------------------------------------------------------------------

describe('deserializeProposal', () => {
  it('returns null for an empty string', () => {
    // FALSIFICATION: attempting JSON.parse('') would throw → caller would crash instead of null
    expect(deserializeProposal('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    // FALSIFICATION: not trimming before checking length would try to parse '   ' → throw or object → not null
    expect(deserializeProposal('   ')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    // FALSIFICATION: removing the try/catch would propagate the SyntaxError → crash instead of null
    expect(deserializeProposal('{ not valid json ]')).toBeNull();
  });

  it('returns null for a JSON array (not an object)', () => {
    // FALSIFICATION: removing the Array.isArray check would return [] instead of null → fail
    expect(deserializeProposal('[1,2,3]')).toBeNull();
  });

  it('returns null for a JSON primitive (number)', () => {
    // FALSIFICATION: removing the typeof !== 'object' check would return 42 instead of null
    expect(deserializeProposal('42')).toBeNull();
  });

  it('returns null for a JSON null literal', () => {
    // FALSIFICATION: removing the !parsed guard would return null-parsed-from-JSON instead of null-from-guard,
    // but the end value is still null — tested via not-throwing rather than null specifically
    expect(deserializeProposal('null')).toBeNull();
  });

  it('returns the parsed object for valid JSON object input', () => {
    const record = validRecord({ type: 'workflow-pattern', confidence: 0.9 });
    const line = JSON.stringify(record);
    const result = deserializeProposal(line);
    // FALSIFICATION: returning null unconditionally would fail this
    expect(result).not.toBeNull();
    expect(result.type).toBe('workflow-pattern');
    expect(result.confidence).toBe(0.9);
  });

  it('returns null for a non-string argument (number)', () => {
    // FALSIFICATION: removing the typeof !== 'string' guard would attempt (42).trim() → crash → not null
    expect(deserializeProposal(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Full roundtrip: create → validate → serialize → deserialize
// ---------------------------------------------------------------------------

describe('full roundtrip: create → validate → serialize → deserialize', () => {
  it('roundtrip preserves all required fields with exact values', () => {
    const record = createProposalRecord({
      type: 'proven-pattern',
      subject: 'Session orchestrator wave design',
      insight: 'Agents should own single files to avoid merge conflicts.',
      evidence: 'Three sessions with parallel agents showed zero conflicts when scoped.',
      confidence: 0.91,
      waveId: 'W5',
    });

    // Validate — must be ok:true before serializing
    const validationResult = validateProposalRecord(record);
    // FALSIFICATION: mutating a field after create but before validate would fail this
    expect(validationResult).toEqual({ ok: true });

    const line = serializeProposal(record);
    const restored = deserializeProposal(line);

    // FALSIFICATION: losing the id during serialize/deserialize would fail this
    expect(restored.id).toBe(record.id);
    // FALSIFICATION: losing type would fail this
    expect(restored.type).toBe('proven-pattern');
    // FALSIFICATION: truncating subject would fail this
    expect(restored.subject).toBe('Session orchestrator wave design');
    // FALSIFICATION: truncating confidence would produce a different value
    expect(restored.confidence).toBe(0.91);
    // FALSIFICATION: dropping wave_id would produce undefined → not 'W5'
    expect(restored.wave_id).toBe('W5');
    // FALSIFICATION: dropping schema_version would produce undefined → not 1
    expect(restored.schema_version).toBe(1);
    // FALSIFICATION: dropping created_at would produce undefined → not a string
    expect(restored.created_at).toBe(record.created_at);
  });

  it('roundtrip preserves optional proposed_by_agent field', () => {
    const record = createProposalRecord(
      validOpts({ proposedByAgent: 'impl-agent-3' })
    );
    const restored = deserializeProposal(serializeProposal(record));
    // FALSIFICATION: stripping optional fields in serialize would produce undefined here
    expect(restored.proposed_by_agent).toBe('impl-agent-3');
  });

  it('validateProposalRecord accepts the deserialized record as valid', () => {
    const original = validRecord({ type: 'hardware-pattern', confidence: 0.77 });
    const restored = deserializeProposal(serializeProposal(original));
    // FALSIFICATION: losing schema_version or any required field in the roundtrip would fail this
    expect(validateProposalRecord(restored)).toEqual({ ok: true });
  });
});
