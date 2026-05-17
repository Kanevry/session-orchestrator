#!/usr/bin/env node
/**
 * check-plugin-monitors.mjs — Validate plugin monitor registration (#427).
 *
 * Checks:
 *   1. .claude-plugin/plugin.json is readable and valid JSON
 *   2. experimental.monitors field is present and a string path
 *   3. The referenced monitors-file path (resolved repo-root-relative) exists
 *      on filesystem
 *   4. The referenced file is valid JSON
 *   5. The parsed JSON is an array with length >= 2
 *   6. Each entry has required fields (name, command, description)
 *   7. Each name is unique within the array
 *   8. Array contains an entry named "ecosystem-health"
 *   9. Array contains an entry named "convergence-monitor"
 *  10. The 2 referenced watcher scripts exist on filesystem
 *
 * Path resolution note:
 *   experimental.monitors value "./monitors/monitors.json" is repo-root-relative
 *   (NOT relative to .claude-plugin/). Strip the leading "./" and resolve from
 *   pluginRoot. Mirrors check-codex-plugin.mjs convention.
 *
 * Schema reference:
 *   https://json.schemastore.org/claude-code-plugin-manifest.json (lines
 *   1606-1645). Per D1 verification: monitors entries have name, command,
 *   description, and optional when (default "always"). There is NO
 *   interval_seconds field — monitors are persistent background processes
 *   and the script controls cadence internally.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one check failed
 *
 * Usage:
 *   node scripts/lib/validate/check-plugin-monitors.mjs <plugin-root>
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-plugin-monitors.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

const REQUIRED_MONITOR_NAMES = ['ecosystem-health', 'convergence-monitor'];
const REQUIRED_FIELDS = ['name', 'command', 'description'];
const REQUIRED_SCRIPTS = [
  'scripts/lib/ecosystem-health.mjs',
  'scripts/lib/convergence-monitor.mjs',
];

// ---------------------------------------------------------------------------
// Check 1: .claude-plugin/plugin.json is readable and valid JSON
// ---------------------------------------------------------------------------

console.log('--- Check 1: .claude-plugin/plugin.json experimental.monitors ---');

const PLUGIN_JSON = join(pluginRoot, '.claude-plugin', 'plugin.json');

let pluginJson;
try {
  pluginJson = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
  pass('.claude-plugin/plugin.json is readable and valid JSON');
} catch (err) {
  fail(`cannot read .claude-plugin/plugin.json: ${err.message}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 2: experimental.monitors is a non-empty string path
// ---------------------------------------------------------------------------

const monitorsPath = pluginJson?.experimental?.monitors;
if (typeof monitorsPath === 'string' && monitorsPath.length > 0) {
  pass(`experimental.monitors is a string path: "${monitorsPath}"`);
} else {
  fail(
    `experimental.monitors must be a non-empty string path; ` +
    `got ${typeof monitorsPath} (${JSON.stringify(monitorsPath)})`,
  );
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 3: referenced monitors file exists on disk
// ---------------------------------------------------------------------------

// Strip leading "./" before resolving from pluginRoot — mirrors composerIcon convention.
const monitorsRel = monitorsPath.replace(/^\.\//, '');
const monitorsAbs = join(pluginRoot, monitorsRel);

if (existsSync(monitorsAbs)) {
  pass(`monitors file exists at ${monitorsRel}`);
} else {
  fail(`monitors file not found at ${monitorsRel} (resolved: ${monitorsAbs})`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 4: referenced monitors file is valid JSON
// ---------------------------------------------------------------------------

let monitors;
try {
  monitors = JSON.parse(readFileSync(monitorsAbs, 'utf8'));
  pass(`${monitorsRel} is valid JSON`);
} catch (err) {
  fail(`${monitorsRel} is not valid JSON: ${err.message}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 5: monitors is an array of length >= 2
// ---------------------------------------------------------------------------

if (Array.isArray(monitors) && monitors.length >= 2) {
  pass(`${monitorsRel} is an array with length ${monitors.length} (>= 2)`);
} else {
  fail(
    `${monitorsRel} must be an array with length >= 2; ` +
    `got ${Array.isArray(monitors) ? `array length ${monitors.length}` : typeof monitors}`,
  );
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 6: each entry has required fields (name, command, description)
// ---------------------------------------------------------------------------

let allEntriesValid = true;
for (let i = 0; i < monitors.length; i += 1) {
  const entry = monitors[i];
  if (!entry || typeof entry !== 'object') {
    fail(`monitors[${i}] is not an object`);
    allEntriesValid = false;
    continue;
  }
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry[field] !== 'string' || entry[field].length === 0) {
      fail(`monitors[${i}] missing required field "${field}" (or not a non-empty string)`);
      allEntriesValid = false;
    }
  }
}
if (allEntriesValid) {
  pass(`all ${monitors.length} entries have required fields (name, command, description)`);
}

// ---------------------------------------------------------------------------
// Check 7: each name is unique within the array
// ---------------------------------------------------------------------------

const names = monitors.map((m) => m?.name).filter((n) => typeof n === 'string');
const dups = names.filter((n, idx) => names.indexOf(n) !== idx);
if (dups.length === 0) {
  pass(`all ${names.length} monitor names are unique`);
} else {
  fail(`duplicate monitor names: ${[...new Set(dups)].join(', ')}`);
}

// ---------------------------------------------------------------------------
// Checks 8-9: required monitor names present
// ---------------------------------------------------------------------------

for (const required of REQUIRED_MONITOR_NAMES) {
  if (names.includes(required)) {
    pass(`monitors array contains required entry "${required}"`);
  } else {
    fail(`monitors array is missing required entry "${required}"`);
  }
}

// ---------------------------------------------------------------------------
// Check 10: referenced watcher scripts exist on disk
// ---------------------------------------------------------------------------

for (const scriptRel of REQUIRED_SCRIPTS) {
  const abs = join(pluginRoot, scriptRel);
  if (existsSync(abs)) {
    pass(`watcher script exists: ${scriptRel}`);
  } else {
    fail(`watcher script missing: ${scriptRel} (resolved: ${abs})`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
