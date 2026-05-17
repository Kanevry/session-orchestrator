#!/usr/bin/env node
/**
 * check-plugin-schema.mjs — Verify $schema declarations in .claude-plugin manifests.
 *
 * Checks (offline-friendly — no network fetch required):
 *   1. .claude-plugin/plugin.json has $schema set to the expected schemastore.org URL
 *   2. .claude-plugin/marketplace.json has $schema set to the expected schemastore.org URL
 *   3. Both files have their required fields per schema:
 *        plugin.json   → name
 *        marketplace.json → name, owner, plugins
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Usage:
 *   node scripts/lib/validate/check-plugin-schema.mjs <plugin-root>
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-plugin-schema.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

/** Read and parse a JSON file; returns null on missing or parse error. */
function readJson(absPath) {
  if (!existsSync(absPath)) return null;
  try {
    return JSON.parse(readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Expected schema URLs
// ---------------------------------------------------------------------------

const PLUGIN_SCHEMA_URL = 'https://json.schemastore.org/claude-code-plugin-manifest.json';
const MARKETPLACE_SCHEMA_URL = 'https://json.schemastore.org/claude-code-marketplace.json';

// ---------------------------------------------------------------------------
// Check 1: .claude-plugin/plugin.json $schema declaration
// ---------------------------------------------------------------------------

console.log('--- Check 1: .claude-plugin/plugin.json $schema declaration ---');

const pluginJsonPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
const pluginJson = readJson(pluginJsonPath);

if (!pluginJson) {
  fail('.claude-plugin/plugin.json is missing or not valid JSON');
} else if (typeof pluginJson['$schema'] !== 'string') {
  fail('.claude-plugin/plugin.json is missing $schema key');
} else if (pluginJson['$schema'] !== PLUGIN_SCHEMA_URL) {
  fail(
    `.claude-plugin/plugin.json $schema is "${pluginJson['$schema']}" — ` +
    `expected "${PLUGIN_SCHEMA_URL}"`,
  );
} else {
  pass(`.claude-plugin/plugin.json $schema = "${PLUGIN_SCHEMA_URL}"`);
}

// ---------------------------------------------------------------------------
// Check 2: .claude-plugin/marketplace.json $schema declaration
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 2: .claude-plugin/marketplace.json $schema declaration ---');

const marketplaceJsonPath = join(pluginRoot, '.claude-plugin', 'marketplace.json');
const marketplaceJson = readJson(marketplaceJsonPath);

if (!marketplaceJson) {
  fail('.claude-plugin/marketplace.json is missing or not valid JSON');
} else if (typeof marketplaceJson['$schema'] !== 'string') {
  fail('.claude-plugin/marketplace.json is missing $schema key');
} else if (marketplaceJson['$schema'] !== MARKETPLACE_SCHEMA_URL) {
  fail(
    `.claude-plugin/marketplace.json $schema is "${marketplaceJson['$schema']}" — ` +
    `expected "${MARKETPLACE_SCHEMA_URL}"`,
  );
} else {
  pass(`.claude-plugin/marketplace.json $schema = "${MARKETPLACE_SCHEMA_URL}"`);
}

// ---------------------------------------------------------------------------
// Check 3: Required fields per schema
//   plugin.json   → name
//   marketplace.json → name, owner, plugins
// ---------------------------------------------------------------------------

console.log('');
console.log('--- Check 3: Required fields per schema ---');

let _requiredFieldsFailed = 0;

// plugin.json: name (only required field per schemastore spec)
if (pluginJson) {
  if (typeof pluginJson.name === 'string' && pluginJson.name.length > 0) {
    pass('.claude-plugin/plugin.json has required field "name"');
  } else {
    fail('.claude-plugin/plugin.json missing required field "name"');
    _requiredFieldsFailed += 1;
  }
}

// marketplace.json: name, owner, plugins
if (marketplaceJson) {
  const marketplaceRequired = ['name', 'owner', 'plugins'];
  for (const field of marketplaceRequired) {
    if (Object.prototype.hasOwnProperty.call(marketplaceJson, field) && marketplaceJson[field] !== undefined) {
      pass(`.claude-plugin/marketplace.json has required field "${field}"`);
    } else {
      fail(`.claude-plugin/marketplace.json missing required field "${field}"`);
      _requiredFieldsFailed += 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
