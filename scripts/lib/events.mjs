/**
 * events.mjs — JSONL event emission + optional webhook POST for session-orchestrator.
 *
 * Replaces scripts/lib/events.sh. Windows-safe (no hardcoded path separators).
 * Uses native fetch (Node 20+) and fs.promises — no external dependencies.
 *
 * Part of v3.0.0 migration (Epic #124, issue #133).
 * Issue #228: removed hardcoded personal-domain default URL. Clank Event Bus URL
 * must now be supplied explicitly via CLANK_EVENT_URL when CLANK_EVENT_SECRET is set.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SO_PROJECT_DIR, SO_SHARED_DIR } from './platform.mjs';
import { readLock } from './session-lock.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to `.orchestrator/metrics/events.jsonl` under `repoRoot`.
 *
 * `repoRoot` defaults to the module-level `SO_PROJECT_DIR` constant, so the
 * zero-arg call is unchanged for every existing caller (#941). Pass an explicit
 * `repoRoot` when the destination must be pinned to a tree other than the
 * CWD/env-resolved project — e.g. a unit test running the gate against a tmp
 * repo, which must NOT append synthetic records to the real fleet telemetry.
 *
 * @param {string} [repoRoot=SO_PROJECT_DIR] — project root the events log lives under.
 * @returns {string}
 */
export function eventsFilePath(repoRoot = SO_PROJECT_DIR) {
  return path.join(repoRoot, SO_SHARED_DIR, 'metrics', 'events.jsonl');
}

/**
 * Session attribution for gate/lifecycle telemetry (#928a, hoisted here #941).
 *
 * The natural shared home the two former call-site copies (`quality-gate.mjs`,
 * `run-quality-gate.mjs`) both named. Emits BOTH the UUID `session_id` and the
 * `semantic_session_id`, mirroring the field shape of
 * `orchestrator.session.lock.acquired` so gate events join against the same keys
 * existing consumers already read (see `session-close-backfill.mjs`).
 *
 * Without a lock (CI runs have none) BOTH keys are OMITTED rather than filled
 * with a placeholder: a fabricated id would silently collide across every
 * unattributed run and read as a real session; an empty string would satisfy a
 * truthiness check while attributing to nothing. An absent key is the only
 * honest encoding of "not attributable".
 *
 * @param {string} [repoRoot] — repo whose `session.lock` is read for attribution.
 * @returns {{session_id?: string, semantic_session_id?: string}}
 */
export function sessionAttribution(repoRoot) {
  try {
    const lock = readLock({ repoRoot });
    if (!lock) return {};
    const out = {};
    if (typeof lock.session_id === 'string' && lock.session_id.trim()) {
      out.session_id = lock.session_id;
    }
    if (typeof lock.semantic_session_id === 'string' && lock.semantic_session_id.trim()) {
      out.semantic_session_id = lock.semantic_session_id;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Append a JSONL event record and optionally POST to the Clank Event Bus webhook.
 *
 * Writes `{ts, event, ...payload}` as a single JSON line to
 * `.orchestrator/metrics/events.jsonl` (creates parent directory if needed).
 * If both `CLANK_EVENT_SECRET` and `CLANK_EVENT_URL` are set, fires an async
 * fire-and-forget POST to `CLANK_EVENT_URL` with a 3-second timeout. Network
 * errors are swallowed. Write errors propagate to the caller. No personal-domain
 * default URL exists — both vars must be set explicitly (#228).
 *
 * @param {string} type — event type (e.g. "orchestrator.session.started")
 * @param {object} [payload={}] — additional fields shallow-merged into the record
 * @param {object} [opts={}] — emission options.
 * @param {string} [opts.filePath] — override the destination JSONL path. Defaults
 *   to `eventsFilePath()` (the project's `.orchestrator/metrics/events.jsonl`).
 *   Used by `scripts/emit-event.mjs --file` so shell callers (e.g.
 *   compute-grounding-injection.sh) can target a pre-resolved EVENTS_JSONL path
 *   without depending on platform.mjs CWD/env resolution (#611).
 * @param {string} [opts.repoRoot] — pin the destination to `<repoRoot>/.orchestrator/
 *   metrics/events.jsonl` instead of the module-level `SO_PROJECT_DIR` default
 *   (#941). Ignored when `opts.filePath` is given (explicit path wins). This is
 *   the clean interface replacing the hand-built `join(repoRoot, …)` recipes that
 *   used to open-code this destination at each call-site.
 * @returns {Promise<void>}
 */
export async function emitEvent(type, payload = {}, opts = {}) {
  // Build the JSONL record: ts + event come first, payload spreads last.
  const record = { timestamp: new Date().toISOString(), event: type, ...payload };
  const line = JSON.stringify(record) + '\n';

  // Ensure the destination directory exists before appending. Resolution order:
  //   1. explicit opts.filePath (a pre-resolved path — #611)
  //   2. opts.repoRoot → <repoRoot>/.orchestrator/metrics/events.jsonl (#941)
  //   3. the SO_PROJECT_DIR default (unchanged for 2-arg callers)
  // eventsFilePath(undefined) falls through to its SO_PROJECT_DIR default param,
  // so a caller passing neither behaves EXACTLY as before (additive).
  const filePath = opts.filePath ?? eventsFilePath(opts.repoRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line, 'utf8');

  // Fire-and-forget webhook POST — only when secret AND URL are configured.
  // No personal-domain default: CLANK_EVENT_URL must be set explicitly (#228).
  if (process.env.CLANK_EVENT_SECRET && process.env.CLANK_EVENT_URL) {
    const url = process.env.CLANK_EVENT_URL;
    const body = JSON.stringify({
      event_type: type,
      source: 'session-orchestrator',
      payload,
    });

    fetch(`${url}/api/webhooks/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CLANK_EVENT_SECRET}`,
      },
      body,
      signal: AbortSignal.timeout(3000),
    }).catch(() => {});
  }
}
