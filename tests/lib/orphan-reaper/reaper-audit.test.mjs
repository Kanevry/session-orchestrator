/**
 * reaper-audit.test.mjs — the bounded audit reader and the size prune (#1437).
 *
 * Both replace a whole-file read of `.orchestrator/metrics/reaper-audit.jsonl`;
 * each test names the bug a tail window would introduce if built naively.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    // or unattributed process, so reports outnumber decisions and a line-count
    // stop rule ended the read once the window held `limit` LINES — here the
    // first 64 KiB window, holding fewer than 50 decisions and none of the
    // rejects. Each scan writes its reports first, then its decision, the order
    // `runOrphanScan` uses. The fixture must outgrow the first window, or the
    // stop rule is never consulted and its mutant survives (#1487 review).
    for (let scan = 1; scan <= 60; scan += 1) {
      for (let pid = 1000; pid < 1010; pid += 1) appendAuditRecord(root, reportRecord(pid));
      const decision = buildAuditRecord(
        { pid: scan, pgid: scan, trigger: 'orphan-ppid1', commandSignature: 'tsgo:6f1c0a2b9d' },
        scan <= 15 ? 'reject' : 'dry-run',
        { timestamp: '2026-10-01T12:00:00.000Z', sessionId: 'main-2026-10-01-session-42', ...(scan <= 15 ? { reason: 'gone' } : {}) },
      );
      appendAuditRecord(root, decision);
    }
    const text = readFileSync(auditPath(root), 'utf8');
    const firstWindowDecisions = Buffer.from(text).subarray(-64 * 1024).toString('utf8')
      .split('\n').filter((l) => /"decision":"(reject|dry-run)"/.test(l)).length;
    expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024);
    expect(firstWindowDecisions).toBeLessThan(50);
    const newestLines = text.split('\n').filter(Boolean).slice(-50).map((l) => JSON.parse(l));

    const got = readAuditRecords(root, 50);

    // The newest 50 decisions are scans 11..60, of which 11..15 are rejects.
    expect(falseAlarmRate(got, 50)).toEqual({ rate: 0.1, n: 50 });
    // Widened, never narrowed: the old population (the newest 50 lines) is
    // still the suffix, so a caller that read lines finds them where they were.
    expect(got.slice(-50)).toEqual(newestLines);
  });

  it.skipIf(process.platform === 'win32')('returns [] for a planted FIFO instead of blocking the scan child in open — a blocking read open hung it at PPID 1', () => {
    // Bug (#1487 review, reproduced 2026-10-02): the append opened the audit
    // O_NONBLOCK, but the rate read then opened the same FIFO with a plain 'r'
    // and blocked until a writer appeared — every hook fire leaves one more hung
    // child, the orphan class HR-107 exists for. Run in a child process: a sync
    // open blocked in THIS worker could not be interrupted by any test timeout.
    mkdirSync(dirname(auditPath(root)), { recursive: true });
    execFileSync('mkfifo', [auditPath(root)]);
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/lib/orphan-reaper/reaper-audit.mjs')).href;
    const probe = `import { readAuditRecords } from ${JSON.stringify(moduleUrl)};
process.stdout.write(JSON.stringify(readAuditRecords(${JSON.stringify(root)}, 50)));`;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 5000 });

    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe('[]');
  });

  it.skipIf(process.platform === 'win32')('warns and returns when APPENDING to a planted FIFO — without O_NONBLOCK the append open blocked the scan child for good', () => {
    // Bug (#1487 review, measured 2026-10-02): the scan child appends once per
    // `report` record BEFORE it reads the rate; an append open without
    // O_NONBLOCK waits for a FIFO reader that never comes, leaving a hung
    // detached child at PPID 1 (the HR-107 class). With the flag the kernel
    // answers ENXIO at once. Child process for the same reason as the read twin.
    mkdirSync(dirname(auditPath(root)), { recursive: true });
    execFileSync('mkfifo', [auditPath(root)]);
    const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts/lib/orphan-reaper/reaper-audit.mjs')).href;
    const probe = `import { appendAuditRecord } from ${JSON.stringify(moduleUrl)};
appendAuditRecord(${JSON.stringify(root)}, ${JSON.stringify(killRecord(1))});`;

    const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { encoding: 'utf8', timeout: 5000 });

    expect(child.signal).toBeNull();
    expect(child.status).toBe(0);
    expect(child.stderr).toMatch(/^orphan-reaper: could not append to \.orchestrator\/metrics\/reaper-audit\.jsonl: ENXIO/);
  });

  it('does not read the rate through a symlinked audit — the link target was read as the audit', () => {
    // Bug (#1487 review): the writers refuse a linked audit, the reader followed
    // it — a link to any file of decision-shaped lines set the HR-101 rate, and a
    // link to a 40 MB file was read whole on every scan (prune refuses links, so
    // its size cap never applied).
    const victimDir = mkdtempSync(join(tmpdir(), 'reaper-audit-victim-'));
    try {
      const victim = join(victimDir, 'events.jsonl');
      writeFileSync(victim, `${JSON.stringify(killRecord(1))}\n`.repeat(60), 'utf8');
      mkdirSync(dirname(auditPath(root)), { recursive: true });
      symlinkSync(victim, auditPath(root));

      expect(readAuditRecords(root, 50)).toEqual([]);
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  it('refuses to APPEND to a hard-linked audit — every record landed in the other name of the file', () => {
    // Bug (#1487 review, reproduced 2026-10-02): `ln <victim> reaper-audit.jsonl`
    // passes O_NOFOLLOW and isFile(), so the append wrote into the victim.
    const victimDir = mkdtempSync(join(tmpdir(), 'reaper-audit-victim-'));
    try {
      const victim = join(victimDir, 'notes.txt');
      writeFileSync(victim, 'keep me\n', 'utf8');
      mkdirSync(dirname(auditPath(root)), { recursive: true });
      linkSync(victim, auditPath(root));
      const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      let warnings;
      try {
        appendAuditRecord(root, killRecord(1));
        warnings = warn.mock.calls.map((c) => String(c[0]));
      } finally {
        warn.mockRestore();
      }

      expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/hard-linked/);
    } finally {
      rmSync(victimDir, { recursive: true, force: true });
    }
  });

  it('never reads past the 1 MiB prune ceiling — an audit the prune does not bound was read whole into memory', () => {
    // Bug (#1487 review): the reader grew ×4 until it held `limit` decisions or
    // reached byte 0, trusting the prune to bound the file; the prune runs AFTER
    // the read and refuses a linked audit, so an oversized file (here 50 old
    // decisions under ~1.3 MiB of reports) was read in a 4 MiB window.
    const decisions = Array.from({ length: 50 }, (_, i) => `${JSON.stringify(killRecord(i + 1))}\n`).join('');
    const reports = `${JSON.stringify(reportRecord(1000))}\n`.repeat(Math.ceil((1.3 * 1024 * 1024) / 200));
    mkdirSync(dirname(auditPath(root)), { recursive: true });
    writeFileSync(auditPath(root), decisions + reports, 'utf8');

    const got = readAuditRecords(root, 50);

    expect(got.filter((r) => r.decision === 'kill')).toHaveLength(0);
    expect(got.length * JSON.stringify(reportRecord(1000)).length).toBeLessThanOrEqual(1024 * 1024);
    expect(got.at(-1)).toEqual(reportRecord(1000));
  });
});
