#!/usr/bin/env node
// check-pi-prompts.mjs — Ensure generated Pi prompt wrappers match commands/*.md.
// Usage: check-pi-prompts.mjs <plugin-root>
// Exit 0 = all checks passed, 1 = at least one failure.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-pi-prompts.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

console.log('--- Check 1: generated Pi prompt wrappers ---');

const generator = join(pluginRoot, 'scripts', 'generate-pi-prompts.mjs');
if (!existsSync(generator)) {
  fail('scripts/generate-pi-prompts.mjs exists');
} else {
  const result = spawnSync(process.execPath, [generator, '--check'], {
    cwd: pluginRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) {
    pass('pi/prompts/*.md are up to date with commands/*.md');
  } else {
    const detail = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
    fail(`pi prompt wrappers are stale${detail ? `: ${detail}` : ''}`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
