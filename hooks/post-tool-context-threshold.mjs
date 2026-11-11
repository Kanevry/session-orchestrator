#!/usr/bin/env node
/**
 * post-tool-context-threshold.mjs — PostToolUse hook: context threshold for
 * every session (#1960).
 *
 * Build sessions grow in bursts and had no context limit (one reached 844k
 * after 80 minutes). This hook reads the session's OWN context from its
 * transcript (`transcript_path` of the payload — never derived from the repo
 * path, the transcript dir follows the cwd) and injects one `additionalContext`
 * hint per level:
 *   prepare-k  (default 700): „Kontext 700k: Übergabe-Datei vorbereiten, keine neue Welle mehr beginnen.“
 *   handover-k (default 800): „Kontext 800k: am nächsten MR-Schnitt übergeben.“
 *
 * Why PostToolUse: it is the only frequent event that supports
 * `additionalContext`, so the hint lands in the turn that crossed the line.
 * The read is a bounded tail-read (scripts/lib/context-threshold.mjs
 * `TAIL_STEPS`), never the whole transcript.
 *
 * Decision flow:
 *   1. shouldRunHook gate (SO_HOOK_PROFILE / SO_DISABLED_HOOKS).
 *   2. stdin payload; no `session_id` → silent (no key for the once-marker);
 *      a non-empty `agent_id` (subagent call) → silent, marker untouched.
 *   3. Session Config `context-threshold` (CLAUDE.md / AGENTS.md); `enabled: false` → silent.
 *   4. Measure. Unmeasurable → silent for this call, NO marker written.
 *   5. decideHints() against the per-session marker; write the marker only
 *      when the fired set changed; print the hint(s).
 *
 * Exit codes: 0 always — fail-open on its own errors with one stderr line.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { getProjectDir } from '../scripts/lib/platform.mjs';
import { _parseContextThreshold } from '../scripts/lib/config/context-threshold.mjs';
import {
  decideHints,
  hintText,
  markerPath,
  measureContext,
  readMarker,
  writeMarker,
} from '../scripts/lib/context-threshold.mjs';

/**
 * Read stdin to EOF (best-effort). Returns parsed JSON or null on failure.
 * @returns {Promise<object|null>}
 */
function readStdinJson() {
  return new Promise((resolve) => {
    if (process.stdin.readableEnded || process.stdin.closed) {
      resolve(null);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => { resolve(null); }, 5_000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      const raw = chunks.join('').trim();
      if (!raw) { resolve(null); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(null); });
    process.stdin.resume();
  });
}

/**
 * `context-threshold.*` from CLAUDE.md, else AGENTS.md, else parser defaults.
 * @returns {Promise<ReturnType<typeof _parseContextThreshold>>}
 */
async function loadConfig() {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      return _parseContextThreshold(await fsp.readFile(path.join(getProjectDir(), name), 'utf8'));
    } catch {
      // missing or unreadable — try next candidate
    }
  }
  return _parseContextThreshold('');
}

async function main() {
  const input = await readStdinJson();
  if (!input) return;
  const sessionId = typeof input.session_id === 'string' && input.session_id.length > 0 ? input.session_id : null;
  if (!sessionId) return;
  // A subagent's tool calls carry the coordinator's session_id AND
  // transcript_path; `agent_id` is the only discriminator (see
  // hooks/subagent-telemetry.mjs, hooks/_lib/subagent-paths.mjs). The hint is
  // the coordinator's: a subagent call must neither receive it nor spend the
  // once-marker — no measurement, no marker, no output.
  if (typeof input.agent_id === 'string' && input.agent_id.length > 0) return;

  const config = await loadConfig();
  if (config.enabled === false) return;
  const prepareK = config['prepare-k'];
  const handoverK = config['handover-k'];

  const m = measureContext(input.transcript_path);
  if (m.status !== 'measured') return; // nicht messbar: silent, no marker

  const transcriptPath = /** @type {string} */ (input.transcript_path);
  const file = markerPath(sessionId);
  const fired = readMarker(file, { sessionId, transcriptPath });
  const decision = decideHints({ tokens: m.tokens, prepareK, handoverK, fired });

  if (decision.changed) {
    writeMarker(file, { sessionId, transcriptPath, fired: decision.fired, tokens: m.tokens });
  }
  if (decision.hints.length === 0) return;

  const text = decision.hints.map((lvl) => hintText(lvl, m.tokens, { prepareK, handoverK })).join(' ');
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text },
  }));
}

// Entry guard (#1393): run only as the node script the harness execs.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook('post-tool-context-threshold')) process.exit(0);
  main()
    .catch((err) => {
      process.stderr.write(`post-tool-context-threshold: skipped (${err?.code ?? err?.message ?? 'error'})\n`);
    })
    .finally(() => process.exit(0));
}
