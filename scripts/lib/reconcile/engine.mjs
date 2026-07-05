/**
 * engine.mjs — Reconciliation-engine ORCHESTRATOR (Epic #693 FA2, issue #695).
 *
 * This is the keystone of #695: it composes the four already-verified sibling
 * leaf modules into a single never-throwing pipeline that turns the
 * `learnings.jsonl` corpus into RULE PROPOSALS, records each proposal/rejection
 * in the idempotency sidecar, and returns the rendered rule content for the
 * operator to approve. It is the reconcile-side analogue of
 * `scripts/lib/skill-evolution/engine.mjs` (the C2 repair orchestrator) and
 * mirrors its defensive posture: DI seams for every disk touch, a never-throws
 * public boundary, and an empty short-circuit that touches no disk.
 *
 * COMPOSITION (the four siblings):
 *   - eligibility.mjs  → filterEligible        (pure partition — INVERTED allow-list)
 *   - emitter.mjs      → toActivationMetadata   (eligible learning → metadata; THROWS on no axis)
 *   - renderer.mjs     → renderRule             (metadata → `.claude/rules/<slug>.md` string)
 *   - idempotency.mjs  → mergeCandidates / makeCandidateId  (store I/O + logical dedupe)
 *
 * PIPELINE (load → short-circuit → filter → per-item → record → summary):
 *   loadLearnings()
 *     → empty? return zeroed result, touch no disk
 *     → filterEligible(learnings)
 *     → per eligible: toActivationMetadata → renderRule → makeCandidateId → proposal
 *     → per rejected: record rejection with audit reason
 *     → mergeCandidates({ candidates, repoRoot })   (SKIPPED on dryRun)
 *     → return { proposals, rejected, summary }
 *
 * ── CRITICAL scope constraint (the FA2/FA3 brandmauer) ───────────────────────
 * The engine COMPUTES proposals and records them in the idempotency sidecar.
 * It MUST NOT write any file into `.claude/rules/` — that write happens only in
 * FA3 (#696) AFTER operator approval. The rendered content lives inside each
 * proposal object; the engine never persists a rule file. The ONLY disk write
 * the engine performs is into the reconcile-candidates sidecar (via
 * idempotency.mjs), and even that is skipped under `dryRun`.
 *
 * ── never-throws contract ────────────────────────────────────────────────────
 * `runReconcile` NEVER throws to its caller. A per-learning emit/render failure
 * degrades to a recorded rejection (never a crash); any unexpected top-level
 * error returns a zeroed result with an `error` field.
 *
 * Plain Node ESM, no external deps — Node 20+ stdlib + the four siblings only.
 *
 * Part of Epic #693 → issue #695 (FA2 Reconciliation Engine).
 *
 * @typedef {Object} ReconcileProposal
 * @property {string} learningKey  - the logical learning key (from the emitter metadata).
 * @property {string} slug         - the `.claude/rules/<slug>.md` slug.
 * @property {string} path         - the intended repo-relative rule path (NOT written).
 * @property {string} content      - the rendered rule markdown (NOT written).
 * @property {number} confidence   - the learning's confidence.
 * @property {string} candidateId  - the deterministic sidecar candidate id.
 * @property {'proposed'} status
 *
 * @typedef {Object} ReconcileRejection
 * @property {string|null} learningKey - best-effort logical key, or null when underivable.
 * @property {string} type             - the learning's `type` (or 'unknown').
 * @property {string} reason           - the audit reason for rejection.
 * @property {'rejected'} status
 *
 * @typedef {Object} ReconcileSummary
 * @property {number} totalLearnings
 * @property {number} eligible
 * @property {number} proposed
 * @property {number} rejected
 * @property {boolean} written
 *
 * @typedef {Object} ReconcileResult
 * @property {ReconcileProposal[]} proposals
 * @property {ReconcileRejection[]} rejected
 * @property {ReconcileSummary} summary
 * @property {string} [error]  - present only when the never-throws top-level guard fired.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { migrateLegacyLearning, normalizeLearning } from '../learnings/schema.mjs';
import { filterEligible } from './eligibility.mjs';
import { toActivationMetadata } from './emitter.mjs';
import { renderRule } from './renderer.mjs';
import { makeCandidateId, mergeCandidates as realMergeCandidates } from './idempotency.mjs';

/** Default repo-relative location of the learnings corpus. */
const DEFAULT_LEARNINGS_PATH = '.orchestrator/metrics/learnings.jsonl';

/**
 * Build a fully-zeroed result (the empty / error shape). Touches no disk.
 * @param {string} [error]
 * @returns {ReconcileResult}
 */
function zeroedResult(error) {
  /** @type {ReconcileResult} */
  const result = {
    proposals: [],
    rejected: [],
    summary: {
      totalLearnings: 0,
      eligible: 0,
      proposed: 0,
      rejected: 0,
      written: false,
    },
  };
  if (typeof error === 'string') result.error = error;
  return result;
}

/**
 * Default learnings loader — read + parse `<repoRoot>/.orchestrator/metrics/learnings.jsonl`
 * line-by-line, migrate/normalize records through the learnings schema SSOT,
 * and skip blank/malformed lines. A missing file yields `[]`. Never throws (a
 * read error degrades to `[]`).
 *
 * @param {string|undefined} repoRoot
 * @returns {Array<Record<string, unknown>>}
 */
function defaultLoadLearnings(repoRoot) {
  const root = typeof repoRoot === 'string' && repoRoot.length > 0 ? repoRoot : process.cwd();
  const absPath = isAbsolute(DEFAULT_LEARNINGS_PATH)
    ? DEFAULT_LEARNINGS_PATH
    : join(root, DEFAULT_LEARNINGS_PATH);

  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch {
    return []; // ENOENT or any read error → empty corpus.
  }

  /** @type {Array<Record<string, unknown>>} */
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // skip malformed line
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      records.push(
        /** @type {Record<string, unknown>} */ (normalizeLearning(migrateLegacyLearning(parsed))),
      );
    }
  }
  return records;
}

/**
 * Best-effort logical key for a REJECTED learning (rejections never run the
 * emitter, so there is no metadata.learningKey). Mirrors the emitter's key
 * shape `${type}/${kebab(subject||title)}` when both halves are present; falls
 * back to `null` when the type or subject/title is unusable. Never throws.
 *
 * @param {unknown} learning
 * @returns {string|null}
 */
function rejectedLearningKey(learning) {
  if (learning === null || typeof learning !== 'object' || Array.isArray(learning)) return null;
  const rec = /** @type {Record<string, unknown>} */ (learning);
  const type = typeof rec.type === 'string' && rec.type !== '' ? rec.type : '';
  const subjectOrTitle =
    (typeof rec.title === 'string' && rec.title !== '' ? rec.title : '') ||
    (typeof rec.subject === 'string' && rec.subject !== '' ? rec.subject : '');
  if (type === '' || subjectOrTitle === '') return null;
  const kebab = subjectOrTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${type}/${kebab}`;
}

/**
 * Resolve the `type` string of a (possibly malformed) learning for the rejected
 * record. Never throws.
 * @param {unknown} learning
 * @returns {string}
 */
function learningType(learning) {
  if (learning && typeof learning === 'object' && !Array.isArray(learning)) {
    const t = /** @type {Record<string, unknown>} */ (learning).type;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return 'unknown';
}

/**
 * Build a sidecar ReconcileCandidate line-record (idempotency.mjs schema) for a
 * proposed or rejected learning. `created_at` is stamped from the injectable
 * clock so output stays deterministic under test.
 *
 * @param {Object} params
 * @param {string} params.id
 * @param {string|null} params.learningKey
 * @param {string} params.slug
 * @param {'proposed'|'rejected'} params.status
 * @param {string} params.reason
 * @param {number} params.confidence
 * @param {string} params.createdAt - ISO timestamp.
 * @returns {import('./idempotency.mjs').ReconcileCandidate}
 */
function buildCandidate({ id, learningKey, slug, status, reason, confidence, createdAt }) {
  return {
    id,
    schema_version: 1,
    learning_key: typeof learningKey === 'string' ? learningKey : '',
    slug,
    status,
    reason,
    confidence,
    created_at: createdAt,
    processed_at: null,
    superseded_by: null,
  };
}

/**
 * Run the reconciliation engine.
 *
 * Composes the four leaf modules into the full proposal pipeline. NEVER throws —
 * per-learning failures degrade to recorded rejections; any unexpected
 * top-level error returns a zeroed result with an `error` field.
 *
 * The engine COMPUTES and RECORDS proposals; it NEVER writes `.claude/rules/`
 * (that is FA3 / #696, post-approval). Its only disk write is into the
 * reconcile-candidates sidecar (via the `merge` seam), skipped when `dryRun`.
 *
 * @param {Object} [params]
 * @param {string} [params.repoRoot]      - repo root; defaults to `process.cwd()` for the default loader/merge.
 * @param {number} [params.ruleExpiryDays]- explicit rule expiry window (passed to the emitter).
 * @param {number} [params.minRuleDays]   - floor window (days) applied to the emitted `expires-at`
 *        so it never falls in the past (forwarded to the emitter — see `emitter.mjs`
 *        `computeExpiresAt`). Defaults internally (7d) when omitted.
 * @param {number} [params.minInsightChars]- opt-in minimum insight length gating the
 *        eligibility placeholder-insight check (forwarded to `filterEligible`). Inert
 *        (no additional rejections) when omitted.
 * @param {number|Date} [params.now]      - injectable clock (emitter fallback + candidate `created_at`).
 * @param {boolean} [params.dryRun]       - when true, compute proposals but SKIP the merge entirely
 *        (also accepted as `opts.dryRun`; either location sets it).
 * @param {Object} [opts]                 - DI seams (all default to real behaviour).
 * @param {(repoRoot?: string) => Array<Record<string, unknown>>} [opts.loadLearnings]
 *        override the file read (REQUIRED for tests to avoid disk).
 * @param {Array<Record<string, unknown>>} [opts.learnings]
 *        direct learnings injection (takes precedence over `loadLearnings`).
 * @param {typeof realMergeCandidates} [opts.merge]
 *        override the sidecar merge (so tests never touch real `.orchestrator/runtime/`).
 * @param {boolean} [opts.dryRun]         - when true, compute proposals but SKIP the merge entirely.
 * @returns {Promise<ReconcileResult>}
 */
export async function runReconcile(
  { repoRoot, ruleExpiryDays, minRuleDays, minInsightChars, now, dryRun: dryRunParam } = {},
  opts = {},
) {
  try {
    // --- Resolve DI seams (real behaviour as defaults) ---------------------
    // dryRun may arrive in the first arg (acceptance criterion 1) OR in opts
    // (the documented DI seam) — either location flips it on.
    const dryRun = dryRunParam === true || opts.dryRun === true;
    const merge = typeof opts.merge === 'function' ? opts.merge : realMergeCandidates;

    // --- Pipeline step 1 — load learnings ----------------------------------
    /** @type {Array<Record<string, unknown>>} */
    let learnings;
    if (Array.isArray(opts.learnings)) {
      learnings = opts.learnings;
    } else if (typeof opts.loadLearnings === 'function') {
      learnings = opts.loadLearnings(repoRoot);
    } else {
      learnings = defaultLoadLearnings(repoRoot);
    }
    if (!Array.isArray(learnings)) learnings = [];

    const totalLearnings = learnings.length;

    // --- Pipeline step 2 — empty short-circuit (touches no disk) ------------
    if (totalLearnings === 0) {
      return zeroedResult();
    }

    // Deterministic created_at for sidecar records (honours injectable clock).
    const nowMs =
      now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now();
    const createdAt = new Date(nowMs).toISOString();

    // --- Pipeline step 3 — partition ---------------------------------------
    const { eligible, rejected: rejectedLearnings } = filterEligible(learnings, {
      now: nowMs,
      minInsightChars,
    });

    /** @type {ReconcileProposal[]} */
    const proposals = [];
    /** @type {ReconcileRejection[]} */
    const rejected = [];
    /** @type {import('./idempotency.mjs').ReconcileCandidate[]} */
    const candidates = [];

    // --- Pipeline step 4 — per eligible learning (wrapped per-item) ---------
    for (const learning of eligible) {
      try {
        const metadata = toActivationMetadata(learning, { ruleExpiryDays, now, minRuleDays });
        const { slug, path, content } = renderRule(learning, metadata);
        const candidateId = makeCandidateId(metadata.learningKey, slug);

        proposals.push({
          learningKey: metadata.learningKey,
          slug,
          path,
          content,
          confidence: metadata.confidence,
          candidateId,
          status: 'proposed',
        });

        candidates.push(
          buildCandidate({
            id: candidateId,
            learningKey: metadata.learningKey,
            slug,
            status: 'proposed',
            reason: 'reconciliation engine proposed a conditional rule',
            confidence: metadata.confidence,
            createdAt,
          }),
        );
      } catch (err) {
        // A single bad learning must not crash the run — degrade to a rejection.
        const msg = err && err.message ? err.message : String(err);
        const learningKey = rejectedLearningKey(learning);
        const reason = `emit/render error: ${msg}`;
        rejected.push({
          learningKey,
          type: learningType(learning),
          reason,
          status: 'rejected',
        });
        candidates.push(
          buildCandidate({
            id: makeCandidateId(learningKey ?? '', `rejected-${learningType(learning)}`),
            learningKey,
            slug: '',
            status: 'rejected',
            reason,
            confidence:
              learning && typeof learning === 'object' && typeof learning.confidence === 'number'
                ? learning.confidence
                : 0,
            createdAt,
          }),
        );
      }
    }

    // --- Pipeline step 5 — per rejected learning (eligibility rejects) ------
    for (const { learning, reason } of rejectedLearnings) {
      const learningKey = rejectedLearningKey(learning);
      const type = learningType(learning);
      rejected.push({
        learningKey,
        type,
        reason,
        status: 'rejected',
      });
      candidates.push(
        buildCandidate({
          id: makeCandidateId(learningKey ?? '', `rejected-${type}`),
          learningKey,
          slug: '',
          status: 'rejected',
          reason,
          confidence:
            learning && typeof learning === 'object' && typeof learning.confidence === 'number'
              ? learning.confidence
              : 0,
          createdAt,
        }),
      );
    }

    // --- Pipeline step 6 — record into the idempotency sidecar --------------
    // The engine's ONLY disk write — and it is skipped entirely under dryRun.
    // It never writes `.claude/rules/` (FA3 / #696 owns that, post-approval).
    let written = false;
    if (!dryRun) {
      try {
        const mergeResult = merge({ candidates, repoRoot });
        written = !!(mergeResult && mergeResult.written === true);
      } catch {
        // Merge failure is non-fatal; proposals still returned, written stays false.
        written = false;
      }
    }

    // --- Pipeline step 7 — summary -----------------------------------------
    return {
      proposals,
      rejected,
      summary: {
        totalLearnings,
        eligible: eligible.length,
        proposed: proposals.length,
        rejected: rejected.length,
        written,
      },
    };
  } catch (err) {
    // never-throws top-level guard.
    const msg = err && err.message ? err.message : String(err);
    return zeroedResult(msg);
  }
}
