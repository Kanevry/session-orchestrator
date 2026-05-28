/**
 * vault-consolidate-fs.mjs — filesystem + classification helpers for
 * scripts/vault-consolidate.mjs (Issue #514 / #607).
 *
 * Extracted from the previously-monolithic vault-consolidate.mjs so the
 * walk / hash / classify / backup logic is unit-importable in isolation. The
 * script itself (vault-consolidate.mjs) wires these helpers behind an
 * `import.meta.url === pathToFileURL(process.argv[1])` entry-guard so importing
 * the script no longer executes the migration as a top-level side effect.
 *
 * Every function here is behaviour-identical to its former in-script form;
 * the only change is that previously-closed-over module constants/state
 * (SCRIPT_NAME, BACKUP_PREFIX, DECISIONS_SIDECAR_REL, canonicalRoot) are now
 * exported constants / explicit parameters so the helpers are pure with
 * respect to their inputs.
 */

import { promises as fs } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const SCRIPT_NAME = 'vault-consolidate';
export const BACKUP_PREFIX = '.vault-backup-';
export const DECISIONS_SIDECAR_REL = '.vault-consolidate-decisions.json';

/**
 * Recursively walk `root`, returning absolute paths of regular files.
 * Skips: hidden directories (start with `.`), and any descendant of an
 * existing `.vault-backup-*` directory.
 */
export async function walkFiles(root) {
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

      // F5 (issue #514 fold-in) — symlink guard, evaluated FIRST.
      //
      // `fs.readdir(dir, { withFileTypes: true })` populates each Dirent from
      // an `lstat` of the entry, so a symlink-to-directory already reports
      // `isDirectory() === false` (and `isSymbolicLink() === true`) and would
      // fall through both branches below untouched. This explicit guard makes
      // the skip OBSERVABLE (a WARN line) and hardens against any future
      // refactor that switches to `fs.stat`-based classification — which DOES
      // follow symlinks and could recurse into an out-of-tree directory or
      // copy a dereferenced target into the backup. We never follow a symlink:
      // neither symlinked directories (recursion risk) nor symlinked files
      // (the dereference-into-backup risk #514 also guards at stageBackup).
      if (entry.isSymbolicLink()) {
        process.stderr.write(
          `${SCRIPT_NAME}: WARN skipping symlink (not dereferenced): ${fullPath}\n`
        );
        continue;
      }

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
      // (Symlinks already handled by the isSymbolicLink() guard above.)
    }
  }

  out.sort();
  return out;
}

export async function sha256OfFile(absPath) {
  const buf = await fs.readFile(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Check whether `B` starts with `A` modulo trailing whitespace.
 * Both are utf-8 strings.
 */
export function isPrefix(a, b) {
  const aTrim = a.trimEnd();
  if (aTrim.length === 0) return false;
  if (aTrim.length > b.length) return false;
  return b.startsWith(aTrim);
}

/**
 * Classify one source file.
 *
 * @param {string} srcAbs         absolute path inside source vault
 * @param {string} rel            relative path under source root
 * @param {string} canonicalRoot  absolute path of the canonical vault root
 * @returns {Promise<object>}     action record
 */
export async function classifyFile(srcAbs, rel, canonicalRoot) {
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

/**
 * Stage one file into the backup directory, preserving its relative path.
 *
 * #514 — symlink defense (defense-in-depth alongside the walk-level guard).
 * `fs.copyFile()` and `fs.stat()` both FOLLOW symlinks, so a symlinked source
 * entry (e.g. `evil.md → /etc/passwd`) would silently copy the TARGET's
 * contents into the backup. We `fs.lstat()` first (which does NOT follow the
 * link) and skip the copy entirely if the source is a symlink, so a symlink is
 * never dereferenced into the backup.
 *
 * @returns {Promise<{staged: boolean}>}  staged=false when skipped (symlink)
 */
export async function stageBackup(backupRoot, srcAbs, rel) {
  const linkStat = await fs.lstat(srcAbs);
  if (linkStat.isSymbolicLink()) {
    process.stderr.write(
      `${SCRIPT_NAME}: WARN refusing to back up symlink (not dereferenced): ${srcAbs}\n`
    );
    return { staged: false };
  }

  const stagedAbs = path.join(backupRoot, rel);
  await fs.mkdir(path.dirname(stagedAbs), { recursive: true });
  await fs.copyFile(srcAbs, stagedAbs);
  try {
    const st = await fs.stat(srcAbs);
    await fs.utimes(stagedAbs, st.atime, st.mtime);
  } catch {
    // non-fatal
  }
  return { staged: true };
}

/**
 * Run `tar -czf <archive> -C <parent> <basename>` then remove the staging dir.
 * Falls back to leaving the staging directory in place if tar is unavailable.
 *
 * @param {string} backupRoot absolute path of the staging directory
 * @returns {Promise<{archive: string|null, removed: boolean}>}
 */
export async function compressAndCleanupBackup(backupRoot) {
  const parent = path.dirname(backupRoot);
  const basename = path.basename(backupRoot);
  const archive = `${backupRoot}.tar.gz`;

  const res = spawnSync('tar', ['-czf', archive, '-C', parent, basename], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });

  // F1 (issue #514 fold-in) — distinguish "tar not on PATH" (ENOENT) from a
  // non-zero tar exit. On ENOENT `spawnSync` sets `res.error` and leaves
  // `res.status === null`; the generic branch below would otherwise print a
  // confusing "tar failed (status null)". Surface the real cause and keep the
  // uncompressed staging dir as the documented fallback.
  if (res.error) {
    const reason = res.error.code === 'ENOENT' ? 'tar not found on PATH' : res.error.message;
    process.stderr.write(
      `${SCRIPT_NAME}: WARN ${reason} — cannot compress backup. ` +
        `Leaving staging directory at ${backupRoot} for manual archival.\n`
    );
    return { archive: null, removed: false };
  }

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
