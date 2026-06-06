#!/usr/bin/env node
// check-baseline-fetch-bridge.mjs — Guard the bootstrap on-demand baseline-fetch
// bridge against the renamed-dependency dead-bridge regression class (#618).
//
// Rationale (#618): the bootstrap on-demand baseline-fetch step (S99/D99) was
// gated on a `-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.sh"` guard — but the
// plugin only ever shipped `fetch-baseline.mjs` (the `.sh` was renamed away).
// The guard therefore evaluated false on every bootstrap → the bridge was dead
// code that silently never fetched. Wave 2 flipped every bootstrap guard/ref to
// `.mjs` and removed the dead `source`/shell-function calls. This validator
// pins that fix mechanically so a future rename (or a stray `.sh` reference)
// fails plugin validation instead of re-introducing a silent dead bridge.
//
// What it checks across the bootstrap files:
//   1. Every `-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.<ext>"` guard names a
//      file that actually EXISTS in the plugin. A guard pointing at a
//      non-existent file is the exact #618 failure (always-false guard).
//   2. No bootstrap file references the stale `fetch-baseline.sh` basename.
//   3. No bootstrap file references the dead shell-function names
//      `fetch_baseline_file`, `fetch_baseline_files_batch`,
//      `write_baseline_fetch_lock` (the removed shell-source bridge).
//
// Usage: check-baseline-fetch-bridge.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ...".
// Exit 0 = bridge intact; 1 = dead/renamed bridge detected; 2 = tool error
// (bootstrap directory unreadable).
//
// Inline-ignore: a source line containing the marker
// `check-baseline-fetch-bridge:ignore` is skipped, so prose may document a
// historical dead reference (e.g. in a migration note) without failing the gate
// (mirrors the repo's `check-rules-references:ignore` / `consistency:exempt:`
// conventions).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const IGNORE_MARKER = 'check-baseline-fetch-bridge:ignore';

// The bootstrap files that participate in the baseline-fetch bridge.
const BOOTSTRAP_FILES = [
  '_shared-template.md',
  'SKILL.md',
  'standard-template.md',
  'deep-template.md',
];

// The renamed/stale basename that must never reappear in a bootstrap file.
const STALE_BASENAME = 'fetch-baseline.sh';

// The removed shell-source bridge function names.
const DEAD_FUNCTIONS = [
  'fetch_baseline_file',
  'fetch_baseline_files_batch',
  'write_baseline_fetch_lock',
];

// A `-f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.<ext>"` guard reference. The
// capture group is the guarded path relative to the plugin root.
const GUARD_RE = /-f\s+["']?\$(?:\{)?PLUGIN_ROOT(?:\})?\/(scripts\/lib\/fetch-baseline\.[a-z]+)["']?/g;

/**
 * Scan the bootstrap files for guarded fetch-baseline paths, stale `.sh`
 * references, and dead shell-function references. Pure + import-safe: returns
 * the collected occurrences so tests can assert against them directly.
 *
 * @param {string} bootstrapDir absolute path to `skills/bootstrap/`
 * @returns {{
 *   guards: Array<{guardedPath: string, file: string, line: number}>,
 *   staleRefs: Array<{file: string, line: number}>,
 *   deadFnRefs: Array<{fn: string, file: string, line: number}>,
 *   missingFiles: string[],
 * }}
 */
export function collectBaselineBridgeRefs(bootstrapDir) {
  /** @type {Array<{guardedPath: string, file: string, line: number}>} */
  const guards = [];
  /** @type {Array<{file: string, line: number}>} */
  const staleRefs = [];
  /** @type {Array<{fn: string, file: string, line: number}>} */
  const deadFnRefs = [];

  /** @type {string[]} */
  const missingFiles = [];
  for (const name of BOOTSTRAP_FILES) {
    const full = join(bootstrapDir, name);
    if (!existsSync(full)) {
      missingFiles.push(name);
      continue;
    }
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((text, idx) => {
      if (text.includes(IGNORE_MARKER)) return;
      const lineNo = idx + 1;

      GUARD_RE.lastIndex = 0;
      let m;
      while ((m = GUARD_RE.exec(text)) !== null) {
        guards.push({ guardedPath: m[1], file: full, line: lineNo });
      }

      if (text.includes(STALE_BASENAME)) {
        staleRefs.push({ file: full, line: lineNo });
      }

      for (const fn of DEAD_FUNCTIONS) {
        if (text.includes(fn)) {
          deadFnRefs.push({ fn, file: full, line: lineNo });
        }
      }
    });
  }

  return { guards, staleRefs, deadFnRefs, missingFiles };
}

/**
 * Run the validator against a plugin root. Prints PASS/FAIL lines and a Results
 * summary; returns the process exit code (0 = bridge intact, 1 = dead/renamed
 * bridge detected, 2 = tool error / bootstrap dir unreadable).
 *
 * @param {string} pluginRoot
 * @returns {number}
 */
export function runCheckBaselineFetchBridge(pluginRoot) {
  const bootstrapDir = join(pluginRoot, 'skills', 'bootstrap');

  console.log('--- Check: bootstrap baseline-fetch bridge (.mjs, no dead .sh refs) ---');

  // Tool-error gate: bootstrap dir must exist and be a readable directory.
  try {
    if (!existsSync(bootstrapDir) || !statSync(bootstrapDir).isDirectory()) {
      console.error(`  tool-error: bootstrap directory not found: ${bootstrapDir}`);
      return 2;
    }
  } catch (/** @type {unknown} */ e) {
    console.error(`  tool-error: cannot read bootstrap directory: ${(/** @type {Error} */ (e)).message}`);
    return 2;
  }

  const { guards, staleRefs, deadFnRefs, missingFiles } =
    collectBaselineBridgeRefs(bootstrapDir);

  let passed = 0;
  let failed = 0;
  const pass = (msg) => { console.log(`  PASS: ${msg}`); passed++; };
  const fail = (msg) => { console.log(`  FAIL: ${msg}`); failed++; };

  const relativize = (f) =>
    f.startsWith(pluginRoot) ? f.slice(pluginRoot.length).replace(/^\//, '') : f;

  // Check 1 — every guarded fetch-baseline path resolves to an existing file.
  if (guards.length === 0) {
    fail('no fetch-baseline guard reference found in bootstrap (expected the on-demand baseline-fetch bridge guard)');
  } else {
    for (const g of guards) {
      const target = join(pluginRoot, g.guardedPath);
      if (existsSync(target)) {
        pass(`guard "${g.guardedPath}" resolves to an existing file (${relativize(g.file)}:${g.line})`);
      } else {
        fail(`guard "${g.guardedPath}" points at a non-existent file — dead always-false bridge (#618 regression) at ${relativize(g.file)}:${g.line}`);
      }
    }
  }

  // Check 2 — no stale `fetch-baseline.sh` reference.
  if (staleRefs.length === 0) {
    pass(`no stale "${STALE_BASENAME}" reference in bootstrap files`);
  } else {
    for (const r of staleRefs) {
      fail(`stale "${STALE_BASENAME}" reference (the plugin ships .mjs only) at ${relativize(r.file)}:${r.line}`);
    }
  }

  // Check 3 — no dead shell-function references.
  if (deadFnRefs.length === 0) {
    pass(`no dead shell-function references (${DEAD_FUNCTIONS.join(', ')}) in bootstrap files`);
  } else {
    for (const r of deadFnRefs) {
      fail(`dead shell-function reference "${r.fn}" (removed shell-source bridge) at ${relativize(r.file)}:${r.line}`);
    }
  }

  // Surface (but do not fail on) any bootstrap file that is simply absent — the
  // file set is the authoritative bridge surface; a missing file just narrows
  // the scan. Absence is informational, not a bridge regression.
  if (missingFiles.length > 0) {
    pass(`bootstrap files scanned (skipped absent: ${missingFiles.join(', ')})`);
  }

  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

// CLI entry — only when executed directly, never on import (keeps the exports
// safe to import from tests without triggering process.exit).
const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const [, , pluginRoot] = process.argv;
  if (!pluginRoot) {
    console.error('Usage: check-baseline-fetch-bridge.mjs <plugin-root>');
    process.exit(2);
  }
  process.exit(runCheckBaselineFetchBridge(pluginRoot));
}
