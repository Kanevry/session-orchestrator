/**
 * scripts/lib/validate/enumerate-repo-files.mjs
 *
 * ONE enumerator for the scanners whose question is **"does this file exist in
 * the repository right now?"** — GitLab #1248.
 *
 * ## The three populations, and why this is a third one
 *
 * `./repo-files.mjs` already answers two questions, and this module answers a
 * third rather than duplicating either:
 *
 *   | function                    | population                                          |
 *   |-----------------------------|-----------------------------------------------------|
 *   | `listRepoFiles()`           | what git TRACKS — "will ship / is versioned"        |
 *   | `listOnDiskFiles()`         | what the filesystem HOLDS minus a name list         |
 *   | `enumerateRepoFiles()` here | **exists under these roots, tracked or not, minus what `.gitignore` excludes** |
 *
 * Pick deliberately. A scanner asking "is this file versioned / will it ship?"
 * (a packaging check, a tarball manifest) MUST keep `listRepoFiles()`. A
 * scanner asking "is this file PRESENT, so is the citation pointing at it
 * dead?" belongs here — for it, the index is the wrong oracle.
 *
 * ## Why the index is the wrong oracle for an existence check (#1248)
 *
 * MEASURED in a clone (Wave-1 D6, 2026-09-06): an UNTRACKED
 * `skills/zz-probe/SKILL.md` citing `scripts/does-not-exist.mjs` made
 * `check-skill-script-paths.mjs` report `1 passed, 0 failed` BEFORE
 * `git add -A` and `0 passed, 1 failed` AFTER — same working tree, same
 * defect, no edit in between. The moment a defect is most likely to exist (a
 * brand-new, not-yet-staged skill or checker) is exactly the moment the index
 * cannot see it, so the check reports clean on the tree that carries the bug.
 * `.claude/rules/measurement-discipline.md` § "A `git grep` drift sweep cannot
 * see untracked files" is the same incident class on the release sweep.
 *
 * ## Why NOT a bare `readdirSync` walk
 *
 * The naive repair — swap `git ls-files` for a filesystem walk with a fixed
 * prune list — reintroduces the MEASURED regression #1143 that put
 * `repo-files.mjs` there in the first place: a walk cannot see `.gitignore`,
 * so a gitignored worktree under `.claude/worktrees/<name>` drops a COMPLETE
 * second checkout into the census (measured with one peer worktree present:
 * +755 `.md`, +1209 `.mjs`, 133 MB, and a peer's copy of a rule file counted
 * as an independent document). MEASURED here 2026-09-06 @ `befdda47` on a
 * clean tree with `.claude/worktrees/` empty:
 *
 *     git ls-files                          -- skills commands agents docs → 287 .md
 *     git ls-files --cached --others
 *                  --exclude-standard       -- (same dirs)                 → 287 .md
 *     listOnDiskFiles() walk, EXCLUDED_DIRS -- (same dirs)                 → 290 .md
 *
 * The 3-file surplus of the walk is entirely gitignored content
 * (`docs/specs/2026-04-04-plan-skill-design.md`,
 * `docs/specs/2026-04-16-bootstrap-gate-design.md`,
 * `docs/specs/2026-05-26-parallel-aware-sessions-design.md`) — private design
 * notes that would enter the census as if they were repository documentation.
 * So the oracle is `--cached --others --exclude-standard`: it sees the
 * untracked file #1248 is about AND honours `.gitignore`, which no prune list
 * can approximate.
 *
 * ## The failure contract: absent is not unreadable (#1248 follow-up)
 *
 * The population above is "exists under these roots". Deciding whether a path
 * EXISTS costs one `statSync`, and that `statSync` can fail for two
 * fundamentally different reasons which an earlier version of this module
 * collapsed into one bare `catch { continue }`:
 *
 *   | stat error                        | what it means                                   | this module |
 *   |-----------------------------------|-------------------------------------------------|-------------|
 *   | `ENOENT`                          | git lists it, the checkout lacks it — sparse checkout, a deletion staged elsewhere | SKIP (contributes zero files) |
 *   | `ENOTDIR`                         | a parent component is a file, so the path cannot exist either | SKIP (same class) |
 *   | `EACCES` / `EPERM`                | the file EXISTS; this process may not look at it | THROW {@link RepoEnumerationError} |
 *   | `ELOOP` / `EIO` / `ENAMETOOLONG` / anything else | the answer is unknown              | THROW {@link RepoEnumerationError} |
 *
 * The skip set is deliberately the same two codes `listRepoFiles()` documents
 * in its own filter comment ("a tracked path can be absent from the working
 * tree"), narrowed from a catch-all to exactly the codes that mean ABSENT.
 * Every other code means the enumerator does not know whether the file is
 * there, and a census that silently omits a file it could not look at reports
 * a SMALLER population than the truth — with no signal that it did.
 *
 * That silence had a measured consequence. `collectDriftHits()` in
 * `scripts/release.mjs` sweeps every enumerated file for the previous release
 * literal; with `README.md` unreadable, the swallow made the sweep read ZERO
 * files, return `status 1` ("no match"), and `evaluateDriftSweep()` reported
 * `ok: true` — a release gate passing on a file it could not open. Fail-closed
 * is one line there, and it was already written:
 *
 *     } catch (err) {
 *       return { status: 128, stdout: '', stderr: `enumerateRepoFiles failed: ${err && err.message}` };
 *
 * (`scripts/release.mjs:576-578`; `evaluateDriftSweep` maps any status outside
 * {0,1} to `ok: false` — "sweep is inconclusive".) So THROWING is what turns
 * an unreadable file into an inconclusive sweep instead of a clean one.
 *
 * NAMED CEILING (BV-004): only the git path fails closed. The non-git fallback
 * walks through `listOnDiskFiles()`, whose `readdirSync` walk skips an
 * unreadable sub-tree by design and cannot report it — see
 * {@link enumerateRepoFiles}. Revisit trigger: the first consumer that needs
 * fail-closed enumeration on a NON-git root (a tarball export, a vendored
 * copy); the answer then is an error-collecting walk in `repo-files.mjs`, not
 * a second stat pass here.
 *
 * ## NAMED CEILING (BV-004)
 *
 * The `prune` list is a fixed set of path segments / repo-relative prefixes,
 * NOT a `.gitignore` parser — it is only load-bearing on the FALLBACK path
 * (a root that is not a git top level: a tarball export, a vendored copy, a
 * tmpdir fixture). On the primary path git already applies the real ignore
 * rules and the prune list is a cheap second filter. REVISIT if a scanner
 * ever needs this on a non-git root whose ignored trees are not covered by
 * the default prune set — then reach for a real ignore parser, do not grow
 * this list a sixth time.
 *
 * @module scripts/lib/validate/enumerate-repo-files
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';

import { EXCLUDED_DIRS, isGitToplevel, listOnDiskFiles } from './repo-files.mjs';

/**
 * Environment handed to `git`. An allowlist rather than `process.env`: an
 * inherited `GIT_DIR` / `GIT_WORK_TREE` (set by any hook that spawned us)
 * would silently re-point `ls-files` at a DIFFERENT repository, and the result
 * would look like a plausible file list. Same allowlist as
 * `repo-files.mjs`, which is not exported there.
 */
const GIT_ENV_ALLOWLIST = Object.freeze(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TZ']);

/**
 * Path segments (or repo-relative path prefixes) never enumerated — reused
 * from `repo-files.mjs` rather than retyped, so an addition there reaches this
 * module too.
 *
 * Deliberately NOT extended with this repo's own ignored trees
 * (`.orchestrator/tmp/`, `.claude/worktrees/`): on the primary path `git` has
 * already applied the real ignore rules — measured, `.orchestrator/tmp/` is
 * `.gitignore:122` — so such an entry would be dead weight there, and naming
 * an untracked path in a module a test imports is itself a finding
 * (`check-untracked-test-deps.mjs` R2). A caller scanning a NON-git root whose
 * ignored subtree a basename cannot express passes it via `prune` instead —
 * that is what the prefix form is for.
 */
export const DEFAULT_PRUNE = EXCLUDED_DIRS;

/**
 * `stat` error codes that mean the path is ABSENT from the working tree, and
 * are therefore skipped rather than raised. See the module header's failure
 * table for why the set is exactly these two and not a catch-all.
 */
const ABSENT_STAT_CODES = Object.freeze(new Set(['ENOENT', 'ENOTDIR']));

/**
 * Raised when a path git listed could not be RESOLVED — the file may well be
 * there and this process could not look at it (`EACCES`, `EPERM`, `ELOOP`,
 * `EIO`, …). Callers are expected to fail closed on it: an enumeration that
 * threw describes no population at all.
 *
 * @property {string} code the underlying `stat` error code (`EACCES`, …)
 * @property {string} path the absolute path that could not be resolved
 */
export class RepoEnumerationError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, path?: string, cause?: unknown}} details
   */
  constructor(message, { code, path: target, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'RepoEnumerationError';
    this.code = code;
    this.path = target;
  }
}

/**
 * True when `relative` (POSIX, repo-relative) is inside a pruned tree.
 * A prune entry matches either a whole path SEGMENT (`node_modules`) or a
 * repo-relative path PREFIX (`.orchestrator/tmp`).
 *
 * @param {string} relative repo-relative POSIX path
 * @param {string[]} prune
 * @returns {boolean}
 */
function isPruned(relative, prune) {
  const segments = relative.split('/');
  for (const entry of prune) {
    if (entry.includes('/')) {
      if (relative === entry || relative.startsWith(`${entry}/`)) return true;
    } else if (segments.includes(entry)) {
      return true;
    }
  }
  return false;
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
 * Normalise `exts` into a predicate over an absolute path.
 * @param {string[] | null | undefined} exts extensions, with or without the dot
 * @returns {(absolute: string) => boolean}
 */
function extFilter(exts) {
  if (!exts || exts.length === 0) return () => true;
  const set = new Set(exts.map((e) => (e.startsWith('.') ? e : `.${e}`)));
  return (absolute) => set.has(path.extname(absolute));
}

/**
 * Files that EXIST under `dirs` — tracked or not — minus gitignored content
 * and minus `prune`.
 *
 * Drop-in shaped like `listRepoFiles()`: absolute paths, sorted, deduplicated,
 * never throwing for a missing directory (it contributes zero files).
 *
 * @param {object} options
 * @param {string} options.repoRoot absolute repository root
 * @param {string[]} [options.dirs] repo-relative directories to scan (default: the whole root)
 * @param {string[] | null} [options.exts] extensions to keep (default: every file)
 * @param {string[]} [options.prune] path segments / repo-relative prefixes to skip
 *   (default: {@link DEFAULT_PRUNE}; REPLACES the default when given, so pass
 *   `[...DEFAULT_PRUNE, 'extra']` to extend it rather than to swap it)
 * @param {(target: string) => import('node:fs').Stats} [options.stat] injection
 *   seam for tests (default: `statSync`) — the same shape `collectDriftHits()`
 *   uses for its `enumerate`/`read` seams
 * @returns {string[]} absolute paths, sorted
 * @throws {RepoEnumerationError} when a listed path can neither be resolved
 *   nor proven absent (`EACCES`, `EPERM`, `ELOOP`, …) — see the module header's
 *   failure table. Only the git path raises; the non-git fallback walk cannot.
 */
export function enumerateRepoFiles({
  repoRoot,
  dirs,
  exts = null,
  prune = DEFAULT_PRUNE,
  stat = statSync,
} = {}) {
  const matches = extFilter(exts);
  const pruneList = [...prune];
  const env = gitEnv();

  if (isGitToplevel(repoRoot, env)) {
    const pathspecs = dirs && dirs.length > 0 ? dirs.filter((d) => d !== '.') : [];
    try {
      // `--cached --others --exclude-standard` = tracked PLUS untracked, minus
      // everything `.gitignore`/`.git/info/exclude` excludes. `--deduplicate`
      // is deliberately not used: it needs git >= 2.31 and the Set below is
      // free. See the module header for why this beats both a bare
      // `ls-files` (#1248) and a bare walk (#1143).
      const out = execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 64 * 1024 * 1024,
          env,
        },
      );
      const found = new Set();
      for (const rel of out.split('\0')) {
        if (!rel) continue;
        if (isPruned(rel, pruneList)) continue;
        const absolute = path.join(repoRoot, rel);
        if (!matches(absolute)) continue;
        // A tracked path can be absent from the working tree (sparse checkout,
        // a deletion staged elsewhere). A scanner that then read it would
        // report a tool-error for a file nobody removed — so ABSENT is skipped.
        // Anything else means the file may be there and we could not look:
        // fail closed rather than shrink the census in silence (header table).
        let entry;
        try {
          entry = stat(absolute);
        } catch (err) {
          const code = err && err.code;
          if (ABSENT_STAT_CODES.has(code)) continue;
          throw new RepoEnumerationError(
            `cannot stat ${absolute} (${code || 'unknown error'}): the file may exist and could not be read — enumeration is inconclusive`,
            { code, path: absolute, cause: err },
          );
        }
        if (!entry.isFile()) continue;
        found.add(absolute);
      }
      return [...found].sort();
    } catch (err) {
      // A resolution failure is NOT a reason to retry with a weaker oracle:
      // the walk would skip the same unreadable entry silently and hand back a
      // census that looks complete. Only a git/`ls-files` failure falls
      // through — there we have no index to trust in the first place.
      if (err instanceof RepoEnumerationError) throw err;
      // fall through to the walk — a git that answered rev-parse but failed
      // ls-files leaves us with no index to trust.
    }
  }

  // Non-git root (tarball export, vendored copy, tmpdir fixture): the walk in
  // `repo-files.mjs` is the reuse — it already skips symlinks and unreadable
  // sub-trees. It excludes by directory BASENAME only, so prefix-shaped prune
  // entries are re-applied here.
  const basenamePrune = pruneList.filter((entry) => !entry.includes('/'));
  return listOnDiskFiles(repoRoot, { dirs, exts, exclude: basenamePrune }).filter((absolute) => {
    const rel = path.relative(repoRoot, absolute).split(path.sep).join('/');
    return !isPruned(rel, pruneList);
  });
}
