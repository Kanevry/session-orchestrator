/**
 * tests/unit/events-rotation.test.mjs
 *
 * Smoke tests for scripts/lib/events-rotation.mjs (issue #251).
 * Comprehensive scenarios (concurrent writers, large files, disk-full) land in W4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { maybeRotate } from '@lib/events-rotation.mjs';
import { ARCHIVE_DIR_NAME, ARCHIVE_NAME_RE } from '@lib/events-schema.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir;

function writeFile(name, sizeBytes) {
  const p = join(tmpDir, name);
  // Generate a payload of the requested length without allocating a giant
  // intermediate when sizeBytes is modest (these tests stay under a few MB).
  writeFileSync(p, 'x'.repeat(sizeBytes));
  return p;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'events-rotation-'));
});

afterEach(() => {
  try {
    // Re-enable writes so rmSync can clean up read-only dirs created in tests.
    chmodSync(tmpDir, 0o755);
  } catch { /* best effort */ }
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('maybeRotate — input validation', () => {
  it('throws on missing logPath', () => {
    expect(() =>
      maybeRotate({ logPath: '', maxSizeMb: 10, maxBackups: 5, enabled: true })
    ).toThrow(/logPath/);
  });

  it('throws on out-of-range maxSizeMb', () => {
    const p = writeFile('events.jsonl', 10);
    expect(() =>
      maybeRotate({ logPath: p, maxSizeMb: 0, maxBackups: 5, enabled: true })
    ).toThrow(/maxSizeMb/);
    expect(() =>
      maybeRotate({ logPath: p, maxSizeMb: 2048, maxBackups: 5, enabled: true })
    ).toThrow(/maxSizeMb/);
  });

  it('throws on out-of-range maxBackups', () => {
    const p = writeFile('events.jsonl', 10);
    expect(() =>
      maybeRotate({ logPath: p, maxSizeMb: 10, maxBackups: 0, enabled: true })
    ).toThrow(/maxBackups/);
    expect(() =>
      maybeRotate({ logPath: p, maxSizeMb: 10, maxBackups: 21, enabled: true })
    ).toThrow(/maxBackups/);
  });
});

// ---------------------------------------------------------------------------
// Early returns
// ---------------------------------------------------------------------------

describe('maybeRotate — early returns', () => {
  it('returns reason=disabled when enabled is false', () => {
    const p = writeFile('events.jsonl', 50 * 1024 * 1024); // clearly above threshold
    const r = maybeRotate({ logPath: p, maxSizeMb: 10, maxBackups: 5, enabled: false });
    expect(r).toEqual({ rotated: false, reason: 'disabled' });
    // File must remain untouched.
    expect(existsSync(p)).toBe(true);
    expect(existsSync(`${p}.1`)).toBe(false);
  });

  it('returns reason=no-file when logPath does not exist', () => {
    const missing = join(tmpDir, 'events.jsonl');
    const r = maybeRotate({
      logPath: missing,
      maxSizeMb: 10,
      maxBackups: 5,
      enabled: true,
    });
    expect(r).toEqual({ rotated: false, reason: 'no-file' });
  });

  it('returns reason=under-threshold when file is smaller than maxSizeMb', () => {
    const p = writeFile('events.jsonl', 1024); // 1 KiB
    const r = maybeRotate({ logPath: p, maxSizeMb: 10, maxBackups: 5, enabled: true });
    expect(r).toEqual({ rotated: false, reason: 'under-threshold' });
    expect(existsSync(p)).toBe(true);
    expect(existsSync(`${p}.1`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rotation mechanics
// ---------------------------------------------------------------------------

describe('maybeRotate — rotation', () => {
  it('rotates active log into _archive/ when above threshold', () => {
    // Use maxSizeMb=1 so we only need 1 MiB of data.
    const p = writeFile('events.jsonl', 1 * 1024 * 1024 + 10);
    const r = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 5, enabled: true });

    expect(r.rotated).toBe(true);
    expect(r.archivedAs).toBe(
      join(tmpDir, ARCHIVE_DIR_NAME, r.archivedAs.split('/').pop()),
    );
    expect(ARCHIVE_NAME_RE.test(r.archivedAs.split('/').pop())).toBe(true);
    expect(r.sizeBefore).toBe(1 * 1024 * 1024 + 10);
    expect(r.maxBackups).toBe(5);

    // Active file is re-created carrying ONLY the rotation record.
    expect(readFileSync(p, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(existsSync(r.archivedAs)).toBe(true);
    expect(statSync(r.archivedAs).size).toBe(1 * 1024 * 1024 + 10);
    // The pre-#1401 ring slot is never created.
    expect(existsSync(`${p}.1`)).toBe(false);
  });

  it('keeps every archive under its own stable name — no shift on the next rotation', () => {
    // BUG THIS CATCHES: the pre-#1401 ring RENAMED each surviving backup on
    // every rotation, which is why the `archived_as` pointer the reader uses to
    // detect a missing archive could not be durable.
    const archiveDir = join(tmpDir, ARCHIVE_DIR_NAME);
    mkdirSync(archiveDir, { recursive: true });
    const existing = join(archiveDir, 'events-20260101T000000Z_20260201T000000Z.jsonl');
    writeFileSync(existing, 'B1');

    const p = writeFile('events.jsonl', 1 * 1024 * 1024 + 10);
    const r = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 5, enabled: true });

    expect(r.rotated).toBe(true);
    expect(readFileSync(existing, 'utf8')).toBe('B1');
    expect(readdirSync(archiveDir).sort()).toEqual(
      [existing, r.archivedAs].map((f) => f.split('/').pop()).sort(),
    );
  });

  it('drops the oldest archive when at max-backups', () => {
    const archiveDir = join(tmpDir, ARCHIVE_DIR_NAME);
    mkdirSync(archiveDir, { recursive: true });
    const oldest = join(archiveDir, 'events-20260101T000000Z_20260201T000000Z.jsonl');
    const middle = join(archiveDir, 'events-20260201T000000Z_20260301T000000Z.jsonl');
    const newest = join(archiveDir, 'events-20260301T000000Z_20260401T000000Z.jsonl');
    writeFileSync(oldest, 'B3-oldest');
    writeFileSync(middle, 'B2');
    writeFileSync(newest, 'B1');

    const p = writeFile('events.jsonl', 1 * 1024 * 1024 + 10);
    const r = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 3, enabled: true });

    expect(r.rotated).toBe(true);
    expect(r.pruned).toEqual([oldest]);
    expect(existsSync(oldest)).toBe(false);
    expect(readFileSync(middle, 'utf8')).toBe('B2');
    expect(readFileSync(newest, 'utf8')).toBe('B1');
    expect(readdirSync(archiveDir)).toHaveLength(3);
  });

  it('threshold boundary: exactly maxSizeMb bytes rotates (contract: size < threshold skips, else rotate)', () => {
    // size === threshold is NOT below threshold → rotation fires.
    const exact = 1 * 1024 * 1024;
    const p = writeFile('events.jsonl', exact);
    const r = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 5, enabled: true });
    expect(r.rotated).toBe(true);
    expect(r.sizeBefore).toBe(exact);
  });
});

// ---------------------------------------------------------------------------
// Error safety (must never throw)
// ---------------------------------------------------------------------------

describe('maybeRotate — error safety', () => {
  it('returns reason=error (never throws) when rename fails on read-only dir', () => {
    const p = writeFile('events.jsonl', 1 * 1024 * 1024 + 10);
    // Make the dir read-only so rename() fails with EACCES/EPERM.
    chmodSync(tmpDir, 0o555);

    let result;
    expect(() => {
      result = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 5, enabled: true });
    }).not.toThrow();

    // On some filesystems (e.g., tmpfs on macOS with root-like perms) the
    // read-only dir may still permit rename — in that case rotation simply
    // succeeded and we just confirm no throw. The key guarantee is "never
    // throws"; the error-path shape is validated below.
    if (result.rotated === false) {
      expect(result.reason).toBe('error');
      expect(typeof result.error).toBe('string');
    } else {
      expect(result.rotated).toBe(true);
    }
  });
});
