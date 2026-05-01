---
description: Approve session plan and begin wave execution
argument-hint: "[optional instructions]"
---

# Execute Session Plan

The user has approved the session plan. Begin execution immediately.

## Express Path Detection

Before invoking the wave-executor, check the conversation context for the Express Path activation banner emitted by session-plan or session-start Phase 8.5:

```
Express path activated — <N> tasks, coordinator-direct, no inter-wave checks.
```

If the banner is present (and the session-plan output emitted a 1-wave Express Path plan per `skills/session-plan/SKILL.md` § "Express Path Short-Circuit"):

1. **Execute the agreed tasks directly** as coordinator actions, in dependency order. Do NOT dispatch subagents. Do NOT invoke the wave-executor skill.
2. **Append the Express Path deviation to STATE.md** before invoking session-end. Read `<state-dir>/STATE.md`, then call `appendDeviation()` from `scripts/lib/state-md.mjs` with the message `Express path: <N> tasks executed coord-direct (express-path.enabled: true, session-type: housekeeping, scope: <N> issues)`. Write the result back via the Write tool. This step ensures the audit trail exists BEFORE session-end finalizes the file. Equivalent one-liner via Bash:
   ```bash
   node --input-type=module -e "
   import {readFileSync, writeFileSync} from 'node:fs';
   import {appendDeviation} from './scripts/lib/state-md.mjs';
   const path = '.claude/STATE.md'; // or .codex/STATE.md on Codex CLI
   const updated = appendDeviation(readFileSync(path, 'utf8'), new Date().toISOString(), 'Express path: <N> tasks executed coord-direct (express-path.enabled: true, session-type: housekeeping, scope: <N> issues)');
   writeFileSync(path, updated);
   "
   ```
3. **Invoke `session-orchestrator:session-end`** directly via the `Skill` tool. Session-end finalizes STATE.md (sets `status: completed`, writes `.orchestrator/metrics/sessions.jsonl`, runs vault-mirror if enabled). Without this auto-invocation, every Express Path run leaves no audit trail (issue #320).
4. **Verify persistence after session-end completes:** read `<state-dir>/STATE.md` and confirm `frontmatter.status === 'completed'` and the body's `## Deviations` section contains an `Express path:` entry. If either is missing, warn the user inline with: `⚠ Express Path persistence verification failed — STATE.md not finalized. Re-run /close manually.` Then return the final summary.
5. **Return** the session summary to the user. The express-path execution is complete.

If the banner is **absent**: proceed to "Standard Execution" below.

## Standard Execution

**Invoke the wave-executor skill.** Follow the agreed plan wave by wave. Forward `$ARGUMENTS` (if any) to the wave-executor as priority guidance for agent prompts (see wave-executor Pre-Execution: User Instructions).

Do NOT re-plan. Do NOT re-analyze. Execute the agreed plan NOW with maximum efficiency.
