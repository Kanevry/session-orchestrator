/**
 * tests/lib/learnings-expiry-sweep.test.mjs
 *
 * Vitest suite for scripts/lib/learnings/expiry-sweep.mjs (Epic #723 B4 +
 * issue #1017).
 *
 * Covers: grace-window partitioning (kept vs archived), archive tagging
 * (_archived_at / _archive_reason), dry-run no-op, backup-on-apply (proves
 * rewriteLearnings' #721 safety net fires), append-only archive semantics
 * across repeated sweeps, the missing-store zeroed result, and — for the
 * decision-driven `pruneLearnings` sibling (#1017) — reason routing, caller-drop
 * tombstoning, consolidation `_superseded_by`, and the fail-closed reason enum.
 *
 * All timestamps are relative to Date.now() at test-run time — no absolute
 * date fixtures (avoids future TTL-expiry time bombs).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ARCHIVE_REASONS,
  pruneLearnings,
  sweepExpiredLearnings,
} from '@lib/learnings/expiry-sweep.mjs';
import { unwritablePath } from '../_helpers/unwritable-path.mjs';

const DAY_MS = 86_400_000;

function learning(overrides = {}) {
  return {
    id: 'id-1',
    type: 'recurring-issue',
    subject: 'subject',
    insight: 'insight text',
    evidence: 'evidence text',
    confidence: 0.6,
    source_session: 'sess-1',
    created_at: new Date(Date.now() - 100 * DAY_MS).toISOString(),
    expires_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    schema_version: 1,
    ...overrides,
  };
}

function writeJsonl(filePath, entries) {
  writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
}

let tmp;
let filePath;
let archivePath;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'expiry-sweep-'));
  filePath = join(tmp, 'learnings.jsonl');
  archivePath = join(tmp, 'learnings-archive.jsonl');
});

afterEach(() => {
  if (tmp && existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Missing store
// ---------------------------------------------------------------------------

describe('sweepExpiredLearnings — missing store', () => {
  it('returns a zeroed result and does not throw when filePath does not exist', async () => {
    const result = await sweepExpiredLearnings({ filePath, archivePath });
    expect(result).toEqual({ scanned: 0, kept: 0, archived: 0, dryRun: true, archivePath });
  });

  it('missing store with dryRun: false still returns a zeroed result (no throw, no write)', async () => {
    const result = await sweepExpiredLearnings({ filePath, archivePath, dryRun: false });
    expect(result).toEqual({ scanned: 0, kept: 0, archived: 0, dryRun: false, archivePath });
    expect(existsSync(archivePath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grace-window partitioning
// ---------------------------------------------------------------------------

describe('sweepExpiredLearnings — grace window', () => {
  it('an entry expired WITHIN the grace window is kept, not archived', async () => {
    const freshlyExpired = learning({
      id: 'fresh-expired',
      expires_at: new Date(Date.now() - 2 * DAY_MS).toISOString(), // 2 days past expiry
    });
    writeJsonl(filePath, [freshlyExpired]);

    const result = await sweepExpiredLearnings({
      filePath,
      archivePath,
      graceDays: 14,
      dryRun: false,
    });

    expect(result.kept).toBe(1);
    expect(result.archived).toBe(0);
    const remaining = readJsonl(filePath);
    expect(remaining.map((e) => e.id)).toEqual(['fresh-expired']);
    expect(existsSync(archivePath)).toBe(false);
  });

  it('an entry expired PAST the grace window is archived with _archived_at + _archive_reason', async () => {
    const oldExpired = learning({
      id: 'old-expired',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(), // 30 days past expiry
    });
    writeJsonl(filePath, [oldExpired]);

    const result = await sweepExpiredLearnings({
      filePath,
      archivePath,
      graceDays: 14,
      dryRun: false,
    });

    expect(result.kept).toBe(0);
    expect(result.archived).toBe(1);

    const remaining = readJsonl(filePath);
    expect(remaining).toEqual([]);

    const archived = readJsonl(archivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('old-expired');
    expect(typeof archived[0]._archived_at).toBe('string');
    expect(Number.isFinite(Date.parse(archived[0]._archived_at))).toBe(true);
    expect(archived[0]._archive_reason).toBe('expired');
  });

  it('a not-yet-expired entry is kept and the archive sidecar is never created', async () => {
    const active = learning({
      id: 'still-active',
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [active]);

    const result = await sweepExpiredLearnings({ filePath, archivePath, dryRun: false });
    expect(result.kept).toBe(1);
    expect(result.archived).toBe(0);
    expect(existsSync(archivePath)).toBe(false);
  });

  it('an entry with no expires_at (unparseable) is treated as not-expired and kept', async () => {
    const noExpiry = learning({ id: 'no-expiry', expires_at: 'not-a-date' });
    writeJsonl(filePath, [noExpiry]);

    const result = await sweepExpiredLearnings({ filePath, archivePath, dryRun: false });
    expect(result.kept).toBe(1);
    expect(result.archived).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dry-run
// ---------------------------------------------------------------------------

describe('sweepExpiredLearnings — dry-run', () => {
  it('dryRun: true mutates neither the store nor the archive, but reports accurate counts', async () => {
    const oldExpired = learning({
      id: 'old-expired',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [oldExpired]);
    const before = readFileSync(filePath, 'utf8');

    const result = await sweepExpiredLearnings({ filePath, archivePath, dryRun: true });

    expect(result).toEqual({ scanned: 1, kept: 0, archived: 1, dryRun: true, archivePath });
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(existsSync(archivePath)).toBe(false);

    const backups = readdirSync(tmp).filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backup on apply (#721 safety net)
// ---------------------------------------------------------------------------

describe('sweepExpiredLearnings — backup on apply (#721 safety net)', () => {
  it('an apply-mode sweep creates exactly one .bak-<ISO> sibling via rewriteLearnings', async () => {
    const keep = learning({
      id: 'keep-me',
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    const archive = learning({
      id: 'archive-me',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [keep, archive]);

    await sweepExpiredLearnings({ filePath, archivePath, dryRun: false });

    const backups = readdirSync(tmp).filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(1);

    // The backup holds the ORIGINAL two-entry content, not the rewritten one.
    const backupBody = readFileSync(join(tmp, backups[0]), 'utf8');
    expect(backupBody).toContain('keep-me');
    expect(backupBody).toContain('archive-me');

    // The rewritten store only holds the kept entry.
    const remaining = readJsonl(filePath);
    expect(remaining.map((e) => e.id)).toEqual(['keep-me']);
  });
});

// ---------------------------------------------------------------------------
// Archive is append-only
// ---------------------------------------------------------------------------

describe('sweepExpiredLearnings — archive is append-only', () => {
  it('a second sweep does not duplicate already-archived entries (they left the store)', async () => {
    const archiveMe = learning({
      id: 'archive-me',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [archiveMe]);

    const first = await sweepExpiredLearnings({ filePath, archivePath, dryRun: false });
    expect(first.archived).toBe(1);
    expect(readJsonl(archivePath)).toHaveLength(1);

    // Second sweep runs against the now-emptied store — nothing left to archive.
    const second = await sweepExpiredLearnings({ filePath, archivePath, dryRun: false });
    expect(second.scanned).toBe(0);
    expect(second.archived).toBe(0);

    const archived = readJsonl(archivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('archive-me');
  });
});

// ---------------------------------------------------------------------------
// Invalid-but-parseable KEEP record safety (review fix — #723 B4 follow-up)
// ---------------------------------------------------------------------------

describe('sweepExpiredLearnings — invalid KEEP record safety', () => {
  it('two consecutive --apply runs with an invalid KEEP record never accumulate archive copies', async () => {
    // Guard for the failure mode the dryRun:true KEEP probe exists to prevent:
    // without the probe, run 1 appends `archive-me` to the archive and THEN
    // blows up in the real rewrite, leaving the store unpruned — so run 2
    // appends the SAME record a second time, forever, on every retry.
    // Asserted on the parsed archive multiset (not a count, not toContain):
    // with the probe it stays empty; delete the probe and it reads
    // ['archive-me'] after run 1 and ['archive-me', 'archive-me'] after run 2.
    const invalidKeep = learning({
      id: 'invalid-keep',
      confidence: 5, // fails validateLearning, survives readLearnings -> KEEP bucket
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    const archiveMe = learning({
      id: 'archive-me',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [invalidKeep, archiveMe]);
    const before = readFileSync(filePath, 'utf8');

    for (const run of [1, 2]) {
      await expect(
        sweepExpiredLearnings({ filePath, archivePath, dryRun: false }),
        `run ${run}`
      ).rejects.toThrow(/confidence/);
      expect(readJsonl(archivePath).map((e) => e.id)).toEqual([]);
      expect(readFileSync(filePath, 'utf8')).toBe(before);
    }
  });

  it('an invalid-but-parseable KEEP record throws BEFORE the archive append or store rewrite', async () => {
    // Passes JSON.parse + readLearnings/normalizeLearning (which never throws
    // on a bad record) but fails validateLearning's confidence range check.
    const invalidKeep = learning({
      id: 'invalid-keep',
      confidence: 5, // out of [0, 1] — fails validateLearning, not readLearnings
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(), // not expired -> KEEP bucket
    });
    const archiveMe = learning({
      id: 'archive-me',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(), // past grace -> ARCHIVE bucket
    });
    writeJsonl(filePath, [invalidKeep, archiveMe]);
    const before = readFileSync(filePath, 'utf8');

    await expect(
      sweepExpiredLearnings({ filePath, archivePath, dryRun: false })
    ).rejects.toThrow(/confidence/);

    // The dry-run validation probe on the KEEP batch throws BEFORE the archive
    // append runs — the archive sidecar must never be created.
    expect(existsSync(archivePath)).toBe(false);
    // The store is byte-unchanged — the real rewrite never ran either.
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    // No backup was created — rewriteLearnings' non-dry call never fired.
    const backups = readdirSync(tmp).filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(0);
  });

  it('an archive-write failure leaves the store byte-unchanged with no backup', async () => {
    if (process.platform === 'win32') return;
    const archiveMe = learning({
      id: 'archive-me',
      expires_at: new Date(Date.now() - 30 * DAY_MS).toISOString(), // past grace -> ARCHIVE bucket
    });
    writeJsonl(filePath, [archiveMe]);
    const before = readFileSync(filePath, 'utf8');

    // unwritablePath() yields a path whose parent (`/dev/null`) is a character
    // device, not a directory — mkdir(dirname(archivePath)) fails fast for
    // every uid (root included), so the archive append itself fails. See
    // tests/_helpers/unwritable-path.mjs and #685.
    await expect(
      sweepExpiredLearnings({ filePath, archivePath: unwritablePath(), dryRun: false })
    ).rejects.toThrow();

    // The store rewrite never ran — it comes strictly AFTER the archive append.
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    const backups = readdirSync(tmp).filter((f) => f.startsWith('learnings.jsonl.bak-'));
    expect(backups).toHaveLength(0);

    // Ordering invariant, stated positively (#1017): a failure at the archive
    // step must leave the record in AT LEAST ONE of {store, archive} — never in
    // NEITHER. Asserted on the union of parsed id SETS, not on record counts: a
    // count survives a merge that replaces two records with one, an id set does
    // not. Swap the append/rewrite order in expiry-sweep.mjs and this goes RED
    // (the store is already pruned when the archive write fails -> empty union).
    const survivingIds = new Set([
      ...readJsonl(filePath).map((e) => e.id),
      ...readJsonl(archivePath).map((e) => e.id),
    ]);
    expect(survivingIds.has('archive-me')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pruneLearnings — decision-driven sibling (#1017)
// ---------------------------------------------------------------------------

function idsIn(filePathArg) {
  return readJsonl(filePathArg).map((e) => e.id);
}

describe('pruneLearnings — expired/zero-confidence records are archived, never deleted', () => {
  it('an expired record leaves the store into the archive tagged _archive_reason: expired', async () => {
    // The #1017 defect verbatim: /evolve pruned `expires_at < now` by rewriting
    // the store with `>` and no archive append, so 11 of 13 rendered
    // learning-id provenance pointers resolved to nothing. Delete the archive
    // append (or route this through a bare rewriteLearnings) and this goes RED.
    const expired = learning({
      id: 'expired-one',
      expires_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    });
    const live = learning({
      id: 'live-one',
      subject: 'other',
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [expired, live]);

    const result = await pruneLearnings({ filePath, archivePath, dryRun: false });

    expect(result.kept).toBe(1);
    expect(result.archived).toBe(1);
    expect(result.byReason).toEqual({ expired: 1 });
    expect(idsIn(filePath)).toEqual(['live-one']);

    const archived = readJsonl(archivePath);
    expect(archived.map((e) => e.id)).toEqual(['expired-one']);
    expect(archived[0]._archive_reason).toBe('expired');
    expect(Number.isFinite(Date.parse(archived[0]._archived_at))).toBe(true);
  });

  it('a decayed record (confidence <= 0) is archived as "pruned", not dropped', async () => {
    const decayed = learning({
      id: 'decayed-one',
      confidence: 0,
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [decayed]);

    const result = await pruneLearnings({ filePath, archivePath, dryRun: false });

    expect(result.byReason).toEqual({ pruned: 1 });
    expect(idsIn(filePath)).toEqual([]);
    expect(readJsonl(archivePath).map((e) => [e.id, e._archive_reason])).toEqual([
      ['decayed-one', 'pruned'],
    ]);
  });

  it('dryRun mutates nothing and takes no backup', async () => {
    const expired = learning({
      id: 'expired-one',
      expires_at: new Date(Date.now() - 1 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [expired]);
    const before = readFileSync(filePath, 'utf8');

    const result = await pruneLearnings({ filePath, archivePath, dryRun: true });

    expect(result).toEqual({
      scanned: 1,
      kept: 0,
      archived: 1,
      byReason: { expired: 1 },
      dryRun: true,
      archivePath,
    });
    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
    expect(readdirSync(tmp).filter((f) => f.startsWith('learnings.jsonl.bak-'))).toHaveLength(0);
  });
});

describe('pruneLearnings — caller-dropped ids are tombstoned', () => {
  it('an id present on disk but absent from the next generation is archived, not lost', async () => {
    // The mechanical guarantee that makes the prose-driven caller safe: whatever
    // an LLM-authored next store generation omits gets a tombstone instead of
    // vanishing. Every id present before the call must still resolve in
    // store ∪ archive afterwards — asserted on id SETS, not counts.
    const keepMe = learning({ id: 'keep-me', subject: 'a' });
    const dropMe = learning({ id: 'drop-me', subject: 'b' });
    for (const e of [keepMe, dropMe]) {
      e.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    }
    writeJsonl(filePath, [keepMe, dropMe]);

    const result = await pruneLearnings({
      filePath,
      archivePath,
      entries: [keepMe], // caller silently dropped `drop-me`
      dryRun: false,
    });

    expect(result.byReason).toEqual({ pruned: 1 });
    expect(idsIn(filePath)).toEqual(['keep-me']);

    const resolvable = new Set([...idsIn(filePath), ...idsIn(archivePath)]);
    expect([...resolvable].sort()).toEqual(['drop-me', 'keep-me']);
    expect(readJsonl(archivePath)[0]._archive_reason).toBe('pruned');
  });

  it('a dropReason function routes a merge to _archive_reason: merged + _merged_into', async () => {
    const source = learning({ id: 'source-1', subject: 'a' });
    const target = learning({ id: 'target-1', subject: 'b' });
    for (const e of [source, target]) {
      e.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    }
    writeJsonl(filePath, [source, target]);

    const result = await pruneLearnings({
      filePath,
      archivePath,
      entries: [target],
      dropReason: () => ({ reason: 'merged', mergedInto: 'target-1' }),
      dryRun: false,
    });

    expect(result.byReason).toEqual({ merged: 1 });
    const archived = readJsonl(archivePath);
    expect(archived).toHaveLength(1);
    expect(archived[0].id).toBe('source-1');
    expect(archived[0]._archive_reason).toBe('merged');
    expect(archived[0]._merged_into).toBe('target-1');
  });
});

describe('pruneLearnings — records the caller cannot be reconciled BY ID are still rescued', () => {
  // The reconciliation identity for these records is `subject`, not `id` — the
  // whole point is that `id` is unusable. `subject` is unique per fixture here
  // and survives the round-trip verbatim, so the store ∪ archive UNION over
  // subjects is the same "every record still resolves" assertion the id-set
  // union makes elsewhere. Never a count: consolidation legitimately turns two
  // records into one, so a plausible count survives a real loss.
  function subjectsIn(filePathArg) {
    return readJsonl(filePathArg).map((e) => e.subject);
  }

  it('a record with an EMPTY id that the next generation omits is archived, not deleted', async () => {
    // TV-001 — the bug: step (3) skipped any record without a usable `id`
    // (`if (typeof id !== 'string' || id.length === 0) continue;`). `keep` is
    // built from `next` alone, so such a record was in neither bucket and the
    // store rewrite deleted it with no archive line — surviving only in the
    // `.bak-<ISO>` snapshot until keep-3 rotation evicted it. Restore that
    // `continue` and this goes RED: the union loses `orphan-no-id`.
    const keepMe = learning({ id: 'keep-me', subject: 'kept' });
    const idless = learning({ id: '', subject: 'orphan-no-id' });
    for (const e of [keepMe, idless]) {
      e.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    }
    writeJsonl(filePath, [keepMe, idless]);

    const result = await pruneLearnings({
      filePath,
      archivePath,
      entries: [keepMe], // caller's next generation omits the id-less record
      dryRun: false,
    });

    expect(result.byReason).toEqual({ pruned: 1 });
    expect(subjectsIn(filePath)).toEqual(['kept']);

    const resolvable = new Set([...subjectsIn(filePath), ...subjectsIn(archivePath)]);
    expect([...resolvable].sort()).toEqual(['kept', 'orphan-no-id']);
    expect(readJsonl(archivePath)[0]._archive_reason).toBe('pruned');
  });

  it('an id-less record the next generation KEEPS is not tombstoned, on this run or the next', async () => {
    // TV-001 — the bug this pins is the NAIVE fix for the one above: archiving
    // every id-less record unconditionally. That record is also in `keep`, so
    // it would live in the store AND gain one fresh archive line on every prune
    // — unbounded archive growth on the DEFAULT (`--entries`-less) invocation,
    // the same "duplicates the archive append every time" failure the KEEP
    // probe exists to prevent. Drop the fingerprint fallback from reconcileKey
    // and this goes RED with archived: 1 on run 1 and 2 lines after run 2.
    const idless = learning({ id: '', subject: 'stays-put' });
    idless.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    writeJsonl(filePath, [idless]);

    const first = await pruneLearnings({ filePath, archivePath, dryRun: false });
    expect(first.archived).toBe(0);
    expect(existsSync(archivePath)).toBe(false);

    const second = await pruneLearnings({ filePath, archivePath, dryRun: false });
    expect(second.archived).toBe(0);
    expect(subjectsIn(filePath)).toEqual(['stays-put']);
    expect(existsSync(archivePath)).toBe(false);
  });

  it('a surplus copy of a DUPLICATE id is archived, not silently dropped by the rewrite', async () => {
    // TV-001 — the bug, one level down from the id-less hole: step (3) tested
    // SET MEMBERSHIP of `id`. Two on-disk records sharing an id against ONE
    // entry in `next` meant both were skipped while `keep` held a single copy —
    // the surplus was deleted with no archive line. Swap the multiset back to
    // `new Set(...)` + `nextIds.has(id)` and this goes RED: `surplus-copy`
    // resolves in neither file.
    const winner = learning({ id: 'same-id', subject: 'winner-copy' });
    const surplus = learning({ id: 'same-id', subject: 'surplus-copy' });
    for (const e of [winner, surplus]) {
      e.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    }
    writeJsonl(filePath, [winner, surplus]);

    const result = await pruneLearnings({
      filePath,
      archivePath,
      entries: [winner],
      dryRun: false,
    });

    expect(result.byReason).toEqual({ pruned: 1 });
    const resolvable = new Set([...subjectsIn(filePath), ...subjectsIn(archivePath)]);
    expect([...resolvable].sort()).toEqual(['surplus-copy', 'winner-copy']);
  });

  it('an archive-write failure leaves every on-disk record — id-less included — still resolvable', async () => {
    // Crash-safety invariant for the PRUNE path (the sweep path has its own
    // copy above). Stated positively: when the pipeline dies partway, every
    // record must remain in AT LEAST ONE of {store, archive}, never in NEITHER.
    // unwritablePath() fails the archive append for every uid, root included.
    // Swap the append/rewrite order in archiveThenRewrite and this goes RED —
    // the store is already rewritten to `keep` when the archive write dies, so
    // both dropped records resolve nowhere.
    if (process.platform === 'win32') return;
    const keepMe = learning({ id: 'keep-me', subject: 'kept' });
    const dropMe = learning({ id: 'drop-me', subject: 'dropped-with-id' });
    const idless = learning({ id: '', subject: 'dropped-no-id' });
    for (const e of [keepMe, dropMe, idless]) {
      e.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    }
    writeJsonl(filePath, [keepMe, dropMe, idless]);

    await expect(
      pruneLearnings({
        filePath,
        archivePath: unwritablePath('prune-archive'),
        entries: [keepMe],
        dryRun: false,
      })
    ).rejects.toThrow();

    const resolvable = new Set([
      ...subjectsIn(filePath),
      ...subjectsIn(unwritablePath('prune-archive')),
    ]);
    expect([...resolvable].sort()).toEqual(['dropped-no-id', 'dropped-with-id', 'kept']);
    expect(readdirSync(tmp).filter((f) => f.startsWith('learnings.jsonl.bak-'))).toHaveLength(0);
  });
});

describe('pruneLearnings — consolidation tombstones the loser', () => {
  it('a duplicate (type, subject) loser is archived "superseded" pointing at the winner id', async () => {
    const lower = learning({ id: 'dup-low', subject: 'same-subject', confidence: 0.4 });
    const higher = learning({ id: 'dup-high', subject: 'same-subject', confidence: 0.9 });
    for (const e of [lower, higher]) {
      e.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    }
    writeJsonl(filePath, [lower, higher]);

    const result = await pruneLearnings({ filePath, archivePath, dryRun: false });

    expect(result.byReason).toEqual({ superseded: 1 });
    expect(idsIn(filePath)).toEqual(['dup-high']);

    const archived = readJsonl(archivePath);
    expect(archived.map((e) => e.id)).toEqual(['dup-low']);
    expect(archived[0]._archive_reason).toBe('superseded');
    expect(archived[0]._superseded_by).toBe('dup-high');
  });

  it('null/empty-subject duplicates are NEVER collapsed (#284)', async () => {
    const a = learning({ id: 'empty-a', subject: '', confidence: 0.4 });
    const b = learning({ id: 'empty-b', subject: '', confidence: 0.9 });
    for (const e of [a, b]) {
      e.expires_at = new Date(Date.now() + 30 * DAY_MS).toISOString();
    }
    writeJsonl(filePath, [a, b]);

    const result = await pruneLearnings({ filePath, archivePath, dryRun: false });

    expect(result.archived).toBe(0);
    expect(idsIn(filePath)).toEqual(['empty-a', 'empty-b']);
    expect(existsSync(archivePath)).toBe(false);
  });
});

describe('pruneLearnings — archive-reason enum is fail-closed', () => {
  it('an unknown reason throws with the store and archive untouched', async () => {
    const dropMe = learning({
      id: 'drop-me',
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [dropMe]);
    const before = readFileSync(filePath, 'utf8');

    await expect(
      pruneLearnings({
        filePath,
        archivePath,
        entries: [],
        dropReason: 'deleted', // not in ARCHIVE_REASONS
        dryRun: false,
      })
    ).rejects.toThrow(/archive reason must be one of/);

    expect(readFileSync(filePath, 'utf8')).toBe(before);
    expect(existsSync(archivePath)).toBe(false);
  });

  it('a "merged" verdict without _merged_into throws — no pointer-less tombstones', async () => {
    const dropMe = learning({
      id: 'drop-me',
      expires_at: new Date(Date.now() + 30 * DAY_MS).toISOString(),
    });
    writeJsonl(filePath, [dropMe]);

    await expect(
      pruneLearnings({
        filePath,
        archivePath,
        entries: [],
        dropReason: 'merged',
        dryRun: false,
      })
    ).rejects.toThrow(/requires a non-empty _merged_into pointer/);

    expect(existsSync(archivePath)).toBe(false);
  });

  it('ARCHIVE_REASONS is the closed four-value vocabulary', async () => {
    expect([...ARCHIVE_REASONS]).toEqual(['expired', 'pruned', 'superseded', 'merged']);
  });
});
