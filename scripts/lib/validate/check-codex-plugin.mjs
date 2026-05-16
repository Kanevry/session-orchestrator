#!/usr/bin/env node
/**
 * check-codex-plugin.mjs — Validate .codex-plugin/plugin.json interface.composerIcon field.
 *
 * Checks:
 *   1. .codex-plugin/plugin.json is readable and valid JSON
 *   2. interface.composerIcon field is present (non-empty string)
 *   3. The path it references (resolved repo-root-relative) exists on filesystem
 *   4. The referenced file starts with "<?xml" or "<svg" (valid XML/SVG root indicator)
 *
 * Path resolution note:
 *   composerIcon value "./assets/icon.svg" is repo-root-relative, NOT relative to
 *   .codex-plugin/. Strip the leading "./" and resolve from pluginRoot.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — at least one check failed
 *
 * Usage:
 *   node scripts/lib/validate/check-codex-plugin.mjs <plugin-root>
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-codex-plugin.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

// ---------------------------------------------------------------------------
// Check 1: .codex-plugin/plugin.json is readable and valid JSON
// ---------------------------------------------------------------------------

console.log('--- Check 1: .codex-plugin/plugin.json composerIcon field ---');

const CODEX_PLUGIN_JSON = join(pluginRoot, '.codex-plugin', 'plugin.json');

let json;
try {
  json = JSON.parse(readFileSync(CODEX_PLUGIN_JSON, 'utf8'));
} catch (err) {
  fail(`cannot read .codex-plugin/plugin.json: ${err.message}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Check 2: interface.composerIcon field is present (non-empty string)
// ---------------------------------------------------------------------------

const iconPath = json?.interface?.composerIcon;
if (typeof iconPath !== 'string' || iconPath.length === 0) {
  fail('interface.composerIcon field not set in .codex-plugin/plugin.json');
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
pass(`interface.composerIcon field is present: ${iconPath}`);

// ---------------------------------------------------------------------------
// Check 3: The referenced file exists (resolved repo-root-relative)
// ---------------------------------------------------------------------------

// composerIcon is repo-root-relative (e.g. "./assets/icon.svg").
// Strip leading "./" so resolve(pluginRoot, "assets/icon.svg") works correctly.
const repoRelative = iconPath.replace(/^\.\//, '');
const resolvedAbs = isAbsolute(iconPath) ? iconPath : resolve(pluginRoot, repoRelative);

if (!existsSync(resolvedAbs)) {
  fail(`composerIcon path '${iconPath}' resolved to '${resolvedAbs}' does not exist`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
pass(`composerIcon file exists at: ${resolvedAbs}`);

// ---------------------------------------------------------------------------
// Check 4: File starts with <?xml or <svg (valid XML/SVG root indicator)
// ---------------------------------------------------------------------------

let content;
try {
  content = readFileSync(resolvedAbs, 'utf8');
} catch (err) {
  fail(`cannot read composerIcon file '${iconPath}': ${err.message}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const trimmed = content.trimStart();
if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<svg')) {
  fail(`composerIcon file '${iconPath}' does not start with <?xml or <svg root`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
pass(`composerIcon file is valid XML/SVG (starts with ${trimmed.startsWith('<?xml') ? '<?xml' : '<svg'})`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
