#!/usr/bin/env node
// scripts/lib/validate/check-hooks-symmetry.mjs
// Verify event-key + handler-file symmetry across hooks/{hooks,hooks-codex,hooks-cursor,hooks-pi}.json
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
  cursorMissingFromMain: ['SessionStart', 'SessionEnd', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreToolUse'],
  // Events unique to hooks-cursor.json (Cursor IDE-specific)
  cursorOnly: ['afterFileEdit', 'beforeShellExecution'],
  // Claude/Codex events with no Pi-native v1 mapping yet.
  piMissingFromMain: ['PostToolUseFailure', 'PostToolBatch', 'SubagentStart', 'SubagentStop', 'CwdChanged'],
  // Pi-native extension events that map onto Claude/Codex hook events.
  piEventMap: {
    session_start: 'SessionStart',
    session_shutdown: 'SessionEnd',
    tool_call: 'PreToolUse',
    tool_result: 'PostToolUse',
    agent_end: 'Stop',
  },
};

const REQUIRED_PI_TOOL_HANDLERS = {
  bash: ['pre-bash-destructive-guard.mjs', 'enforce-commands.mjs'],
  edit: ['enforce-scope.mjs', 'config-protection.mjs'],
  write: ['enforce-scope.mjs', 'config-protection.mjs'],
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

const packageJson = loadJson(join(PLUGIN_ROOT, 'package.json'), false);
const piPackageRequired = Boolean(packageJson?.pi);
const claudeJson = loadJson(join(HOOKS_DIR, 'hooks.json'));
const codexJson  = loadJson(join(HOOKS_DIR, 'hooks-codex.json'));
const cursorJson = loadJson(join(HOOKS_DIR, 'hooks-cursor.json'), false);
const piJson = loadJson(join(HOOKS_DIR, 'hooks-pi.json'), piPackageRequired);

// Step 2: Extract event keys
const claudeEvents = new Set(Object.keys(claudeJson.hooks || {}));
const codexEvents  = new Set(Object.keys(codexJson.hooks || {}));
const cursorEvents = cursorJson ? new Set(Object.keys(cursorJson.hooks || {})) : new Set();
const piEvents = piJson ? new Set(Object.keys(piJson.hooks || {})) : new Set();

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

// Step 5: pi native-event mappings must cover all non-documented main events
console.log('');
console.log('--- Check 3: hooks-pi.json documented mappings ---');
if (piJson) {
  const piCoveredMainEvents = new Set();
  for (const [piEvent, mainEvent] of Object.entries(DOCUMENTED_ASYMMETRIES.piEventMap)) {
    if (piEvents.has(piEvent)) piCoveredMainEvents.add(mainEvent);
  }

  const piMissing = [...claudeEvents].filter((e) =>
    !piCoveredMainEvents.has(e) && !DOCUMENTED_ASYMMETRIES.piMissingFromMain.includes(e));
  if (piMissing.length === 0) {
    pass(`hooks-pi.json covers mapped main events; missing events are documented (${DOCUMENTED_ASYMMETRIES.piMissingFromMain.join(', ')})`);
  } else {
    fail(`hooks-pi.json missing UNDOCUMENTED main-event mappings: ${piMissing.join(', ')}`);
  }

  const knownPiEvents = new Set(Object.keys(DOCUMENTED_ASYMMETRIES.piEventMap));
  const piExtra = [...piEvents].filter((e) => !knownPiEvents.has(e));
  if (piExtra.length === 0) {
    pass(`hooks-pi.json pi-native events are all mapped (${piEvents.size} events)`);
  } else {
    fail(`hooks-pi.json has UNDOCUMENTED pi-native events: ${piExtra.join(', ')}`);
  }

  const missingToolHandlers = requiredPiToolHandlerGaps(piJson);
  if (missingToolHandlers.length === 0) {
    pass('hooks-pi.json wires required tool_call handlers for bash, edit, and write');
  } else {
    fail(`hooks-pi.json missing required tool_call handlers: ${missingToolHandlers.join('; ')}`);
  }
} else {
  pass(`hooks-pi.json absent (optional config)`);
}

// Step 6: Extract handler-file refs from each config
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
        const match = cmd.match(/(?:hooks\/|\$\{?CLAUDE_PLUGIN_ROOT\}?\/hooks\/|\$\{?CODEX_PLUGIN_ROOT\}?\/hooks\/|\$\{?PI_PLUGIN_ROOT\}?\/hooks\/)([\w/-]+\.mjs)/);
        if (match) handlers.add(match[1]);
      }
    }
  }
  return handlers;
}

function matcherMatches(matcher, target) {
  if (!matcher || matcher === '*') return true;
  return matcher.split('|').map((p) => p.trim().toLowerCase()).includes(target);
}

function handlersForPiTool(json, toolName) {
  const handlers = new Set();
  const entries = Array.isArray(json.hooks?.tool_call) ? json.hooks.tool_call : [];
  for (const entry of entries) {
    const matcher = typeof entry.matcher === 'string' ? entry.matcher.toLowerCase() : '';
    if (!matcherMatches(matcher, toolName)) continue;
    for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
      const cmd = hook.command || hook.script || '';
      const match = cmd.match(/(?:hooks\/|\$\{?PI_PLUGIN_ROOT\}?\/hooks\/)([\w/-]+\.mjs)/);
      if (match) handlers.add(match[1]);
    }
  }
  return handlers;
}

function requiredPiToolHandlerGaps(json) {
  const gaps = [];
  for (const [toolName, requiredHandlers] of Object.entries(REQUIRED_PI_TOOL_HANDLERS)) {
    const handlers = handlersForPiTool(json, toolName);
    for (const required of requiredHandlers) {
      if (!handlers.has(required)) gaps.push(`${toolName} → ${required}`);
    }
  }
  return gaps;
}
const claudeHandlers = extractHandlers(claudeJson);
const codexHandlers  = extractHandlers(codexJson);
const cursorHandlers = cursorJson ? extractHandlers(cursorJson) : new Set();
const piHandlers = piJson ? extractHandlers(piJson) : new Set();
const allHandlers = new Set([...claudeHandlers, ...codexHandlers, ...cursorHandlers, ...piHandlers]);

// Step 7: Verify each handler file exists on disk (skip _lib/* — those are library modules)
console.log('');
console.log('--- Check 4: handler files exist on disk ---');
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

// Step 8: Reverse — find .mjs files in hooks/ that are NOT referenced anywhere (potential dead code)
// (informational only — not a fail; ship as PASS noting count, with a stretch-goal output)
console.log('');
console.log('--- Check 5: no orphan .mjs files in hooks/ ---');
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
