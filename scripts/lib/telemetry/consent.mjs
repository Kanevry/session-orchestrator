/**
 * consent.mjs — anonymous-usage-telemetry consent layer (Epic #841, S1 / GL #842).
 *
 * Owns the persisted consent record (`~/.config/session-orchestrator/telemetry.json`)
 * and the pure `resolveConsent()` precedence machine that decides — from env vars,
 * the host-local owner.yaml fleet flag, and the stored per-user decision — whether
 * telemetry may be SENT at all.
 *
 * ── Fail-closed by design (Learning conf 0.9) ────────────────────────────────
 * The `send` bit is true ONLY when an explicitly affirmative signal is present
 * (`SO_TELEMETRY=1`, `owner.yaml telemetry.enabled === true`, or a stored
 * `consent: 'granted'`). Every ambiguous, missing, or corrupt state resolves to
 * `send: false`. "Not explicitly disabled" is NEVER treated as consent.
 *
 * ── Precedence (highest wins) ────────────────────────────────────────────────
 *   1. DO_NOT_TRACK (set, non-empty, not '0'/'false')  → disabled-env
 *   2. SO_TELEMETRY_DISABLED === '1'                    → disabled-env
 *   3. SO_TELEMETRY === '1'                             → enabled-env
 *   4. ownerConfig.telemetry.enabled === true (strict) → enabled-fleet
 *   5. state.consent === 'granted'                      → enabled-consent
 *   6. state.consent === 'denied'                       → disabled-consent
 *   7. (otherwise)                                      → no-consent
 *
 * The env pair (1/2) is the per-shell escape hatch that outranks the fleet flag
 * (PRD AC FA5): a fleet-opted host still honours `SO_TELEMETRY_DISABLED=1` /
 * `DO_NOT_TRACK` for a single shell. The fleet flag (4) intentionally outranks a
 * stored `denied` (6) — owner.yaml is the operator's host-level decision.
 *
 * No `anon_id` is ever minted here — id generation is lazy and lives in a sibling
 * module; this layer only preserves the field across read/modify/write.
 *
 * Node ESM, no external deps beyond `scripts/lib/io.mjs` (atomic write).
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { writeJsonAtomicSync } from '../io.mjs';
import { TELEMETRY_DIR, TELEMETRY_JSON_PATH, TELEMETRY_QUEUE_PATH } from './paths.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Schema version stamped into every telemetry.json record. */
export const CONSENT_SCHEMA_VERSION = 1;

// Path constants are single-sourced in ./paths.mjs — a constants-only leaf
// module that both consent.mjs (policy) and queue.mjs (storage) import, so
// neither depends on the other. Re-exported here for backward-compat: these
// were consent.mjs exports before the extraction.
export { TELEMETRY_DIR, TELEMETRY_JSON_PATH, TELEMETRY_QUEUE_PATH };

/** Consent enum stored in the record's `consent` field. */
const CONSENT_GRANTED = 'granted';
const CONSENT_DENIED = 'denied';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * A fresh default record: everything null, schema_version pinned. Returned when
 * the file is missing or corrupt so callers never see partial/garbage state.
 * @returns {{schema_version: number, consent: null, decided_at: null, anon_id: null, anon_id_created_at: null, last_flush_at: null}}
 */
function defaultRecord() {
  return {
    schema_version: CONSENT_SCHEMA_VERSION,
    consent: null,
    decided_at: null,
    anon_id: null,
    anon_id_created_at: null,
    last_flush_at: null,
  };
}

/**
 * True when an env var carries a truthy "on" signal: present, trims to a
 * non-empty string that is neither '0' nor (case-insensitively) 'false'.
 * @param {unknown} raw
 * @returns {boolean}
 */
function isTruthyEnvFlag(raw) {
  if (raw === undefined || raw === null) return false;
  const t = String(raw).trim();
  if (t === '' || t === '0') return false;
  if (t.toLowerCase() === 'false') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Read and normalise the persisted consent record. NEVER throws.
 *
 * - Missing file            → `{ source: 'default' }` + a fresh default record.
 * - Unparseable / non-object → `{ source: 'corrupt' }` + default record + a
 *   stderr WARN pointing at `telemetry status`; the errors array names the fault.
 * - Valid object            → `{ source: 'file' }`; missing known fields are
 *   filled from defaults and UNKNOWN fields are preserved (additive tolerance).
 *
 * @param {object} [opts]
 * @param {string} [opts.path]  Override the read path (test injection).
 * @returns {{ record: object, source: 'file'|'default'|'corrupt', errors: string[] }}
 */
export function readTelemetryState({ path } = {}) {
  const target = path || TELEMETRY_JSON_PATH;

  if (!existsSync(target)) {
    return { record: defaultRecord(), source: 'default', errors: [] };
  }

  let raw;
  try {
    raw = readFileSync(target, 'utf8');
  } catch (err) {
    const msg = `telemetry.json unreadable: ${err?.message ?? String(err)}`;
    console.error(`⚠ telemetry: ${msg}. Using defaults — run 'telemetry status' to inspect.`);
    return { record: defaultRecord(), source: 'corrupt', errors: [msg] };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = `telemetry.json is not valid JSON: ${err?.message ?? String(err)}`;
    console.error(`⚠ telemetry: ${msg}. Using defaults — run 'telemetry status' to inspect.`);
    return { record: defaultRecord(), source: 'corrupt', errors: [msg] };
  }

  if (!isPlainObject(parsed)) {
    const msg = `telemetry.json is not an object (got ${Array.isArray(parsed) ? 'array' : typeof parsed})`;
    console.error(`⚠ telemetry: ${msg}. Using defaults — run 'telemetry status' to inspect.`);
    return { record: defaultRecord(), source: 'corrupt', errors: [msg] };
  }

  // Additive tolerance: defaults fill missing known fields, `parsed` overrides
  // and carries any unknown fields through untouched.
  const record = { ...defaultRecord(), ...parsed };
  return { record, source: 'file', errors: [] };
}

/**
 * Atomically persist a consent record via {@link writeJsonAtomicSync}. Creates
 * the parent directory first. NEVER throws — filesystem failures are returned.
 *
 * @param {object} record  The full record to persist.
 * @param {object} [opts]
 * @param {string} [opts.path]  Override the write path (test injection).
 * @returns {{ ok: boolean, error?: string }}
 */
export function writeTelemetryState(record, { path } = {}) {
  const target = path || TELEMETRY_JSON_PATH;
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  const res = writeJsonAtomicSync(target, record);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

// ---------------------------------------------------------------------------
// Consent decision
// ---------------------------------------------------------------------------

/**
 * @typedef {'disabled-env'|'disabled-consent'|'enabled-env'|'enabled-fleet'|'enabled-consent'|'no-consent'} ConsentState
 */

/**
 * Resolve the effective telemetry posture from all signals. Pure — no I/O.
 * Fail-closed: `send` is true ONLY for the three `enabled-*` states.
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]  Env source (default process.env).
 * @param {object} [opts.ownerConfig]  Parsed owner.yaml object (fleet flag lives at `.telemetry.enabled`).
 * @param {object|null} [opts.state]    A persisted record (from {@link readTelemetryState}).
 * @param {boolean} [opts.interactive]  Whether a TTY prompt is possible right now.
 * @returns {{ state: ConsentState, send: boolean, prompt: boolean, reason: string }}
 */
export function resolveConsent({ env = process.env, ownerConfig = {}, state = null, interactive = false } = {}) {
  // 1. DO_NOT_TRACK — universal opt-out, per-shell escape above everything.
  if (isTruthyEnvFlag(env?.DO_NOT_TRACK)) {
    return { state: 'disabled-env', send: false, prompt: false, reason: 'DO_NOT_TRACK is set' };
  }

  // 2. SO_TELEMETRY_DISABLED=1 — per-shell escape, outranks SO_TELEMETRY and fleet.
  if (env?.SO_TELEMETRY_DISABLED === '1') {
    return { state: 'disabled-env', send: false, prompt: false, reason: 'SO_TELEMETRY_DISABLED=1' };
  }

  // 3. SO_TELEMETRY=1 — explicit per-shell opt-in.
  if (env?.SO_TELEMETRY === '1') {
    return { state: 'enabled-env', send: true, prompt: false, reason: 'SO_TELEMETRY=1' };
  }

  // 4. Fleet flag — owner.yaml telemetry.enabled must be STRICTLY boolean true.
  if (ownerConfig?.telemetry?.enabled === true) {
    return { state: 'enabled-fleet', send: true, prompt: false, reason: 'owner.yaml telemetry.enabled=true' };
  }

  // 5/6. Stored per-user decision.
  if (state?.consent === CONSENT_GRANTED) {
    return { state: 'enabled-consent', send: true, prompt: false, reason: 'stored consent: granted' };
  }
  if (state?.consent === CONSENT_DENIED) {
    return { state: 'disabled-consent', send: false, prompt: false, reason: 'stored consent: denied' };
  }

  // 7. No decision on record — only prompt when a TTY is available; never send.
  return {
    state: 'no-consent',
    send: false,
    prompt: interactive === true,
    reason: 'no consent decision recorded',
  };
}

/**
 * Read-modify-atomic-write helper shared by grant/deny. Preserves the anon_id
 * fields and any unknown fields already on the record; starts from a clean
 * default record when the on-disk file is missing or corrupt (no garbage merge).
 *
 * @param {'granted'|'denied'} decision
 * @param {{ path?: string, now: string }} args
 * @returns {{ ok: boolean, record: object }}
 */
function setConsentDecision(decision, { path, now }) {
  const { record } = readTelemetryState({ path });
  const next = { ...record, consent: decision, decided_at: now };
  const res = writeTelemetryState(next, { path });
  return { ok: res.ok, record: next };
}

/**
 * Record an affirmative consent decision. anon_id fields are left untouched.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]  Override the state path (test injection).
 * @param {string} [opts.now]   ISO timestamp for `decided_at` (defaults to now).
 * @returns {{ ok: boolean, record: object }}
 */
export function grantConsent({ path, now = new Date().toISOString() } = {}) {
  return setConsentDecision(CONSENT_GRANTED, { path, now });
}

/**
 * Record a refusal decision. anon_id fields are left untouched.
 *
 * @param {object} [opts]
 * @param {string} [opts.path]  Override the state path (test injection).
 * @param {string} [opts.now]   ISO timestamp for `decided_at` (defaults to now).
 * @returns {{ ok: boolean, record: object }}
 */
export function denyConsent({ path, now = new Date().toISOString() } = {}) {
  return setConsentDecision(CONSENT_DENIED, { path, now });
}

// ---------------------------------------------------------------------------
// Environment probes
// ---------------------------------------------------------------------------

/**
 * True when running in a recognised CI environment: `CI` set to a truthy value,
 * or any of the well-known CI marker vars present and non-empty.
 *
 * @param {Record<string, string|undefined>} [env]  Env source (default process.env).
 * @returns {boolean}
 */
export function isCiEnv(env = process.env) {
  if (isTruthyEnvFlag(env?.CI)) return true;
  for (const key of ['GITHUB_ACTIONS', 'GITLAB_CI', 'CONTINUOUS_INTEGRATION']) {
    const v = env?.[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') return true;
  }
  return false;
}

/**
 * True when there is no interactive TTY to prompt on: any CI environment, or a
 * stdout that is not a TTY. Fail-closed toward headless — anything that is not a
 * confirmed interactive TTY counts as headless.
 *
 * @param {Record<string, string|undefined>} [env]  Env source (default process.env).
 * @param {{ stdout?: { isTTY?: boolean } }} [streams]  Stream source (default process).
 * @returns {boolean}
 */
export function isHeadless(env = process.env, streams = process) {
  if (isCiEnv(env)) return true;
  return streams?.stdout?.isTTY !== true;
}
