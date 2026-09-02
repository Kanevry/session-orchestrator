/**
 * tests/lib/sessions-canonical.test.mjs
 *
 * Tests for scripts/lib/sessions-canonical.mjs — the canonical (one record per
 * physical session) read of `.orchestrator/metrics/sessions.jsonl` (#1167).
 *
 * Each test names the concrete bug it catches; the module's whole reason to
 * exist is that the raw ledger over-counts, so every case here is a
 * "consumer silently counts one session twice" regression.
 *
 * Fixtures are written to a tmp dir — NEVER the live .orchestrator store.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  readCanonicalSessions,
  canonicalizeSessions,
  canonicalizeSessionsDetailed,
} from '@lib/sessions-canonical.mjs';

let repoRoot;

function ledgerPath() {
  return path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
}

/** Write raw LINES (strings, so a malformed line can be planted verbatim). */
function writeLines(lines) {
  const file = ledgerPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function writeLedger(records) {
  writeLines(records.map((r) => JSON.stringify(r)));
}

/** Minimal ledger-shaped record (only the fields the collapse rules read). */
function rec(overrides) {
  return {
    session_id: 'main-2026-09-01-session-1',
    session_type: 'deep',
    started_at: '2026-09-01T10:00:00.000Z',
    completed_at: '2026-09-01T12:00:00.000Z',
    status: 'completed',
    ...overrides,
  };
}

beforeEach(() => {
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-canonical-'));
});

afterEach(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Rule 1 — newest-wins per session_id
// ---------------------------------------------------------------------------

describe('rule 1 — newest-wins per session_id', () => {
  it('keeps only the LAST record for an id', () => {
    // Bug: the 2026-05-10 duplicate LINE in the live ledger makes a raw
    // line-count reader report one session twice.
    writeLedger([
      rec({ session_id: 'main-2026-05-10-session-1', notes: 'first' }),
      rec({ session_id: 'main-2026-05-10-session-1', notes: 'second' }),
      rec({ session_id: 'main-2026-05-11-session-1' }),
    ]);

    const out = readCanonicalSessions({ repoRoot });

    expect(out).toHaveLength(2);
    expect(out[0].session_id).toBe('main-2026-05-10-session-1');
    expect(out[0].notes).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — supersedes removes the stub
// ---------------------------------------------------------------------------

describe('rule 2 — supersedes', () => {
  it('removes the stub a later record supersedes', () => {
    // Bug: the #1068 supersede path leaves the abandoned stub on disk by
    // design; a reader that keeps both counts the session as abandoned AND
    // completed.
    writeLedger([
      rec({
        session_id: 'main-2026-08-01-abandoned-deadbeef',
        status: 'abandoned',
        _backfill_source: 'events-jsonl',
      }),
      rec({
        session_id: 'main-2026-08-01-session-1',
        status: 'completed',
        supersedes: 'main-2026-08-01-abandoned-deadbeef',
      }),
    ]);

    const out = readCanonicalSessions({ repoRoot });

    expect(out.map((r) => r.session_id)).toEqual(['main-2026-08-01-session-1']);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — narrow abandoned-tuple collapse
// ---------------------------------------------------------------------------

describe('rule 3 — abandoned-tuple collapse', () => {
  const STARTED = '2026-08-15T11:42:58.603Z';
  const COMPLETED = '2026-08-15T12:16:29.600Z';

  it('collapses the two-writer double stub and keeps the NON-synthetic record', () => {
    // Bug: the SessionEnd hook and the startup CLI each wrote one `abandoned`
    // record for the SAME physical session (8 such pairs measured in the live
    // ledger, 2026-09-02 @ c3ab480). They share no id — only the exact
    // started_at + completed_at tuple.
    writeLedger([
      rec({
        session_id: 'main-2026-08-15-session-2',
        status: 'abandoned',
        started_at: STARTED,
        completed_at: COMPLETED,
        _synthetic_session_id: null,
      }),
      rec({
        session_id: 'main-2026-08-15-abandoned-1a2b3c4d',
        status: 'abandoned',
        started_at: STARTED,
        completed_at: COMPLETED,
        _synthetic_session_id: true,
      }),
    ]);

    const out = readCanonicalSessions({ repoRoot });

    expect(out.map((r) => r.session_id)).toEqual(['main-2026-08-15-session-2']);
  });

  it('does NOT collapse two completed records with identical timestamps', () => {
    // Bug (the inverse): an over-broad collapse would delete a real,
    // authoritative session. `completed` is a truth claim, never a
    // second-writer artefact.
    writeLedger([
      rec({ session_id: 'a-session', status: 'completed', started_at: STARTED, completed_at: COMPLETED }),
      rec({
        session_id: 'b-session',
        status: 'completed',
        started_at: STARTED,
        completed_at: COMPLETED,
        _synthetic_session_id: true,
      }),
    ]);

    expect(readCanonicalSessions({ repoRoot }).map((r) => r.session_id)).toEqual([
      'a-session',
      'b-session',
    ]);
  });

  it('does NOT collapse on started_at alone when completed_at differs', () => {
    // Bug: two sessions can share a started_at (a clear/compact re-fire emits
    // the same start); only the FULL tuple identifies one physical session.
    writeLedger([
      rec({
        session_id: 'main-2026-08-15-session-2',
        status: 'abandoned',
        started_at: STARTED,
        completed_at: COMPLETED,
      }),
      rec({
        session_id: 'main-2026-08-15-abandoned-1a2b3c4d',
        status: 'abandoned',
        started_at: STARTED,
        completed_at: '2026-08-15T12:16:29.601Z', // 1 ms later
        _synthetic_session_id: true,
      }),
    ]);

    expect(readCanonicalSessions({ repoRoot })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Read path
// ---------------------------------------------------------------------------

describe('readCanonicalSessions — read path', () => {
  it('skips a malformed line instead of returning nothing', () => {
    // Bug: one truncated append (crash mid-write) must not blank the whole
    // ledger for every consumer.
    writeLines([
      JSON.stringify(rec({ session_id: 'good-1' })),
      '{ not json',
      JSON.stringify(rec({ session_id: 'good-2' })),
    ]);

    expect(readCanonicalSessions({ repoRoot }).map((r) => r.session_id)).toEqual([
      'good-1',
      'good-2',
    ]);
  });

  it('returns [] SILENTLY when the ledger is absent (ENOENT)', () => {
    // #1188 — a fresh repo has no ledger; that is ordinary, not an anomaly, so
    // the WARN below must NOT fire here (a warn on the ordinary path is noise
    // that trains the operator to ignore the real one).
    const seen = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      seen.push(String(chunk));
      return true;
    });
    try {
      expect(readCanonicalSessions({ repoRoot })).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([]);
  });

  it('returns [] with a stderr warning when the ledger path is a DIRECTORY (EISDIR)', () => {
    // Bug (#1188): `catch { return [] }` conflated ENOENT with EACCES/EISDIR, so
    // an UNREADABLE ledger read as "no sessions" and every downstream count was
    // silently wrong with no signal anywhere.
    // FALSIFICATION: restoring the bare `catch { return [] }` leaves `seen` empty.
    fs.mkdirSync(ledgerPath(), { recursive: true });
    const seen = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      seen.push(String(chunk));
      return true;
    });
    let out;
    try {
      out = readCanonicalSessions({ repoRoot });
    } finally {
      spy.mockRestore();
    }
    expect(out).toEqual([]);
    expect(seen.join('')).toContain('EISDIR');
    expect(seen.join('')).toContain('readCanonicalSessions');
  });

  it('accepts an explicit filePath', () => {
    writeLedger([rec({ session_id: 'only-1' })]);
    expect(readCanonicalSessions({ filePath: ledgerPath() })).toHaveLength(1);
  });
});

describe('canonicalizeSessions — pure array form', () => {
  it('applies the same rules to an already-parsed array and does not mutate it', () => {
    const input = [
      rec({ session_id: 'x', notes: 'first' }),
      rec({ session_id: 'x', notes: 'second' }),
    ];
    const out = canonicalizeSessions(input);
    expect(out).toHaveLength(1);
    expect(out[0].notes).toBe('second');
    expect(input).toHaveLength(2);
  });

  it('drops records without a usable session_id and tolerates non-array input', () => {
    expect(canonicalizeSessions([rec({ session_id: '' }), null, 'nope'])).toEqual([]);
    expect(canonicalizeSessions(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rule ordering, supersede attestation, keepUnidentified
// ---------------------------------------------------------------------------

describe('rule ordering — double-stub collapse runs BEFORE supersede removal', () => {
  const T1 = '2026-08-15T11:00:00.000Z';
  const T2 = '2026-08-15T12:00:00.000Z';

  it('drops the synthetic twin of a stub that is itself superseded', () => {
    // Bug (H1, measured): with supersede removal first, deleting the authentic
    // stub shrank the tuple group to ONE member, so rule 3 no longer fired and
    // the synthetic phantom OUTLIVED the session that refuted it — the reader
    // then reported an abandoned session that provably completed.
    const out = canonicalizeSessions([
      { session_id: 'S1', status: 'abandoned', started_at: T1, completed_at: T2 },
      {
        session_id: 'SYN',
        status: 'abandoned',
        started_at: T1,
        completed_at: T2,
        _synthetic_session_id: true,
      },
      { session_id: 'S1c', status: 'completed', started_at: T1, supersedes: 'S1' },
    ]);

    expect(out.map((r) => r.session_id)).toEqual(['S1c']);
  });
});

describe('rule 3 — supersede resolution is order-independent', () => {
  const T1 = '2026-08-15T11:00:00.000Z';
  const A = { session_id: 'A', status: 'abandoned', started_at: T1, completed_at: T1 };
  const B = {
    session_id: 'B',
    status: 'abandoned',
    started_at: T1,
    completed_at: '2026-08-15T11:30:00.000Z',
    supersedes: 'A',
  };
  const C = { session_id: 'C', status: 'completed', started_at: T1, supersedes: 'B' };

  it('resolves a C→B→A chain to {C, A} in every input permutation', () => {
    // Bug (M1, measured): deleting in file order made the SAME three records
    // yield {C, A} or {C} depending on which permutation the appends landed
    // in — B's marker still removed A when B itself had already been removed.
    const perms = [
      [C, B, A],
      [C, A, B],
      [B, C, A],
      [A, B, C],
      [B, A, C],
      [A, C, B],
    ];
    for (const perm of perms) {
      const ids = canonicalizeSessions(perm)
        .map((r) => r.session_id)
        .sort();
      expect(ids).toEqual(['A', 'C']);
    }
  });

  it('breaks a mutual supersede cycle by keeping the NEWEST record', () => {
    // Bug: X→Y and Y→X resolved by insertion order, so two readers of the same
    // file disagreed about which session existed.
    const X = {
      session_id: 'X',
      status: 'abandoned',
      started_at: T1,
      completed_at: T1,
      supersedes: 'Y',
    };
    const Y = {
      session_id: 'Y',
      status: 'abandoned',
      started_at: T1,
      completed_at: '2026-08-15T12:00:00.000Z',
      supersedes: 'X',
    };

    expect(canonicalizeSessions([X, Y]).map((r) => r.session_id)).toEqual(['Y']);
    expect(canonicalizeSessions([Y, X]).map((r) => r.session_id)).toEqual(['Y']);
  });
});

describe('rule 3 — supersede markers must be attestable', () => {
  const T1 = '2026-08-15T11:00:00.000Z';
  const T2 = '2026-08-15T12:00:00.000Z';

  it('ignores a supersede with no shared join key and reports it', () => {
    // Bug: sessions.jsonl is append-only and world-writable to any writer, so
    // an unconstrained `supersedes` let ONE appended line delete ANY id from
    // every consumer (the armed autonomy verdict included).
    const detailed = canonicalizeSessionsDetailed([
      { session_id: 'victim', status: 'abandoned', started_at: T1, completed_at: T2 },
      { session_id: 'attacker', status: 'completed', started_at: T2, supersedes: 'victim' },
    ]);

    expect(detailed.records.map((r) => r.session_id)).toEqual(['victim', 'attacker']);
    expect(detailed.ignoredSupersedes).toEqual([
      { by: 'attacker', target: 'victim', reason: 'no-shared-join-key' },
    ]);
  });

  it('ignores a supersede whose target is not abandoned', () => {
    const detailed = canonicalizeSessionsDetailed([
      { session_id: 'real', status: 'completed', started_at: T1, completed_at: T2 },
      { session_id: 'later', status: 'completed', started_at: T1, supersedes: 'real' },
    ]);

    expect(detailed.records.map((r) => r.session_id)).toEqual(['real', 'later']);
    expect(detailed.ignoredSupersedes).toEqual([
      { by: 'later', target: 'real', reason: 'target-not-abandoned' },
    ]);
  });

  it('honours a supersede joined by raw_session_id even when started_at differs', () => {
    const out = canonicalizeSessions([
      {
        session_id: 'stub',
        status: 'abandoned',
        started_at: T1,
        completed_at: T2,
        raw_session_id: 'uuid-1',
      },
      {
        session_id: 'real',
        status: 'completed',
        started_at: T2,
        raw_session_id: 'uuid-1',
        supersedes: 'stub',
      },
    ]);

    expect(out.map((r) => r.session_id)).toEqual(['real']);
  });
});

describe('keepUnidentified option', () => {
  it('appends id-less record objects after the identified ones, in order', () => {
    // Bug: an effectiveness/count consumer that needs id-less legacy rows had
    // to re-implement the identified/anonymous split itself, and the two
    // copies drifted.
    const out = canonicalizeSessions(
      [
        { session_id: 'x', notes: 'first' },
        { session_type: 'deep', notes: 'anon-1' },
        { session_id: 'x', notes: 'second' },
        { session_type: 'feature', notes: 'anon-2' },
        null,
        'nope',
      ],
      { keepUnidentified: true },
    );

    expect(out.map((r) => r.notes)).toEqual(['second', 'anon-1', 'anon-2']);
    expect(canonicalizeSessions([{ session_type: 'deep' }])).toEqual([]);
  });
});
