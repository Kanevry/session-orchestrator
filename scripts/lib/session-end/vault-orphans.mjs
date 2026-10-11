/**
 * vault-orphans.mjs - Phase 3.7e Vault Orphans (#1563).
 *
 * Lists the untracked files in the Meta-Vault that were modified since this
 * session started, so the closing session can NAME what it may have left
 * behind there.
 *
 * Why this exists (measured 2026-10-11): one vault checkout had accumulated 268
 * untracked files over five days - website audits, session reports, reviews,
 * lead handovers - written by sessions of OTHER repos into their configured
 * `vault-dir`. None of them was ever committed: a session's close commits only
 * in its own repo, and vault-mirror auto-commits only its own generator-marked
 * files (`scripts/lib/vault-mirror/auto-commit.mjs`). The writing session is the
 * only one that knows it wrote them, and nothing made it look.
 *
 * THE IRON RULE: this module PROPOSES, it never DISPOSES. Its only git
 * invocation is the read-only `ls-files --others --exclude-standard -z`. No
 * add, commit, rm, mv, clean, stash; no file is written, moved or deleted. The
 * vault is another repo with its own rules (PSA-003).
 *
 * The return field is named `candidates`, not `orphans`: mtime is a HINT, not
 * proof of ownership. A concurrent session of another repo may have written the
 * same file in the same window. The coordinator names them and records one Open
 * Question; it never acts on them.
 *
 * Three states, never two (a missing measurement must not look like zero):
 *   - `{ status: 'ok', total: 0 }`   - measured, nothing found
 *   - `{ status: 'ok', total: N }`   - measured, N candidates
 *   - `{ status: 'unavailable' }`    - could not measure (no vault dir, not a
 *                                      git repo, git failed). Never reported as
 *                                      "no orphans".
 *
 * Exclusion - what another writer already owns: any file whose first 4 KB
 * carries a `_generator: session-orchestrator-` frontmatter line. Census
 * 2026-10-11 @ 686e2c12 (`rg -n "GENERATOR_MARKER\s*=" scripts/`): four marker
 * values, all with that prefix - `vault-mirror@1` (40-learnings/, 50-sessions/,
 * monthly rollups), `vault-status-narrative@1` (01-projects/<slug>/
 * _session-narrative.md), `active-sessions@1` (01-projects/_active-sessions.md),
 * `gitlab-portfolio@1`. The match is line-anchored so a hand-written note that
 * merely QUOTES the marker in prose is still reported.
 *
 * There is deliberately NO blanket exclusion of `40-learnings/` / `50-sessions/`:
 * vault-mirror owns only the MARKED files there. `autoCommitVaultMirror` treats
 * an unmarked staged file in those dirs as an offender and skips its whole
 * commit, so an unmarked untracked file there is owned by nobody AND blocks the
 * mirror - the last thing to hide.
 *
 * Never throws. DI seams (#580-DI-001), synchronous like the Phase 4b sibling
 * ./worktree-orphan-sweep.mjs: `execFileFn` (default `execFileSync`) and
 * `statFn` (default `lstatSync` - a symlink is reported as itself, never
 * followed out of the vault). Every git call passes an args ARRAY, no shell
 * (#577 HARDEN-001).
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';

import { redactHomeDir } from '../common.mjs';

/** Upper bound on the returned `candidates` list; `total` still counts all. */
export const MAX_CANDIDATES = 200;

/** Bytes read per file for the generator check - same window as auto-commit.mjs. */
const HEAD_BYTES = 4096;

/** A frontmatter line naming one of this plugin's generators. */
const GENERATOR_LINE_RE = /^_generator:[ \t]*session-orchestrator-/m;

/**
 * Env vars that retarget git away from `-C <dir>`. An inherited `GIT_DIR` beats
 * `-C` (incident 2026-08-19), which here would list ANOTHER repo's untracked
 * files as vault candidates. Stripped for the one git call below.
 */
const REPO_REDIRECT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR'];

/**
 * Ceiling for git's NUL-separated path list: 16 MiB is ~150k paths at ~100
 * bytes. Past it, execFileSync throws ENOBUFS and the result is `unavailable`
 * (could not measure), never a silently cut list. Revisit if a vault ever
 * reports that reason.
 */
const LS_FILES_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * A vault on a hung network filesystem must not stall /close: past this the
 * call is killed and the result is `unavailable` (git-failed). 20k untracked
 * files took 0.46 s (2026-10-11), so 20 s is a hang, not a slow vault.
 */
const LS_FILES_TIMEOUT_MS = 20_000;

/** @param {string} absPath @returns {boolean} true when the head names one of our generators */
function isGeneratorOwned(absPath) {
  let fd;
  try {
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    return GENERATOR_LINE_RE.test(buf.subarray(0, n).toString('utf8'));
  } catch {
    // Unreadable -> not provably someone else's. This module only REPORTS, so
    // the safe direction is to show the file, not to hide it.
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * @param {string} reason
 * @param {string} [detail]
 * @returns {{status: 'unavailable', reason: string, detail?: string, candidates: []}}
 */
function unavailable(reason, detail) {
  return detail ? { status: 'unavailable', reason, detail, candidates: [] } : { status: 'unavailable', reason, candidates: [] };
}

/**
 * Find untracked vault files modified at or after `sinceMs`.
 *
 * @param {object} [opts]
 * @param {string} opts.vaultDir - Vault working-tree root (already tilde-expanded).
 * @param {number} opts.sinceMs - Session start, epoch ms. Files with an older
 *   mtime are not candidates.
 * @param {Function} [opts.execFileFn] - execFileSync seam: (file, args, options) => string.
 * @param {Function} [opts.statFn] - lstatSync seam: (absPath) => { mtimeMs, isFile() }.
 * @returns {{status: 'ok', candidates: Array<{path: string, mtimeMs: number}>,
 *   total: number, truncated: boolean, untracked: number}
 *   | {status: 'unavailable', reason: string, detail?: string, candidates: []}}
 *   `path` is vault-relative as git reports it. `total` counts every candidate,
 *   `candidates` holds at most MAX_CANDIDATES of them (sorted by path),
 *   `untracked` is everything git listed before the mtime and generator filters.
 */
export function findVaultOrphans({ vaultDir, sinceMs, execFileFn, statFn } = {}) {
  try {
    if (typeof vaultDir !== 'string' || vaultDir.trim() === '') return unavailable('no-vault-dir');
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return unavailable('invalid-since');

    const exec = typeof execFileFn === 'function' ? execFileFn : execFileSync;
    const stat = typeof statFn === 'function' ? statFn : lstatSync;
    const root = path.resolve(vaultDir);

    const env = { ...process.env };
    for (const key of REPO_REDIRECT_ENV) delete env[key];

    // -- THE ONLY GIT CALL - read-only --------------------------------------
    let out;
    try {
      out = exec('git', ['-C', root, 'ls-files', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8',
        env,
        maxBuffer: LS_FILES_MAX_BUFFER,
        timeout: LS_FILES_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const stderr = typeof err?.stderr === 'string' ? err.stderr : String(err?.stderr ?? '');
      const reason = /not a git repository/i.test(stderr) ? 'not-a-git-repo' : 'git-failed';
      const firstLine = redactHomeDir(stderr.split('\n').find((l) => l.trim() !== '') ?? err?.code ?? '');
      return unavailable(reason, typeof firstLine === 'string' ? firstLine.trim().slice(0, 200) : undefined);
    }
    if (typeof out !== 'string') return unavailable('git-failed', 'non-string git output');

    const untrackedPaths = out.split('\0').filter((p) => p !== '');

    // Cost is linear in the untracked count: one lstat per path, plus one 4 KB
    // read per path that passes the mtime filter (cheapest filter first). Fine
    // for the measured 268; revisit if a close reports more than ~10k untracked
    // files, where the per-file read would start to show in /close time.
    const all = [];
    for (const rel of untrackedPaths) {
      const abs = path.join(root, rel);
      let st;
      try {
        st = stat(abs);
      } catch {
        // Vanished between listing and stat (a concurrent writer moved it):
        // nothing left to name.
        continue;
      }
      const mtimeMs = Number(st?.mtimeMs);
      if (!Number.isFinite(mtimeMs) || mtimeMs < sinceMs) continue;
      if (typeof st.isFile === 'function' && st.isFile() && isGeneratorOwned(abs)) continue;
      all.push({ path: rel, mtimeMs });
    }

    all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      status: 'ok',
      candidates: all.slice(0, MAX_CANDIDATES),
      total: all.length,
      truncated: all.length > MAX_CANDIDATES,
      untracked: untrackedPaths.length,
    };
  } catch (err) {
    // Defensive catch-all - this probe must never throw into /close.
    return unavailable('internal-error', String(err?.message ?? err).slice(0, 200));
  }
}
