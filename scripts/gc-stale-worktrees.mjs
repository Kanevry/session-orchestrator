/**
 * gc-stale-worktrees.mjs — garbage-collect orphaned autopilot worktrees.
 *
 * Discovers worktrees under ${os.tmpdir()}/so-worktrees/, cross-references
 * them against .orchestrator/metrics/sessions.jsonl, checks PID liveness,
 * and classifies each into one of four buckets:
 *
 *   kept          — referenced in sessions.jsonl (within 7 days) or live PID
 *   orphan-locked — lock file with a live PID → never touched
 *   orphan-young  — no reference, no live PID, age < 7 days (safety floor)
 *   orphan-stale  — no reference, no live PID, age >= 7 days → eligible for GC
 *
 * Default mode is --dry-run. Pass --apply to actually remove orphan-stale
 * worktrees.
 *
 * ADR-364 thin-slice item 4.
 *
 * Exports (for unit tests):
 *   main, discoverWorktrees, classifyWorktree, isPidAlive
 */

import fs from 'node:fs';
import fsP from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { validateWorkspacePath } from './lib/worktree/lifecycle.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKTREE_PREFIX = 'so-worktrees';
const BRANCH_PREFIX = 'so-worktree-';
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const META_SUBDIR = '.orchestrator/tmp/worktree-meta';
const SESSIONS_JSONL = '.orchestrator/metrics/sessions.jsonl';

// ---------------------------------------------------------------------------
// isPidAlive — mirrored from session-lock.mjs (do NOT import private fn)
// ---------------------------------------------------------------------------

/**
 * Check whether a PID corresponds to a live process on this host.
 * Returns true when the process exists (even if we lack kill permission).
 * Returns false when the process does not exist (ESRCH) or for invalid input.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    if (err.code === 'EPERM') return true; // process exists, we lack permission
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sessions reference loader
// ---------------------------------------------------------------------------

/**
 * Load all worktree-related strings from sessions.jsonl.
 * Returns a Set of lowercased strings (suffix, branch, wtPath substrings) that
 * appeared in session entries written within the last 7 days.
 *
 * Older entries (> 7 days) are not considered — only positive matches block GC.
 * Missing or unreadable file returns an empty Set.
 *
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function loadRecentSessionRefs(repoRoot) {
  const refs = new Set();
  const sessionsPath = path.join(repoRoot, SESSIONS_JSONL);

  let raw;
  try {
    raw = fs.readFileSync(sessionsPath, 'utf8');
  } catch {
    return refs;
  }

  const cutoff = Date.now() - STALE_THRESHOLD_MS;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Only consider recent entries (within 7 days).
    const entryDate = Date.parse(entry.completed_at ?? entry.started_at ?? '');
    if (Number.isFinite(entryDate) && entryDate < cutoff) continue;

    // Collect all string values that could reference a worktree.
    const candidate = JSON.stringify(entry).toLowerCase();
    refs.add(candidate);
  }

  return refs;
}

/**
 * Check whether a worktree entry is referenced in the session refs set.
 * Uses a tolerant string-contains check against the worktree's suffix, branch,
 * and wtPath.
 *
 * @param {{ suffix: string, branch: string, wtPath: string }} worktree
 * @param {Set<string>} sessionRefs
 * @returns {boolean}
 */
function isReferencedInSessions(worktree, sessionRefs) {
  const { suffix, branch, wtPath } = worktree;
  for (const candidate of sessionRefs) {
    if (
      candidate.includes(suffix.toLowerCase()) ||
      candidate.includes(branch.toLowerCase()) ||
      candidate.includes(wtPath.toLowerCase())
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lock file PID detection
// ---------------------------------------------------------------------------

/**
 * Attempt to find a PID from lock files inside or associated with a worktree.
 * Looks for .session-meta.json or *.lock files inside the worktree dir, and
 * also checks .orchestrator/tmp/ in the repo root for files referencing the
 * worktree suffix.
 *
 * Returns the PID if found, or null if none found / not parseable.
 *
 * @param {string} wtPath  Absolute path to the worktree directory.
 * @param {string} suffix  Worktree suffix.
 * @param {string} repoRoot
 * @returns {number|null}
 */
function findLockPid(wtPath, suffix, repoRoot) {
  // Check .session-meta.json inside the worktree.
  const candidates = [
    path.join(wtPath, '.session-meta.json'),
    path.join(wtPath, '.orchestrator', 'session.lock'),
    path.join(repoRoot, '.orchestrator', 'tmp', `${suffix}.json`),
    path.join(repoRoot, '.orchestrator', 'tmp', `${suffix}.lock`),
  ];

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(content);
      const pid = data.pid ?? data.session_pid ?? data.locked_by_pid ?? null;
      if (typeof pid === 'number' && Number.isFinite(pid)) {
        return pid;
      }
    } catch {
      // Not found or not parseable — try next candidate.
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// discoverWorktrees
// ---------------------------------------------------------------------------

/**
 * Discover all so-worktree-* directories under the worktrees root.
 *
 * Returns an array of raw descriptor objects with filesystem metadata. Does NOT
 * classify them — call classifyWorktree() on each.
 *
 * @param {object} [opts]
 * @param {string} [opts.worktreeRoot]  Override for os.tmpdir()/so-worktrees. Tests pass mock dirs.
 * @param {string} [opts.metaDir]       Override for .orchestrator/tmp/worktree-meta. Tests pass mock dirs.
 * @param {string} [opts.repoRoot]      Override for repo root (default: process.cwd()).
 * @returns {Array<{
 *   suffix: string,
 *   branch: string,
 *   wtPath: string,
 *   createdAt: Date|null,
 *   metaPresent: boolean,
 *   meta: object|null
 * }>}
 */
export function discoverWorktrees(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();
  const worktreeRoot = opts.worktreeRoot ?? path.join(os.tmpdir(), WORKTREE_PREFIX);
  const metaDir = opts.metaDir ?? path.join(repoRoot, META_SUBDIR);

  // Gracefully no-op if the worktrees root doesn't exist.
  let entries;
  try {
    entries = fs.readdirSync(worktreeRoot, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }

  const results = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const branch = entry.name;
    if (!branch.startsWith(BRANCH_PREFIX)) continue;

    const suffix = branch.slice(BRANCH_PREFIX.length);
    const wtPath = path.join(worktreeRoot, branch);

    // Determine creation time: prefer meta file createdAt, fall back to fs mtime.
    let createdAt = null;
    let metaPresent = false;
    let meta = null;

    const metaFilePath = path.join(metaDir, `${suffix}.json`);
    try {
      const metaRaw = fs.readFileSync(metaFilePath, 'utf8');
      meta = JSON.parse(metaRaw);
      metaPresent = true;
      if (meta.createdAt) {
        const parsed = new Date(meta.createdAt);
        if (!isNaN(parsed.getTime())) {
          createdAt = parsed;
        }
      }
    } catch {
      // Missing or unparseable meta — fall back to filesystem mtime.
    }

    if (!createdAt) {
      try {
        const stat = fs.statSync(wtPath);
        createdAt = stat.mtime;
      } catch {
        // Cannot stat — leave createdAt as null (treat as ancient for safety).
        createdAt = null;
      }
    }

    results.push({ suffix, branch, wtPath, createdAt, metaPresent, meta });
  }

  return results;
}

// ---------------------------------------------------------------------------
// classifyWorktree
// ---------------------------------------------------------------------------

/**
 * Classify a single worktree descriptor into one of the four GC buckets.
 *
 * @param {{
 *   suffix: string,
 *   branch: string,
 *   wtPath: string,
 *   createdAt: Date|null,
 *   metaPresent: boolean,
 *   meta: object|null
 * }} worktree
 * @param {Set<string>} sessionRefs  From loadRecentSessionRefs().
 * @param {string} repoRoot
 * @returns {{
 *   status: 'kept'|'orphan-locked'|'orphan-young'|'orphan-stale',
 *   reason: string,
 *   worktree: object,
 *   ageMs: number|null,
 *   pid: number|null
 * }}
 */
export function classifyWorktree(worktree, sessionRefs, repoRoot) {
  const { suffix, branch, wtPath, createdAt } = worktree;
  const ageMs = createdAt ? Date.now() - createdAt.getTime() : null;

  // 1. Check live PID in lock file.
  const pid = findLockPid(wtPath, suffix, repoRoot ?? process.cwd());
  if (pid !== null && isPidAlive(pid)) {
    return {
      status: 'orphan-locked',
      reason: `pid ${pid} alive`,
      worktree,
      ageMs,
      pid,
    };
  }

  // 2. Check references in sessions.jsonl.
  if (isReferencedInSessions({ suffix, branch, wtPath }, sessionRefs)) {
    const sessionId = findReferencingSession({ suffix, branch, wtPath }, sessionRefs);
    return {
      status: 'kept',
      reason: sessionId ? `referenced by ${sessionId}` : 'referenced in sessions.jsonl',
      worktree,
      ageMs,
      pid: null,
    };
  }

  // 3. Age check.
  const isStale = ageMs === null || ageMs >= STALE_THRESHOLD_MS;
  if (!isStale) {
    const days = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
    return {
      status: 'orphan-young',
      reason: `created ${days}d ago, no references (under 7-day floor — kept)`,
      worktree,
      ageMs,
      pid: null,
    };
  }

  const days = ageMs === null ? '?' : (ageMs / (24 * 60 * 60 * 1000)).toFixed(0);
  return {
    status: 'orphan-stale',
    reason: `created ${days}d ago, no references, no live pid`,
    worktree,
    ageMs,
    pid: null,
  };
}

/**
 * Find the session_id that first references this worktree (for display).
 * Returns null if none found or references are stored as bulk strings.
 *
 * @param {{ suffix: string, branch: string, wtPath: string }} worktree
 * @param {Set<string>} sessionRefs  Full JSON-stringified session entries.
 * @returns {string|null}
 */
function findReferencingSession(worktree, sessionRefs) {
  // sessionRefs contains full lowercased JSON blobs; parse back for session_id.
  // This is a best-effort display enhancement only.
  for (const candidate of sessionRefs) {
    if (
      candidate.includes(worktree.suffix.toLowerCase()) ||
      candidate.includes(worktree.branch.toLowerCase()) ||
      candidate.includes(worktree.wtPath.toLowerCase())
    ) {
      try {
        const obj = JSON.parse(candidate);
        return obj.session_id ?? null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Human-readable output
// ---------------------------------------------------------------------------

/**
 * Format an age in milliseconds to a human-readable string.
 * @param {number|null} ageMs
 * @returns {string}
 */
function formatAge(ageMs) {
  if (ageMs === null) return 'unknown age';
  const days = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h ago`;
  const mins = Math.floor(ageMs / (60 * 1000));
  return `${mins}m ago`;
}

/**
 * Print human-readable summary to stdout.
 *
 * @param {object} buckets  { kept, orphanLocked, orphanYoung, orphanStale }
 * @param {string[]} removed  Paths removed under --apply (empty in dry-run).
 * @param {boolean} isDryRun
 * @param {string} worktreeRoot
 */
function printHuman(buckets, removed, isDryRun, worktreeRoot) {
  const total =
    buckets.kept.length +
    buckets.orphanLocked.length +
    buckets.orphanYoung.length +
    buckets.orphanStale.length;

  process.stdout.write(`Found ${total} worktree(s) in ${worktreeRoot}\n`);

  if (buckets.kept.length > 0) {
    process.stdout.write(`  KEPT (${buckets.kept.length}):\n`);
    for (const r of buckets.kept) {
      process.stdout.write(`    ${r.worktree.branch} — created ${formatAge(r.ageMs)}, ${r.reason}\n`);
    }
  }

  if (buckets.orphanLocked.length > 0) {
    process.stdout.write(`  ORPHAN-LOCKED (${buckets.orphanLocked.length}):\n`);
    for (const r of buckets.orphanLocked) {
      process.stdout.write(`    ${r.worktree.branch} — ${r.reason}\n`);
    }
  }

  if (buckets.orphanYoung.length > 0) {
    process.stdout.write(`  ORPHAN-YOUNG (${buckets.orphanYoung.length}):\n`);
    for (const r of buckets.orphanYoung) {
      process.stdout.write(`    ${r.worktree.branch} — ${r.reason}\n`);
    }
  }

  if (buckets.orphanStale.length > 0) {
    process.stdout.write(`  ORPHAN-STALE (${buckets.orphanStale.length}):\n`);
    for (const r of buckets.orphanStale) {
      process.stdout.write(`    ${r.worktree.branch} — ${r.reason}\n`);
    }
  }

  if (isDryRun) {
    process.stdout.write(
      `\nDry-run mode. Use --apply to delete the ${buckets.orphanStale.length} stale orphan(s).\n`
    );
  } else {
    process.stdout.write(
      `\nApplied. Removed ${removed.length} of ${buckets.orphanStale.length} stale orphan(s).\n`
    );
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * Main entry point. Parses argv, discovers, classifies, and optionally removes
 * orphan-stale worktrees.
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv]          Override process.argv (tests).
 * @param {string} [opts.worktreeRoot]    Override os.tmpdir()/so-worktrees (tests).
 * @param {string} [opts.metaDir]         Override meta dir (tests).
 * @param {string} [opts.repoRoot]        Override repo root (tests).
 * @returns {Promise<0|1|2>}  Exit code.
 */
export async function main(opts = {}) {
  const argv = opts.argv ?? process.argv.slice(2);
  const repoRoot = opts.repoRoot ?? process.cwd();
  const worktreeRoot =
    opts.worktreeRoot ?? path.join(os.tmpdir(), WORKTREE_PREFIX);
  const metaDir = opts.metaDir ?? path.join(repoRoot, META_SUBDIR);

  // ---------------------------------------------------------------------------
  // Parse flags
  // ---------------------------------------------------------------------------

  let flagDryRun = false;
  let flagApply = false;
  let flagJson = false;
  let flagHelp = false;

  for (const arg of argv) {
    switch (arg) {
      case '--dry-run':
        flagDryRun = true;
        break;
      case '--apply':
        flagApply = true;
        break;
      case '--json':
        flagJson = true;
        break;
      case '--help':
      case '-h':
        flagHelp = true;
        break;
      default:
        process.stderr.write(`gc-stale-worktrees: unknown argument: ${arg}\n`);
        process.stderr.write(`Run with --help for usage.\n`);
        process.exit(1);
    }
  }

  if (flagHelp) {
    process.stdout.write(`gc-stale-worktrees.mjs — garbage-collect orphaned autopilot worktrees

USAGE
  node scripts/gc-stale-worktrees.mjs [--dry-run] [--apply] [--json] [--help]

FLAGS
  --dry-run   (default) Print classification; no filesystem mutations.
  --apply     Delete all orphan-stale worktrees. Requires explicit opt-in.
  --json      Emit machine-readable JSON to stdout.
  -h, --help  Show this help text and exit.

DESCRIPTION
  Discovers worktrees under \${os.tmpdir()}/so-worktrees/ and classifies each:

    kept          — referenced in sessions.jsonl (within 7 days) or live PID
    orphan-locked — has a lock file with a live PID; never touched
    orphan-young  — no reference, no live PID, age < 7 days (safety floor)
    orphan-stale  — no reference, no live PID, age >= 7 days → eligible for GC

  Only orphan-stale entries are removed under --apply.

EXIT CODES
  0 — success
  1 — user/input error (bad flags)
  2 — system error (unexpected exception)
`);
    return 0;
  }

  if (flagApply && flagDryRun) {
    process.stderr.write(`gc-stale-worktrees: --apply and --dry-run are mutually exclusive.\n`);
    process.stderr.write(`Run with --help for usage.\n`);
    process.exit(1);
  }

  // Default: dry-run if neither --apply nor --dry-run was given.
  const isDryRun = !flagApply;

  // ---------------------------------------------------------------------------
  // Discover + classify
  // ---------------------------------------------------------------------------

  const worktrees = discoverWorktrees({ worktreeRoot, metaDir, repoRoot });
  const sessionRefs = loadRecentSessionRefs(repoRoot);

  const buckets = {
    kept: [],
    orphanLocked: [],
    orphanYoung: [],
    orphanStale: [],
  };

  for (const wt of worktrees) {
    const result = classifyWorktree(wt, sessionRefs, repoRoot);
    switch (result.status) {
      case 'kept':
        buckets.kept.push(result);
        break;
      case 'orphan-locked':
        buckets.orphanLocked.push(result);
        break;
      case 'orphan-young':
        buckets.orphanYoung.push(result);
        break;
      case 'orphan-stale':
        buckets.orphanStale.push(result);
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Apply (if requested)
  // ---------------------------------------------------------------------------

  const removed = [];
  if (!isDryRun) {
    for (const r of buckets.orphanStale) {
      try {
        const isValid = validateWorkspacePath(r.worktree.wtPath, worktreeRoot);
        if (!isValid) {
          process.stderr.write(
            `gc-stale-worktrees: refusing to remove out-of-root path: ${r.worktree.wtPath}\n`
          );
          continue;
        }
        await fsP.rm(r.worktree.wtPath, { recursive: true, force: true });
        removed.push(r.worktree.wtPath);
      } catch (err) {
        process.stderr.write(
          `gc-stale-worktrees: failed to remove ${r.worktree.wtPath}: ${err.message}\n`
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------

  if (flagJson) {
    const output = {
      kept: buckets.kept.map((r) => ({
        branch: r.worktree.branch,
        suffix: r.worktree.suffix,
        wtPath: r.worktree.wtPath,
        ageMs: r.ageMs,
        reason: r.reason,
      })),
      orphanLocked: buckets.orphanLocked.map((r) => ({
        branch: r.worktree.branch,
        suffix: r.worktree.suffix,
        wtPath: r.worktree.wtPath,
        ageMs: r.ageMs,
        pid: r.pid,
        reason: r.reason,
      })),
      orphanYoung: buckets.orphanYoung.map((r) => ({
        branch: r.worktree.branch,
        suffix: r.worktree.suffix,
        wtPath: r.worktree.wtPath,
        ageMs: r.ageMs,
        reason: r.reason,
      })),
      orphanStale: buckets.orphanStale.map((r) => ({
        branch: r.worktree.branch,
        suffix: r.worktree.suffix,
        wtPath: r.worktree.wtPath,
        ageMs: r.ageMs,
        reason: r.reason,
      })),
      ...(flagApply ? { removed } : {}),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  } else {
    printHuman(buckets, removed, isDryRun, worktreeRoot);
  }

  return 0;
}

// ---------------------------------------------------------------------------
// CLI guard — prevents process.exit during test-time imports (#368)
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`gc-stale-worktrees: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
