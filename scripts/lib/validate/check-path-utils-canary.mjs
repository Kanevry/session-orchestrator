#!/usr/bin/env node
/**
 * check-path-utils-canary.mjs — Assert that validatePathInsideProject is exported
 * from path-utils.mjs and is imported at all three canonical callsites.
 *
 * Rationale: validatePathInsideProject is the canonical two-phase path-traversal +
 * symlink-escape guard (Phase 1 lexical isPathInside, Phase 2 realpathSync-when-exists).
 * It was extracted in #402 from three inline guard sites to prevent duplication drift.
 * Without this canary, a refactor that removes the import at any callsite silently
 * reverts to no guard (or re-introduces an inline one), which is a CWE-23 regression
 * the test suite will not catch directly.
 *
 * Regression class this prevents (not covered by existing 39 canaries):
 *   - Removal of `validatePathInsideProject` import from config/test.mjs,
 *     profiles/schema.mjs, or playwright-driver/runner.mjs without a test failing.
 *   - Removal of the export from path-utils.mjs while callsites still compile
 *     (the call would simply return undefined and silently skip validation).
 *
 * Checks:
 *   1. path-utils.mjs exports validatePathInsideProject (export keyword present)
 *   2. scripts/lib/config/test.mjs imports validatePathInsideProject from path-utils
 *   3. scripts/lib/profiles/schema.mjs imports validatePathInsideProject from path-utils
 *   4. scripts/lib/playwright-driver/runner.mjs imports validatePathInsideProject from path-utils
 *
 * MAINTAINER NOTE: This canary locks in WHICH production modules use the helper.
 * If a callsite is intentionally removed (e.g. module deprecation), DELETE the matching
 * Check N block from this file — this is not a "fix the canary to be passing" situation.
 * Conversely, when a NEW callsite is added, append a corresponding Check N+1 block.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one check failed
 *
 * Usage:
 *   node scripts/lib/validate/check-path-utils-canary.mjs <plugin-root>
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-path-utils-canary.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

function readFile(relPath) {
  const abs = join(pluginRoot, relPath);
  if (!existsSync(abs)) return null;
  return readFileSync(abs, 'utf8');
}

// ---------------------------------------------------------------------------
// Check 1: path-utils.mjs exports validatePathInsideProject
// ---------------------------------------------------------------------------

console.log('--- Check 1: path-utils.mjs exports validatePathInsideProject ---');

const pathUtils = readFile('scripts/lib/path-utils.mjs');
if (pathUtils === null) {
  fail('scripts/lib/path-utils.mjs does not exist');
} else if (/export function validatePathInsideProject/.test(pathUtils)) {
  pass('path-utils.mjs exports validatePathInsideProject');
} else {
  fail('path-utils.mjs does not export validatePathInsideProject — two-phase guard helper is missing');
}

// ---------------------------------------------------------------------------
// Check 2: config/test.mjs imports validatePathInsideProject
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 2: scripts/lib/config/test.mjs imports validatePathInsideProject ---');

const configTest = readFile('scripts/lib/config/test.mjs');
if (configTest === null) {
  fail('scripts/lib/config/test.mjs does not exist');
} else if (/import\s*\{[^}]*validatePathInsideProject[^}]*\}\s*from\s*['"][^'"]*path-utils/.test(configTest)) {
  pass('config/test.mjs imports validatePathInsideProject from path-utils');
} else {
  fail('config/test.mjs does not import validatePathInsideProject from path-utils — SEC-IR-LOW-2 profiles-path guard may be missing');
}

// ---------------------------------------------------------------------------
// Check 3: profiles/schema.mjs imports validatePathInsideProject
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 3: scripts/lib/profiles/schema.mjs imports validatePathInsideProject ---');

const profilesSchema = readFile('scripts/lib/profiles/schema.mjs');
if (profilesSchema === null) {
  fail('scripts/lib/profiles/schema.mjs does not exist');
} else if (/import\s*\{[^}]*validatePathInsideProject[^}]*\}\s*from\s*['"][^'"]*path-utils/.test(profilesSchema)) {
  pass('profiles/schema.mjs imports validatePathInsideProject from path-utils');
} else {
  fail('profiles/schema.mjs does not import validatePathInsideProject from path-utils — SEC-IR-LOW-3 rubric path guard may be missing');
}

// ---------------------------------------------------------------------------
// Check 4: playwright-driver/runner.mjs imports validatePathInsideProject
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 4: scripts/lib/playwright-driver/runner.mjs imports validatePathInsideProject ---');

const runnerMjs = readFile('scripts/lib/playwright-driver/runner.mjs');
if (runnerMjs === null) {
  fail('scripts/lib/playwright-driver/runner.mjs does not exist');
} else if (/import\s*\{[^}]*validatePathInsideProject[^}]*\}\s*from\s*['"][^'"]*path-utils/.test(runnerMjs)) {
  pass('playwright-driver/runner.mjs imports validatePathInsideProject from path-utils');
} else {
  fail('playwright-driver/runner.mjs does not import validatePathInsideProject from path-utils — #398 runDir traversal guard may be missing');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
