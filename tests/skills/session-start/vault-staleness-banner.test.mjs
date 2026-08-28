/**
 * tests/skills/session-start/vault-staleness-banner.test.mjs
 *
 * Unit tests for scripts/lib/vault-staleness-banner.mjs (issue #319, record-age
 * gate #1159).
 *
 * Contract:
 *   - checkVaultStaleness({repoRoot, now?}) reads
 *     `<repoRoot>/.orchestrator/metrics/vault-staleness.jsonl`, takes the LAST
 *     non-empty line, and classifies a banner severity. `now` (epoch ms,
 *     defaults to `Date.now()`) is the clock seam for the record-age gate.
 *   - Returns null on: missing file, empty file, malformed last line, missing
 *     `findings` array, stale_count <= 0.
 *   - Returns {severity: 'info', kind: 'probe-stale', message, ageDays,
 *     timestamp} when stale_count > 0 AND record.timestamp is a parseable
 *     date older than MAX_RECORD_AGE_DAYS (7) relative to `now` — the probe
 *     has not run since, so the recorded findings are not current (#1159).
 *   - Otherwise returns {severity, message, staleCount, maxDeltaHours,
 *     timestamp} when stale_count > 0. Severity is 'warn' when max
 *     delta_hours <= 48, 'alert' when max delta_hours > 48. A missing or
 *     unparsable timestamp always takes this path (never 'probe-stale').
 *   - renderBanner({repoRoot}) returns the message string or '' on null.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  checkVaultStaleness,
  renderBanner,
  MAX_RECORD_AGE_DAYS,
} from '@lib/vault-staleness-banner.mjs';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tmpdir helpers — one isolated repoRoot per test, cleaned up in afterEach.
// ---------------------------------------------------------------------------

let tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  tmpDirs = [];
});

function makeRepo() {
  const d = mkdtempSync(join(tmpdir(), 'so-vault-banner-'));
  tmpDirs.push(d);
  mkdirSync(join(d, '.orchestrator', 'metrics'), { recursive: true });
  return d;
}

function writeJsonl(repoRoot, content) {
  writeFileSync(
    join(repoRoot, '.orchestrator', 'metrics', 'vault-staleness.jsonl'),
    content,
    'utf8',
  );
}

function record(overrides = {}) {
  return {
    timestamp: '2026-04-30T12:00:00Z',
    probe: 'vault-staleness',
    project_root: '/tmp/example',
    vault_dir: '/tmp/example/vault',
    scanned_projects: 5,
    stale_count: 0,
    errors: 0,
    duration_ms: 12,
    findings: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// checkVaultStaleness — null cases
// ---------------------------------------------------------------------------

describe('checkVaultStaleness — silent (null) cases (#319)', () => {
  it('returns null when JSONL file is absent', () => {
    const repo = makeRepo();
    expect(checkVaultStaleness({ repoRoot: repo })).toBeNull();
  });

  it('returns null when JSONL file is empty', () => {
    const repo = makeRepo();
    writeJsonl(repo, '');
    expect(checkVaultStaleness({ repoRoot: repo })).toBeNull();
  });

  it('returns null when last line is malformed JSON (no throw)', () => {
    const repo = makeRepo();
    writeJsonl(repo, 'this is not json\n');
    expect(checkVaultStaleness({ repoRoot: repo })).toBeNull();
  });

  it('returns null when stale_count is 0', () => {
    const repo = makeRepo();
    writeJsonl(repo, JSON.stringify(record({ stale_count: 0 })) + '\n');
    expect(checkVaultStaleness({ repoRoot: repo })).toBeNull();
  });

  it('returns null when findings is missing or non-array', () => {
    const repo = makeRepo();
    const bad = record({ stale_count: 3 });
    delete bad.findings;
    writeJsonl(repo, JSON.stringify(bad) + '\n');
    expect(checkVaultStaleness({ repoRoot: repo })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// checkVaultStaleness — banner classification
// ---------------------------------------------------------------------------

describe('checkVaultStaleness — banner classification (#319)', () => {
  it("classifies severity 'warn' when stale_count=3 and max delta=24h", () => {
    const repo = makeRepo();
    const rec = record({
      stale_count: 3,
      findings: [
        { slug: 'a', severity: 'warn', last_sync: '...', delta_hours: 12, flag: 'stale' },
        { slug: 'b', severity: 'warn', last_sync: '...', delta_hours: 24, flag: 'stale' },
        { slug: 'c', severity: 'warn', last_sync: '...', delta_hours: 18, flag: 'stale' },
      ],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    // `now` pinned 1s after the record's own timestamp — deterministic
    // regardless of wall-clock date, and stays inside the #1159 age gate.
    const now = Date.parse(rec.timestamp) + 1000;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.staleCount).toBe(3);
    expect(result.maxDeltaHours).toBe(24);
    expect(result.message).toContain('3 projects stale');
    expect(result.message).toContain('24h');
  });

  it("classifies severity 'alert' when stale_count=12 and max delta=140.7h, hints at broken cron", () => {
    const repo = makeRepo();
    const rec = record({
      stale_count: 12,
      findings: [
        { slug: 'a', delta_hours: 80 },
        { slug: 'b', delta_hours: 140.7 },
        { slug: 'c', delta_hours: 50 },
      ],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const now = Date.parse(rec.timestamp) + 1000;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('alert');
    expect(result.staleCount).toBe(12);
    expect(result.maxDeltaHours).toBe(140.7);
    expect(result.message).toContain('12 projects stale');
    expect(result.message).toContain('140.7h');
    expect(result.message).toContain('Vault-Sync cron likely broken');
  });

  it("boundary: max delta exactly 48h → severity 'warn' (<= 48 is warn)", () => {
    const repo = makeRepo();
    const rec = record({
      stale_count: 1,
      findings: [{ slug: 'a', delta_hours: 48 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const now = Date.parse(rec.timestamp) + 1000;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.maxDeltaHours).toBe(48);
  });

  it("boundary: max delta 48.1h → severity 'alert' (> 48 is alert)", () => {
    const repo = makeRepo();
    const rec = record({
      stale_count: 1,
      findings: [{ slug: 'a', delta_hours: 48.1 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const now = Date.parse(rec.timestamp) + 1000;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('alert');
    expect(result.maxDeltaHours).toBe(48.1);
  });

  it('multi-line JSONL — picks LAST line only (older lines ignored)', () => {
    const repo = makeRepo();
    const oldRec = record({
      timestamp: '2026-04-29T00:00:00Z',
      stale_count: 99,
      findings: [{ slug: 'old', delta_hours: 999 }],
    });
    const newRec = record({
      timestamp: '2026-04-30T12:00:00Z',
      stale_count: 2,
      findings: [
        { slug: 'x', delta_hours: 10 },
        { slug: 'y', delta_hours: 20 },
      ],
    });
    writeJsonl(repo, JSON.stringify(oldRec) + '\n' + JSON.stringify(newRec) + '\n');

    // `now` pinned near newRec's own timestamp (the LAST line) — oldRec's
    // timestamp is irrelevant since it is never the record read.
    const now = Date.parse(newRec.timestamp) + 60_000;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.staleCount).toBe(2);
    expect(result.maxDeltaHours).toBe(20);
    expect(result.timestamp).toBe('2026-04-30T12:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// checkVaultStaleness — record-age gate (#1159)
// ---------------------------------------------------------------------------

describe('checkVaultStaleness — record-age gate (#1159)', () => {
  it('returns kind: "probe-stale" (not "warn") when the last record is 47 days old', () => {
    // Bug this catches: pre-#1159, a stale record's age was never checked —
    // a 47-day-old probe run with stale_count=14 was re-reported as a
    // CURRENT "warn"/"alert" finding on every session start.
    const repo = makeRepo();
    const rec = record({
      timestamp: '2026-01-01T00:00:00Z',
      stale_count: 14,
      findings: [{ slug: 'a', delta_hours: 10 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const now = Date.parse(rec.timestamp) + 47 * MS_PER_DAY;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('info');
    expect(result.kind).toBe('probe-stale');
    expect(result.ageDays).toBe(47);
    expect(result.timestamp).toBe('2026-01-01T00:00:00Z');
    expect(result.message).toContain('47 days old');
    expect(result.message).toContain('the probe has not run since');
    expect(result.message).not.toContain('Vault-Sync cron likely broken');
  });

  it('positive path: a 2-day-old record still classifies as today\'s "warn" (age gate does not fire)', () => {
    // Bug this catches: an age gate that fires unconditionally (or with an
    // inverted comparison) would swallow every FRESH record too, not just
    // stale ones — this pins the case a broken gate would break.
    const repo = makeRepo();
    const rec = record({
      timestamp: '2026-01-01T00:00:00Z',
      stale_count: 14,
      findings: [{ slug: 'a', delta_hours: 10 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const now = Date.parse(rec.timestamp) + 2 * MS_PER_DAY;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.kind).toBeUndefined();
    expect(result.staleCount).toBe(14);
    expect(result.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('boundary: a record exactly MAX_RECORD_AGE_DAYS old still classifies as "warn" (not yet stale)', () => {
    // Bug this catches: an off-by-one (`>=` instead of `>`) at the exact
    // boundary would misclassify a record precisely 7 days old as
    // 'probe-stale' — the same boundary-inclusivity bug class the sibling
    // 48h maxDelta boundary tests above guard against.
    const repo = makeRepo();
    const rec = record({
      timestamp: '2026-01-01T00:00:00Z',
      stale_count: 5,
      findings: [{ slug: 'a', delta_hours: 10 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const now = Date.parse(rec.timestamp) + MAX_RECORD_AGE_DAYS * MS_PER_DAY;
    const result = checkVaultStaleness({ repoRoot: repo, now });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.kind).toBeUndefined();
  });

  it('missing timestamp keeps today\'s unchanged behaviour (no age gate, no throw)', () => {
    // Bug this catches: a naive age-gate implementation might throw on
    // Date.parse(undefined) or misclassify a record with no timestamp as
    // "infinitely old" — both would change the pre-#1159 contract, which
    // documents a missing timestamp as the existing 'unknown' fallback path.
    const repo = makeRepo();
    const rec = record({ stale_count: 7, findings: [{ slug: 'a', delta_hours: 60 }] });
    delete rec.timestamp;
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    expect(() => checkVaultStaleness({ repoRoot: repo })).not.toThrow();
    const result = checkVaultStaleness({ repoRoot: repo });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('alert');
    expect(result.kind).toBeUndefined();
    expect(result.timestamp).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// renderBanner — convenience wrapper
// ---------------------------------------------------------------------------

describe('renderBanner — string convenience wrapper (#319)', () => {
  it("returns '' when checkVaultStaleness would return null (no JSONL)", () => {
    const repo = makeRepo();
    expect(renderBanner({ repoRoot: repo })).toBe('');
  });

  it('returns the message string when a banner is produced', () => {
    const repo = makeRepo();
    // renderBanner has no `now` seam (it always reads the real clock), so
    // the fixture timestamp must be freshly-relative rather than a fixed
    // literal, or the #1159 age gate would swallow it into 'probe-stale'.
    const rec = record({
      timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      stale_count: 4,
      findings: [{ slug: 'a', delta_hours: 30 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const banner = renderBanner({ repoRoot: repo });
    expect(banner).toContain('4 projects stale');
    expect(banner).toContain('30h');
  });
});
