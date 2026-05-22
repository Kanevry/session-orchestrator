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

```bash
node --input-type=module -e "
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const cwd = process.cwd();
const sessionFile = join(cwd, '.orchestrator', 'current-session.json');
const ackFile = join(cwd, '.orchestrator', 'runtime', 'templates-acknowledged.json');
const reason = process.argv[1] ?? '';
const userId = process.env.USER ?? process.env.USERNAME ?? '';

// Resolve session_id
let sessionId = null;
if (existsSync(sessionFile)) {
  try {
    const raw = JSON.parse(readFileSync(sessionFile, 'utf8'));
    sessionId = raw.session_id ?? raw.sessionId ?? null;
  } catch { /* ignore */ }
}
if (!sessionId) {
  process.stderr.write('⚠ templates-ack: could not read session_id from .orchestrator/current-session.json — ack not written\n');
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
