/**
 * Trusted-publishing probe commit on the GitHub mirror (#1906).
 *
 * The rehearsal of route B pushes a prerelease tag `vX.Y.Z-<id>.N` to `github`
 * on a commit whose only parent is a proven curated export snapshot and which
 * changes nothing but the version fields (skills/npm-publish/SKILL.md § Route B).
 * That tree can never equal the export tree of a source (.husky/pre-push
 * condition 6), so the hook ran the full gate on the slim tree, red by
 * construction. `checkProbeCommit` proves the commit IS such a probe, so the
 * hook may run the same mirror smoke gate as for its parent snapshot.
 *
 * Every condition reads what the commits and trees are (fail closed):
 *   1. the remote ref is `refs/tags/v<version>` and the version has the exact
 *      prerelease shape publish.yml publishes under its own dist-tag, never
 *      `latest` (`X.Y.Z-<id>.N`, <id> lowercase, ≥ 2 characters, not `latest`,
 *      not `v<digit>…`/`vx…`);
 *   2. the commit has exactly one parent;
 *   3. that parent is a genuine snapshot: its last `Source-Commit:` trailer names
 *      a local commit whose public-export policy has a non-empty `include`, the
 *      parent's tree equals computeSnapshotTree of that source, and the source is
 *      an ancestor of refs/remotes/origin/main (the pre-push conditions 3, 4, 6, 7);
 *   4. the diff to the parent names exactly package.json and package-lock.json,
 *      both still regular files (mode 100644, never a symlink or executable);
 *   5. both files equal the parent's with only `version` (package.json) and
 *      `version` / `packages[""].version` (package-lock.json) set to the tag's
 *      version — compared as parsed JSON, so no script, dependency or field moves.
 *
 * CEILING (BV-004): like the snapshot gate, this guards against mistakes and
 * copied trailers, not against a local user who can edit the hook or this module.
 * Revisit trigger: a probe tag push that passed here while GitHub CI went red.
 *
 * @module mirror-probe
 */
import { spawnSync } from './native-command.mjs';
import { computeSnapshotTree } from './snapshot-probe.mjs';

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+-([a-z][a-z0-9-]+)\.[0-9]+$/;

/**
 * The prerelease version a probe tag ref names, or null.
 * @param {string} remoteRef
 * @returns {string | null}
 */
export function probeVersion(remoteRef) {
  const m = /^refs\/tags\/v(.+)$/.exec(remoteRef ?? '');
  const shape = m ? VERSION_RE.exec(m[1]) : null;
  if (!shape) return null;
  const distTag = shape[1];
  if (distTag === 'latest' || /^v[0-9x]/.test(distTag)) return null;
  return m[1];
}

function gitRunner(repoRoot) {
  return (args) => {
    const r = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', input: '', maxBuffer: 64 * 1024 * 1024 });
    return { ok: r.status === 0, out: r.status === 0 ? r.stdout : '' };
  };
}

function lastSourceTrailer(message) {
  let src = null;
  for (const line of message.split('\n')) {
    const m = /^Source-Commit: ([0-9a-f]{40,64})\s*$/.exec(line);
    if (m) src = m[1];
  }
  return src;
}

const parse = (text) => {
  try { return JSON.parse(text); } catch { return undefined; }
};

/**
 * Whether `sha`, pushed to `remoteRef` on the mirror, is a version-only probe
 * commit on a proven snapshot. Never throws; `reason` names the first failed check.
 * @param {{ repoRoot: string, sha: string, remoteRef: string }} input
 * @returns {{ ok: true, version: string, parent: string, source: string } | { ok: false, reason: string }}
 */
export function checkProbeCommit({ repoRoot, sha, remoteRef }) {
  const git = gitRunner(repoRoot);
  const version = probeVersion(remoteRef);
  if (version === null) return { ok: false, reason: `${remoteRef} is no prerelease probe tag` };
  const commit = git(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  if (!commit.ok) return { ok: false, reason: `${sha} is no commit` };
  const head = commit.out.trim();
  const parents = git(['rev-list', '--parents', '-n', '1', head]).out.trim().split(' ').slice(1);
  if (parents.length !== 1) return { ok: false, reason: `probe commit has ${parents.length} parents, not 1` };
  const [parent] = parents;
  const source = lastSourceTrailer(git(['cat-file', 'commit', parent]).out);
  if (!source || !git(['cat-file', '-e', `${source}^{commit}`]).ok) return { ok: false, reason: 'parent carries no Source-Commit of a local commit' };
  const policy = parse(git(['show', `${source}:.orchestrator/policy/public-export.json`]).out);
  if (!Array.isArray(policy?.include) || policy.include.length === 0) return { ok: false, reason: 'source export policy has no include list' };
  let snap;
  try { snap = computeSnapshotTree({ repoRoot, source }); } catch { snap = { ok: false }; }
  const parentTree = git(['rev-parse', '--verify', '--quiet', `${parent}^{tree}`]).out.trim();
  if (!snap.ok || snap.sourceSha !== source || snap.snapshotTree !== parentTree) return { ok: false, reason: 'parent tree is not the curated export tree of its source' };
  if (!git(['merge-base', '--is-ancestor', source, 'refs/remotes/origin/main']).ok) return { ok: false, reason: 'source is not on origin/main' };
  const changed = git(['diff', '--name-only', '--no-renames', parent, head]).out.trim().split('\n').filter(Boolean).sort();
  if (changed.length !== 2 || changed[0] !== 'package-lock.json' || changed[1] !== 'package.json') {
    return { ok: false, reason: `probe changes ${changed.length === 0 ? 'nothing' : JSON.stringify(changed)}, not only package.json and package-lock.json` };
  }
  const modes = git(['ls-tree', head, '--', 'package.json', 'package-lock.json']).out.trim().split('\n');
  if (modes.length !== 2 || modes.some((line) => !line.startsWith('100644 blob '))) return { ok: false, reason: 'package.json and package-lock.json must stay regular files (100644)' };
  const before = (file) => parse(git(['show', `${parent}:${file}`]).out);
  const after = (file) => parse(git(['show', `${head}:${file}`]).out);
  const pkg = before('package.json');
  const lock = before('package-lock.json');
  if (!pkg || !lock?.packages?.['']) return { ok: false, reason: 'parent package files are unreadable' };
  pkg.version = version;
  lock.version = version;
  lock.packages[''].version = version;
  if (JSON.stringify(after('package.json')) !== JSON.stringify(pkg)) return { ok: false, reason: 'package.json changes more than version' };
  if (JSON.stringify(after('package-lock.json')) !== JSON.stringify(lock)) return { ok: false, reason: 'package-lock.json changes more than its two version fields' };
  return { ok: true, version, parent, source };
}
