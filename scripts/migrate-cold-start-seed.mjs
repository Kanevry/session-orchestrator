#!/usr/bin/env node
/**
 * migrate-cold-start-seed.mjs — one-shot seeder for the welcome-banner-pending marker.
 *
 * Part of the Learning-Memory Modernization initiative (epic #498, issue #507).
 *
 * Seeds a zero-byte `.orchestrator/welcome-banner-pending` marker file in dormant
 * repos so the cold-start detector can emit a welcome banner on the next
 * Claude Code open. The marker is intentionally untracked (lives under
 * `.orchestrator/`, which is typically gitignored) and auto-deletes on first
 * session-end.
 *
 * Idempotency rules — a repo is SKIPPED when any of these hold:
 *   - The marker file already exists (`.orchestrator/welcome-banner-pending`).
 *   - The repo has at least one session recorded in
 *     `.orchestrator/metrics/sessions.jsonl` (i.e. it is not dormant).
 *   - The `.orchestrator/` directory is missing entirely (defensive — the
 *     bootstrap-gate has not run yet, marker would land in the wrong place).
 *
 * Repos missing a `.git/` directory are still seeded — the marker lives
 * outside git anyway.
 *
 * Usage:
 *   node scripts/migrate-cold-start-seed.mjs [--dry-run|--apply] [--repos <comma,list>] [--json] [--help]
 *
 * Target repo resolution (in priority order):
 *   1. --repos <comma,list>             (explicit CLI override)
 *   2. dormant-repos: [...] in
 *      ~/.config/session-orchestrator/vault-migration-rules.yaml
 *   3. <none> → fail with non-zero exit and a hint to the config file.
 *
 * Flags:
 *   --dry-run        Classify each target repo, do not write anything (DEFAULT).
 *   --apply          Write the marker file to each eligible repo.
 *   --repos <list>   Comma-separated repo paths (absolute or ~-prefixed).
 *   --json           Emit one JSON record per repo plus a final summary record.
 *   --help, -h       Print this help text to stderr and exit 0.
 *
 * Exit codes:
 *   0  Success (even when 0 repos were seeded — idempotent NO-OP is fine).
 *   1  Input/argument error (incl. no targets given anywhere).
 *   2  I/O error (filesystem failure mid-apply).
 *
 * Output (stdout — unless --json):
 *   migrate-cold-start-seed: <abbrev-path>: <status> [dry-run|applied]
 *
 * Summary line (stderr):
 *   migrate-cold-start-seed: N seeded, M already-seeded, K skipped [dry-run|applied]
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { promises as fs } from 'node:fs';
import {
  loadVaultMigrationRules,
  VAULT_MIGRATION_RULES_PATH,
} from './lib/vault-migration-rules.mjs';
import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';

const MARKER_REL = '.orchestrator/welcome-banner-pending';
const ORCH_REL = '.orchestrator';
const SESSIONS_REL = '.orchestrator/metrics/sessions.jsonl';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

// CLI parsing via the shared helper (#510). Migrated from the previous
// ad-hoc args.includes()/knownFlags-Set pattern — same behaviour, single
// source for unknown-flag rejection (exit 1) and `--json`/`--dry-run`/`--apply`
// conventions. Per-script semantics (mutex check, --repos comma-split done
// at the use site) remain in this file.
let parsedFlags;
try {
  parsedFlags = parseColumnFlags({
    knownBool: {
      apply: false,
      'dry-run': false,
      json: false,
      help: { short: 'h', default: false },
    },
    knownString: { repos: null },
  });
} catch (err) {
  if (err instanceof CliFlagError) {
    // Preserve the legacy "unknown flag" prose (the prior knownFlags-Set
    // implementation used that wording; tests at
    // tests/scripts/migrate-cold-start-seed.test.mjs assert against it).
    // node:util parseArgs emits "Unknown option '--foo'" — map to legacy.
    const legacy = err.message.replace(/^Unknown option/, 'unknown flag');
    process.stderr.write(`migrate-cold-start-seed: ${legacy}\n`);
    process.exit(1);
  }
  throw err;
}

const helpFlag = parsedFlags.values.help === true;
if (helpFlag) {
  process.stderr.write(`Usage: migrate-cold-start-seed.mjs [--dry-run|--apply] [--repos <comma,list>] [--json] [--help]

Seeds a zero-byte .orchestrator/welcome-banner-pending marker in dormant repos
so the cold-start detector can emit a welcome banner on the next Claude Code
open. The marker is untracked and auto-deletes on first session-end.

Options:
  --dry-run        Classify each target repo, do not write anything (DEFAULT).
  --apply          Write the marker file to each eligible repo.
  --repos <list>   Comma-separated repo paths (absolute or ~-prefixed).
                   When omitted, falls back to dormant-repos: [...] in
                   ~/.config/session-orchestrator/vault-migration-rules.yaml.
  --json           Emit one JSON record per repo plus a final summary record.
  --help, -h       Print this help text to stderr and exit 0.

Idempotency — a repo is SKIPPED when any of these hold:
  - The marker already exists.
  - sessions.jsonl has at least one line (repo is not dormant).
  - The .orchestrator/ directory is missing (bootstrap-gate has not run).

Repos without a .git/ directory are still seeded — the marker lives outside
git anyway.

Examples:
  # Default dry-run against the 6 hardcoded repos
  node scripts/migrate-cold-start-seed.mjs

  # Apply to the default repo list
  node scripts/migrate-cold-start-seed.mjs --apply

  # Dry-run against a custom repo list, JSON output
  node scripts/migrate-cold-start-seed.mjs --repos ~/foo,~/bar --json

Exit codes:  0 success  1 input error  2 I/O error
`);
  process.exit(0);
}

const applyFlag = parsedFlags.values.apply === true;
const dryRunFlag = parsedFlags.values['dry-run'] === true;
const jsonFlag = parsedFlags.values.json === true;

if (applyFlag && dryRunFlag) {
  process.stderr.write('migrate-cold-start-seed: --dry-run and --apply are mutually exclusive\n');
  process.exit(1);
}

// Default is dry-run (matches scripts/migrate-learnings-jsonl.mjs convention).
const dryRun = !applyFlag;

// `--repos` is kept as the raw comma-separated string here (split later, at
// the use site below). Preserves the legacy "null when omitted" contract that
// downstream branches depend on.
const reposArg = parsedFlags.values.repos ?? null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function abbrevPath(p) {
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

async function pathExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function isDir(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function sessionsHasContent(sessionsPath) {
  try {
    const raw = await fs.readFile(sessionsPath, 'utf8');
    return raw.split('\n').some((l) => l.trim().length > 0);
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Classify a single repo and (when applying) write the marker atomically.
 * Returns { repo, status, gitTracked, reason? }.
 *
 * Possible statuses:
 *   already-seeded            marker already exists
 *   skip-active               sessions.jsonl has ≥1 line
 *   skip-not-bootstrapped     .orchestrator/ missing
 *   skip-permission-denied    fs error reading/writing
 *   skip-missing              repo path itself does not exist
 *   would-seed                dry-run, marker absent and eligible
 *   seeded                    --apply, marker successfully written
 */
async function processRepo(repo, { apply }) {
  const repoExists = await isDir(repo);
  if (!repoExists) {
    return { repo, status: 'skip-missing', gitTracked: false, reason: 'repo path does not exist' };
  }

  const gitTracked = await isDir(join(repo, '.git'));

  const orchDir = join(repo, ORCH_REL);
  const orchExists = await isDir(orchDir);
  if (!orchExists) {
    return { repo, status: 'skip-not-bootstrapped', gitTracked, reason: '.orchestrator/ missing' };
  }

  const markerPath = join(repo, MARKER_REL);
  let markerExists;
  try {
    markerExists = await pathExists(markerPath);
  } catch (err) {
    return {
      repo,
      status: 'skip-permission-denied',
      gitTracked,
      reason: `stat marker: ${err.message}`,
    };
  }

  if (markerExists) {
    return { repo, status: 'already-seeded', gitTracked };
  }

  // Sessions.jsonl liveness check — even if marker is absent, an active repo
  // should not get a "welcome" banner.
  const sessionsPath = join(repo, SESSIONS_REL);
  try {
    if (await sessionsHasContent(sessionsPath)) {
      return { repo, status: 'skip-active', gitTracked, reason: 'sessions.jsonl has ≥1 line' };
    }
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return {
        repo,
        status: 'skip-permission-denied',
        gitTracked,
        reason: `read sessions.jsonl: ${err.message}`,
      };
    }
    // Any other error: surface as I/O failure.
    throw err;
  }

  if (!apply) {
    return { repo, status: 'would-seed', gitTracked };
  }

  // --apply: write zero-byte marker atomically (tmp + rename).
  try {
    await fs.mkdir(dirname(markerPath), { recursive: true });
    const tmp = `${markerPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, '', { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tmp, markerPath);
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      return {
        repo,
        status: 'skip-permission-denied',
        gitTracked,
        reason: `write marker: ${err.message}`,
      };
    }
    // Hard I/O failure — abort with exit 2.
    process.stderr.write(
      `migrate-cold-start-seed: ERROR failed to write ${markerPath}: ${err.message}\n`
    );
    process.exit(2);
  }

  return { repo, status: 'seeded', gitTracked };
}

// ---------------------------------------------------------------------------
// Resolve target repo list
// ---------------------------------------------------------------------------

let targetRepos;
if (reposArg) {
  targetRepos = reposArg
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0)
    .map(resolveHome);

  if (targetRepos.length === 0) {
    process.stderr.write('migrate-cold-start-seed: --repos given but empty after parsing\n');
    process.exit(1);
  }
} else {
  const { config, errors } = loadVaultMigrationRules();
  for (const e of errors) {
    process.stderr.write(`migrate-cold-start-seed: config: ${e}\n`);
  }
  if (config.dormantRepos.length === 0) {
    process.stderr.write(
      'migrate-cold-start-seed: no target repos.\n' +
        `  Either pass --repos <comma,list>, or list paths under 'dormant-repos:' in\n` +
        `  ${VAULT_MIGRATION_RULES_PATH}\n`
    );
    process.exit(1);
  }
  targetRepos = config.dormantRepos.map(resolveHome);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const modeLabel = dryRun ? 'dry-run' : 'applied';
const results = [];

for (const repo of targetRepos) {
  const result = await processRepo(repo, { apply: !dryRun });
  results.push(result);

  const shortPath = abbrevPath(result.repo);
  const reasonSuffix = result.reason ? ` (${result.reason})` : '';

  if (jsonFlag) {
    process.stdout.write(
      JSON.stringify({
        kind: 'repo',
        repo: result.repo,
        short: shortPath,
        status: result.status,
        gitTracked: result.gitTracked,
        reason: result.reason ?? null,
        mode: modeLabel,
      }) + '\n'
    );
  } else {
    process.stdout.write(
      `migrate-cold-start-seed: ${shortPath}: ${result.status}${reasonSuffix} [${modeLabel}]\n`
    );
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const counts = {
  seeded: 0,
  'would-seed': 0,
  'already-seeded': 0,
  'skip-active': 0,
  'skip-not-bootstrapped': 0,
  'skip-permission-denied': 0,
  'skip-missing': 0,
};
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
}

// "seeded" reflects actual writes in --apply mode; in --dry-run we surface
// "would-seed" as the actionable count.
const seededCount = dryRun ? counts['would-seed'] : counts['seeded'];
const alreadySeeded = counts['already-seeded'];
const skipped =
  counts['skip-active'] +
  counts['skip-not-bootstrapped'] +
  counts['skip-permission-denied'] +
  counts['skip-missing'];

const summaryLine =
  `migrate-cold-start-seed: ${seededCount} ${dryRun ? 'would-seed' : 'seeded'}, ` +
  `${alreadySeeded} already-seeded, ${skipped} skipped [${modeLabel}]`;

if (jsonFlag) {
  process.stdout.write(
    JSON.stringify({
      kind: 'summary',
      mode: modeLabel,
      counts,
      seeded: seededCount,
      alreadySeeded,
      skipped,
      total: results.length,
    }) + '\n'
  );
}

process.stderr.write(summaryLine + '\n');

process.exit(0);
