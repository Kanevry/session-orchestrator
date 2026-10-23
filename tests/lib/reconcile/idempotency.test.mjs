/**
 * idempotency.test.mjs — Unit tests for the #695 FA2 Reconciliation Engine
 * record-store I/O + logical dedupe + idempotency module
 * (`scripts/lib/reconcile/idempotency.mjs`).
 *
 * ALL disk access targets a per-test TEMP dir (mkdtempSync under os.tmpdir),
 * cleaned up in afterEach. The real `.orchestrator/runtime/` store is NEVER
 * touched. The store path is passed explicitly so resolveStorePath stays inside
 * the temp tree.
 *
 * The idempotency KEY is the logical `learning_key` (issue #695), not the
 * physical hashed `id` — these tests assert dedupe + processed-guard against
 * `learning_key`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_STORE_PATH,
  buildCandidate,
  makeCandidateId,
  loadCandidates,
  isProcessed,
  mergeCandidates,
  markCandidateProcessed,
} from '../../../scripts/lib/reconcile/idempotency.mjs';
import { VERDICT_LEDGER_PATH } from '../../../scripts/lib/reconcile/verdict-ledger.mjs';

let tmpDir;
let storePath;

/** Minimal valid ReconcileCandidate (live: processed_at null). */
function candidate(overrides = {}) {
  return {
    id: 'rc-aaaa1111',
    schema_version: 1,
    learning_key: 'fragile-pattern/zx-imports',
    slug: 'fragile-pattern-zx-imports-660952b',
    status: 'proposed',
    reason: 'reconciliation engine proposed a conditional rule',
    confidence: 0.8,
    created_at: '2026-06-21T00:00:00.000Z',
    processed_at: null,
    superseded_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-idempotency-'));
  storePath = join(tmpDir, 'reconcile-candidates.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('DEFAULT_STORE_PATH', () => {
  it('points at the reconcile work-queue under .orchestrator/runtime', () => {
    expect(DEFAULT_STORE_PATH).toBe('.orchestrator/runtime/reconcile-candidates.jsonl');
  });
});

describe('makeCandidateId', () => {
  // TV-003 consolidation: the former "deterministic and rc-prefixed" and
  // "different id for a different slug" cases exercised the same one-line pure
  // function over the same inputs; merged into one case covering both halves of
  // its contract (stability + slug-sensitivity) with no assertion lost.
  it('is deterministic, rc-prefixed, and slug-sensitive', () => {
    const a = makeCandidateId('fragile-pattern/zx-imports', 'slug-abc');
    const b = makeCandidateId('fragile-pattern/zx-imports', 'slug-abc');
    const c = makeCandidateId('fragile-pattern/zx-imports', 'slug-xyz');
    expect(a).toBe(b);
    expect(a).toMatch(/^rc-[0-9a-f]{8}$/);
    expect(a).not.toBe(c);
  });
});

describe('buildCandidate', () => {
  // TV-001 — the bug: `buildCandidate` mints the records that `mergeCandidates`
  // persists, and `readStore`'s shape guard rejects anything without BOTH
  // `learning_key` and `created_at`. Producer and guard now live in this one
  // file, so a field renamed/dropped on one side would silently quarantine every
  // record the engine writes — a full run vanishing on the next merge, with the
  // banner then reporting "never". No existing test round-trips the constructor
  // through the guard: the engine tests stub the merge seam, and every store test
  // here hand-writes its fixture instead of building one.
  it('produces a record that survives the store shape guard (producer ↔ guard round-trip)', () => {
    const built = buildCandidate({
      id: makeCandidateId('anti-pattern/foo', 'anti-pattern-foo-1234567'),
      learningKey: 'anti-pattern/foo',
      slug: 'anti-pattern-foo-1234567',
      status: 'proposed',
      reason: 'reconciliation engine proposed a conditional rule',
      confidence: 0.9,
      createdAt: '2026-07-31T00:00:00.000Z',
    });

    const result = mergeCandidates({ candidates: [built], storePath });
    expect(result.written).toBe(true);
    expect(result.skipped).toBe(0);
    expect(loadCandidates({ storePath })).toEqual({
      records: [built],
      skipped: 0,
    });
  });

  it('coerces a null learningKey (rejection path) to the empty string', () => {
    expect(
      buildCandidate({
        id: 'rc-dead0000',
        learningKey: null,
        slug: '',
        status: 'rejected',
        reason: 'ineligible',
        confidence: 0,
        createdAt: '2026-07-31T00:00:00.000Z',
      }),
    ).toEqual({
      id: 'rc-dead0000',
      schema_version: 1,
      learning_key: '',
      slug: '',
      status: 'rejected',
      reason: 'ineligible',
      confidence: 0,
      created_at: '2026-07-31T00:00:00.000Z',
      processed_at: null,
      superseded_by: null,
    });
  });
});

describe('loadCandidates', () => {
  // TV-001 — the bug (GitLab #955 finding 2): a reader that returns only the
  // array cannot distinguish a MISSING store from one whose every line failed
  // the shape guard. `reconcile-nudge-banner.mjs` read it that way and reported
  // "last reconcile run: never" for a store holding 40 quarantined rows —
  // denying a run whose record was merely unreadable. `skipped` is what
  // separates them, and it is now on THE reader, not on a longer-named sibling
  // the next consumer would not reach for.
  // TV-003 consolidation: the former "returns an empty array for a missing file"
  // case is folded in here — the missing-store half below asserts strictly more
  // (`{records: [], skipped: 0}` vs `[]`) over the same input.
  it('separates a contaminated store from an empty one (both yield records: [])', () => {
    const foreignPath = join(tmpDir, 'contaminated.jsonl');
    const foreign = JSON.stringify({ candidate_id: 'rc-1', generated_at: '2026-07-31T07:09:33.905Z', status: 'candidate' });
    writeFileSync(foreignPath, `${foreign}\n${foreign}\nnot json at all\n`, 'utf8');

    expect(loadCandidates({ storePath: foreignPath })).toEqual({ records: [], skipped: 3 });
    expect(loadCandidates({ storePath: join(tmpDir, 'missing.jsonl') })).toEqual({
      records: [],
      skipped: 0,
    });
  });

  it('is read-only — the skipped lines are still on disk afterwards (unlike mergeCandidates)', () => {
    const foreign = JSON.stringify({ candidate_id: 'rc-1', generated_at: '2026-07-31T07:09:33.905Z' });
    writeFileSync(storePath, `${foreign}\n`, 'utf8');

    expect(loadCandidates({ storePath }).skipped).toBe(1);
    expect(loadCandidates({ storePath }).skipped).toBe(1);
  });

  it('skips a malformed line and returns the valid records (no throw)', () => {
    const valid = JSON.stringify(candidate({ learning_key: 'fragile-pattern/zx-imports' }));
    writeFileSync(storePath, `${valid}\nthis is not json\n`, 'utf8');

    const { records, skipped } = loadCandidates({ storePath });
    expect(records).toHaveLength(1);
    expect(records[0].learning_key).toBe('fragile-pattern/zx-imports');
    expect(skipped).toBe(1);
  });

  // TV-001 — the bug this catches, which the rest of the suite lets through:
  // on 2026-07-31 a wave-agent hand-wrote 16 report records into the real store
  // (`.orchestrator/runtime/reconcile-candidates.jsonl`) in a shape NO writer in
  // this repo produces — `candidate_id`/`generated_at`/`status:"candidate"`, no
  // `created_at`, no `schema_version`, no `processed_at`. readStore accepted every
  // non-array object verbatim, so those records entered the work-queue: they were
  // returned by loadCandidates, counted by the reconcile nudge banner's
  // `lastRunCandidateCount`, and yet invisible to `_lastRunAt` (which reads
  // `created_at`) — a non-empty store reporting "no reconcile run on record".
  // Every other test in this file feeds the store WRITER-FAITHFUL records plus
  // one unparseable line; a well-formed record of the WRONG SHAPE was never
  // exercised, so nothing here goes red when the guard is removed.
  // Fixture is a golden record: field set + order copied from a real line of the
  // 2026-07-31 store, long text values truncated (testing.md § Fixtures Mirror
  // Production Data). NOTE it carries a valid `learning_key` — only the missing
  // `created_at` rejects it, so a `learning_key`-only guard would NOT bite.
  it('rejects a shape-foreign record (candidate_id/generated_at, no created_at)', () => {
    const foreign = {
      learning_key: 'anti-pattern/console-log-process-exit-drops-stdout',
      slug: 'anti-pattern-console-log-process-exit-drops-stdout-91c32e4',
      confidence: 0.95,
      always_apply: 'false',
      globs: ['scripts/lib/**'],
      scope: 'glob-scoped',
      expires_at: '2026-10-27',
      description: 'Node stdout is ASYNC on a pipe (macOS)',
      candidate_id: 'rc-f587113f',
      rule_path: '.claude/rules/anti-pattern-console-log-process-exit-drops-stdout-91c32e4.md',
      status: 'candidate',
      generated_at: '2026-07-31T07:09:33.905Z',
      generated_by: 'W3-reconcile-candidate-dry-run',
    };
    const valid = candidate({ learning_key: 'fragile-pattern/zx-imports' });
    writeFileSync(storePath, `${JSON.stringify(foreign)}\n${JSON.stringify(valid)}\n`, 'utf8');

    // Read side: the foreign record never reaches a consumer, and the drop is
    // reported on the reader itself.
    const loaded = loadCandidates({ storePath });
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].learning_key).toBe('fragile-pattern/zx-imports');
    expect(loaded.skipped).toBe(1);

    // Write side: the drop is reported, not silent, and the store is purged of it.
    const result = mergeCandidates({ candidates: [], storePath });
    expect(result.skipped).toBe(1);
    expect(result.merged.map((r) => r.learning_key)).toEqual(['fragile-pattern/zx-imports']);
    expect(loadCandidates({ storePath })).toEqual({ records: loaded.records, skipped: 0 });
  });
});

describe('mergeCandidates', () => {
  it('writes one new candidate into an empty store and reads it back', () => {
    const result = mergeCandidates({ candidates: [candidate()], storePath });
    expect(result.written).toBe(true);

    const { records } = loadCandidates({ storePath });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      learning_key: 'fragile-pattern/zx-imports',
      status: 'proposed',
      confidence: 0.8,
    });
  });

  it('dedupes by learning_key — re-merging the same key keeps exactly one line (latest wins)', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-old', reason: 'first' })], storePath });
    mergeCandidates({ candidates: [candidate({ id: 'rc-new', reason: 'second' })], storePath });

    const { records } = loadCandidates({ storePath });
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rc-new');
    expect(records[0].reason).toBe('second');
  });

  it('does not overwrite a processed candidate when a new same-key candidate is merged', () => {
    mergeCandidates({
      candidates: [candidate({ id: 'rc-done', processed_at: '2026-06-21T12:00:00.000Z' })],
      storePath,
    });
    mergeCandidates({ candidates: [candidate({ id: 'rc-new', processed_at: null })], storePath });

    const { records } = loadCandidates({ storePath });
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rc-done');
    expect(records[0].processed_at).toBe('2026-06-21T12:00:00.000Z');
  });
});

// #1710 — TV-001: the sidecar is gitignored and checkout-local, so before the
// ledger a verdict (an operator decline above all) existed nowhere a fresh
// worktree could read. These pin that mergeCandidates mirrors every terminal
// DECISION into the append-only ledger exactly once — including verdicts that
// were already in the sidecar before the ledger existed — and never writes a
// ledger without an explicit repoRoot.
describe('mergeCandidates — verdict ledger mirror (#1710)', () => {
  const ledgerLines = (root) => {
    const p = join(root, VERDICT_LEDGER_PATH);
    return existsSync(p)
      ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
  };

  // F1 — only DECISIONS are mirrored. `written`, `already-on-disk` and a record
  // without `outcome` (pre-#1042, read as `written`) describe one branch's tree;
  // the tracked rule file's provenance marker is their cross-tree witness.
  // Mirroring them from a worktree whose branch is later abandoned would make
  // the learning permanently non-re-proposable in main.
  it('backfills an older decision and a new one once each, skips branch-scoped outcomes; a repeat merge appends nothing', () => {
    const repoRoot = tmpDir;
    // Terminal records already in the sidecar from before the ledger existed.
    writeFileSync(
      storePath,
      [
        candidate({ learning_key: 'anti-pattern/old', processed_at: '2026-09-01T00:00:00.000Z', outcome: 'rejected' }),
        candidate({ learning_key: 'anti-pattern/on-disk', processed_at: '2026-09-02T00:00:00.000Z', outcome: 'already-on-disk' }),
        candidate({ learning_key: 'anti-pattern/legacy', processed_at: '2026-09-03T00:00:00.000Z' }),
      ]
        .map((c) => JSON.stringify(c))
        .join('\n') + '\n',
      'utf8',
    );
    const stamped = [
      candidate({ learning_key: 'anti-pattern/new', processed_at: '2026-10-01T00:00:00.000Z', outcome: 'expired-swept' }),
      candidate({ learning_key: 'anti-pattern/written', processed_at: '2026-10-02T00:00:00.000Z', outcome: 'written' }),
    ];

    const first = mergeCandidates({ candidates: stamped, repoRoot, storePath });
    expect(first.written).toBe(true);
    expect(first.ledger).toEqual({ ok: true, appended: 2 });
    expect(ledgerLines(repoRoot).map((r) => [r.kind, r.learning_key, r.outcome, r.processed_at])).toEqual([
      ['verdict', 'anti-pattern/new', 'expired-swept', '2026-10-01T00:00:00.000Z'],
      ['verdict', 'anti-pattern/old', 'rejected', '2026-09-01T00:00:00.000Z'],
    ]);

    const second = mergeCandidates({ candidates: [], repoRoot, storePath });
    expect(second.ledger).toEqual({ ok: true, appended: 0 });
    expect(ledgerLines(repoRoot)).toHaveLength(2);
  });

  // Real call shape of the rule-drop recipe and the expiry sweep's delete: the
  // learning's sidecar record is already `written`, so mergeCandidates keeps it
  // and its branch-scoped outcome is never mirrored. The decision must reach the
  // ledger anyway, or the dropped rule returns in a fresh worktree.
  it('mirrors a decision stamped over a kept `written` record exactly once', () => {
    const repoRoot = tmpDir;
    const key = 'anti-pattern/dropped-rule';
    writeFileSync(
      storePath,
      JSON.stringify(candidate({ learning_key: key, processed_at: '2026-09-01T00:00:00.000Z', outcome: 'written' })) + '\n',
      'utf8',
    );

    const res = markCandidateProcessed({
      learningKey: key,
      outcome: 'expired-swept',
      processedAt: '2026-10-22T00:00:00.000Z',
      repoRoot,
      storePath,
    });
    markCandidateProcessed({ learningKey: key, outcome: 'expired-swept', repoRoot, storePath });

    expect(res.alreadyProcessed).toBe(true);
    expect(ledgerLines(repoRoot).map((r) => [r.kind, r.learning_key, r.outcome, r.processed_at])).toEqual([
      ['verdict', key, 'expired-swept', '2026-10-22T00:00:00.000Z'],
    ]);
  });

  it('writes no ledger at all when no repoRoot is passed (no cwd fallback)', () => {
    // A cwd fallback would land in this redirected cwd, never in the real repo.
    const fakeCwd = mkdtempSync(join(tmpdir(), 'reconcile-idempotency-cwd-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(fakeCwd);
    try {
      const result = mergeCandidates({
        candidates: [candidate({ processed_at: '2026-10-01T00:00:00.000Z', outcome: 'rejected' })],
        storePath,
      });

      expect(result.written).toBe(true);
      expect(result.ledger).toBeUndefined();
      expect(existsSync(join(tmpDir, VERDICT_LEDGER_PATH))).toBe(false);
      expect(existsSync(join(fakeCwd, VERDICT_LEDGER_PATH))).toBe(false);
    } finally {
      cwd.mockRestore();
      rmSync(fakeCwd, { recursive: true, force: true });
    }
  });
});

describe('isProcessed', () => {
  // TV-003 consolidation: the three former cases shared one setup and differed
  // only in the existing record's (learning_key, processed_at) pair — merged into
  // a table with no assertion lost. isProcessed is true iff BOTH halves match.
  //
  // #1042 added the `outcome` dimension: terminality is `processed_at` ALONE,
  // never the outcome value. The two rows that matter are the last two — a
  // record stamped `'rejected'` (the operator declined the proposal) must read
  // as terminal, or the next run re-proposes the rule he just refused; and a
  // pre-#1042 record with NO `outcome` field must keep reading as terminal
  // exactly as before (back-compat: absence means 'written').
  it.each([
    ['same key + terminal processed_at, no outcome (pre-#1042 record)', 'fragile-pattern/zx-imports', '2026-06-21T12:00:00.000Z', undefined, true],
    ['same key but still live', 'fragile-pattern/zx-imports', null, undefined, false],
    ['different key, terminal', 'anti-pattern/other', '2026-06-21T12:00:00.000Z', 'written', false],
    ['same key + terminal, outcome "written"', 'fragile-pattern/zx-imports', '2026-06-21T12:00:00.000Z', 'written', true],
    ['same key + terminal, outcome "rejected" (#1042)', 'fragile-pattern/zx-imports', '2026-06-21T12:00:00.000Z', 'rejected', true],
  ])('%s → %s', (_label, existingKey, processedAt, outcome, expected) => {
    const cand = candidate({ learning_key: 'fragile-pattern/zx-imports' });
    const existingRecord = candidate({ learning_key: existingKey, processed_at: processedAt });
    if (outcome !== undefined) existingRecord.outcome = outcome;
    expect(isProcessed(cand, [existingRecord])).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// markCandidateProcessed — the terminal stamp (#1042 / #1153 P10)
// ---------------------------------------------------------------------------

describe('markCandidateProcessed', () => {
  it('mints a terminal record whose status agrees with an operator rejection', () => {
    const res = markCandidateProcessed({
      learningKey: 'anti-pattern/never-proposed-before',
      outcome: 'rejected',
      processedAt: '2026-06-22T09:00:00.000Z',
      fallbackSlug: 'anti-pattern-never-proposed-before',
      fallbackConfidence: 0.7,
      storePath,
    });

    // The bug: the mint branch hardcoded status:'proposed' while stamping
    // processed_at + outcome:'rejected' in the SAME record — a terminal,
    // declined candidate that still reads as a live proposal.
    expect(res.stamped.status).toBe('rejected');
    expect(res.stamped.outcome).toBe('rejected');
    expect(res.stamped.processed_at).toBe('2026-06-22T09:00:00.000Z');
    expect(res.written).toBe(true);
    expect(res.alreadyProcessed).toBe(false);

    const { records } = loadCandidates({ storePath });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('rejected');
  });

  it('mints status "proposed" when the proposal was accepted and written', () => {
    const res = markCandidateProcessed({
      learningKey: 'proven-pattern/accepted',
      outcome: 'written',
      processedAt: '2026-06-22T09:00:00.000Z',
      fallbackSlug: 'proven-pattern-accepted',
      storePath,
    });

    expect(res.stamped.status).toBe('proposed');
    expect(res.stamped.outcome).toBe('written');
  });

  it('returns the PERSISTED record when a prior terminal verdict wins the dedupe', () => {
    writeFileSync(
      storePath,
      JSON.stringify(
        candidate({
          learning_key: 'fragile-pattern/zx-imports',
          processed_at: '2026-06-21T12:00:00.000Z',
          outcome: 'written',
        }),
      ) + '\n',
    );

    const res = markCandidateProcessed({
      learningKey: 'fragile-pattern/zx-imports',
      outcome: 'rejected',
      processedAt: '2026-06-25T18:00:00.000Z',
      storePath,
    });

    // The bug: the function returned the freshly-built stamp while
    // mergeCandidates KEPT the existing terminal record — caller and disk
    // disagreed about the verdict, silently.
    const { records } = loadCandidates({ storePath });
    expect(records).toHaveLength(1);
    expect(records[0].processed_at).toBe('2026-06-21T12:00:00.000Z');
    expect(records[0].outcome).toBe('written');
    expect(res.stamped.processed_at).toBe('2026-06-21T12:00:00.000Z');
    expect(res.stamped.outcome).toBe('written');
    expect(res.alreadyProcessed).toBe(true);
    // Not a write FAILURE — writer.mjs raises an operator-visible error on
    // written:false, and the store IS in the intended terminal state here.
    expect(res.written).toBe(true);
  });

  it('stamps a live existing record in place, preserving its provenance fields', () => {
    writeFileSync(storePath, JSON.stringify(candidate({ confidence: 0.42 })) + '\n');

    const res = markCandidateProcessed({
      learningKey: 'fragile-pattern/zx-imports',
      outcome: 'written',
      processedAt: '2026-06-25T18:00:00.000Z',
      storePath,
    });

    expect(res.stamped.processed_at).toBe('2026-06-25T18:00:00.000Z');
    expect(res.stamped.outcome).toBe('written');
    expect(res.stamped.confidence).toBe(0.42);
    expect(res.stamped.created_at).toBe('2026-06-21T00:00:00.000Z');
    expect(res.alreadyProcessed).toBe(false);
  });

  it('is a no-op for a missing learningKey', () => {
    expect(markCandidateProcessed({ outcome: 'written', storePath })).toEqual({
      written: false,
      stamped: null,
    });
    expect(loadCandidates({ storePath }).records).toEqual([]);
  });
});
