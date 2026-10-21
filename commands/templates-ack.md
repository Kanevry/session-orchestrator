---
description: Acknowledge templates-first policy for the current session — bypasses the pre-bash-templates-first hook for the remainder of the session
argument-hint: "[optional-reason]"
---

# Templates Acknowledgement

Write a session-scoped acknowledgement entry to `.orchestrator/runtime/templates-acknowledged.json`. Once written, the `pre-bash-templates-first` hook (G6) will allow `gh`/`glab` create operations for the rest of the current session without requiring a prior template Read.

**Use this only when:**
- You have already reviewed the relevant template externally (e.g. copy-paste workflow), OR
- You are running an automated or retro merge that does not benefit from template enforcement.

## Implementation

Run the following node snippet to write the acknowledgement:

The acknowledgement requires proof from the nearest ancestor whose process name
(basename of `comm`) is `claude`: its `~/.claude/sessions/<pid>.json` must supply a valid `sessionId`.
Only parent PID and process name are measured, with at most 64 processes and no
cycles. Nonempty native environment IDs must agree with that invocation.
Missing process/session evidence refuses the acknowledgement, including on
harnesses without a Claude ancestor. Shared
`.orchestrator/current-session.json` state is never used as identity. This guards against accidental acknowledgement
for a parent session from a nested harness; it is not a security boundary against
a hostile child (which could write the file directly). A Claude started as a
plain `node` script has no `claude` ancestor and is refused. Run this
from the target project with the harness's plugin-root environment set (or from
the session-orchestrator repository itself).
The hook accepts this acknowledgement only when its invocation supplies a valid,
unambiguous `session_id` or `sessionId`; inherited environment IDs cannot grant
an acknowledgement bypass when that invocation ID is missing.

```bash
node --input-type=module -e "
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const cwd = process.cwd();
const ackFile = join(cwd, '.orchestrator', 'runtime', 'templates-acknowledged.json');
const reason = process.argv[1] ?? '';
const userId = process.env.USER ?? process.env.USERNAME ?? '';

// Bootstrap from the same root precedence as the plugin resolver. The cwd
// fallback is restricted to the plugin repository, never an arbitrary project.
const roots = [
  ['claude', 'CLAUDE_PLUGIN_ROOT'], ['codex', 'CODEX_PLUGIN_ROOT'],
  ['cursor', 'CURSOR_RULES_DIR'], ['pi', 'PI_PLUGIN_ROOT'],
];
const platform = (process.env.SO_PLATFORM ?? '').trim();
const ordered = [...roots.filter(([p]) => p === platform), ...roots.filter(([p]) => p !== platform)];
let pluginRoot = null;
for (const name of ['PLUGIN_ROOT', ...ordered.map(([, name]) => name)]) {
  const candidate = (process.env[name] ?? '').trim();
  if (!candidate) continue;
  try { if (statSync(candidate).isDirectory()) { pluginRoot = candidate; break; } } catch { /* try next root */ }
}
if (!pluginRoot) {
  try {
    if (JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).name === 'session-orchestrator') pluginRoot = cwd;
  } catch { /* no plugin-root evidence */ }
}
if (!pluginRoot) {
  process.stderr.write('⚠ templates-ack: plugin root unavailable — ack not written\n');
  process.exit(1);
}
let sessionId = null;
try {
  const { readInvocationSessionId } = await import(pathToFileURL(join(pluginRoot, 'scripts/lib/session-identity/own-session.mjs')).href);
  sessionId = readInvocationSessionId();
} catch {
  process.stderr.write('⚠ templates-ack: process-local identity helper unavailable — ack not written\n');
  process.exit(1);
}
if (!sessionId) {
  process.stderr.write('⚠ templates-ack: session id does not come from this invocation — ack not written\n');
  process.exit(1);
}

// Read existing ack file (or start fresh)
let existing = {};
if (existsSync(ackFile)) {
  try { existing = JSON.parse(readFileSync(ackFile, 'utf8')); } catch { existing = {}; }
}

// Build new entry
const entry = { acknowledgedAt: new Date().toISOString() };
if (userId) entry.userId = userId;
if (reason) entry.reason = reason;
existing[sessionId] = entry;

// Atomic write via tmp + rename
const dir = dirname(ackFile);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const tmp = ackFile + '.tmp.' + randomBytes(4).toString('hex');
writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', 'utf8');
renameSync(tmp, ackFile);

process.stdout.write('✓ templates-ack: session ' + sessionId + ' acknowledged at ' + entry.acknowledgedAt + '\n');
process.stdout.write('  Written: ' + ackFile + '\n');
if (reason) process.stdout.write('  Reason: ' + reason + '\n');
" -- "\$ARGUMENTS"
```

## Verification

After writing, confirm the entry exists:

```bash
node -e "
const f = require('fs');
const p = '.orchestrator/runtime/templates-acknowledged.json';
if (!f.existsSync(p)) { console.log('NOT FOUND'); process.exit(1); }
const d = JSON.parse(f.readFileSync(p, 'utf8'));
console.log(JSON.stringify(d, null, 2));
"
```

## Schema

The acknowledgement file stores one entry per session:

```json
{
  "<sessionId>": {
    "acknowledgedAt": "2026-05-22T14:30:45.123Z",
    "userId": "user@example.com",
    "reason": "Bypass for retro merge"
  }
}
```

The hook reads `entry.acknowledgedAt` to confirm a valid session-scoped bypass.
