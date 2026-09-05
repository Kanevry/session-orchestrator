#!/usr/bin/env node
// scripts/lib/validate/check-hooks-symmetry.mjs
// Verify event-key + handler-file + per-event handler-set symmetry across
// hooks/{hooks,hooks-codex,hooks-cursor,hooks-pi}.json (Check 6: #942)
// Check 6 projects platform-native event namespaces onto the logical Claude
// events first, then refuses to report parity for any counterpart event that
// lands on no hooks.json event — whether that is one dropped projection or the
// whole namespace (a vacuum-true PASS — see Check 6).
// Exit 0 = all checks pass, 1 = any check fails
// Stdout: '  PASS: ...' / '  FAIL: ...' lines + 'Results: N passed, M failed'

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The pi and cursor projections are IMPORTED, not copied: the runtime bridges
// rewrite `hook_event_name` for every native event, so they are the source of
// truth for which native event becomes which Claude event (#953). A local
// literal here was a second copy — it could drift silently, and the validator
// would then certify a projection the runtime does not use.
import { CURSOR_TO_CANONICAL_EVENT } from '../cursor-hook-bridge.mjs';
import { PI_TO_CANONICAL_EVENT } from '../pi-hook-bridge.mjs';

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
  cursorOnly: [
    'afterFileEdit',
    'afterShellExecution',
    'beforeShellExecution',
    'postToolUse',
    'postToolUseFailure',
    'preToolUse',
    'sessionEnd',
    'sessionStart',
    'stop',
    'subagentStart',
    'subagentStop',
  ],
  // Claude/Codex events with no Pi-native v1 mapping yet.
  piMissingFromMain: ['PostToolUseFailure', 'PostToolBatch', 'SubagentStart', 'SubagentStop', 'CwdChanged'],
  // Pi-native extension events that map onto Claude/Codex hook events.
  // Bound to the runtime constant (see the import comment): the projection this
  // validator checks hooks-pi.json against is the SAME object pi-hook-bridge.mjs
  // applies to live payloads, so the two cannot drift apart.
  piEventMap: PI_TO_CANONICAL_EVENT,
  // Bound to the runtime constant (see the import comment): the projection this
  // validator checks hooks-cursor.json against is the SAME object
  // cursor-hook-bridge.mjs applies to live payloads (#919 closed).
  cursorEventMap: CURSOR_TO_CANONICAL_EVENT,
  // Check 6 (#942): handlers wired on a Claude event but intentionally absent
  // from the SAME logical event on a counterpart manifest. Checks 1-3 compare
  // event KEYS and Check 4 handler EXISTENCE — a handler wired on only one
  // platform was structurally invisible to all four (the #942 blind spot:
  // post-bash-write-verify.mjs shipped Claude-only and nothing flagged it).
  // A handler missing on a shared event and NOT listed here → FAIL.
  handlerAsymmetries: {
    codex: {
      // Codex 0.144.4 has no payload adapter (docs/codex-setup.md § Hook
      // Surface and Trust): Edit/Write handlers expect Claude payload shapes,
      // Bash guards expect tool_name === 'Bash'. Wiring them would be a silent
      // no-op, not enforcement (#919-P2 class) — "pretending the payloads are
      // compatible would create false enforcement".
      PreToolUse: [
        // pre-task-scope-disjoint (#1020): NOT ported by construction. The hook
        // matches the `Agent` dispatch tool, which this platform does not have —
        // Cursor IDE and Pi v1 have no parallel agent dispatch at all
        // (skills/session-plan/SKILL.md Platform Note), and Codex has no payload
        // adapter for it. A matcher that can never fire is not enforcement.
        // pre-auq-clarity (#1107): NOT ported by construction. The hook matches
        // the `AskUserQuestion` tool, which this platform does not have — it
        // renders a numbered Markdown list instead (docs/codex-setup.md:112,
        // docs/cursor-setup.md:86), and pi-hook-bridge's TOOL_NAME_MAP carries
        // no `askuserquestion` entry. A matcher on a tool that never fires is a
        // dead entry: maintenance cost that ASSERTS a protection it does not
        // provide. Revisit the day the platform gains the tool — the mechanical
        // witness for that day is the mapPiToolName assertion in
        // tests/hooks/pre-auq-clarity-wiring.test.mjs, which goes red then.
        'pre-auq-clarity.mjs',
        'pre-task-scope-disjoint.mjs',
        'skill-invocation-telemetry.mjs',
        'enforce-scope.mjs',
        'config-protection.mjs',
        'pre-bash-destructive-guard.mjs',
        'pre-bash-staging-fence.mjs',
        'pre-bash-memory-propose-audit.mjs',
        // pre-bash-sessions-ledger-guard (#958): same Bash-payload dependency
        // as the guards above — it reads tool_name === 'Bash' and
        // tool_input.command, neither of which any Codex bridge delivers
        // (measured 2026-07-31: `grep -rn "tool_name" scripts/lib/codex/*.mjs`
        // → 0 matches, exit 1). A manifest entry would be a silent no-op, not
        // enforcement — #919-P2 class. Gap registered, not faked.
        'pre-bash-sessions-ledger-guard.mjs',
        'pre-bash-templates-first.mjs',
        'pre-bash-issue-budget.mjs',
        'enforce-commands.mjs',
      ],
      // post-bash-write-verify (#942): needs tool_name === 'Bash', which no
      // Codex bridge delivers — documented exception until an adapter exists.
      // Measured 2026-07-31: `grep -rn "tool_name" scripts/lib/codex/*.mjs`
      // → 0 matches (exit 1), so a manifest entry here would be a silent
      // no-op, not enforcement. Same #919-P2 class as the PreToolUse block.
      PostToolUse: [
        'post-edit-validate.mjs',
        'post-tooluse-frontend-slop.mjs',
        // post-edit-import-probe (#1224): same missing Edit/Write payload
        // adapter as post-edit-validate — the hook reads tool_name and
        // tool_input.file_path, neither of which any Codex bridge delivers.
        // A manifest entry would be a silent no-op, not enforcement.
        'post-edit-import-probe.mjs',
        'post-bash-write-verify.mjs',
      ],
      SubagentStart: ['subagent-telemetry.mjs'],
      SubagentStop: ['subagent-telemetry.mjs', 'post-subagent-discovery-validator.mjs'],
    },
    pi: {
      // skill-invocation-telemetry: Pi has no Skill tool (pi-hook-bridge
      // TOOL_NAME_MAP) — the matcher can never fire.
      // pre-bash-templates-first + pre-bash-issue-budget (#946): status-quo
      // gaps predating #942. Operator decision 2026-07-31 — NOT ported, gap
      // registered instead; #946 tracks the port-or-justify follow-up.
      // pre-bash-sessions-ledger-guard (#958): NOT ported. Pi has a payload
      // adapter (pi-hook-bridge.mjs), so unlike codex/cursor this one is
      // portable — but wiring it is a separate decision with its own test
      // surface, and the operator's 2026-07-31 rule is that a gap gets
      // registered rather than faked. #958 tracks the port-or-justify.
      PreToolUse: [
        // pre-task-scope-disjoint (#1020): NOT ported by construction. The hook
        // matches the `Agent` dispatch tool, which this platform does not have —
        // Cursor IDE and Pi v1 have no parallel agent dispatch at all
        // (skills/session-plan/SKILL.md Platform Note), and Codex has no payload
        // adapter for it. A matcher that can never fire is not enforcement.
        // pre-auq-clarity (#1107): NOT ported by construction. The hook matches
        // the `AskUserQuestion` tool, which this platform does not have — it
        // renders a numbered Markdown list instead (docs/codex-setup.md:112,
        // docs/cursor-setup.md:86), and pi-hook-bridge's TOOL_NAME_MAP carries
        // no `askuserquestion` entry. A matcher on a tool that never fires is a
        // dead entry: maintenance cost that ASSERTS a protection it does not
        // provide. Revisit the day the platform gains the tool — the mechanical
        // witness for that day is the mapPiToolName assertion in
        // tests/hooks/pre-auq-clarity-wiring.test.mjs, which goes red then.
        'pre-auq-clarity.mjs',
        'pre-task-scope-disjoint.mjs',
        'skill-invocation-telemetry.mjs',
        'pre-bash-sessions-ledger-guard.mjs', // #958
        'pre-bash-templates-first.mjs', // #946
        'pre-bash-issue-budget.mjs',    // #946
      ],
    },
    // Cursor is wired through scripts/lib/cursor-hook-bridge.mjs (#919 closed).
    // Remaining gaps are tools Cursor does not expose, not missing adapters.
    cursor: {
      PreToolUse: [
        // pre-task-scope-disjoint (#1020): NOT ported by construction. The hook
        // matches the `Agent` dispatch tool, which this platform does not have —
        // Cursor IDE and Pi v1 have no parallel agent dispatch at all
        // (skills/session-plan/SKILL.md Platform Note), and Codex has no payload
        // adapter for it. A matcher that can never fire is not enforcement.
        // pre-auq-clarity (#1107): NOT ported by construction. The hook matches
        // the `AskUserQuestion` tool, which this platform does not have — it
        // renders a numbered Markdown list instead (docs/codex-setup.md:112,
        // docs/cursor-setup.md:86), and pi-hook-bridge's TOOL_NAME_MAP carries
        // no `askuserquestion` entry. A matcher on a tool that never fires is a
        // dead entry: maintenance cost that ASSERTS a protection it does not
        // provide. Revisit the day the platform gains the tool — the mechanical
        // witness for that day is the mapPiToolName assertion in
        // tests/hooks/pre-auq-clarity-wiring.test.mjs, which goes red then.
        'pre-auq-clarity.mjs',
        'pre-task-scope-disjoint.mjs',
        // skill-invocation-telemetry: Cursor has no Skill tool — the matcher
        // can never fire. Commands Read skills/*/SKILL.md instead.
        'skill-invocation-telemetry.mjs',
      ],
    },
  },
};

const REQUIRED_CODEX_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
];
const FORBIDDEN_CODEX_EVENTS = [
  'SessionEnd',
  'PostToolUseFailure',
  'PostToolBatch',
  'CwdChanged',
];

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

// Step 3: Codex exposes a deliberate subset of the broader Claude event surface.
console.log('--- Check 1: hooks-codex.json required/forbidden event surface ---');
const missingRequiredCodex = REQUIRED_CODEX_EVENTS.filter((event) => !codexEvents.has(event));
if (missingRequiredCodex.length === 0) {
  pass(`required Codex event subset is present (${REQUIRED_CODEX_EVENTS.join(', ')})`);
} else {
  fail(`hooks-codex.json missing required events: ${missingRequiredCodex.join(', ')}`);
}

const forbiddenCodex = FORBIDDEN_CODEX_EVENTS.filter((event) => codexEvents.has(event));
if (forbiddenCodex.length === 0) {
  pass('hooks-codex.json excludes all forbidden Claude-only events');
} else {
  fail(`hooks-codex.json has forbidden unsupported events: ${forbiddenCodex.join(', ')}`);
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
function extractHandlersByEvent(json) {
  const byEvent = {};
  for (const [eventName, event] of Object.entries(json.hooks || {})) {
    const handlers = new Set();
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
        const match = cmd.match(/(?:hooks\/|\$\{?CLAUDE_PLUGIN_ROOT\}?\/hooks\/|\$\{?CODEX_PLUGIN_ROOT\}?\/hooks\/|\$\{?PI_PLUGIN_ROOT\}?\/hooks\/|\$\{?CURSOR_PLUGIN_ROOT\}?\/hooks\/)([\w/-]+\.mjs)/);
        if (match) handlers.add(match[1]);
      }
    }
    byEvent[eventName] = handlers;
  }
  return byEvent;
}

function extractHandlers(json) {
  const handlers = new Set();
  for (const set of Object.values(extractHandlersByEvent(json))) {
    for (const h of set) handlers.add(h);
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

// Step 9 (#942): per-event handler-SET parity, Claude → counterpart.
// Checks 1-3 compare event keys, Check 4 handler existence — neither sees a
// handler wired on one platform only. For every logical event the counterpart
// DECLARES (event-level absences stay governed by Checks 1-3), each Claude
// handler must be present on the counterpart or listed in
// DOCUMENTED_ASYMMETRIES.handlerAsymmetries. Undocumented gap → FAIL.
console.log('');
console.log('--- Check 6: per-event handler-set parity across manifests (#942) ---');
const claudeHandlersByEvent = extractHandlersByEvent(claudeJson);

// Pi and Cursor declare platform-native event names; project them onto the
// logical main events before comparing, or the whole comparison is vacuous.
// Native events with no mapping are carried through under their own name so
// the projection guard below still sees them as declared.
//
// The merge is a UNION, not an assignment: two native events may project onto
// the SAME logical event (a harness with `before_shell` AND `before_edit` both
// mapping to PreToolUse, or — reachable today via the identity fallback — a
// counterpart that declares the logical event alongside a native event that
// projects onto it). Assignment let the second write silently discard the
// first set, so its handlers resurfaced as a phantom "undocumented asymmetry"
// or vanished from the comparison entirely.
function handlersByMainEvent(json, eventMap) {
  const byNativeEvent = extractHandlersByEvent(json);
  const byMain = {};
  for (const [nativeEvent, handlers] of Object.entries(byNativeEvent)) {
    const target = eventMap[nativeEvent] || nativeEvent;
    byMain[target] = new Set([...(byMain[target] ?? []), ...handlers]);
  }
  return byMain;
}

const HANDLER_PARITY_COUNTERPARTS = [
  { file: 'hooks-codex.json', key: 'codex', byEvent: codexJson ? extractHandlersByEvent(codexJson) : null },
  {
    file: 'hooks-cursor.json',
    key: 'cursor',
    byEvent: cursorJson ? handlersByMainEvent(cursorJson, DOCUMENTED_ASYMMETRIES.cursorEventMap) : null,
  },
  {
    file: 'hooks-pi.json',
    key: 'pi',
    byEvent: piJson ? handlersByMainEvent(piJson, DOCUMENTED_ASYMMETRIES.piEventMap) : null,
  },
];

for (const { file, key, byEvent } of HANDLER_PARITY_COUNTERPARTS) {
  if (!byEvent) {
    pass(`${file} absent (optional config) — handler parity skipped`);
    continue;
  }
  // Projection guard: every event a counterpart declares must land on a
  // logical event hooks.json also declares. An unprojected event makes the
  // per-event loop below `continue` on the logical event it was supposed to
  // cover, so those handlers are never compared and Check 6 still reports
  // PASS — only the `documented asymmetries:` count moves. Losing ALL
  // projections is how hooks-cursor.json passed with 20 of 22 handlers
  // missing; losing ONE is the same blindness at smaller scale, so the guard
  // fails closed per event, not only on the empty intersection (#946).
  const declaredEvents = Object.keys(byEvent);
  const sharedEvents = declaredEvents.filter((e) => Object.hasOwn(claudeHandlersByEvent, e));
  const unprojectedEvents = declaredEvents.filter((e) => !Object.hasOwn(claudeHandlersByEvent, e));
  if (declaredEvents.length > 0 && sharedEvents.length === 0) {
    // Whole-namespace loss keeps its own message: nothing at all was compared.
    fail(`${file} shares ZERO logical events with hooks.json after projection (declares: ${declaredEvents.join(', ')}) — handler parity would pass vacuously; add an event projection to DOCUMENTED_ASYMMETRIES`);
    continue;
  }
  if (unprojectedEvents.length > 0) {
    fail(`${file} declares events with no logical counterpart in hooks.json after projection: ${unprojectedEvents.join(', ')} — handlers on the logical events they stand for are never compared; add a projection to DOCUMENTED_ASYMMETRIES.${key}EventMap`);
    continue;
  }

  const allow = DOCUMENTED_ASYMMETRIES.handlerAsymmetries[key] || {};
  const undocumented = [];
  let documentedCount = 0;
  for (const [event, claudeSet] of Object.entries(claudeHandlersByEvent)) {
    const counterpartSet = byEvent[event];
    if (!counterpartSet) continue; // event not declared on counterpart — Checks 1-3 govern
    const allowed = new Set(allow[event] || []);
    for (const handler of claudeSet) {
      if (counterpartSet.has(handler)) continue;
      if (allowed.has(handler)) { documentedCount++; continue; }
      undocumented.push(`${event} → ${handler}`);
    }
  }
  if (undocumented.length === 0) {
    pass(`${file} per-event handler sets match hooks.json (documented asymmetries: ${documentedCount})`);
  } else {
    fail(`${file} missing UNDOCUMENTED handlers on shared events: ${undocumented.join(', ')}`);
  }
}

// Final
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
