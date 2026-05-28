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
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {
  loadVaultMigrationRules,
  VAULT_MIGRATION_RULES_PATH,
} from './lib/vault-migration-rules.mjs';
import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const PROJECTS_ROOT = path.join(HOME, 'Projects');

// Set at startup from CLI args or config. Helpers read these; main() resolves them.
let OLD_SEGMENT = null;
let NEW_SEGMENT = null;

/**
 * Test-only seam (architect MED #607 D3): set the module-level OLD/NEW segments
 * that the exported pure helpers (rewriteContent, findMissingSegmentHits,
 * isOwnedByUsernamePath, classifyHit) read. The CLI path sets these inside
 * main() from --from/--to or config; importing tests have no other way to drive
 * the segment-dependent helpers. Underscore prefix = internal-but-test-visible,
 * mirroring the _parseVaultIntegration / _parseMemoryProposals convention.
 *
 * Returns the prior values so a test can save/restore around an assertion.
 */
function _setSegmentsForTest(oldSeg, newSeg) {
  const prev = { OLD_SEGMENT, NEW_SEGMENT };
  OLD_SEGMENT = oldSeg;
  NEW_SEGMENT = newSeg;
  return prev;
}

// ── Missing-segment class (GitLab #600 D3) ────────────────────────────────────
// A second, username-independent drift class: a `vault-dir:` value that points at
// `~/Projects/vault` (or `/Users/<user>/Projects/vault`) — MISSING the canonical
// `/Bernhard/` owner segment — must become `~/Projects/Bernhard/vault`.
//
// Scoping discipline (do NOT blunt-rewrite every `~/Projects/` path):
//   - Only lines in a `vault-dir:` context (vault-integration.vault-dir /
//     vault-sync.vault-dir) are touched. `cache: ~/Projects/vault-backups` and
//     other unrelated `~/Projects/...` paths are left untouched.
//   - The match anchors the value to `~` or `/Users/<user>` immediately before
//     `/Projects/vault`, and requires a path boundary AFTER `vault` (negative
//     lookahead `(?![\w-])`) so `vault-backups` / `vaultfoo` never match.
//   - Matching `Projects/vault` directly (not `Projects/Bernhard/vault`) yields
//     idempotency for free: a canonical line has `Projects/Bernhard/vault`, so
//     the pattern does not match it → no `.../Bernhard/Bernhard/vault`.
//
// The owner segment is the canonical `Bernhard`; the rewrite inserts it between
// `Projects/` and `vault`.
const MISSING_SEGMENT_OWNER = 'Bernhard';

// Classification label for the missing-/Bernhard/-segment drift class. Referenced
// in findMissingSegmentHits() (hit record) and the emit() action strings — hoisted
// here so the literal lives in exactly one place (architect MED #607 D3).
const MISSING_SEGMENT_CLASS = 'vault-dir-missing-segment';

const MISSING_SEGMENT_RE = new RegExp(
  // (1) vault-dir: prefix (with optional surrounding whitespace)
  // (2) value root: ~ or /Users/<user>
  // (3) /Projects/vault, NOT followed by a word char or hyphen (path boundary)
  String.raw`(vault-dir:\s*['"]?)(~|/Users/[^/\s'"]+)/Projects/vault(?![\w-])`,
  'g',
);

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
  // Migrated to scripts/lib/cli-flags.mjs (#510). Per-script semantics
  // (mutex check, --repos comma-split, "next arg starts with --" guards)
  // remain here; the helper owns argv tokenisation + unknown-flag rejection.
  //
  // Note: `node:util` parseArgs strict mode already rejects "--from --to"
  // patterns by treating `--to` as the missing-value for `--from` (the prior
  // hand-rolled check covered the same case, with a different error message).
  let parsedFlags;
  try {
    parsedFlags = parseColumnFlags({
      argv: argv.slice(2),
      knownBool: {
        help: { short: 'h', default: false },
        apply: false,
        'dry-run': false,
        json: false,
      },
      knownString: {
        repos: null, // raw comma-separated string; split below
        from: null,
        to: null,
      },
    });
  } catch (err) {
    if (err instanceof CliFlagError) {
      // Preserve legacy prose so the existing test contracts at
      // tests/scripts/migrate-vault-paths.test.mjs ("unknown argument",
      // "--repos requires") keep passing — same exit-1 behaviour, same
      // user-visible message shape, helper owns the actual parsing.
      const legacy = err.message
        .replace(/^Unknown option/, 'unknown argument')
        .replace(/^Option '--repos <value>' argument missing$/, '--repos requires a comma-separated list')
        .replace(/^Option '--from <value>' argument missing$/, '--from requires a literal source segment')
        .replace(/^Option '--to <value>' argument missing$/, '--to requires a literal target segment');
      process.stderr.write(`migrate-vault-paths: ${legacy}\n`);
      process.exit(1);
    }
    throw err;
  }

  const values = parsedFlags.values;

  // Mutex check: --dry-run and --apply on the same invocation is the
  // canonical footgun (issue #509). Preserved verbatim.
  const applyFlag = values.apply === true;
  const dryRunFlag = values['dry-run'] === true;
  if (applyFlag && dryRunFlag) {
    process.stderr.write('migrate-vault-paths: --dry-run and --apply are mutually exclusive\n');
    process.exit(1);
  }

  // Split --repos into a string[] at the use site, preserving the prior shape
  // contract (the downstream code at main() iterates opts.repos as an array).
  let repos = null;
  if (values.repos !== undefined && values.repos !== null) {
    repos = values.repos
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return {
    help: values.help === true,
    apply: applyFlag, // --dry-run leaves this false (matches the prior shape)
    json: values.json === true,
    repos,
    from: values.from ?? null,
    to: values.to ?? null,
  };
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
  // ENOENT guard (GitLab #600 F2): when the `grep` binary is missing from PATH,
  // spawnSync sets `result.error` (ENOENT) and `result.status` is null. The
  // status check below treats null as a failure but reports an empty stderr
  // ("grep failed: "), masking the real cause. Surface the spawn error first.
  if (result.error) {
    process.stderr.write(
      `migrate-vault-paths: grep/find not found on PATH (${result.error.code ?? result.error.message})\n`,
    );
    process.exit(2);
  }
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
 * Discover files containing a missing-segment `vault-dir:` drift (GitLab #600
 * D3) — i.e. a `vault-dir:` line pointing at `~/Projects/vault` (or
 * `/Users/<user>/Projects/vault`) that lacks the canonical `/Bernhard/` owner
 * segment. These files do NOT contain OLD_SEGMENT, so findCandidateFiles() (which
 * greps OLD_SEGMENT) cannot find them.
 *
 * grep matches the literal `Projects/vault`; per-file classification then applies
 * the precise MISSING_SEGMENT_RE (vault-dir context + path-boundary + not-canonical)
 * to weed out false positives such as `cache: ~/Projects/vault-backups`. Test-dir
 * and other EXCLUDE_GLOBS are filtered out so tests/** fixtures are never rewritten.
 */
function findMissingSegmentFiles(roots) {
  if (roots.length === 0) return [];
  const result = spawnSync(
    'grep',
    [
      '-r',
      '-l',
      '-I',
      '--include=*.md',
      // Coarse literal pre-filter; precise vault-dir/idempotency check happens
      // per-line in findMissingSegmentHits(). 'Projects/vault' also matches
      // canonical 'Projects/Bernhard/vault' lines, but those are dropped later.
      'Projects/vault',
      ...roots,
    ],
    { encoding: 'utf8' },
  );
  if (result.error) {
    process.stderr.write(
      `migrate-vault-paths: grep/find not found on PATH (${result.error.code ?? result.error.message})\n`,
    );
    process.exit(2);
  }
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
 * Auto-discover ALL repos under ~/Projects/** that contain the OLD_SEGMENT
 * literal OR a missing-segment `vault-dir:` drift. Used in tandem with the
 * default-target list to find drift we don't already know about.
 */
function discoverAdditionalFiles() {
  if (!existsSync(PROJECTS_ROOT)) return [];
  const set = new Set(findCandidateFiles([PROJECTS_ROOT]));
  for (const f of findMissingSegmentFiles([PROJECTS_ROOT])) set.add(f);
  return [...set];
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

/**
 * Does this line carry a missing-segment `vault-dir:` drift (GitLab #600 D3)?
 * Returns true only for a `vault-dir:` value at `~/Projects/vault` or
 * `/Users/<user>/Projects/vault` that is NOT already canonical
 * (`~/Projects/Bernhard/vault`) — see MISSING_SEGMENT_RE for the precise shape.
 * `RegExp.test` advances lastIndex on a /g regex, so reset it before each probe.
 */
function lineHasMissingSegment(line) {
  MISSING_SEGMENT_RE.lastIndex = 0;
  return MISSING_SEGMENT_RE.test(line);
}

/**
 * Is this line owned by the username-rewrite path (i.e. does it carry OLD_SEGMENT)?
 *
 * The missing-segment pass must never touch a line the username rewrite owns — a
 * `vault-dir: /Users/oldname/Projects/vault` line is a username drift, not a
 * missing-segment drift. This single predicate is the shared invariant used by
 * BOTH findMissingSegmentHits() (skip the hit) and rewriteMissingSegment() (skip
 * the rewrite, gated on the ORIGINAL line text). Extracted to one place so the
 * two sites cannot drift apart (architect MED #607 D3).
 *
 * `line` may be undefined when an original-content array is shorter than the
 * working-content array (chained transforms can change line count); an undefined
 * line is, by definition, not owned by the username path → returns false.
 */
function isOwnedByUsernamePath(line) {
  return line !== undefined && line.includes(OLD_SEGMENT);
}

/**
 * Find missing-segment hits in a file's content, returning
 * [{line, text, classification: MISSING_SEGMENT_CLASS}].
 * Historical files (decisions.md, archive/, …) are reported but not rewritten,
 * mirroring the OLD_SEGMENT path — classifyHit's isHistorical() guard.
 *
 * Lines that also contain OLD_SEGMENT are owned by the username-rewrite path and
 * deliberately skipped here: a `vault-dir: /Users/oldname/Projects/vault` line is
 * a username drift (→ /Users/newname/Projects/vault), NOT a missing-segment drift.
 * Without this guard the two classes collide and the username output would gain a
 * spurious /Bernhard/ segment.
 */
function findMissingSegmentHits(filePath, content) {
  const historical = isHistorical(filePath);
  const lines = content.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (isOwnedByUsernamePath(lines[i])) continue; // owned by username-rewrite path
    if (lineHasMissingSegment(lines[i])) {
      hits.push({
        line: i + 1, // 1-indexed
        text: lines[i],
        classification: historical ? 'historical' : MISSING_SEGMENT_CLASS,
      });
    }
  }
  return hits;
}

/**
 * Rewrite missing-segment `vault-dir:` values in `content`: insert the canonical
 * `/Bernhard/` owner segment between `Projects/` and `vault`. Only `vault-dir:`
 * lines matching MISSING_SEGMENT_RE are touched — unrelated `~/Projects/...`
 * paths (e.g. `cache: ~/Projects/vault-backups`) are preserved verbatim.
 *
 * `originalContent` (the file BEFORE rewriteContent ran) gates which lines are
 * eligible: any line whose original carried OLD_SEGMENT is owned by the username
 * path and is skipped, even though the username rewrite may have produced a
 * `/Users/newname/Projects/vault` form that would otherwise match the regex.
 * This keeps the two classes from colliding when both transforms chain.
 *
 * `originalContent` is REQUIRED (no default): the collision-gate is meaningless
 * without the pre-rewrite text, and a `= content` default silently fails open if
 * a future caller forgets it — passing the already-rewritten content as its own
 * "original" would let a chained username rewrite leak a spurious /Bernhard/
 * segment. Callers MUST pass the original content explicitly (architect MED #607 D3).
 */
function rewriteMissingSegment(content, originalContent) {
  const origLines = originalContent.split('\n');
  return content
    .split('\n')
    .map((line, i) => {
      // Skip lines the username path owns (matched on the ORIGINAL line text).
      if (isOwnedByUsernamePath(origLines[i])) return line;
      MISSING_SEGMENT_RE.lastIndex = 0;
      return line.replace(
        MISSING_SEGMENT_RE,
        (_m, prefix, root) => `${prefix}${root}/Projects/${MISSING_SEGMENT_OWNER}/vault`,
      );
    })
    .join('\n');
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

  // Initial file discovery within named repos: OLD_SEGMENT files AND
  // missing-segment vault-dir drift files (GitLab #600 D3 — the latter do not
  // contain OLD_SEGMENT, so findCandidateFiles alone would miss them).
  const candidateSet = new Set(findCandidateFiles(repoRoots));
  for (const f of findMissingSegmentFiles(repoRoots)) candidateSet.add(f);
  let candidateFiles = [...candidateSet];

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
    // Two independent drift classes, each discovered per-line:
    //   - OLD_SEGMENT username drift  → rewriteContent (split+join)
    //   - missing /Bernhard/ segment  → rewriteMissingSegment (#600 D3)
    const hits = findHits(filePath, content);
    const missingHits = findMissingSegmentHits(filePath, content);
    if (hits.length === 0 && missingHits.length === 0) continue;

    // Decide per-file: if every hit is historical → skip the whole file.
    // Otherwise, rewrite the whole file (transforms are global) — historical hits
    // in mixed files are rare; if any exist, classify each line and skip-count.
    const fixableHits = hits.filter((h) => h.classification !== 'historical');
    const historicalHits = hits.filter((h) => h.classification === 'historical');
    const fixableMissing = missingHits.filter((h) => h.classification !== 'historical');
    const historicalMissing = missingHits.filter((h) => h.classification === 'historical');

    for (const h of [...historicalHits, ...historicalMissing]) {
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

    if (fixableHits.length === 0 && fixableMissing.length === 0) continue;

    // Defense-in-depth: if the entire file is in a historical context, skip
    // rewriting even if any hit slipped past per-line classification.
    if (isHistorical(filePath)) continue;

    // Chain both transforms. rewriteContent (username) runs first; the
    // missing-segment pass is then gated on the ORIGINAL content so it never
    // touches a line the username rewrite already owns (see rewriteMissingSegment).
    let newContent = content;
    if (fixableHits.length > 0) newContent = rewriteContent(newContent);
    if (fixableMissing.length > 0) newContent = rewriteMissingSegment(newContent, content);

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
    for (const h of fixableMissing) {
      totalLinesFixed++;
      emit(opts, {
        action: opts.apply ? `${MISSING_SEGMENT_CLASS}-fixed` : `${MISSING_SEGMENT_CLASS}-would-fix`,
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

// ---------------------------------------------------------------------------
// Entry guard + exports (architect MED #607 D3)
//
// Run main() only when invoked directly as a CLI (node scripts/migrate-vault-paths.mjs).
// When imported by a test (or another module), the pure helpers below are
// available without firing the one-shot migration as a side effect.
//
// `process.argv[1]` is the invoked script path under `node <script>`, but it is
// `undefined` under `node -e "import(...)"` and some dynamic-import contexts —
// pathToFileURL(undefined) throws ERR_INVALID_ARG_TYPE. Guard the falsy case so
// importing the module is never a hard error regardless of how the importer runs.
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`migrate-vault-paths: FATAL: ${err.message}\n`);
    process.exit(2);
  });
}

export {
  rewriteMissingSegment,
  rewriteContent,
  lineHasMissingSegment,
  findMissingSegmentHits,
  isHistorical,
  classifyHit,
  isOwnedByUsernamePath,
  MISSING_SEGMENT_CLASS,
  _setSegmentsForTest,
};
