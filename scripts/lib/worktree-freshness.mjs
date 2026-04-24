/**
 * worktree-freshness.mjs — base-ref staleness guard for agent merge-back.
 *
 * Prevents the class of regression observed in sessions 2026-04-20 07:30 and
 * 09:00: coordinator commits to main while an agent's worktree is in-flight,
 * then the agent's merge-back silently overwrites those commits because its
 * base-ref was stale at dispatch time (issue #195).
 *
 * Pairs with the meta-persistence added to createWorktree in worktree.mjs.
 * Learning: worktree-base-ref-staleness.
 *
 * Stdlib-only, cross-platform, no zx.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKTREE_META_DIR } from './worktree.mjs';
import { pathMatchesPattern } from './hardening.mjs';

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DriftCommit
 * @property {string}   sha
 * @property {string}   subject
 * @property {string[]} files
 */

/**
 * @typedef {Object} FreshnessResult
 * @property {boolean}         fresh
 * @property {string|null}     baseSha
 * @property {string|null}     currentSha
 * @property {DriftCommit[]}   driftCommits
 * @property {string[]}        overlap
 * @property {'pass'|'warn'|'block'|'no-meta'} decision
 * @property {string}          message
 */

// ---------------------------------------------------------------------------
// Primary export
// ---------------------------------------------------------------------------

/**
 * Check whether the worktree's base-ref is still fresh relative to the target
 * branch. Uses the meta file written by createWorktree (issue #195) to
 * determine the sha captured at dispatch time.
 *
 * Decision rules:
 *   - Meta file missing or unreadable → 'no-meta' (defensive: fresh=false)
 *   - baseSha === currentSha          → 'pass'    (fresh=true)
 *   - Divergence, no scope overlap    → 'warn'    (fresh=false)
 *   - Divergence with scope overlap   → 'block'   (fresh=false)
 *
 * @param {Object}        opts
 * @param {string}        opts.suffix          Worktree suffix (key for meta file).
 * @param {string}        [opts.targetBranch='main']  Branch to compare against.
 * @param {string[]|null} [opts.agentScope=null]       Agent file scope; null skips overlap computation.
 * @param {string}        [opts.cwd=process.cwd()]     Repo root.
 * @returns {Promise<FreshnessResult>}
 */
export async function checkWorktreeBaseRefFresh({
  suffix,
  targetBranch = 'main',
  agentScope = null,
  cwd = process.cwd(),
} = {}) {
  // ------------------------------------------------------------------
  // 1. Read meta file — resolve path relative to `cwd` so the caller's
  //    repo root governs (consistent with the git commands below).
  // ------------------------------------------------------------------
  const metaPath = path.join(cwd, WORKTREE_META_DIR, `${suffix}.json`);
  let meta;

  try {
    const raw = await fs.readFile(metaPath, 'utf8');
    meta = JSON.parse(raw);
  } catch (err) {
    if (err instanceof SyntaxError) {
      return _noMeta(
        null,
        null,
        `meta file corrupted for '${suffix}': ${err.message}`
      );
    }
    // ENOENT or any other read error → no meta
    return _noMeta(
      null,
      null,
      `no meta for suffix '${suffix}' — cannot validate freshness`
    );
  }

  // Validate required fields
  if (!meta || typeof meta.baseSha !== 'string' || typeof meta.branch !== 'string') {
    return _noMeta(
      null,
      null,
      `meta file corrupted for '${suffix}': missing required fields (baseSha, branch)`
    );
  }

  const { baseSha } = meta;

  // ------------------------------------------------------------------
  // 2. Resolve current sha of target branch
  // ------------------------------------------------------------------
  let currentSha;
  try {
    currentSha = execFileSync('git', ['rev-parse', targetBranch], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    return _noMeta(
      baseSha,
      null,
      `no meta for suffix '${suffix}' — cannot validate freshness: failed to resolve '${targetBranch}': ${err.message}`
    );
  }

  // ------------------------------------------------------------------
  // 3. Fresh check
  // ------------------------------------------------------------------
  const sha7 = currentSha.slice(0, 7);

  if (baseSha === currentSha) {
    return {
      fresh: true,
      baseSha,
      currentSha,
      driftCommits: [],
      overlap: [],
      decision: 'pass',
      message: `base-ref fresh (${targetBranch} at ${sha7})`,
    };
  }

  // ------------------------------------------------------------------
  // 4. Compute drift commits: baseSha..currentSha
  // ------------------------------------------------------------------
  let driftCommits;
  try {
    driftCommits = _parseDriftLog(cwd, baseSha, currentSha);
  } catch {
    // Unknown sha / corrupt meta equivalent
    return _noMeta(
      baseSha,
      currentSha,
      `no meta for suffix '${suffix}' — cannot validate freshness: git log failed (baseSha '${baseSha}' may be unknown)`
    );
  }

  const n = driftCommits.length;

  // ------------------------------------------------------------------
  // 5. Overlap computation
  // ------------------------------------------------------------------
  if (agentScope === null || agentScope.length === 0) {
    return {
      fresh: false,
      baseSha,
      currentSha,
      driftCommits,
      overlap: [],
      decision: 'warn',
      message:
        `${targetBranch} advanced by ${n} commit${n === 1 ? '' : 's'} since worktree creation; ` +
        `no agent-scope overlap — coordinator review recommended`,
    };
  }

  // Collect all files touched in drift, deduplicated
  const driftFiles = _uniqueDriftFiles(driftCommits);

  const overlap = driftFiles.filter((file) =>
    agentScope.some((pat) => pathMatchesPattern(file, pat))
  );

  if (overlap.length > 0) {
    return {
      fresh: false,
      baseSha,
      currentSha,
      driftCommits,
      overlap,
      decision: 'block',
      message:
        `${targetBranch} advanced by ${n} commit${n === 1 ? '' : 's'} since worktree creation; ` +
        `overlap on ${overlap.join(', ')} — agent's copy would overwrite coordinator work`,
    };
  }

  return {
    fresh: false,
    baseSha,
    currentSha,
    driftCommits,
    overlap: [],
    decision: 'warn',
    message:
      `${targetBranch} advanced by ${n} commit${n === 1 ? '' : 's'} since worktree creation; ` +
      `no agent-scope overlap — coordinator review recommended`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a FreshnessResult for the no-meta / corrupt-meta / unresolvable case.
 *
 * @param {string|null} baseSha
 * @param {string|null} currentSha
 * @param {string}      message
 * @returns {FreshnessResult}
 */
function _noMeta(baseSha, currentSha, message) {
  return {
    fresh: false,
    baseSha,
    currentSha,
    driftCommits: [],
    overlap: [],
    decision: 'no-meta',
    message,
  };
}

/**
 * Run `git log --name-only` over the range baseSha..currentSha and parse
 * the output into an array of DriftCommit objects.
 *
 * Format: `%H%x00%s%x00` — NUL-separated sha + subject, followed by a blank
 * line, then the file list, then another blank line per commit.
 *
 * Throws if git exits non-zero (caller handles).
 *
 * @param {string} cwd
 * @param {string} baseSha
 * @param {string} currentSha
 * @returns {DriftCommit[]}
 */
function _parseDriftLog(cwd, baseSha, currentSha) {
  const raw = execFileSync(
    'git',
    ['log', '--name-only', `--pretty=format:%H%x00%s%x00`, `${baseSha}..${currentSha}`],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  const commits = [];
  let current = null;

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trimEnd();

    if (line.includes('\x00')) {
      // Header line: sha NUL subject NUL
      const parts = line.split('\x00');
      const sha = parts[0].trim();
      const subject = parts[1] ?? '';
      if (sha) {
        if (current !== null) {
          commits.push(current);
        }
        current = { sha, subject, files: [] };
      }
    } else if (line === '') {
      // Blank separator — flush current commit if pending
      if (current !== null) {
        commits.push(current);
        current = null;
      }
    } else if (current !== null && line.length > 0) {
      // File name line
      current.files.push(line);
    }
  }

  // Flush any trailing commit not followed by blank line
  if (current !== null) {
    commits.push(current);
  }

  return commits;
}

/**
 * Collect all unique file paths touched across drift commits.
 *
 * @param {DriftCommit[]} driftCommits
 * @returns {string[]}
 */
function _uniqueDriftFiles(driftCommits) {
  const seen = new Set();
  for (const commit of driftCommits) {
    for (const file of commit.files) {
      seen.add(file);
    }
  }
  return Array.from(seen);
}
