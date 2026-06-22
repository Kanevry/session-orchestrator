#!/usr/bin/env node
/**
 * relocate-vault-corpus.mjs — IO/CLI layer for flat-corpus vault relocation.
 *
 * Moves flat markdown files under 40-learnings/ and 50-sessions/ in a vault
 * into per-repo namespace subdirectories using the classification logic from
 * scripts/lib/vault-relocation-rules.mjs (C1).
 *
 * Usage:
 *   node scripts/relocate-vault-corpus.mjs --vault-dir <path> [--dry-run|--apply]
 *     [--derivable-only] [--rollback <manifest>] [--learnings-only|--sessions-only]
 *     [--json] [--help]
 *
 * Flags:
 *   --vault-dir DIR       Path to the vault git repo root (REQUIRED — no default for safety)
 *   --dry-run             Preview plan, write nothing (DEFAULT; mutex with --apply)
 *   --apply               Move files via git mv and write reverse-manifest (mutex with --dry-run)
 *   --derivable-only      Only move files where confident===true; skip _unsorted/redacted-repo/unknown-repo
 *   --rollback MANIFEST   Reverse a previous --apply run given its manifest JSON path
 *   --learnings-only      Scope to 40-learnings/ only
 *   --sessions-only       Scope to 50-sessions/ only
 *   --json                Emit JSONL records on stdout (one per file)
 *   --help, -h            Show this help
 *
 * Exit codes:
 *   0  Success (including no-op / dry-run)
 *   1  Input/arg error
 *   2  IO error
 *
 * Data → stdout. Diagnostics/summary → stderr.
 *
 * Structural idempotency: flat files at maxdepth 1 are enumerated; files already
 * at depth ≥ 2 (already namespaced) are never enumerated nor moved.
 */

import { promises as fs, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  loadVaultRelocationRules,
  VAULT_RELOCATION_RULES_PATH,
  parseRelocationFrontmatter,
  namespaceForSession,
  classifyOwner,
  isConfident,
  computeDest,
  isAlreadyNamespaced,
  _setResolverForTest,
} from './lib/vault-relocation-rules.mjs';
import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_NAME = 'relocate-vault-corpus';
const LEARNINGS_SUBDIR = '40-learnings';
const SESSIONS_SUBDIR = '50-sessions';
const MANIFEST_DIR = '.orchestrator';
const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  let parsedFlags;
  try {
    parsedFlags = parseColumnFlags({
      argv: argv.slice(2),
      knownBool: {
        help: { short: 'h', default: false },
        apply: false,
        'dry-run': false,
        json: false,
        'derivable-only': false,
        'learnings-only': false,
        'sessions-only': false,
      },
      knownString: {
        'vault-dir': null,
        rollback: null,
      },
    });
  } catch (err) {
    if (err instanceof CliFlagError) {
      process.stderr.write(`${SCRIPT_NAME}: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const values = parsedFlags.values;

  // Mutex check: --dry-run and --apply on the same invocation
  const applyFlag = values.apply === true;
  const dryRunFlag = values['dry-run'] === true;
  if (applyFlag && dryRunFlag) {
    process.stderr.write(`${SCRIPT_NAME}: --dry-run and --apply are mutually exclusive\n`);
    process.exit(1);
  }

  // --learnings-only and --sessions-only are mutually exclusive
  if (values['learnings-only'] && values['sessions-only']) {
    process.stderr.write(`${SCRIPT_NAME}: --learnings-only and --sessions-only are mutually exclusive\n`);
    process.exit(1);
  }

  return {
    help: values.help === true,
    apply: applyFlag,
    json: values.json === true,
    derivableOnly: values['derivable-only'] === true,
    rollback: values.rollback ?? null,
    vaultDir: values['vault-dir'] ?? null,
    learningsOnly: values['learnings-only'] === true,
    sessionsOnly: values['sessions-only'] === true,
  };
}

function printHelp() {
  process.stdout.write(
    `Usage: ${SCRIPT_NAME}.mjs --vault-dir <path> [--dry-run|--apply]
  [--derivable-only] [--rollback <manifest>] [--learnings-only|--sessions-only]
  [--json] [--help]

Moves flat markdown files from 40-learnings/ and 50-sessions/ roots in a vault
git repo into per-repo namespace subdirectories.

Flat files at depth 1 are enumerated and classified; files already in a
subdirectory (depth >= 2, already namespaced) are never touched.

REQUIRED:
  --vault-dir DIR         Path to the vault git repo root

MODES (default: --dry-run):
  --dry-run               Preview plan, write nothing (DEFAULT)
  --apply                 Move files via git mv, write reverse-manifest (STAGE ONLY — no commit)
  --rollback MANIFEST     Reverse a previous --apply run given its manifest JSON path

FILTERS:
  --derivable-only        Only move files where confident===true; skip _unsorted/redacted-repo/unknown-repo
  --learnings-only        Scope to 40-learnings/ only
  --sessions-only         Scope to 50-sessions/ only

OUTPUT:
  --json                  Emit JSONL records on stdout (one per file)
  --help, -h              Show this help

Exit codes:
  0  Success (including no-op / dry-run)
  1  Input/arg error
  2  IO error

Data goes to stdout; diagnostics and summary go to stderr.

WARNING: This tool operates on a git repo (--vault-dir). Run with --dry-run
first to verify the plan. The --apply mode stages moves (git mv) but does NOT
commit — the operator must review and commit separately.

The reverse-manifest is written to <vault-dir>/.orchestrator/relocation-manifest-<ISO>.json
on a successful --apply run and can be used with --rollback to undo.

Config: ${VAULT_RELOCATION_RULES_PATH}
`,
  );
}

// ---------------------------------------------------------------------------
// Flat-file discovery (maxdepth 1 only — structural idempotency)
// ---------------------------------------------------------------------------

/**
 * Enumerate flat markdown files directly under <dir> (maxdepth 1, files only).
 * Files at depth >= 2 (already in a subdirectory) are never returned.
 *
 * @param {string} dir - absolute path to the corpus subdir (e.g. vault/40-learnings)
 * @returns {string[]} absolute file paths of flat .md files
 */
function enumerateFlatFiles(dir) {
  if (!existsSync(dir)) return [];

  const result = spawnSync(
    'find',
    [dir, '-maxdepth', '1', '-type', 'f', '-name', '*.md'],
    { encoding: 'utf8' },
  );

  if (result.error) {
    process.stderr.write(
      `${SCRIPT_NAME}: find not found on PATH (${result.error.code ?? result.error.message})\n`,
    );
    process.exit(2);
  }
  if (result.status !== 0) {
    process.stderr.write(`${SCRIPT_NAME}: find failed: ${result.stderr}\n`);
    process.exit(2);
  }

  return result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Session→repo index builder
// ---------------------------------------------------------------------------

/**
 * Build a Map<sessionId, namespace> by scanning all session files — both flat
 * root AND existing <repo>/ subdirs (which carry frontmatter repo:).
 *
 * The index is passed to namespaceForLearning so it can resolve
 * source_session links to their owning namespace.
 *
 * @param {string} sessionsDir - absolute path to 50-sessions/
 * @returns {Map<string, string>} sessionId → namespace
 */
async function buildSessionRepoIndex(sessionsDir) {
  const index = new Map();
  if (!existsSync(sessionsDir)) return index;

  // All session .md files: flat + in subdirs (already-namespaced)
  const result = spawnSync(
    'find',
    [sessionsDir, '-type', 'f', '-name', '*.md'],
    { encoding: 'utf8' },
  );

  if (result.error || result.status !== 0) {
    // Non-fatal: return empty index, but warn so the operator knows source_session resolution is disabled
    process.stderr.write(`${SCRIPT_NAME}: WARN: could not scan sessions for index — transitive source_session resolution disabled: ${result.stderr || result.error?.message || 'unknown'}\n`);
    return index;
  }

  const files = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  for (const filePath of files) {
    let content;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch (e) {
      process.stderr.write(`${SCRIPT_NAME}: WARN: skipping session file for index (${path.basename(filePath)}): ${e.message}\n`);
      continue;
    }

    const frontmatter = parseRelocationFrontmatter(content);
    const basename = path.basename(filePath);
    // namespaceForSession returns { namespace, source }
    const { namespace } = namespaceForSession(frontmatter);
    if (namespace && namespace !== '_unsorted' && namespace !== 'redacted-repo' && namespace !== 'unknown-repo') {
      // Derive sessionId from basename (strip .md)
      const sessionId = basename.replace(/\.md$/, '');
      index.set(sessionId, namespace);
    }
  }

  return index;
}

// ---------------------------------------------------------------------------
// Classification helpers
// ---------------------------------------------------------------------------

/**
 * Classify a single file, returning the plan entry.
 *
 * @param {object} opts
 * @param {string} opts.filePath - absolute path
 * @param {string} opts.corpusRoot - absolute path to 40-learnings/ or 50-sessions/
 * @param {Map<string, string>} opts.sessionRepoIndex
 * @returns {{ from: string, to: string, namespace: string, source: string, confident: boolean }}
 */
async function classifyFile({ filePath, corpusRoot, sessionRepoIndex }) {
  const basename = path.basename(filePath);

  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    return {
      from: filePath,
      to: null,
      namespace: '_unsorted',
      source: 'error',
      confident: false,
      error: err.message,
    };
  }

  const frontmatter = parseRelocationFrontmatter(content);

  // classifyOwner dispatches on frontmatter.type — handles both sessions and learnings
  const classifyResult = classifyOwner({ frontmatter, sessionRepoIndex });

  const { namespace, source, confident } = classifyResult;

  const dest = computeDest({ basename, root: corpusRoot, namespace });

  return {
    from: filePath,
    to: dest,
    namespace,
    source,
    confident,
  };
}

// ---------------------------------------------------------------------------
// Emit (stdout record per file)
// ---------------------------------------------------------------------------

/**
 * Emit a single JSONL record or human-readable line per file.
 *
 * @param {boolean} jsonMode
 * @param {object} rec
 */
function emit(jsonMode, rec) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(rec) + '\n');
    return;
  }
  // Human-readable: action from → to [namespace] (source)
  const fromRel = rec.from ? path.basename(rec.from) : '?';
  const toRel = rec.to ? path.relative(path.dirname(rec.from), rec.to) : '?';
  const reasonStr = rec.reason ? ` [${rec.reason}]` : '';
  process.stdout.write(
    `${SCRIPT_NAME}: ${rec.action}: ${fromRel} → ${toRel} (${rec.namespace ?? rec.reason ?? '?'})${reasonStr}\n`,
  );
}

// ---------------------------------------------------------------------------
// git mv wrapper
// ---------------------------------------------------------------------------

/**
 * Ensure a directory exists inside the vault (creates via mkdir -p, not git).
 * Vault directories can be created outside git since they'll be picked up when
 * files are moved in.
 *
 * @param {string} dir - absolute path
 */
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Move a file using `git mv` (stages the rename, does NOT commit).
 *
 * @param {string} vaultDir - absolute path to vault git root
 * @param {string} from - absolute path (source)
 * @param {string} to - absolute path (destination)
 * @returns {{ ok: boolean, error?: string }}
 */
function gitMv(vaultDir, from, to) {
  // git mv wants relative paths from the repo root
  const fromRel = path.relative(vaultDir, from);
  const toRel = path.relative(vaultDir, to);

  const result = spawnSync(
    'git',
    ['-C', vaultDir, 'mv', fromRel, toRel],
    { encoding: 'utf8' },
  );

  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || result.stdout || 'git mv failed').trim() };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Manifest writer (atomic tmp + rename)
// ---------------------------------------------------------------------------

/**
 * Write the reverse-manifest atomically under <vaultDir>/.orchestrator/.
 *
 * @param {object} opts
 * @param {string} opts.vaultDir
 * @param {boolean} opts.derivableOnly
 * @param {object} opts.summary
 * @param {Array<{from:string,to:string,namespace:string,source:string}>} opts.moves
 * @returns {string} absolute path to the written manifest
 */
async function writeManifest({ vaultDir, derivableOnly, summary, moves }) {
  const manifestDir = path.join(vaultDir, MANIFEST_DIR);
  await ensureDir(manifestDir);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.join(manifestDir, `relocation-manifest-${ts}.json`);
  const tmpPath = `${manifestPath}.tmp-${process.pid}`;

  // Store vault-relative paths in the manifest
  const movesRel = moves.map((m) => ({
    from: path.relative(vaultDir, m.from),
    to: path.relative(vaultDir, m.to),
    namespace: m.namespace,
    source: m.source,
  }));

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    tool: SCRIPT_NAME,
    createdAt: new Date().toISOString(),
    vaultDir,
    mode: derivableOnly ? 'derivable-only' : 'full',
    mechanism: 'git-mv',
    summary,
    moves: movesRel,
  };

  await fs.writeFile(tmpPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  await fs.rename(tmpPath, manifestPath);

  return manifestPath;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * Reverse a previous --apply run by reversing each move in the manifest.
 *
 * @param {string} manifestPath
 * @param {boolean} jsonMode
 */
async function runRollback(manifestPath, jsonMode) {
  let manifestContent;
  try {
    manifestContent = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    process.stderr.write(`${SCRIPT_NAME}: failed to read manifest: ${err.message}\n`);
    process.exit(2);
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch (err) {
    process.stderr.write(`${SCRIPT_NAME}: failed to parse manifest: ${err.message}\n`);
    process.exit(2);
  }

  const { vaultDir, moves } = manifest;
  if (!vaultDir || !Array.isArray(moves)) {
    process.stderr.write(`${SCRIPT_NAME}: invalid manifest schema\n`);
    process.exit(1);
  }

  let reversed = 0;
  let skipped = 0;
  let errors = 0;

  // Reverse in reverse order (mirrors file-by-file; order matters if subdirs)
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i];
    const absTo = path.join(vaultDir, m.to);     // current location
    const absFrom = path.join(vaultDir, m.from); // destination (original)

    // Assert: to exists, from absent
    if (!existsSync(absTo)) {
      emit(jsonMode, {
        action: 'skipped',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
        reason: 'source-missing-for-rollback',
      });
      skipped++;
      continue;
    }
    if (existsSync(absFrom)) {
      emit(jsonMode, {
        action: 'skipped',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
        reason: 'dest-exists-for-rollback',
      });
      skipped++;
      continue;
    }

    const mvResult = gitMv(vaultDir, absTo, absFrom);
    if (!mvResult.ok) {
      process.stderr.write(`${SCRIPT_NAME}: ERROR git mv failed: ${mvResult.error}\n`);
      errors++;
      emit(jsonMode, {
        action: 'error',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
        reason: mvResult.error,
      });
    } else {
      emit(jsonMode, {
        action: 'rolled-back',
        from: absTo,
        to: absFrom,
        namespace: m.namespace,
        source: m.source,
        confident: null,
      });
      reversed++;
    }
  }

  process.stderr.write(
    `${SCRIPT_NAME}: rollback complete — ${reversed} reversed, ${skipped} skipped, ${errors} errors\n`,
  );

  process.exit(errors > 0 ? 2 : 0);
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

  // Handle --rollback before requiring --vault-dir (manifest carries vaultDir)
  if (opts.rollback !== null) {
    await runRollback(opts.rollback, opts.json);
    return; // runRollback calls process.exit
  }

  // --vault-dir is required for all other modes
  if (!opts.vaultDir) {
    process.stderr.write(
      `${SCRIPT_NAME}: --vault-dir is required (no default to prevent accidental writes)\n`,
    );
    process.exit(1);
  }

  const vaultDir = path.resolve(opts.vaultDir);
  if (!existsSync(vaultDir)) {
    process.stderr.write(`${SCRIPT_NAME}: vault-dir not found: ${vaultDir}\n`);
    process.exit(1);
  }

  // Load relocation rules (errors are warnings, not fatal)
  const ruleset = loadVaultRelocationRules();
  for (const e of ruleset.errors ?? []) {
    process.stderr.write(`${SCRIPT_NAME}: config: ${e}\n`);
  }

  // ── Corpus paths ─────────────────────────────────────────────────────────
  const learningsDir = path.join(vaultDir, LEARNINGS_SUBDIR);
  const sessionsDir = path.join(vaultDir, SESSIONS_SUBDIR);

  // ── Step 1: Build session→repo index (single pass over ALL session files) ──
  const sessionRepoIndex = await buildSessionRepoIndex(sessionsDir);

  // ── Step 2: Enumerate flat files (maxdepth 1 only) ───────────────────────
  const scopeSessions = !opts.learningsOnly;
  const scopeLearnings = !opts.sessionsOnly;

  const sessionFiles = scopeSessions ? enumerateFlatFiles(sessionsDir) : [];
  const learningFiles = scopeLearnings ? enumerateFlatFiles(learningsDir) : [];

  // ── Step 3: Classify each flat file ──────────────────────────────────────
  /** @type {Array<{from:string,to:string,namespace:string,source:string,confident:boolean,corpusRoot:string}>} */
  const plan = [];

  for (const filePath of sessionFiles) {
    const entry = await classifyFile({
      filePath,
      corpusRoot: sessionsDir,
      sessionRepoIndex,
    });
    plan.push({ ...entry, corpusRoot: sessionsDir });
  }

  for (const filePath of learningFiles) {
    const entry = await classifyFile({
      filePath,
      corpusRoot: learningsDir,
      sessionRepoIndex,
    });
    plan.push({ ...entry, corpusRoot: learningsDir });
  }

  // ── Step 4: Apply mode decision, emit records ─────────────────────────────
  const summary = {
    moved: 0,
    skippedAlreadyNamespaced: 0,
    fallbackBucket: 0,
    skippedNonConfident: 0,
    destCollisions: 0,
    ioErrors: 0,
  };

  /** @type {Array<{from:string,to:string,namespace:string,source:string}>} */
  const appliedMoves = [];

  for (const entry of plan) {
    // isAlreadyNamespaced is a structural guard — should never be hit (we enumerate maxdepth 1)
    // but defensive check in case find returned a deeper path
    const relToCorpus = path.relative(entry.corpusRoot, entry.from);
    if (isAlreadyNamespaced(relToCorpus)) {
      summary.skippedAlreadyNamespaced++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
        reason: 'already-namespaced',
      });
      continue;
    }

    if (entry.error) {
      summary.ioErrors++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: null,
        namespace: '_unsorted',
        source: 'error',
        confident: false,
        reason: `read-error: ${entry.error}`,
      });
      continue;
    }

    // --derivable-only: skip non-confident entries
    if (opts.derivableOnly && !isConfident(entry.namespace)) {
      summary.skippedNonConfident++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
        reason: 'non-confident',
      });
      continue;
    }

    // Track fallback bucket
    if (!isConfident(entry.namespace)) {
      summary.fallbackBucket++;
    }

    // Dest-collision guard
    if (existsSync(entry.to)) {
      summary.destCollisions++;
      emit(opts.json, {
        action: 'skipped',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
        reason: 'dest-exists',
      });
      continue;
    }

    if (!opts.apply) {
      // Dry-run: report what would happen
      emit(opts.json, {
        action: 'would-move',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
      });
      summary.moved++;
    } else {
      // Apply: mkdir, git mv, record
      try {
        await ensureDir(path.dirname(entry.to));
      } catch (err) {
        summary.ioErrors++;
        process.stderr.write(
          `${SCRIPT_NAME}: ERROR creating dir ${path.dirname(entry.to)}: ${err.message}\n`,
        );
        emit(opts.json, {
          action: 'skipped',
          from: entry.from,
          to: entry.to,
          namespace: entry.namespace,
          source: entry.source,
          confident: entry.confident,
          reason: `mkdir-error: ${err.message}`,
        });
        continue;
      }

      const mvResult = gitMv(vaultDir, entry.from, entry.to);
      if (!mvResult.ok) {
        summary.ioErrors++;
        process.stderr.write(`${SCRIPT_NAME}: ERROR git mv failed: ${mvResult.error}\n`);
        emit(opts.json, {
          action: 'skipped',
          from: entry.from,
          to: entry.to,
          namespace: entry.namespace,
          source: entry.source,
          confident: entry.confident,
          reason: `git-mv-error: ${mvResult.error}`,
        });
        continue;
      }

      emit(opts.json, {
        action: 'moved',
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
        confident: entry.confident,
      });
      summary.moved++;
      appliedMoves.push({
        from: entry.from,
        to: entry.to,
        namespace: entry.namespace,
        source: entry.source,
      });
    }
  }

  // ── Step 5: Write manifest on --apply ─────────────────────────────────────
  if (opts.apply && appliedMoves.length > 0) {
    try {
      const writtenPath = await writeManifest({
        vaultDir,
        derivableOnly: opts.derivableOnly,
        summary,
        moves: appliedMoves,
      });
      process.stderr.write(`${SCRIPT_NAME}: manifest written: ${writtenPath}\n`);
    } catch (err) {
      summary.ioErrors++;
      process.stderr.write(`${SCRIPT_NAME}: WARN: manifest write failed — moves were staged via git mv but --rollback via manifest is unavailable; reverse manually via 'git -C <vault> reset' or 'git mv' back. Error: ${err.message}\n`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const modeLabel = opts.apply ? 'applied' : 'dry-run';
  const derivableLabel = opts.derivableOnly ? ' [derivable-only]' : '';
  process.stderr.write(
    `${SCRIPT_NAME}: ${summary.moved} ${opts.apply ? 'moved' : 'would-move'}, ` +
    `${summary.skippedAlreadyNamespaced} already-namespaced, ` +
    `${summary.skippedNonConfident} non-confident skipped, ` +
    `${summary.destCollisions} dest-collisions, ` +
    `${summary.ioErrors} I/O errors` +
    ` [${modeLabel}${derivableLabel}]\n`,
  );

  process.exit(summary.ioErrors > 0 ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Entry guard (run only when invoked directly)
// ---------------------------------------------------------------------------

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`${SCRIPT_NAME}: FATAL: ${err.message}\n`);
    process.exit(2);
  });
}

export {
  enumerateFlatFiles,
  buildSessionRepoIndex,
  classifyFile,
  writeManifest,
  runRollback,
  _setResolverForTest,
};
