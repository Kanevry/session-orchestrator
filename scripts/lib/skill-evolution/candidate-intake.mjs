/**
 * candidate-intake.mjs — Pure transform for the #647 C2 auto-repair engine.
 *
 * Ingests the two repair-candidate feeders and normalises them into a single
 * `RepairCandidate[]` shape:
 *   1. `/evolve` learnings (`.orchestrator/metrics/learnings.jsonl` records)
 *   2. `claude-md-drift-check` output (`driftResult.errors[]`)
 *
 * This module is a PURE transform: it performs NO I/O. It never reads or writes
 * any file. Persistence and the `processed_at` / `superseded_by` lifecycle are
 * OWNED BY the sibling `idempotency.mjs` module — this module only emits the
 * raw candidates with those fields nulled out.
 *
 * The `id` field is a deterministic short hash of (source, target_path,
 * fingerprint), so the same input always yields the same id. That determinism
 * is the idempotency key the sibling module relies on.
 *
 * Part of Epic #643 → issue #647 (C2 auto-repair engine).
 */

import { createHash } from 'node:crypto';

/**
 * @typedef {Object} RepairCandidate
 * @property {string}      id              Deterministic short hash (idempotency key).
 * @property {1}          schema_version  Schema version, always 1.
 * @property {'evolve-learning'|'drift-check'} source  Originating feeder.
 * @property {string}     source_ref      Back-reference into the source feeder.
 * @property {string}     target_path     Repo-relative path the repair targets.
 * @property {number}     evidence        Numeric confidence/strength of the signal.
 * @property {'confidence'|'filesystem-fact'} evidence_kind  Interpretation of `evidence`.
 * @property {string}     proposed_change Short human-readable description of the fix.
 * @property {string}     rationale       Why this candidate exists.
 * @property {string}     created_at      ISO timestamp when the candidate was minted.
 * @property {null}       processed_at    Always null (idempotency.mjs sets this later).
 * @property {null}       superseded_by   Always null (idempotency.mjs sets this later).
 */

/** Drift-check checks that map to error candidates → `proposed_change` template. */
const DRIFT_PROPOSED_CHANGE = {
  'path-resolver': () => 'Update/remove stale absolute path',
  'project-count-sync': () => 'Sync project count',
  'session-file-existence': () => 'Remove/repoint missing session-file ref',
  'issue-reference-freshness': () =>
    'Move/remove closed issue ref out of forward-looking section',
  'session-config-parity': () => 'Add missing Session Config key',
  'vault-dir-parity': () => 'Reconcile vault-dir between CLAUDE.md and AGENTS.md',
};

/** Path-extraction regex: repo-relative dir paths OR bare known-extension filenames. */
const PATH_RE =
  /(scripts|skills|hooks|tests|docs)\/[\w./-]+|\b[\w-]+\.(mjs|md|json|js|ts)\b/;

/** Prescriptive-verb regex: the insight must propose an action, not merely describe. */
const PRESCRIPTIVE_RE =
  /\b(fix|change|switch|default|pin|port|remove|add|update|replace|disable|enable|require)\b/i;

/** Drift-check statuses that mean "no candidates to emit". */
const DRIFT_INERT_STATUSES = new Set(['skipped', 'skipped-mode-off', undefined]);

/**
 * Slugify a string for use inside the deterministic fingerprint. The exact form
 * is internal (it only feeds the hash) — kebab-case, alnum-only, collapsed.
 * @param {string} input
 * @returns {string}
 */
function slug(input) {
  return String(input ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Build the deterministic candidate id from its idempotency triple.
 * @param {string} source
 * @param {string} targetPath
 * @param {string} fingerprint
 * @returns {string}
 */
function makeId(source, targetPath, fingerprint) {
  const hash = createHash('sha256')
    .update(source + '\0' + targetPath + '\0' + fingerprint)
    .digest('hex')
    .slice(0, 8);
  return `rc-${hash}`;
}

/**
 * Extract the first repo-relative path from a candidate's text fields.
 * @param {string} text
 * @returns {string|null}
 */
function extractPath(text) {
  const match = PATH_RE.exec(String(text ?? ''));
  return match ? match[0] : null;
}

/**
 * Map a single learning record to a RepairCandidate, or null when it fails any
 * actionable filter. learnings.jsonl records are NOT uniform — only `confidence`
 * and `created_at` are guaranteed — so id/subject/insight/evidence are handled
 * defensively.
 * @param {Record<string, unknown>} learning
 * @param {number} evidenceFloor
 * @param {string} nowIso
 * @returns {RepairCandidate|null}
 */
function learningToCandidate(learning, evidenceFloor, nowIso) {
  if (!learning || typeof learning !== 'object') return null;

  // Filter 1: confidence gate.
  const confidence = /** @type {unknown} */ (learning.confidence);
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (confidence < evidenceFloor) return null;

  // Filter 4: not expired (missing expires_at ⇒ live).
  const expiresAt = learning.expires_at;
  if (typeof expiresAt === 'string' && expiresAt.length > 0 && expiresAt < nowIso) {
    return null;
  }

  const subject = typeof learning.subject === 'string' ? learning.subject : '';
  const insight = typeof learning.insight === 'string' ? learning.insight : '';

  // Filter 2: resolvable target path from subject OR insight.
  const targetPath = extractPath(subject) ?? extractPath(insight);
  if (!targetPath) return null;

  // Filter 3: insight must be prescriptive.
  if (!PRESCRIPTIVE_RE.test(insight)) return null;

  const source = 'evolve-learning';
  const sourceRef = typeof learning.id === 'string' && learning.id.length > 0
    ? learning.id
    : null;
  const fingerprint = slug(targetPath + '-' + insight.slice(0, 80));

  return {
    id: makeId(source, targetPath, fingerprint),
    schema_version: 1,
    source,
    source_ref: sourceRef,
    target_path: targetPath,
    evidence: confidence,
    evidence_kind: 'confidence',
    proposed_change: insight,
    rationale: `evolve learning (confidence ${confidence}): ${insight}`,
    created_at: nowIso,
    processed_at: null,
    superseded_by: null,
  };
}

/**
 * Map a single drift-check error to a RepairCandidate. Drift errors are
 * filesystem facts (evidence 1.0). Unknown checks fall back to a generic
 * proposed-change derived from the check name.
 * @param {Record<string, unknown>} err
 * @param {string} nowIso
 * @returns {RepairCandidate|null}
 */
function driftErrorToCandidate(err, nowIso) {
  if (!err || typeof err !== 'object') return null;

  const check = typeof err.check === 'string' ? err.check : '';
  const file = typeof err.file === 'string' ? err.file : '';
  const line = err.line ?? '';
  const message = typeof err.message === 'string' ? err.message : '';

  // target_path is required — drift errors carry a repo-relative file already.
  if (!file) return null;

  const source = 'drift-check';
  const sourceRef = `${check}:${file}:${line}`;

  // Per-check proposed-change templates; command-count needs the actual count.
  let proposedChange;
  if (check === 'command-count') {
    // Prefer the STRUCTURED bare claimed number (checker.mjs:495 exposes
    // `command_count: { actual, claimed }` where `claimed` is `parseInt(m[1])`).
    // `err.extracted` is the FULL regex match (e.g. "8 commands"); using it here
    // produced the malformed double-word `'8 commands commands'` that the engine
    // whitelist regex (engine.mjs COMMAND_COUNT_SHAPE) correctly rejects — making
    // autonomous-apply dead code for this shape (#651 FIX 1).
    const claimed =
      (err.command_count && typeof err.command_count === 'object' && err.command_count !== null
        ? /** @type {Record<string, unknown>} */ (err.command_count).claimed
        : undefined) ?? err.extracted ?? '?';
    const actual =
      err.command_count && typeof err.command_count === 'object' && err.command_count !== null
        ? /** @type {Record<string, unknown>} */ (err.command_count).actual ?? '?'
        : '?';
    proposedChange = `Update narrative '${claimed} commands' to actual ${actual}`;
  } else if (Object.prototype.hasOwnProperty.call(DRIFT_PROPOSED_CHANGE, check)) {
    proposedChange = DRIFT_PROPOSED_CHANGE[check]();
  } else {
    proposedChange = `Resolve drift-check '${check}'`;
  }

  const fingerprint = slug(file + '-' + message.slice(0, 80));

  return {
    id: makeId(source, file, fingerprint),
    schema_version: 1,
    source,
    source_ref: sourceRef,
    target_path: file,
    evidence: 1.0,
    evidence_kind: 'filesystem-fact',
    proposed_change: proposedChange,
    rationale: message,
    created_at: nowIso,
    processed_at: null,
    superseded_by: null,
  };
}

/**
 * Ingest the two repair-candidate feeders and return a normalised
 * `RepairCandidate[]`. Pure transform — performs no I/O.
 *
 * @param {Object} params
 * @param {Array<Record<string, unknown>>} [params.learnings] - `/evolve` learning records.
 * @param {{ status?: string, errors?: Array<Record<string, unknown>>, warnings?: unknown[] }|null} [params.driftResult]
 *        claude-md-drift-check output. Only `errors[]` are mapped; `warnings[]`
 *        are skipped. A null result, or a status of `skipped`/`skipped-mode-off`/
 *        undefined, emits zero drift candidates.
 * @param {string} [params.repoRoot] - repo root (accepted for caller symmetry; unused in the pure transform).
 * @param {number} [params.evidenceFloor=0.5] - minimum learning confidence to qualify.
 * @param {string} [params.now] - ISO timestamp for `created_at` + expiry checks (test determinism).
 * @returns {RepairCandidate[]}
 */
export function extractCandidates({
  learnings,
  driftResult,
  // eslint-disable-next-line no-unused-vars -- accepted for caller symmetry; pure transform does no path resolution
  repoRoot,
  evidenceFloor = 0.5,
  now,
} = {}) {
  const nowIso = typeof now === 'string' && now.length > 0 ? now : new Date().toISOString();
  const floor = Number.isFinite(evidenceFloor) ? evidenceFloor : 0.5;

  /** @type {RepairCandidate[]} */
  const candidates = [];

  // Feeder 1: /evolve learnings.
  if (Array.isArray(learnings)) {
    for (const learning of learnings) {
      const candidate = learningToCandidate(learning, floor, nowIso);
      if (candidate) candidates.push(candidate);
    }
  }

  // Feeder 2: drift-check errors (skip when inert).
  if (
    driftResult &&
    typeof driftResult === 'object' &&
    !DRIFT_INERT_STATUSES.has(driftResult.status) &&
    Array.isArray(driftResult.errors)
  ) {
    for (const err of driftResult.errors) {
      const candidate = driftErrorToCandidate(err, nowIso);
      if (candidate) candidates.push(candidate);
    }
  }

  return candidates;
}
