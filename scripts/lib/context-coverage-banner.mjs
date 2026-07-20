/**
 * context-coverage-banner.mjs — Session-start banner for issue #831 (building
 * block B4).
 *
 * Surfaces a `warn` banner during session-start Phase 4 when a REGISTERED
 * vault project — a `<vaultDir>/01-projects/<slug>/` directory that contains
 * an `_overview.md` — has neither a `context.md` nor a `_passive.md` file. A
 * manual audit found 11 such gap folders in one vault; this probe makes the
 * gap mechanically visible at session-start instead of relying on manual
 * sweeps.
 *
 * "Registered" is deliberately NOT reinvented here. `discoverVaultRepos()`
 * (`scripts/lib/gitlab-portfolio/vcs-detect.mjs`) already establishes the
 * exact convention this probe reuses: a `01-projects/<slug>/` directory
 * without an `_overview.md` is silently skipped — it is not a project, and
 * therefore it can never be a "gap".
 *
 * Design notes:
 *  - Mirrors the contract used by every other Phase 4 banner
 *    (`scripts/lib/vault-staleness-banner.mjs`, `scripts/lib/loop-readiness-banner.mjs`,
 *    `scripts/lib/reconcile-nudge-banner.mjs`): a single `checkXxx()` entry
 *    point that returns `null` (silent no-op) or `{ severity, message, ... }`
 *    — never an array, never `undefined`, never a throw.
 *  - Synchronous — the probe only touches `existsSync`/`readdirSync`/`statSync`,
 *    so unlike the async peer-cards/reconcile-nudge probes this one needs no
 *    `await` at the call site (mirrors `checkLoopReadiness`).
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
 *    `discoverVaultRepos()` does inline for the same reason.
 *
 * Cross-references:
 *  - `scripts/lib/gitlab-portfolio/vcs-detect.mjs` (`discoverVaultRepos`) —
 *    the canonical "registered" definition this probe reuses.
 *  - `scripts/lib/config/context-coverage.mjs` (`_parseContextCoverage`) —
 *    the `context-coverage:` Session Config block parser. NOT wired into
 *    `scripts/lib/config.mjs` by this module — the coordinator registers it
 *    separately. The exact lines to add there:
 *
 *      import { _parseContextCoverage } from './config/context-coverage.mjs';
 *      // ... later, alongside the other top-level block parses:
 *      const contextCoverage = _parseContextCoverage(mdContent);
 *      // ... in the returned config object:
 *      'context-coverage': contextCoverage,
 *
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site (wiring
 *    snippet supplied separately; this module does not edit that file).
 *  - Issue #831 (building block B4).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { expandTilde } from './common.mjs';

/** Vault-relative projects directory (mirrors discoverVaultRepos()'s own constant). */
const PROJECTS_SUBDIR = '01-projects';

/** File marking a `01-projects/<slug>/` directory as REGISTERED (discoverVaultRepos() convention). */
const OVERVIEW_FILE = '_overview.md';

/** Either file's presence satisfies "coverage" for a registered project. */
const COVERAGE_FILES = ['context.md', '_passive.md'];

/**
 * Above this many gap slugs, the message truncates the name list and says so
 * explicitly rather than silently dropping names past the limit.
 */
const MAX_GAP_NAMES_IN_MESSAGE = 20;

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
 * Format the gap-slug list for the banner message, truncating (with an
 * explicit note) past `MAX_GAP_NAMES_IN_MESSAGE`.
 *
 * @param {string[]} slugs
 * @returns {string}
 */
function _formatGapNames(slugs) {
  if (slugs.length <= MAX_GAP_NAMES_IN_MESSAGE) return slugs.join(', ');
  const shown = slugs.slice(0, MAX_GAP_NAMES_IN_MESSAGE).join(', ');
  const hiddenCount = slugs.length - MAX_GAP_NAMES_IN_MESSAGE;
  return `${shown}, and ${hiddenCount} more (name list truncated)`;
}

/**
 * Check context-coverage and produce a session-start banner.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — REQUIRED absolute path to the repo root.
 * @param {string} [opts.vaultDir] — test seam; overrides the config-resolved vault dir.
 * @param {object} [opts.config] — optional already-parsed Session Config (avoids
 *   a second CLAUDE.md (or AGENTS.md on Codex CLI) read; caller passes `$CONFIG`, mirrors `checkReconcileNudge`).
 *   Read keys: `config['context-coverage']` (`.enabled`, `.mode`) and
 *   `config['vault-integration']['vault-dir']`.
 * @returns {null | {severity: 'warn', message: string, gaps: Array<{slug: string}>, registered: number, covered: number}}
 */
export function checkContextCoverage({ repoRoot, vaultDir, config } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const cfg =
      config &&
      typeof config === 'object' &&
      config['context-coverage'] &&
      typeof config['context-coverage'] === 'object'
        ? config['context-coverage']
        : {};

    // Config gate — returns null BEFORE any filesystem I/O.
    if (cfg.enabled === false || cfg.mode === 'off') return null;

    const rawVaultDir = _resolveRawVaultDir(vaultDir, config);
    if (!rawVaultDir) return null;

    const resolvedVaultDir = expandTilde(rawVaultDir);
    const projectsDir = path.join(resolvedVaultDir, PROJECTS_SUBDIR);

    let entries;
    try {
      entries = readdirSync(projectsDir);
    } catch {
      return null;
    }
    if (!Array.isArray(entries) || entries.length === 0) return null;

    entries = [...entries].sort();

    let registered = 0;
    const gaps = [];

    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.startsWith('.')) continue;

      const entryPath = path.join(projectsDir, entry);

      let stat;
      try {
        stat = statSync(entryPath);
      } catch {
        continue;
      }
      if (!stat || !stat.isDirectory()) continue;

      // "Registered" is defined ELSEWHERE (discoverVaultRepos()) — a
      // directory lacking `_overview.md` is not a project, and therefore not
      // a gap. Do not invent a second definition here.
      let hasOverview = false;
      try {
        hasOverview = existsSync(path.join(entryPath, OVERVIEW_FILE));
      } catch {
        // best-effort — treat an unreadable path as "no _overview.md".
      }
      if (!hasOverview) continue;

      registered += 1;

      let isCovered = false;
      for (const file of COVERAGE_FILES) {
        try {
          if (existsSync(path.join(entryPath, file))) {
            isCovered = true;
            break;
          }
        } catch {
          // best-effort — treat an unreadable path as "not covered by this file".
        }
      }

      if (!isCovered) gaps.push({ slug: entry });
    }

    if (registered === 0 || gaps.length === 0) return null;

    const covered = registered - gaps.length;
    const gapSlugs = gaps.map((g) => g.slug);

    const finding = `${gaps.length} of ${registered} registered projects lack context.md and _passive.md`;
    const remediation = 'add a context.md or mark the project passive with _passive.md.';
    const message = `⚠ context-coverage: ${finding} — ${_formatGapNames(gapSlugs)} — ${remediation}`;

    return { severity: 'warn', message, gaps, registered, covered };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
