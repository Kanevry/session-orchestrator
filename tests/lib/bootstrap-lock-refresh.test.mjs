import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshBootstrapLock } from '@lib/bootstrap-lock-refresh.mjs';
import { parseBootstrapLock } from '@lib/bootstrap-lock-freshness.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

let sandbox;

function lockPath() {
  return join(sandbox, '.orchestrator', 'bootstrap.lock');
}

function writeLock(contents) {
  const dir = join(sandbox, '.orchestrator');
  mkdirSync(dir, { recursive: true });
  writeFileSync(lockPath(), contents);
}

function readLock() {
  return readFileSync(lockPath(), 'utf8');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'blrefresh-'));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

// ── provenance preservation (highest-value test) ──────────────────────────────

describe('refreshBootstrapLock — provenance preservation (#57)', () => {
  it('preserves every original line byte-for-byte; only refreshed-at + refreshed-plugin-version change', () => {
    const original =
      '# .orchestrator/bootstrap.lock\n' +
      'version: 1\n' +
      'tier: standard\n' +
      'archetype: node-minimal\n' +
      'timestamp: 2026-01-01T00:00:00.000Z\n' +
      'source: plugin-template\n' +
      'plugin-version: 3.0.0\n' +
      'bootstrapped-at: 2026-01-01T00:00:00.000Z\n';
    writeLock(original);

    const now = Date.parse('2026-02-15T12:00:00.000Z');
    const result = refreshBootstrapLock({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0',
      now,
    });

    expect(result.ok).toBe(true);
    expect(result.refreshedAt).toBe('2026-02-15T12:00:00.000Z');
    expect(result.refreshedPluginVersion).toBe('3.2.0');

    const originalLines = original.split('\n').filter((l) => l.length > 0);
    const afterLines = readLock().split('\n').filter((l) => l.length > 0);

    // Every ORIGINAL line is still present, untouched, in the same relative order.
    for (const line of originalLines) {
      expect(afterLines).toContain(line);
    }

    // Exactly two new lines were appended — nothing else changed.
    expect(afterLines.length).toBe(originalLines.length + 2);
    expect(afterLines).toContain('refreshed-at: 2026-02-15T12:00:00.000Z');
    expect(afterLines).toContain('refreshed-plugin-version: 3.2.0');
  });

  it('does not rewrite bootstrapped-at or plugin-version when refreshing', () => {
    writeLock('version: 1\ntier: fast\nbootstrapped-at: 2026-01-01T00:00:00.000Z\nplugin-version: 2.9.0\n');
    refreshBootstrapLock({ repoRoot: sandbox, currentPluginVersion: '3.1.0', now: Date.now() });

    const after = readLock();
    expect(after).toContain('bootstrapped-at: 2026-01-01T00:00:00.000Z');
    expect(after).toContain('plugin-version: 2.9.0');
  });
});

// ── missing / invalid lock refusal ────────────────────────────────────────────

describe('refreshBootstrapLock — missing/invalid-lock refusal (#57)', () => {
  it('refuses when repoRoot is not provided', () => {
    const result = refreshBootstrapLock({});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-or-invalid');
    expect(result.message).toMatch(/\/bootstrap( --retroactive)? first/);
  });

  it('refuses when the lock file does not exist — never fabricates a lock', () => {
    const result = refreshBootstrapLock({ repoRoot: sandbox, currentPluginVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-or-invalid');
    expect(existsSync(lockPath())).toBe(false);
  });

  it('refuses when the lock is missing the required tier field', () => {
    writeLock('version: 1\nbootstrapped-at: 2026-01-01T00:00:00.000Z\n');
    const result = refreshBootstrapLock({ repoRoot: sandbox, currentPluginVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-or-invalid');
  });

  it('refuses when the lock is missing the required version field', () => {
    writeLock('tier: standard\nbootstrapped-at: 2026-01-01T00:00:00.000Z\n');
    const result = refreshBootstrapLock({ repoRoot: sandbox, currentPluginVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-or-invalid');
  });

  it('refuses on a structurally empty lock file', () => {
    writeLock('');
    const result = refreshBootstrapLock({ repoRoot: sandbox, currentPluginVersion: '3.0.0' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('missing-or-invalid');
  });
});

// ── idempotency ────────────────────────────────────────────────────────────────

describe('refreshBootstrapLock — idempotency (#57)', () => {
  it('running twice replaces the two fields in place, never duplicating them', () => {
    writeLock('version: 1\ntier: deep\nbootstrapped-at: 2026-01-01T00:00:00.000Z\nplugin-version: 3.0.0\n');

    const first = refreshBootstrapLock({
      repoRoot: sandbox,
      currentPluginVersion: '3.1.0',
      now: Date.parse('2026-02-01T00:00:00.000Z'),
    });
    const second = refreshBootstrapLock({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0',
      now: Date.parse('2026-03-01T00:00:00.000Z'),
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.refreshedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(second.refreshedPluginVersion).toBe('3.2.0');

    const lines = readLock().split('\n').filter((l) => l.length > 0);
    const refreshedAtLines = lines.filter((l) => l.startsWith('refreshed-at:'));
    const refreshedPluginVersionLines = lines.filter((l) => l.startsWith('refreshed-plugin-version:'));

    expect(refreshedAtLines).toHaveLength(1);
    expect(refreshedPluginVersionLines).toHaveLength(1);
    expect(refreshedAtLines[0]).toBe('refreshed-at: 2026-03-01T00:00:00.000Z');
    expect(refreshedPluginVersionLines[0]).toBe('refreshed-plugin-version: 3.2.0');

    // Original provenance still untouched after two refreshes.
    expect(readLock()).toContain('bootstrapped-at: 2026-01-01T00:00:00.000Z');
    expect(readLock()).toContain('plugin-version: 3.0.0');
  });

  it('is safe to call without currentPluginVersion — writes refreshed-at only', () => {
    writeLock('version: 1\ntier: fast\nbootstrapped-at: 2026-01-01T00:00:00.000Z\n');
    const result = refreshBootstrapLock({ repoRoot: sandbox, now: Date.parse('2026-02-01T00:00:00.000Z') });
    expect(result.ok).toBe(true);
    expect(result.refreshedPluginVersion).toBeNull();
    expect(readLock()).not.toContain('refreshed-plugin-version:');
    expect(readLock()).toContain('refreshed-at: 2026-02-01T00:00:00.000Z');
  });
});

// ── CR/LF sanitization — defense-in-depth against forged lock-line injection ──

describe('refreshBootstrapLock — newline sanitization (defense-in-depth)', () => {
  it('strips embedded newlines from currentPluginVersion so a malformed value cannot inject a forged top-level key', () => {
    writeLock('version: 1\ntier: standard\nbootstrapped-at: 2026-01-01T00:00:00.000Z\n');

    const result = refreshBootstrapLock({
      repoRoot: sandbox,
      currentPluginVersion: '3.2.0\nversion: 999',
      now: Date.parse('2026-02-15T12:00:00.000Z'),
    });

    expect(result.ok).toBe(true);

    const after = readLock();
    const parsed = parseBootstrapLock(after);

    // The original version/tier fields are untouched — no forged top-level
    // key landed via the embedded newline in currentPluginVersion.
    expect(parsed['version']).toBe('1');
    expect(parsed['tier']).toBe('standard');

    // No standalone `version: 999` line was injected anywhere in the file.
    expect(after).not.toMatch(/^version: 999$/m);

    // The refreshed-plugin-version line carries the SANITIZED (newline-
    // stripped, concatenated) value — the raw payload is neutralized, not
    // silently dropped.
    expect(after).toContain('refreshed-plugin-version: 3.2.0version: 999');
    expect(result.refreshedPluginVersion).toBe('3.2.0version: 999');
  });

  it('produces a file with exactly one line per top-level key even when the injected payload spans multiple newlines', () => {
    writeLock('version: 1\ntier: deep\nbootstrapped-at: 2026-01-01T00:00:00.000Z\n');

    refreshBootstrapLock({
      repoRoot: sandbox,
      currentPluginVersion: 'evil\ntier: hacked\nversion: 999',
      now: Date.parse('2026-03-01T00:00:00.000Z'),
    });

    const after = readLock();
    const parsed = parseBootstrapLock(after);

    // tier/version keys still resolve to their ORIGINAL values — a
    // multi-newline payload cannot overwrite either via injected lines.
    expect(parsed['tier']).toBe('deep');
    expect(parsed['version']).toBe('1');
    expect(after).not.toMatch(/^tier: hacked$/m);
    expect(after).not.toMatch(/^version: 999$/m);
  });
});
