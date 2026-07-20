/**
 * telemetry/sync.mjs — batch build + offline-tolerant sync for anonymous usage
 * telemetry (Epic #841, Issue #844 / S3 FA3; PRD
 * docs/prd/2026-07-20-anonymous-usage-telemetry.md §3-FA3).
 *
 * This module is the SEND path. It ties together the W2 primitives:
 *   - consent.mjs  — resolveConsent (the outermost gate), telemetry.json read/write
 *   - schema.mjs   — buildUsagePing + projectUsagePing (whitelist projection)
 *   - anon-id.mjs  — ensureAnonId (lazy mint + 90-day rotation)
 *   - queue.mjs    — the bounded NDJSON offline queue
 *
 * ── Outermost-seam gating (load-bearing privacy invariant) ───────────────────
 * `resolveConsent()` is the FIRST statement of `flush()`. When it returns
 * `send !== true` the function returns immediately — nothing below the gate is
 * reachable: no fetch, no queue write, and NO anon-ID minting. The anon-ID is
 * minted lazily inside `buildBatch()`, which `flush()` calls ONLY after the gate
 * has passed. This makes "no ID exists until an affirmative-consent send is
 * actually attempted" a structural guarantee, not a discipline.
 *
 * ── Fire-and-forget, never-throw ─────────────────────────────────────────────
 * A flush never throws and never blocks a session beyond the POST timeout. On
 * any send failure (network, timeout, non-2xx) the batch lands in the host-local
 * queue (bounded, oldest-dropped) and the session closes with zero user-facing
 * error.
 *
 * Node ESM. The only network dependency is the global `fetch`.
 */

import path from 'node:path';

import {
  resolveConsent,
  readTelemetryState,
  writeTelemetryState,
  TELEMETRY_JSON_PATH,
} from './consent.mjs';
import { buildUsagePing, projectUsagePing } from './schema.mjs';
import { ensureAnonId } from './anon-id.mjs';
import { peekAll, enqueue, clear, queueStats } from './queue.mjs';
import { loadOwnerConfig } from '../owner-yaml.mjs';
import { readJsonlFile } from '../io.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Public ingest endpoint. Overridable per-process via SO_TELEMETRY_ENDPOINT (tests/staging). */
export const TELEMETRY_ENDPOINT = 'https://telemetry.session-orchestrator.com/v1/records';

/** Fire-and-forget POST timeout (ms). */
export const POST_TIMEOUT_MS = 3000;

/** Daily-fallback horizon: only flush a backlog older than this. */
const DAILY_FLUSH_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve the effective ingest endpoint (env override wins). */
function resolveEndpoint(env) {
  const override = (env?.SO_TELEMETRY_ENDPOINT || '').trim();
  return override || TELEMETRY_ENDPOINT;
}

/**
 * The default network sender: one POST carrying the whole batch array as the
 * JSON body (the server accepts arrays), with an AbortSignal timeout. Resolves
 * on a 2xx status, rejects on anything else (which routes the caller into the
 * offline queue).
 *
 * @param {object} opts
 * @param {NodeJS.ProcessEnv} opts.env
 * @param {number} opts.timeoutMs
 * @returns {(batches: object[]) => Promise<void>}
 */
function defaultSender({ env, timeoutMs }) {
  const endpoint = resolveEndpoint(env);
  return async (batches) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batches),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`telemetry endpoint returned HTTP ${res.status}`);
    }
  };
}

// ---------------------------------------------------------------------------
// Batch build
// ---------------------------------------------------------------------------

/**
 * Build ONE whitelist-projected usage-ping record from the local JSONL streams.
 *
 * Reads `<metricsDir>/sessions.jsonl` + `<metricsDir>/skill-invocations.jsonl`
 * (metricsDir defaults to `<cwd>/.orchestrator/metrics`). The LAST sessions.jsonl
 * record defines the session window: skill-invocations whose `timestamp >=` its
 * `started_at` are included. When no session record exists, the ping falls back
 * to `session_type: 'other'`, `duration_bucket: '<15m'`, and the invocations of
 * the last 24 hours.
 *
 * anon-ID handling (persist=true, the send path): `ensureAnonId` runs on the
 * telemetry.json record; a created/rotated ID is persisted via
 * `writeTelemetryState`. With `persist=false` (the CLI `show` preview) NOTHING is
 * minted or written — an existing ID is echoed, otherwise a placeholder string is
 * shown. This preserves the lazy-ID invariant even for `show`.
 *
 * INVARIANT: `flush()` calls this ONLY after the consent gate has passed, so the
 * (persisting) anon-ID mint is never reachable under `send !== true`.
 *
 * Never throws — an internal failure returns `{ record: null, reason }`.
 *
 * @param {object} [opts]
 * @param {string} [opts.metricsDir]       Metrics dir (default `<cwd>/.orchestrator/metrics`).
 * @param {NodeJS.ProcessEnv} [opts.env]   Env source (default process.env).
 * @param {object} [opts.ownerConfig]      Parsed owner.yaml (default: loaded here).
 * @param {{skills: Set<string>, commands: Set<string>}} [opts.roster] Roster (default: loaded by schema).
 * @param {string} [opts.now]              ISO timestamp for sent_at + rotation clock.
 * @param {string} [opts.statePath]        telemetry.json path override (test injection).
 * @param {boolean} [opts.persist=true]    Mint+persist the anon-ID (false ⇒ preview only).
 * @returns {{ record: object|null, reason?: string }}
 */
export function buildBatch({
  metricsDir,
  env = process.env,
  ownerConfig,
  roster,
  now,
  statePath,
  persist = true,
} = {}) {
  try {
    const dir = metricsDir || path.join(process.cwd(), '.orchestrator', 'metrics');
    const nowIso = now || new Date().toISOString();

    const sessions = readJsonlFile(path.join(dir, 'sessions.jsonl'), { skipInvalid: true });
    const invocations = readJsonlFile(path.join(dir, 'skill-invocations.jsonl'), { skipInvalid: true });

    const sessionRecord = sessions.length > 0 ? sessions[sessions.length - 1] : null;

    let windowInvocations;
    let sessionForPing;
    if (sessionRecord && typeof sessionRecord.started_at === 'string' && !Number.isNaN(Date.parse(sessionRecord.started_at))) {
      const startMs = Date.parse(sessionRecord.started_at);
      windowInvocations = invocations.filter((rec) => {
        const t = Date.parse(rec?.timestamp);
        return !Number.isNaN(t) && t >= startMs;
      });
      sessionForPing = sessionRecord;
    } else {
      // No usable session record → 24h window + synthetic session (schema
      // fallbacks yield session_type 'other' / duration_bucket '<15m').
      const cutoff = (Number.isNaN(Date.parse(nowIso)) ? Date.now() : Date.parse(nowIso)) - DAILY_FLUSH_MS;
      windowInvocations = invocations.filter((rec) => {
        const t = Date.parse(rec?.timestamp);
        return !Number.isNaN(t) && t >= cutoff;
      });
      sessionForPing = {};
    }

    const cfg = ownerConfig ?? loadOwnerConfig().config;

    const ping = buildUsagePing({
      sessionRecord: sessionForPing,
      skillInvocations: windowInvocations,
      ownerConfig: cfg,
      env,
      now: nowIso,
      roster,
    });

    const target = statePath || TELEMETRY_JSON_PATH;
    const { record: stateRecord } = readTelemetryState({ path: target });

    if (persist) {
      const { record: nextState, anon_id, created, rotated } = ensureAnonId(stateRecord, { now: nowIso });
      if (created || rotated) {
        writeTelemetryState(nextState, { path: target });
      }
      ping.anon_id = anon_id;
    } else {
      ping.anon_id =
        typeof stateRecord.anon_id === 'string' && stateRecord.anon_id.trim() !== ''
          ? stateRecord.anon_id
          : '(generated on first send)';
    }

    return { record: projectUsagePing(ping) };
  } catch (err) {
    return { record: null, reason: `build-error: ${err?.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

/**
 * Attempt to flush telemetry: gate on consent, build the batch, drain the
 * offline queue together with the new record in ONE send, and empty the queue on
 * success. Never throws, never blocks beyond `timeoutMs`.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]   Env source (default process.env).
 * @param {number} [opts.timeoutMs]        POST timeout (default POST_TIMEOUT_MS).
 * @param {(batches: object[]) => Promise<void>} [opts.sender] Injected sender (default: network POST).
 * @param {string} [opts.metricsDir]       Metrics dir override.
 * @param {string} [opts.statePath]        telemetry.json path override.
 * @param {string} [opts.queuePath]        queue path override.
 * @param {string} [opts.now]              ISO timestamp (sent_at, last_flush_at, rotation clock).
 * @param {object} [opts.ownerConfig]      Parsed owner.yaml (default: loaded here). Inject to
 *                                         isolate a test from the host's real owner.yaml fleet flag.
 * @returns {Promise<{ sent: boolean, queued: boolean, state: string, reason: string }>}
 */
export async function flush({
  env = process.env,
  timeoutMs = POST_TIMEOUT_MS,
  sender,
  metricsDir,
  statePath,
  queuePath,
  now,
  ownerConfig,
} = {}) {
  // Resolve owner.yaml once (injectable for hermetic tests). loadOwnerConfig reads the host's
  // real owner.yaml — a test asserting "consent absent" MUST inject {} or a real fleet flag
  // (telemetry.enabled: true) legitimately flips send=true.
  const cfg = ownerConfig ?? loadOwnerConfig().config;

  // OUTERMOST SEAM — the consent gate is the FIRST statement. When send !== true
  // nothing below (no fetch, no queue write, no anon-ID mint) is reachable.
  const consent = resolveConsent({
    env,
    ownerConfig: cfg,
    state: readTelemetryState({ path: statePath }).record,
    interactive: false,
  });
  if (consent.send !== true) {
    return { sent: false, queued: false, state: consent.state, reason: 'gated' };
  }

  const nowIso = now || new Date().toISOString();

  // Build the batch (this lazily mints + persists the anon-ID — only reachable
  // here, i.e. strictly after the gate).
  const { record, reason } = buildBatch({ metricsDir, env, ownerConfig: cfg, statePath, now: nowIso });
  if (!record) {
    return { sent: false, queued: false, state: consent.state, reason: reason || 'no-record' };
  }

  // Debug seam: print the exact payload, send nothing.
  if (env?.SO_TELEMETRY_DEBUG === '1') {
    process.stderr.write(`${JSON.stringify(record)}\n`);
    return { sent: false, queued: false, state: consent.state, reason: 'debug' };
  }

  // Drain the existing queue together with the new record in ONE send.
  const queuedBatches = peekAll({ path: queuePath }).map((entry) => entry.batch);
  const batches = [...queuedBatches, record];

  const send = typeof sender === 'function' ? sender : defaultSender({ env, timeoutMs });

  try {
    await send(batches);
  } catch {
    // Send failed → only the NEW record joins the queue (queued batches remain
    // in place since the queue was not cleared).
    enqueue(record, { path: queuePath, now: nowIso });
    return { sent: false, queued: true, state: consent.state, reason: 'queued' };
  }

  // 2xx → empty the queue and stamp last_flush_at (preserving the anon-ID that
  // buildBatch may have just persisted).
  clear({ path: queuePath });
  const { record: freshState } = readTelemetryState({ path: statePath });
  writeTelemetryState({ ...freshState, last_flush_at: nowIso }, { path: statePath });

  return { sent: true, queued: false, state: consent.state, reason: 'sent' };
}

// ---------------------------------------------------------------------------
// Daily-fallback predicate
// ---------------------------------------------------------------------------

/**
 * Whether a daily-fallback flush is due: the queue is non-empty AND more than 24h
 * have passed since the last successful flush (a never-flushed queue with items
 * counts as due). Cheap — a single telemetry.json read + a queue stat. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.statePath]  telemetry.json path override.
 * @param {string} [opts.queuePath]  queue path override.
 * @param {number} [opts.now]        Reference time in epoch-ms (default Date.now()).
 * @returns {boolean}
 */
export function shouldDailyFlush({ statePath, queuePath, now = Date.now() } = {}) {
  try {
    const { count } = queueStats({ path: queuePath });
    if (count <= 0) return false;

    const { record } = readTelemetryState({ path: statePath });
    const raw = record?.last_flush_at;
    const lastMs = typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? Date.parse(raw) : 0;
    return now - lastMs > DAILY_FLUSH_MS;
  } catch {
    return false;
  }
}
