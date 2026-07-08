/**
 * handover-gate.mjs — deterministic routing helper for the /close Handover
 * Alignment Gate (session-end Phase 1.65).
 *
 * PRD: docs/prd/2026-07-07-close-handover-alignment-gate.md
 * Issue: #769 (Epic #724 — Session-Lifecycle & Close-Friction)
 *
 * ## What this module does
 *
 * The gate is skill-prose-first with a minimal mechanical core (same pattern as
 * memory-proposals / phase-skip.mjs): the LLM coordinator runs the AUQ
 * interaction, and this small pure `.mjs` lib makes the deterministic candidate
 * classification trivially testable. There is NO I/O here — no disk, no clock,
 * no randomness — so every function is a pure, deterministic mapping of input
 * records to a routed shape.
 *
 * ## The routing contract (PRD FA2 + §3.A EARS)
 *
 * Every carryover candidate lands in EXACTLY ONE of `autoCarry` or `ask` — no
 * candidate is ever dropped by classification (the Ubiquitous EARS rule). The
 * coordinator later decides the OB (whether an issue is filed) from these two
 * buckets: `autoCarry` items are listed in the gate summary but are NOT
 * user-deselectable; `ask` items become the Middle-Band multiSelect (preselected
 * = carry).
 *
 * A candidate is routed to `autoCarry` when ANY of:
 *   - `priority === 'critical'` or `priority === 'high'`, OR
 *   - `bucket === 'spiral-failed'` (the SPIRAL/FAILED safety-net, Phase 1.6), OR
 *   - `originIssue === null` (Grill decision: dropping a candidate that has no
 *     origin issue would be real forgetting — SKILL.md:853 Critical Rule stays
 *     intact).
 *
 * A candidate is routed to `ask` when it has an origin issue AND its priority is
 * `medium` / `low` / `null` AND its bucket is `not-started` / `emergent` /
 * `partially-done` (i.e. not high-prio, not spiral-failed).
 *
 * `malformed` records (missing/empty task text) are routed to `ask` with a
 * `malformed: true` flag — the helper NEVER throws on them, and the malformed
 * branch takes precedence over every autoCarry condition (a record with no task
 * text cannot be meaningfully auto-filed, so the operator decides).
 *
 * Empty / non-array input yields `{ autoCarry: [], ask: [] }` — never throws.
 *
 * @typedef {Object} NormalizedCandidate
 * @property {string} task           - task text (required; if absent/empty → malformed:true).
 * @property {string} sourcePhase    - '1.2' | '1.3' | '1.4' | '1.6' (best-effort string).
 * @property {number|null} originIssue - issue IID, or null when there is no origin issue.
 * @property {'critical'|'high'|'medium'|'low'|null} priority
 * @property {'partially-done'|'not-started'|'emergent'|'spiral-failed'} bucket
 * @property {boolean} [malformed]   - true when task text is missing/empty.
 *
 * @typedef {Object} RoutingResult
 * @property {NormalizedCandidate[]} autoCarry - not user-deselectable; gate-summary only.
 * @property {NormalizedCandidate[]} ask       - Middle-Band multiSelect (preselected = carry).
 */

// ---------------------------------------------------------------------------
// Coercion tables
// ---------------------------------------------------------------------------

/** Valid carryover buckets (PRD §3.A). */
const VALID_BUCKETS = new Set(['partially-done', 'not-started', 'emergent', 'spiral-failed']);

/** Valid priorities (GitLab priority labels, lowercased, label-prefix stripped). */
const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);

/**
 * Source-phase → bucket inference used when a candidate omits an explicit bucket
 * (PRD §2 In-Scope: 1.2 Partially Done, 1.3 Not Started, 1.4 unfinished Emergent,
 * 1.6 SPIRAL/FAILED walk).
 */
const PHASE_BUCKET = {
  '1.2': 'partially-done',
  '1.3': 'not-started',
  '1.4': 'emergent',
  '1.6': 'spiral-failed',
};

/** Neutral fallback bucket when neither an explicit bucket nor a known phase maps. */
const DEFAULT_BUCKET = 'not-started';

// ---------------------------------------------------------------------------
// Field coercers (each pure, each defensive)
// ---------------------------------------------------------------------------

/**
 * Coerce an origin-issue field. Numeric string ("769") → number; an integer
 * number passes through; everything else (missing, null, fractional
 * number/string, non-numeric) → null. Issue IIDs are always integers, so a
 * fractional number is coerced identically to a fractional numeric string —
 * both are malformed input and fall through to `null` (routing the candidate
 * to autoCarry via the no-origin rule, the safe direction).
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function coerceOriginIssue(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    return /^-?\d+$/.test(t) ? Number(t) : null;
  }
  return null;
}

/**
 * Coerce a priority field: lowercase, trim, strip a leading `priority:` label,
 * validate against the closed enum. Anything invalid → null.
 *
 * @param {unknown} v
 * @returns {'critical'|'high'|'medium'|'low'|null}
 */
function coercePriority(v) {
  if (v === null || v === undefined) return null;
  let s = String(v).trim().toLowerCase();
  if (s.startsWith('priority:')) s = s.slice('priority:'.length).trim();
  return VALID_PRIORITIES.has(s) ? /** @type {any} */ (s) : null;
}

/**
 * Coerce the source-phase field to a best-effort trimmed string ('' when absent).
 *
 * @param {unknown} v
 * @returns {string}
 */
function coerceSourcePhase(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

/**
 * Resolve the bucket: an explicit valid bucket wins; otherwise infer from the
 * source phase; otherwise fall back to the neutral default.
 *
 * @param {unknown} rawBucket
 * @param {string} sourcePhase
 * @returns {'partially-done'|'not-started'|'emergent'|'spiral-failed'}
 */
function coerceBucket(rawBucket, sourcePhase) {
  if (rawBucket !== null && rawBucket !== undefined) {
    const b = String(rawBucket).trim().toLowerCase();
    if (VALID_BUCKETS.has(b)) return /** @type {any} */ (b);
  }
  return /** @type {any} */ (PHASE_BUCKET[sourcePhase] ?? DEFAULT_BUCKET);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Normalize a raw carryover-candidate record into a {@link NormalizedCandidate}.
 *
 * Accepts any subset of `{ task, sourcePhase, originIssue, priority, bucket }`
 * (strings or numbers) and coerces each field. Missing/empty `task` yields
 * `task: ''` plus `malformed: true` (never throws). Pure and deterministic —
 * no `Date.now()` / `Math.random()`.
 *
 * @param {unknown} raw
 * @returns {NormalizedCandidate}
 */
export function normalizeCandidate(raw) {
  const rec = raw && typeof raw === 'object' ? /** @type {Record<string, unknown>} */ (raw) : {};

  const sourcePhase = coerceSourcePhase(rec.sourcePhase);
  const originIssue = coerceOriginIssue(rec.originIssue);
  const priority = coercePriority(rec.priority);
  const bucket = coerceBucket(rec.bucket, sourcePhase);

  const hasTask = typeof rec.task === 'string' && rec.task.trim().length > 0;

  /** @type {NormalizedCandidate} */
  const normalized = {
    task: hasTask ? /** @type {string} */ (rec.task) : '',
    sourcePhase,
    originIssue,
    priority,
    bucket,
  };
  if (!hasTask) normalized.malformed = true;

  return normalized;
}

/**
 * Route a list of raw carryover candidates into `{ autoCarry, ask }`.
 *
 * Each candidate is first normalized via {@link normalizeCandidate}, then
 * classified per the module routing contract. Every candidate lands in exactly
 * one bucket; nothing is dropped. Empty or non-array input → `{ autoCarry: [],
 * ask: [] }`. Never throws.
 *
 * @param {unknown} candidates
 * @returns {RoutingResult}
 */
export function routeCandidates(candidates) {
  /** @type {RoutingResult} */
  const result = { autoCarry: [], ask: [] };
  if (!Array.isArray(candidates) || candidates.length === 0) return result;

  for (const raw of candidates) {
    const c = normalizeCandidate(raw);

    // malformed takes precedence over every autoCarry condition — a record with
    // no task text cannot be meaningfully auto-filed, so the operator decides.
    if (c.malformed) {
      result.ask.push(c);
      continue;
    }

    const isAutoCarry =
      c.priority === 'critical' ||
      c.priority === 'high' ||
      c.bucket === 'spiral-failed' ||
      c.originIssue === null;

    if (isAutoCarry) result.autoCarry.push(c);
    else result.ask.push(c);
  }

  return result;
}
