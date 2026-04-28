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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the absolute path to .orchestrator/metrics/events.jsonl in the project root.
 * @returns {string}
 */
export function eventsFilePath() {
  return path.join(SO_PROJECT_DIR, SO_SHARED_DIR, 'metrics', 'events.jsonl');
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
 * @returns {Promise<void>}
 */
export async function emitEvent(type, payload = {}) {
  // Build the JSONL record: ts + event come first, payload spreads last.
  const record = { timestamp: new Date().toISOString(), event: type, ...payload };
  const line = JSON.stringify(record) + '\n';

  // Ensure .orchestrator/metrics/ exists before appending.
  const filePath = eventsFilePath();
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
