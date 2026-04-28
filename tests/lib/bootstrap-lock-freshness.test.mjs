import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MS_PER_DAY,
  parseBootstrapLock,
  checkBootstrapLockFreshness,
  classifyVersionMismatch,
} from '../../scripts/lib/bootstrap-lock-freshness.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

let sandbox;

function writeLock(contents) {
  const dir = join(sandbox, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bootstrap.lock'), contents);
}

function isoAgo(days) {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

function nowMs() {
  return Date.now();
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'blfresh-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ── parseBootstrapLock ────────────────────────────────────────────────────────

describe('parseBootstrapLock', () => {
  it('parses all standard fields', () => {
    const result = parseBootstrapLock(`
# .orchestrator/bootstrap.lock
version: 1
tier: standard
archetype: node-minimal
timestamp: 2026-01-01T00:00:00Z
source: plugin-template
plugin-version: 3.0.0
bootstrapped-at: 2026-01-01T00:00:00Z
`);
    expect(result['version']).toBe('1');
    expect(result['tier']).toBe('standard');
    expect(result['archetype']).toBe('node-minimal');
    expect(result['plugin-version']).toBe('3.0.0');
    expect(result['bootstrapped-at']).toBe('2026-01-01T00:00:00Z');
  });

  it('ignores comment lines and blank lines', () => {
    const result = parseBootstrapLock('# comment\n\nkey: value\n');
    expect(result['key']).toBe('value');
    expect(Object.keys(result)).toHaveLength(1);
  });

  it('preserves unknown fields', () => {
    const result = parseBootstrapLock('unknown-field: hello\n');
    expect(result['unknown-field']).toBe('hello');
  });

  it('returns empty object for empty string', () => {
    expect(parseBootstrapLock('')).toEqual({});
  });

  it('returns empty object for comment-only content', () => {
    expect(parseBootstrapLock('# just a comment\n')).toEqual({});
  });

  it('does not throw on non-string input', () => {
    expect(() => parseBootstrapLock(null)).not.toThrow();
    expect(() => parseBootstrapLock(undefined)).not.toThrow();
    expect(() => parseBootstrapLock(42)).not.toThrow();
  });

  it('handles lines without colon gracefully', () => {
    const result = parseBootstrapLock('no-colon-here\nkey: value\n');
    expect(result['key']).toBe('value');
    expect(result['no-colon-here']).toBeUndefined();
  });
});

// ── checkBootstrapLockFreshness — happy path (info) ───────────────────────────

describe('checkBootstrapLockFreshness — info (fresh, matching version)', () => {
  it('returns ok=true and severity=info for a fresh lock with matching plugin-version', () => {
    const bootstrappedAt = isoAgo(5);
    writeLock(`version: 1\ntier: fast\nbootstrapped-at: ${bootstrappedAt}\nplugin-version: 3.0.0\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.ok).toBe(true);
    expect(result.severity).toBe('info');
    expect(result.details.ageDays).toBeLessThan(30);
    expect(result.details.versionMismatch).toBe(false);
  });

  it('returns info for a 1-day-old lock', () => {
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 3.0.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.severity).toBe('info');
  });
});

// ── checkBootstrapLockFreshness — warn ────────────────────────────────────────

describe('checkBootstrapLockFreshness — warn', () => {
  it('returns severity=warn when age is 45 days (30–89d window)', () => {
    const now = nowMs();
    const bootstrappedAt = new Date(now - 45 * 86400000).toISOString();
    writeLock(`version: 1\nbootstrapped-at: ${bootstrappedAt}\nplugin-version: 3.0.0\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
      now,
    });
    expect(result.severity).toBe('warn');
    expect(result.ok).toBe(false);
    expect(result.details.ageDays).toBe(45);
  });

  it('returns severity=warn when age is exactly 30 days', () => {
    const now = nowMs();
    const bootstrappedAt = new Date(now - 30 * 86400000).toISOString();
    writeLock(`version: 1\nbootstrapped-at: ${bootstrappedAt}\nplugin-version: 3.0.0\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
      now,
    });
    expect(result.severity).toBe('warn');
  });

  it('returns severity=alert on major version mismatch (2.9.0 → 3.0.0) regardless of age', () => {
    // Major version mismatch (2.x.x vs 3.x.x) → alert (#290 tiering)
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 2.9.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.severity).toBe('alert');
    expect(result.details.versionMismatch).toBe(true);
  });

  it('includes versionMismatch=false when versions match', () => {
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 3.0.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.details.versionMismatch).toBe(false);
  });
});

// ── checkBootstrapLockFreshness — alert ───────────────────────────────────────

describe('checkBootstrapLockFreshness — alert', () => {
  it('returns severity=alert when age is >= 90 days', () => {
    const now = nowMs();
    const bootstrappedAt = new Date(now - 95 * 86400000).toISOString();
    writeLock(`version: 1\nbootstrapped-at: ${bootstrappedAt}\nplugin-version: 3.0.0\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
      now,
    });
    expect(result.severity).toBe('alert');
    expect(result.ok).toBe(false);
    expect(result.details.ageDays).toBeGreaterThanOrEqual(90);
  });

  it('returns severity=alert when lock file is missing', () => {
    // No lock written — sandbox has no .orchestrator dir
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.severity).toBe('alert');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('missing');
  });

  it('returns severity=alert when bootstrapped-at is missing (no timestamp either)', () => {
    writeLock('version: 1\ntier: fast\nsource: plugin-template\n');
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.severity).toBe('alert');
    expect(result.details.ageDays).toBeNull();
  });

  it('returns severity=alert when bootstrapped-at is unparseable', () => {
    writeLock('version: 1\nbootstrapped-at: not-a-date\n');
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.severity).toBe('alert');
    expect(result.details.ageDays).toBeNull();
  });
});

// ── Legacy lock fallback ──────────────────────────────────────────────────────

describe('checkBootstrapLockFreshness — legacy lock (no bootstrapped-at)', () => {
  it('falls back to timestamp field when bootstrapped-at is absent', () => {
    const now = nowMs();
    const timestamp = new Date(now - 10 * 86400000).toISOString();
    writeLock(`version: 1\ntier: fast\ntimestamp: ${timestamp}\nsource: plugin-template\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
      now,
    });
    // 10 days old → info
    expect(result.severity).toBe('info');
    expect(result.details.bootstrappedAt).toBe(timestamp);
    expect(result.details.ageDays).toBe(10);
  });

  it('flags warn via timestamp fallback when age is 45d', () => {
    const now = nowMs();
    const timestamp = new Date(now - 45 * 86400000).toISOString();
    writeLock(`version: 1\ntimestamp: ${timestamp}\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      now,
    });
    expect(result.severity).toBe('warn');
  });
});

// ── Version mismatch edge cases ───────────────────────────────────────────────

describe('checkBootstrapLockFreshness — version mismatch handling', () => {
  it('does NOT flag versionMismatch when lock has no plugin-version field', () => {
    writeLock(`version: 1\nbootstrapped-at: ${isoAgo(1)}\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    // No plugin-version in lock → versionMismatch is false (can't compare)
    expect(result.details.versionMismatch).toBe(false);
    expect(result.details.pluginVersion).toBeNull();
  });

  it('does NOT flag versionMismatch when currentPluginVersion is not provided', () => {
    writeLock(`version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 2.5.0\n`);
    const result = checkBootstrapLockFreshness({ repoRoot: sandbox });
    expect(result.details.versionMismatch).toBe(false);
  });
});

// ── Never throws ──────────────────────────────────────────────────────────────

describe('checkBootstrapLockFreshness — robustness', () => {
  it('does not throw when called with no arguments', () => {
    expect(() => checkBootstrapLockFreshness()).not.toThrow();
  });

  it('does not throw on an empty lock file', () => {
    writeLock('');
    expect(() =>
      checkBootstrapLockFreshness({ repoRoot: sandbox, currentPluginVersion: '3.0.0' })
    ).not.toThrow();
  });

  it('does not throw on garbage content', () => {
    writeLock('!!!@@@###\x00\x01\x02');
    expect(() =>
      checkBootstrapLockFreshness({ repoRoot: sandbox, currentPluginVersion: '3.0.0' })
    ).not.toThrow();
  });

  it('does not throw when repoRoot does not exist', () => {
    expect(() =>
      checkBootstrapLockFreshness({
        repoRoot: '/definitely/does/not/exist/xyz123',
        currentPluginVersion: '3.0.0',
      })
    ).not.toThrow();
  });

  it('returns ok=false with severity=alert for missing repoRoot parameter', () => {
    const result = checkBootstrapLockFreshness({});
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('alert');
  });
});

// ── Message and details shape ─────────────────────────────────────────────────

describe('checkBootstrapLockFreshness — return shape', () => {
  it('always returns the expected keys', () => {
    writeLock(`version: 1\nbootstrapped-at: ${isoAgo(5)}\nplugin-version: 3.0.0\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result).toHaveProperty('ok');
    expect(result).toHaveProperty('severity');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('details');
    expect(result.details).toHaveProperty('ageDays');
    expect(result.details).toHaveProperty('pluginVersion');
    expect(result.details).toHaveProperty('currentPluginVersion');
    expect(result.details).toHaveProperty('bootstrappedAt');
    expect(result.details).toHaveProperty('versionMismatch');
  });

  it('includes age and version info in the message string', () => {
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(5)}\nplugin-version: 3.0.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
    });
    expect(result.message).toMatch(/age=/);
    expect(result.message).toMatch(/plugin-version=/);
    expect(result.message).toMatch(/current=/);
  });
});

// ── MS_PER_DAY constant (#203) ────────────────────────────────────────────────

describe('MS_PER_DAY constant', () => {
  it('equals exactly 86400000', () => {
    expect(MS_PER_DAY).toBe(86400000);
  });

  it('equals 24 * 60 * 60 * 1000', () => {
    expect(MS_PER_DAY).toBe(24 * 60 * 60 * 1000);
  });

  it('is used correctly: a 1-day offset expressed via MS_PER_DAY produces ageDays=1', () => {
    const now = nowMs();
    const bootstrappedAt = new Date(now - 1 * MS_PER_DAY).toISOString();
    writeLock(`version: 1\nbootstrapped-at: ${bootstrappedAt}\nplugin-version: 3.0.0\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.0.0',
      now,
    });
    expect(result.details.ageDays).toBe(1);
  });
});

// ── classifyVersionMismatch (#290) ────────────────────────────────────────────

describe('classifyVersionMismatch', () => {
  it('returns alert for major version mismatch (2.x.x vs 3.x.x)', () => {
    expect(classifyVersionMismatch('2.0.0', '3.0.0')).toBe('alert');
  });

  it('returns alert when lock has lower major (3.0.0 → 4.0.0)', () => {
    expect(classifyVersionMismatch('3.0.0', '4.2.1')).toBe('alert');
  });

  it('returns info for minor version mismatch only (3.1.0 vs 3.2.0)', () => {
    expect(classifyVersionMismatch('3.1.0', '3.2.0')).toBe('info');
  });

  it('returns info for patch-only mismatch (3.2.0 vs 3.2.1)', () => {
    expect(classifyVersionMismatch('3.2.0', '3.2.1')).toBe('info');
  });

  it('returns warn for non-parseable versions', () => {
    expect(classifyVersionMismatch('not-a-version', '3.0.0')).toBe('warn');
  });

  it('returns warn when current version is not parseable', () => {
    expect(classifyVersionMismatch('3.0.0', 'dev-build')).toBe('warn');
  });
});

// ── plugin_version field (#290) ───────────────────────────────────────────────

describe('checkBootstrapLockFreshness — plugin_version (#290)', () => {
  it('returns ok=true and severity=info when plugin-version matches current', () => {
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 3.2.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0',
    });
    expect(result.ok).toBe(true);
    expect(result.severity).toBe('info');
    expect(result.details.versionMismatch).toBe(false);
  });

  it('returns severity=info (not raised) for patch-only mismatch on a fresh lock', () => {
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 3.2.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.1',
    });
    // Patch mismatch → versionMismatchSeverity='info' → does not raise overall severity
    expect(result.severity).toBe('info');
    expect(result.details.versionMismatch).toBe(true);
    expect(result.details.versionMismatchSeverity).toBe('info');
  });

  it('returns severity=info for minor-only mismatch on a fresh lock', () => {
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 3.1.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0',
    });
    expect(result.severity).toBe('info');
    expect(result.details.versionMismatch).toBe(true);
    expect(result.details.versionMismatchSeverity).toBe('info');
  });

  it('returns severity=alert for major plugin-version mismatch (v2 lock vs v3 current)', () => {
    writeLock(
      `version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 2.0.0\n`
    );
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0',
    });
    expect(result.severity).toBe('alert');
    expect(result.ok).toBe(false);
    expect(result.details.versionMismatch).toBe(true);
    expect(result.details.versionMismatchSeverity).toBe('alert');
  });

  it('legacy lock without plugin-version: does NOT raise severity, sets legacyLock detail', () => {
    // Lock predates plugin-version field — backward compat (#290)
    writeLock(`version: 1\nbootstrapped-at: ${isoAgo(1)}\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0',
    });
    // Severity must NOT be raised to warn/alert for missing plugin-version
    expect(result.severity).toBe('info');
    expect(result.ok).toBe(true);
    expect(result.details.versionMismatch).toBe(false);
    expect(result.details.legacyLock).toMatch(/predates plugin-version/);
  });

  it('legacy lock without plugin-version and no currentPluginVersion: legacyLock is null', () => {
    // No currentPluginVersion provided — can't determine legacy drift
    writeLock(`version: 1\nbootstrapped-at: ${isoAgo(1)}\n`);
    const result = checkBootstrapLockFreshness({ repoRoot: sandbox });
    expect(result.details.legacyLock).toBeNull();
  });

  it('returns details.versionMismatchSeverity=null when versions match', () => {
    writeLock(`version: 1\nbootstrapped-at: ${isoAgo(1)}\nplugin-version: 3.2.0\n`);
    const result = checkBootstrapLockFreshness({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0',
    });
    expect(result.details.versionMismatchSeverity).toBeNull();
  });
});
