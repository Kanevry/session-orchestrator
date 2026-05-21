#!/usr/bin/env node
/**
 * migrate-vault-paths.mjs — one-shot cross-repo migration for username-drift in vault/project paths.
 *
 * Fixes the username-drift bug described in PRD 2026-05-21-learning-memory-modernization F1.1:
 *   /Users/bernhardgoetzendorfer/...  →  /Users/bernhardg./...
 *
 * Only the username path segment changes; the trailing path is preserved.
 *
 * Discovery seed (W1 D1 findings):
 *   - buchhaltgenie/CLAUDE.md:125 (vault-dir-drift — critical)
 *   - buchhaltgenie/AGENTS.md:123 (vault-dir-drift)
 *   - buchhaltgenie/{CLAUDE,AGENTS}.md plan-baseline-path + pencil drift
 *   - scrapling-service/CLAUDE.md:67 (runbook path)
 *   - sven/STATUS.md:126 (broken ls example)
 *   - mail-assistant/.claude/state/STATE.md:13 (plan-file)
 *
 * Usage:
 *   node scripts/migrate-vault-paths.mjs [--dry-run|--apply] [--repos <comma,list>] [--json] [--help]
 *
 * Flags:
 *   --dry-run        Preview changes without writing (DEFAULT)
 *   --apply          Write fixes in-place (atomic: tmp + rename)
 *   --repos LIST     Comma-separated repo paths to scan; defaults to known targets
 *                    + any other ~/Projects/**\/*.md hits discovered by initial scan
 *   --json           Emit machine-readable JSONL on stdout (one record per hit)
 *   --help, -h       Show this help
 *
 * Exit codes:
 *   0  Success (including no-op)
 *   1  Input/arg error
 *   2  I/O error
 *
 * Idempotent: re-running --apply after a successful run is a no-op.
 *
 * Output (stdout — human or --json):
 *   migrate-vault-paths: <abbrev-path>:<line>: <classification> → would-fix|fixed|skipped
 *
 * Summary line (stderr):
 *   migrate-vault-paths: N files scanned, M lines fixed, K historical skipped [dry-run|applied]
 */

import { promises as fs, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OLD_USERNAME_SEGMENT = '/Users/bernhardgoetzendorfer/';
const NEW_USERNAME_SEGMENT = '/Users/bernhardg./';

const HOME = os.homedir();
const PROJECTS_ROOT = path.join(HOME, 'Projects');

const DEFAULT_TARGET_REPOS = [
  // Known operational targets from W1 D1 findings; resolved at runtime.
  // We list bare names; resolveRepoPath() walks ~/Projects/** to find them.
  'buchhaltgenie',
  'scrapling-service',
  'sven',
  'mail-assistant',
];

const EXCLUDE_GLOBS = [
  '/tests/',
  '/fixtures/',
  '/.git/',
  '/.vault-backup-',
  '/node_modules/',
  // Mutation-testing & build-temp sandboxes — these are file copies, not source
  '/.stryker-tmp/',
  '/.next/',
  '/dist/',
  '/build/',
  '/coverage/',
];

/**
 * Historical heuristic: skip rewriting these hits (still report them in dry-run
 * so reviewers see the scope). Matches:
 *   - decisions.md (session decision log)
 *   - /history/ in path (any history directory)
 *   - /archive/ or /XX-archive/ in path (vault-style archives like 90-archive/)
 *   - basename containing 'archive' (ARCHIVE-INSTRUCTIONS.md, …)
 *   - completed/snapshot session-evidence under .research/, .task-evidence/
 *     when filename includes a date stamp or "session-" prefix
 */
function isHistorical(filePath) {
  const lower = filePath.toLowerCase();
  const base = path.basename(lower);
  if (base === 'decisions.md') return true;
  if (lower.includes('/history/')) return true;
  if (lower.includes('-history/')) return true; // e.g. pricing-history/
  // Vault-style archive directories: /90-archive/, /archive/, /archived/
  if (/\/(?:\d{2}-)?archived?\//.test(lower)) return true;
  if (base.includes('archive')) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {
    help: false,
    apply: false,
    json: false,
    repos: null, // null = use defaults + auto-discover
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--json') out.json = true;
    else if (a === '--repos') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        process.stderr.write('migrate-vault-paths: --repos requires a comma-separated list\n');
        process.exit(1);
      }
      out.repos = next.split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    } else {
      process.stderr.write(`migrate-vault-paths: unknown argument: ${a}\n`);
      process.exit(1);
    }
  }
  return out;
}

function printHelp() {
  process.stdout.write(
    `Usage: migrate-vault-paths.mjs [--dry-run|--apply] [--repos <comma,list>] [--json] [--help]

Rewrites '${OLD_USERNAME_SEGMENT}' → '${NEW_USERNAME_SEGMENT}' across markdown files
under ~/Projects/, skipping tests/, fixtures/, .git/, vault-backups, and
historical contexts (decisions.md, history/, archive*).

Options:
  --dry-run            Preview changes without writing (DEFAULT)
  --apply              Write fixes in-place (atomic: tmp + rename)
  --repos LIST         Comma-separated repo names or paths to scan (overrides defaults)
  --json               Emit JSONL records on stdout (one per hit)
  --help, -h           Show this help

Exit codes:  0 success  1 input error  2 I/O error
`,
  );
}

// ---------------------------------------------------------------------------
// Repo discovery
// ---------------------------------------------------------------------------

/**
 * Resolve a repo name to an absolute path by searching ~/Projects/**.
 * If the input is already an absolute path that exists, returns it as-is.
 * Returns null when no match is found.
 */
function resolveRepoPath(nameOrPath) {
  if (path.isAbsolute(nameOrPath)) {
    return existsSync(nameOrPath) ? nameOrPath : null;
  }
  // Search up to 4 levels deep under ~/Projects/
  const result = spawnSync(
    'find',
    [PROJECTS_ROOT, '-maxdepth', '4', '-type', 'd', '-name', nameOrPath],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  const lines = result.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  // Prefer non-vault paths; the vault mirror under 01-projects/<name>/ is the wrong target.
  const nonVault = lines.find((l) => !l.includes('/vault/'));
  return nonVault ?? lines[0] ?? null;
}

/**
 * Use grep -r -l -I to find every text file under any root that contains the
 * literal old-username segment. Returns absolute file paths.
 * The -I flag excludes binary files.
 */
function findCandidateFiles(roots) {
  if (roots.length === 0) return [];
  const result = spawnSync(
    'grep',
    [
      '-r', // recursive
      '-l', // list-files-with-matches
      '-I', // skip binary
      '--include=*.md', // markdown only (CLI runbooks live in .md; STATE.md and STATUS.md included)
      OLD_USERNAME_SEGMENT,
      ...roots,
    ],
    { encoding: 'utf8' },
  );
  // grep exits 1 when no matches; both 0 and 1 are valid responses
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(`migrate-vault-paths: grep failed: ${result.stderr}\n`);
    process.exit(2);
  }
  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => !EXCLUDE_GLOBS.some((g) => p.includes(g)));
}

/**
 * Auto-discover ALL repos under ~/Projects/** that contain the literal.
 * Used in tandem with the default-target list to find drift we don't already know about.
 */
function discoverAdditionalFiles() {
  if (!existsSync(PROJECTS_ROOT)) return [];
  return findCandidateFiles([PROJECTS_ROOT]);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a single drift hit on a line.
 * - vault-dir-drift: contains `vault-dir:` AND vault-path literal
 * - path-drift: any other use of the old username
 * - historical: file is in a decisions.md / history/ / archive context
 */
function classifyHit(filePath, line) {
  if (isHistorical(filePath)) return 'historical';
  const lower = line.toLowerCase();
  if (lower.includes('vault-dir:') && line.includes(OLD_USERNAME_SEGMENT + 'Projects/vault')) {
    return 'vault-dir-drift';
  }
  return 'path-drift';
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

/**
 * Replace the old-username segment with the new one across the full text.
 * Only the username segment changes — `/Users/bernhardgoetzendorfer/Foo/bar`
 * becomes `/Users/bernhardg./Foo/bar`.
 */
function rewriteContent(content) {
  // Use split+join (no regex) so we never accidentally match a substring outside the literal.
  return content.split(OLD_USERNAME_SEGMENT).join(NEW_USERNAME_SEGMENT);
}

/**
 * Determine which lines in a file contain the literal, returning [{line: n, text, classification}].
 */
function findHits(filePath, content) {
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(OLD_USERNAME_SEGMENT)) {
      hits.push({
        line: i + 1, // 1-indexed
        text: lines[i],
        classification: classifyHit(filePath, lines[i]),
      });
    }
  }
  return hits;
}

/**
 * Atomic write: write to <path>.migrate-tmp, then rename.
 */
async function atomicWrite(filePath, content) {
  const tmp = `${filePath}.migrate-tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, filePath);
}

/**
 * Shorten a path for display: ~/Projects/<short> from absolute.
 */
function abbrev(filePath) {
  if (filePath.startsWith(HOME)) return '~' + filePath.slice(HOME.length);
  return filePath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  // Resolve the scan set: explicit --repos, or defaults + auto-discovery
  const repoRoots = [];
  if (opts.repos) {
    for (const r of opts.repos) {
      const resolved = resolveRepoPath(r);
      if (!resolved) {
        process.stderr.write(`migrate-vault-paths: WARN repo not found: ${r}\n`);
        continue;
      }
      repoRoots.push(resolved);
    }
    if (repoRoots.length === 0) {
      process.stderr.write('migrate-vault-paths: no valid repos to scan\n');
      process.exit(1);
    }
  } else {
    // Defaults: resolve known targets
    for (const name of DEFAULT_TARGET_REPOS) {
      const resolved = resolveRepoPath(name);
      if (resolved) repoRoots.push(resolved);
    }
  }

  // Initial file discovery within named repos
  let candidateFiles = findCandidateFiles(repoRoots);

  // If --repos was NOT specified, expand scan to discover anything else under ~/Projects/**
  if (!opts.repos) {
    const additional = discoverAdditionalFiles();
    const set = new Set(candidateFiles);
    for (const f of additional) set.add(f);
    candidateFiles = [...set];
  }

  candidateFiles.sort();

  let totalScanned = 0;
  let totalLinesFixed = 0;
  let totalHistoricalSkipped = 0;
  let totalPermissionErrors = 0;

  for (const filePath of candidateFiles) {
    // Skip if path matches an exclude glob (defense-in-depth; grep filter already applied)
    if (EXCLUDE_GLOBS.some((g) => filePath.includes(g))) continue;

    let content;
    try {
      // Skip symlinks (safer than dereferencing during a rewrite)
      const lst = await fs.lstat(filePath);
      if (lst.isSymbolicLink()) {
        emit(opts, {
          action: 'skipped',
          reason: 'symlink',
          file: filePath,
          line: null,
          classification: null,
        });
        continue;
      }
      content = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      totalPermissionErrors++;
      emit(opts, {
        action: 'skipped',
        reason: `read-error: ${err.message}`,
        file: filePath,
        line: null,
        classification: null,
      });
      continue;
    }

    totalScanned++;
    const hits = findHits(filePath, content);
    if (hits.length === 0) continue;

    // Decide per-file: if every hit is historical → skip the whole file.
    // Otherwise, rewrite the whole file (split+join is global) — historical hits in mixed files
    // are rare; if any exist, classify each line and skip-count appropriately.
    const fixableHits = hits.filter((h) => h.classification !== 'historical');
    const historicalHits = hits.filter((h) => h.classification === 'historical');

    for (const h of historicalHits) {
      totalHistoricalSkipped++;
      emit(opts, {
        action: 'skipped',
        reason: 'historical',
        file: filePath,
        line: h.line,
        classification: h.classification,
        text: truncate(h.text),
      });
    }

    if (fixableHits.length === 0) continue;

    // Defense-in-depth: if the entire file is in a historical context, skip
    // rewriting even if any hit slipped past per-line classification.
    if (isHistorical(filePath)) continue;

    const newContent = rewriteContent(content);

    for (const h of fixableHits) {
      totalLinesFixed++;
      emit(opts, {
        action: opts.apply ? 'fixed' : 'would-fix',
        reason: null,
        file: filePath,
        line: h.line,
        classification: h.classification,
        text: truncate(h.text),
      });
    }

    if (opts.apply) {
      try {
        await atomicWrite(filePath, newContent);
      } catch (err) {
        totalPermissionErrors++;
        process.stderr.write(
          `migrate-vault-paths: ERROR failed to write ${filePath}: ${err.message}\n`,
        );
        // Continue with next file rather than aborting the whole run.
      }
    }
  }

  const modeLabel = opts.apply ? 'applied' : 'dry-run';
  process.stderr.write(
    `migrate-vault-paths: ${totalScanned} files scanned, ${totalLinesFixed} lines fixed, ` +
      `${totalHistoricalSkipped} historical skipped` +
      (totalPermissionErrors > 0 ? `, ${totalPermissionErrors} I/O errors` : '') +
      ` [${modeLabel}]\n`,
  );

  process.exit(totalPermissionErrors > 0 ? 2 : 0);
}

function truncate(s) {
  if (typeof s !== 'string') return s;
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

/**
 * Emit a single output record. JSON mode prints one JSONL object; text mode
 * prints the canonical human line: "<abbrev>:<line>: <class> → <action>".
 */
function emit(opts, rec) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(rec) + '\n');
    return;
  }
  const where = `${abbrev(rec.file)}${rec.line ? ':' + rec.line : ''}`;
  const cls = rec.classification ?? rec.reason ?? '?';
  process.stdout.write(`migrate-vault-paths: ${where}: ${cls} → ${rec.action}\n`);
}

main().catch((err) => {
  process.stderr.write(`migrate-vault-paths: FATAL: ${err.message}\n`);
  process.exit(2);
});
