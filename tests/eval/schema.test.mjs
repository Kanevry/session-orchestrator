/**
 * tests/eval/schema.test.mjs
 *
 * Unit tests for the aiat-llm-eval record schema + sink (Epic #803, S2):
 *   - scripts/lib/eval/schema.mjs — validateEvalRecord / normalizeEvalRecord /
 *     buildRunId / projectSubmission
 *   - scripts/lib/eval/sink.mjs   — appendEvalRecord / readEvalRecords
 *
 * Coverage:
 *   - happy path + every required-field / enum / range violation
 *   - the load-bearing "no global-score" rejection (kein Globalscore per Konstruktion)
 *   - the judge advisory:true firewall + deterministic/judge field coupling
 *   - the hostname_hash cleartext guard (data-minimization at the schema layer)
 *   - Data-Minimization: projectSubmission drops paths / repo names / prompts /
 *     cleartext hostnames / dimension evidence (FA2 fake-regression documented below)
 *   - sink append-only + malformed-line resilience + never-throw semantics
 *
 * NOW-relativity (Zeitbomben-Learning, conf 0.9): records under test are built
 * via validRecord() with `new Date().toISOString()`. Schema validation has NO
 * now-comparison (timestamp is only Date.parse-checked), so the fixed-timestamp
 * JSON fixtures under tests/fixtures/eval/records/ cannot time-bomb either.
 *
 * Falsification: every assertion below fails if the corresponding validation /
 * projection / IO body is removed.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateEvalRecord,
  normalizeEvalRecord,
  buildRunId,
  projectSubmission,
  ValidationError,
  SUBMISSION_FIELDS,
  KPI_FIELDS,
  REQUIRED_FIELDS,
  CURRENT_EVAL_SCHEMA_VERSION,
  CURRENT_STANDARD_VERSION,
} from '@lib/eval/schema.mjs';
import { appendEvalRecord, readEvalRecords, DEFAULT_EVAL_JSONL_PATH } from '@lib/eval/sink.mjs';
import { unwritablePath } from '../_helpers/unwritable-path.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/eval/records');

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

/** A complete, valid session-eval record. NOW-relative timestamp (no time-bomb). */
function validRecord(overrides = {}) {
  const now = new Date().toISOString();
  return {
    schema_version: 1,
    record_kind: 'session-eval',
    run_id: buildRunId('unit-session', now),
    session_id: 'unit-session',
    standard_version: CURRENT_STANDARD_VERSION,
    rubric_version: 'rubric-v1',
    provenance: { rubric_sha256: '3b8f0aa1cd42e77b19ce', engine_commit: '90fdf09' },
    model: { id: 'claude-opus-4-8', source: 'self-report' },
    harness: {
      plugin_version: '3.14.0',
      platform: 'claude-code',
      host_class: 'macos-arm64',
      hostname_hash: 'a1b2c3d4e5f6a7b8',
    },
    kpis: {
      duration_seconds: 1800,
      total_waves: 5,
      total_agents: 18,
      token_input: 120000,
      token_output: 45000,
      carryover: 0,
    },
    dimensions: [
      { id: 'verification-evidence', method: 'deterministic', status: 'pass', evidence: 'gate exit 0', score: null },
      {
        id: 'instruction-adherence',
        method: 'judge',
        status: 'pass',
        evidence: 'followed the plan',
        score: 0.9,
        advisory: true,
        calibration_status: 'uncalibrated',
      },
    ],
    handle: null,
    anonymized: true,
    timestamp: now,
    ...overrides,
  };
}

describe('validateEvalRecord — happy path', () => {
  it('accepts a fully valid record and returns a new object', () => {
    const rec = validRecord();
    const out = validateEvalRecord(rec);
    expect(out).not.toBe(rec); // new object
    expect(out.record_kind).toBe('session-eval');
    expect(out.schema_version).toBe(1);
  });

  it('stamps schema_version to CURRENT when absent', () => {
    const rec = validRecord();
    delete rec.schema_version;
    const out = validateEvalRecord(rec);
    expect(out.schema_version).toBe(CURRENT_EVAL_SCHEMA_VERSION);
  });

  it('rejects a non-object input', () => {
    expect(() => validateEvalRecord(null)).toThrow(ValidationError);
    expect(() => validateEvalRecord([])).toThrow(ValidationError);
    expect(() => validateEvalRecord('x')).toThrow(ValidationError);
  });
});

describe('validateEvalRecord — required fields', () => {
  for (const field of REQUIRED_FIELDS) {
    it(`throws when required field '${field}' is missing`, () => {
      const rec = validRecord();
      delete rec[field];
      expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
    });
  }
});

describe('validateEvalRecord — no global score (kein Globalscore per Konstruktion)', () => {
  for (const key of ['overall', 'total', 'mean', 'global_score']) {
    it(`REJECTS a record carrying a top-level '${key}' key`, () => {
      const rec = validRecord({ [key]: 0.87 });
      expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
    });
  }
});

describe('validateEvalRecord — enum violations', () => {
  it('throws on invalid record_kind', () => {
    expect(() => validateEvalRecord(validRecord({ record_kind: 'benchmark-eval' }))).toThrow(ValidationError);
  });

  it('throws on invalid model.source', () => {
    const rec = validRecord();
    rec.model.source = 'guessed';
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws on invalid dimension method', () => {
    const rec = validRecord();
    rec.dimensions[0].method = 'vibes';
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws on invalid dimension status', () => {
    const rec = validRecord();
    rec.dimensions[0].status = 'maybe';
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws on invalid judge calibration_status', () => {
    const rec = validRecord();
    rec.dimensions[1].calibration_status = 'calibrated';
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });
});

describe('validateEvalRecord — judge/deterministic field coupling', () => {
  it('REJECTS a judge dimension with advisory:false (advisory-only firewall)', () => {
    const rec = validRecord();
    rec.dimensions[1].advisory = false;
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws when a judge dimension omits advisory', () => {
    const rec = validRecord();
    delete rec.dimensions[1].advisory;
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws when a deterministic dimension carries advisory', () => {
    const rec = validRecord();
    rec.dimensions[0].advisory = true;
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws when a deterministic dimension carries calibration_status', () => {
    const rec = validRecord();
    rec.dimensions[0].calibration_status = 'uncalibrated';
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });
});

describe('validateEvalRecord — harness hostname_hash guard (data-minimization)', () => {
  it('accepts a null hostname_hash', () => {
    const rec = validRecord();
    rec.harness.hostname_hash = null;
    expect(() => validateEvalRecord(rec)).not.toThrow();
  });

  it('REJECTS a cleartext hostname in hostname_hash', () => {
    const rec = validRecord();
    rec.harness.hostname_hash = 'secret-laptop.local';
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });
});

describe('validateEvalRecord — kpis (don\'t fake perfect)', () => {
  it('accepts null for a KPI field (missing ≠ zero)', () => {
    const rec = validRecord();
    rec.kpis.token_input = null;
    expect(() => validateEvalRecord(rec)).not.toThrow();
  });

  it('throws when a KPI field is missing entirely', () => {
    const rec = validRecord();
    delete rec.kpis.carryover;
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws on a negative KPI value', () => {
    const rec = validRecord();
    rec.kpis.total_agents = -1;
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });
});

describe('validateEvalRecord — provenance + timestamp', () => {
  it('accepts a null engine_commit', () => {
    const rec = validRecord();
    rec.provenance.engine_commit = null;
    expect(() => validateEvalRecord(rec)).not.toThrow();
  });

  it('throws on empty rubric_sha256', () => {
    const rec = validRecord();
    rec.provenance.rubric_sha256 = '';
    expect(() => validateEvalRecord(rec)).toThrow(ValidationError);
  });

  it('throws on a non-parseable timestamp', () => {
    expect(() => validateEvalRecord(validRecord({ timestamp: 'not-a-date' }))).toThrow(ValidationError);
  });

  it('throws on a non-boolean anonymized', () => {
    expect(() => validateEvalRecord(validRecord({ anonymized: 'yes' }))).toThrow(ValidationError);
  });
});

describe('buildRunId', () => {
  it('builds a deterministic <session>-eval-<compactISO> id', () => {
    expect(buildRunId('main-2026-07-16-deep-1', '2026-07-16T10:00:00.000Z')).toBe(
      'main-2026-07-16-deep-1-eval-20260716T100000000Z',
    );
  });

  it('is stable across calls (no clock read)', () => {
    const a = buildRunId('s', '2026-01-02T03:04:05.678Z');
    const b = buildRunId('s', '2026-01-02T03:04:05.678Z');
    expect(a).toBe(b);
    expect(a).toBe('s-eval-20260102T030405678Z');
  });

  it('throws on empty sessionId or bad timestamp', () => {
    expect(() => buildRunId('', '2026-01-01T00:00:00.000Z')).toThrow(ValidationError);
    expect(() => buildRunId('s', 'nope')).toThrow(ValidationError);
  });
});

describe('normalizeEvalRecord', () => {
  it('never throws on a non-object', () => {
    expect(normalizeEvalRecord(null)).toBe(null);
    expect(normalizeEvalRecord(42)).toBe(42);
  });

  it('fills undefined KPI fields with null (don\'t fake perfect)', () => {
    const out = normalizeEvalRecord({ kpis: { duration_seconds: 10 } });
    expect(out.kpis.duration_seconds).toBe(10);
    expect(out.kpis.token_input).toBe(null);
    expect(out.kpis.carryover).toBe(null);
    for (const f of KPI_FIELDS) expect(f in out.kpis).toBe(true);
  });

  it('defaults handle to null and record_kind/standard_version to current', () => {
    const out = normalizeEvalRecord({});
    expect(out.handle).toBe(null);
    expect(out.record_kind).toBe('session-eval');
    expect(out.standard_version).toBe(CURRENT_STANDARD_VERSION);
    expect(out.anonymized).toBe(true); // no handle ⇒ anonymous
  });

  it('derives anonymized=false when a handle is present', () => {
    const out = normalizeEvalRecord({ handle: 'nightowl' });
    expect(out.anonymized).toBe(false);
  });

  it('defaults judge-dimension advisory + calibration_status', () => {
    const out = normalizeEvalRecord({
      dimensions: [{ id: 'x', method: 'judge', status: 'pass', evidence: 'e' }],
    });
    expect(out.dimensions[0].advisory).toBe(true);
    expect(out.dimensions[0].calibration_status).toBe('uncalibrated');
  });
});

describe('projectSubmission — Data-Minimization (FA2)', () => {
  // FAKE-REGRESSION (executed 2026-07-16): temporarily added 'evidence' to
  // SUBMISSION_FIELDS.dimensions in scripts/lib/eval/schema.mjs and re-ran this
  // suite → this test went RED (the contaminated path/repo string surfaced in
  // the projection); reverted → GREEN. This proves the whitelist actually bites.
  it('drops paths, repo names, prompts, cleartext hostnames, and dimension evidence', () => {
    const contaminated = loadFixture('contaminated-session-eval.json');
    const projected = projectSubmission(contaminated);
    const serialized = JSON.stringify(projected);

    // None of the planted contamination survives the projection.
    expect(serialized).not.toContain('/Users/secret');
    expect(serialized).not.toContain('workdir');
    expect(serialized).not.toContain('super-secret-customer-repo');
    expect(serialized).not.toContain('secret-laptop.local');
    expect(serialized).not.toContain('confidential');

    // Rogue top-level + nested fields are gone.
    expect(projected.cwd).toBeUndefined();
    expect(projected.repo).toBeUndefined();
    expect(projected.prompt).toBeUndefined();
    expect(projected.harness.hostname).toBeUndefined();
    expect(projected.dimensions[0].evidence).toBeUndefined();
  });

  it('keeps the whitelisted submission-safe fields', () => {
    const contaminated = loadFixture('contaminated-session-eval.json');
    const projected = projectSubmission(contaminated);

    expect(projected.record_kind).toBe('session-eval');
    expect(projected.run_id).toBe('sample-session-2-eval-20260101T000000000Z');
    expect(projected.standard_version).toBe('aiat-llm-eval/1.0');
    expect(projected.model).toEqual({ id: 'claude-opus-4-8', source: 'self-report' });
    expect(projected.harness.plugin_version).toBe('3.14.0');
    expect(projected.harness.hostname_hash).toBe('a1b2c3d4e5f6a7b8'); // hashed form is safe
    expect(projected.kpis.token_input).toBe(120000);
    expect(projected.dimensions[0]).toEqual({
      id: 'verification-evidence',
      method: 'deterministic',
      status: 'pass',
      score: null,
    });
  });

  it('returns {} for a non-object input', () => {
    expect(projectSubmission(null)).toEqual({});
  });

  it('the whitelist is frozen at every level', () => {
    expect(Object.isFrozen(SUBMISSION_FIELDS)).toBe(true);
    expect(Object.isFrozen(SUBMISSION_FIELDS.dimensions)).toBe(true);
    expect(SUBMISSION_FIELDS.dimensions).not.toContain('evidence');
  });
});

describe('sink — appendEvalRecord / readEvalRecords', () => {
  let dir;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function tmpJournal() {
    dir = mkdtempSync(path.join(tmpdir(), 'eval-sink-'));
    return path.join(dir, 'eval.jsonl');
  }

  it('appends records append-only (two writes ⇒ two lines) and reads them back', () => {
    const journal = tmpJournal();
    const r1 = appendEvalRecord(validRecord({ session_id: 's1' }), { path: journal });
    const r2 = appendEvalRecord(validRecord({ session_id: 's2' }), { path: journal });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const raw = readFileSync(journal, 'utf8');
    expect(raw.split('\n').filter((l) => l.trim()).length).toBe(2);

    const records = readEvalRecords(journal);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.session_id)).toEqual(['s1', 's2']);
  });

  it('never throws on an invalid record — returns {ok:false, reason:"validation"} and writes nothing', () => {
    const journal = tmpJournal();
    const bad = validRecord({ record_kind: 'nope' });
    const res = appendEvalRecord(bad, { path: journal });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('validation');
    expect(existsSync(journal)).toBe(false); // nothing written
  });

  it('never throws on an unwritable target directory — returns { ok:false, reason:"fs-error" }', () => {
    // /dev/null/<sub> yields a fast, uniform ENOTDIR on mkdirSync for every
    // uid (root and non-root alike) — see tests/_helpers/unwritable-path.mjs
    // (#685 root-as-uid-0 hazard: a procfs path HANGS as root instead).
    if (process.platform === 'win32') return; // POSIX-only construct
    const res = appendEvalRecord(validRecord({ session_id: 'unwritable' }), {
      path: path.join(unwritablePath('eval-sink'), 'eval.jsonl'),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('fs-error');
  });

  it('skips malformed JSONL lines on read (never throws)', () => {
    const journal = tmpJournal();
    appendEvalRecord(validRecord({ session_id: 'good' }), { path: journal });
    appendFileSync(journal, 'this is not json\n', 'utf8');
    appendEvalRecord(validRecord({ session_id: 'good2' }), { path: journal });

    const records = readEvalRecords(journal);
    expect(records.map((r) => r.session_id)).toEqual(['good', 'good2']);
  });

  it('returns [] for a missing journal file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'eval-sink-'));
    expect(readEvalRecords(path.join(dir, 'does-not-exist.jsonl'))).toEqual([]);
  });

  it('exposes the canonical default journal path', () => {
    expect(DEFAULT_EVAL_JSONL_PATH).toBe('.orchestrator/metrics/eval.jsonl');
  });
});
