/**
 * worktree-cleanup.mjs — Phase 4a Auto-Promoted Worktree Cleanup helpers (#575 P3.2).
 *
 * Public API:
 *   - detectAutoPromotedWorktree(repoRoot, sessionId, opts): { wtPath, sessionId, branch, source } | null
 *   - isWorktreeClean(wtPath, opts): boolean
 *     (opts.execFileFn — injectable execFileSync seam for tests; #577 HARDEN-001)
 *   - PROMOTION_MARKER_RELPATH — repo-relative path of the promotion marker
 *     written by `enterWorktree()` (SSOT for the file location; the WRITER
 *     imports this constant from here, so writer and reader can never drift).
 *
 * Closes #575 — Epic #568 Phase 3.2 (Parallel-Aware Sessions Auto-Promoted Worktree Cleanup)
 * PRD: "Parallel-aware sessions" (#568; archived in the private Meta-Vault) §3 P3 Gherkin rows 2-3
 *
 * Lifted verbatim from skills/session-end/SKILL.md Phase 4a so that the helpers
 * are unit-testable and reusable (instruction-text → executable extraction).
 *
 * DI seam (#580-DI-001): this module uses a SYNCHRONOUS `opts.execFileFn`
 * (default `execFileSync`) because session-end Phase 4a runs in a synchronous
 * coordinator step. Its sibling helper `scripts/lib/memory-cleanup/worktree-sweep.mjs`
 * shares the same sync `execFileFn` seam; the autopilot worktree driver
 * (`scripts/lib/autopilot/worktree-pipeline.mjs`) deliberately uses an ASYNC
 * `opts.$` (zx) seam instead because `enterWorktree()` is async. The seams are
 * kept divergent on purpose — unifying them would break the sync/async boundary.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseSessionId } from '../session-id.mjs';

/**
 * Repo-relative location of the promotion marker `enterWorktree()` drops into
 * every worktree it creates. Deliberately inside `.orchestrator/` (the session
 * state dir) and deliberately WITHOUT any absolute path in its payload — the
 * source checkout is recorded as `repoPathHash()` so the file can be committed
 * or shipped without leaking the operator's filesystem layout.
 *
 * @type {string}
 */
export const PROMOTION_MARKER_RELPATH = path.join('.orchestrator', 'promoted-from.json');

/**
 * Read + shape-validate the promotion marker of a candidate worktree.
 *
 * Never throws: a missing file, a directory, unreadable permissions, invalid
 * JSON, or a payload of the wrong shape all mean "no marker" (→ legacy path).
 *
 * @param {string} repoRoot
 * @returns {{branch: string, source_session_id: string} & Record<string, unknown> | null}
 */
function readPromotionMarker(repoRoot) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path.join(repoRoot, PROMOTION_MARKER_RELPATH), 'utf8'));
  } catch {
    return null; // absent / unreadable / corrupt JSON — fall back to legacy detection
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof parsed.branch !== 'string' || parsed.branch.length === 0) return null;
  if (typeof parsed.source_session_id !== 'string' || parsed.source_session_id.length === 0) {
    return null;
  }
  return parsed;
}

/**
 * The marker path as git reports it in `status --porcelain` — always
 * forward-slashed, regardless of the host separator.
 * @type {string}
 */
const PROMOTION_MARKER_GIT_PATH = PROMOTION_MARKER_RELPATH.split(path.sep).join('/');

/**
 * True for the ONE porcelain line the promotion marker itself produces:
 * `?? .orchestrator/promoted-from.json`.
 *
 * Why this exists: in THIS repo `.gitignore` already lists
 * `.orchestrator/promoted-from.json` explicitly (`git check-ignore
 * .orchestrator/promoted-from.json` exits 0), so the marker never reaches
 * `git status --porcelain` here at all — this exemption is redundant
 * belt-and-braces for the repo that ships it. It earns its keep in CONSUMER
 * repos: `.orchestrator/` is commonly only PARTLY gitignored there
 * (`.orchestrator/metrics/*.jsonl`, `session.lock`, … but not the bare
 * directory, and not necessarily this file), and on a worktree whose branch
 * predates that ignore line being added, the marker would show up as an
 * untracked file and make every promoted worktree read "dirty" — turning the
 * Phase 4a clean path (auto-remove) into a permanent operator AUQ. Repos that
 * gitignore `.orchestrator/` wholesale never see the line at all. A third shape exists —
 * the directory untracked AND un-ignored, where git collapses everything into
 * one `?? .orchestrator/` line — and is deliberately NOT matched here:
 * discounting a whole directory could hide operator work, and such a worktree
 * is already dirty from the session's own `session.lock` / `STATE.md` writes
 * regardless of this marker.
 *
 * Deliberately narrow: ONLY the untracked (`??`) status of exactly this path is
 * ignored. A modified, staged, renamed or conflicted marker still counts as
 * dirty, and no other file under `.orchestrator/` is affected — this is our own
 * bookkeeping artefact, not operator work (PSA-003: we created it, so it is
 * ours to discount).
 *
 * @param {string} line - One `git status --porcelain` line.
 * @returns {boolean}
 */
function isUntrackedPromotionMarker(line) {
  if (!line.startsWith('?? ')) return false;
  const filePath = line.slice(3).trim().replace(/^"(.*)"$/, '$1');
  return filePath === PROMOTION_MARKER_GIT_PATH;
}

/**
 * Current branch of a worktree, or `null` when it cannot be determined
 * (git error, or a detached HEAD — `git branch --show-current` prints nothing).
 *
 * @param {Function} execFileFn
 * @param {string} repoRoot
 * @returns {string|null}
 */
function currentBranchOf(execFileFn, repoRoot) {
  try {
    const out = execFileFn('git', ['-C', repoRoot, 'branch', '--show-current'], {
      encoding: 'utf8',
    });
    const branch = String(out ?? '').trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Detect whether the given repoRoot is an auto-promoted sibling worktree
 * created by `enterWorktree()` during the Phase 0.5 PROMOTION_OFFER path.
 *
 * Two keys, tried in this order:
 *
 *  1. **Marker (primary).** `<repoRoot>/.orchestrator/promoted-from.json`,
 *     written by `enterWorktree()` at creation time. Accepted when the file
 *     parses, carries `branch` + `source_session_id`, and the worktree's
 *     current branch either MATCHES the recorded one or cannot be read at all.
 *     This is the only key that survives the #1069 process boundary: since
 *     #1069 the session that RUNS in the promoted worktree is a NEW session
 *     with its OWN id, and since #1067 the worktree sits on `so/<sourceId>` —
 *     so the current session's id appears in neither the directory name nor
 *     the branch, and key 2 below can never match. Recording the fact at
 *     creation time is what makes it re-derivable later.
 *  2. **Basename (legacy fallback).** `<basePath>/<main-repo-name>-<sessionId>/`
 *     against the CURRENT session id — still correct for worktrees created
 *     before the marker existed, and for the same-session case.
 *
 * Returns:
 *   { wtPath, sessionId, branch, source: 'marker'|'basename' } on match
 *   null on non-match (UUID session, non-promoted path, or git error)
 *
 * @param {string} repoRoot - Absolute path to the candidate worktree
 * @param {string} sessionId - Session ID (semantic or UUID)
 * @returns {{wtPath: string, sessionId: string, branch: string, source: 'marker'|'basename'} | null}
 */
export function detectAutoPromotedWorktree(repoRoot, sessionId, opts = {}) {
  // #577 HARDEN-001: execFileSync + args ARRAY (no shell) is structurally
  // injection-proof — repoRoot can never be interpreted as shell metacharacters.
  const execFileFn = opts.execFileFn ?? execFileSync;

  // --- Key 1: the marker written at creation time (session-id independent) ---
  const marker = readPromotionMarker(repoRoot);
  if (marker) {
    const current = currentBranchOf(execFileFn, repoRoot);
    // `current === null` (git unavailable / detached HEAD) is accepted: the
    // marker is written by exactly one code path, and the destructive step in
    // Phase 4a is gated separately by `isWorktreeClean()`, which fails CLOSED
    // on any git error. So an unverifiable branch can only ever route the
    // operator into the AUQ, never into an automatic removal.
    if (current === null || current === marker.branch) {
      return {
        wtPath: repoRoot,
        sessionId: marker.source_session_id,
        branch: marker.branch,
        source: 'marker',
      };
    }
  }

  // --- Key 2: legacy basename match against the CURRENT session id ---
  const parsed = parseSessionId(sessionId);
  if (!parsed || parsed.format !== 'semantic') return null; // UUID-format sessions are never auto-promoted

  // Derive the MAIN checkout root from `git worktree list --porcelain` (first entry).
  // Bug-fix (W3 T2 finding): the original logic compared `path.basename(repoRoot) === ${repoName}-${sessionId}`
  // where repoName WAS basename(repoRoot) itself — structurally impossible. The correct repo-name comes
  // from the main checkout (worktree list entry 0), not from the promoted worktree we're checking.
  let mainCheckoutRoot;
  try {
    const out = execFileFn('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
    });
    const lines = out.split('\n');
    const firstWorktreeLine = lines.find((l) => l.startsWith('worktree '));
    if (!firstWorktreeLine) return null;
    mainCheckoutRoot = firstWorktreeLine.slice('worktree '.length);
  } catch {
    return null; // not a git repo, treat as not promoted
  }

  // If repoRoot IS the main checkout, this session is NOT in an auto-promoted worktree.
  if (path.resolve(repoRoot) === path.resolve(mainCheckoutRoot)) return null;

  // Auto-promoted layout: <basePath>/<main-repo-name>-<sessionId>/
  // Where <basePath> = path.dirname(mainCheckoutRoot).
  const mainRepoName = path.basename(mainCheckoutRoot);
  const expectedBasename = `${mainRepoName}-${sessionId}`;
  const isPromotedPath = path.basename(repoRoot) === expectedBasename;

  if (isPromotedPath) {
    return { wtPath: repoRoot, sessionId, branch: parsed.branch, source: 'basename' };
  }
  return null;
}

/**
 * Determine whether the worktree at the given path is clean.
 *
 * A worktree is clean iff ALL three conditions hold:
 *   1. No uncommitted changes (`git status --porcelain` is empty)
 *   2. No untracked files (implicit in #1 — porcelain includes `??` entries),
 *      with ONE exception: the untracked promotion marker this module's own
 *      writer drops into the worktree (see isUntrackedPromotionMarker)
 *   3. No unpushed commits (`git status --short --branch` lacks `ahead`)
 *
 * On any git error, returns `false` (safer per PSA-003 — conservative default
 * means we never auto-remove a worktree we couldn't verify).
 *
 * @param {string} wtPath - Absolute path to the worktree
 * @returns {boolean}
 */
export function isWorktreeClean(wtPath, opts = {}) {
  // #577 HARDEN-001: execFileSync + args ARRAY (no shell) — wtPath cannot inject.
  const execFileFn = opts.execFileFn ?? execFileSync;
  try {
    const status = execFileFn('git', ['-C', wtPath, 'status', '--porcelain'], {
      encoding: 'utf8',
    });
    const significant = String(status ?? '')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0)
      // Our own promotion marker is not operator work — see
      // isUntrackedPromotionMarker() for why it must not count as dirty.
      .filter((l) => !isUntrackedPromotionMarker(l));
    if (significant.length > 0) return false; // dirty (modified, untracked, or staged)

    const branchStatus = execFileFn('git', ['-C', wtPath, 'status', '--short', '--branch'], {
      encoding: 'utf8',
    });
    if (branchStatus.match(/\bahead\b/)) return false; // unpushed

    return true;
  } catch {
    return false; // any error → treat as dirty (safer per PSA-003)
  }
}
