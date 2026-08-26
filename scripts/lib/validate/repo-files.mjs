/**
 * scripts/lib/validate/repo-files.mjs
 *
 * File enumeration for the `scripts/lib/validate/` scanners — TWO exports,
 * because the population a scanner needs genuinely splits in two:
 *
 *   listRepoFiles()   — what git TRACKS. The right default for any scanner
 *                       asking "what does this repository contain?".
 *   listOnDiskFiles() — what the filesystem HOLDS, minus a named exclusion
 *                       set. For the scanners whose oracle is deliberately
 *                       "exists on disk" — `check-untracked-test-deps.mjs`
 *                       states it outright: "untracked = ignored OR (exists on
 *                       disk AND not in git ls-files)". That check needs BOTH
 *                       halves and diffs them; collapsing them into one
 *                       enumerator would delete its subject.
 *
 * Why this module exists (#1143). A scanner that walks with `readdirSync`
 * cannot see `.gitignore`, so every gitignored artefact under a scan root
 * enters its census as if it were repository content. Two populations arrive
 * that way, and only the first is widely known:
 *
 *   1. A git worktree created inside the repo. This repo's own convention is
 *      `.claude/worktrees/<name>` (gitignored, `.gitignore:20`), which drops a
 *      COMPLETE second checkout into any root-anchored walk. Measured by
 *      `check-unwired-features.mjs` (see its EXCLUDED_DIRS comment) with one
 *      peer worktree present: +755 `.md` and +1209 `.mjs` files, 133 MB — and,
 *      worse than the cost, the peer's copy of a rule file was counted as an
 *      INDEPENDENT document, so a finding cited two sources where one exists.
 *
 *   2. Ordinary gitignored content, present with no worktree at all. Measured
 *      2026-08-26 on a clean checkout of this repo (`.claude/worktrees/` empty,
 *      `find .claude/worktrees -mindepth 1 | wc -l` → 0): the `.md` corpus of
 *      `check-doc-cli-commands.mjs` was 4 files wider on disk than in the index
 *      — `.claude/STATE.md` (per-session mutable state) and three
 *      `docs/specs/*.md` (gitignored design notes). So the exposure is LIVE,
 *      not merely latent on the worktree case.
 *
 * The index is also the cheaper oracle: one `git ls-files -z` beats a
 * recursive `readdirSync` over the same subtree, and it never descends into
 * `node_modules` at all.
 *
 * Both exports return ABSOLUTE paths, sorted, and never throw for a missing
 * directory (it contributes zero files). Symlinks are skipped in the walk —
 * following them can leave the root entirely, and a symlinked file is not
 * independent content.
 *
 * @module scripts/lib/validate/repo-files
 */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Environment handed to `git`. An allowlist rather than `process.env`: an
 * inherited `GIT_DIR` / `GIT_WORK_TREE` (set by any hook that spawned us)
 * would silently re-point `ls-files` at a DIFFERENT repository, and the
 * result would look like a plausible file list. Same allowlist as
 * `check-banner-parity.mjs`, whose enumeration pattern this lifts.
 */
const GIT_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']);

/**
 * Directory names excluded from every filesystem walk in this module.
 *
 * `worktrees` is the #1143 entry and is here for a MEASURED reason, not by
 * analogy to `node_modules` (see the module header). The other four are the
 * usual generated/vendored trees; excluding them is what makes the walk
 * fallback comparable in cost to the `ls-files` path it replaces.
 *
 * NOT exhaustive by intent: this is the exclusion set for a walk that has
 * already lost `.gitignore`. The fix for a new gitignored tree is to use
 * `listRepoFiles()`, not to grow this list.
 */
export const EXCLUDED_DIRS = Object.freeze([
  'node_modules',
  '.git',
  'worktrees',
  'dist',
  'coverage',
]);

/**
 * `realpathSync` that degrades to its input. Used only to compare two paths
 * for identity, where an unresolvable path can never equal a resolvable one.
 * @param {string} target
 * @returns {string}
 */
function safeRealpath(target) {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** @returns {NodeJS.ProcessEnv} the allowlisted git environment */
function gitEnv() {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

/**
 * True when `root` is the top level of a git working tree — the precondition
 * for trusting `git ls-files` to describe it.
 *
 * The realpath comparison is load-bearing: inside a SUBDIRECTORY of a repo
 * (or inside a worktree of one), `rev-parse --show-toplevel` succeeds and
 * names a DIFFERENT directory, and `ls-files` run there would enumerate a
 * corpus that is not the caller's root.
 *
 * @param {string} root absolute path
 * @param {NodeJS.ProcessEnv} [env] allowlisted git environment (default: {@link gitEnv})
 * @returns {boolean}
 */
export function isGitToplevel(root, env = gitEnv()) {
  try {
    const toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    }).trim();
    return Boolean(toplevel) && safeRealpath(toplevel) === safeRealpath(root);
  } catch {
    return false; // not a git checkout, or no git binary
  }
}

/**
 * Normalise the `exts` option into a predicate.
 * @param {string[] | null | undefined} exts
 * @returns {(absolute: string) => boolean}
 */
function extFilter(exts) {
  if (!exts || exts.length === 0) return () => true;
  const set = new Set(exts.map((e) => (e.startsWith('.') ? e : `.${e}`)));
  return (absolute) => set.has(path.extname(absolute));
}

/**
 * Recursive `readdirSync` walk under `absDir`.
 *
 * Defensive by design: an unreadable sub-directory is skipped rather than
 * thrown, so one bad entry never aborts a whole census. A directory whose
 * basename is in `exclude` is not descended into.
 *
 * @param {string} absDir
 * @param {(absolute: string) => boolean} matches
 * @param {Set<string>} exclude directory BASENAMES to skip
 * @param {string[]} acc
 * @returns {string[]}
 */
function walk(absDir, matches, exclude, acc = []) {
  let entries;
  try {
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return acc;
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    // A symlink can leave the root entirely, and a symlinked file is not
    // independent content — skip both directions.
    if (entry.isSymbolicLink()) continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      if (exclude.has(entry.name)) continue;
      walk(full, matches, exclude, acc);
      continue;
    }
    if (entry.isFile() && matches(full)) acc.push(full);
  }
  return acc;
}

/**
 * Resolve the `dirs` option to absolute directories under `root`.
 * `'.'` (or an empty list) means the root itself.
 * @param {string} root
 * @param {string[] | undefined} dirs
 * @returns {string[]}
 */
function resolveDirs(root, dirs) {
  if (!dirs || dirs.length === 0) return [root];
  return dirs.map((d) => (d === '.' ? root : path.join(root, d)));
}

/**
 * Files git TRACKS under `dirs` — the repository's own account of its content.
 *
 * `git ls-files` is authoritative and honours `.gitignore` for free. When
 * `root` is not the top level of a git checkout (a tarball export, a tmpdir
 * fixture, a vendored copy), this falls back to a filesystem walk carrying the
 * SAME exclusion set as {@link listOnDiskFiles} — a fallback that walked
 * naively would reintroduce the exact bug this function exists to remove.
 *
 * @param {string} root absolute repository root
 * @param {{dirs?: string[], exts?: string[] | null}} [options]
 *   `dirs` repo-relative directories to scan (default: the whole root);
 *   `exts` extensions to keep, with or without the dot (default: every file).
 * @returns {string[]} absolute paths, sorted, deduplicated
 */
export function listRepoFiles(root, options = {}) {
  const { dirs, exts = null } = options;
  const matches = extFilter(exts);
  const env = gitEnv();

  if (isGitToplevel(root, env)) {
    const pathspecs = dirs && dirs.length > 0 ? dirs.filter((d) => d !== '.') : [];
    try {
      const out = execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
        env,
      });
      return out
        .split('\0')
        .filter(Boolean)
        .map((rel) => path.join(root, rel))
        .filter(matches)
        // A tracked path can be absent from the working tree (sparse checkout,
        // a deletion staged elsewhere). A scanner that then read it would
        // report a tool-error for a file nobody removed.
        .filter((absolute) => {
          try {
            return statSync(absolute).isFile();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      // fall through to the walk — a git that answered rev-parse but failed
      // ls-files leaves us with no index to trust.
    }
  }

  const exclude = new Set(EXCLUDED_DIRS);
  const found = new Set();
  for (const dir of resolveDirs(root, dirs)) {
    for (const file of walk(dir, matches, exclude)) found.add(file);
  }
  return [...found].sort();
}

/**
 * Files the FILESYSTEM holds under `dirs`, minus {@link EXCLUDED_DIRS}.
 *
 * Use this only when "exists on disk" is genuinely the oracle — i.e. when the
 * point is to find files git does NOT track. Every other scanner wants
 * {@link listRepoFiles}.
 *
 * @param {string} root absolute repository root
 * @param {{dirs?: string[], exts?: string[] | null, exclude?: string[]}} [options]
 *   `exclude` REPLACES the default exclusion set when given; pass
 *   `[...EXCLUDED_DIRS, 'extra']` to extend it rather than to swap it.
 * @returns {string[]} absolute paths, sorted, deduplicated
 */
export function listOnDiskFiles(root, options = {}) {
  const { dirs, exts = null, exclude = EXCLUDED_DIRS } = options;
  const matches = extFilter(exts);
  const excludeSet = new Set(exclude);
  const found = new Set();
  for (const dir of resolveDirs(root, dirs)) {
    for (const file of walk(dir, matches, excludeSet)) found.add(file);
  }
  return [...found].sort();
}
