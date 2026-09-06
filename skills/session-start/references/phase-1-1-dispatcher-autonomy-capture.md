# Phase 1.1: Dispatcher-Autonomy Migration Capture

> Sub-file of the session-start skill (#1157 — agentskills.io: SKILL.md core < 500 lines, procedure in `references/`). Extracted VERBATIM from `skills/session-start/SKILL.md`; `SKILL.md` keeps a one-line stub naming this phase and its gate condition.

## Phase 1.1: Dispatcher-Autonomy Migration Capture (one-time, per-repo)

> Closes session-orchestrator issue #681 (Epic #673 P3 — one-time per-repo dispatcher-autonomy capture). Migration trigger: the first session-start after this feature ships on a repo whose committed `dispatcher-autonomy:` block is still absent. Cross-reference `.claude/rules/ask-via-tool.md` (AUQ via tool, not prose).

**WHEN:** Runs after Phase 1 (config read) and BEFORE Phase 1.2 (session-lock acquire). Fires **exactly once per repo** — the write makes the committed block present, so every subsequent session skips it.

**WHY (one-time guard):** The committed `## Dispatcher Autonomy` block is the never-re-ask marker. Detect "block absent" via `isDispatcherAutonomyBlockPresent($CLAUDE_MD_CONTENT)` — a raw `/^dispatcher-autonomy:\s*$/m` presence check on the file content. Do NOT use the resolved autonomy value from `$CONFIG`: it returns `'off'` for BOTH "block absent" AND "block present with `autonomy: off`", so it cannot distinguish a first-run migration from a deliberate `off`. Only the raw presence check distinguishes them.

> **The guard is gated purely on committed-block PRESENCE, never on the resolved value.** A machine whose effective autonomy differs from the committed default — because `SO_DISPATCHER_AUTONOMY` or `owner.yaml` `dispatcher.autonomy` overrides it — STILL counts as captured the moment the committed block exists, and is never re-asked. Conversely a host with `owner.yaml` `dispatcher.autonomy` set but NO committed block is still asked once at this migration: a host-local override does NOT satisfy the migration guard; only the committed CLAUDE.md / AGENTS.md block does. Even a header-present-but-body-malformed block counts as PRESENT (a malformed block is the operator's to fix, not a re-prompt trigger).

**WHAT:** When the block is absent, the coordinator dispatches ONE `AskUserQuestion` using the definition from `scripts/lib/config/dispatcher-autonomy-capture.mjs`:

- **Dispatcher autonomy** — `off` (Recommended, fail-closed) | `advisory` | `autonomous-gated`

On **any** answer (including `off`) the committed block is written, presented, and never re-asked. The writer persists ONLY the committed default — host-local overrides (`SO_DISPATCHER_AUTONOMY` env, `owner.yaml` `dispatcher.autonomy`) stay host-local and NEVER land in CLAUDE.md.

> **Capture writes the committed default; the runtime value flows through `resolveDispatcherAutonomy`.** This phase only persists the operator's one-time choice as the committed baseline. The EFFECTIVE autonomy at run time is resolved separately by `resolveDispatcherAutonomy()` in `scripts/lib/config/dispatcher-autonomy.mjs` with host-local precedence `SO_DISPATCHER_AUTONOMY` env > `owner.yaml` `dispatcher.autonomy` > committed > `off` (#653 pattern). Migration capture never reads or writes those override tiers — it writes the committed tier only, so a machine with an active override differs from the committed default WITHOUT re-triggering this capture.

**AUQ (mandatory — use the tool, not prose):** On Claude Code / Cursor IDE, dispatch this via the **`AskUserQuestion` tool** per `.claude/rules/ask-via-tool.md` (AUQ-001) — never an inline markdown "choose 1/2/3" list. Option 1 (`off`) is the recommended, fail-closed default. Only Codex CLI (no `AskUserQuestion`) falls back to a numbered-list prose prompt (AUQ-004 exception 1).

**HOW (coordinator steps):**

```js
import {
  getDispatcherAutonomyQuestion,
  isDispatcherAutonomyBlockPresent,
  writeDispatcherAutonomyBlock,
} from '$PLUGIN_ROOT/scripts/lib/config/dispatcher-autonomy-capture.mjs';
import { readFileSync } from 'node:fs';

const claudeMdPath = `${process.cwd()}/CLAUDE.md`;
let content = '';
try { content = readFileSync(claudeMdPath, 'utf8'); } catch { /* no CLAUDE.md — skip */ }
if (content && !isDispatcherAutonomyBlockPresent(content)) {
  const q = getDispatcherAutonomyQuestion(); // option 1 = 'off' (Recommended, fail-closed)
  // Claude Code / Cursor: dispatch AskUserQuestion([q]) (the TOOL — AUQ-001); collect the
  //   selected label (the `autonomy` enum). Never an inline numbered-list prose question here.
  // Codex CLI fallback only (no AskUserQuestion — AUQ-004 exception 1): print q.question +
  //   numbered q.options list, read the operator's pick, map it to the option label.
  const autonomy = /* selected option label: 'off' | 'advisory' | 'autonomous-gated' */;
  const result = writeDispatcherAutonomyBlock({ claudeMdPath, autonomy });
  // result: { written: true, path } on first write; { written: false, reason: 'already-present' } if a
  //   parallel session already wrote it OR a malformed block already exists (defensive
  //   double-write guard re-checks absence against freshly-read content before writing).
}
```

> Skip silently when no committed `CLAUDE.md` exists (e.g. a not-yet-bootstrapped repo) — the read failure is non-fatal. The capture then runs at bootstrap (Phase 3.5.1) instead.

**WHERE:** Appended as a standalone `## Dispatcher Autonomy` H2 in the repo's committed `CLAUDE.md` (NOT a key inside `## Session Config` — the standalone-H2 placement keeps `claude-md-drift-check` Check-6 parity green).

