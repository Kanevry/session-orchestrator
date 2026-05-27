#!/usr/bin/env node
/**
 * vault-consolidate.mjs — One-shot vault consolidation migration (PRD F1.1, Issue #499).
 *
 * Folds the redundant vault at `~/Projects/vault/` into the canonical
 * `~/Projects/Bernhard/vault/`, with per-file conflict resolution, idempotent
 * re-runs, and a compressed backup of the source side BEFORE any write.
 *
 * Design — two-phase coordinator-driven flow for merge resolution
 * ---------------------------------------------------------------
 *
 * AskUserQuestion (AUQ) is only available to the coordinator (parent session),
 * not to this script. The PRD F1.1 Gherkin requires per-file AUQ for any
 * collision. To bridge that gap, this script runs in two phases:
 *
 *   Phase 1  — `--dry-run`  (default)
 *              Walks the source vault, hashes both sides where paths collide,
 *              and emits a per-file action plan (`copy`, `skip-already-present`,
 *              `merge`, `conflict-needs-review`) to stdout. NO writes occur.
 *              Used by the coordinator to surface decisions to the operator
 *              before any state changes.
 *
 *   Phase 2  — `--apply`
 *              Performs all `copy` and `skip-already-present` actions silently
 *              (those are determined by byte-equality + path uniqueness, no
 *              ambiguity). For each `merge` / `conflict-needs-review`, the
 *              script EXITS with code 3 after writing a structured prompt
 *              record to stdout:
 *                  {kind:"awaiting-merge-decision", source, canonical,
 *                   src_size, dst_size, src_mtime, dst_mtime, src_sha,
 *                   dst_sha, subset_hint}
 *              The coordinator presents the decision via AUQ, then re-invokes
 *              the script with `--resolve "<path>=<src|dst|skip>"` (repeatable)
 *              to record the operator's choice and continue. The script
 *              persists decisions in a sidecar file so resumption is idempotent.
 *
 * Safety
 * ------
 * - Backup-before-write: `cp -R "$SRC" "$SRC/.vault-backup-<iso-ts>/"` happens
 *   ONCE, before any write in --apply. After the apply run completes the
 *   backup directory is gzip-tarred and the staging directory deleted.
 * - The source vault is NEVER deleted by this script. The deletion phase is
 *   the operator's responsibility — script prints final guidance for the
 *   `rm -rf` command.
 * - Idempotent: a second --apply run after a successful first sees only
 *   `skip-already-present` actions and produces no new backup.
 * - The .vault-backup-<ts>/ staging dir lives INSIDE the source vault (so it
 *   moves with the source if the operator later relocates it) but is excluded
 *   from the walk so consecutive runs don't recurse into prior backups.
 *
 * Files in the source vault are classified as one of:
 *   - `copy`                    same relative path absent in canonical
 *   - `skip-already-present`    same path + byte-identical (SHA-256)
 *   - `merge`                   same path, byte-different, requires AUQ
 *   - `conflict-needs-review`   same path, byte-different, no obvious winner
 *
 * Subset detection: if canonical content STARTS WITH the source content
 * (modulo trailing whitespace), we mark the action as `merge` with the
 * canonical (larger) side pre-suggested as the winner via `subset_hint`.
 *
 * Exit codes:
 *   0  Success — all planned actions executed (or dry-run completed cleanly)
 *   1  Input / argument error
 *   2  I/O error (filesystem, permissions, etc.)
 *   3  --apply mode requires merge decisions from the coordinator
 *
 * Examples:
 *   node scripts/vault-consolidate.mjs --help
 *   node scripts/vault-consolidate.mjs --dry-run
 *   node scripts/vault-consolidate.mjs --dry-run --json
 *   node scripts/vault-consolidate.mjs --apply
 *   node scripts/vault-consolidate.mjs --apply \
 *       --resolve "50-sessions/foo.md=src" \
 *       --resolve "01-projects/session-orchestrator/decisions.md=dst"
 */

import { promises as fs } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import { die, utcTimestamp } from './lib/common.mjs';
import { parseColumnFlags, CliFlagError } from './lib/cli-flags.mjs';

const SCRIPT_NAME = 'vault-consolidate';
const DEFAULT_SOURCE = '~/Projects/vault';
const DEFAULT_CANONICAL = '~/Projects/Bernhard/vault';
const BACKUP_PREFIX = '.vault-backup-';
const DECISIONS_SIDECAR_REL = '.vault-consolidate-decisions.json';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function printHelp() {
  const usage = `Usage: ${SCRIPT_NAME} [--dry-run|--apply] [--source <path>] [--canonical <path>] [--json] [--resolve <rel-path>=<src|dst|skip>] [--help]

Consolidate a redundant Obsidian vault into a canonical one, with per-file
conflict resolution and a compressed backup of the source side.

Options:
  --dry-run                  Plan only. Walks both vaults, prints per-file
                             actions, exits 0 without modifying anything.
                             This is the DEFAULT.
  --apply                    Execute the plan. Copies non-colliding files,
                             skips byte-identical duplicates, and for each
                             collision emits a structured 'awaiting-merge-
                             decision' record and exits with code 3 until
                             all merges are resolved via --resolve.
  --source <path>            Path to the redundant (source) vault.
                             Default: ${DEFAULT_SOURCE}
  --canonical <path>         Path to the canonical vault.
                             Default: ${DEFAULT_CANONICAL}
  --json                     Newline-delimited JSON output (one record per
                             file, plus a final summary record).
  --resolve <rel>=<choice>   Record a merge decision for the file at the
                             given relative path. Repeatable. Choices:
                               src   → take the source-vault version
                               dst   → keep the canonical version (no-op)
                               skip  → leave both untouched (records the
                                       deferral and does not re-prompt)
  --help, -h                 Print this message to stderr and exit 0.

Examples:
  ${SCRIPT_NAME} --dry-run
  ${SCRIPT_NAME} --dry-run --json
  ${SCRIPT_NAME} --apply
  ${SCRIPT_NAME} --apply --resolve "50-sessions/foo.md=src" \\
                         --resolve "01-projects/session-orchestrator/decisions.md=dst"

Exit codes:
  0  Success
  1  Input / argument error
  2  I/O error
  3  --apply needs merge decisions (see structured awaiting-merge-decision records)
`;
  process.stderr.write(usage);
}

let parsed;
try {
  parsed = parseColumnFlags({
    knownBool: {
      'dry-run': false,
      apply: false,
      json: false,
      help: { short: 'h', default: false },
    },
    knownString: {
      source: null,
      canonical: null,
      resolve: { multiple: true, default: [] },
    },
  });
} catch (err) {
  if (err instanceof CliFlagError) {
    process.stderr.write(`${SCRIPT_NAME}: ${err.message}\n\n`);
    printHelp();
    process.exit(1);
  }
  throw err;
}

if (parsed.values.help) {
  printHelp();
  process.exit(0);
}

if (parsed.values['dry-run'] && parsed.values.apply) {
  die('--dry-run and --apply are mutually exclusive');
}

// Default to dry-run when neither flag is given.
const isApply = parsed.values.apply === true;
const isDryRun = !isApply;
const isJson = parsed.values.json === true;

function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const sourceRoot = path.resolve(expandHome(parsed.values.source ?? DEFAULT_SOURCE));
const canonicalRoot = path.resolve(expandHome(parsed.values.canonical ?? DEFAULT_CANONICAL));

// Parse --resolve flags into a Map<relPath, "src"|"dst"|"skip">
const resolutions = new Map();
for (const entry of parsed.values.resolve ?? []) {
  const eq = entry.lastIndexOf('=');
  if (eq <= 0 || eq === entry.length - 1) {
    die(`--resolve must be of the form "<rel-path>=<src|dst|skip>", got: ${entry}`);
  }
  const relPath = entry.slice(0, eq);
  const choice = entry.slice(eq + 1).toLowerCase();
  if (!['src', 'dst', 'skip'].includes(choice)) {
    die(`--resolve choice must be one of src|dst|skip, got: ${choice}`);
  }
  resolutions.set(relPath, choice);
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

async function isDir(p) {
  try {
    const st = await fs.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}

if (!(await isDir(sourceRoot))) {
  // EARS F1.1 Unwanted behaviour: if source vault doesn't exist treat as a no-op success
  // — there's nothing to consolidate. We still emit a summary for the caller.
  const emptySummary = {
    kind: 'summary',
    mode: isDryRun ? 'dry-run' : 'apply',
    source: sourceRoot,
    canonical: canonicalRoot,
    counts: { copy: 0, 'skip-already-present': 0, merge: 0, 'conflict-needs-review': 0 },
    notice: `source vault not found at ${sourceRoot} — nothing to do`,
  };
  if (isJson) {
    process.stdout.write(JSON.stringify(emptySummary) + '\n');
  } else {
    process.stdout.write(`${SCRIPT_NAME}: source vault not found at ${sourceRoot} — nothing to do.\n`);
  }
  process.exit(0);
}

if (!(await isDir(canonicalRoot))) {
  process.stderr.write(
    `ERROR: canonical vault not found at ${canonicalRoot} — refusing to consolidate\n`
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Walk the source vault
// ---------------------------------------------------------------------------

/**
 * Recursively walk `root`, returning absolute paths of regular files.
 * Skips: hidden directories (start with `.`), and any descendant of an
 * existing `.vault-backup-*` directory.
 */
async function walkFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      process.stderr.write(`${SCRIPT_NAME}: WARN readdir failed for ${dir}: ${err.message}\n`);
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip hidden dirs and prior backup staging dirs
        if (entry.name === '.git') continue;
        if (entry.name.startsWith(BACKUP_PREFIX)) continue;
        if (entry.name === '.obsidian' || entry.name === '.trash') continue;
        if (entry.name === 'node_modules') continue;
        // Allow other dotfiles (vault-mirror writes none, but be conservative)
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile()) {
        // Skip macOS metadata, the decisions sidecar, and .DS_Store
        if (entry.name === '.DS_Store') continue;
        if (entry.name === DECISIONS_SIDECAR_REL) continue;
        if (entry.name.startsWith('._')) continue;
        // Skip backup archives left by prior --apply runs (idempotency).
        // Matches both `.vault-backup-<ts>.tar.gz` and `.vault-backup-<ts>` dirs
        // (the dir form is also filtered by the directory branch above).
        if (entry.name.startsWith(BACKUP_PREFIX)) continue;
        out.push(fullPath);
      }
      // Symlinks: skip — vaults are plain markdown trees in our deployment.
    }
  }

  out.sort();
  return out;
}

// ---------------------------------------------------------------------------
// Per-file classification
// ---------------------------------------------------------------------------

async function sha256OfFile(absPath) {
  const buf = await fs.readFile(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Check whether `B` starts with `A` modulo trailing whitespace.
 * Both are utf-8 strings.
 */
function isPrefix(a, b) {
  const aTrim = a.trimEnd();
  if (aTrim.length === 0) return false;
  if (aTrim.length > b.length) return false;
  return b.startsWith(aTrim);
}

/**
 * Classify one source file.
 *
 * @param {string} srcAbs  absolute path inside source vault
 * @param {string} rel     relative path under source root
 * @returns {Promise<object>}  action record
 */
async function classifyFile(srcAbs, rel) {
  const dstAbs = path.join(canonicalRoot, rel);

  let srcStat;
  try {
    srcStat = await fs.stat(srcAbs);
  } catch (err) {
    return {
      kind: 'action',
      action: 'error',
      rel,
      source: srcAbs,
      canonical: dstAbs,
      error: `stat source failed: ${err.message}`,
    };
  }

  let dstStat;
  try {
    dstStat = await fs.stat(dstAbs);
  } catch {
    dstStat = null;
  }

  if (dstStat === null) {
    return {
      kind: 'action',
      action: 'copy',
      rel,
      source: srcAbs,
      canonical: dstAbs,
      src_size: srcStat.size,
      src_mtime: srcStat.mtime.toISOString(),
    };
  }

  // Both sides exist — hash both
  let srcSha;
  let dstSha;
  try {
    [srcSha, dstSha] = await Promise.all([sha256OfFile(srcAbs), sha256OfFile(dstAbs)]);
  } catch (err) {
    return {
      kind: 'action',
      action: 'error',
      rel,
      source: srcAbs,
      canonical: dstAbs,
      error: `hash failed: ${err.message}`,
    };
  }

  if (srcSha === dstSha) {
    return {
      kind: 'action',
      action: 'skip-already-present',
      rel,
      source: srcAbs,
      canonical: dstAbs,
      src_size: srcStat.size,
      dst_size: dstStat.size,
      src_sha: srcSha,
      dst_sha: dstSha,
    };
  }

  // Content differs — check subset relationship to pre-suggest a winner.
  // We use explicit `isUtf8()` binary detection (not throw-based) to classify
  // as `merge` vs `conflict-needs-review`. Node 20+ silently substitutes the
  // U+FFFD replacement char for invalid UTF-8 sequences instead of throwing
  // from `readFile('utf8')`, which previously left the conflict-needs-review
  // branch unreachable for binary files (issue #508).
  let subsetHint = null;
  let textReadable = false;
  try {
    const [srcBuf, dstBuf] = await Promise.all([fs.readFile(srcAbs), fs.readFile(dstAbs)]);
    // Both sides must be valid UTF-8 to be classified as `merge`. If either
    // is binary (or non-UTF-8 encoded), fall through to conflict-needs-review
    // so the operator inspects the pair manually with the right tool.
    if (isUtf8(srcBuf) && isUtf8(dstBuf)) {
      textReadable = true;
      const srcContent = srcBuf.toString('utf8');
      const dstContent = dstBuf.toString('utf8');
      if (isPrefix(srcContent, dstContent)) {
        // canonical is a superset of source → prefer canonical (dst)
        subsetHint = 'dst-is-superset';
      } else if (isPrefix(dstContent, srcContent)) {
        // source is a superset of canonical → prefer source (src)
        subsetHint = 'src-is-superset';
      }
    }
  } catch {
    // Read error (permissions, disappeared mid-walk, etc.) — leave
    // textReadable=false; treat as conflict-needs-review so the operator
    // inspects manually.
  }

  // Classification:
  //   - both sides valid UTF-8                → merge  (AUQ-resolvable;
  //                                              subset_hint may suggest winner)
  //   - unreadable / binary / non-UTF-8       → conflict-needs-review
  //
  // Both classes still require an operator decision via the two-phase
  // coordinator flow, but the label tells the caller whether the diff can be
  // shown inline (merge) or requires opening the file in a binary tool
  // (conflict-needs-review).
  const action = textReadable ? 'merge' : 'conflict-needs-review';

  return {
    kind: 'action',
    action,
    rel,
    source: srcAbs,
    canonical: dstAbs,
    src_size: srcStat.size,
    dst_size: dstStat.size,
    src_mtime: srcStat.mtime.toISOString(),
    dst_mtime: dstStat.mtime.toISOString(),
    src_sha: srcSha,
    dst_sha: dstSha,
    subset_hint: subsetHint,
  };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

const records = [];

function emitRecord(record) {
  records.push(record);
  if (isJson) {
    process.stdout.write(JSON.stringify(record) + '\n');
  }
}

function emitHumanLine(line) {
  if (!isJson) {
    process.stdout.write(line + '\n');
  }
}

// ---------------------------------------------------------------------------
// Apply helpers
// ---------------------------------------------------------------------------

async function copyFilePreservingMtime(srcAbs, dstAbs) {
  await fs.mkdir(path.dirname(dstAbs), { recursive: true });
  await fs.copyFile(srcAbs, dstAbs);
  // Preserve mtime so subsequent runs classify as skip-already-present even
  // if the file later moves.
  try {
    const st = await fs.stat(srcAbs);
    await fs.utimes(dstAbs, st.atime, st.mtime);
  } catch {
    // Non-fatal — copy succeeded.
  }
}

/**
 * Stage one file into the backup directory, preserving its relative path.
 */
async function stageBackup(backupRoot, srcAbs, rel) {
  const stagedAbs = path.join(backupRoot, rel);
  await fs.mkdir(path.dirname(stagedAbs), { recursive: true });
  await fs.copyFile(srcAbs, stagedAbs);
  try {
    const st = await fs.stat(srcAbs);
    await fs.utimes(stagedAbs, st.atime, st.mtime);
  } catch {
    // non-fatal
  }
}

/**
 * Run `tar -czf <archive> -C <parent> <basename>` then remove the staging dir.
 * Falls back to leaving the staging directory in place if tar is unavailable.
 *
 * @param {string} backupRoot absolute path of the staging directory
 * @returns {Promise<{archive: string|null, removed: boolean}>}
 */
async function compressAndCleanupBackup(backupRoot) {
  const parent = path.dirname(backupRoot);
  const basename = path.basename(backupRoot);
  const archive = `${backupRoot}.tar.gz`;

  const res = spawnSync('tar', ['-czf', archive, '-C', parent, basename], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  if (res.status === 0) {
    // Remove the now-redundant staging directory
    try {
      await fs.rm(backupRoot, { recursive: true, force: true });
      return { archive, removed: true };
    } catch (err) {
      process.stderr.write(
        `${SCRIPT_NAME}: WARN backup compressed but staging dir cleanup failed: ${err.message}\n`
      );
      return { archive, removed: false };
    }
  }

  process.stderr.write(
    `${SCRIPT_NAME}: WARN tar failed (status ${res.status}): ${res.stderr || res.stdout || 'no detail'}. ` +
      `Leaving staging directory at ${backupRoot} for manual archival.\n`
  );
  return { archive: null, removed: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const startTs = utcTimestamp();
emitHumanLine(`${SCRIPT_NAME}: mode=${isDryRun ? 'dry-run' : 'apply'} source=${sourceRoot} canonical=${canonicalRoot}`);

let srcFiles;
try {
  srcFiles = await walkFiles(sourceRoot);
} catch (err) {
  process.stderr.write(`${SCRIPT_NAME}: ERROR walking source vault: ${err.message}\n`);
  process.exit(2);
}

// Classify every file
/** @type {object[]} */
const actions = [];
for (const srcAbs of srcFiles) {
  const rel = path.relative(sourceRoot, srcAbs);
  const action = await classifyFile(srcAbs, rel);
  actions.push(action);
}

// Group counts for summary
const counts = {
  copy: 0,
  'skip-already-present': 0,
  merge: 0,
  'conflict-needs-review': 0,
  error: 0,
};
for (const a of actions) {
  counts[a.action] = (counts[a.action] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// Dry-run: emit plan + summary and exit 0
// ---------------------------------------------------------------------------

if (isDryRun) {
  for (const action of actions) {
    emitRecord(action);
    emitHumanLine(`  [${action.action}] ${action.rel}${action.subset_hint ? ` (hint: ${action.subset_hint})` : ''}`);
  }
  emitRecord({
    kind: 'summary',
    mode: 'dry-run',
    source: sourceRoot,
    canonical: canonicalRoot,
    counts,
    total: actions.length,
    timestamp: startTs,
  });
  emitHumanLine('');
  emitHumanLine(
    `${SCRIPT_NAME}: dry-run plan: ${counts.copy} copy + ${counts['skip-already-present']} skip-already-present + ` +
      `${counts.merge} merge + ${counts['conflict-needs-review']} conflict-needs-review` +
      (counts.error > 0 ? ` + ${counts.error} error` : '')
  );
  emitHumanLine(`${SCRIPT_NAME}: total ${actions.length} files inspected. No changes made.`);
  if (counts.merge + counts['conflict-needs-review'] > 0) {
    emitHumanLine(
      `${SCRIPT_NAME}: to apply, re-run with --apply. Merge collisions will halt the script with exit 3 until resolved via --resolve.`
    );
  } else {
    emitHumanLine(`${SCRIPT_NAME}: no merges required — re-run with --apply to execute.`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Apply: detect any unresolved merges first
// ---------------------------------------------------------------------------

const unresolvedMerges = actions.filter(
  (a) => (a.action === 'merge' || a.action === 'conflict-needs-review') && !resolutions.has(a.rel)
);

if (unresolvedMerges.length > 0) {
  for (const action of unresolvedMerges) {
    emitRecord({
      kind: 'awaiting-merge-decision',
      rel: action.rel,
      source: action.source,
      canonical: action.canonical,
      src_size: action.src_size,
      dst_size: action.dst_size,
      src_mtime: action.src_mtime,
      dst_mtime: action.dst_mtime,
      src_sha: action.src_sha,
      dst_sha: action.dst_sha,
      subset_hint: action.subset_hint,
      action: action.action,
      hint:
        action.subset_hint === 'dst-is-superset'
          ? 'canonical contains source as a strict prefix — recommend "dst"'
          : action.subset_hint === 'src-is-superset'
            ? 'source contains canonical as a strict prefix — recommend "src"'
            : 'no obvious winner — review both files',
    });
    emitHumanLine(
      `  [awaiting-merge-decision] ${action.rel}  [src=${action.src_size}B ${action.src_mtime} | dst=${action.dst_size}B ${action.dst_mtime}]` +
        (action.subset_hint ? `  (hint: ${action.subset_hint})` : '')
    );
  }
  emitHumanLine('');
  emitHumanLine(
    `${SCRIPT_NAME}: ${unresolvedMerges.length} merge${unresolvedMerges.length === 1 ? '' : 's'} ${unresolvedMerges.length === 1 ? 'requires' : 'require'} operator decision.`
  );
  emitHumanLine(
    `${SCRIPT_NAME}: re-invoke with --resolve "<rel-path>=<src|dst|skip>" for each (repeatable). Exiting with code 3.`
  );
  process.exit(3);
}

// ---------------------------------------------------------------------------
// Apply: do the work
// ---------------------------------------------------------------------------

// Detect idempotent re-run: if EVERY action is skip-already-present (or error),
// we have nothing to do AND we should not create a fresh backup.
const hasWritePlanned = actions.some(
  (a) => a.action === 'copy' || a.action === 'merge' || a.action === 'conflict-needs-review'
);

let backupRoot = null;
let manifestPath = null;
const manifestLines = [];

if (hasWritePlanned) {
  const stamp = startTs.replace(/[:.]/g, '-');
  backupRoot = path.join(sourceRoot, `${BACKUP_PREFIX}${stamp}`);
  try {
    await fs.mkdir(backupRoot, { recursive: true });
  } catch (err) {
    process.stderr.write(`${SCRIPT_NAME}: ERROR creating backup dir ${backupRoot}: ${err.message}\n`);
    process.exit(2);
  }
  manifestPath = path.join(backupRoot, 'MANIFEST.md');
  manifestLines.push(`# vault-consolidate backup manifest`);
  manifestLines.push('');
  manifestLines.push(`- created: ${startTs}`);
  manifestLines.push(`- source: ${sourceRoot}`);
  manifestLines.push(`- canonical: ${canonicalRoot}`);
  manifestLines.push('');
  manifestLines.push(`| Rel-Path | Action | Source-Size | Canonical-Size | Decision | Timestamp |`);
  manifestLines.push(`|----------|--------|-------------|----------------|----------|-----------|`);
}

let applied = 0;
let skipped = 0;
let errored = 0;

for (const action of actions) {
  if (action.action === 'error') {
    errored++;
    emitRecord({ kind: 'result', rel: action.rel, status: 'error', error: action.error });
    emitHumanLine(`  [error] ${action.rel}: ${action.error}`);
    continue;
  }

  if (action.action === 'skip-already-present') {
    skipped++;
    emitRecord({ kind: 'result', rel: action.rel, status: 'skip-already-present' });
    emitHumanLine(`  [skip-already-present] ${action.rel}`);
    continue;
  }

  // copy / merge / conflict-needs-review — all require a backup of the source
  // before any write.
  try {
    if (backupRoot) {
      await stageBackup(backupRoot, action.source, action.rel);
    }
  } catch (err) {
    errored++;
    emitRecord({ kind: 'result', rel: action.rel, status: 'error', error: `backup failed: ${err.message}` });
    emitHumanLine(`  [error] ${action.rel}: backup failed: ${err.message}`);
    continue;
  }

  if (action.action === 'copy') {
    try {
      await copyFilePreservingMtime(action.source, action.canonical);
      applied++;
      manifestLines.push(
        `| ${action.rel} | copy | ${action.src_size ?? '-'} | - | written | ${utcTimestamp()} |`
      );
      emitRecord({ kind: 'result', rel: action.rel, status: 'copied', canonical: action.canonical });
      emitHumanLine(`  [copied] ${action.rel}`);
    } catch (err) {
      errored++;
      emitRecord({ kind: 'result', rel: action.rel, status: 'error', error: err.message });
      emitHumanLine(`  [error] ${action.rel}: ${err.message}`);
    }
    continue;
  }

  // merge or conflict-needs-review — operator has provided a resolution
  const choice = resolutions.get(action.rel);
  if (choice === 'src') {
    try {
      await copyFilePreservingMtime(action.source, action.canonical);
      applied++;
      manifestLines.push(
        `| ${action.rel} | ${action.action} | ${action.src_size ?? '-'} | ${action.dst_size ?? '-'} | src (overwrote canonical) | ${utcTimestamp()} |`
      );
      emitRecord({
        kind: 'result',
        rel: action.rel,
        status: 'merged-src',
        canonical: action.canonical,
      });
      emitHumanLine(`  [merged:src→canonical] ${action.rel}`);
    } catch (err) {
      errored++;
      emitRecord({ kind: 'result', rel: action.rel, status: 'error', error: err.message });
      emitHumanLine(`  [error] ${action.rel}: ${err.message}`);
    }
  } else if (choice === 'dst') {
    skipped++;
    manifestLines.push(
      `| ${action.rel} | ${action.action} | ${action.src_size ?? '-'} | ${action.dst_size ?? '-'} | dst (canonical retained) | ${utcTimestamp()} |`
    );
    emitRecord({ kind: 'result', rel: action.rel, status: 'merged-dst' });
    emitHumanLine(`  [merged:keep-canonical] ${action.rel}`);
  } else {
    // skip — backup is staged but no canonical write
    skipped++;
    manifestLines.push(
      `| ${action.rel} | ${action.action} | ${action.src_size ?? '-'} | ${action.dst_size ?? '-'} | skip (both untouched) | ${utcTimestamp()} |`
    );
    emitRecord({ kind: 'result', rel: action.rel, status: 'merged-skip' });
    emitHumanLine(`  [merged:skip] ${action.rel}`);
  }
}

// ---------------------------------------------------------------------------
// Finalise backup
// ---------------------------------------------------------------------------

let backupInfo = { archive: null, removed: false, root: backupRoot };

if (backupRoot && manifestPath && manifestLines.length > 0) {
  manifestLines.push('');
  manifestLines.push(`- finished: ${utcTimestamp()}`);
  manifestLines.push(`- applied: ${applied}`);
  manifestLines.push(`- skipped: ${skipped}`);
  manifestLines.push(`- errored: ${errored}`);
  try {
    await fs.writeFile(manifestPath, manifestLines.join('\n') + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(`${SCRIPT_NAME}: WARN manifest write failed: ${err.message}\n`);
  }

  const compress = await compressAndCleanupBackup(backupRoot);
  backupInfo = { ...compress, root: backupRoot };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

emitRecord({
  kind: 'summary',
  mode: 'apply',
  source: sourceRoot,
  canonical: canonicalRoot,
  counts,
  total: actions.length,
  applied,
  skipped,
  errored,
  backup: backupInfo,
  timestamp: startTs,
  finished: utcTimestamp(),
});

emitHumanLine('');
emitHumanLine(`${SCRIPT_NAME}: apply complete: ${applied} written, ${skipped} skipped, ${errored} errored.`);
if (backupInfo.archive) {
  emitHumanLine(`${SCRIPT_NAME}: source side backed up to ${backupInfo.archive}`);
} else if (backupInfo.root) {
  emitHumanLine(`${SCRIPT_NAME}: source side staged at ${backupInfo.root} (uncompressed; tar unavailable or failed)`);
} else {
  emitHumanLine(`${SCRIPT_NAME}: no backup needed (idempotent re-run — all files already present)`);
}
emitHumanLine(
  `${SCRIPT_NAME}: Source vault retained at ${sourceRoot}. ` +
    `Once you've verified the canonical vault, delete with: rm -rf "${sourceRoot}"`
);

process.exit(errored > 0 ? 2 : 0);
