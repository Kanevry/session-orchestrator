#!/usr/bin/env node
/**
 * run-migrate-v2-cross-repo.mjs — cross-repo Migrate-CLI v2 runner.
 *
 * Walks a list of repos, applies the v2 migration to each repo's learnings.jsonl,
 * and reports pre/post invalid-rate per repo — plus, per repo and in the
 * aggregate, the count of invalid records per validation error class before and
 * after migration (`errorClassesPre` / `errorClassesPost`, GitHub #69 / GitLab
 * #1446). An error class is the validateLearning message up to `, got:`
 * (e.g. `scope must be one of local|private|public`), so a dry run shows which
 * failure kinds the migration fixes and which remain.
 *
 * Usage:
 *   node scripts/run-migrate-v2-cross-repo.mjs [--repos <comma-list>] [--apply] [--json] [--out <path>]
 *
 * Flags:
 *   --repos <comma-list>  Comma-separated repo paths (absolute or ~-prefixed).
 *                         When omitted, uses the hardcoded ROLLOUT_REPOS list.
 *   --apply               Write migrated records back to each file (atomic),
 *                         under that store's lock (`withLearningsLock`, the
 *                         `<store>.lock` every learnings writer takes), so a
 *                         live session appending in that repo is never lost.
 *                         DEFAULT is dry-run (no writes, no lock).
 *   --json                Output machine-readable JSON instead of Markdown table.
 *   --out <path>          Write output to file instead of stdout.
 *
 * Exit codes:
 *   0  Success (including repos with no learnings.jsonl — gracefully skipped)
 *   1  Input/argument error
 *   2  I/O error — incl. a store lock not acquired under --apply: that repo
 *      is left unwritten and reported `status: 'error'`, the run continues
 *      with the next repo, and exits 2 at the end
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  migrateLegacyLearning,
  validateLearning,
} from './lib/learnings.mjs';
import { LearningsLockError, withLearningsLock } from './lib/learnings/io.mjs';
import { getCrossRepoProjects, getConfinementRoot } from './lib/config/cross-repo.mjs';
import { validatePathInsideProject } from './lib/path-utils.mjs';

const LEARNINGS_REL = '.orchestrator/metrics/learnings.jsonl';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const helpFlag = args.includes('--help') || args.includes('-h');
if (helpFlag) {
  process.stdout.write(`Usage: run-migrate-v2-cross-repo.mjs [--repos <comma-list>] [--apply] [--json] [--out <path>]

Options:
  --repos <comma-list>  Comma-separated repo paths (absolute or ~-prefixed).
                        Defaults to the 16-repo ROLLOUT_REPOS list from #305.
  --apply               Write migrated files back (default: dry-run, no writes).
  --json                Emit JSON instead of Markdown table.
  --out <path>          Write output to file instead of stdout.

Exit codes:  0 success  1 input error  2 I/O error
`);
  process.exit(0);
}

const applyFlag = args.includes('--apply');
const jsonFlag = args.includes('--json');

const reposIdx = args.indexOf('--repos');
const reposArg =
  reposIdx !== -1 && args[reposIdx + 1] ? args[reposIdx + 1] : null;

const outIdx = args.indexOf('--out');
const outPath =
  outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

// ---------------------------------------------------------------------------
// Resolve repos list
// ---------------------------------------------------------------------------

function resolveHome(p) {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// Resolve the repo list: --repos flag wins; otherwise use Session Config.
// If neither source provides repos, NO-OP cleanly (exit 0).
let repos;

if (reposArg) {
  repos = reposArg
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map(resolveHome);

  if (repos.length === 0) {
    process.stderr.write('run-migrate-v2: no repos to process\n');
    process.exit(1);
  }
} else {
  // Config-driven — resolved from the shared cross-repo accessor (#478).
  const configProjects = await getCrossRepoProjects();

  if (configProjects.length === 0) {
    process.stderr.write(
      'cross-repo: no projects configured (set cross-repo.projects in Session Config) — nothing to do.\n'
    );
    process.exit(0);
  }

  const migrateRoot = getConfinementRoot();
  repos = configProjects
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map(resolveHome)
    .filter((absPath) => {
      const guard = validatePathInsideProject(absPath, migrateRoot);
      if (!guard.ok) {
        process.stderr.write(
          `run-migrate-v2: WARN rejecting confined-path violation for ${JSON.stringify(absPath)} (reason: ${guard.reason})\n`
        );
        return false;
      }
      return true;
    });
}

// ---------------------------------------------------------------------------
// Per-repo migration logic
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RepoResult
 * @property {string} repo       - absolute repo path
 * @property {string} status     - 'skipped' | 'dry-run' | 'applied' | 'error'
 * @property {number} total      - total records parsed
 * @property {number} invalidPre - invalid records before migration
 * @property {number} invalidPost - invalid records after migration
 * @property {number} fixedByV2  - records that became valid after migration
 * @property {number} malformed  - JSON-parse failures (preserved, not counted in invalid)
 * @property {Record<string, number>} errorClassesPre  - invalid-pre count per error class
 * @property {Record<string, number>} errorClassesPost - invalid-post count per error class
 * @property {string|null} error  - error message if status=error
 */

/**
 * Reduce a validateLearning error message to its class: the text before the
 * record-specific `, got: <value>` tail. Messages without that tail (e.g.
 * `learning missing required field: subject`) are their own class.
 *
 * @param {unknown} err
 * @returns {string}
 */
function errorClassOf(err) {
  const message = err instanceof Error ? err.message : String(err);
  const idx = message.indexOf(', got:');
  return idx === -1 ? message : message.slice(0, idx);
}

/**
 * @param {Record<string, number>} counts
 * @param {string} cls
 */
function bump(counts, cls) {
  counts[cls] = (counts[cls] ?? 0) + 1;
}

/**
 * A RepoResult that counted nothing.
 *
 * @param {string} repoPath
 * @param {string} status
 * @param {string|null} error
 * @returns {RepoResult}
 */
function emptyResult(repoPath, status, error) {
  return {
    repo: repoPath,
    status,
    total: 0,
    invalidPre: 0,
    invalidPost: 0,
    fixedByV2: 0,
    malformed: 0,
    errorClassesPre: {},
    errorClassesPost: {},
    error,
  };
}

/** Repos whose store lock was not acquired under --apply (nothing written there). */
const lockFailedRepos = [];

/**
 * Process a single repo. Returns a RepoResult.
 *
 * Under --apply the WHOLE read → backup → rename runs inside the store lock:
 * these are other repos, where a live session may append between this read
 * and the rename — outside the lock that record would be silently replaced.
 * A dry run writes nothing and takes no lock.
 *
 * @param {string} repoPath - resolved absolute path to the repo
 * @param {boolean} apply   - whether to write changes back
 * @returns {Promise<RepoResult>}
 */
async function processRepo(repoPath, apply) {
  const learningsPath = join(repoPath, LEARNINGS_REL);

  if (!existsSync(learningsPath)) return emptyResult(repoPath, 'skipped', null);
  if (!apply) return migrateStore(repoPath, learningsPath, false);

  try {
    return await withLearningsLock(learningsPath, () => migrateStore(repoPath, learningsPath, true));
  } catch (err) {
    if (!(err instanceof LearningsLockError)) throw err;
    lockFailedRepos.push(repoPath);
    return emptyResult(repoPath, 'error', err.message);
  }
}

/**
 * Read, migrate and (when `apply`) atomically rewrite one store. Under --apply
 * the caller holds the store lock.
 *
 * @param {string} repoPath
 * @param {string} learningsPath
 * @param {boolean} apply
 * @returns {RepoResult}
 */
function migrateStore(repoPath, learningsPath, apply) {
  // Read
  let raw;
  try {
    raw = readFileSync(learningsPath, 'utf8');
  } catch (err) {
    return emptyResult(repoPath, 'error', `read failed: ${err.message}`);
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  let malformed = 0;
  let invalidPre = 0;
  let invalidPost = 0;
  let fixedByV2 = 0;
  /** @type {Record<string, number>} */
  const errorClassesPre = {};
  /** @type {Record<string, number>} */
  const errorClassesPost = {};
  const outputLines = [];

  for (const line of lines) {
    // Parse
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      outputLines.push(line); // preserve malformed lines as-is
      continue;
    }

    // Pre-migration validity check
    let wasValidPre = true;
    try {
      validateLearning({ ...parsed, schema_version: parsed.schema_version ?? 1 });
    } catch (err) {
      wasValidPre = false;
      invalidPre++;
      bump(errorClassesPre, errorClassOf(err));
    }

    // Migrate
    const migrated = migrateLegacyLearning(parsed);

    // Post-migration validity check
    let isValidPost = true;
    let validatedRecord = migrated;
    try {
      validatedRecord = validateLearning({
        ...migrated,
        schema_version: migrated.schema_version ?? 1,
      });
    } catch (err) {
      isValidPost = false;
      invalidPost++;
      bump(errorClassesPost, errorClassOf(err));
    }

    if (!wasValidPre && isValidPost) {
      fixedByV2++;
    }

    // Use the migrated+validated record when valid; otherwise fall back to original
    if (isValidPost) {
      outputLines.push(JSON.stringify(validatedRecord));
    } else {
      // Preserve original line — do not discard records that still fail validation
      outputLines.push(line);
    }
  }

  const total = lines.length - malformed;

  // Write (--apply only)
  if (apply) {
    const timestamp = Date.now();
    const backupPath = `${learningsPath}.bak-cross-repo-migrate-${timestamp}`;
    try {
      // Backup original
      copyFileSync(learningsPath, backupPath);
      // Write migrated content atomically
      const body = outputLines.join('\n') + '\n';
      const tmpPath = `${learningsPath}.migrate-cross-repo-tmp-${process.pid}-${timestamp}`;
      mkdirSync(dirname(learningsPath), { recursive: true });
      writeFileSync(tmpPath, body, 'utf8');
      renameSync(tmpPath, learningsPath);
    } catch (err) {
      return {
        repo: repoPath,
        status: 'error',
        total,
        invalidPre,
        invalidPost,
        fixedByV2,
        malformed,
        errorClassesPre,
        errorClassesPost,
        error: `write failed: ${err.message}`,
      };
    }
  }

  return {
    repo: repoPath,
    status: apply ? 'applied' : 'dry-run',
    total,
    invalidPre,
    invalidPost,
    fixedByV2,
    malformed,
    errorClassesPre,
    errorClassesPost,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Run across all repos
// ---------------------------------------------------------------------------

// Sequential: one store lock at a time, and a lock failure in one repo never
// stops the next.
const results = [];
for (const r of repos) results.push(await processRepo(r, applyFlag));

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

const aggregate = results.reduce(
  (acc, r) => {
    acc.totalRecords += r.total;
    acc.totalFixedByV2 += r.fixedByV2;
    acc.totalStillInvalidPost += r.invalidPost;
    acc.totalMalformed += r.malformed;
    acc.totalReposProcessed += r.status !== 'skipped' ? 1 : 0;
    acc.totalReposSkipped += r.status === 'skipped' ? 1 : 0;
    for (const [cls, n] of Object.entries(r.errorClassesPre)) {
      acc.errorClassesPre[cls] = (acc.errorClassesPre[cls] ?? 0) + n;
    }
    for (const [cls, n] of Object.entries(r.errorClassesPost)) {
      acc.errorClassesPost[cls] = (acc.errorClassesPost[cls] ?? 0) + n;
    }
    return acc;
  },
  {
    totalRecords: 0,
    totalFixedByV2: 0,
    totalStillInvalidPost: 0,
    totalMalformed: 0,
    totalReposProcessed: 0,
    totalReposSkipped: 0,
    /** @type {Record<string, number>} */
    errorClassesPre: {},
    /** @type {Record<string, number>} */
    errorClassesPost: {},
  }
);

// ---------------------------------------------------------------------------
// Format output
// ---------------------------------------------------------------------------

function repoName(absPath) {
  return absPath.split('/').pop() ?? absPath;
}

function fmtPct(count, total) {
  if (total === 0) return '—';
  return `${count} (${((count / total) * 100).toFixed(1)}%)`;
}

/**
 * Markdown table of invalid-record counts per error class, pre vs post
 * migration. Classes are the union of both sides, sorted by pre count desc.
 *
 * @param {Record<string, number>} pre
 * @param {Record<string, number>} post
 * @returns {string[]}
 */
function errorClassTable(pre, post) {
  const classes = [...new Set([...Object.keys(pre), ...Object.keys(post)])].sort(
    (a, b) => (pre[b] ?? 0) - (pre[a] ?? 0) || a.localeCompare(b)
  );
  if (classes.length === 0) return ['_No validation errors._'];
  const rows = ['| Error class | Invalid pre | Invalid post |', '|-------------|-------------|--------------|'];
  for (const cls of classes) {
    rows.push(`| ${cls.replaceAll('|', '\\|')} | ${pre[cls] ?? 0} | ${post[cls] ?? 0} |`);
  }
  return rows;
}

function buildMarkdown(results, aggregate, mode) {
  const lines = [];
  lines.push(`# Cross-Repo Migrate-CLI v2 — ${mode} report`);
  lines.push('');
  lines.push(
    '| Repo | Total | Invalid pre | Invalid post | Fixed by v2 | Malformed | Status |'
  );
  lines.push(
    '|------|-------|-------------|--------------|-------------|-----------|--------|'
  );
  for (const r of results) {
    const name = repoName(r.repo);
    lines.push(
      `| ${name} | ${r.total} | ${fmtPct(r.invalidPre, r.total)} | ${fmtPct(r.invalidPost, r.total)} | ${r.fixedByV2} | ${r.malformed} | ${r.status}${r.error ? `: ${r.error}` : ''} |`
    );
  }
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push(`- Total records: **${aggregate.totalRecords}**`);
  lines.push(`- Fixed by v2 migration: **${aggregate.totalFixedByV2}**`);
  lines.push(`- Still invalid post-v2: **${aggregate.totalStillInvalidPost}**`);
  lines.push(`- Malformed (unparseable): **${aggregate.totalMalformed}**`);
  lines.push(`- Repos processed: **${aggregate.totalReposProcessed}**`);
  lines.push(`- Repos skipped (no learnings.jsonl): **${aggregate.totalReposSkipped}**`);
  lines.push('');
  lines.push('## Error classes (all repos)');
  lines.push('');
  lines.push(...errorClassTable(aggregate.errorClassesPre, aggregate.errorClassesPost));
  lines.push('');
  for (const r of results) {
    if (r.status === 'skipped') continue;
    lines.push(`### ${repoName(r.repo)}`);
    lines.push('');
    lines.push(...errorClassTable(r.errorClassesPre, r.errorClassesPost));
    lines.push('');
  }
  return lines.join('\n');
}

function buildJson(results, aggregate, mode) {
  return JSON.stringify({ mode, repos: results, aggregate }, null, 2);
}

const mode = applyFlag ? 'apply' : 'dry-run';
const output = jsonFlag
  ? buildJson(results, aggregate, mode)
  : buildMarkdown(results, aggregate, mode);

// ---------------------------------------------------------------------------
// Emit output
// ---------------------------------------------------------------------------

if (outPath) {
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output, 'utf8');
    process.stderr.write(`run-migrate-v2: output written to ${outPath}\n`);
  } catch (err) {
    process.stderr.write(`run-migrate-v2: ERROR writing output to ${outPath}: ${err.message}\n`);
    process.exit(2);
  }
} else {
  process.stdout.write(output + '\n');
}

// Summary to stderr
process.stderr.write(
  `run-migrate-v2: [${mode}] ${aggregate.totalReposProcessed} processed, ` +
    `${aggregate.totalReposSkipped} skipped, ` +
    `${aggregate.totalFixedByV2} fixed-by-v2, ` +
    `${aggregate.totalStillInvalidPost} still-invalid\n`
);

let exitCode = 0;
if (lockFailedRepos.length > 0) {
  process.stderr.write(
    `run-migrate-v2: ERROR learnings store lock not acquired, nothing written in ${lockFailedRepos.length} repo(s): ` +
      `${lockFailedRepos.join(', ')}\n`
  );
  exitCode = 2;
}

// #1487.15: every other `status: 'error'` (read failed / write failed) is an
// I/O error too — exit 2 as the header and --help document, never 0.
const ioFailed = results.filter((r) => r.status === 'error' && !lockFailedRepos.includes(r.repo));
if (ioFailed.length > 0) {
  process.stderr.write(
    `run-migrate-v2: ERROR I/O error in ${ioFailed.length} repo(s): ` +
      `${ioFailed.map((r) => `${r.repo} (${r.error})`).join(', ')}\n`
  );
  exitCode = 2;
}

process.exit(exitCode);
