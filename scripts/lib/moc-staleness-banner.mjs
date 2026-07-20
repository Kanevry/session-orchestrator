/**
 * moc-staleness-banner.mjs — Session-start banner for issue #831 (building
 * block B2).
 *
 * Surfaces a `warn` banner during session-start Phase 4 when a Meta-Vault
 * MOC (map-of-content) index note — a `<vaultDir>/08-topics/*-moc.md` file —
 * has an `updated:` frontmatter older than a configurable threshold (default
 * 90 days). Nothing in this repo reads `08-topics/` before this module; it
 * is the first consumer.
 *
 * Design notes:
 *  - Mirrors the contract used by every other Phase 4 banner
 *    (`scripts/lib/peer-cards/staleness-banner.mjs`, `scripts/lib/vault-staleness-banner.mjs`,
 *    `scripts/lib/loop-readiness-banner.mjs`, `scripts/lib/reconcile-nudge-banner.mjs`,
 *    and sibling building block `scripts/lib/context-coverage-banner.mjs` — B4
 *    of this same issue): a single `checkXxx()` entry point that returns
 *    `null` (silent no-op) or `{ severity, message, ... }` — never an array,
 *    never `undefined`, never a throw.
 *  - Synchronous — the probe only touches `existsSync`/`readdirSync`/`readFileSync`,
 *    so unlike the async peer-cards/reconcile-nudge probes this one needs no
 *    `await` at the call site (mirrors `checkLoopReadiness` / `checkContextCoverage`).
 *  - Never throws. Wrapped in an outermost defensive `try/catch`; every
 *    individually-fallible filesystem call additionally gets its own inner
 *    bare (no-binding) catch with a one-line explanatory comment.
 *  - `vault-dir` resolution mirrors the host-local-override pattern used
 *    throughout the plugin (issue #653): an injected `opts.vaultDir` test
 *    seam wins, then `config['vault-integration']['vault-dir']`, else the
 *    probe silently no-ops (no vault configured — nothing to check).
 *  - The committed repo default for `vault-integration.vault-dir` is
 *    tilde-prefixed (`~/Projects/vault`) and is NOT pre-expanded anywhere
 *    upstream of this module — `expandTilde()` from `./common.mjs` is applied
 *    unconditionally before the first `path.join`, exactly as
 *    `checkContextCoverage()` does for the same reason.
 *  - A `*-moc.md` file whose `updated:` frontmatter is missing or
 *    unparseable is EXCLUDED, not reported stale — mirrors
 *    `scripts/lib/peer-cards/staleness-banner.mjs` (~L61-76): the corrective
 *    action there is "fix the frontmatter", not this banner's "refresh the
 *    `updated:` date" remediation hint. Gated via `Number.isFinite(days)`.
 *
 * Cross-references:
 *  - `scripts/lib/config/moc-staleness.mjs` (`_parseMocStaleness`) — the
 *    `moc-staleness:` Session Config block parser. NOT wired into
 *    `scripts/lib/config.mjs` by this module — the coordinator registers it
 *    separately. The exact lines to add there:
 *
 *      import { _parseMocStaleness } from './config/moc-staleness.mjs';
 *      // ... later, alongside the other top-level block parses:
 *      const mocStaleness = _parseMocStaleness(mdContent);
 *      // ... in the returned config object:
 *      'moc-staleness': mocStaleness,
 *
 *  - `scripts/lib/common.mjs` (`expandTilde`) — shared tilde-expansion helper.
 *  - `scripts/lib/context-coverage-banner.mjs` — sibling B4 building block for
 *    the same issue; this module mirrors its structure closely.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site (wiring
 *    snippet supplied separately; this module does not edit that file).
 *  - Issue #831 (building block B2).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'js-yaml';

import { expandTilde } from './common.mjs';

/** Vault-relative directory holding MOC (map-of-content) index notes. */
const MOC_SUBDIR = '08-topics';

/** Filename suffix that identifies a MOC note within `08-topics/`. */
const MOC_SUFFIX = '-moc.md';

/** Fallback staleness threshold (days) when config supplies none/invalid. */
const DEFAULT_THRESHOLD_DAYS = 90;

/** Matches a leading `---\n...\n---` YAML frontmatter fence. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Above this many stale filenames, the message truncates the name list and
 * says so explicitly rather than silently dropping names past the limit.
 */
const MAX_STALE_NAMES_IN_MESSAGE = 20;

/**
 * Resolve the vault directory to scan.
 *
 * Precedence: `opts.vaultDir` (test seam) > `config['vault-integration']['vault-dir']` > null.
 *
 * @param {string|undefined} vaultDir
 * @param {unknown} config
 * @returns {string|null} raw (not-yet-tilde-expanded) vault dir, or null when unresolvable
 */
function _resolveRawVaultDir(vaultDir, config) {
  if (typeof vaultDir === 'string' && vaultDir.length > 0) return vaultDir;

  if (config && typeof config === 'object') {
    const vaultIntegration = /** @type {Record<string, unknown>} */ (config)['vault-integration'];
    if (vaultIntegration && typeof vaultIntegration === 'object') {
      const raw = /** @type {Record<string, unknown>} */ (vaultIntegration)['vault-dir'];
      if (typeof raw === 'string' && raw.length > 0) return raw;
    }
  }

  return null;
}

/**
 * Read a single MOC file and compute whole days since its `updated:`
 * frontmatter field. Returns `NaN` (never throws) when the file cannot be
 * read, has no frontmatter fence, the YAML fails to parse, `updated` is
 * missing/non-string, or `updated` is not a parseable date — every one of
 * these cases is the caller's signal to EXCLUDE the file, not report it
 * stale.
 *
 * @param {string} filePath — absolute path to a `*-moc.md` file
 * @param {number} nowMs — epoch ms clock
 * @returns {number} whole days since `updated:`, or `NaN`
 */
function _readMocStalenessDays(filePath, nowMs) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return NaN;
  }

  const m = raw.match(FRONTMATTER_RE);
  if (!m) return NaN;

  let fm;
  try {
    fm = YAML.load(m[1]);
  } catch {
    return NaN;
  }

  if (!fm || typeof fm !== 'object' || Array.isArray(fm)) return NaN;

  // js-yaml's default schema auto-resolves an ISO-8601-shaped scalar (the
  // canonical `updated:` form) into a native `Date`, NOT a string — verified:
  // `YAML.load('updated: 2026-01-01T00:00:00Z').updated instanceof Date`.
  // Accept both shapes; anything else (missing, number, array, …) excludes.
  const rawUpdated = fm.updated;
  let updatedMs;
  if (rawUpdated instanceof Date) {
    updatedMs = rawUpdated.getTime();
  } else if (typeof rawUpdated === 'string') {
    updatedMs = Date.parse(rawUpdated);
  } else {
    return NaN;
  }
  if (!Number.isFinite(updatedMs)) return NaN;

  return Math.floor((nowMs - updatedMs) / 86_400_000);
}

/**
 * Format the stale-filename list for the banner message, truncating (with an
 * explicit note) past `MAX_STALE_NAMES_IN_MESSAGE`.
 *
 * @param {Array<{file: string, days: number}>} stale
 * @returns {string}
 */
function _formatStaleNames(stale) {
  const parts = stale.map((s) => `${s.file} (${s.days}d)`);
  if (parts.length <= MAX_STALE_NAMES_IN_MESSAGE) return parts.join(', ');
  const shown = parts.slice(0, MAX_STALE_NAMES_IN_MESSAGE).join(', ');
  const hiddenCount = parts.length - MAX_STALE_NAMES_IN_MESSAGE;
  return `${shown}, and ${hiddenCount} more (name list truncated)`;
}

/**
 * Check MOC staleness and produce a session-start banner.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — REQUIRED absolute path to the repo root.
 * @param {string} [opts.vaultDir] — test seam; overrides the config-resolved vault dir.
 * @param {Date|number} [opts.now] — injectable clock for deterministic tests.
 * @param {object} [opts.config] — optional already-parsed Session Config (avoids
 *   a second CLAUDE.md (or AGENTS.md on Codex CLI) read; caller passes `$CONFIG`, mirrors `checkContextCoverage`).
 *   Read keys: `config['moc-staleness']` (`.enabled`, `.mode`, `.thresholds.moc`)
 *   and `config['vault-integration']['vault-dir']`.
 * @returns {null | { severity: 'warn', message: string, stale: Array<{file: string, days: number}> }}
 */
export function checkMocStaleness({ repoRoot, vaultDir, now, config } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const cfg =
      config &&
      typeof config === 'object' &&
      config['moc-staleness'] &&
      typeof config['moc-staleness'] === 'object'
        ? config['moc-staleness']
        : {};

    // Config gate — returns null BEFORE any filesystem I/O. Explicit opt-in
    // required: `cfg.enabled` must be the literal `true`, not merely
    // truthy/absent. A config block that is entirely absent (or present
    // without an `enabled` key) must fail CLOSED, not open — see issue #831
    // fail-open regression (a config carrying `vault-integration.vault-dir`
    // but no `moc-staleness` block previously ran the probe unsolicited,
    // because `undefined !== false`).
    if (cfg?.enabled !== true || cfg?.mode === 'off') return null;

    const rawVaultDir = _resolveRawVaultDir(vaultDir, config);
    if (!rawVaultDir) return null;

    const resolvedVaultDir = expandTilde(rawVaultDir);
    const topicsDir = path.join(resolvedVaultDir, MOC_SUBDIR);

    if (!existsSync(topicsDir)) return null;

    let entries;
    try {
      entries = readdirSync(topicsDir);
    } catch {
      return null;
    }
    if (!Array.isArray(entries) || entries.length === 0) return null;

    entries = [...entries].sort();

    const mocFiles = entries.filter((f) => typeof f === 'string' && f.endsWith(MOC_SUFFIX));
    if (mocFiles.length === 0) return null;

    const nowMs =
      now instanceof Date
        ? now.getTime()
        : typeof now === 'number' && Number.isFinite(now)
          ? now
          : Date.now();

    const cfgThreshold =
      cfg.thresholds && typeof cfg.thresholds === 'object' ? cfg.thresholds.moc : undefined;
    const thresholdDays =
      typeof cfgThreshold === 'number' && Number.isFinite(cfgThreshold) && cfgThreshold > 0
        ? cfgThreshold
        : DEFAULT_THRESHOLD_DAYS;

    const stale = [];
    for (const file of mocFiles) {
      const filePath = path.join(topicsDir, file);
      let days;
      try {
        days = _readMocStalenessDays(filePath, nowMs);
      } catch {
        days = NaN;
      }
      // Missing/unparseable `updated:` is EXCLUDED, not reported stale.
      if (!Number.isFinite(days)) continue;
      if (days > thresholdDays) stale.push({ file, days });
    }

    if (stale.length === 0) return null;

    const subjectLabel = stale.length === 1 ? '1 MOC stale' : `${stale.length} MOCs stale`;
    const finding = `${subjectLabel} (>${thresholdDays} days)`;
    const remediation = 'review and refresh the `updated:` frontmatter.';
    const message = `⚠ moc-staleness: ${finding} — ${_formatStaleNames(stale)} — ${remediation}`;

    return { severity: 'warn', message, stale };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
