/**
 * reaper-audit.test.mjs — the bounded audit reader and the size prune (#1437).
 *
 * Both replace a whole-file read of `.orchestrator/metrics/reaper-audit.jsonl`;
 * each test names the bug a tail window would introduce if built naively.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendAuditRecord,
  auditPath,
  buildAuditRecord,
  pruneReaperAudit,
  readAuditRecords,
} from '../../../scripts/lib/orphan-reaper/reaper-audit.mjs';

/** A real-shaped `kill` record, as `runOrphanScan` writes it. */
function killRecord(pid) {
  return buildAuditRecord(
    {
      pid,
      pgid: pid,
      trigger: 'orphan-ppid1',
      threshold: { minAgeSeconds: 300 },
      actual: { ageSeconds: 600 },
      commandSignature: 'tsgo:6f1c0a2b9d',
      args: '/opt/homebrew/bin/tsgo --noEmit -p tsconfig.json',
    },
    'kill',
    {
      timestamp: '2026-10-01T12:00:00.000Z',
      sessionId: 'main-2026-10-01-session-42',
      result: { ok: true, signalsSent: ['SIGTERM'], survivors: [], survivedSigkill: false, verifiedAfterMs: 500, verified: 'gone' },
    },
  );
}

describe('reaper audit — bounded reader and prune', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'reaper-audit-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns exactly the newest `limit` records even when they span more than the first tail window', () => {
    // Bug: a FIXED tail window silently shrinks the false-alarm population once
    // `limit` records outgrow it — 500 records of this shape need ~225 KB, the
    // first window is 64 KiB, so a non-growing reader returns 144 and the
    // HR-101 rate is judged on a population nobody configured.
    for (let pid = 1; pid <= 600; pid += 1) appendAuditRecord(root, killRecord(pid));
    const reference = readFileSync(auditPath(root), 'utf8')
      .split('\n').filter(Boolean).slice(-500).map((l) => JSON.parse(l));

    const got = readAuditRecords(root, 500);

    expect(got).toHaveLength(500);
    expect(got[0].pid).toBe(101);
    expect(got.at(-1).pid).toBe(600);
    expect(got).toEqual(reference);
  });

  it('prunes an oversized audit to its newest whole records and keeps the live file', () => {
    // Bug: a prune that writes the raw tail window keeps a cut-off record as its
    // FIRST line — a corrupt line every later reader must skip — and one that
    // unlinks instead of rewriting loses the live audit the next scan appends to.
    for (let pid = 1; pid <= 200; pid += 1) appendAuditRecord(root, killRecord(pid));
    const before = statSync(auditPath(root)).size;

    const removed = pruneReaperAudit(root, { maxBytes: 16 * 1024, keepBytes: 8 * 1024 });

    const text = readFileSync(auditPath(root), 'utf8');
    const lines = text.split('\n').filter(Boolean);
    expect(removed).toBe(before - Buffer.byteLength(text));
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8 * 1024);
    expect(text.endsWith('\n')).toBe(true);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
    expect(JSON.parse(lines.at(-1)).pid).toBe(200);
    expect(pruneReaperAudit(root, { maxBytes: 16 * 1024, keepBytes: 8 * 1024 })).toBe(0);
  });
});
