/**
 * bootstrap-lock-freshness.mjs — #186 / #290 / #203
 * Validates .orchestrator/bootstrap.lock freshness + plugin-version drift.
 *
 * Plain-JS validation — no Zod dependency.
 * Never throws. Never mutates input.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Milliseconds in one day — extracted for readability + testability (#203). */
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
 * Reads the plugin version from package.json at the given plugin root.
 * Returns null if the file is absent or unparseable — never throws.
 *
 * @param {string} pluginRoot  Absolute path to the session-orchestrator plugin root.
 * @returns {string|null}
 */
export function readPluginVersionFromPackageJson(pluginRoot) {
  try {
    const pkgPath = join(pluginRoot, 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Classifies a version mismatch severity between two semver strings.
 *
 * Rules (#290):
 *   - major component differs → 'alert'
 *   - minor or patch only differs → 'info'
 *   - either string is not parseable semver → 'warn' (safe fallback)
 *
 * @param {string} lockVer    Version string from bootstrap.lock.
 * @param {string} currentVer Current plugin version.
 * @returns {'info'|'warn'|'alert'}
 */
export function classifyVersionMismatch(lockVer, currentVer) {
  // Simple semver: split on '.' and compare the major component.
  const parse = (v) => v.match(/^(\d+)\.(\d+)\.(\d+)/);
  const lm = parse(lockVer);
  const cm = parse(currentVer);
  if (!lm || !cm) return 'warn'; // not parseable — safe fallback
  if (lm[1] !== cm[1]) return 'alert'; // major mismatch
  return 'info'; // minor or patch only
}

/**
 * Checks .orchestrator/bootstrap.lock for freshness and plugin-version drift.
 *
 * Tiered severity:
 *   info  — ageDays < 30 AND (no version mismatch OR patch/minor-only mismatch)
 *   warn  — ageDays 30..89 OR non-parseable version mismatch
 *   alert — ageDays >= 90 OR bootstrappedAt unparseable OR lock missing
 *           OR major plugin-version mismatch
 *
 * Legacy lock support: if `bootstrapped-at` is absent, falls back to
 * `timestamp` (present in all pre-#186 locks). If both absent, severity=alert.
 *
 * Backward compat (#290): if the lock file predates the `plugin-version` field,
 * a soft informational message is added to details but severity is NOT raised.
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
      ageDays = Math.floor((now - ts) / MS_PER_DAY);
    }
  }

  // Backward compat (#290): lock predates plugin-version field — soft signal only.
  const legacyLockNoPluinVersion =
    typeof currentPluginVersion === 'string' && pluginVersion === null;

  let versionMismatch = false;
  let versionMismatchSeverity = null; // 'info' | 'warn' | 'alert' — null when no mismatch

  if (
    typeof currentPluginVersion === 'string' &&
    typeof pluginVersion === 'string' &&
    pluginVersion !== currentPluginVersion
  ) {
    versionMismatch = true;
    versionMismatchSeverity = classifyVersionMismatch(pluginVersion, currentPluginVersion);
  }

  let severity = 'info';

  // Age-based escalation.
  if (ageDays !== null && ageDays >= 30) severity = 'warn';
  if (ageDays !== null && ageDays >= 90) severity = 'alert';
  if (ageDays === null) severity = 'alert';

  // Version-mismatch escalation (only when mismatch detected).
  if (versionMismatch && versionMismatchSeverity === 'warn') {
    if (severity === 'info') severity = 'warn';
  }
  if (versionMismatch && versionMismatchSeverity === 'alert') {
    severity = 'alert';
  }
  // 'info'-classified mismatches (minor/patch) do NOT raise severity beyond
  // whatever age already determined.

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
      versionMismatchSeverity,
      legacyLock: legacyLockNoPluinVersion
        ? 'lock predates plugin-version field; consider /bootstrap --retroactive'
        : null,
    },
  };
}
