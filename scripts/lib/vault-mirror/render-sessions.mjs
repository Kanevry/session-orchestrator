/**
 * render-sessions.mjs — Session markdown generators for vault-mirror (Issue #283 split).
 *
 * Exports: detectSessionSchema, normalizeSessionEntry, generateSessionNote, generateSessionNoteV2, generateSessionNoteV3
 *
 * #732: all three generators accept `options.repoNs` (the leak-guarded /
 * pseudonym-mapped namespace segment from resolveRepoNamespace(), threaded
 * through by process.mjs::processSession) and emit it as a `source-repo:`
 * frontmatter line — mirroring render-learnings.mjs's `source-repo` field.
 * Prior to #732, session notes emitted a raw `repo:` field sourced directly
 * from deriveRepo() (bypassing the leak-guard entirely, even though the write
 * PATH already used resolveRepoNamespace()). Historical notes on disk may still
 * carry the legacy `repo:` key — the vault frontmatter Zod schema tolerates it
 * via `.passthrough()`, and it is NOT rewritten retroactively by this change.
 */

import { toDate, buildTag, slugifyIdSafe } from './utils.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

/**
 * Placeholders for an ABSENT optional field (session-reviewer M1).
 *
 * These are the tokens the v2/v3 generators already use — `'?'` inside a wave
 * table cell (generateSessionNoteV2's wave rows), `'n/a'` in a prose bullet
 * (both v2 and v3). The v1 generator predates both guards and interpolated the
 * same optional fields raw, so any record lacking one wrote the literal string
 * `undefined` into a vault note a human reads.
 *
 * ── ABSENT IS NOT ZERO ─────────────────────────────────────────────────────
 *
 * Every use site must apply these with `??`, NEVER `||`. A wave that genuinely
 * changed 0 files, or dispatched 0 agents, has a MEASURED zero and must render
 * `0`; only a field the producer never wrote is unknown. `||` collapses that
 * distinction (`0 || '?'` → `'?'`, asserting "unknown" about a real
 * measurement); `??` preserves it (`0 ?? '?'` → `0`).
 */
const MISSING_CELL = '?';
const MISSING_VALUE = 'n/a';

/**
 * Render the `**Duration:**` bullet value for all three generators (#969 LOW-1).
 *
 * All three sites used to read `Math.round((duration_seconds ?? 0) / 60)`, three
 * lines that violated the banner directly above them: neither `duration_minutes`
 * nor `duration_seconds` is in ANY of the `RENDERABLE_SESSION_FIELDS_*` lists,
 * so absence is reachable, and a record lacking both rendered `Duration: 0m` —
 * a claimed MEASURED zero, contradicted on the same line by its own
 * `started_at → completed_at` span, and sitting beside correctly-rendered `n/a`s.
 * "0m" reads as a verified fact; that is the more damaging direction.
 *
 * The whole chain is `??`, never `||`, so a genuinely measured zero survives:
 * `duration_minutes: 0` renders `0m`, and so does `duration_seconds: 0`
 * (`Math.round(0 / 60)` is `0`, and `0 ?? x` is `0`). Only a field the producer
 * never wrote becomes `MISSING_VALUE`. The suffix is applied HERE rather than at
 * the call sites, because `${MISSING_VALUE}m` would render `n/am`.
 *
 * @param {unknown} durationSeconds — v1/v2/v3 `duration_seconds`.
 * @param {unknown} [durationMinutes] — v3 `duration_minutes`; WINS when both are
 *   present, preserving v3's original precedence.
 * @returns {string} e.g. `'42m'`, `'0m'`, or `'n/a'`.
 */
function renderDuration(durationSeconds, durationMinutes) {
  const fromSeconds =
    durationSeconds === undefined || durationSeconds === null
      ? undefined
      : Math.round(durationSeconds / 60);
  const minutes = durationMinutes ?? fromSeconds;
  return minutes === undefined || minutes === null ? MISSING_VALUE : `${minutes}m`;
}

/**
 * ── RENDERABLE ⊋ SCHEMA-VALID (#964) ───────────────────────────────────────
 *
 * Each generator gates on its own required-field list. Before #964 all three
 * lists were function-local `const`s with no stated relationship to
 * `REQUIRED_FIELDS` (scripts/lib/session-schema/constants.mjs) — the write-path
 * schema — which made five independent notions of "a valid session record" in
 * one codebase, drifting silently. They are lifted here, exported, and pinned
 * against `REQUIRED_FIELDS` by a mechanical superset test in
 * tests/lib/vault-mirror/render-sessions.test.mjs.
 *
 * The relationship is deliberately asymmetric, not a duplicate:
 *
 *   `REQUIRED_FIELDS`  — "this record is well-formed". The writer
 *     (scripts/emit-session.mjs) REFUSES a record that fails it.
 *   these lists        — "this record renders into a note a human can read".
 *     vault-mirror SKIPS a record that fails them; the record stays valid.
 *
 * Collapsing the two would destroy that distinction. Hence `effectiveness`:
 * optional to the writer (a record lacking it is fine), required by the v1
 * renderer (a note reading `planned=n/a, completed=n/a, carryover=n/a,
 * rate=n/a` is worse than no note — indistinguishable from a real session whose
 * metrics happened to be absent).
 *
 * The predicate here is VALUE presence (`null`/`undefined` both fail); the
 * validator's is KEY presence. See `_validateRequiredFields` for why.
 */

/**
 * v1 — the only generator reachable from a write-path-valid record (measured:
 * 205/205 live ledger records at HEAD 730ee9d route v1). Its list is
 * `REQUIRED_FIELDS` plus `effectiveness`, i.e. a strict superset.
 */
export const RENDERABLE_SESSION_FIELDS_V1 = Object.freeze([
  'session_id',
  'session_type',
  'started_at',
  'completed_at',
  'total_waves',
  'total_agents',
  'total_files_changed',
  'agent_summary',
  'waves',
  'effectiveness',
]);

/**
 * v2 — legacy S69+ producer shape. Requires FEWER fields than `REQUIRED_FIELDS`
 * (no `total_waves`/`total_agents`/`total_files_changed`/`agent_summary`)
 * because it DERIVES every one of them from the wave array, and carries the
 * file count as top-level `files_changed` — the alias `SESSION_KEY_ALIASES`
 * maps to `total_files_changed` on read.
 *
 * That shortfall is an EARNED carve-out from the superset rule, not an
 * oversight: `detectSessionSchema` routes to v2 only when
 * `total_agents === undefined`, and `validateSession` rejects exactly that
 * (missing key, or present-but-not-a-number). No record can satisfy both. The
 * test asserts the disjointness rather than trusting this comment.
 */
export const RENDERABLE_SESSION_FIELDS_V2 = Object.freeze([
  'session_id',
  'session_type',
  'started_at',
  'completed_at',
  'waves',
  'files_changed',
  'effectiveness',
]);

/**
 * v3 — coordinator-direct shape with SCALAR `waves`. Same earned carve-out as
 * v2, from a sharper contradiction: `_validateWaves` throws unless
 * `Array.isArray(entry.waves)`, `generateSessionNoteV3` throws unless
 * `typeof entry.waves === 'number'`. A value cannot be both, so no record can
 * satisfy both contracts — v3 is unreachable from the sanctioned writer by
 * construction, and measurement agrees (0/205).
 */
export const RENDERABLE_SESSION_FIELDS_V3 = Object.freeze([
  'session_id',
  'session_type',
  'started_at',
  'completed_at',
  'waves',
  'effectiveness',
]);

/**
 * Session-ledger status → vault-frontmatter status mapping (#909).
 *
 * ── WHY A MAPPING AND NOT A PASS-THROUGH ───────────────────────────────────
 *
 * The two value ranges are DISJOINT:
 *
 *   `sessions.jsonl` `status` — `completed` | `abandoned`, or absent/null on
 *     every pre-#724 record (SESSION_STATUS, scripts/lib/session-schema/validator.mjs).
 *   vault frontmatter `status` — `draft` | `active` | `verified` | `archived` |
 *     `production` | `mvp` | `idea` (vaultNoteStatusSchema, skills/vault-sync/validator.mjs).
 *
 * Neither `completed` nor `abandoned` is a legal vault status. Emitting
 * `session.status` verbatim would therefore write an off-schema frontmatter
 * value and hard-fail `vault-sync`, which runs as a session-end Phase 1 gate.
 *
 * ── WHAT THIS REPLACES ─────────────────────────────────────────────────────
 *
 * All three generators previously hard-coded `status: verified` (frontmatter
 * line + `status/verified` tag) and never read `session.status` at all — so
 * every mirrored session claimed "verified" regardless of how it ended. A false
 * `verified` in a knowledge store is worse than a missing note: it is a claim
 * downstream readers cannot distinguish from a true one.
 *
 * ── THE MAPPING ────────────────────────────────────────────────────────────
 *
 *   completed    → verified   (closed through the full /close flow incl. gates)
 *   abandoned    → draft      (phantom stub synthesized by the SessionEnd
 *                              backfill from events.jsonl; incomplete fields,
 *                              never gate-verified — `draft` is the honest
 *                              "unfinished" value)
 *   absent/null  → verified   (pre-#724 records predate the field; per
 *                              filters.mjs's fail-open contract these are
 *                              genuine sessions, and this keeps the 200+
 *                              already-mirrored notes byte-identical → no
 *                              re-write churn on the next mirror run)
 *   anything else→ draft      (fail-safe: the ledger enum is additive-optional
 *                              and has grown once already; an unmapped future
 *                              value must never be able to emit an off-schema
 *                              vault status, and must never silently claim
 *                              `verified`)
 */
const VAULT_STATUS_BY_SESSION_STATUS = Object.freeze({
  completed: 'verified',
  abandoned: 'draft',
});

/** Vault status for a record that carries no `status` field (pre-#724). */
const VAULT_STATUS_WHEN_ABSENT = 'verified';

/** Vault status for a ledger value outside the known enum (fail-safe). */
const VAULT_STATUS_FALLBACK = 'draft';

/**
 * Resolve the vault-frontmatter `status` for a session record.
 *
 * Guaranteed to return a member of vaultNoteStatusSchema for ANY input —
 * including `null`, a non-object, or a hostile string such as `'constructor'`
 * (hence `Object.hasOwn` rather than a bare property read, which would return
 * an inherited `Object.prototype` member).
 *
 * @param {unknown} entry — a parsed sessions.jsonl record
 * @returns {'verified'|'draft'}
 */
export function vaultStatusForSession(entry) {
  if (entry === null || typeof entry !== 'object') return VAULT_STATUS_WHEN_ABSENT;
  const raw = entry.status;
  if (raw === null || raw === undefined || raw === '') return VAULT_STATUS_WHEN_ABSENT;
  return Object.hasOwn(VAULT_STATUS_BY_SESSION_STATUS, raw)
    ? VAULT_STATUS_BY_SESSION_STATUS[raw]
    : VAULT_STATUS_FALLBACK;
}

/**
 * Frontmatter line emitter — skips emission when value is null/undefined/empty
 * to avoid template-literal coercion bugs (e.g. `platform: undefined` → "undefined").
 * Returns the formatted line with trailing newline, or empty string to skip.
 */
function fmLine(key, value) {
  if (value === null || value === undefined || value === '') return '';
  return `${key}: ${value}\n`;
}

/**
 * Session JSONL has three producer schemas in production:
 *   v1 (legacy):  total_waves, total_agents, total_files_changed, agent_summary, waves[{agent_count, files_changed, quality}]
 *   v2 (S69+):    files_changed (top-level), waves[{agents, agents_done, agents_partial, agents_failed, dispatch, duration_s}]
 *   v3 (2026-05+): coordinator-direct records — `waves` is a SCALAR count and
 *                  `agents_dispatched` is a scalar; no per-wave array breakdown.
 *                  Added for #491, when such records fell through to v1
 *                  validation and were rejected as `skipped-invalid`.
 * v1 and v2 both carry `waves` as an ARRAY, so a numeric `waves` is the
 * unambiguous v3 discriminator.
 *
 * #964 — CORRECTION. This comment previously claimed v3 was "the shape
 * session-end actually emits". It is not, and cannot be: `validateSession`
 * requires `Array.isArray(waves)`, so a scalar-`waves` record is refused by
 * `scripts/emit-session.mjs` before it can be written. Census over the live
 * ledger at HEAD 730ee9d — 205 parseable records, post-`normalizeSessionEntry`:
 * **v1 205, v2 0, v3 0**. Both v2 and v3 are read-path tolerances for foreign /
 * legacy producer shapes, not targets of the sanctioned writer. v3's live
 * reachability is therefore zero; see the follow-up note in the #964 report
 * before treating it as dead code — deletion is a separate decision, and the
 * `normalizeSessionEntry` alias path can still synthesize a scalar `waves`.
 */
export function detectSessionSchema(entry) {
  if (!entry) return 'v1';
  if (typeof entry.waves === 'number') return 'v3';
  return entry.total_agents === undefined && entry.files_changed !== undefined ? 'v2' : 'v1';
}

/**
 * Map known producer alias fields onto the canonical session shapes (#635).
 *
 * Several session-end variants emitted alias fields the validators reject:
 * `ended_at` (for completed_at), `mode` (for session_type), and wave counts
 * only as `total_waves`/`waves_completed` with no `waves` field at all. Such
 * records fell through to v1 validation and were skipped-invalid. This pure
 * function fills MISSING canonical fields from their aliases so the entry
 * routes to the v3 (scalar-waves) renderer. Canonical v1/v2/v3 entries pass
 * through untouched (`waves` is only filled when absent — an existing array
 * or number is never modified).
 *
 * Returns a new object; never mutates the input.
 */
export function normalizeSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const e = { ...entry };

  if (e.completed_at === null || e.completed_at === undefined) {
    if (e.ended_at !== null && e.ended_at !== undefined) e.completed_at = e.ended_at;
  }
  if (e.session_type === null || e.session_type === undefined) {
    if (typeof e.mode === 'string' && e.mode.length > 0) e.session_type = e.mode;
  }
  if (e.waves === null || e.waves === undefined) {
    if (typeof e.total_waves === 'number') e.waves = e.total_waves;
    else if (typeof e.waves_completed === 'number') e.waves = e.waves_completed;
    else e.waves = 0; // coordinator-direct record with no wave breakdown
  }

  return e;
}

export function generateSessionNote(entry, options = {}) {
  for (const field of RENDERABLE_SESSION_FIELDS_V1) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: session entry missing required field '${field}' (session_id=${entry.session_id ?? '<no session_id>'})`);
    }
  }

  const {
    session_id,
    session_type,
    platform,
    started_at,
    completed_at,
    duration_seconds,
    total_waves,
    total_agents,
    total_files_changed,
    agent_summary,
    waves,
    effectiveness,
  } = entry;

  if (typeof effectiveness !== 'object' || effectiveness === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'effectiveness' (session_id=${session_id})`);
  }
  if (typeof agent_summary !== 'object' || agent_summary === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'agent_summary' (session_id=${session_id})`);
  }
  if (!Array.isArray(waves)) {
    throw new Error(`vault-mirror: session entry missing nested field 'waves' (session_id=${session_id})`);
  }

  const created = toDate(started_at);
  const updated = toDate(completed_at);
  const durationLabel = renderDuration(duration_seconds);
  // #M1: every `effectiveness` sub-field is OPTIONAL (validator.mjs
  // `_validateOptionalFields` shape-checks the object, never its members), so a
  // raw interpolation writes the literal string `undefined` into a note a human
  // reads. `??` (never `||`) is load-bearing: a measured `0` must survive as `0`,
  // only a genuinely absent value becomes the placeholder. The alias reads are
  // ordered v1-field-first so a record that rendered a value before renders the
  // exact same value now — this change can only ever replace `undefined`/`NaN`.
  const { planned_issues, carryover, completion_rate } = effectiveness;
  const completed = effectiveness.completed ?? effectiveness.completed_issues ?? MISSING_VALUE;
  const emergent = effectiveness.emergent ?? effectiveness.unplanned_finds ?? MISSING_VALUE;
  const ratePercent =
    typeof completion_rate === 'number' ? Math.round(completion_rate * 100) + '%' : MISSING_VALUE;
  const { complete, partial, failed, spiral } = agent_summary;

  const titleValue = `Session ${created} — ${session_type}`;
  // Always quote session title — it contains em-dash
  const title = `"${titleValue}"`;

  // #602: session_type is interpolated raw upstream; slugify each tag segment
  // and cap the combined tag at 64 chars so the frontmatter passes the vault
  // tagPathRegex. The `id` is likewise slugified to a kebab slug below —
  // entry.session_id may carry an ISO-timestamp uppercase `T`/`:`/`.`/`Z`.
  const noteId = slugifyIdSafe(session_id) ?? session_id;
  // #909: the real ledger status, mapped into the vault enum — never hard-coded.
  const vaultStatus = vaultStatusForSession(entry);
  const tags = `[${buildTag(['session', session_type])}, ${buildTag(['status', vaultStatus])}]`;

  // Build wave table rows.
  //
  // #M1: only `wave` and `role` are schema-REQUIRED per wave (validator.mjs
  // `_validateWaves`); `agent_count`, `files_changed` and `quality` are never
  // validated, so all three are optional and were rendering as the literal
  // string `undefined`. Guarded with the same `?? '?'` the v2 generator's wave
  // rows already used — `??` so a measured `0` still renders `0`.
  const waveRows = waves
    .map(
      (w) =>
        `| ${w.wave} | ${w.role} | ${w.agent_count ?? MISSING_CELL} | ${w.files_changed ?? MISSING_CELL} | ${w.quality ?? MISSING_CELL} |`,
    )
    .join('\n');

  // Skip-emit guard: avoid `platform: undefined` literal coercion (issue #343).
  const platformBullet = (platform === null || platform === undefined || platform === '')
    ? ''
    : ` · **Platform:** ${platform}`;

  // #732: emit `source-repo` (the leak-guarded/pseudonym-mapped namespace from
  // resolveRepoNamespace(), threaded through by process.mjs) instead of the
  // legacy raw `repo` field — mirrors render-learnings.mjs's source-repo line.
  const { repoNs } = options;

  return `---
id: ${noteId}
type: session
title: ${title}
status: ${vaultStatus}
created: ${created}
updated: ${updated}
tags: ${tags}
${fmLine('source-repo', repoNs)}_generator: ${GENERATOR_MARKER}
---

# Session ${session_id}

- **Type:** ${session_type}${platformBullet}
- **Duration:** ${durationLabel} (${started_at} → ${completed_at})
- **Waves:** ${total_waves} · **Agents:** ${total_agents} · **Files changed:** ${total_files_changed}
- **Effectiveness:** planned=${planned_issues ?? MISSING_VALUE}, completed=${completed}, carryover=${carryover ?? MISSING_VALUE}, emergent=${emergent}, rate=${ratePercent}

## Wave breakdown

| Wave | Role | Agents | Files | Quality |
|------|------|--------|-------|---------|
${waveRows}

## Agent summary

- Complete: ${complete} · Partial: ${partial} · Failed: ${failed} · Spiral: ${spiral}
`;
}

export function generateSessionNoteV2(entry, options = {}) {
  for (const field of RENDERABLE_SESSION_FIELDS_V2) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: session entry missing required field '${field}' (session_id=${entry.session_id ?? '<no session_id>'})`);
    }
  }
  if (!Array.isArray(entry.waves)) {
    throw new Error(`vault-mirror: session entry 'waves' must be an array (session_id=${entry.session_id})`);
  }
  if (typeof entry.effectiveness !== 'object' || entry.effectiveness === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'effectiveness' (session_id=${entry.session_id})`);
  }

  const { session_id, session_type, started_at, completed_at, duration_seconds, branch, planned_issues, waves, files_changed, issues_closed, issues_created, effectiveness, notes } = entry;

  const created = toDate(started_at);
  const updated = toDate(completed_at);
  const durationLabel = renderDuration(duration_seconds);

  // Derive v1-equivalent aggregates from v2 wave structure
  const totalWaves = waves.length;
  const totalAgents = waves.reduce((acc, w) => acc + (w.agents ?? 0), 0);
  const complete = waves.reduce((acc, w) => acc + (w.agents_done ?? 0), 0);
  const partial = waves.reduce((acc, w) => acc + (w.agents_partial ?? 0), 0);
  const failed = waves.reduce((acc, w) => acc + (w.agents_failed ?? 0), 0);

  const completionRate = effectiveness.completion_rate;
  const ratePercent = typeof completionRate === 'number' ? Math.round(completionRate * 100) + '%' : 'n/a';
  const carryover = effectiveness.carryover ?? 'n/a';

  const titleValue = `Session ${created} — ${session_type}`;
  const title = `"${titleValue}"`;

  // #602: session_type is interpolated raw upstream; slugify each tag segment
  // and cap the combined tag at 64 chars so the frontmatter passes the vault
  // tagPathRegex. The `id` is likewise slugified to a kebab slug below —
  // entry.session_id may carry an ISO-timestamp uppercase `T`/`:`/`.`/`Z`.
  const noteId = slugifyIdSafe(session_id) ?? session_id;
  // #909: the real ledger status, mapped into the vault enum — never hard-coded.
  const vaultStatus = vaultStatusForSession(entry);
  const tags = `[${buildTag(['session', session_type])}, ${buildTag(['status', vaultStatus])}]`;

  const waveRows = waves
    .map((w) => `| ${w.wave} | ${w.role} | ${w.agents ?? '?'} | ${w.dispatch ?? '?'} | ${w.duration_s ?? '?'}s | ${w.agents_done ?? 0}/${w.agents_partial ?? 0}/${w.agents_failed ?? 0} |`)
    .join('\n');

  const closedList = Array.isArray(issues_closed) && issues_closed.length ? issues_closed.join(', ') : '—';
  const createdList = Array.isArray(issues_created) && issues_created.length ? issues_created.join(', ') : '—';
  const branchLine = branch ? ` · **Branch:** ${branch}` : '';
  const notesBlock = notes ? `\n## Notes\n\n${notes}\n` : '';

  // #732: emit `source-repo` (leak-guarded/pseudonym-mapped) instead of the
  // legacy raw `repo` field — see generateSessionNote for the full rationale.
  const { repoNs } = options;

  return `---
id: ${noteId}
type: session
title: ${title}
status: ${vaultStatus}
created: ${created}
updated: ${updated}
tags: ${tags}
${fmLine('source-repo', repoNs)}_generator: ${GENERATOR_MARKER}
---

# Session ${session_id}

- **Type:** ${session_type}${branchLine}
- **Duration:** ${durationLabel} (${started_at} → ${completed_at})
- **Waves:** ${totalWaves} · **Agents:** ${totalAgents} · **Files changed:** ${files_changed}
- **Effectiveness:** planned=${planned_issues ?? 'n/a'}, carryover=${carryover}, rate=${ratePercent}
- **Issues closed:** ${closedList}
- **Issues created:** ${createdList}

## Wave breakdown

| Wave | Role | Agents | Dispatch | Duration | done/partial/failed |
|------|------|--------|----------|----------|---------------------|
${waveRows}

## Agent summary

- Complete: ${complete} · Partial: ${partial} · Failed: ${failed}
${notesBlock}`;
}

/**
 * v3 generator — coordinator-direct session records (#491).
 *
 * These records carry `waves` as a scalar count and `agents_dispatched` as a
 * scalar (no per-wave array), plus rich top-level metadata (issues_closed,
 * follow_ups_filed, commits, tests_total_*). They are what session-end actually
 * writes to sessions.jsonl. The v1/v2 generators require `waves` to be an array
 * and reject this shape, so it gets its own renderer.
 */
export function generateSessionNoteV3(entry, options = {}) {
  for (const field of RENDERABLE_SESSION_FIELDS_V3) {
    if (entry[field] === null || entry[field] === undefined) {
      throw new Error(`vault-mirror: session entry missing required field '${field}' (session_id=${entry.session_id ?? '<no session_id>'})`);
    }
  }
  if (typeof entry.waves !== 'number') {
    throw new Error(`vault-mirror: session entry 'waves' must be a number (session_id=${entry.session_id})`);
  }
  if (typeof entry.effectiveness !== 'object' || entry.effectiveness === null) {
    throw new Error(`vault-mirror: session entry missing nested field 'effectiveness' (session_id=${entry.session_id})`);
  }

  const {
    session_id, session_type, platform, branch, started_at, completed_at,
    duration_minutes, duration_seconds, waves, agents_dispatched, agent_summary,
    planned_issues, effectiveness, commits, issues_closed, issues_created,
    follow_ups_filed, tests_total_pre, tests_total_post, tests_added, notes,
  } = entry;

  const created = toDate(started_at);
  const updated = toDate(completed_at);
  const durationLabel = renderDuration(duration_seconds, duration_minutes);

  // #968 — ABSENT IS NOT ZERO. Two sites here defaulted an absent value to `0`,
  // claiming a measured zero the producer never wrote: `emergent` (`?? 0`) and
  // the `agent_summary` destructuring defaults (`= 0`, over an `as` that itself
  // falls back to `{}`). That was inconsistent with v3's OWN treatment of the
  // neighbouring fields — `carryover` used `?? 'n/a'` one line above `emergent`'s
  // `?? 0` — and it is the more damaging direction: "0 agents failed" reads as a
  // verified fact, "n/a" reads as unknown. `??` (never `||`) is load-bearing at
  // every site: a MEASURED 0 must still render `0`.
  const completionRate = effectiveness.completion_rate;
  const ratePercent =
    typeof completionRate === 'number' ? Math.round(completionRate * 100) + '%' : MISSING_VALUE;
  const completed = effectiveness.completed_issues ?? effectiveness.completed ?? MISSING_VALUE;
  const carryover = effectiveness.carryover ?? MISSING_VALUE;
  const emergent = effectiveness.unplanned_finds ?? effectiveness.emergent ?? MISSING_VALUE;

  const agentsValue = typeof agents_dispatched === 'number' ? agents_dispatched : MISSING_VALUE;
  const as = agent_summary && typeof agent_summary === 'object' ? agent_summary : {};
  const complete = as.complete ?? MISSING_VALUE;
  const partial = as.partial ?? MISSING_VALUE;
  const failed = as.failed ?? MISSING_VALUE;
  const spiral = as.spiral ?? MISSING_VALUE;

  const fmtIssues = (list) =>
    Array.isArray(list) && list.length ? list.map((i) => `#${i}`).join(', ') : '—';
  const closedList = fmtIssues(issues_closed);
  const createdList = fmtIssues(issues_created);
  const followList = fmtIssues(follow_ups_filed);
  // #969 LOW-1: an ABSENT `commits` is "not recorded", an EMPTY one is
  // "recorded, and there were none". `commits` is not in
  // RENDERABLE_SESSION_FIELDS_V3, so absence is reachable — and the old `: 0`
  // published the second answer to the first question. A present-but-empty
  // array keeps rendering `0`: that IS a measured zero, exactly the value the
  // ABSENT-IS-NOT-ZERO banner says must survive.
  const commitCount = Array.isArray(commits) ? commits.length : MISSING_VALUE;
  const testsDelta =
    typeof tests_total_pre === 'number' && typeof tests_total_post === 'number'
      ? `${tests_total_pre} → ${tests_total_post}`
      : typeof tests_added === 'number'
        ? `+${tests_added}`
        : '—';

  const titleValue = `Session ${created} — ${session_type}`;
  const title = `"${titleValue}"`;
  // #602: session_type is interpolated raw upstream; slugify each tag segment
  // and cap the combined tag at 64 chars so the frontmatter passes the vault
  // tagPathRegex. The `id` is likewise slugified to a kebab slug below —
  // entry.session_id may carry an ISO-timestamp uppercase `T`/`:`/`.`/`Z`.
  const noteId = slugifyIdSafe(session_id) ?? session_id;
  // #909: the real ledger status, mapped into the vault enum — never hard-coded.
  const vaultStatus = vaultStatusForSession(entry);
  const tags = `[${buildTag(['session', session_type])}, ${buildTag(['status', vaultStatus])}]`;

  const platformBullet = platform === null || platform === undefined || platform === '' ? '' : ` · **Platform:** ${platform}`;
  const branchLine = branch ? ` · **Branch:** ${branch}` : '';
  const notesBlock = notes ? `\n## Notes\n\n${notes}\n` : '';

  // #732: emit `source-repo` (leak-guarded/pseudonym-mapped) instead of the
  // legacy raw `repo` field — see generateSessionNote for the full rationale.
  const { repoNs } = options;

  return `---
id: ${noteId}
type: session
title: ${title}
status: ${vaultStatus}
created: ${created}
updated: ${updated}
tags: ${tags}
${fmLine('source-repo', repoNs)}_generator: ${GENERATOR_MARKER}
---

# Session ${session_id}

- **Type:** ${session_type}${branchLine}${platformBullet}
- **Duration:** ${durationLabel} (${started_at} → ${completed_at})
- **Waves:** ${waves} · **Agents:** ${agentsValue} · **Commits:** ${commitCount}
- **Effectiveness:** planned=${planned_issues ?? MISSING_VALUE}, completed=${completed}, carryover=${carryover}, emergent=${emergent}, rate=${ratePercent}
- **Tests:** ${testsDelta}
- **Issues closed:** ${closedList}
- **Issues created:** ${createdList}
- **Follow-ups filed:** ${followList}

## Agent summary

- Complete: ${complete} · Partial: ${partial} · Failed: ${failed} · Spiral: ${spiral}
${notesBlock}`;
}
