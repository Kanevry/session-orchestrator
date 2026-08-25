#!/usr/bin/env node
// check-cursor-adapter.mjs — Ensure Cursor-native commands, skills, and hooks stay wired.
// Usage: check-cursor-adapter.mjs <plugin-root>
// Exit 0 = all checks passed, 1 = at least one failure.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CURSOR_TO_CANONICAL_EVENT } from '../cursor-hook-bridge.mjs';

const pluginRoot = process.argv[2];
if (!pluginRoot) {
  console.error('Usage: check-cursor-adapter.mjs <plugin-root>');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed += 1; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed += 1; }

console.log('--- Check 1: generated Cursor command and skill wrappers ---');

const generator = join(pluginRoot, 'scripts', 'generate-cursor-adapter.mjs');
if (!existsSync(generator)) {
  fail('scripts/generate-cursor-adapter.mjs exists');
} else {
  const result = spawnSync(process.execPath, [generator, '--check'], {
    cwd: pluginRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status === 0) {
    pass('.cursor/commands and .cursor/skills are up to date with commands/ and skills/');
  } else {
    const detail = ((result.stdout ?? '') + (result.stderr ?? '')).trim();
    fail(`Cursor adapter wrappers are stale${detail ? `: ${detail}` : ''}`);
  }
}

console.log('');
console.log('--- Check 2: .cursor/hooks.json native manifest ---');

const hooksPath = join(pluginRoot, '.cursor', 'hooks.json');
if (!existsSync(hooksPath)) {
  fail('.cursor/hooks.json exists');
} else {
  let hooksJson;
  try {
    hooksJson = JSON.parse(readFileSync(hooksPath, 'utf8'));
    pass('.cursor/hooks.json is valid JSON');
  } catch (err) {
    fail(`.cursor/hooks.json is not valid JSON: ${err.message}`);
    hooksJson = null;
  }

  if (hooksJson) {
    if (hooksJson.version === 1) {
      pass('.cursor/hooks.json version is 1');
    } else {
      fail('.cursor/hooks.json version must be 1');
    }

    const declared = Object.keys(hooksJson.hooks || {});
    const expected = Object.keys(CURSOR_TO_CANONICAL_EVENT);
    const missing = expected.filter((event) => !declared.includes(event));
    const extra = declared.filter((event) => !expected.includes(event));
    if (missing.length === 0 && extra.length === 0) {
      pass(`.cursor/hooks.json events match CURSOR_TO_CANONICAL_EVENT (${expected.length})`);
    } else {
      if (missing.length > 0) fail(`.cursor/hooks.json missing events: ${missing.join(', ')}`);
      if (extra.length > 0) fail(`.cursor/hooks.json extra events: ${extra.join(', ')}`);
    }

    const bridgeRef = 'scripts/lib/cursor-hook-bridge.mjs';
    const allPointAtBridge = declared.every((event) => {
      const entries = Array.isArray(hooksJson.hooks[event]) ? hooksJson.hooks[event] : [];
      return entries.some((entry) => typeof entry.command === 'string' && entry.command.includes(bridgeRef) && entry.command.includes(`--event ${event}`));
    });
    if (allPointAtBridge) {
      pass('.cursor/hooks.json commands invoke cursor-hook-bridge.mjs with --event');
    } else {
      fail('.cursor/hooks.json commands must invoke scripts/lib/cursor-hook-bridge.mjs --event <name>');
    }
  }
}

console.log('');
console.log('--- Check 3: Cursor hook bridge module ---');

const bridgePath = join(pluginRoot, 'scripts', 'lib', 'cursor-hook-bridge.mjs');
if (existsSync(bridgePath)) {
  pass('scripts/lib/cursor-hook-bridge.mjs exists');
} else {
  fail('scripts/lib/cursor-hook-bridge.mjs exists');
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
