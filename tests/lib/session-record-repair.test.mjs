/**
 * tests/lib/session-record-repair.test.mjs
 *
 * Vitest suite for scripts/lib/session-record-repair.mjs (GitLab #1004).
 *
 * ── GOLDEN FIXTURE PROVENANCE (testing.md § Fixtures Mirror Production Data) ──
 * `tests/fixtures/sessions-invalid-golden.jsonl` holds 13 lines copied VERBATIM
 * from `.orchestrator/metrics/sessions.jsonl` at HEAD 1be450a on 2026-08-05
 * (216 lines, 33 failing `validateSession`, 0 unparseable). Nothing was
 * redacted — the source lines were scanned for home paths and token shapes and
 * carry none. Source line numbers, in fixture order:
 *
 *   fixture 1  ← live 71   main-2026-04-30-1900          total_agents + total_files_changed missing
 *   fixture 2  ← live 85   main-2026-05-10-housekeeping-2 SIX defects (worst case in the ledger)
 *   fixture 3  ← live 87   main-2026-05-11-deep-1        waves absent            ┐ the id-triple:
 *   fixture 4  ← live 88   main-2026-05-11-deep-1        waves absent            ├ three lines,
 *   fixture 5  ← live 89   main-2026-05-11-deep-1        completed_at missing    ┘ one session_id
 *   fixture 6  ← live 100  main-2026-06-14-deep-1        VALID
 *   fixture 7  ← live 101  main-2026-06-14-deep-2        VALID
 *   fixture 8  ← live 104  main-2026-06-14-session-3     waves is a NUMBER
 *   fixture 9  ← live 111  main-2026-06-19-session-1     agent_summary.spiral missing
 *   fixture 10 ← live 115  main-2026-06-20-session-3     waves[i].wave undefined (shape uses wave_number)
 *   fixture 11 ← live 152  main-2026-07-05-deep-1        NO schema_version key + waves[i].wave undefined
 *   fixture 12 ← live 171  main-2026-07-24-deep-2        waves[0].wave === 0 (coordinator-direct wave 0)
 *   fixture 13 ← live 216  main-2026-08-04-session-2     VALID (an abandoned backfill record)
 *
 * NOTE the 87/88 pair is NOT byte-identical (1668 vs 1130 bytes) — they are two
 * differently-shaped close attempts that share one session_id, which is exactly
 * why the dedupe-refusal test below asserts on line COUNT and ORDER, not bytes.
 *
 * Testing-rule compliance: hardcoded expected values, behaviour over
 * implementation, every case names the bug it catches (test-value.md TV-001).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateSession } from '@lib/session-schema/validator.mjs';
import {
  repairRecord,
  repairLine,
  repairText,
  repairLedger,
  verifyWritten,
  REPAIR_SOURCE,
  CANONICAL_LEDGER_REL,
} from '@lib/session-record-repair.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'sessions-invalid-golden.jsonl');

const GOLDEN_RAW = readFileSync(FIXTURE, 'utf8');
const GOLDEN_LINES = GOLDEN_RAW.split('\n').filter((l) => l.length > 0);

/** 1-based fixture-line accessor, so the tests read like the provenance table. */
const golden = (n) => GOLDEN_LINES[n - 1];
const goldenRecord = (n) => JSON.parse(golden(n));

/** Minimal schema-valid record used as the base for single-defect synthetics. */
function baseRecord(overrides = {}) {
  return {
    session_id: 'main-2026-01-01-session-1',
    session_type: 'feature',
    started_at: '2026-01-01T09:00:00.000Z',
    completed_at: '2026-01-01T10:00:00.000Z',
    total_waves: 2,
    waves: [
      { wave: 1, role: 'Discovery' },
      { wave: 2, role: 'Impl-Core' },
    ],
    agent_summary: { complete: 3, partial: 0, failed: 0, spiral: 0 },
    total_agents: 3,
    total_files_changed: 7,
    effectiveness: { carryover: 0 },
    ...overrides,
  };
}

/** Drop a key entirely (as opposed to setting it undefined). */
function without(record, ...keys) {
  const out = { ...record };
  for (const k of keys) delete out[k];
  return out;
}

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'session-record-repair-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Build a canonical-layout tmp repo whose ledger is `content`. */
function makeRepo(content) {
  const repoRoot = mkdtempSync(path.join(tmp, 'repo-'));
  const file = path.join(repoRoot, CANONICAL_LEDGER_REL);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return { repoRoot, file };
}

// ---------------------------------------------------------------------------
// 1. Every defect class repairs to schema-valid
// ---------------------------------------------------------------------------

describe('repairRecord — every defect class becomes schema-valid', () => {
  // Bug caught: a repair rule that fixes only the FIRST violation validateSession
  // reports, leaving the record invalid for the next sub-validator in the chain.
  const CASES = [
    {
      name: 'total_files_changed missing',
      input: () => without(baseRecord(), 'total_files_changed'),
      defect: 'total_files_changed_missing',
      expect: (r) => expect(r.total_files_changed).toBe(0),
    },
    {
      // agent_summary is the record's own evidence (live line 71: sum 30 vs
      // waves.length 5 — W2/A4 review finding). baseRecord's summary sums to 3.
      name: 'total_agents missing → agent_summary sum (not waves.length)',
      input: () => without(baseRecord(), 'total_agents'),
      defect: 'total_agents_missing',
      expect: (r) => expect(r.total_agents).toBe(3),
    },
    {
      name: 'total_agents missing, no agent_summary → waves.length fallback',
      input: () => without(baseRecord(), 'total_agents', 'agent_summary'),
      defect: 'total_agents_missing',
      expect: (r) => expect(r.total_agents).toBe(2),
    },
    {
      name: 'total_agents missing with no waves and no agent_summary → 0',
      input: () => without(baseRecord({ waves: [] }), 'total_agents', 'agent_summary'),
      defect: 'total_agents_missing',
      expect: (r) => expect(r.total_agents).toBe(0),
    },
    {
      name: 'total_waves missing → waves.length',
      input: () => without(baseRecord(), 'total_waves'),
      defect: 'total_waves_missing',
      expect: (r) => expect(r.total_waves).toBe(2),
    },
    {
      name: 'agent_summary.spiral missing → 0',
      input: () => baseRecord({ agent_summary: { complete: 3, partial: 0, failed: 0 } }),
      defect: 'agent_summary_spiral_missing',
      expect: (r) => expect(r.agent_summary).toEqual({ complete: 3, partial: 0, failed: 0, spiral: 0 }),
    },
    {
      name: 'agent_summary absent → all-zero counters',
      input: () => without(baseRecord(), 'agent_summary'),
      defect: 'agent_summary_absent',
      expect: (r) => expect(r.agent_summary).toEqual({ complete: 0, partial: 0, failed: 0, spiral: 0 }),
    },
    {
      name: 'waves absent → [] and never synthesized',
      input: () => without(baseRecord(), 'waves'),
      defect: 'waves_absent',
      expect: (r) => expect(r.waves).toEqual([]),
    },
    {
      name: 'waves is a number → []',
      input: () => baseRecord({ waves: 5 }),
      defect: 'waves_number',
      expect: (r) => expect(r.waves).toEqual([]),
    },
    {
      name: 'waves[i].wave undefined → renumbered i+1',
      input: () => baseRecord({ waves: [{ role: 'Discovery' }, { role: 'Impl-Core' }, { role: 'Quality' }] }),
      defect: 'wave_index_invalid',
      expect: (r) => expect(r.waves.map((w) => w.wave)).toEqual([1, 2, 3]),
    },
    {
      name: 'waves[0].wave === 0 → whole array renumbered i+1',
      input: () =>
        baseRecord({
          waves: [
            { wave: 0, role: 'CI-Unblock' },
            { wave: 1, role: 'Discovery' },
            { wave: 2, role: 'Impl-Core' },
          ],
        }),
      defect: 'wave_index_invalid',
      // Bug caught: patching ONLY the offending entry would leave [1,1,2] —
      // two waves numbered 1, which validateSession happily accepts.
      expect: (r) => expect(r.waves.map((w) => w.wave)).toEqual([1, 2, 3]),
    },
    {
      name: 'completed_at missing → started_at verbatim',
      input: () => without(baseRecord(), 'completed_at'),
      defect: 'completed_at_missing',
      expect: (r) => expect(r.completed_at).toBe('2026-01-01T09:00:00.000Z'),
    },
    {
      // Legacy alias (emit-session.mjs aliasLegacyEndedAt precedent; live line
      // 85 — W2/A4 review finding): a parseable, monotonic ended_at wins over
      // the duration-0 fallback so the record cannot disagree with itself.
      name: 'completed_at missing with legacy ended_at → ended_at',
      input: () =>
        without(baseRecord({ ended_at: '2026-01-01T11:00:00.000Z' }), 'completed_at'),
      defect: 'completed_at_missing',
      expect: (r) => expect(r.completed_at).toBe('2026-01-01T11:00:00.000Z'),
    },
    {
      name: 'completed_at missing with NON-monotonic ended_at → started_at',
      input: () =>
        without(baseRecord({ ended_at: '2026-01-01T08:00:00.000Z' }), 'completed_at'),
      defect: 'completed_at_missing',
      expect: (r) => expect(r.completed_at).toBe('2026-01-01T09:00:00.000Z'),
    },
  ];

  for (const c of CASES) {
    it(`repairs "${c.name}" from invalid to valid`, () => {
      const input = c.input();
      expect(() => validateSession(input)).toThrow();

      const { record, defects, changed } = repairRecord(input);

      expect(changed).toBe(true);
      expect(defects).toContain(c.defect);
      expect(() => validateSession(record)).not.toThrow();
      c.expect(record);
      // Provenance is set on every repaired record.
      expect(record._backfill_source).toBe(REPAIR_SOURCE);
    });
  }

  it('repairs ALL defects of a six-defect record in ONE pass', () => {
    // Bug caught: first-error-only repair. Live line 85 needs six fields; a
    // single-defect repair would leave it invalid and silently un-fixed.
    const input = goldenRecord(2);
    expect(() => validateSession(input)).toThrow();

    const { record, defects } = repairRecord(input);

    expect(defects.length).toBeGreaterThanOrEqual(5);
    expect(() => validateSession(record)).not.toThrow();
  });

  it('does not mutate the input record', () => {
    const input = without(baseRecord(), 'total_agents');
    repairRecord(input);
    expect('total_agents' in input).toBe(false);
    expect('_backfill_source' in input).toBe(false);
  });

  it('never synthesizes wave entries for a record that had none', () => {
    // Bug caught: "helpfully" reconstructing waves from total_waves would
    // fabricate a record of work that may never have happened.
    const input = without(baseRecord({ total_waves: 5 }), 'waves');
    const { record } = repairRecord(input);
    expect(record.waves).toEqual([]);
    expect(record.total_waves).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. Valid records pass through byte-for-byte
// ---------------------------------------------------------------------------

describe('repairLine — valid records are emitted byte-for-byte', () => {
  // Contract: an untouched line must come out identical, so the repair diff
  // shows only the real repairs and no key-order churn.
  //
  // FAKE-REGRESSION NOTE (2026-08-05, testing.md § Negative-Assertion
  // Fake-Regression Check): the three golden-line cases below CANNOT bite on
  // their own. Every ledger line was itself written by `JSON.stringify`, so a
  // plain re-stringify round-trips byte-identically — injecting
  // `line: JSON.stringify(record)` into the valid branch left all three GREEN.
  // The defect that does change bytes is routing valid records through
  // `validateSession`'s RETURN, which stamps `schema_version: 2`. No live
  // record has the shape that exposes it (0 of 216 records are
  // valid-and-unversioned at HEAD 1be450a), so the synthetic case at the end of
  // this block is the one that actually fails on drift. The golden cases stay
  // as the production-shaped contract pin.
  for (const n of [6, 7, 13]) {
    it(`emits golden fixture line ${n} unchanged`, () => {
      const original = golden(n);
      expect(() => validateSession(JSON.parse(original))).not.toThrow();

      const result = repairLine(original);

      expect(result.status).toBe('valid');
      expect(result.line).toBe(original);
    });
  }

  it('does not stamp schema_version onto a VALID record that lacks one', () => {
    // This is the case that bites (see the FAKE-REGRESSION NOTE above): if the
    // valid branch ever returns `validateSession(record)`'s output instead of
    // the original bytes, this line gains `"schema_version":2` — a version
    // claim the record never made — and the byte comparison fails.
    const record = baseRecord();
    expect('schema_version' in record).toBe(false);
    const line = JSON.stringify(record);
    expect(() => validateSession(record)).not.toThrow();

    const result = repairLine(line);

    expect(result.status).toBe('valid');
    expect(result.line).toBe(line);
    expect('schema_version' in JSON.parse(result.line)).toBe(false);
  });

  it('passes an unparseable line through untouched', () => {
    const junk = '{"session_id": "broken", ';
    const result = repairLine(junk);
    expect(result.status).toBe('unparseable');
    expect(result.line).toBe(junk);
  });

  it('keeps the ORIGINAL line when a record is still invalid after repair', () => {
    // waves[0] is not an object → no defensible default → error bucket.
    const original = JSON.stringify(baseRecord({ waves: ['not-an-object'] }));
    const result = repairLine(original);
    expect(result.status).toBe('error');
    expect(result.line).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 3. waves = number carries into total_waves
// ---------------------------------------------------------------------------

describe('repairRecord — a numeric `waves` is a wave COUNT, not garbage', () => {
  it('carries the number into a MISSING total_waves', () => {
    // Bug caught: the lossy shortcut `waves = []` alone, which would set
    // total_waves to the new array length (0) and destroy the only surviving
    // record of how many waves the session actually ran.
    const input = without(baseRecord({ waves: 7 }), 'total_waves');
    const { record, defects } = repairRecord(input);

    expect(record.waves).toEqual([]);
    expect(record.total_waves).toBe(7);
    expect(defects).toContain('waves_number');
    expect(defects).toContain('total_waves_missing');
    expect(() => validateSession(record)).not.toThrow();
  });

  it('leaves an already-present total_waves alone (golden line 8, live 104)', () => {
    const input = goldenRecord(8);
    expect(input.waves).toBe(5);
    expect(input.total_waves).toBe(5);

    const { record } = repairRecord(input);

    expect(record.waves).toEqual([]);
    expect(record.total_waves).toBe(5);
    expect(() => validateSession(record)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. The duplicate-id triple survives
// ---------------------------------------------------------------------------

describe('repairText — duplicate session_ids are preserved, never deduped', () => {
  it('emits the three main-2026-05-11-deep-1 lines as three lines in order', () => {
    // Bug caught: a "helpful" dedupe. Downstream readers count LINES
    // (memory-banner sessionsEver = countJsonlLines), so collapsing the triple
    // would silently delete two sessions from every historical count.
    const { text, summary } = repairText(GOLDEN_RAW);
    const ids = text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).session_id);

    expect(ids.filter((id) => id === 'main-2026-05-11-deep-1')).toHaveLength(3);
    expect(ids.slice(2, 5)).toEqual([
      'main-2026-05-11-deep-1',
      'main-2026-05-11-deep-1',
      'main-2026-05-11-deep-1',
    ]);
    expect(summary.duplicate_ids_observed).toEqual([{ session_id: 'main-2026-05-11-deep-1', count: 3 }]);
  });

  it('preserves line count and line order across the whole fixture', () => {
    const { text, summary } = repairText(GOLDEN_RAW);
    const outLines = text.split('\n').filter((l) => l.length > 0);

    expect(outLines).toHaveLength(GOLDEN_LINES.length);
    expect(outLines.map((l) => JSON.parse(l).session_id)).toEqual(
      GOLDEN_LINES.map((l) => JSON.parse(l).session_id)
    );
    expect(summary.invalid_before).toBe(10);
    expect(summary.repaired).toBe(10);
    expect(summary.invalid_after).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it('preserves the trailing newline shape exactly', () => {
    // Bug caught: a rejoin that drops the trailing newline turns the next
    // appended record into a continuation of the last line.
    const { text } = repairText(GOLDEN_RAW);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. _backfill_incomplete_fields is exact per record
// ---------------------------------------------------------------------------

describe('repairRecord — _backfill_incomplete_fields is the exact defaulted set', () => {
  it('lists all six defaulted fields for golden line 2 (live 85)', () => {
    // Bug caught: a provenance list that reports the defect CLASS rather than
    // the fields, or that under-reports because only the first defect was seen.
    const { record } = repairRecord(goldenRecord(2));
    expect(record._backfill_incomplete_fields).toEqual([
      'completed_at',
      'total_waves',
      'waves',
      'agent_summary',
      'total_agents',
      'total_files_changed',
    ]);
  });

  it('lists exactly the two defaulted fields for golden line 1 (live 71)', () => {
    const { record } = repairRecord(goldenRecord(1));
    expect(record._backfill_incomplete_fields).toEqual(['total_agents', 'total_files_changed']);
  });

  it('names agent_summary.spiral, not the whole object, for golden line 9 (live 111)', () => {
    const { record } = repairRecord(goldenRecord(9));
    expect(record._backfill_incomplete_fields).toEqual(['agent_summary.spiral']);
  });

  it('unions with a pre-existing _backfill_incomplete_fields instead of clobbering it', () => {
    const input = without(baseRecord({ _backfill_incomplete_fields: ['branch'] }), 'total_files_changed');
    const { record } = repairRecord(input);
    expect(record._backfill_incomplete_fields).toEqual(['branch', 'total_files_changed']);
  });
});

// ---------------------------------------------------------------------------
// 9. schema_version absence is preserved
// ---------------------------------------------------------------------------

describe('repairLine — schema_version absence survives repair', () => {
  it('does not stamp schema_version onto golden line 11 (live 152)', () => {
    // Bug caught: serializing validateSession's RETURN value instead of the
    // repaired input. validateSession stamps `schema_version: 2` on its output,
    // inventing a version claim the record never made.
    const input = goldenRecord(11);
    expect('schema_version' in input).toBe(false);

    const result = repairLine(golden(11));

    expect(result.status).toBe('repaired');
    expect('schema_version' in JSON.parse(result.line)).toBe(false);
  });

  it('preserves an existing schema_version verbatim', () => {
    const input = goldenRecord(1);
    expect(input.schema_version).toBe(1);
    const result = repairLine(golden(1));
    expect(JSON.parse(result.line).schema_version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 7. Post-verification failure restores the backup and reports not-ok
// ---------------------------------------------------------------------------

describe('repairLedger — post-verification is fail-safe', () => {
  it('restores the backup byte-identically when the written file is invalid', () => {
    // Seam: a writeFileSync that corrupts the payload — the real failure mode a
    // post-verification exists to catch (truncated / mangled write). Bug caught:
    // trusting the in-memory repair and leaving a corrupt ledger on disk.
    const { repoRoot, file } = makeRepo(GOLDEN_RAW);
    const before = readFileSync(file, 'utf8');

    const summary = repairLedger({
      file,
      repoRoot,
      apply: true,
      deps: {
        writeFileSync: (p, _content, enc) => {
          // Write a schema-INVALID ledger instead of the repaired one.
          writeFileSync(p, '{"session_id":"corrupt","session_type":"feature"}\n', enc);
        },
      },
    });

    expect(summary.ok).toBe(false);
    expect(summary.restored).toBe(true);
    expect(summary.post_verify.invalid_after).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readFileSync(summary.backup_path, 'utf8')).toBe(before);
  });

  it('reports ok and a clean integrity verdict on a canonical ledger path', () => {
    // The integrity probe exercises the REAL vault-mirror render path, which is
    // a strictly different population from validateSession — 5 of the live
    // ledger's records were dropped there, not by the schema.
    const { repoRoot, file } = makeRepo(GOLDEN_RAW);

    const summary = repairLedger({ file, repoRoot, apply: true });

    expect(summary.ok).toBe(true);
    expect(summary.repaired).toBe(10);
    expect(summary.invalid_after).toBe(0);
    expect(summary.post_verify.integrity).toBe('clean');
  });

  it('reports the integrity probe as skipped for a non-canonical path', () => {
    // Bug caught: silently measuring <repoRoot>/.orchestrator/metrics/sessions.jsonl
    // (the path checkSessionsIntegrity hardcodes) while --file pointed elsewhere,
    // which would "verify" a file the run never touched.
    const other = path.join(tmp, 'elsewhere.jsonl');
    writeFileSync(other, GOLDEN_RAW, 'utf8');

    const verdict = verifyWritten({ file: other, repoRoot: REPO_ROOT });

    expect(verdict.integrity).toBe('skipped-not-canonical-path');
  });
});

// ---------------------------------------------------------------------------
// 4. Idempotency (module level; the CLI suite repeats it through the process)
// ---------------------------------------------------------------------------

describe('repairLedger — idempotency', () => {
  it('is a no-op on a second apply: byte-identical file, repaired 0', () => {
    // Bug caught: a repair that keeps re-flagging or re-writing already-repaired
    // records (e.g. by appending to _backfill_incomplete_fields every run).
    const { repoRoot, file } = makeRepo(GOLDEN_RAW);

    const first = repairLedger({ file, repoRoot, apply: true });
    const afterRun1 = readFileSync(file, 'utf8');

    const second = repairLedger({ file, repoRoot, apply: true, backup: false });
    const afterRun2 = readFileSync(file, 'utf8');

    expect(first.repaired).toBe(10);
    expect(second.repaired).toBe(0);
    expect(second.invalid_before).toBe(0);
    expect(afterRun2).toBe(afterRun1);
  });

  it('dry-run writes nothing at all', () => {
    const { repoRoot, file } = makeRepo(GOLDEN_RAW);

    const summary = repairLedger({ file, repoRoot, apply: false });

    expect(summary.mode).toBe('dry-run');
    expect(summary.repaired).toBe(10);
    expect(summary.backup_path).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(GOLDEN_RAW);
  });
});
