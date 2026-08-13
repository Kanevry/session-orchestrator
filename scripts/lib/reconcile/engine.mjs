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
 * @property {number} capped   - count of eligible learnings that were NOT proposed
 *        this run purely because of the `maxProposalsPerRun` volume brake (issue
 *        #900 D — confidence-sorted, lowest-confidence entries cut first). Each
 *        capped learning is ALSO counted inside `rejected` (with a `capped — ...`
 *        reason) — `totalLearnings === proposed + rejected` still holds unchanged;
 *        `capped` is a diagnostic sub-count that lets a report distinguish
 *        "genuinely ineligible" rejections from "eligible but cut by the volume
 *        brake" ones at a glance.
 * @property {boolean} written
 * @property {number} [skipped] - how many persisted sidecar lines the store's
 *        read-side shape guard rejected and this run therefore DROPPED from disk
 *        (`mergeCandidates` rewrites the store in full, never appends — see
 *        `idempotency.mjs`). PRESENT-vs-ABSENT is load-bearing and must not be
 *        collapsed: `0` means "the store was inspected and nothing was dropped",
 *        while ABSENCE means "the store was never inspected this run" — the case
 *        under `dryRun` (merge skipped entirely), on the empty short-circuit, on
 *        the top-level error path, and when the merge seam reports no count.
 *        Defaulting the absent case to `0` would be a false all-clear.
 *
 * @typedef {Object} ReconcileResult
 * @property {ReconcileProposal[]} proposals
 * @property {ReconcileRejection[]} rejected
 * @property {ReconcileSummary} summary
 * @property {string} [error]  - present only when the never-throws top-level guard fired.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { kebab } from '../learnings/kebab.mjs';
import { migrateLegacyLearning, normalizeLearning } from '../learnings/schema.mjs';
import { filterEligible } from './eligibility.mjs';
import { toActivationMetadata } from './emitter.mjs';
import { renderRule } from './renderer.mjs';
import {
  DEFAULT_STORE_PATH,
  buildCandidate,
  makeCandidateId,
  mergeCandidates as realMergeCandidates,
} from './idempotency.mjs';

/** Default repo-relative location of the learnings corpus. */
const DEFAULT_LEARNINGS_PATH = '.orchestrator/metrics/learnings.jsonl';

/**
 * Default volume brake (issue #900 D) — mirrors the `reconcile.max-proposals-
 * per-run` Session Config default in `scripts/lib/config/reconcile.mjs`. Applied
 * even when a caller omits `maxProposalsPerRun` entirely, so the engine never
 * silently proposes an unbounded number of rules in one run.
 */
const DEFAULT_MAX_PROPOSALS_PER_RUN = 10;

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
      capped: 0,
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
  return `${type}/${kebab(subjectOrTitle)}`;
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
 * Surface a shape-guard drop on stderr. The sidecar is a mutable work-queue that
 * `mergeCandidates` rewrites in FULL, so a record the read-side shape guard
 * rejects is not merely ignored — it is gone from disk after this run. The count
 * alone makes that loss attributable; this WARN is what makes it VISIBLE, since
 * the summary field only helps a caller that thinks to read it.
 *
 * Never throws: a failing diagnostic must not break the never-throws contract of
 * {@link runReconcile} (a broken stderr pipe would otherwise zero the result).
 *
 * @param {number} skipped - drop count (> 0 by the time this is called).
 * @returns {void}
 */
function warnDroppedStoreRecords(skipped) {
  try {
    console.warn(
      `⚠️  reconcile: ${skipped} record(s) in ${DEFAULT_STORE_PATH} failed the ` +
        `candidate shape guard and were DROPPED by this merge — the store is ` +
        `rewritten in full, so they are no longer on disk. Expected shape: a ` +
        `ReconcileCandidate with \`learning_key\` + \`created_at\` (see ` +
        `scripts/lib/reconcile/idempotency.mjs). Only \`mergeCandidates\` may ` +
        `write this store; hand-written or report records do not belong in it.`,
    );
  } catch {
    // A diagnostic must never become the failure it reports on.
  }
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
 * @param {number} [params.maxProposalsPerRun] - volume brake (issue #900 D): after
 *        sorting eligible learnings by confidence DESC, only the top N are proposed;
 *        the rest are recorded as `capped` rejections. Defaults to
 *        {@link DEFAULT_MAX_PROPOSALS_PER_RUN} (10) when omitted, non-finite, or < 1
 *        — the brake is ALWAYS active, matching the Session Config default.
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
  {
    repoRoot,
    ruleExpiryDays,
    minRuleDays,
    minInsightChars,
    now,
    maxProposalsPerRun: maxProposalsPerRunParam,
    dryRun: dryRunParam,
  } = {},
  opts = {},
) {
  try {
    // --- Resolve DI seams (real behaviour as defaults) ---------------------
    // dryRun may arrive in the first arg (acceptance criterion 1) OR in opts
    // (the documented DI seam) — either location flips it on.
    const dryRun = dryRunParam === true || opts.dryRun === true;
    const merge = typeof opts.merge === 'function' ? opts.merge : realMergeCandidates;
    // Volume brake (#900 D) — always active; a missing/invalid override falls
    // back to the same default the Session Config parser uses.
    const maxProposalsPerRun =
      Number.isFinite(maxProposalsPerRunParam) && maxProposalsPerRunParam >= 1
        ? Math.floor(maxProposalsPerRunParam)
        : DEFAULT_MAX_PROPOSALS_PER_RUN;

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

    // --- Pipeline step 3b — volume brake (#900 D) ---------------------------
    // Sort eligible learnings by confidence DESC (ties keep their original,
    // stable relative order) and keep only the top `maxProposalsPerRun`. The
    // rest are cut BEFORE they ever reach the emitter — never proposed this
    // run — and recorded as `capped` rejections in step 4b below so a report
    // stays honest about the cut instead of silently dropping them.
    const confidenceOf = (l) =>
      l && typeof l === 'object' && typeof l.confidence === 'number' ? l.confidence : 0;
    const sortedEligible = eligible
      .map((learning, index) => ({ learning, index }))
      .sort((a, b) => confidenceOf(b.learning) - confidenceOf(a.learning) || a.index - b.index)
      .map(({ learning }) => learning);
    const keptEligible = sortedEligible.slice(0, maxProposalsPerRun);
    const cappedEligible = sortedEligible.slice(maxProposalsPerRun);

    /** @type {ReconcileProposal[]} */
    const proposals = [];
    /** @type {ReconcileRejection[]} */
    const rejected = [];
    /** @type {import('./idempotency.mjs').ReconcileCandidate[]} */
    const candidates = [];

    // --- Pipeline step 4 — per eligible learning (wrapped per-item) ---------
    for (const learning of keptEligible) {
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

    // --- Pipeline step 4b — capped-eligible learnings (#900 D) --------------
    // Learnings that passed eligibility but were cut by the volume brake are
    // NEVER passed to the emitter — recorded directly as rejections (with a
    // `capped — ...` reason) so a report distinguishes this from a genuine
    // ineligibility rejection.
    for (const learning of cappedEligible) {
      const learningKey = rejectedLearningKey(learning);
      const type = learningType(learning);
      const reason = `capped — max-proposals-per-run (${maxProposalsPerRun}) reached; ${cappedEligible.length} lower-confidence eligible learning(s) not proposed this run`;
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
          confidence: confidenceOf(learning),
          createdAt,
        }),
      );
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
    // `undefined` (NOT 0) until the merge actually inspects the store — absence
    // means "not checked", 0 means "checked, nothing dropped". See the
    // ReconcileSummary `skipped` typedef.
    /** @type {number|undefined} */
    let skipped;
    if (!dryRun) {
      try {
        const mergeResult = merge({ candidates, repoRoot });
        written = !!(mergeResult && mergeResult.written === true);
        // Only a finite count from the seam counts as "inspected". A merge seam
        // that reports nothing leaves `skipped` absent rather than fabricating 0.
        if (mergeResult && Number.isFinite(mergeResult.skipped)) {
          skipped = Number(mergeResult.skipped);
        }
      } catch {
        // Merge failure is non-fatal; proposals still returned, written stays
        // false and `skipped` stays absent (the store was never inspected).
        written = false;
      }
    }

    // Make an attributable drop VISIBLE, not merely recorded (WARN, never throw).
    if (typeof skipped === 'number' && skipped > 0) warnDroppedStoreRecords(skipped);

    // --- Pipeline step 7 — summary -----------------------------------------
    /** @type {ReconcileSummary} */
    const summary = {
      totalLearnings,
      eligible: eligible.length,
      proposed: proposals.length,
      rejected: rejected.length,
      capped: cappedEligible.length,
      written,
    };
    // Additive + absence-preserving: the key exists ONLY when the store was
    // actually inspected, so no consumer can read a false `skipped: 0`.
    if (typeof skipped === 'number') summary.skipped = skipped;

    return { proposals, rejected, summary };
  } catch (err) {
    // never-throws top-level guard.
    const msg = err && err.message ? err.message : String(err);
    return zeroedResult(msg);
  }
}
