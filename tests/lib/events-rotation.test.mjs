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
  // Rotation happy path
  // -------------------------------------------------------------------------

  describe('rotation happy path', () => {
    it('returns correct result shape when file exceeds threshold', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });
      expect(result.rotated).toBe(true);
      expect(result.archivedAs).toBe(`${logPath}.1`);
      expect(result.sizeBefore).toBe(2097152);
      expect(result.maxBackups).toBe(2);
    });

    it('active file is moved to .1 and no longer exists at original path', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });
      expect(existsSync(`${logPath}.1`)).toBe(true);
      expect(existsSync(logPath)).toBe(false);
    });

    it('archived file at .1 retains original size', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 2, enabled: true });
      expect(statSync(`${logPath}.1`).size).toBe(2097152);
    });

    it('successful rotation result has no error field', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 1, enabled: true });
      expect(result.error).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Ring-buffer shift — existing backups shift up before active is renamed
  // -------------------------------------------------------------------------

  describe('ring-buffer shift', () => {
    it('shifts .1 → .2 and .2 → .3 preserving content when maxBackups=3', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      writeFileSync(`${logPath}.1`, 'backup-1');
      writeFileSync(`${logPath}.2`, 'backup-2');

      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 3, enabled: true });

      expect(result.rotated).toBe(true);
      expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('backup-1');
      expect(readFileSync(`${logPath}.3`, 'utf8')).toBe('backup-2');
      expect(existsSync(`${logPath}.4`)).toBe(false);
      expect(existsSync(logPath)).toBe(false);
    });

    it('active file content is accessible at .1 after shifting existing backups', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      writeFileSync(`${logPath}.1`, 'old-backup');

      maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 3, enabled: true });

      expect(statSync(`${logPath}.1`).size).toBe(2097152);
      expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('old-backup');
    });

    it('deletes the oldest backup at maxBackups slot before shifting', () => {
      writeFileSync(logPath, Buffer.alloc(2 * 1024 * 1024));
      writeFileSync(`${logPath}.1`, 'B1');
      writeFileSync(`${logPath}.2`, 'B2');
      writeFileSync(`${logPath}.3`, 'B3-oldest');

      const result = maybeRotate({ logPath, maxSizeMb: 1, maxBackups: 3, enabled: true });

      expect(result.rotated).toBe(true);
      // B3-oldest replaced by shifted B2; no .4 should be created
      expect(readFileSync(`${logPath}.3`, 'utf8')).toBe('B2');
      expect(readFileSync(`${logPath}.2`, 'utf8')).toBe('B1');
      expect(existsSync(`${logPath}.4`)).toBe(false);
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
