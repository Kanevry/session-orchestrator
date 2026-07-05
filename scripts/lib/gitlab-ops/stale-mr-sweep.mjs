/**
 * stale-mr-sweep.mjs — list open MRs/PRs older than a staleness threshold.
 *
 * Replicates the glab/gh shell-out pattern from
 * `scripts/lib/autopilot/mr-draft.mjs` (execFile, array args, shell: false —
 * SEC-006) and the staleness-math convention from
 * `scripts/lib/gitlab-portfolio/aggregator.mjs` (`summarizeRepo`):
 * an item is stale when `now - <date> > thresholdDays * 86_400_000`
 * (strictly greater than — an item exactly `thresholdDays` old is NOT
 * stale; see `filterStaleMRs` boundary note below).
 *
 * Exports:
 *   filterStaleMRs(mrs, opts)          — pure filter over an already-fetched array
 *   findStaleMRs(opts)                 — fetch (single repo) + filter
 *   findStaleMRsMultiRepo(opts)        — fetch + filter across vault-registered repos
 *   main(argv, deps)                   — thin CLI wrapper (guarded, see bottom of file)
 *
 * Security: execFile with array args, `shell: false`, bounded timeout — never
 * interpolates repo/branch identifiers into a shell string (SEC-006).
 */

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

import { detectVcsForRepo, discoverVaultRepos } from '../gitlab-portfolio/vcs-detect.mjs';

const realExecFile = promisify(execFileCb);

/** Default staleness threshold, in days. */
export const DEFAULT_THRESHOLD_DAYS = 14;

/** Default per-invocation CLI timeout, in ms. */
export const DEFAULT_TIMEOUT_MS = 8_000;

/** Default `gh pr list --json` field list (mirrors GROUNDED FACTS spec). */
const GH_PR_JSON_FIELDS = 'number,title,url,createdAt,updatedAt,author,headRefName';

// ---------------------------------------------------------------------------
// filterStaleMRs — pure core
// ---------------------------------------------------------------------------

/**
 * Filter an already-fetched array of raw glab/gh MR/PR objects down to the
 * stale subset.
 *
 * Accepts the raw CLI JSON shape directly — no normalization step required.
 * Date fields are read with dual snake_case/camelCase fallback
 * (`mr.updated_at ?? mr.updatedAt`), mirroring aggregator.mjs's
 * `normalizeIssue` convention.
 *
 * Boundary (documented, tested): an item is stale when its age is STRICTLY
 * GREATER than the threshold (`age > thresholdMs`). An item exactly
 * `thresholdDays` old is NOT stale — this is the exclusive-at-boundary
 * convention already used by `aggregator.mjs`'s `summarizeRepo` staleness
 * math (`nowMs - updatedTs > staleThresholdMs`).
 *
 * @param {Array<object>} mrs - raw MR/PR objects (glab or gh JSON shape)
 * @param {object} [opts]
 * @param {number} [opts.thresholdDays=14] - staleness threshold in days
 * @param {number} [opts.now=Date.now()] - reference "now" timestamp (ms epoch) — injectable for deterministic tests
 * @param {'created'|'updated'} [opts.field='updated'] - which date field drives the age calculation
 * @returns {Array<object>} the stale subset, in the original order
 */
export function filterStaleMRs(mrs, opts = {}) {
  const { thresholdDays = DEFAULT_THRESHOLD_DAYS, now = Date.now(), field = 'updated' } = opts;

  if (!Array.isArray(mrs)) return [];

  const thresholdMs = thresholdDays * 86_400_000;

  return mrs.filter((mr) => {
    if (!mr || typeof mr !== 'object') return false;

    const dateStr = field === 'created' ? (mr.created_at ?? mr.createdAt) : (mr.updated_at ?? mr.updatedAt);
    if (!dateStr) return false;

    const ts = Date.parse(dateStr);
    if (Number.isNaN(ts)) return false;

    const ageMs = now - ts;
    return ageMs > thresholdMs;
  });
}

// ---------------------------------------------------------------------------
// Single-repo fetch
// ---------------------------------------------------------------------------

/**
 * Fetch open MRs/PRs for a single repo and return the stale subset.
 *
 * VCS resolution priority:
 *   1. `opts.vcs` if explicitly provided ('gitlab' | 'github')
 *   2. `detectVcsForRepo({ repo })` if `opts.repo` is provided
 *   3. 'gitlab' (cross-project default per CLAUDE.md / AGENTS.md Session Config `vcs: gitlab`) —
 *      only reached when neither vcs nor repo is provided, i.e. the caller
 *      intends "the repo at `repoRoot`", and glab/gh both auto-detect the
 *      remote from the local git checkout when no --repo flag is given.
 *
 * Never throws: CLI failure (missing binary, non-zero exit, timeout) and
 * malformed JSON output both resolve to a graceful `{ ok: false, error, stale: [], total: 0 }`
 * result plus a diagnostic line on stderr — never an unhandled rejection.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot=process.cwd()] - cwd for the CLI invocation (used for local-checkout auto-detection by glab/gh)
 * @param {string} [opts.repo] - explicit "owner/repo" or GitLab path identifier; when set, passed via `--repo`
 * @param {'gitlab'|'github'} [opts.vcs] - explicit VCS override (skips detectVcsForRepo)
 * @param {number} [opts.thresholdDays=14]
 * @param {'created'|'updated'} [opts.field='updated']
 * @param {Function} [opts.exec] - injectable execFile-like function `(cmd, args, options) => Promise<{stdout, stderr}>`; defaults to the real promisified execFile
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.timeoutMs=8000]
 * @returns {Promise<
 *   { ok: true, repo: string, vcs: 'gitlab'|'github', total: number, stale: Array<object> } |
 *   { ok: false, error: string, repo: string|null, vcs: 'gitlab'|'github'|null, total: 0, stale: [] }
 * >}
 */
export async function findStaleMRs(opts = {}) {
  const {
    repoRoot = process.cwd(),
    repo,
    vcs: vcsOverride,
    thresholdDays = DEFAULT_THRESHOLD_DAYS,
    field = 'updated',
    exec = realExecFile,
    now = Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const resolvedVcs = vcsOverride ?? (repo ? detectVcsForRepo({ repo }) : 'gitlab');

  if (resolvedVcs !== 'gitlab' && resolvedVcs !== 'github') {
    const msg = `stale-mr-sweep: could not resolve VCS for repo "${repo}" — pass { vcs: 'gitlab'|'github' } explicitly`;
    process.stderr.write(`${msg}\n`);
    return { ok: false, error: msg, repo: repo ?? null, vcs: null, total: 0, stale: [] };
  }

  let cmd;
  let args;
  if (resolvedVcs === 'gitlab') {
    cmd = 'glab';
    args = ['mr', 'list', '--state', 'opened', '--output', 'json'];
  } else {
    cmd = 'gh';
    args = ['pr', 'list', '--state', 'open', '--json', GH_PR_JSON_FIELDS];
  }
  if (repo) {
    args.push('--repo', repo);
  }

  const repoLabel = repo ?? repoRoot;

  let stdout;
  try {
    const result = await exec(cmd, args, {
      shell: false,
      timeout: timeoutMs,
      cwd: repoRoot,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result?.stdout ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`stale-mr-sweep: ${cmd} failed for ${repoLabel}: ${msg}\n`);
    return { ok: false, error: msg, repo: repoLabel, vcs: resolvedVcs, total: 0, stale: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const msg = `${cmd} output could not be parsed as JSON: ${err instanceof Error ? err.message : String(err)}`;
    process.stderr.write(`stale-mr-sweep: ${msg} (repo: ${repoLabel})\n`);
    return { ok: false, error: msg, repo: repoLabel, vcs: resolvedVcs, total: 0, stale: [] };
  }

  if (!Array.isArray(parsed)) {
    const msg = `expected array from ${cmd}, got ${typeof parsed}`;
    process.stderr.write(`stale-mr-sweep: ${msg} (repo: ${repoLabel})\n`);
    return { ok: false, error: msg, repo: repoLabel, vcs: resolvedVcs, total: 0, stale: [] };
  }

  const stale = filterStaleMRs(parsed, { thresholdDays, now, field });

  return {
    ok: true,
    repo: repoLabel,
    vcs: resolvedVcs,
    total: parsed.length,
    stale,
  };
}

// ---------------------------------------------------------------------------
// Multi-repo (vault-wide) sweep
// ---------------------------------------------------------------------------

/**
 * Discover vault-registered repos and run `findStaleMRs` against each.
 * Per-repo failures do not abort the sweep — they are recorded as
 * `{ ok: false, ... }` entries alongside successful ones (mirrors
 * `aggregator.mjs`'s `fetchIssuesMultiRepo` resilience convention).
 *
 * @param {object} opts
 * @param {string} opts.vaultDir
 * @param {number} [opts.thresholdDays=14]
 * @param {'created'|'updated'} [opts.field='updated']
 * @param {Function} [opts.exec]
 * @param {number} [opts.now=Date.now()]
 * @param {number} [opts.timeoutMs=8000]
 * @param {typeof discoverVaultRepos} [opts.discoverRepos] - injectable for tests
 * @returns {Promise<Array<{ slug: string } & Awaited<ReturnType<typeof findStaleMRs>>>>}
 */
export async function findStaleMRsMultiRepo(opts = {}) {
  const {
    vaultDir,
    thresholdDays = DEFAULT_THRESHOLD_DAYS,
    field = 'updated',
    exec = realExecFile,
    now = Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    discoverRepos = discoverVaultRepos,
  } = opts;

  const repos = await discoverRepos({ vaultDir });
  if (!Array.isArray(repos) || repos.length === 0) return [];

  const results = await Promise.all(
    repos.map((r) =>
      findStaleMRs({ repo: r.repo, vcs: r.vcs, thresholdDays, field, exec, now, timeoutMs }),
    ),
  );

  return repos.map((r, i) => ({ slug: r.slug, ...results[i] }));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const HELP_TEXT = `stale-mr-sweep — list open MRs/PRs older than a staleness threshold

USAGE
  node scripts/lib/gitlab-ops/stale-mr-sweep.mjs [flags]

FLAGS
  --threshold-days <N>   Staleness threshold in days (default: 14).
  --field <created|updated>  Which date drives the age calc (default: updated).
  --repo <owner/repo>     Target a specific repo (passed via --repo to glab/gh).
  --vcs <gitlab|github>   Override VCS auto-detection.
  --all-vault             Sweep every vault-registered repo instead of a single repo.
  --vault-dir <path>      Vault directory for --all-vault (default: ~/Projects/vault).
  --json                  Emit machine-readable JSON instead of a human summary.
  -h, --help              Show this help text and exit.

EXIT CODES
  0  Success (including zero stale MRs found)
  1  User / input error (bad flag value, missing required value)
  2  System error (glab/gh missing, CLI failure, malformed output)
`;

/**
 * Parse CLI argv into a flags object. Returns `{ error }` on a bad flag.
 * @param {string[]} argv
 * @returns {{ error?: string } | {
 *   help: boolean, json: boolean, allVault: boolean,
 *   thresholdDays: number, field: 'created'|'updated',
 *   repo: string|null, vcs: 'gitlab'|'github'|null, vaultDir: string|null,
 * }}
 */
function parseArgs(argv) {
  const flags = {
    help: false,
    json: false,
    allVault: false,
    thresholdDays: DEFAULT_THRESHOLD_DAYS,
    field: 'updated',
    repo: null,
    vcs: null,
    vaultDir: null,
  };

  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    switch (arg) {
      case '--help':
      case '-h':
        flags.help = true;
        break;
      case '--json':
        flags.json = true;
        break;
      case '--all-vault':
        flags.allVault = true;
        break;
      case '--threshold-days': {
        const next = list[i + 1];
        const parsed = Number(next);
        if (!next || !Number.isFinite(parsed) || parsed <= 0) {
          return { error: `--threshold-days requires a positive number (got: ${next ?? '<missing>'})` };
        }
        flags.thresholdDays = parsed;
        i++;
        break;
      }
      case '--field': {
        const next = list[i + 1];
        if (next !== 'created' && next !== 'updated') {
          return { error: `--field must be 'created' or 'updated' (got: ${next ?? '<missing>'})` };
        }
        flags.field = next;
        i++;
        break;
      }
      case '--repo': {
        const next = list[i + 1];
        if (!next || next.startsWith('--')) {
          return { error: '--repo requires a value' };
        }
        flags.repo = next;
        i++;
        break;
      }
      case '--vcs': {
        const next = list[i + 1];
        if (next !== 'gitlab' && next !== 'github') {
          return { error: `--vcs must be 'gitlab' or 'github' (got: ${next ?? '<missing>'})` };
        }
        flags.vcs = next;
        i++;
        break;
      }
      case '--vault-dir': {
        const next = list[i + 1];
        if (!next || next.startsWith('--')) {
          return { error: '--vault-dir requires a value' };
        }
        flags.vaultDir = next;
        i++;
        break;
      }
      default:
        return { error: `unknown argument: ${arg}` };
    }
  }

  return flags;
}

/**
 * Thin CLI entry point over `findStaleMRs` / `findStaleMRsMultiRepo`.
 *
 * @param {string[]} argv
 * @param {object} [deps] - injectable dependencies for tests
 * @returns {Promise<{ exitCode: number }>}
 */
export async function main(argv, deps = {}) {
  const {
    exec = realExecFile,
    now = Date.now(),
    repoRoot = process.cwd(),
    discoverRepos = discoverVaultRepos,
    homedir = () => process.env.HOME ?? '',
  } = deps;

  const flags = parseArgs(argv);

  if (flags.error) {
    process.stderr.write(`stale-mr-sweep: ${flags.error}\n`);
    process.stderr.write('Run with --help for usage.\n');
    return { exitCode: 1 };
  }

  if (flags.help) {
    process.stdout.write(HELP_TEXT);
    return { exitCode: 0 };
  }

  if (flags.allVault) {
    const vaultDir = flags.vaultDir ?? `${homedir()}/Projects/vault`;
    const results = await findStaleMRsMultiRepo({
      vaultDir,
      thresholdDays: flags.thresholdDays,
      field: flags.field,
      exec,
      now,
      discoverRepos,
    });

    if (flags.json) {
      process.stdout.write(`${JSON.stringify(results)}\n`);
    } else {
      for (const r of results) {
        if (!r.ok) {
          process.stderr.write(`stale-mr-sweep: WARN: ${r.slug} — ${r.error}\n`);
          continue;
        }
        process.stdout.write(`${r.slug} (${r.vcs}): ${r.stale.length} stale / ${r.total} open\n`);
      }
    }
    return { exitCode: 0 };
  }

  const result = await findStaleMRs({
    repoRoot,
    repo: flags.repo,
    vcs: flags.vcs ?? undefined,
    thresholdDays: flags.thresholdDays,
    field: flags.field,
    exec,
    now,
  });

  if (!result.ok) {
    // Diagnostic already written to stderr by findStaleMRs.
    return { exitCode: 2 };
  }

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `stale-mr-sweep: ${result.stale.length} stale / ${result.total} open (${result.vcs}, threshold ${flags.thresholdDays}d)\n`,
    );
    for (const mr of result.stale) {
      const iid = mr.iid ?? mr.number ?? '?';
      const title = mr.title ?? '(no title)';
      process.stdout.write(`  !${iid} — ${title}\n`);
    }
  }

  return { exitCode: 0 };
}

// ── CLI guard — prevent process.exit during test-time imports ─────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((result) => {
      process.exit(result.exitCode);
    })
    .catch((err) => {
      process.stderr.write(`stale-mr-sweep: unexpected error: ${err?.stack ?? err}\n`);
      process.exit(2);
    });
}
