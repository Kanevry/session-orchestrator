/**
 * session-schema.mjs — canonical schema lock for sessions.jsonl entries.
 *
 * Issues #249, #304. Companion to `scripts/lib/learnings.mjs`. Plain-JS
 * validator + normalizer for session records written to
 * `.orchestrator/metrics/sessions.jsonl`. No Zod — plain-JS matches the
 * repo convention for script-layer utilities.
 *
 * ── CANONICAL SCHEMA (schema_version: 1) ─────────────────────────────────
 *
 * Two historical shapes coexist in sessions.jsonl on disk (#304: 73% of
 * records were mirror-invalid before the migration helper shipped):
 *
 *   OLD SHAPE (pre-v3, schema_version: 0 or absent):
 *     agents_dispatched   number   — total agents scheduled (scalar)
 *     agents_complete     number   — succeeded
 *     agents_partial      number   — partial success
 *     agents_failed       number   — failed
 *     waves_completed     number   — scalar wave count (no array)
 *
 *   NEW SHAPE (v3+, schema_version: 1) — THIS IS THE CANONICAL SHAPE:
 *     total_agents        number   — sum of all dispatched agents
 *     total_files_changed number   — total files touched across all waves
 *     agent_summary       object   — { complete, partial, failed, spiral }
 *     waves               array    — [{ wave, role, ...waveMetrics }]
 *
 * Required fields for a valid schema_version=1 record:
 *   session_id, session_type, started_at, completed_at,
 *   total_waves, waves, agent_summary, total_agents, total_files_changed
 *
 * Migration: `scripts/migrate-sessions-jsonl.mjs` maps old → new shape.
 * Backfill (apply to entire file): `scripts/backfill-sessions.mjs`.
 *
 * ── CONTRACT SUMMARY ─────────────────────────────────────────────────────
 *
 *   validateSession(entry):
 *     Throws ValidationError on required-field/type/range violations.
 *     Returns a NEW object with `schema_version` stamped to
 *     CURRENT_SESSION_SCHEMA_VERSION (1) if absent. Unknown fields pass
 *     through (additive contract). Does NOT apply SESSION_KEY_ALIASES.
 *     Used by scripts/emit-session.mjs as the write-path gate — any entry
 *     that fails validation is rejected before it reaches disk.
 *
 *   normalizeSession(entry):
 *     Never throws. Applies SAFE key aliases (same-shape renames only).
 *     Missing `schema_version` on read is tagged as 0 (pre-versioning
 *     legacy, distinct from CURRENT_SESSION_SCHEMA_VERSION=1 stamped on
 *     new writes). Emits a deduplicated WARN per session_id per process.
 *
 * Unsafe value-transforming aliases (e.g., `waves_executed` scalar →
 * `waves` array, `duration_min` → `duration_seconds`) are explicitly OUT
 * of scope here and belong in the migration / backfill scripts.
 *
 * ── MODULE STRUCTURE ─────────────────────────────────────────────────────
 *
 * This file is a thin barrel. All logic lives in submodules:
 *   session-schema/constants.mjs  — CURRENT_SESSION_SCHEMA_VERSION,
 *                                   SESSION_KEY_ALIASES, VALID_SESSION_TYPES,
 *                                   REQUIRED_FIELDS, AGENT_SUMMARY_FIELDS
 *   session-schema/validator.mjs  — ValidationError, validateSession
 *   session-schema/normalizer.mjs — normalizeSession
 *   session-schema/timestamps.mjs — clampTimestampsMonotonic
 *   session-schema/aliases.mjs    — aliasLegacyEndedAt
 */

export { CURRENT_SESSION_SCHEMA_VERSION, SESSION_KEY_ALIASES } from './session-schema/constants.mjs';
export { ValidationError, validateSession } from './session-schema/validator.mjs';
export { normalizeSession } from './session-schema/normalizer.mjs';
export { clampTimestampsMonotonic } from './session-schema/timestamps.mjs';
export { aliasLegacyEndedAt } from './session-schema/aliases.mjs';
