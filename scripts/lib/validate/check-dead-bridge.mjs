#!/usr/bin/env node
// check-dead-bridge.mjs — Dead-bridge validator (dangling refs + bridge balance).
//
// Issue #671. Generalises the #618 baseline-fetch-bridge guard
// (check-baseline-fetch-bridge.mjs) into a corpus-driven dead-bridge detector:
// a "bridge" is a documented hand-off between two surfaces (a guard naming a
// file, a doc pointer to a script, a Phase reference to a skill, …). A bridge
// is DEAD when one end dangles — the referenced file/symbol no longer exists,
// or the two ends of a documented pair are unbalanced.
//
// This module is the CLI ORCHESTRATOR. It owns the real-fs IO (RepoContext),
// drives the FROZEN-contract detectors, prints PASS/FAIL lines, and sets the
// exit code. The detection logic and the corpus of known bridges live in the
// two sibling modules imported below.
//
// Usage: check-dead-bridge.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ...".
// Exit 0 = all bridges intact; 1 = at least one dead bridge; 2 = tool error
// (a detector reported a `*-tool-error` rule — e.g. an unreadable surface).
//
// Import-safety: importing `runCheckDeadBridge` MUST NOT trigger any execution
// or process.exit — the isMain guard at the bottom is the only side-effecting
// path. The Quality wave imports runCheckDeadBridge directly for unit tests.

import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { DETECTORS } from './dead-bridge-detectors.mjs';
import * as corpus from './dead-bridge-corpus.mjs';

const DEFAULT_EXTS = ['.mjs', '.md'];

/**
 * Recursively collect absolute paths under `absDir` whose extension is in
 * `exts`. Returns [] when `absDir` is missing or not a directory. Defensive:
 * an unreadable sub-directory is skipped rather than throwing, so a single bad
 * entry never aborts the whole walk (tool-error surfacing is the detectors'
 * job, via readText/exists on a specific surface).
 *
 * @param {string} absDir
 * @param {string[] | null} exts  null/undefined → match every file
 * @returns {string[]}
 */
function walk(absDir, exts) {
  /** @type {string[]} */
  const out = [];
  let entries;
  try {
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return out;
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(absDir, ent.name);
    let isDir;
    let isFile;
    try {
      // Dirent gives the type directly; fall back to statSync for symlinks etc.
      isDir = ent.isDirectory();
      isFile = ent.isFile();
      if (!isDir && !isFile && ent.isSymbolicLink()) {
        const st = statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      }
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...walk(full, exts));
    } else if (isFile) {
      if (!exts || exts.includes(path.extname(full))) out.push(full);
    }
  }
  return out;
}

/**
 * Build the RepoContext handed to every detector. All IO is real node:fs and
 * lives ONLY here — detectors are pure functions of (ctx, corpus).
 *
 * @param {string} pluginRoot
 * @returns {{
 *   pluginRoot: string,
 *   listMdFiles: (absDir: string) => string[],
 *   listFiles: (absDir: string, exts?: string[]) => string[],
 *   readText: (absPath: string) => string,
 *   exists: (absPath: string) => boolean,
 * }}
 */
export function buildRepoContext(pluginRoot) {
  return {
    pluginRoot,
    listMdFiles: (absDir) => walk(absDir, ['.md']),
    listFiles: (absDir, exts = DEFAULT_EXTS) => walk(absDir, exts),
    readText: (absPath) => readFileSync(absPath, 'utf8'),
    exists: (absPath) => existsSync(absPath),
  };
}

/**
 * Relativize an absolute path against the plugin root for human-readable
 * output. Falls back to the raw path when it lies outside the root.
 *
 * @param {string} root
 * @param {string} abs
 * @returns {string}
 */
function relativize(root, abs) {
  return path.relative(root, abs);
}

/**
 * Run the dead-bridge validator against a plugin root. Drives every frozen
 * detector, prints a PASS line per clean detector and a FAIL line per finding,
 * then a Results summary. Returns the process exit code.
 *
 * @param {string} pluginRoot
 * @returns {number} 0 = all bridges intact; 1 = dead bridge(s); 2 = tool error.
 */
export function runCheckDeadBridge(pluginRoot) {
  const ctx = buildRepoContext(pluginRoot);

  console.log('--- Check: dead-bridge validator (dangling refs + bridge balance) ---');

  // Run every detector, collecting findings tagged by their producing detector.
  /** @type {Array<{ rule: string, severity: string, file: string, line: number, message: string }>} */
  const findings = [];
  /** @type {Set<string>} */
  const detectorsWithFindings = new Set();
  /** @type {string[]} */
  const allDetectorIds = [];
  let toolError = false;

  for (const { id, fn } of DETECTORS) {
    allDetectorIds.push(id);
    const out = fn(ctx, corpus) || [];
    for (const f of out) {
      findings.push(f);
      detectorsWithFindings.add(id);
      if (typeof f.rule === 'string' && f.rule.endsWith('-tool-error')) toolError = true;
    }
  }

  // PASS line per detector that produced zero findings; FAIL line per finding.
  // Detectors are processed in DETECTORS order; PASS lines are emitted first so
  // the clean surfaces read before the failures (mirrors check-rules.mjs flow).
  for (const id of allDetectorIds) {
    if (!detectorsWithFindings.has(id)) {
      console.log(`  PASS: ${id} — no dead bridges detected`);
    }
  }

  for (const f of findings) {
    const loc = f.file ? `${relativize(pluginRoot, f.file)}:${f.line} — ` : '';
    console.log(`  FAIL: ${loc}${f.message}`);
  }

  const passed = allDetectorIds.length - detectorsWithFindings.size;
  const failed = findings.length;

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (toolError) return 2;
  return failed > 0 ? 1 : 0;
}

// CLI entry — only when executed directly, never on import (keeps the exports
// safe to import from tests without triggering process.exit).
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const pluginRoot = process.argv[2];
  if (!pluginRoot) {
    console.error('Usage: check-dead-bridge.mjs <plugin-root>');
    process.exit(2);
  }
  process.exit(runCheckDeadBridge(pluginRoot));
}
