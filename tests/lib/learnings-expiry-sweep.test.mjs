/**
 * tests/lib/learnings-expiry-sweep.test.mjs
 *
 * Vitest suite for scripts/lib/learnings/expiry-sweep.mjs (Epic #723 B4).
 *
 * Covers: grace-window partitioning (kept vs archived), archive tagging
 * (_archived_at / _archive_reason), dry-run no-op, backup-on-apply (proves
 * rewriteLearnings' #721 safety net fires), append-only archive semantics
 * across repeated sweeps, and the missing-store zeroed result.
 *
 * All timestamps are relative to Date.now() at test-run time — no absolute
 * date fixtures (avoids future TTL-expiry time bombs).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepExpiredLearnings } from '@lib/learnings/expiry-sweep.mjs';
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
  });
});
