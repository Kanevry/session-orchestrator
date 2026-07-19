#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateCodexPluginContract } from '../codex/plugin-contract.mjs';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-codex-plugin.mjs <plugin-root>');
  process.exit(1);
}

console.log('--- Check: canonical Codex plugin contract ---');

let expectedBaseVersion;
try {
  const packageJson = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8'));
  expectedBaseVersion = packageJson.version;
} catch (error) {
  console.log(`  FAIL: cannot read package.json version: ${error.message}`);
  console.log('');
  console.log('Results: 0 passed, 1 failed');
  process.exit(1);
}

const verdict = validateCodexPluginContract({ pluginRoot, expectedBaseVersion });
if (verdict.ok) {
  console.log('  PASS: .codex-plugin/plugin.json and hooks/hooks-codex.json satisfy the Codex contract');
} else {
  for (const error of verdict.errors) {
    console.log(`  FAIL: [${error.rule}] ${error.path}: ${error.message}`);
  }
}

console.log('');
console.log(`Results: ${verdict.ok ? 1 : 0} passed, ${verdict.errors.length} failed`);
process.exit(verdict.ok ? 0 : 1);
