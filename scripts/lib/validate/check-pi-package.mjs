#!/usr/bin/env node
// check-pi-package.mjs — Validate the Pi package manifest in package.json.
// Usage: check-pi-package.mjs <plugin-root>
// Exit 0 = all checks passed, 1 = at least one failure.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-pi-package.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function stripLeadingDotSlash(p) {
  return p.replace(/^\.\//, '');
}

function matchesSimpleGlob(relPath) {
  if (!relPath.includes('*')) {
    return existsSync(join(pluginRoot, stripLeadingDotSlash(relPath)));
  }

  const clean = stripLeadingDotSlash(relPath);
  const dir = dirname(clean);
  const base = clean.slice(dir.length + 1);
  const [prefix, suffix] = base.split('*');
  const absDir = join(pluginRoot, dir);
  if (!isDir(absDir)) return false;
  return readdirSync(absDir).some((entry) => entry.startsWith(prefix) && entry.endsWith(suffix));
}

function validatePathArray(pkg, field) {
  const values = pkg.pi?.[field];
  if (!Array.isArray(values) || values.length === 0) {
    fail(`pi.${field} must be a non-empty array`);
    return;
  }

  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0) {
      fail(`pi.${field} entry must be a non-empty string`);
      continue;
    }
    if (!value.startsWith('./')) {
      fail(`pi.${field} entry must be repo-relative and start with ./: ${value}`);
      continue;
    }
    if (matchesSimpleGlob(value)) {
      pass(`pi.${field} entry resolves: ${value}`);
    } else {
      fail(`pi.${field} entry does not resolve: ${value}`);
    }
  }
}

console.log('--- Check 1: package.json pi package manifest ---');

const packageJsonPath = join(pluginRoot, 'package.json');
let pkg;
try {
  pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
} catch (err) {
  fail(`package.json not found or invalid JSON: ${err.message}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

if (Array.isArray(pkg.keywords) && pkg.keywords.includes('pi-package')) {
  pass('package.json keywords include pi-package');
} else {
  fail('package.json keywords must include pi-package');
}

if (pkg.pi && typeof pkg.pi === 'object' && !Array.isArray(pkg.pi)) {
  pass('package.json pi manifest is present');
} else {
  fail('package.json pi manifest is missing');
}

validatePathArray(pkg, 'extensions');
validatePathArray(pkg, 'skills');
validatePathArray(pkg, 'prompts');

const extensionEntries = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions : [];
const tsExtension = extensionEntries.find((entry) => entry.endsWith('.ts'));
if (tsExtension && isFile(join(pluginRoot, stripLeadingDotSlash(tsExtension)))) {
  pass(`Pi extension TypeScript entry exists: ${tsExtension}`);
} else {
  fail('pi.extensions must include an existing .ts extension entry');
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
