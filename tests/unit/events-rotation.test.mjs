/**
 * tests/unit/events-rotation.test.mjs
 *
 * Smoke tests for scripts/lib/events-rotation.mjs (issue #251).
 * Comprehensive scenarios (concurrent writers, large files, disk-full) land in W4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { maybeRotate } from '../../scripts/lib/events-rotation.mjs';

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
  it('rotates active log to .1 when above threshold', () => {
    // Use maxSizeMb=1 so we only need 1 MiB of data.
    const p = writeFile('events.jsonl', 1 * 1024 * 1024 + 10);
    const r = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 5, enabled: true });

    expect(r.rotated).toBe(true);
    expect(r.archivedAs).toBe(`${p}.1`);
    expect(r.sizeBefore).toBe(1 * 1024 * 1024 + 10);
    expect(r.maxBackups).toBe(5);

    // Active file is gone; caller re-creates on next append.
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}.1`)).toBe(true);
    expect(statSync(`${p}.1`).size).toBe(1 * 1024 * 1024 + 10);
  });

  it('shifts existing backups: .1 → .2, .2 → .3, etc.', () => {
    const p = writeFile('events.jsonl', 1 * 1024 * 1024 + 10);
    writeFileSync(`${p}.1`, 'B1');
    writeFileSync(`${p}.2`, 'B2');

    const r = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 5, enabled: true });

    expect(r.rotated).toBe(true);
    // Previous .2 is now .3, previous .1 is now .2, active is now .1.
    expect(readFileSync(`${p}.3`, 'utf8')).toBe('B2');
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('B1');
    expect(statSync(`${p}.1`).size).toBe(1 * 1024 * 1024 + 10);
    expect(existsSync(p)).toBe(false);
  });

  it('drops the oldest backup when at max-backups', () => {
    const p = writeFile('events.jsonl', 1 * 1024 * 1024 + 10);
    // Populate .1 through .3 with maxBackups=3 (so .3 is the oldest → will be deleted).
    writeFileSync(`${p}.1`, 'B1');
    writeFileSync(`${p}.2`, 'B2');
    writeFileSync(`${p}.3`, 'B3-oldest');

    const r = maybeRotate({ logPath: p, maxSizeMb: 1, maxBackups: 3, enabled: true });

    expect(r.rotated).toBe(true);
    // B3 was dropped; B2 shifted to .3; B1 shifted to .2; active → .1.
    expect(readFileSync(`${p}.3`, 'utf8')).toBe('B2');
    expect(readFileSync(`${p}.2`, 'utf8')).toBe('B1');
    expect(statSync(`${p}.1`).size).toBe(1 * 1024 * 1024 + 10);
    // .4 never existed and must not be created.
    expect(existsSync(`${p}.4`)).toBe(false);
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
