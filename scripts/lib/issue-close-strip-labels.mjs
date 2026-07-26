/**
 * issue-close-strip-labels.mjs
 *
 * Auto-strips `status:*` workflow labels from an issue before it is closed.
 * A closed issue carrying `status:in-progress` or `status:ready` is misleading
 * because close already implies the work is done.
 *
 * Design notes:
 *   - Stdlib only. Shells out via `execFileSync` (argv-array form — no shell
 *     interpolation, safe for label values with special chars).
 *   - Fetches current labels via JSON output, filters for `status:*`, runs the
 *     strip only when at least one match is found (idempotent no-op otherwise).
 *   - Returns the array of stripped label names (empty array = no-op).
 *   - Never throws — all errors are caught and returned as `{ stripped: [],
 *     error: string }` so callers can log and proceed with close unblocked.
 *   - Supports GitLab (`glab`) and GitHub (`gh`). VCS is a required param.
 *   - Every `glab`/`gh` spawn is pinned to the resolved repo via `-R <spec>`
 *     (#839) — see `scripts/lib/vcs-repo-spec.mjs` for why: a bare spawn
 *     falls back to the ambient `GITLAB_HOST`/`GH_HOST`, which can silently
 *     resolve to the wrong GitLab instance on a multi-host machine, turning
 *     this whole module into a silent no-op.
 *
 * Usage (from session-end Phase 5 issue-close loop):
 *
 *   import { stripStatusLabels } from '${PLUGIN_ROOT}/scripts/lib/issue-close-strip-labels.mjs';
 *
 *   const { stripped, error } = await stripStatusLabels({ issueId: 42, vcs: 'gitlab' });
 *   if (error) console.warn(`⚠ label strip failed for #${issueId}: ${error}`);
 *   else if (stripped.length) console.log(`Stripped ${stripped.join(', ')} from #${issueId}`);
 *   // then close the issue with glab/gh as usual
 *
 * Auto-created by `scripts/lib/issue-close-strip-labels.mjs` (#308).
 */

import { execFileSync } from 'node:child_process';
import { resolveRepoSpec } from './vcs-repo-spec.mjs';

/** Regex that matches any `status:*` label name. */
const STATUS_LABEL_RE = /^status:/;

/**
 * Run a CLI command and return { ok, stdout, stderr }. Never throws.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function runCli(cmd, args) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: '' };
  } catch (err) {
    const stderr =
      err && err.stderr ? String(err.stderr) : err && err.message ? String(err.message) : 'unknown error';
    const stdout = err && err.stdout ? String(err.stdout) : '';
    return { ok: false, stdout, stderr };
  }
}

/**
 * Fetch the label names currently applied to an issue.
 *
 * @param {{ issueId: number | string, vcs: 'gitlab' | 'github', spec?: string }} opts
 *   `spec` is the resolved `-R`/`--repo` host-pinning value (#839); omitted
 *   (undefined) means no `-R` is appended — never emit `-R undefined`.
 * @returns {{ ok: boolean, labels: string[], stderr: string }}
 */
function fetchLabels({ issueId, vcs, spec }) {
  const id = String(issueId);

  if (vcs === 'github') {
    // `gh issue view <NUMBER> --json labels` returns { labels: [{name, ...}] }
    const args = ['issue', 'view', id, '--json', 'labels'];
    if (spec) args.push('-R', spec);
    const res = runCli('gh', args);
    if (!res.ok) return { ok: false, labels: [], stderr: res.stderr };
    let parsed;
    try {
      parsed = JSON.parse(res.stdout);
    } catch (e) {
      return { ok: false, labels: [], stderr: `JSON parse failed: ${e && e.message ? e.message : String(e)}` };
    }
    const labels = Array.isArray(parsed?.labels)
      ? parsed.labels.map((l) => (typeof l?.name === 'string' ? l.name : String(l))).filter(Boolean)
      : [];
    return { ok: true, labels, stderr: '' };
  }

  // Default: gitlab via glab.
  // `glab issue view <IID> --output json` returns an issue object with a `labels` array.
  const args = ['issue', 'view', id, '--output', 'json'];
  if (spec) args.push('-R', spec);
  const res = runCli('glab', args);
  if (!res.ok) return { ok: false, labels: [], stderr: res.stderr };
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    return { ok: false, labels: [], stderr: `JSON parse failed: ${e && e.message ? e.message : String(e)}` };
  }
  // GitLab JSON shape: { labels: ["status:ready", "priority::high", ...] }
  const labels = Array.isArray(parsed?.labels)
    ? parsed.labels.map((l) => (typeof l === 'string' ? l : String(l))).filter(Boolean)
    : [];
  return { ok: true, labels, stderr: '' };
}

/**
 * Strip all `status:*` labels from an issue.
 *
 * Returns the list of label names that were stripped. An empty array means the
 * issue had no `status:*` labels (idempotent no-op — no CLI call is made for
 * the strip step). Never throws.
 *
 * @param {{
 *   issueId: number | string,
 *   vcs?: 'gitlab' | 'github',
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined
 * }} opts
 *   `repoRoot` defaults to `process.cwd()`. `resolveRepoSpecFn` is the
 *   injectable seam for the `-R`/`--repo` host-pinning resolution (#839) —
 *   defaults to the real `resolveRepoSpec` (shells out to `git remote
 *   get-url`); tests inject a stub instead of shelling out.
 * @returns {Promise<{ stripped: string[], error?: string }>}
 */
export async function stripStatusLabels({
  issueId,
  vcs = 'gitlab',
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
} = {}) {
  try {
    const id = String(issueId ?? '').trim();
    if (!id || id === 'undefined' || id === 'null') {
      return { stripped: [], error: `invalid issueId: ${String(issueId)}` };
    }

    const vcsResolved = vcs === 'github' ? 'github' : 'gitlab';

    // Resolve the -R/--repo host-pinning spec ONCE, reused by both the fetch
    // and the strip call below (#839). undefined ⇒ no -R is appended anywhere.
    const spec = resolveRepoSpecFn({ repoRoot, vcs: vcsResolved });

    // Step 1: fetch current labels.
    const { ok, labels, stderr } = fetchLabels({ issueId: id, vcs: vcsResolved, spec });
    if (!ok) {
      return { stripped: [], error: `failed to fetch labels: ${stderr}` };
    }

    // Step 2: filter to status:* only.
    const toStrip = labels.filter((l) => STATUS_LABEL_RE.test(l));
    if (toStrip.length === 0) {
      // Idempotent no-op — no status labels present.
      return { stripped: [] };
    }

    // Step 3: strip via CLI.
    let stripRes;
    if (vcsResolved === 'github') {
      // `gh issue edit <NUMBER> --remove-label label1 --remove-label label2 ...`
      const args = ['issue', 'edit', id];
      for (const label of toStrip) {
        args.push('--remove-label', label);
      }
      if (spec) args.push('-R', spec);
      stripRes = runCli('gh', args);
    } else {
      // `glab issue update <IID> --unlabel label1,label2,...`
      // glab accepts comma-separated list in a single --unlabel flag value.
      const args = ['issue', 'update', id, '--unlabel', toStrip.join(',')];
      if (spec) args.push('-R', spec);
      stripRes = runCli('glab', args);
    }

    if (!stripRes.ok) {
      return {
        stripped: [],
        error: `label strip CLI failed: ${stripRes.stderr.trim() || 'unknown error'}`,
      };
    }

    return { stripped: toStrip };
  } catch (err) {
    const msg = err && err.message ? String(err.message) : 'unknown error';
    return { stripped: [], error: msg };
  }
}
