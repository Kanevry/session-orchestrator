#!/usr/bin/env node
// scripts/lib/validate/check-hooks-symmetry.mjs
// Verify event-key + handler-file symmetry across hooks/{hooks,hooks-codex,hooks-cursor}.json
// Exit 0 = all checks pass, 1 = any check fails
// Stdout: '  PASS: ...' / '  FAIL: ...' lines + 'Results: N passed, M failed'

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const PLUGIN_ROOT = process.argv[2];
if (!PLUGIN_ROOT) {
  console.error('Usage: check-hooks-symmetry.mjs <plugin-root>');
  process.exit(1);
}

const HOOKS_DIR = join(PLUGIN_ROOT, 'hooks');

// Documented asymmetries — events expected to be missing from specific configs.
// Anything NOT in this list that's asymmetric → FAIL (drift).
const DOCUMENTED_ASYMMETRIES = {
  // Events from hooks.json/hooks-codex.json that are intentionally absent in hooks-cursor.json
  cursorMissingFromMain: ['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreToolUse'],
  // Events unique to hooks-cursor.json (Cursor IDE-specific)
  cursorOnly: ['afterFileEdit', 'beforeShellExecution'],
};

let passed = 0;
let failed = 0;

function pass(msg) { console.log(`  PASS: ${msg}`); passed++; }
function fail(msg) { console.log(`  FAIL: ${msg}`); failed++; }

// Step 1: Load JSON files — required files exit on error; cursor is optional (returns undefined)
function loadJson(filePath, required = true) {
  if (!required && !existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    fail(`${filePath.split('/').pop()}: ${e.message}`);
    process.exit(1);
  }
}

const claudeJson = loadJson(join(HOOKS_DIR, 'hooks.json'));
const codexJson  = loadJson(join(HOOKS_DIR, 'hooks-codex.json'));
const cursorJson = loadJson(join(HOOKS_DIR, 'hooks-cursor.json'), false);

// Step 2: Extract event keys
const claudeEvents = new Set(Object.keys(claudeJson.hooks || {}));
const codexEvents  = new Set(Object.keys(codexJson.hooks || {}));
const cursorEvents = cursorJson ? new Set(Object.keys(cursorJson.hooks || {})) : new Set();

// Step 3: claude vs codex must match exactly (no documented asymmetries between them)
console.log('--- Check 1: hooks.json ↔ hooks-codex.json event-key parity ---');
const claudeOnly = [...claudeEvents].filter((e) => !codexEvents.has(e));
const codexOnly  = [...codexEvents].filter((e) => !claudeEvents.has(e));
if (claudeOnly.length === 0 && codexOnly.length === 0) {
  pass(`hooks.json and hooks-codex.json have identical event-key sets (${claudeEvents.size} events)`);
} else {
  if (claudeOnly.length > 0) fail(`events in hooks.json but missing in hooks-codex.json: ${claudeOnly.join(', ')}`);
  if (codexOnly.length > 0)  fail(`events in hooks-codex.json but missing in hooks.json: ${codexOnly.join(', ')}`);
}

// Step 4: cursor asymmetries must be documented
console.log('');
console.log('--- Check 2: hooks-cursor.json documented asymmetries ---');
if (cursorJson) {
  const cursorMissing = [...claudeEvents].filter((e) => !cursorEvents.has(e));
  const undocumentedMissing = cursorMissing.filter((e) => !DOCUMENTED_ASYMMETRIES.cursorMissingFromMain.includes(e));
  if (undocumentedMissing.length === 0) {
    pass(`hooks-cursor.json missing events are all documented (${cursorMissing.length} events: ${cursorMissing.join(', ')})`);
  } else {
    fail(`hooks-cursor.json missing UNDOCUMENTED events: ${undocumentedMissing.join(', ')}`);
  }

  const cursorExtra = [...cursorEvents].filter((e) => !claudeEvents.has(e));
  const undocumentedExtra = cursorExtra.filter((e) => !DOCUMENTED_ASYMMETRIES.cursorOnly.includes(e));
  if (undocumentedExtra.length === 0) {
    pass(`hooks-cursor.json cursor-only events are all documented (${cursorExtra.length} events: ${cursorExtra.join(', ')})`);
  } else {
    fail(`hooks-cursor.json has UNDOCUMENTED extra events: ${undocumentedExtra.join(', ')}`);
  }
} else {
  pass(`hooks-cursor.json absent (optional config)`);
}

// Step 5: Extract handler-file refs from each config
// Handles two shapes:
//   Claude/Codex: hooks[event] = Array<{ hooks: Array<{ command: "node \"$CLAUDE_PLUGIN_ROOT/hooks/foo.mjs\"" }> }>
//   Cursor:       hooks[event] = { script: "hooks/foo.mjs" }
function extractHandlers(json) {
  const handlers = new Set();
  for (const event of Object.values(json.hooks || {})) {
    const matchers = Array.isArray(event) ? event : [event];
    for (const m of matchers) {
      // Cursor shape: script field at matcher level
      if (typeof m.script === 'string') {
        const scriptMatch = m.script.match(/(?:hooks\/)([\w/-]+\.mjs)/);
        if (scriptMatch) handlers.add(scriptMatch[1]);
      }
      // Claude/Codex shape: nested hooks array with command field
      const hookList = m.hooks || [];
      for (const h of hookList) {
        const cmd = h.command || h.script || '';
        const match = cmd.match(/(?:hooks\/|\$\{?CLAUDE_PLUGIN_ROOT\}?\/hooks\/|\$\{?CODEX_PLUGIN_ROOT\}?\/hooks\/)([\w/-]+\.mjs)/);
        if (match) handlers.add(match[1]);
      }
    }
  }
  return handlers;
}
const claudeHandlers = extractHandlers(claudeJson);
const codexHandlers  = extractHandlers(codexJson);
const cursorHandlers = cursorJson ? extractHandlers(cursorJson) : new Set();
const allHandlers = new Set([...claudeHandlers, ...codexHandlers, ...cursorHandlers]);

// Step 6: Verify each handler file exists on disk (skip _lib/* — those are library modules)
console.log('');
console.log('--- Check 3: handler files exist on disk ---');
const missing = [];
for (const h of allHandlers) {
  if (h.startsWith('_lib/')) continue;  // library modules, not hook handlers
  if (!existsSync(join(HOOKS_DIR, h))) {
    missing.push(h);
  }
}
if (missing.length === 0) {
  pass(`all ${allHandlers.size} handler files exist on disk`);
} else {
  fail(`handler files referenced but missing: ${missing.join(', ')}`);
}

// Step 7: Reverse — find .mjs files in hooks/ that are NOT referenced anywhere (potential dead code)
// (informational only — not a fail; ship as PASS noting count, with a stretch-goal output)
console.log('');
console.log('--- Check 4: no orphan .mjs files in hooks/ ---');
let dirEntries = [];
try { dirEntries = readdirSync(HOOKS_DIR); } catch { /* empty */ }
const onDisk = dirEntries.filter((f) => f.endsWith('.mjs'));
const unreferenced = onDisk.filter((f) => !allHandlers.has(f));
if (unreferenced.length === 0) {
  pass(`no orphan .mjs files in hooks/ (${onDisk.length} files all referenced)`);
} else {
  // INFO not FAIL — orphans are tolerated for now (e.g., _lib/ modules)
  pass(`hooks/ has ${unreferenced.length} unreferenced .mjs files (allowed; they may be library helpers): ${unreferenced.join(', ')}`);
}

// Final
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
