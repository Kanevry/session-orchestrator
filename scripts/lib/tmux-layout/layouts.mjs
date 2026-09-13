/**
 * layouts.mjs — tmux layout renderers for the session-orchestrator tmux-layout skill.
 *
 * Exports:
 *   renderDefaultLayout({ sessionName, force, projectRoot, vcsConfig? })
 *   renderDebugLayout({ sessionName, force, projectRoot })
 *
 * Default layout pane map (user-facing numbering):
 *   Pane 1 (top-left)     — scratch shell (NO command — default tmux shell, AUQ-001 compliance)
 *   Pane 2 (top-right)    — tail -F <stateDir>/STATE.md
 *   Pane 3 (bottom-right) — vcs-aware CI watch (poll-loop from detectVcsCommand)
 *   Pane 4 (bottom-left)  — tail -F .orchestrator/metrics/events.jsonl | jq select(wave|gate|spiral)
 *   Pane 5 (optional)     — agent-status telemetry (#565), only when withStatusPane is true:
 *                           poll-loop over readCurrentStatus() from scripts/lib/agent-status.mjs,
 *                           which reports provenance (live-map / rebuilt-log / stale-cache) — #1342.
 *
 * Debug layout pane map (user-facing numbering):
 *   Pane 1 (top-left)     — scratch shell (NO command — default tmux shell, AUQ-001 compliance)
 *   Pane 2 (top-right)    — hypothesis-test runner: npm test -- --watch
 *   Pane 3 (bottom-right) — debug-artifact tail: tail -F .orchestrator/debug/*.md
 *   Pane 4 (bottom-left)  — diff-watch: watch -n 2 'git diff --stat | head -30'
 *
 * Issues #561, #562 — ADR-0007 tmux-visualization substrate.
 */

import path from 'node:path';
import { resolveStateDir } from '../platform.mjs';
import { detectVcsCommand } from './vcs-detector.mjs';
import { isSessionCollision } from './tmux-shell.mjs';

// ---------------------------------------------------------------------------
// Telemetry wrapper — defensive import (P2 parallel agent owns telemetry.mjs)
// ---------------------------------------------------------------------------

/** @type {(layoutName: string, fn: Function) => Function} */
let withTelemetry;
try {
  // P2 owns scripts/lib/tmux-layout/telemetry.mjs — import defensively so that
  // layouts.mjs works (without telemetry) even when P2's file has not landed yet.
  ({ withTelemetry } = await import('./telemetry.mjs'));
} catch {
  // Fallback: identity wrapper — emits no telemetry but preserves the layout API.
  // This code path is exercised during development and test runs before P2 ships.
  withTelemetry = (_layoutName, fn) => fn;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Single-quote a shell command string for use as a tmux send-keys argument.
 * Escapes embedded single-quotes using the POSIX `'...' '\'' '...'` pattern.
 *
 * @param {string} s
 * @returns {string}  e.g. 'tail -F /path/to/STATE.md'
 */
function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** Poll interval (seconds) of the agent-status pane loop. */
const STATUS_PANE_POLL_SECONDS = 2;

/**
 * Build the ONE-SHOT render command of the agent-status pane (#1342).
 *
 * The pane used to `jq` `.orchestrator/runtime/agent-status-current.json` directly.
 * That file is a REBUILDABLE CACHE, not the source of truth: after a lock timeout
 * (or a death between the ledger append and the map write) it shows `running` for
 * an agent whose ledger already says `completed`. So the pane now goes through
 * `readCurrentStatus()` — the only reader that folds the ledger tail and reports
 * PROVENANCE — and prints that provenance in its header line:
 *
 *   agent-status · source=<live-map|rebuilt-log|stale-cache|absent> · at=<ISO|n/a>[ · STALE][ · DEGRADED: <reasons>]
 *
 * A `stale-cache` source or any `degraded` reason is marked in TEXT (leading `⚠`
 * plus the words STALE / DEGRADED), never by colour alone. `absent` (nothing on
 * disk yet) stays UNMARKED — a fresh repo is not a degradation (HR-101).
 *
 * Exported so a consumer test can run the render ONCE instead of the poll loop.
 *
 * Shell-shape notes (both load-bearing):
 *   - the `-e` script is wrapped in SINGLE quotes, so the JS below uses only
 *     double-quoted strings: inside single quotes no `$`, backtick or interactive
 *     `!` history expansion can touch it.
 *   - the module path is resolved from THIS file's own URL (never a hardcoded home
 *     path), exactly as the sibling pane commands stay relative-to-cwd.
 *
 * @returns {string} a single shell command; prints the pane body once and exits.
 */
export function buildStatusPaneRenderCommand() {
  // `%27` guard: a single quote in the repo path would otherwise end the shell
  // single-quoted `-e` argument.
  const moduleHref = new URL('../agent-status.mjs', import.meta.url).href.replace(/'/g, '%27');
  const js = [
    `import {readCurrentStatus} from ${JSON.stringify(moduleHref)};`,
    'const v=readCurrentStatus({repoRoot:process.cwd()});',
    'const ids=Object.keys(v.entries).sort();',
    // An EMPTY channel (no ledger yet, no cache yet) is the normal fresh-repo
    // state, not a degradation — marking it would fire the warning on every
    // session and teach the operator to ignore it (host-resources.md HR-101).
    // `readCurrentStatus()` names that state `absent` and emits no `degraded`,
    // so the unmarked case keys on the SOURCE, not on a reason allowlist.
    'const bare=v.source==="absent";',
    'const marks=[];',
    'if(!bare&&v.source==="stale-cache")marks.push("STALE");',
    'if(!bare&&v.degraded)marks.push("DEGRADED: "+v.degraded.reasons.join(","));',
    'const head=(marks.length>0?"\u26a0 ":"")+"agent-status \u00b7 source="+v.source+" \u00b7 at="+(v.at||"n/a")+(marks.length>0?" \u00b7 "+marks.join(" \u00b7 "):"");',
    'console.log(head);',
    'if(ids.length===0)console.log("no agent-status yet \u2014 set persistence:true + run a wave (see skills/wave-executor/wave-loop.md \u00a7 3a-bis)");',
    'for(const id of ids){const r=v.entries[id]||{};const what=typeof r.text==="string"?r.text:(r.step!==undefined?r.step+"/"+r.total+(r.label?" "+r.label:""):"unknown");console.log(id+"  "+what+"  "+(r.ts||"no-ts"));}',
  ].join('');
  return `node --input-type=module -e '${js}'`;
}

// ---------------------------------------------------------------------------
// renderDefaultLayout
// ---------------------------------------------------------------------------

/**
 * Render the default 4-pane tmux layout.
 *
 * Produces a one-liner shell command that the user pastes into a SECOND terminal
 * (not the coordinator terminal). The coordinator terminal remains untouched.
 *
 * Collision policy (PSA-003):
 *   - If session already exists and --force is false → refuse with an error.
 *   - If session already exists and --force is true  → kill it first.
 *
 * @param {{ sessionName: string, force: boolean, projectRoot: string, vcsConfig?: object, withStatusPane?: boolean }} ctx
 * @returns {Promise<{ ok: boolean, oneliner: string, panes: number, degraded: boolean, attachCommand: string, error?: string }>}
 */
async function _renderDefaultLayoutInner({ sessionName, force, projectRoot, vcsConfig, withStatusPane = false }) {
  // 1. Resolve STATE.md path: resolveStateDir() returns '.claude' / '.codex' / '.cursor'
  //    We intentionally do NOT hard-code projectRoot into the STATE.md path inside the
  //    one-liner — the user pastes the command in THEIR second terminal from the same
  //    project dir, so relative-from-cwd paths work. But for the tail -F of events.jsonl
  //    (which is relative) and STATE.md (also relative) we keep them relative.
  const stateDirName = resolveStateDir();   // returns '.claude' | '.codex' | '.cursor'
  const stateMdPath = path.join(stateDirName, 'STATE.md');

  // 2. Resolve vcs command (Pane 3)
  const vcs = detectVcsCommand({ config: vcsConfig, projectRoot });

  // 3. Build pane commands (Pane 1 = scratch shell per AUQ-001 — no command sent, tmux uses default shell)
  const pane2Cmd = `tail -F ${stateMdPath}`;
  const pane3Cmd = vcs.command;
  const pane4Cmd = `tail -F .orchestrator/metrics/events.jsonl | jq --unbuffered 'select(.event | test("wave|gate|spiral"))'`;
  // Pane 5 (optional, #565 / #1342): poll `readCurrentStatus()` — NOT the cache
  // file — so the pane can never present a stale `running` as live. The renderer
  // prints its own "no agent-status yet" line when the channel is empty, and is
  // exported (buildStatusPaneRenderCommand) so a test can run it once.
  const pane5Cmd = `while true; do clear; ${buildStatusPaneRenderCommand()}; sleep ${STATUS_PANE_POLL_SECONDS}; done`;

  // 4. Session-collision check
  const collision = isSessionCollision(sessionName);
  if (collision.exists && !force) {
    return {
      ok: false,
      oneliner: '',
      panes: 0,
      degraded: true,
      attachCommand: '',
      error: `Session '${sessionName}' already exists. Use --force to replace, or --session-name <other> to coexist (PSA-003).`,
    };
  }

  // 5. Build one-liner segments. Commands are joined with ' && ' so any
  //    failure aborts the chain early (fail-fast is safer than silent partial setup).
  const segments = [];

  // Kill existing session if --force
  if (collision.exists && force) {
    segments.push(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);
  }

  // Create new detached session (Pane 0 = user-facing Pane 1, the scratch shell)
  segments.push(`tmux new-session -d -s ${sessionName}`);

  // Pane 1 (tmux index 0.0): scratch shell — send 'clear' to tidy it up, no further command
  segments.push(`tmux send-keys -t ${sessionName}:0.0 'clear' Enter`);

  // Pane 2 (tmux index 0.1): split horizontal on the window, run STATE.md tail
  segments.push(`tmux split-window -h -t ${sessionName}:0`);
  segments.push(`tmux send-keys -t ${sessionName}:0.1 ${shellQuote(pane2Cmd)} Enter`);

  // Pane 3 (tmux index 0.2): split vertically on Pane 2 (right side), run CI watch
  segments.push(`tmux split-window -v -t ${sessionName}:0.1`);
  segments.push(`tmux send-keys -t ${sessionName}:0.2 ${shellQuote(pane3Cmd)} Enter`);

  // Pane 4 (tmux index 0.3): split vertically on Pane 1 (left side), run events tail
  segments.push(`tmux split-window -v -t ${sessionName}:0.0`);
  segments.push(`tmux send-keys -t ${sessionName}:0.3 ${shellQuote(pane4Cmd)} Enter`);

  // Pane 5 (tmux index 0.4, optional #565): split off Pane 4, run agent-status poll-loop
  if (withStatusPane) {
    segments.push(`tmux split-window -v -t ${sessionName}:0.3`);
    segments.push(`tmux send-keys -t ${sessionName}:0.4 ${shellQuote(pane5Cmd)} Enter`);
  }

  // Select Pane 1 (scratch shell) as the active pane, then attach
  segments.push(`tmux select-pane -t ${sessionName}:0.0`);
  segments.push(`tmux attach-session -t ${sessionName}`);

  const oneliner = segments.join(' && ');
  const attachCommand = `tmux attach-session -t ${sessionName}`;

  return {
    ok: true,
    oneliner,
    panes: withStatusPane ? 5 : 4,
    // degraded = true when no vcs tool available (Pane 3 shows a help message instead)
    degraded: vcs.bin === null,
    attachCommand,
  };
}

// ---------------------------------------------------------------------------
// renderDebugLayout — STUB (#562, deferred to W3 P1)
// ---------------------------------------------------------------------------

/**
 * STUB for GitLab #562 — W3 P1 will implement the debug layout variant.
 * For now returns a degraded result indicating not-yet-implemented.
 *
 * Signature MUST match renderDefaultLayout for uniform consumption by I2.
 *
 * @param {{ sessionName: string, force: boolean, projectRoot: string }} ctx
 * @returns {Promise<{ ok: boolean, oneliner: string, panes: number, degraded: boolean, attachCommand: string, error?: string }>}
 */
async function _renderDebugLayoutInner({ sessionName, force, projectRoot: _projectRoot }) {
  // Debug layout (4 panes — #562):
  //   Pane 1: scratch shell (AUQ-001)
  //   Pane 2: npm test --watch (hypothesis-test runner)
  //   Pane 3: tail -F .orchestrator/debug/*.md (debug-artifact tail)
  //   Pane 4: watch -n 2 'git diff --stat | head -30' (diff-watch)

  const pane2Cmd = `npm test -- --watch 2>&1 | head -200`;
  const pane3Cmd = `tail -F .orchestrator/debug/*.md 2>/dev/null || echo 'no .orchestrator/debug/*.md yet — companion to /debug skill Phase 2'`;
  const pane4Cmd = `watch -n 2 'git diff --stat | head -30'`;

  // Session-collision check (same policy as default layout — PSA-003)
  const collision = isSessionCollision(sessionName);
  if (collision.exists && !force) {
    return {
      ok: false,
      oneliner: '',
      panes: 0,
      degraded: true,
      attachCommand: '',
      error: `Session '${sessionName}' already exists. Use --force to replace, or --session-name <other> to coexist (PSA-003).`,
    };
  }

  const segments = [];
  if (collision.exists && force) {
    segments.push(`tmux kill-session -t ${sessionName} 2>/dev/null || true`);
  }
  segments.push(`tmux new-session -d -s ${sessionName}`);
  segments.push(`tmux send-keys -t ${sessionName}:0.0 'clear' Enter`);
  segments.push(`tmux split-window -h -t ${sessionName}:0`);
  segments.push(`tmux send-keys -t ${sessionName}:0.1 ${shellQuote(pane2Cmd)} Enter`);
  segments.push(`tmux split-window -v -t ${sessionName}:0.1`);
  segments.push(`tmux send-keys -t ${sessionName}:0.2 ${shellQuote(pane3Cmd)} Enter`);
  segments.push(`tmux split-window -v -t ${sessionName}:0.0`);
  segments.push(`tmux send-keys -t ${sessionName}:0.3 ${shellQuote(pane4Cmd)} Enter`);
  segments.push(`tmux select-pane -t ${sessionName}:0.0`);
  segments.push(`tmux attach-session -t ${sessionName}`);

  return {
    ok: true,
    oneliner: segments.join(' && '),
    panes: 4,
    degraded: false,
    attachCommand: `tmux attach-session -t ${sessionName}`,
  };
}

// Public exports — wrapped with telemetry for promotion-gate criteria (#563)
export const renderDefaultLayout = withTelemetry('default', _renderDefaultLayoutInner);
export const renderDebugLayout = withTelemetry('debug', _renderDebugLayoutInner);
