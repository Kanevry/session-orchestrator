/**
 * github-export.mjs — curated public GitHub mirror as ONE snapshot commit (#1631, #1594).
 *
 * GitLab keeps the full private repository. The public GitHub mirror (`mirror: curated`)
 * receives, per export, a single SQUASH commit whose tree is the source tree minus the
 * paths in `.orchestrator/policy/public-export.json`, and whose parent is ALWAYS the
 * public GitHub main — verified against the remote itself (`git ls-remote`), never
 * trusted from the local tracking ref alone. Nothing but that one new commit sits
 * between the public main and the export, so nothing private can ride along: no older
 * snapshot built under an older policy, no forged or stale export ref, no private
 * commit from the source history.
 *
 * Plumbing only, on a temp index — the real index, working tree and HEAD are untouched:
 *   GIT_INDEX_FILE=<tmp> read-tree <source>^{tree}
 *   → update-index --force-remove (paths matched by the SAME matcher the leakage
 *     checker uses, so the two can never disagree on what "excluded" means)
 *   → write-tree → commit-tree -p <verified github main> (trailer `Source-Commit: <sha>`)
 *   → update-ref refs/heads/github-export <new> <old-or-zero>   (compare-and-swap)
 *
 * `refs/heads/github-export` is only the output slot: overwritten each run, never read
 * as a parent. Every git call runs with GIT_NO_REPLACE_OBJECTS=1, and the export refuses
 * outright when `refs/replace/*` or `info/grafts` exist — either would let the checks read
 * a different object graph than the one `git push` sends.
 *
 * The git runner is injectable so tests and callers can wrap it; the snapshot check is
 * injectable so plumbing tests do not depend on a host owner-pattern policy. The default
 * snapshot check runs the strict leakage scan and refuses when a public file still cites
 * an excluded path, so the curated tree cannot turn GitHub's validate-plugin red.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PUBLIC_EXPORT_POLICY_FILE,
  isPublicExportExcluded,
  validatePublicExportPolicy,
} from './validate/check-owner-leakage.mjs';
import { scanSkillScriptPaths } from './validate/check-skill-script-paths.mjs';
import { checkSkillLinks } from './validate/check-skill-links.mjs';

export const EXPORT_REF = 'refs/heads/github-export';
export const MIRROR_REMOTE = 'github';
export const MIRROR_REF = 'refs/remotes/github/main';
export const SOURCE_COMMIT_TRAILER = 'Source-Commit';

const LEAKAGE_SCRIPT = fileURLToPath(new URL('./validate/check-owner-leakage.mjs', import.meta.url));
const PARSE_CONFIG_SCRIPT = fileURLToPath(new URL('../parse-config.mjs', import.meta.url));
const MIRROR_VALUES = ['none', 'github', 'curated'];

/**
 * @typedef {{ status: number|null, stdout: string, stderr: string }} GitResult
 * @typedef {(args: string[], opts?: { env?: Record<string,string|undefined>, input?: string }) => GitResult} GitRunner
 */

/**
 * Default git runner: never throws, returns status + output.
 * @param {string} cwd
 * @returns {GitRunner}
 */
export function createGitRunner(cwd) {
  return (args, { env, input } = {}) => {
    const res = spawnSync('git', args, {
      cwd,
      // Replace refs would let every check below read a different graph than push sends.
      env: { ...process.env, ...(env ?? {}), GIT_NO_REPLACE_OBJECTS: '1' },
      input,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? (res.error ? String(res.error.message) : '') };
  };
}

/**
 * Last `Source-Commit:` trailer value of a raw commit object (`git cat-file commit`).
 * @param {string} commitBody
 * @returns {string|null} full hex sha or null
 */
export function parseSourceCommitTrailer(commitBody) {
  const re = new RegExp(`^${SOURCE_COMMIT_TRAILER}: ([0-9a-f]{40,64})\\s*$`, 'gm');
  let last = null;
  for (const m of commitBody.matchAll(re)) last = m[1];
  return last;
}

/** @param {GitRunner} git @param {string} rev */
function resolveCommit(git, rev) {
  const res = git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  return res.status === 0 ? res.stdout.trim() : null;
}

/** @param {GitRunner} git */
function isAncestor(git, ancestor, descendant) {
  return git(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0;
}

/** @param {GitRunner} git @param {string} treeish */
function listTree(git, treeish) {
  const res = git(['ls-tree', '-r', '-z', '--name-only', treeish]);
  if (res.status !== 0) throw new Error(`git ls-tree failed for ${treeish}`);
  return res.stdout.split('\0').filter(Boolean);
}

/**
 * Public files that still cite an excluded path, judged by the SAME two validate-plugin
 * modules the GitHub CI runs (`check-skill-script-paths` for inline-code citations,
 * `check-skill-links` for relative links), executed on the snapshot tree. Only findings
 * that point INTO an excluded path count: those are the ones the export itself creates,
 * so a source tree that passes validate-plugin cannot produce a snapshot that fails it.
 * A tool error in the path scan counts as a finding (fail closed).
 * @param {string} root snapshot work tree
 * @param {string[]} excludes
 * @returns {string[]} `file:line → cited` entries
 */
export function findExcludedCitations(root, excludes) {
  const hit = (rel) => isPublicExportExcluded(rel, excludes) || isPublicExportExcluded(`${rel}/`, excludes);
  const out = [];
  const paths = scanSkillScriptPaths({ pluginRoot: root });
  if (paths.toolError) out.push('path-check tool error — citations not measurable');
  for (const f of paths.findings) {
    if (f.severity !== 'warn' && hit(f.path)) out.push(`${f.file}:${f.line} → ${f.path}`);
  }
  for (const f of checkSkillLinks(root).findings) {
    const target = relative(root, resolve(dirname(join(root, f.file)), f.target.split('#')[0])).split('\\').join('/');
    if (hit(target)) out.push(`${f.file}:${f.line} → ${f.target}`);
  }
  return out;
}

/**
 * Default snapshot check: materialise the snapshot commit in a temporary detached
 * worktree, run `check-owner-leakage.mjs --public-export` over it, then
 * {@link findExcludedCitations}. The worktree is always removed. Only the leakage
 * checker's own (already redacted) FAIL lines are surfaced; citation findings name
 * public files and excluded paths, which the public policy file already lists.
 * @param {{ git: GitRunner, commit: string, excludes: string[] }} ctx
 * @returns {{ ok: boolean, reason?: string, findings?: string[] }}
 */
export function defaultSnapshotCheck({ git, commit, excludes }) {
  const dir = mkdtempSync(join(tmpdir(), 'so-github-export-'));
  const wt = join(dir, 'tree');
  let added = false;
  try {
    const add = git(['-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', '--quiet', wt, commit]);
    if (add.status !== 0) return { ok: false, reason: 'temporary worktree for the leakage scan could not be created' };
    added = true;
    const res = spawnSync(process.execPath, [LEAKAGE_SCRIPT, wt, '--public-export'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const findings = (res.stdout ?? '').split('\n').filter((l) => l.startsWith('  FAIL:'));
    if (res.status !== 0) return { ok: false, reason: `leakage scan failed (${findings.length} finding(s))`, findings };
    const citations = findExcludedCitations(wt, excludes);
    if (citations.length > 0) {
      return { ok: false, reason: `${citations.length} public file citation(s) point into excluded paths (validate-plugin would fail on GitHub)`, findings: citations };
    }
    return { ok: true };
  } finally {
    if (added) git(['worktree', 'remove', '--force', wt]);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Replace refs or grafts make every read disagree with what `git push` sends. @param {GitRunner} git */
function graphIntegrityProblem(git) {
  const replaceRefs = git(['for-each-ref', '--format=%(refname)', 'refs/replace/']);
  if (replaceRefs.status !== 0 || replaceRefs.stdout.trim() !== '') return 'refs/replace/* present — remove replace refs before exporting';
  const grafts = git(['rev-parse', '--path-format=absolute', '--git-path', 'info/grafts']);
  if (grafts.status !== 0 || existsSync(grafts.stdout.trim())) return 'info/grafts present — remove grafts before exporting';
  return null;
}

/**
 * Exclude list from the SOURCE commit's policy file.
 * @param {GitRunner} git @param {string} sourceSha
 * @returns {{ ok: true, excludes: string[] } | { ok: false, reason: string }}
 */
export function readSourcePolicy(git, sourceSha) {
  const res = git(['show', `${sourceSha}:${PUBLIC_EXPORT_POLICY_FILE}`]);
  if (res.status !== 0) return { ok: false, reason: `${PUBLIC_EXPORT_POLICY_FILE} missing in source commit` };
  try {
    return validatePublicExportPolicy(JSON.parse(res.stdout));
  } catch {
    return { ok: false, reason: `${PUBLIC_EXPORT_POLICY_FILE} is not JSON` };
  }
}

/**
 * Write the curated snapshot TREE of a source commit: the source tree minus every path
 * the policy excludes, via a temp index (`read-tree` → `update-index --force-remove` →
 * `write-tree`). Writes loose tree objects only — no commit, no ref; the real index is
 * untouched. The written tree is post-checked independently of the removal step.
 * Shared by `buildGithubExport` and the snapshot probe (#1712), so the tree the probe
 * tests is by construction the tree the export publishes.
 * @param {{ git: GitRunner, sourceSha: string, excludes: string[] }} opts
 * @returns {{ ok: true, tree: string, sourceFiles: number, removed: string[] } | { ok: false, reason: string }}
 */
export function writeSnapshotTree({ git, sourceSha, excludes }) {
  const fail = (reason) => ({ ok: /** @type {const} */ (false), reason });
  const tmp = mkdtempSync(join(tmpdir(), 'so-github-export-idx-'));
  const env = { GIT_INDEX_FILE: join(tmp, 'index') };
  let tree;
  let sourceFiles;
  let removed;
  try {
    if (git(['read-tree', `${sourceSha}^{tree}`], { env }).status !== 0) return fail('read-tree of the source failed');
    const ls = git(['ls-files', '-z', '--cached'], { env });
    if (ls.status !== 0) return fail('listing the temp index failed');
    const all = ls.stdout.split('\0').filter(Boolean);
    sourceFiles = all.length;
    removed = all.filter((p) => isPublicExportExcluded(p, excludes));
    if (removed.length > 0) {
      const rm = git(['update-index', '--force-remove', '-z', '--stdin'], { env, input: removed.join('\0') + '\0' });
      if (rm.status !== 0) return fail('removing excluded paths from the temp index failed');
    }
    const wt = git(['write-tree'], { env });
    if (wt.status !== 0) return fail('write-tree failed');
    tree = wt.stdout.trim();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // Post-check on the written tree itself, independent of the removal step above.
  const survivors = listTree(git, tree).filter((p) => isPublicExportExcluded(p, excludes));
  if (survivors.length > 0) return fail(`${survivors.length} excluded path(s) survived in the snapshot tree`);
  return { ok: true, tree, sourceFiles, removed };
}

/**
 * The anchor (`ls-remote`) is read through the FETCH URL, but `git push` goes to the
 * push URL (`remote.<name>.pushurl`, `url.*.pushInsteadOf`). If they differ, the
 * verified main describes a different repository than the one that receives the push.
 * URLs are compared, never printed.
 * @param {GitRunner} git @param {string} remote
 * @returns {string|null} problem, or null when both resolve to the same URL
 */
export function pushUrlProblem(git, remote) {
  const fetchUrl = git(['remote', 'get-url', remote]);
  const pushUrl = git(['remote', 'get-url', '--push', remote]);
  if (fetchUrl.status !== 0 || pushUrl.status !== 0) return `remote '${remote}' URLs not readable`;
  if (fetchUrl.stdout.trim() !== pushUrl.stdout.trim()) {
    return `the push URL of '${remote}' differs from its fetch URL (pushurl or pushInsteadOf) — the verified main would not describe the push target`;
  }
  return null;
}

/**
 * Public GitHub main: the tracking ref, required to equal the remote's real main.
 * @param {GitRunner} git @param {string} remote @param {string} mirrorRef
 * @returns {{ ok: true, sha: string } | { ok: false, reason: string }}
 */
function verifiedPublicMain(git, remote, mirrorRef) {
  const mirrorSha = resolveCommit(git, mirrorRef);
  if (!mirrorSha) return { ok: false, reason: `${mirrorRef} does not resolve — fetch ${remote} first` };
  const ls = git(['ls-remote', remote, 'refs/heads/main']);
  const remoteSha = ls.status === 0 ? (ls.stdout.split('\n').find((l) => l.endsWith('\trefs/heads/main')) ?? '').split('\t')[0] : '';
  if (!remoteSha) return { ok: false, reason: `git ls-remote ${remote} refs/heads/main failed — public main not verifiable` };
  if (remoteSha !== mirrorSha) return { ok: false, reason: `${mirrorRef} does not match ${remote}'s main — fetch ${remote} first` };
  return { ok: true, sha: mirrorSha };
}

/**
 * Re-verify a snapshot commit BY SHA right before it is pushed (session-end § 4.4 runs
 * this through `github-export.mjs --verify <sha> --source <sha>`). Binding the check to
 * the sha — and pushing that sha, not a ref name — closes the window in which the export
 * ref could be swapped after the scan. Objects are immutable by sha once replace refs
 * and grafts are ruled out.
 * @param {{ git: GitRunner, sha: string, source: string, remote?: string, mirrorRef?: string }} opts
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyExportCommit({ git, sha, source, remote = MIRROR_REMOTE, mirrorRef = MIRROR_REF }) {
  const bad = (reason) => ({ ok: /** @type {const} */ (false), reason });
  const integrity = graphIntegrityProblem(git);
  if (integrity) return bad(integrity);
  const commit = resolveCommit(git, sha);
  const sourceSha = resolveCommit(git, source);
  if (!commit || commit !== sha) return bad('the export sha is not a full commit sha');
  if (!sourceSha) return bad(`source '${source}' does not resolve to a commit`);
  const pushProblem = pushUrlProblem(git, remote);
  if (pushProblem) return bad(pushProblem);
  const main = verifiedPublicMain(git, remote, mirrorRef);
  if (!main.ok) return bad(main.reason);
  const parents = git(['rev-list', '--parents', '-n', '1', commit]).stdout.trim().split(' ').slice(1);
  if (parents.length !== 1 || parents[0] !== main.sha) return bad('the export commit is not one commit directly on the public main');
  const body = git(['cat-file', 'commit', commit]);
  if (body.status !== 0 || parseSourceCommitTrailer(body.stdout) !== sourceSha) return bad(`the export commit's ${SOURCE_COMMIT_TRAILER} is not the source`);
  const policy = readSourcePolicy(git, sourceSha);
  if (!policy.ok) return bad(policy.reason);
  const survivors = listTree(git, commit).filter((p) => isPublicExportExcluded(p, policy.excludes));
  if (survivors.length > 0) return bad(`${survivors.length} excluded path(s) in the export commit`);
  return { ok: true };
}

/**
 * Build (or confirm) the curated public snapshot.
 *
 * @param {object} opts
 * @param {GitRunner} opts.git
 * @param {string} [opts.source='HEAD']
 * @param {string} [opts.exportRef=EXPORT_REF] output ref only — never read as a parent
 * @param {string} [opts.remote=MIRROR_REMOTE] remote whose `refs/heads/main` is the public main
 * @param {string} [opts.mirrorRef=MIRROR_REF] local tracking ref that must equal the remote main
 * @param {boolean} [opts.dryRun=false]
 * @param {(ctx: { git: GitRunner, commit: string, excludes: string[] }) => { ok: boolean, reason?: string, findings?: string[] }} [opts.snapshotCheck]
 * @returns {{ status: 'created'|'unchanged'|'dry-run'|'refused', sha?: string, reason?: string, findings?: string[], stats?: object, warnings?: string[] }}
 */
export function buildGithubExport({
  git,
  source = 'HEAD',
  exportRef = EXPORT_REF,
  remote = MIRROR_REMOTE,
  mirrorRef = MIRROR_REF,
  dryRun = false,
  snapshotCheck = defaultSnapshotCheck,
}) {
  const refuse = (reason, extra = {}) => ({ status: /** @type {const} */ ('refused'), reason, ...extra });

  const integrity = graphIntegrityProblem(git);
  if (integrity) return refuse(integrity);

  const sourceSha = resolveCommit(git, source);
  if (!sourceSha) return refuse(`source '${source}' does not resolve to a commit`);

  // The policy is read from the SOURCE commit, so what is excluded matches what is exported.
  const policy = readSourcePolicy(git, sourceSha);
  if (!policy.ok) return refuse(policy.reason);
  const { excludes } = policy;

  // A push URL that differs from the fetch URL makes the anchor below meaningless for
  // the push. Publishing refuses; a dry-run publishes nothing, so it only reports it.
  const pushProblem = pushUrlProblem(git, remote);
  if (pushProblem && !dryRun) return refuse(pushProblem);

  // The parent is ALWAYS the public GitHub main, anchored on the remote itself: a stale,
  // rolled-back or hand-moved tracking ref must never decide what becomes the base.
  const main = verifiedPublicMain(git, remote, mirrorRef);
  if (!main.ok) return refuse(main.reason);
  const parentSha = main.sha;
  const exportOld = resolveCommit(git, exportRef);
  const warnings = pushProblem ? [pushProblem] : [];

  // The published snapshot must describe an older state of the same source line.
  const parentBody = git(['cat-file', 'commit', parentSha]);
  if (parentBody.status !== 0) return refuse('parent commit unreadable');
  const parentSource = parseSourceCommitTrailer(parentBody.stdout);
  if (parentSource && !(resolveCommit(git, parentSource) && isAncestor(git, parentSource, sourceSha))) {
    return refuse(`the parent's ${SOURCE_COMMIT_TRAILER} is not an ancestor of the source`);
  }

  // One selection path for export and snapshot probe (#1712); the helper post-checks
  // the written tree for surviving excluded paths.
  const snap = writeSnapshotTree({ git, sourceSha, excludes });
  if (!snap.ok) return refuse(snap.reason);
  const { tree: newTree, sourceFiles: sourceCount, removed } = snap;

  const parentTree = git(['rev-parse', `${parentSha}^{tree}`]).stdout.trim();
  const diff = git(['diff-tree', '-r', '--name-only', '-z', parentTree, newTree]);
  const stats = {
    sourceFiles: sourceCount,
    excludedFiles: removed.length,
    snapshotFiles: sourceCount - removed.length,
    changedVsParent: diff.stdout.split('\0').filter(Boolean).length,
  };

  // Nothing to publish: the public main already carries this tree. The export ref is
  // left alone; the caller pushes nothing.
  if (newTree === parentTree) {
    if (dryRun) return { status: 'dry-run', sha: parentSha, stats: { ...stats, unchanged: true }, warnings };
    return { status: 'unchanged', sha: parentSha, stats };
  }

  const message = `Public snapshot of ${sourceSha.slice(0, 12)}\n\n${SOURCE_COMMIT_TRAILER}: ${sourceSha}\n`;
  const ct = git(['commit-tree', newTree, '-p', parentSha, '-F', '-'], { input: message });
  if (ct.status !== 0) return refuse('commit-tree failed');
  const newCommit = ct.stdout.trim();

  const check = snapshotCheck({ git, commit: newCommit, excludes });
  if (!check.ok) return refuse(check.reason ?? 'snapshot check failed', { findings: check.findings, stats });

  if (dryRun) return { status: 'dry-run', sha: newCommit, stats, warnings };

  if (git(['update-ref', exportRef, newCommit, exportOld ?? '0'.repeat(sourceSha.length)]).status !== 0) {
    return refuse(`update-ref ${exportRef} lost a compare-and-swap race`);
  }
  return { status: 'created', sha: newCommit, stats };
}

/**
 * The repo's `mirror` Session Config value, read the way session-end § 4.4 reads it:
 * `parse-config.mjs` run inside the repo, `mirror` taken from its JSON (`null` = key absent).
 * Unreadable config, non-JSON output and unknown values are refusals, never a default.
 * @param {string} repoRoot
 * @returns {{ ok: true, mirror: 'none'|'github'|'curated'|null } | { ok: false, reason: string }}
 */
export function readMirrorSetting(repoRoot) {
  const res = spawnSync(process.execPath, [PARSE_CONFIG_SCRIPT], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (res.status !== 0) return { ok: false, reason: "Session Config unreadable — 'mirror' not evaluated" };
  let mirror;
  try {
    mirror = JSON.parse(res.stdout).mirror ?? null;
  } catch {
    return { ok: false, reason: 'parse-config output is not JSON' };
  }
  if (mirror !== null && !MIRROR_VALUES.includes(mirror)) {
    return { ok: false, reason: `unknown 'mirror: ${mirror}' (expected none | github | curated)` };
  }
  return { ok: true, mirror };
}

/**
 * Fail-closed guard for every PLAIN push of source refs to the mirror (`git push github
 * HEAD`/`main`, i.e. `mirror` absent or `github`). The working tree's Session Config can
 * predate `mirror: curated` — any branch or checkout cut before the repo adopted the
 * curated export has no `mirror` key and would publish the full private history. So the
 * policy file decides, not the key: when HEAD or origin's main (read live via
 * `ls-remote`, fetched when the object is not local) carries
 * `.orchestrator/policy/public-export.json`, the repo publishes curated only and the
 * plain push is refused. Without an `origin` remote there is no upstream to consult, so
 * a `github` remote is pushed to only when `mirror: github` is set explicitly
 * (`explicitGithub`); an absent key is "could not tell". "Could not tell" (origin
 * unreadable, its main not fetchable) refuses as well.
 * @param {{ git: GitRunner, upstream?: string, explicitGithub?: boolean }} opts
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function plainPushGuard({ git, upstream = 'origin', explicitGithub = false }) {
  const adopted = (where) => ({
    ok: /** @type {const} */ (false),
    reason: `${where} carries ${PUBLIC_EXPORT_POLICY_FILE} — this repo publishes to GitHub only as a curated export; set 'mirror: curated' (or merge ${upstream}'s main) instead of pushing source history`,
  });
  if (git(['cat-file', '-e', `HEAD:${PUBLIC_EXPORT_POLICY_FILE}`]).status === 0) return adopted('HEAD');
  const remotes = git(['remote']);
  if (remotes.status !== 0) return { ok: false, reason: 'git remote failed — upstream policy unknown' };
  const names = remotes.stdout.split('\n');
  if (!names.includes(upstream)) {
    if (!names.includes(MIRROR_REMOTE) || explicitGithub) return { ok: true };
    return { ok: false, reason: `no '${upstream}' remote — the upstream export policy cannot be checked; set 'mirror: github' explicitly to push source history to '${MIRROR_REMOTE}'` };
  }
  const ls = git(['ls-remote', upstream, 'refs/heads/main']);
  if (ls.status !== 0) return { ok: false, reason: `cannot read ${upstream}'s main — upstream export policy unknown` };
  const sha = (ls.stdout.split('\n').find((l) => l.endsWith('\trefs/heads/main')) ?? '').split('\t')[0];
  if (!sha) return { ok: true };
  if (!resolveCommit(git, sha)) git(['fetch', '--quiet', '--no-tags', upstream, 'refs/heads/main']);
  if (resolveCommit(git, sha) !== sha) return { ok: false, reason: `${upstream}'s main ${sha.slice(0, 12)} is not available locally — upstream export policy unknown` };
  if (git(['cat-file', '-e', `${sha}:${PUBLIC_EXPORT_POLICY_FILE}`]).status === 0) return adopted(`${upstream}'s main`);
  return { ok: true };
}
