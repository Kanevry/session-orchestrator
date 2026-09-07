/**
 * session-schema/constants.mjs — pure data constants for session schema.
 *
 * Extracted from scripts/lib/session-schema.mjs (W1A3 split).
 * Leaf module — no imports from siblings or parent.
 *
 * Exports: CURRENT_SESSION_SCHEMA_VERSION, SESSION_KEY_ALIASES,
 *          VALID_SESSION_TYPES, VALID_SESSION_PROFILES, REQUIRED_FIELDS,
 *          AGENT_SUMMARY_FIELDS
 */

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Current session-record schema version. New writes are stamped with this
 * value by validateSession. Records read without `schema_version` are tagged
 * as 0 (pre-versioning legacy) by normalizeSession.
 *
 * Bumped 1 -> 2 via issue #372 (2026-07-02): gate evidence — 135/135
 * production entries in .orchestrator/metrics/sessions.jsonl validate
 * cleanly against the accepted-version set in validator.mjs. The bump is
 * additive-only; no required-field or shape change accompanies it.
 */
export const CURRENT_SESSION_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Key aliases (safe renames — no value transformation)
// ---------------------------------------------------------------------------

/**
 * Safe key aliases — same-shape renames only (no value transformation).
 * Applied by normalizeSession on read so legacy records can be consumed by
 * canonical-key consumers without rewriting the file.
 *
 * Identity is frozen so callers can do strict-equality checks on the object
 * reference across re-imports.
 */
export const SESSION_KEY_ALIASES = Object.freeze({
  type: 'session_type',
  mode: 'session_type',
  closed_issues: 'issues_closed',
  new_issues: 'issues_created',
  issues_filed: 'issues_created',
  issues_planned: 'planned_issues',
  files_changed: 'total_files_changed',
  snapshots: 'snapshots_created',
  learnings: 'learnings_added',
  waves_total: 'total_waves',
  waves_completed: 'total_waves',
  head_ref: 'branch',
  isolation_override: 'isolation',
});

// ---------------------------------------------------------------------------
// Enums / required field lists
// ---------------------------------------------------------------------------

/**
 * Closed set of valid session_type values.
 *
 * `unknown` (GitLab #1234, added 2026-09-06) is NOT a fourth session MODE — it is
 * the absence of a measurement, and it exists so a reconstructed record can say
 * so instead of guessing. Measured 2026-09-06 over the 90-day fleet corpus: all
 * 1.656 `abandoned` records carry `_session_type_inferred: true` + `total_waves: 0`
 * and NO organically written `abandoned` record exists anywhere — i.e. every one
 * of them was labelled `housekeeping` by `scripts/lib/session-close-backfill.mjs`
 * because the enum left it no alternative, and that guess is what produced the
 * fleet-wide "27 % close rate" figure (the real rate is 21,3 %).
 *
 * Only `synthesizeRecord()` in `scripts/lib/session-close-backfill.mjs` writes it,
 * and only for records it also flags `_session_type_inferred` + `_synthetic`.
 * A live session never becomes `unknown`: `/session` still resolves one of the
 * three modes, and `scripts/lib/wave-sizing.mjs` (which THROWS on a fourth value)
 * is only ever fed the live type, never a ledger record.
 *
 * Known mis-bucket, out of this change's scope: `normalizeSessionType()` in
 * `scripts/lib/telemetry/schema.mjs:382` maps any non-empty unlisted value to
 * `'other'` ("something WAS measured and is not one of the three modes"), which
 * is the opposite of what `unknown` means — even though that module already
 * defines `SESSION_TYPE_UNKNOWN = 'unknown'` for its absent-branch.
 */
export const VALID_SESSION_TYPES = Object.freeze(['feature', 'deep', 'housekeeping', 'unknown']);

/**
 * CLOSED set of valid `session_profile` values — the SSOT for this enum
 * (GitLab #1252). `scripts/lib/telemetry/schema.mjs` re-exports this constant
 * rather than defining a second literal; `server/ingest/validate.mjs`
 * `SESSION_PROFILES` is a deliberate MIRROR (the server tree must not import
 * from `scripts/`) held in lockstep by `tests/telemetry/parity.test.mjs`.
 *
 * A profile names a WAVE-SHAPE variant on top of an UNCHANGED `session_type`:
 * an ultradeep session is `session_type: "deep"` PLUS
 * `session_profile: "ultradeep"` — never `session_type: "ultradeep"`.
 * PRD: docs/prd/2026-09-06-ultradeep-session-profile.md. Writer:
 * `commands/session.md` § "Argument alias: ultradeep" → STATE.md frontmatter
 * `session-profile`; wave shape: `skills/session-plan/SKILL.md`.
 *
 * DELIBERATELY NOT A MEMBER of VALID_SESSION_TYPES above: that set is consumed
 * by `scripts/lib/telemetry/schema.mjs` (an unlisted type → 'other') and by
 * `scripts/lib/wave-sizing.mjs` (an unlisted type → TypeError), where a new
 * MODE would be MISLABELLED rather than rejected. That reasoning is unchanged
 * by the `unknown` member: `unknown` is the absence of a measurement, not a
 * mode, and nothing dispatches on it.
 *
 * WHY A WHITELIST AND NOT A REGEX: the value is copied from repo-authored
 * STATE.md frontmatter, i.e. it is the only usage-ping field whose VALUE is
 * free text. Two Wave-1 reviewers reproduced the leak end-to-end (2026-09-06):
 * `session-profile: client-acme-private-repo` travelled verbatim to the ingest
 * server's `raw_json`. A shape regex does not close it — that string already
 * passes any lowercase-and-hyphens pattern. Only an enumeration of names that
 * are public BY CONSTRUCTION does. Adding a profile therefore means a reviewed
 * edit HERE and in the server mirror.
 */
export const VALID_SESSION_PROFILES = Object.freeze(['ultradeep']);

/**
 * Required fields for a schema_version=1 record. Validated by validateSession
 * before any write reaches disk.
 */
export const REQUIRED_FIELDS = Object.freeze([
  'session_id',
  'session_type',
  'started_at',
  'completed_at',
  'total_waves',
  'waves',
  'agent_summary',
  'total_agents',
  'total_files_changed',
]);

/**
 * Required numeric counters inside the agent_summary object. All must be
 * non-negative numbers.
 */
export const AGENT_SUMMARY_FIELDS = Object.freeze(['complete', 'partial', 'failed', 'spiral']);

/**
 * Optional fields — declared here so a field's status is STATED, never inferred
 * from the presence of an `if` in the validator. Seeded by the remote-agent
 * substrate (ADR-364 thin-slice) and grown additively since (#644, #724, #773,
 * #964). These are NOT in REQUIRED_FIELDS — older entries lacking them validate
 * cleanly. Validator: see `_validateOptionalFields` in validator.mjs.
 *
 * NOT YET EXHAUSTIVE. `_validateOptionalFields` additionally shape-checks
 * `discovery_stats`, `review_stats`, `platform`, `branch`, `base_branch`,
 * `notes`, `duration_seconds`, `issues_closed` and `issues_created` without
 * listing them here. Treat membership as "declared optional", never absence as
 * "not a known field" — see the #964 follow-up note in the session report.
 */
export const OPTIONAL_FIELDS = Object.freeze([
  'agent_identity',
  'worktree_path',
  'parent_run_id',
  'lease_acquired_at',
  'lease_ttl_seconds',
  'expected_cost_tier',
  // Epic #644 — session-level token rollup fields (additive, v1-compatible).
  'total_token_input',
  'total_token_output',
  'subagents_with_tokens',
  // Epic #724 C1 — SessionEnd close-through backfill provenance fields.
  // `status` distinguishes normally-closed ('completed') from hook-backfilled
  // ('abandoned') records. The `_backfill_*` markers record how a stub was
  // synthesized when a session terminated without running /close. All are
  // additive-optional: pre-#724 records lacking them validate cleanly.
  'status',
  '_backfill_source',
  '_backfill_incomplete_fields',
  '_session_type_inferred',
  '_synthetic_session_id',
  // #773 — Handover-Alignment-Gate telemetry (additive, v1-compatible).
  // Non-negative integers; absent = gate did not run / not measured.
  'open_questions_asked',
  'open_questions_answered',
  'open_questions_deferred',
  // #964 — `effectiveness` was shape-checked by `_validateOptionalFields` while
  // appearing in NEITHER list, so its status could only be inferred from an
  // `if`. It is OPTIONAL on the write path and stays that way: making it
  // required would retroactively invalidate the 10 existing records that lack
  // it, plus every `abandoned` stub the SessionEnd backfill (#724 C1) will ever
  // write. It is REQUIRED by the vault-mirror v1 renderer
  // (`RENDERABLE_SESSION_FIELDS_V1`, scripts/lib/vault-mirror/render-sessions.mjs)
  // — that is a strictly stronger, deliberately separate contract: "renderable
  // into a note a human reads" ⊃ "schema-valid". A record missing it is a clean
  // vault-mirror skip, NOT a malformed record.
  'effectiveness',
  // `session_profile` — a WAVE-SHAPE variant on top of an unchanged
  // `session_type`. Additive and optional on purpose: every historical record
  // lacking the field validates unchanged. Value set + the full rationale for
  // why it is NOT a VALID_SESSION_TYPES member: VALID_SESSION_PROFILES above.
  'session_profile',
]);
