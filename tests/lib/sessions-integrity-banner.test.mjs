/**
 * sessions-integrity-banner.test.mjs — GitLab #958 finding 3.
 *
 * Nameable bug this suite catches (TV-001): silent ledger corruption reaching
 * vault-mirror as data loss. `scripts/vault-mirror.mjs` logs an invalid record
 * as `{"action":"skipped-invalid"}` and still exits 0, so a session that never
 * got a vault note produces no operator-visible signal. A banner that returned
 * `null` on everything would restore exactly that silence while looking green,
 * so the load-bearing test here is the DISCRIMINATION test: N valid + M
 * invalid must report exactly M, by id, and go silent when the M are removed.
 *
 * The fixture seed is a GOLDEN RECORD harvested verbatim from this repo's real
 * `.orchestrator/metrics/sessions.jsonl` (line 195, `main-2026-07-29-deep-1`,
 * HEAD 1f7b449) per `.claude/rules/testing.md` § Fixtures Mirror Production
 * Data — not a hand-shaped object built to satisfy the reader. Nothing is
 * redacted: the record carries no secrets, and its `session_id`/`branch` name
 * this public repo.
 *
 * Its `status: 'completed'` is LOAD-BEARING, not incidental. The previous seed
 * was `status: 'abandoned'`, which drew every fixture from the population
 * `scripts/lib/vault-mirror/process.mjs:485` discards as `skipped-abandoned`
 * BEFORE the render path — so the whole suite exercised records production
 * never mirrors, and the alert test below asserted an alert the banner had no
 * business raising. Keep any future re-harvest non-abandoned.
 *
 * Each invalid variant reproduces a defect class actually observed in that
 * ledger on 2026-07-31:
 *
 *   - `waves[].wave` missing        → validateSession-invalid, mirrors FINE
 *                                     (real: line 74, main-2026-07-20-session-2)
 *   - `total_waves` missing         → invalid under BOTH
 *                                     (real: lines 199/200)
 *   - `effectiveness` missing       → validateSession-VALID, mirror DROPS it
 *                                     (real: lines 38-49, 10 records — all of
 *                                     which are ALSO abandoned, hence the
 *                                     regression guard at the end of the
 *                                     discrimination block)
 *
 * That third class is why the banner reports two populations: measurement
 * showed neither validator's failure set contains the other.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { checkSessionsIntegrity } from '../../scripts/lib/sessions-integrity-banner.mjs';

const LEDGER_REL = '.orchestrator/metrics/sessions.jsonl';

/**
 * Golden record harvested verbatim from the real ledger (line 195,
 * `main-2026-07-29-deep-1`). `status: 'completed'` — see the file header for
 * why a non-abandoned seed is load-bearing.
 */
const GOLDEN = Object.freeze({
  session_id: 'main-2026-07-29-deep-1',
  session_type: 'deep',
  started_at: '2026-07-29T10:09:33.983Z',
  completed_at: '2026-07-29T13:10:43.404Z',
  total_waves: 5,
  waves: [
    { wave: 1, role: 'Discovery', agents: 6, files_changed: 0 },
    { wave: 2, role: 'Impl-Core', agents: 6, files_changed: 19 },
    { wave: 3, role: 'Impl-Polish', agents: 3, files_changed: 12 },
    { wave: 4, role: 'Quality', agents: 3, files_changed: 0 },
    { wave: 5, role: 'Impl-Polish', agents: 5, files_changed: 14 },
  ],
  agent_summary: { complete: 22, partial: 1, failed: 0, spiral: 0 },
  total_agents: 23,
  total_files_changed: 45,
  status: 'completed',
  effectiveness: { planned_issues: 4, completed_issues: 3, carryover: 0, completion_rate: 1 },
  branch: 'main',
  schema_version: 2,
  total_token_input: 563345,
  total_token_output: 2800396,
  subagents_with_tokens: 24,
});

/** A valid record with a distinct id. */
function validRecord(id) {
  return {
    ...GOLDEN,
    session_id: id,
    waves: GOLDEN.waves.map((w) => ({ ...w })),
    agent_summary: { ...GOLDEN.agent_summary },
    effectiveness: { ...GOLDEN.effectiveness },
  };
}

let repoRoot;

function writeLedger(records) {
  mkdirSync(path.join(repoRoot, '.orchestrator/metrics'), { recursive: true });
  const body = records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n');
  writeFileSync(path.join(repoRoot, LEDGER_REL), body.length > 0 ? `${body}\n` : '');
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'sessions-integrity-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('checkSessionsIntegrity — discrimination', () => {
  it('reports exactly the invalid records by id, then goes silent once they are removed', () => {
    const valid = [validRecord('valid-a'), validRecord('valid-b'), validRecord('valid-c')];

    // M = 2 known-invalid, both failing validateSession.
    const noWaveNumber = { ...validRecord('bad-wave'), waves: [{ role: 'implementer' }] };
    const noTotalWaves = validRecord('bad-total-waves');
    delete noTotalWaves.total_waves;

    writeLedger([valid[0], noWaveNumber, valid[1], noTotalWaves, valid[2]]);

    const found = checkSessionsIntegrity({ repoRoot });

    expect(found).not.toBeNull();
    expect(found.total).toBe(5);
    expect(found.schemaInvalid.map((r) => r.sessionId)).toEqual(['bad-wave', 'bad-total-waves']);
    expect(found.schemaInvalid.map((r) => r.line)).toEqual([2, 4]);
    expect(found.message).toContain('2 of 5 records fail validateSession');

    // Remove the M invalid records — the banner must fall silent.
    writeLedger(valid);
    expect(checkSessionsIntegrity({ repoRoot })).toBeNull();
  });

  it('separates the two populations: a schema-invalid record can still mirror, and a mirror-dropped record can be schema-valid', () => {
    // Real class from ledger line 74: fails validateSession, vault-mirror renders it anyway.
    const schemaOnly = { ...validRecord('schema-only'), waves: [{ role: 'implementer' }] };
    // Real class from ledger lines 38-49: passes validateSession, vault-mirror drops it.
    const mirrorOnly = validRecord('mirror-only');
    delete mirrorOnly.effectiveness;

    writeLedger([schemaOnly, mirrorOnly]);

    const found = checkSessionsIntegrity({ repoRoot });

    expect(found.schemaInvalid.map((r) => r.sessionId)).toEqual(['schema-only']);
    expect(found.mirrorSkipped.map((r) => r.sessionId)).toEqual(['mirror-only']);
    expect(found.mirrorSkipped[0].error).toContain("missing required field 'effectiveness'");
  });

  it('escalates to alert only when vault-mirror actually drops a record', () => {
    const schemaOnly = { ...validRecord('schema-only'), waves: [{ role: 'implementer' }] };
    writeLedger([validRecord('ok'), schemaOnly]);
    const warned = checkSessionsIntegrity({ repoRoot });
    expect(warned.severity).toBe('warn');
    expect(warned.mirrorSkipped).toEqual([]);
    expect(warned.message.startsWith('⚠')).toBe(true);

    // `status: 'completed'` is asserted inline, not inherited: an abandoned
    // record here would be dropped by production as `skipped-abandoned` and
    // must NOT escalate. Pinning it keeps a future golden re-harvest from
    // silently turning this back into an assertion of the #958 false alert.
    const dropped = { ...validRecord('dropped'), status: 'completed' };
    delete dropped.effectiveness;
    writeLedger([validRecord('ok'), dropped]);
    const alerted = checkSessionsIntegrity({ repoRoot });
    expect(alerted.severity).toBe('alert');
    expect(alerted.mirrorSkipped.map((r) => r.sessionId)).toEqual(['dropped']);
    expect(alerted.message).toContain('NO vault note');
    expect(alerted.message.startsWith('🚨')).toBe(true);
  });

  it('does not count an abandoned record as mirror-dropped — production filters it as skipped-abandoned before rendering', () => {
    // Nameable bug (TV-001): without the #909 `isRealSession` guard in
    // `mirrorSkipReason`, this record renders a 🚨 whose remedy ("re-emit via
    // emit-session.mjs") cannot produce a vault note, because
    // `process.mjs:485` discards it before the generator is ever reached.
    // Measured at HEAD 1f7b449: 10 of 10 alerting records were exactly this.
    const abandoned = { ...validRecord('abandoned-renderfail'), status: 'abandoned' };
    delete abandoned.effectiveness; // would throw in the generator if reached

    // Same defect, NOT abandoned — the control that proves the guard is scoped
    // to the abandoned status and has not silenced the real signal.
    const real = { ...validRecord('real-renderfail'), status: 'completed' };
    delete real.effectiveness;

    writeLedger([abandoned]);
    expect(checkSessionsIntegrity({ repoRoot })).toBeNull();

    writeLedger([abandoned, real]);
    const found = checkSessionsIntegrity({ repoRoot });
    expect(found.mirrorSkipped.map((r) => r.sessionId)).toEqual(['real-renderfail']);
    expect(found.total).toBe(2); // abandoned records are still COUNTED, just not blamed
  });
});

describe('checkSessionsIntegrity — silent no-op paths', () => {
  it('returns null for an absent ledger', () => {
    expect(checkSessionsIntegrity({ repoRoot })).toBeNull();
  });

  it('returns null for an empty ledger', () => {
    writeLedger([]);
    expect(checkSessionsIntegrity({ repoRoot })).toBeNull();
  });

  it('returns null for a ledger of unparseable garbage', () => {
    writeLedger(['not json at all', '{"broken": ', '\x00\x01binary']);
    expect(checkSessionsIntegrity({ repoRoot })).toBeNull();
  });

  it('returns null for a fully valid ledger', () => {
    writeLedger([validRecord('a'), validRecord('b')]);
    expect(checkSessionsIntegrity({ repoRoot })).toBeNull();
  });

  it('returns null for a missing or non-string repoRoot instead of throwing', () => {
    expect(checkSessionsIntegrity({})).toBeNull();
    expect(checkSessionsIntegrity()).toBeNull();
    expect(checkSessionsIntegrity({ repoRoot: 42 })).toBeNull();
  });

  it('skips unparseable lines but still reports invalid records around them', () => {
    const bad = validRecord('bad');
    delete bad.total_waves;
    writeLedger([validRecord('a'), 'garbage-line', bad]);

    const found = checkSessionsIntegrity({ repoRoot });
    expect(found.total).toBe(2); // garbage line is not counted as a record
    expect(found.schemaInvalid.map((r) => r.sessionId)).toEqual(['bad']);
  });
});
