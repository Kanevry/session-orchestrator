/**
 * tests/skills/session-start/vault-staleness-banner.test.mjs
 *
 * Unit tests for scripts/lib/vault-staleness-banner.mjs (issue #319).
 *
 * Contract:
 *   - checkVaultStaleness({repoRoot}) reads
 *     `<repoRoot>/.orchestrator/metrics/vault-staleness.jsonl`, takes the LAST
 *     non-empty line, and classifies a banner severity.
 *   - Returns null on: missing file, empty file, malformed last line, missing
 *     `findings` array, stale_count <= 0.
 *   - Returns {severity, message, staleCount, maxDeltaHours, timestamp} when
 *     stale_count > 0. Severity is 'warn' when max delta_hours <= 48,
 *     'alert' when max delta_hours > 48.
 *   - renderBanner({repoRoot}) returns the message string or '' on null.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  checkVaultStaleness,
  renderBanner,
} from '../../../scripts/lib/vault-staleness-banner.mjs';

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

    const result = checkVaultStaleness({ repoRoot: repo });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.staleCount).toBe(3);
    expect(result.maxDeltaHours).toBe(24);
    expect(result.message).toContain('3 projects stale');
    expect(result.message).toContain('24h');
  });

  it("classifies severity 'alert' when stale_count=12 and max delta=140.7h, mentions Clank-Vault-Sync", () => {
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

    const result = checkVaultStaleness({ repoRoot: repo });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('alert');
    expect(result.staleCount).toBe(12);
    expect(result.maxDeltaHours).toBe(140.7);
    expect(result.message).toContain('12 projects stale');
    expect(result.message).toContain('140.7h');
    expect(result.message).toContain('Clank-Vault-Sync');
  });

  it("boundary: max delta exactly 48h → severity 'warn' (<= 48 is warn)", () => {
    const repo = makeRepo();
    const rec = record({
      stale_count: 1,
      findings: [{ slug: 'a', delta_hours: 48 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const result = checkVaultStaleness({ repoRoot: repo });
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

    const result = checkVaultStaleness({ repoRoot: repo });
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

    const result = checkVaultStaleness({ repoRoot: repo });
    expect(result).not.toBeNull();
    expect(result.staleCount).toBe(2);
    expect(result.maxDeltaHours).toBe(20);
    expect(result.timestamp).toBe('2026-04-30T12:00:00Z');
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
    const rec = record({
      stale_count: 4,
      findings: [{ slug: 'a', delta_hours: 30 }],
    });
    writeJsonl(repo, JSON.stringify(rec) + '\n');

    const banner = renderBanner({ repoRoot: repo });
    expect(banner).toContain('4 projects stale');
    expect(banner).toContain('30h');
  });
});
