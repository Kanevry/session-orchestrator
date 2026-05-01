#!/usr/bin/env node
/**
 * run-migrate-v2-cross-repo.mjs — cross-repo Migrate-CLI v2 runner.
 *
 * Walks a list of repos, applies the v2 migration to each repo's learnings.jsonl,
 * and reports pre/post invalid-rate per repo.
 *
 * Usage:
 *   node scripts/run-migrate-v2-cross-repo.mjs [--repos <comma-list>] [--apply] [--json] [--out <path>]
 *
 * Flags:
 *   --repos <comma-list>  Comma-separated repo paths (absolute or ~-prefixed).
 *                         When omitted, uses the hardcoded ROLLOUT_REPOS list.
 *   --apply               Write migrated records back to each file (atomic).
 *                         DEFAULT is dry-run (no writes).
 *   --json                Output machine-readable JSON instead of Markdown table.
 *   --out <path>          Write output to file instead of stdout.
 *
 * Exit codes:
 *   0  Success (including repos with no learnings.jsonl — gracefully skipped)
 *   1  Input/argument error
 *   2  I/O error
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  migrateLegacyLearning,
  validateLearning,
} from './lib/learnings.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default rollout repos — 16 repos from issue #305 / D3 audit
 * (cross-repo-warn-strict-readiness.md).
 */
const ROLLOUT_REPOS = [
  '~/Projects/launchpad-ai-factory',
  '~/Projects/Codex-Hackathon',
  '~/Projects/EventDrop.at',
  '~/Projects/GotzendorferAT',
  '~/Projects/GotzendorferV2',
  '~/Projects/LeadPipeDACH',
  '~/Projects/WalkAITalkie',
  '~/Projects/aegis',
  '~/Projects/ai-gateway',
  '~/Projects/clank',
  '~/Projects/eventdrop-render-service',
  '~/Projects/feedfoundry',
  '~/Projects/launchpad',
  '~/Projects/mail-assistant',
  '~/Projects/n8n',
  '~/Projects/projects-baseline',
];

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

const repos = (reposArg ? reposArg.split(',') : ROLLOUT_REPOS)
  .map((r) => r.trim())
  .filter((r) => r.length > 0)
  .map(resolveHome);

if (repos.length === 0) {
  process.stderr.write('run-migrate-v2: no repos to process\n');
  process.exit(1);
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
 * @property {string|null} error  - error message if status=error
 */

/**
 * Process a single repo. Returns a RepoResult.
 *
 * @param {string} repoPath - resolved absolute path to the repo
 * @param {boolean} apply   - whether to write changes back
 * @returns {RepoResult}
 */
function processRepo(repoPath, apply) {
  const learningsPath = join(repoPath, LEARNINGS_REL);

  if (!existsSync(learningsPath)) {
    return {
      repo: repoPath,
      status: 'skipped',
      total: 0,
      invalidPre: 0,
      invalidPost: 0,
      fixedByV2: 0,
      malformed: 0,
      error: null,
    };
  }

  // Read
  let raw;
  try {
    raw = readFileSync(learningsPath, 'utf8');
  } catch (err) {
    return {
      repo: repoPath,
      status: 'error',
      total: 0,
      invalidPre: 0,
      invalidPost: 0,
      fixedByV2: 0,
      malformed: 0,
      error: `read failed: ${err.message}`,
    };
  }

  const lines = raw.split('\n').filter((l) => l.trim().length > 0);

  let malformed = 0;
  let invalidPre = 0;
  let invalidPost = 0;
  let fixedByV2 = 0;
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
    } catch {
      wasValidPre = false;
      invalidPre++;
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
    } catch {
      isValidPost = false;
      invalidPost++;
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
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Run across all repos
// ---------------------------------------------------------------------------

const results = repos.map((r) => processRepo(r, applyFlag));

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
    return acc;
  },
  {
    totalRecords: 0,
    totalFixedByV2: 0,
    totalStillInvalidPost: 0,
    totalMalformed: 0,
    totalReposProcessed: 0,
    totalReposSkipped: 0,
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

process.exit(0);
