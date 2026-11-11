#!/usr/bin/env node
/**
 * Check: no NEW direct rename call outside the shared atomic writers
 * (GitLab #1865, AC 3). BLOCKING.
 *
 * ## Why
 *
 * A hand-rolled tmp-file + rename is the write pattern #1865 retired from the
 * four priority stores: it lacks the retry on Windows `EPERM`/`EBUSY` and
 * the tmp cleanup that `scripts/lib/io.mjs` (`writeJsonAtomic`,
 * `writeJsonAtomicSync`, `atomicWriteWithBackup`, `atomicWriteText`,
 * `renameWithRetry`) and `hooks/_lib/atomic-json.mjs` (`atomicMutateJson`)
 * carry. The remaining sites are migrated in a later pass; this check keeps
 * their number from growing in the meantime.
 *
 * ## Rules
 *
 *   - Population: every `.mjs/.cjs/.js` file under `scripts/` and `hooks/`
 *     (via `enumerateRepoFiles`, tracked plus untracked-not-ignored), minus the
 *     two helper modules that implement the writers.
 *   - A site is a `rename` or `renameSync` identifier directly followed by an
 *     opening parenthesis (`fs.renameSync`, `io.renameSync`, a bare import —
 *     `renameWithRetry` does not match).
 *   - Comment-only lines (`//`, `/*`, `*`) are skipped.
 *   - A site whose line, or a comment-only line directly above it, carries the marker
 *     `// direct-rename:ok <reason>` is exempt (a reason is required): use it
 *     for a rename that is not a write — a tombstone move, a rotation.
 *   - The remaining per-file counts are compared with ALLOWLIST (a ratchet):
 *     a file above its count, or a file not on the list, FAILS. A file below
 *     its count PASSES and is reported as "ratchet can be tightened", so the
 *     list only shrinks.
 *   - Vacuum guard: a census of zero files FAILS — a broken enumeration must
 *     not pass.
 *
 * @module scripts/lib/validate/check-direct-rename
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { enumerateRepoFiles } from './enumerate-repo-files.mjs';
import { isMainModule } from '../is-main-module.mjs';

/** Directories whose code is scanned. */
export const SCAN_DIRS = Object.freeze(['scripts', 'hooks']);

/** The helper modules that implement the atomic writers — their renames are the point. */
export const HELPER_MODULES = Object.freeze(['scripts/lib/io.mjs', 'hooks/_lib/atomic-json.mjs']);

/**
 * Ratchet: repo-relative file → number of direct rename sites still allowed.
 * Census 2026-11-02 (#1865 part 2, working tree on top of f646c935): 0 sites —
 * every remaining direct rename carries a same-line `direct-rename:ok` marker
 * naming why the shared retry does not apply. The list is empty on purpose: a
 * new direct rename fails until it migrates to `renameWithRetry` /
 * `renameSyncWithRetry` (scripts/lib/io.mjs) or carries an honest marker.
 */
export const ALLOWLIST = Object.freeze({});

// Written as an alternation so this module's own source does not match itself.
const RENAME_RE = /\b(?:rename|renameSync)\(/g;
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/;
const MARKER_RE = /direct-rename:ok\s+\S/;

export const HINT =
  'use writeJsonAtomic/atomicWriteText/renameWithRetry from scripts/lib/io.mjs (#1865), ' +
  'or mark an intentional non-write rename with // direct-rename:ok <reason>';

/**
 * Direct rename sites of one file's source text.
 *
 * @param {string} source file contents
 * @returns {{ line: number, text: string }[]} one entry per call (a line with two calls yields two)
 */
export function findDirectRenames(source) {
  const lines = source.split('\n');
  const sites = [];
  lines.forEach((text, i) => {
    if (COMMENT_LINE_RE.test(text)) return;
    const hits = text.match(RENAME_RE);
    if (!hits) return;
    if (MARKER_RE.test(text) || (i > 0 && COMMENT_LINE_RE.test(lines[i - 1]) && MARKER_RE.test(lines[i - 1]))) return;
    for (let k = 0; k < hits.length; k += 1) sites.push({ line: i + 1, text: text.trim() });
  });
  return sites;
}

/**
 * Scan the code corpus and compare per-file counts against the ratchet.
 *
 * @param {{ pluginRoot: string, dirs?: readonly string[], allowlist?: Readonly<Record<string, number>> }} opts
 * @returns {{ ok: boolean, vacuum: boolean,
 *   findings: { file: string, allowed: number, actual: number, sites: { line: number, text: string }[] }[],
 *   tightenable: { file: string, allowed: number, actual: number }[],
 *   summary: { filesScanned: number, sites: number, filesWithSites: number } }}
 */
export function scanDirectRenames({ pluginRoot, dirs = SCAN_DIRS, allowlist = ALLOWLIST }) {
  const files = enumerateRepoFiles({ repoRoot: pluginRoot, dirs: [...dirs], exts: ['.mjs', '.cjs', '.js'] });
  const counts = new Map();
  let filesScanned = 0;
  for (const abs of files) {
    const rel = path.relative(pluginRoot, abs).split(path.sep).join('/');
    if (HELPER_MODULES.includes(rel)) continue;
    filesScanned += 1;
    const sites = findDirectRenames(readFileSync(abs, 'utf8'));
    if (sites.length > 0) counts.set(rel, sites);
  }
  const findings = [];
  const tightenable = [];
  let total = 0;
  for (const [file, sites] of counts) {
    total += sites.length;
    const allowed = Object.hasOwn(allowlist, file) ? allowlist[file] : 0;
    if (sites.length > allowed) findings.push({ file, allowed, actual: sites.length, sites });
  }
  for (const [file, allowed] of Object.entries(allowlist)) {
    const actual = counts.get(file)?.length ?? 0;
    if (actual < allowed) tightenable.push({ file, allowed, actual });
  }
  findings.sort((a, b) => a.file.localeCompare(b.file));
  tightenable.sort((a, b) => a.file.localeCompare(b.file));
  const vacuum = filesScanned === 0;
  return {
    ok: !vacuum && findings.length === 0,
    vacuum,
    findings,
    tightenable,
    summary: { filesScanned, sites: total, filesWithSites: counts.size },
  };
}

/**
 * Run the human-readable validator CLI.
 *
 * @param {string} pluginRoot absolute plugin root
 * @returns {number} 0 = clean, 1 = findings or empty census
 */
export function runCheckDirectRename(pluginRoot) {
  console.log('--- Check: no new direct rename calls outside the atomic writers (#1865) ---');
  const inspection = scanDirectRenames({ pluginRoot });
  if (inspection.vacuum) {
    console.log(`  FAIL: census found 0 code files under ${SCAN_DIRS.join(', ')} — enumeration is broken`);
  }
  for (const f of inspection.findings) {
    const where = f.sites.map((s) => s.line).join(', ');
    console.log(`  FAIL: ${f.file} has ${f.actual} direct rename call(s), allowlist ${f.allowed} (line ${where})`);
  }
  if (inspection.findings.length > 0) console.log(`  hint: ${HINT}`);
  for (const t of inspection.tightenable) {
    console.log(`  NOTE: ratchet can be tightened: ${t.file} ${t.allowed} → ${t.actual}`);
  }
  const s = inspection.summary;
  if (inspection.ok) {
    console.log(
      `  PASS: ${s.sites} allowlisted direct rename call(s) in ${s.filesWithSites} file(s), ` +
        `${s.filesScanned} file(s) scanned`,
    );
  }
  const failed = inspection.findings.length + (inspection.vacuum ? 1 : 0);
  console.log('');
  console.log(`Results: ${inspection.ok ? 1 : 0} passed, ${failed} failed`);
  return inspection.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2).filter((arg) => arg !== '--json');
  const root = path.resolve(args[0] || process.cwd());
  if (process.argv.includes('--json')) {
    const inspection = scanDirectRenames({ pluginRoot: root });
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exitCode = inspection.ok ? 0 : 1;
  } else {
    process.exitCode = runCheckDirectRename(root);
  }
}
