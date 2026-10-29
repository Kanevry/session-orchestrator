/**
 * session-work-trees.mjs — which trees did a session commit in, and from which
 * start ref (#1659).
 *
 * `session-start-ref` names ONE sha in ONE tree. A coordinator that commits in
 * several of its own worktrees (`git -C <wt> commit`, `cd <wt> && git commit`,
 * subagents committing there) leaves those commits unattributed, and a ref from
 * a different tree is no fix: a two-dot diff across two trees lists foreign
 * files. hooks/pre-bash-staging-fence.mjs therefore records, before every
 * `git commit`, the pair `(tree, start_ref)` as an
 * `orchestrator.session.work_tree` event in the events ledger. This module is
 * the reader:
 *
 *  - {@link readSessionWorkTrees} — the session's trees, FIRST record per tree
 *    wins (the writer does not dedupe; every commit appends one record).
 *  - {@link sessionCommitFiles} — per tree `git diff --name-only <ref>..HEAD`
 *    INSIDE THAT TREE ONLY. A diff between two different trees is never
 *    computed.
 *
 * Neither function throws. Unreadable ledger lines are COUNTED, not silently
 * skipped (`.claude/rules/measurement-discipline.md` § Unlesbare JSONL-Zeilen
 * zaehlen); an unusable tree is reported `skipped` with a reason.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { readEventsWithRotations } from './events.mjs';
import { SESSION_WORK_TREE_EVENT } from './events-schema.mjs';
import { execFileSync } from './native-command.mjs';

/**
 * Events-ledger window for the #1401 census (`events-retention-banner.mjs`):
 * `null` — {@link readSessionWorkTrees} reads back to a session's FIRST
 * `orchestrator.session.work_tree` record, however old, so no day count bounds
 * it. A cut history loses that tree's first start_ref; the reader then takes
 * the oldest surviving record for it, which under-reports that tree (#1659).
 */
export const REQUIRED_EVENTS_WINDOW_DAYS = null;

/** Per-git-call timeout. A hung git must not hang a consumer (close, gate). */
const GIT_TIMEOUT_MS = 10_000;

/** Full sha, SHA-1 or SHA-256 object format. */
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Read the `(tree, start_ref)` pairs one session recorded.
 *
 * Only records whose `session_id` EQUALS `sessionId` (the raw harness id — a
 * dispatched subagent carries the coordinator's raw id, so its commits count
 * for the coordinator, as intended). The first record per `tree` wins, in
 * ledger order (rotated archives included, oldest first). A record of the
 * right event and session but with a missing/invalid `tree` or `start_ref` is
 * counted in `invalid`, never used.
 *
 * @param {object} args
 * @param {string} args.sessionId — raw session id to match.
 * @param {string} [args.eventsFile] — explicit active ledger path (wins over repoRoot).
 * @param {string} [args.repoRoot] — project root whose ledger is read; defaults
 *   like `eventsFilePath()` (`resolveEventsLedgerRoot()`).
 * @returns {{ trees: Array<{ tree: string, start_ref: string }>,
 *             malformed: number, invalid: number, complete: boolean|null,
 *             error?: string }}
 *   `malformed` = unreadable ledger lines (all sessions, the reader cannot
 *   attribute a line it cannot parse); `complete` mirrors
 *   `readEventsWithRotations` (`null` = no ledger found, NOT "no trees").
 */
export function readSessionWorkTrees({ sessionId, eventsFile, repoRoot } = {}) {
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return { trees: [], malformed: 0, invalid: 0, complete: null, error: 'sessionId missing' };
  }
  let read;
  try {
    read = readEventsWithRotations(repoRoot, eventsFile ? { filePath: eventsFile } : {});
  } catch (err) {
    return { trees: [], malformed: 0, invalid: 0, complete: null, error: String(err?.message ?? err) };
  }

  const seen = new Set();
  const trees = [];
  let invalid = 0;
  for (const rec of read.events) {
    if (rec?.event !== SESSION_WORK_TREE_EVENT || rec.session_id !== sessionId) continue;
    const { tree, start_ref: startRef } = rec;
    if (typeof tree !== 'string' || !path.isAbsolute(tree)
      || typeof startRef !== 'string' || !FULL_SHA_RE.test(startRef)) {
      invalid += 1;
      continue;
    }
    if (seen.has(tree)) continue; // first record per tree wins (#1659)
    seen.add(tree);
    trees.push({ tree, start_ref: startRef });
  }
  return { trees, malformed: read.malformed_lines, invalid, complete: read.complete };
}

/**
 * Run git with an argv array (no shell) and a timeout; never throws.
 *
 * @param {string[]} args
 * @returns {{ ok: true, stdout: string } | { ok: false, error: string }}
 */
function git(args) {
  try {
    const stdout = execFileSync('git', args, {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout };
  } catch (err) {
    const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : '';
    return { ok: false, error: stderr || String(err?.message ?? err) };
  }
}

/**
 * Files each tree's commits touched since that tree's own start ref.
 *
 * For every `{ tree, start_ref }`: `git -C <tree> diff --name-only
 * <start_ref>..HEAD`, run in THAT tree with THAT tree's ref — never a diff
 * between two trees. Paths are tree-relative, as git prints them; `union` is
 * the deduped, sorted union of those relative paths across trees (trees of the
 * same repo share a path space).
 *
 * A tree whose directory is gone, or whose ref no longer resolves there (gc'd,
 * different repo), lands in `skipped` with a reason — the caller decides what
 * an unmeasured tree means; it is never silently dropped and never throws.
 *
 * @param {{ trees: Array<{ tree: string, start_ref: string }> }} args
 * @returns {{ perTree: Array<{ tree: string, start_ref: string, files: string[] }>,
 *             skipped: Array<{ tree: string, start_ref: string, reason: string }>,
 *             union: string[] }}
 */
export function sessionCommitFiles({ trees } = {}) {
  const perTree = [];
  const skipped = [];
  const union = new Set();
  for (const entry of Array.isArray(trees) ? trees : []) {
    const tree = entry?.tree;
    const startRef = entry?.start_ref;
    if (typeof tree !== 'string' || typeof startRef !== 'string' || !FULL_SHA_RE.test(startRef)) {
      skipped.push({ tree: String(tree), start_ref: String(startRef), reason: 'invalid-entry' });
      continue;
    }
    if (!existsSync(tree)) {
      skipped.push({ tree, start_ref: startRef, reason: 'tree-missing' });
      continue;
    }
    const verify = git(['-C', tree, 'rev-parse', '--verify', '--quiet', `${startRef}^{commit}`]);
    if (!verify.ok) {
      skipped.push({ tree, start_ref: startRef, reason: 'ref-unresolvable' });
      continue;
    }
    const diff = git(['-C', tree, 'diff', '--name-only', `${startRef}..HEAD`]);
    if (!diff.ok) {
      skipped.push({ tree, start_ref: startRef, reason: `diff-failed: ${diff.error.split('\n')[0]}` });
      continue;
    }
    const files = diff.stdout.split('\n').filter((l) => l !== '');
    for (const f of files) union.add(f);
    perTree.push({ tree, start_ref: startRef, files });
  }
  return { perTree, skipped, union: [...union].sort() };
}
