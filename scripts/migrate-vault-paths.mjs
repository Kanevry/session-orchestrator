#!/usr/bin/env node
/**
 * migrate-vault-paths.mjs — one-shot cross-repo migration for username-drift in vault/project paths.
 *
 * Rewrites a literal "from" username path-segment to a "to" segment across markdown
 * files under ~/Projects/. Only the username path segment changes; the trailing
 * path is preserved.
 *
 * Typical use: a host username change (`/Users/oldname/` → `/Users/newname/`) leaves
 * hardcoded paths in CLAUDE.md / AGENTS.md / STATE.md across every checked-out repo.
 * This script sweeps them in one pass.
 *
 * Usage:
 *   node scripts/migrate-vault-paths.mjs --from <old/> --to <new/> [--dry-run|--apply] [--repos <comma,list>] [--json] [--help]
 *
 * Rule resolution (in priority order):
 *   1. --from / --to flags (explicit CLI override)
 *   2. username-rewrites: [{from,to}] in
 *      ~/.config/session-orchestrator/vault-migration-rules.yaml
 *      (first entry is used; multiple rewrites in one run require multiple invocations)
 *   3. <none> → fail with non-zero exit and a hint to the config file.
 *
 * Target repo resolution (in priority order):
 *   1. --repos <comma,list>             (explicit CLI override)
 *   2. audited-repos: [...] in the same vault-migration-rules.yaml
 *   3. <none, no --repos> → scan only the auto-discover sweep under ~/Projects/**.
 *
 * Flags:
 *   --from SEG       Literal source segment (e.g. '/Users/oldname/'). Required if no config entry.
 *   --to SEG         Literal target segment (e.g. '/Users/newname/'). Required if no config entry.
 *   --dry-run        Preview changes without writing (DEFAULT)
 *   --apply          Write fixes in-place (atomic: tmp + rename)
 *   --repos LIST     Comma-separated repo names or absolute paths to scan
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
import {
  loadVaultMigrationRules,
  VAULT_MIGRATION_RULES_PATH,
} from './lib/vault-migration-rules.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const PROJECTS_ROOT = path.join(HOME, 'Projects');

// Set at startup from CLI args or config. Helpers read these; main() resolves them.
let OLD_SEGMENT = null;
let NEW_SEGMENT = null;

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
    repos: null, // null = use config defaults / auto-discover
    from: null,  // null = read from config
    to: null,    // null = read from config
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
    } else if (a === '--from') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        process.stderr.write('migrate-vault-paths: --from requires a literal source segment\n');
        process.exit(1);
      }
      out.from = next;
      i++;
    } else if (a === '--to') {
      const next = args[i + 1];
      if (!next || next.startsWith('--')) {
        process.stderr.write('migrate-vault-paths: --to requires a literal target segment\n');
        process.exit(1);
      }
      out.to = next;
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
    `Usage: migrate-vault-paths.mjs --from <old/> --to <new/> [--dry-run|--apply] [--repos <comma,list>] [--json] [--help]

Rewrites a literal "from" path segment to a "to" segment across markdown files
under ~/Projects/, skipping tests/, fixtures/, .git/, vault-backups, and
historical contexts (decisions.md, history/, archive*).

Both --from and --to are required unless username-rewrites[0] is set in
${VAULT_MIGRATION_RULES_PATH}.

Options:
  --from SEG           Literal source segment (e.g. '/Users/oldname/')
  --to SEG             Literal target segment (e.g. '/Users/newname/')
  --dry-run            Preview changes without writing (DEFAULT)
  --apply              Write fixes in-place (atomic: tmp + rename)
  --repos LIST         Comma-separated repo names or paths to scan; falls back
                       to audited-repos: [...] in vault-migration-rules.yaml,
                       then to ~/Projects/** auto-discovery sweep
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
      OLD_SEGMENT,
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
  if (lower.includes('vault-dir:') && line.includes(OLD_SEGMENT + 'Projects/vault')) {
    return 'vault-dir-drift';
  }
  return 'path-drift';
}

// ---------------------------------------------------------------------------
// File processing
// ---------------------------------------------------------------------------

/**
 * Replace OLD_SEGMENT with NEW_SEGMENT across the full text. Only that literal
 * segment changes; the trailing path is preserved verbatim (e.g. '/Users/x/Foo'
 * → '/Users/y/Foo' when the rewrite rule is '/Users/x/' → '/Users/y/').
 */
function rewriteContent(content) {
  // Use split+join (no regex) so we never accidentally match a substring outside the literal.
  return content.split(OLD_SEGMENT).join(NEW_SEGMENT);
}

/**
 * Determine which lines in a file contain the literal, returning [{line: n, text, classification}].
 */
function findHits(filePath, content) {
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(OLD_SEGMENT)) {
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

  // ── Resolve --from / --to rewrite segments ────────────────────────────────
  // Priority: CLI args > config username-rewrites[0] > fail.
  const ruleset = loadVaultMigrationRules();
  for (const e of ruleset.errors) {
    process.stderr.write(`migrate-vault-paths: config: ${e}\n`);
  }
  if (opts.from && opts.to) {
    OLD_SEGMENT = opts.from;
    NEW_SEGMENT = opts.to;
  } else if (opts.from || opts.to) {
    process.stderr.write('migrate-vault-paths: --from and --to must be given together\n');
    process.exit(1);
  } else if (ruleset.config.usernameRewrites.length > 0) {
    OLD_SEGMENT = ruleset.config.usernameRewrites[0].from;
    NEW_SEGMENT = ruleset.config.usernameRewrites[0].to;
  } else {
    process.stderr.write(
      'migrate-vault-paths: no rewrite rule found.\n' +
        '  Either pass --from <old/> --to <new/>, or set username-rewrites: in\n' +
        `  ${VAULT_MIGRATION_RULES_PATH}\n`
    );
    process.exit(1);
  }

  // Resolve the scan set: explicit --repos, or config audited-repos, or empty (auto-discover only)
  const repoRoots = [];
  const explicitRepos = opts.repos ?? (ruleset.config.auditedRepos.length > 0 ? ruleset.config.auditedRepos : null);
  if (explicitRepos) {
    for (const r of explicitRepos) {
      const resolved = resolveRepoPath(r);
      if (!resolved) {
        process.stderr.write(`migrate-vault-paths: WARN repo not found: ${r}\n`);
        continue;
      }
      repoRoots.push(resolved);
    }
    if (repoRoots.length === 0 && opts.repos) {
      process.stderr.write('migrate-vault-paths: no valid repos to scan\n');
      process.exit(1);
    }
  }

  // Initial file discovery within named repos
  let candidateFiles = findCandidateFiles(repoRoots);

  // If NO explicit repo list was given (neither --repos nor config.audited-repos),
  // expand scan to discover anything else under ~/Projects/**.
  if (!explicitRepos) {
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
