#!/usr/bin/env node
// check-plugin-json.mjs — Validate plugin.json existence, JSON validity, name, and version fields.
// Usage: check-plugin-json.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..."
// Exit 0 = all checks passed; exit 1 = at least one failure.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-plugin-json.mjs <plugin-root>');
  process.exit(1);
}

const PLUGIN_JSON = join(pluginRoot, '.claude-plugin', 'plugin.json');

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

// ============================================================================
// Check 1: plugin.json exists and is valid JSON
// ============================================================================
console.log('--- Check 1: plugin.json exists and is valid JSON ---');

if (!existsSync(PLUGIN_JSON)) {
  fail(`plugin.json not found at ${PLUGIN_JSON}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
pass('plugin.json exists');

let data;
let content;
try {
  content = readFileSync(PLUGIN_JSON, 'utf8');
  data = JSON.parse(content);
} catch {
  fail('plugin.json is not valid JSON');
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
pass('plugin.json is valid JSON');

// ============================================================================
// Check 2: Required field 'name' is present and kebab-case
// ============================================================================
console.log('');
console.log('--- Check 2: name field ---');

const name = data.name || '';
if (!name) {
  fail("required field 'name' is missing");
} else {
  pass(`name field is present: ${name}`);
  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    pass('name is valid kebab-case');
  } else {
    fail(`name is not kebab-case: ${name} (expected pattern: ^[a-z][a-z0-9]*(-[a-z0-9]+)*$)`);
  }
}

// ============================================================================
// Check 3: version matches semver (if present)
// ============================================================================
console.log('');
console.log('--- Check 3: version field ---');

const version = data.version || '';
if (!version) {
  pass('version field not present (optional, skipped)');
} else {
  if (/^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(version)) {
    pass(`version matches semver: ${version}`);
  } else {
    fail(`version does not match semver: ${version}`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
