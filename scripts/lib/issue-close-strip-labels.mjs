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
 * Usage (session-end Phase 5 issue-close step) — ONE command strips, closes
 * and verifies every resolved issue:
 *
 *   node scripts/lib/issue-close-strip-labels.mjs --close --vcs gitlab 1388 1387
 *
 * It prints one JSON line per id and exits 1 when any id did not verify as
 * closed. The mechanical call exists because the earlier prose-only step
 * ("call stripStatusLabels, then close") was skipped often enough that 339
 * closed issues still carried `status:in-progress` (measured 2026-09-19).
 * `closeIssues()` is the same sequence as a library call; `stripStatusLabels()`
 * stays exported for callers that only strip.
 *
 * Auto-created by `scripts/lib/issue-close-strip-labels.mjs` (#308).
 */

import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isMainModule } from './is-main-module.mjs';
import { resolveRepoSpec } from './vcs-repo-spec.mjs';

/** Regex that matches any `status:*` label name. */
const STATUS_LABEL_RE = /^status:/;

/**
 * Run a CLI command and return { ok, stdout, stderr }. Never throws.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {typeof execFileSync} [execFile] injectable executor (tests)
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function runCli(cmd, args, execFile = execFileSync) {
  try {
    const stdout = execFile(cmd, args, {
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
 * Read an issue as JSON via `glab issue view --output json` (every field) or
 * `gh issue view --json <ghFields>` (only the named fields).
 *
 * @param {{ issueId: string, vcs: 'gitlab' | 'github', spec?: string,
 *   ghFields: string, execFile?: typeof execFileSync }} opts
 *   `spec` is the resolved `-R`/`--repo` host-pinning value (#839); omitted
 *   (undefined) means no `-R` is appended — never emit `-R undefined`.
 * @returns {{ ok: boolean, data: any, stderr: string }}
 */
function viewIssueJson({ issueId, vcs, spec, ghFields, execFile }) {
  const args =
    vcs === 'github'
      ? ['issue', 'view', issueId, '--json', ghFields]
      : ['issue', 'view', issueId, '--output', 'json'];
  if (spec) args.push('-R', spec);
  const res = runCli(vcs === 'github' ? 'gh' : 'glab', args, execFile);
  if (!res.ok) return { ok: false, data: null, stderr: res.stderr };
  try {
    return { ok: true, data: JSON.parse(res.stdout), stderr: '' };
  } catch (e) {
    return {
      ok: false,
      data: null,
      stderr: `JSON parse failed: ${e && e.message ? e.message : String(e)}`,
    };
  }
}

/**
 * Fetch the label names currently applied to an issue.
 *
 * GitHub shape: `{ labels: [{ name }] }`; GitLab shape: `{ labels: ["status:ready", ...] }`.
 *
 * @param {{ issueId: string, vcs: 'gitlab' | 'github', spec?: string, execFile?: typeof execFileSync }} opts
 * @returns {{ ok: boolean, labels: string[], stderr: string }}
 */
function fetchLabels({ issueId, vcs, spec, execFile }) {
  const { ok, data, stderr } = viewIssueJson({ issueId, vcs, spec, ghFields: 'labels', execFile });
  if (!ok) return { ok: false, labels: [], stderr };
  const toName =
    vcs === 'github'
      ? (l) => (typeof l?.name === 'string' ? l.name : String(l))
      : (l) => (typeof l === 'string' ? l : String(l));
  const labels = Array.isArray(data?.labels) ? data.labels.map(toName).filter(Boolean) : [];
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
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined,
 *   execFile?: typeof execFileSync
 * }} opts
 *   `repoRoot` defaults to `process.cwd()`. `resolveRepoSpecFn` is the
 *   injectable seam for the `-R`/`--repo` host-pinning resolution (#839) —
 *   defaults to the real `resolveRepoSpec` (shells out to `git remote
 *   get-url`); tests inject a stub instead of shelling out. `execFile`
 *   (default `execFileSync`) runs every glab/gh call.
 * @returns {Promise<{ stripped: string[], error?: string }>}
 */
export async function stripStatusLabels({
  issueId,
  vcs = 'gitlab',
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
  execFile = execFileSync,
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
    const { ok, labels, stderr } = fetchLabels({ issueId: id, vcs: vcsResolved, spec, execFile });
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
      stripRes = runCli('gh', args, execFile);
    } else {
      // `glab issue update <IID> --unlabel label1,label2,...`
      // glab accepts comma-separated list in a single --unlabel flag value.
      const args = ['issue', 'update', id, '--unlabel', toStrip.join(',')];
      if (spec) args.push('-R', spec);
      stripRes = runCli('glab', args, execFile);
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

/**
 * Strip `status:*` labels, close, and VERIFY the close for each issue id — in
 * that order, one id at a time.
 *
 * `closed` is true only when a re-read of the issue AFTER the close says
 * `state: closed` (GitLab `closed`, GitHub `CLOSED`). The close command's own
 * exit status is not trusted: a wrong project or a silent 404 can exit 0 while
 * closing nothing (gitlab-ops skill, "Close verification"). The re-read runs
 * even when the close command failed, so an issue that was already closed
 * reports `closed: true` alongside the close `error`.
 *
 * A strip failure is non-fatal: it is reported as `stripError` and the close
 * still runs. An id that is not a positive integer (an optional leading `#` is
 * accepted) gets no CLI call at all — a value starting with `-` would
 * otherwise reach glab/gh as a flag.
 *
 * @param {{
 *   ids: Array<number | string>,
 *   vcs?: 'gitlab' | 'github',
 *   repo?: string,
 *   repoRoot?: string,
 *   resolveRepoSpecFn?: (opts: { repoRoot: string, vcs: 'gitlab' | 'github' }) => string | undefined,
 *   execFile?: typeof execFileSync
 * }} opts
 *   `repo` overrides the `-R`/`--repo` spec; otherwise it is resolved once via
 *   `resolveRepoSpecFn` exactly as `stripStatusLabels` does (#839).
 * @returns {Promise<Array<{ id: string, stripped: string[], stripError?: string,
 *   closed: boolean, state: string | null, error?: string }>>}
 */
export async function closeIssues({
  ids = [],
  vcs = 'gitlab',
  repo,
  repoRoot = process.cwd(),
  resolveRepoSpecFn = resolveRepoSpec,
  execFile = execFileSync,
} = {}) {
  const vcsResolved = vcs === 'github' ? 'github' : 'gitlab';
  const spec = repo?.trim() || resolveRepoSpecFn({ repoRoot, vcs: vcsResolved });
  const cli = vcsResolved === 'github' ? 'gh' : 'glab';
  const results = [];

  for (const rawId of ids) {
    const id = String(rawId ?? '')
      .trim()
      .replace(/^#/, '');
    if (!/^[1-9]\d*$/.test(id)) {
      results.push({
        id: String(rawId),
        stripped: [],
        closed: false,
        state: null,
        error: 'invalid issue id',
      });
      continue;
    }
    const result = { id, stripped: [], closed: false, state: null };

    // 1. strip — non-fatal. The resolved spec is handed through so strip,
    //    close and verify all pin the same repo.
    const strip = await stripStatusLabels({
      issueId: id,
      vcs: vcsResolved,
      resolveRepoSpecFn: () => spec,
      execFile,
    });
    result.stripped = strip.stripped;
    if (strip.error) result.stripError = strip.error;

    // 2. close
    const closeArgs = ['issue', 'close', id];
    if (spec) closeArgs.push('-R', spec);
    const closeRes = runCli(cli, closeArgs, execFile);
    const errors = closeRes.ok
      ? []
      : [`close failed: ${closeRes.stderr.trim() || 'unknown error'}`];

    // 3. verify — the platform's state is the only evidence of a close.
    const view = viewIssueJson({
      issueId: id,
      vcs: vcsResolved,
      spec,
      ghFields: 'state',
      execFile,
    });
    if (view.ok) {
      result.state = typeof view.data?.state === 'string' ? view.data.state : null;
      result.closed = result.state?.toLowerCase() === 'closed';
      if (!result.closed) {
        errors.push(`verify: issue state is ${result.state ?? 'unknown'}, not closed`);
      }
    } else {
      errors.push(`verify failed: ${view.stderr.trim() || 'unknown error'}`);
    }
    if (errors.length) result.error = errors.join('; ');
    results.push(result);
  }
  return results;
}

const USAGE =
  'usage: issue-close-strip-labels.mjs --close [--vcs gitlab|github] [-R|--repo <spec>] <id>...';

/**
 * CLI: `--close [--vcs gitlab|github] [-R <spec>] <id>...` — one JSON line per
 * id on stdout. Exit 0 = every id verified closed, 1 = at least one did not,
 * 2 = usage error (no GitLab/GitHub call made).
 *
 * @param {string[]} [argv]
 * @returns {Promise<number>} exit code
 */
async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        close: { type: 'boolean', default: false },
        vcs: { type: 'string', default: 'gitlab' },
        repo: { type: 'string', short: 'R' },
      },
    });
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (!values.close || positionals.length === 0 || !['gitlab', 'github'].includes(values.vcs)) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  const results = await closeIssues({ ids: positionals, vcs: values.vcs, repo: values.repo });
  for (const r of results) {
    if (r.stripError) {
      process.stderr.write(
        `⚠ label strip failed for #${r.id}: ${r.stripError} — close attempted anyway\n`,
      );
    }
    process.stdout.write(`${JSON.stringify(r)}\n`);
  }
  return results.every((r) => r.closed) ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await main();
}
