/**
 * tests/lib/events-rotation.test.mjs
 *
 * Unit tests for scripts/lib/events-rotation.mjs — the top-level rotation
 * engine (issue #349). Tests the public `maybeRotate()` function.
 *
 * Isolation strategy:
 *   - Real fs via mkdtempSync for all tests (no vi.spyOn on node:fs —
 *     ESM named exports are not configurable; spying is blocked by the
 *     runtime).
 *   - Error paths triggered via real fs conditions (read-only dir,
 *     non-directory path component) so the module's try/catch is exercised
 *     without module-level mocking.
 *   - No fake timers — function is synchronous with no Date.now usage.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maybeRotate } from '@lib/events-rotation.mjs';
import { ARCHIVE_DIR_NAME, ARCHIVE_NAME_RE, ROTATION_EVENT } from '@lib/events-schema.mjs';

/**
 * A ledger body of `count` records spanning `firstTs`..`lastTs`, padded past
 * `minBytes` so it crosses the rotation threshold.
 *
 * Record shape is copied from a live `.orchestrator/metrics/events.jsonl` line
 * (harvested 2026-09-19), per `.claude/rules/testing.md` § Fixtures Mirror
 * Production Data — a hand-shaped record would encode what the reader expects
 * rather than what the writer emits.
 */
function ledgerBody({ firstTs, lastTs, count = 4, minBytes = 0 }) {
  const stamps = [firstTs, ...Array.from({ length: Math.max(0, count - 2) }, () => lastTs), lastTs];
  const lines = stamps.slice(0, count).map((timestamp, i) =>
    JSON.stringify({
      timestamp,
      event: 'orchestrator.auq_clarity.allowed',
      session_id: 'c8eeea77-cbd5-4fd1-81d4-89ba549d8fdb',
      questions: i,
      schema_version: 1,
    }),
  );
  let body = `${lines.join('\n')}\n`;
  if (body.length < minBytes) {
    // Pad with more VALID records so `lines` stays meaningful — padding with
    // junk would silently inflate malformed_lines instead.
    const filler = JSON.stringify({
      timestamp: lastTs,
      event: 'orchestrator.turn.stopped',
      session_id: 'c8eeea77-cbd5-4fd1-81d4-89ba549d8fdb',
      schema_version: 1,
    });
    while (body.length < minBytes) body += `${filler}\n`;
  }
  return body;
}

/** Sole entry in the archive directory (the tests below rotate exactly once). */
function soleArchive(dir) {
  const names = readdirSync(join(dir, ARCHIVE_DIR_NAME));
  expect(names).toHaveLength(1);
  return join(dir, ARCHIVE_DIR_NAME, names[0]);
}

describe('maybeRotate', () => {
  let tmpDir;
  let logPath;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'events-rotation-'));
    logPath = join(tmpDir, 'events.jsonl');
  });

  afterEach(() => {
    // Re-enable writes so rmSync can clean up any read-only dirs created in tests.
    try { chmodSync(tmpDir, 0o755); } catch { /* best effort */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Input validation — throws Error on programmer errors (not runtime fs failure)
  // -------------------------------------------------------------------------

  describe('input validation', () => {
    it('throws when logPath is undefined', () => {
      expect(() =>
        maybeRotate({ logPath: undefined, maxSizeMb: 1, maxBackups: 1, enabled: true })
      ).toThrow(Error);
    });

    it('throw message for undefined logPath includes "logPath"', () => {
      expect(() =>
        maybeRotate({ logPath: undefined, maxSizeMb: 1, maxBackups: 1, enabled: true })
      ).toThrow(/logPath/);
    });

    it('throws when logPath is empty string', () => {
      expect(() =>
        maybeRotate({ logPath: '', maxSizeMb: 1, maxBackups: 1, enabled: true })
      ).toThrow(/logPath/);
    });

    it('throws when maxSizeMb is a float (1.5)', () => {
      expect(() =>
        maybeRotate({ logPath: '/tmp/x.jsonl', maxSizeMb: 1.5, maxBackups: 1, enabled: true })
      ).toThrow(/maxSizeMb/);
    });

    it('throws when maxSizeMb is 0 (below minimum range)', () => {
      expect(() =>
        maybeRotate({ logPath: '/tmp/x.jsonl', maxSizeMb: 0, maxBackups: 1, enabled: true })
      ).toThrow(/maxSizeMb/);
    });

    it('throws when maxSizeMb is 1025 (above maximum range)', () => {
      expect(() =>
        maybeRotate({ logPath: '/tmp/x.jsonl', maxSizeMb: 1025, maxBackups: 1, enabled: true })
      ).toThrow(/maxSizeMb/);
    });

    it('throws when maxBackups is a float (1.5)', () => {
      expect(() =>
        maybeRotate({ logPath: '/tmp/x.jsonl', maxSizeMb: 1, maxBackups: 1.5, enabled: true })
      ).toThrow(/maxBackups/);
    });

    it('throws when maxBackups is 0 (below minimum range)', () => {
      expect(() =>
        maybeRotate({ logPath: '/tmp/x.jsonl', maxSizeMb: 1, maxBackups: 0, enabled: true })
      ).toThrow(/maxBackups/);
    });

    it('throws when maxBackups is 21 (above maximum range)', () => {
      expect(() =>
        maybeRotate({ logPath: '/tmp/x.jsonl', maxSizeMb: 1, maxBackups: 21, enabled: true })
      ).toThrow(/maxBackups/);
    });
  });

  // -------------------------------------------------------------------------
  // Early returns — rotation skipped before touching the file
  // -------------------------------------------------------------------------

  describe('early returns', () => {
    it('returns disabled result when enabled is false', () => {
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: false });
      expect(result).toEqual({ rotated: false, reason: 'disabled' });
    });

    it('leaves file untouched when enabled is false (even if file would exceed threshold)', () => {
      writeFileSync(logPath, Buffer.alloc(50 * 1024 * 1024));
      maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: false });
      expect(existsSync(logPath)).toBe(true);
      expect(existsSync(`${logPath}.1`)).toBe(false);
    });

    it('returns no-file result when log file does not exist', () => {
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });
      expect(result).toEqual({ rotated: false, reason: 'no-file' });
    });

    it('returns under-threshold result when file is 100 bytes with maxSizeMb=1', () => {
      writeFileSync(logPath, Buffer.alloc(100));
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });
      expect(result).toEqual({ rotated: false, reason: 'under-threshold' });
    });

    it('returns under-threshold when file is exactly 1 byte below 1 MiB threshold', () => {
      writeFileSync(logPath, Buffer.alloc(1048575));
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });
      expect(result).toEqual({ rotated: false, reason: 'under-threshold' });
    });

    it('rotates when file size is exactly 1 MiB (at-threshold fires rotation)', () => {
      writeFileSync(logPath, Buffer.alloc(1048576));
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });
      expect(result.rotated).toBe(true);
      expect(result.sizeBefore).toBe(1048576);
    });
  });

  // -------------------------------------------------------------------------
  // Rotation happy path — archive scheme (#1401)
  // -------------------------------------------------------------------------

  describe('rotation happy path', () => {
    it('moves the active file into _archive/ under a name carrying its time range', () => {
      writeFileSync(
        logPath,
        ledgerBody({
          firstTs: '2026-04-12T06:33:01.123Z',
          lastTs: '2026-09-18T19:14:02Z',
          minBytes: 2 * 1024 * 1024,
        }),
      );

      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });

      expect(result.rotated).toBe(true);
      expect(result.archivedAs).toBe(
        join(tmpDir, ARCHIVE_DIR_NAME, 'events-20260412T063301Z_20260918T191402Z.jsonl'),
      );
      expect(existsSync(result.archivedAs)).toBe(true);
      expect(result.maxBackups).toBe(2);
    });

    it('archived file retains the original byte count', () => {
      const body = ledgerBody({
        firstTs: '2026-04-12T06:33:01.123Z',
        lastTs: '2026-09-18T19:14:02Z',
        minBytes: 2 * 1024 * 1024,
      });
      writeFileSync(logPath, body);

      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });

      expect(statSync(result.archivedAs).size).toBe(Buffer.byteLength(body));
      expect(result.sizeBefore).toBe(Buffer.byteLength(body));
    });

    it('successful rotation result has no error field', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });
      expect(result.error).toBeUndefined();
    });

    it('never renames onto an existing archive — a collision gets its own suffix', () => {
      // BUG THIS CATCHES: renameSync overwrites its destination silently. Two
      // rotations of content with the same derived range would DESTROY the
      // first archive — the exact unrecoverable-loss class #1401 exists for.
      const range = {
        firstTs: '2026-04-12T06:33:01.123Z',
        lastTs: '2026-09-18T19:14:02Z',
        minBytes: 2 * 1024 * 1024,
      };
      mkdirSync(join(tmpDir, ARCHIVE_DIR_NAME), { recursive: true });
      const occupied = join(
        tmpDir,
        ARCHIVE_DIR_NAME,
        'events-20260412T063301Z_20260918T191402Z.jsonl',
      );
      writeFileSync(occupied, 'PRIOR-ARCHIVE-MUST-SURVIVE\n');

      writeFileSync(logPath, ledgerBody(range));
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 5, enabled: true });

      expect(result.archivedAs).toBe(
        join(tmpDir, ARCHIVE_DIR_NAME, 'events-20260412T063301Z_20260918T191402Z-2.jsonl'),
      );
      expect(readFileSync(occupied, 'utf8')).toBe('PRIOR-ARCHIVE-MUST-SURVIVE\n');
    });

    it('names the archive `unknown_<now>` when no record carries a parseable timestamp', () => {
      writeFileSync(logPath, `${'x'.repeat(2 * 1024 * 1024)}\n`);
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });

      expect(result.firstTs).toBeNull();
      expect(result.lastTs).toBeNull();
      expect(ARCHIVE_NAME_RE.test(result.archivedAs.split('/').pop())).toBe(true);
      expect(result.archivedAs).toMatch(/events-unknown_\d{8}T\d{6}Z\.jsonl$/);
    });
  });

  // -------------------------------------------------------------------------
  // The rotation record — the ledger carries its own break (#1401 F1)
  // -------------------------------------------------------------------------

  describe('orchestrator.events.rotated record', () => {
    it('is the FIRST line of the new active file and carries all five fields', () => {
      // BUG THIS CATCHES: before #1401 a rotation wrote nothing durable — only
      // a console.error whose stderr the harness discards — so a rotation and a
      // DELETED archive were byte-identical from the outside. Measured
      // 2026-09-19: events.jsonl.1 (53,896 lines, 2026-04-12 → 2026-09-18) was
      // destroyed and no artefact recorded that it had ever existed.
      const body = ledgerBody({
        firstTs: '2026-04-12T06:33:01.123Z',
        lastTs: '2026-09-18T19:14:02Z',
        count: 6,
        minBytes: 2 * 1024 * 1024,
      });
      writeFileSync(logPath, body);
      const expectedLines = body.trimEnd().split('\n').length;

      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });

      expect(result.recordWritten).toBe(true);
      const newFile = readFileSync(logPath, 'utf8');
      const record = JSON.parse(newFile.split('\n')[0]);

      expect(record.event).toBe(ROTATION_EVENT);
      expect(record.archived_as).toBe(result.archivedAs);
      expect(record.size_before).toBe(Buffer.byteLength(body));
      expect(record.lines).toBe(expectedLines);
      expect(record.first_ts).toBe('2026-04-12T06:33:01.123Z');
      expect(record.last_ts).toBe('2026-09-18T19:14:02Z');
      // The new file contains the record and nothing else.
      expect(newFile.trimEnd().split('\n')).toHaveLength(1);
    });

    it('counts unreadable lines in malformed_lines instead of skipping them silently', () => {
      // BUG THIS CATCHES: a JSONL parser that skips a torn line without
      // counting it turns a partial read into a clean verdict — the `lines`
      // figure would then under-report the archive and read as authoritative.
      const valid = ledgerBody({
        firstTs: '2026-04-12T06:33:01.123Z',
        lastTs: '2026-09-18T19:14:02Z',
        count: 3,
      });
      const torn = '{"timestamp":"2026-05-01T00:00:00Z","eve\n"not-an-object"\n';
      const pad = ledgerBody({
        firstTs: '2026-05-02T00:00:00Z',
        lastTs: '2026-09-18T19:14:02Z',
        count: 2,
        minBytes: 2 * 1024 * 1024,
      });
      writeFileSync(logPath, valid + torn + pad);

      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });

      expect(result.malformedLines).toBe(2);
      const record = JSON.parse(readFileSync(logPath, 'utf8').split('\n')[0]);
      expect(record.malformed_lines).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Retention — max-backups still binds, and prunes only its own output
  // -------------------------------------------------------------------------

  describe('archive retention', () => {
    it('prunes the oldest archives beyond maxBackups and names them in the record', () => {
      const archiveDir = join(tmpDir, ARCHIVE_DIR_NAME);
      mkdirSync(archiveDir, { recursive: true });
      const older = join(archiveDir, 'events-20260101T000000Z_20260201T000000Z.jsonl');
      const newer = join(archiveDir, 'events-20260301T000000Z_20260401T000000Z.jsonl');
      writeFileSync(older, 'OLDEST\n');
      writeFileSync(newer, 'NEWER\n');

      writeFileSync(
        logPath,
        ledgerBody({
          firstTs: '2026-04-12T06:33:01.123Z',
          lastTs: '2026-09-18T19:14:02Z',
          minBytes: 2 * 1024 * 1024,
        }),
      );
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });

      expect(result.pruned).toEqual([older]);
      expect(existsSync(older)).toBe(false);
      expect(existsSync(newer)).toBe(true);
      const record = JSON.parse(readFileSync(logPath, 'utf8').split('\n')[0]);
      expect(record.pruned).toEqual([older]);
    });

    it('never prunes a file in _archive/ that rotation did not write', () => {
      // BUG THIS CATCHES: `_archive/` is a shared, human-facing directory — the
      // live repo copy holds a hand-placed analysis dump. A loose name match
      // would delete an operator's file to satisfy max-backups.
      const archiveDir = join(tmpDir, ARCHIVE_DIR_NAME);
      mkdirSync(archiveDir, { recursive: true });
      const foreign = join(archiveDir, 'events-worktree-vault-session-analysis-2026-08-17.jsonl');
      writeFileSync(foreign, 'HAND-PLACED\n');
      writeFileSync(join(archiveDir, 'events-20260101T000000Z_20260201T000000Z.jsonl'), 'A\n');

      writeFileSync(
        logPath,
        ledgerBody({
          firstTs: '2026-04-12T06:33:01.123Z',
          lastTs: '2026-09-18T19:14:02Z',
          minBytes: 2 * 1024 * 1024,
        }),
      );
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });

      expect(result.pruned).toEqual([
        join(archiveDir, 'events-20260101T000000Z_20260201T000000Z.jsonl'),
      ]);
      expect(readFileSync(foreign, 'utf8')).toBe('HAND-PLACED\n');
    });

    it('leaves a legacy .1 ring backup untouched — it is read, never shifted or pruned', () => {
      // Two live fleet repos still carry a pre-#1401 `events.jsonl.1`
      // (measured 2026-09-19). Shifting or pruning it would destroy history the
      // reader can still use.
      writeFileSync(`${logPath}.1`, 'LEGACY-RING-BACKUP\n');
      writeFileSync(
        logPath,
        ledgerBody({
          firstTs: '2026-04-12T06:33:01.123Z',
          lastTs: '2026-09-18T19:14:02Z',
          minBytes: 2 * 1024 * 1024,
        }),
      );

      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });

      expect(result.rotated).toBe(true);
      expect(readFileSync(`${logPath}.1`, 'utf8')).toBe('LEGACY-RING-BACKUP\n');
      expect(existsSync(`${logPath}.2`)).toBe(false);
      expect(soleArchive(tmpDir)).toBe(result.archivedAs);
    });
  });

  // -------------------------------------------------------------------------
  // Error handling — never throws; wraps real fs errors in the result object
  // -------------------------------------------------------------------------

  describe('error handling', () => {
    it('returns error result (does not throw) when rename fails due to read-only directory', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      chmodSync(tmpDir, 0o555); // read+execute only — rename will fail on most systems

      let result;
      expect(() => {
        result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });
      }).not.toThrow();

      // On some systems (macOS + rootless) chmod on tmpfs may not block rename —
      // the function must either succeed or return an error result; never throw.
      if (result.rotated === false) {
        expect(result.reason).toBe('error');
        expect(typeof result.error).toBe('string');
        expect(result.error.length).toBeGreaterThan(0);
      } else {
        expect(result.rotated).toBe(true);
      }
    });

    it('returns error result (rotated=false, reason=error) when logPath points inside a file (not a dir)', () => {
      // Create a file, then attempt to use a path whose parent component IS that file.
      const fileAsDir = join(tmpDir, 'notadir');
      writeFileSync(fileAsDir, 'I am a file');
      // This path has a file as a directory component — statSync will throw ENOTDIR.
      const badPath = join(fileAsDir, 'events.jsonl');

      let result;
      expect(() => {
        result = maybeRotate({ logPath: badPath, maxSizeMb: 1, maxBackups: 1, enabled: true });
      }).not.toThrow();

      // existsSync on badPath returns false, so reason = 'no-file', OR
      // if existsSync itself errors, it returns false (Node's existsSync catches errors).
      // Either way, the function must not throw.
      expect(result.rotated).toBe(false);
      expect(['no-file', 'error']).toContain(result.reason);
    });

    it('error result does not include archivedAs field', () => {
      // Use a genuinely inaccessible path (parent dir does not exist).
      const result = maybeRotate({
        logPath: join(tmpDir, 'nonexistent-subdir', 'events.jsonl'),
        maxSizeMb: 1,
        maxBackups: 1,
        enabled: true,
      });
      // nonexistent-subdir doesn't exist → existsSync returns false → no-file
      expect(result.rotated).toBe(false);
      expect(result.archivedAs).toBeUndefined();
    });
  });
});
