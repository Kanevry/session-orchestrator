/**
 * bootstrap-lock-freshness.mjs — #186
 * Validates .orchestrator/bootstrap.lock freshness + plugin-version drift.
 *
 * Plain-JS validation — no Zod dependency.
 * Never throws. Never mutates input.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal single-level YAML parser for .orchestrator/bootstrap.lock.
 * Returns an object with all key:value pairs found. Unknown fields are
 * preserved. Comment lines and blank lines are ignored. Values are trimmed.
 *
 * @returns {Record<string, string>}
 */
export function parseBootstrapLock(contents) {
  if (typeof contents !== 'string') return {};

  const result = {};
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

/**
 * Checks .orchestrator/bootstrap.lock for freshness and plugin-version drift.
 *
 * Tiered severity:
 *   info  — ageDays < 30 AND no version mismatch
 *   warn  — ageDays 30..89 OR version mismatch (but age < 90)
 *   alert — ageDays >= 90 OR bootstrappedAt unparseable OR lock missing
 *
 * Legacy lock support: if `bootstrapped-at` is absent, falls back to
 * `timestamp` (present in all pre-#186 locks). If both absent, severity=alert.
 *
 * @param {{repoRoot: string, currentPluginVersion?: string, now?: number}} opts
 * @returns {{ok: boolean, severity: 'info'|'warn'|'alert', message: string, details: object}}
 */
export function checkBootstrapLockFreshness({
  repoRoot,
  currentPluginVersion,
  now = Date.now(),
} = {}) {
  if (!repoRoot) {
    return {
      ok: false,
      severity: 'alert',
      message: 'bootstrap.lock: repoRoot not provided',
      details: { reason: 'missing-repoRoot' },
    };
  }

  const lockPath = join(repoRoot, '.orchestrator', 'bootstrap.lock');

  if (!existsSync(lockPath)) {
    return {
      ok: false,
      severity: 'alert',
      message: 'bootstrap.lock missing',
      details: { reason: 'missing' },
    };
  }

  let parsed;
  try {
    parsed = parseBootstrapLock(readFileSync(lockPath, 'utf8'));
  } catch {
    return {
      ok: false,
      severity: 'alert',
      message: 'bootstrap.lock: failed to read file',
      details: { reason: 'read-error' },
    };
  }

  // Fall back to legacy `timestamp` field for pre-#186 locks.
  const bootstrappedAt = parsed['bootstrapped-at'] || parsed['timestamp'] || null;
  const pluginVersion = parsed['plugin-version'] || null;

  let ageDays = null;
  if (bootstrappedAt) {
    const ts = Date.parse(bootstrappedAt);
    if (!Number.isNaN(ts)) {
      ageDays = Math.floor((now - ts) / 86400000);
    }
  }

  const versionMismatch =
    typeof currentPluginVersion === 'string' &&
    typeof pluginVersion === 'string' &&
    pluginVersion !== currentPluginVersion;

  let severity = 'info';
  if (versionMismatch) severity = 'warn';
  if (ageDays !== null && ageDays >= 30) severity = 'warn';
  if (ageDays !== null && ageDays >= 90) severity = 'alert';
  if (ageDays === null) severity = 'alert';

  return {
    ok: severity === 'info',
    severity,
    message: `bootstrap.lock: age=${ageDays ?? 'unknown'}d, plugin-version=${pluginVersion ?? 'unknown'} (current=${currentPluginVersion ?? 'unknown'})`,
    details: {
      ageDays,
      pluginVersion,
      currentPluginVersion: currentPluginVersion ?? null,
      bootstrappedAt,
      versionMismatch,
    },
  };
}
