/**
 * reaper-audit.test.mjs — the bounded audit reader and the size prune (#1437).
 *
 * Both replace a whole-file read of `.orchestrator/metrics/reaper-audit.jsonl`;
 * each test names the bug a tail window would introduce if built naively.
 */

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendAuditRecord,
  auditPath,
  buildAuditRecord,
  falseAlarmRate,
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

/** A `report` record for a process the reaper may not touch, as every scan
 *  re-writes it for each long-lived foreign or unattributed process. */
function reportRecord(pid) {
  return buildAuditRecord(
    { pid, pgid: pid, reason: 'unattributed', ageSeconds: 900 },
    'report',
    { timestamp: '2026-10-01T12:00:00.000Z', sessionId: 'main-2026-10-01-session-42' },
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

  it('refuses a symlinked audit and leaves the link target byte-identical — writeFileSync cut the linked file to its tail', () => {
    // Bug (CWE-59, reproduced 2026-10-01): `statSync` + `writeFileSync(target)`
    // follow a symlink, so `ln -s events.jsonl reaper-audit.jsonl` let the next
    // oversized prune cut events.jsonl down to its newest `keepBytes`.
    const victimDir = mkdtempSync(join(tmpdir(), 'reaper-audit-victim-'));
    try {
      const victim = join(victimDir, 'events.jsonl');
      const body = `${JSON.stringify(killRecord(1))}\n`.repeat(100);
      writeFileSync(victim, body, 'utf8');
      mkdirSync(dirname(auditPath(root)), { recursive: true });
      symlinkSync(victim, auditPath(root));
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      let removed;
      let warnings;
      try {
        removed = pruneReaperAudit(root, { maxBytes: 16 * 1024, keepBytes: 8 * 1024 });
        warnings = warn.mock.calls.map((c) => String(c[0]));
      } finally {
        warn.mockRestore();
      }

      expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);
      expect(removed).toBe(0);
      expect(readFileSync(victim, 'utf8')).toBe(body);
      expect(lstatSync(auditPath(root)).isSymbolicLink()).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/not a regular file/);
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  it('refuses to APPEND through a symlinked audit too — appendFileSync wrote every record into the link target', () => {
    // Bug (CWE-59, #1487 item 5): MR !70 closed the symlink-follow for the
    // prune, but the append kept following the link, so `ln -s events.jsonl
    // reaper-audit.jsonl` routed every kill record into events.jsonl.
    const victimDir = mkdtempSync(join(tmpdir(), 'reaper-audit-victim-'));
    try {
      const victim = join(victimDir, 'events.jsonl');
      writeFileSync(victim, 'keep me\n', 'utf8');
      mkdirSync(dirname(auditPath(root)), { recursive: true });
      symlinkSync(victim, auditPath(root));
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      let warnings;
      try {
        appendAuditRecord(root, killRecord(1));
        warnings = warn.mock.calls.map((c) => String(c[0]));
      } finally {
        warn.mockRestore();
      }

      expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
      expect(lstatSync(auditPath(root)).isSymbolicLink()).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/not a regular file/);
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  it('reads back the newest `limit` DECISIONS, not the newest `limit` lines — report lines pushed every reject out of the rate', () => {
    // Bug (#1487 item 7, HR-105): every scan re-reports each long-lived foreign
    // or unattributed process, so reports outnumber decisions and a 50-LINE
    // window held only the newest 10 of 30 decisions — none a reject — so the
    // rate read 0 while 6 of 30 decisions were rejects. Each scan writes its
    // reports first, then its decision, the order `runOrphanScan` uses.
    for (let scan = 1; scan <= 30; scan += 1) {
      for (let pid = 1000; pid < 1004; pid += 1) appendAuditRecord(root, reportRecord(pid));
      const decision = buildAuditRecord(
        { pid: scan, pgid: scan, trigger: 'orphan-ppid1', commandSignature: 'tsgo:6f1c0a2b9d' },
        scan <= 6 ? 'reject' : 'dry-run',
        { timestamp: '2026-10-01T12:00:00.000Z', sessionId: 'main-2026-10-01-session-42', ...(scan <= 6 ? { reason: 'gone' } : {}) },
      );
      appendAuditRecord(root, decision);
    }
    const newestLines = readFileSync(auditPath(root), 'utf8')
      .split('\n').filter(Boolean).slice(-50).map((l) => JSON.parse(l));

    const got = readAuditRecords(root, 50);

    expect(falseAlarmRate(got, 50)).toEqual({ rate: 0.2, n: 30 });
    // Widened, never narrowed: the old population (the newest 50 lines) is
    // still the suffix, so a caller that read lines finds them where they were.
    expect(got.slice(-50)).toEqual(newestLines);
  });
});
