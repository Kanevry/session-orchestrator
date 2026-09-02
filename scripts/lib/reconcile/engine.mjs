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
 * @property {number} alreadyMaterialized - count of eligible learnings that were
 *        NOT proposed this run because they are already terminal — either the
 *        idempotency sidecar already carries a `processed_at` stamp for their
 *        `learning_key` (`isProcessed`), or a `.claude/rules/*.md` file already
 *        carries a matching `learning-key`/`learning-id` provenance marker
 *        (issue #484: 9 of 10 proposals in one run were exactly this). Runs
 *        BEFORE the `maxProposalsPerRun` volume brake so an already-materialized
 *        learning never consumes a new learning's quota. Same accounting pattern
 *        as `capped`: each one is ALSO counted inside `rejected`, and
 *        `totalLearnings === proposed + rejected` still holds unchanged.
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

import { readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { expandTilde } from '../common.mjs';
import { learningKeyOf } from '../learnings/kebab.mjs';
import { migrateLegacyLearning, normalizeLearning } from '../learnings/schema.mjs';
import { filterEligible } from './eligibility.mjs';
import { toActivationMetadata } from './emitter.mjs';
import { renderRule } from './renderer.mjs';
import {
  DEFAULT_STORE_PATH,
  buildCandidate,
  isProcessed,
  makeCandidateId,
  loadCandidates as realLoadCandidates,
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
      alreadyMaterialized: 0,
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
 * emitter, so there is no `metadata.learningKey`). Delegates to the shared
 * `learningKeyOf` — it must NOT merely "mirror" the emitter's shape, it has to
 * BE it: this key is written to `reconcile-candidates.jsonl` and folded into
 * `makeCandidateId`, so a learning that succeeds one run and is rejected the
 * next would otherwise appear in the sidecar under two identities and defeat
 * `isProcessed`/`mergeCandidates` dedupe. Returns `null` for an unkeyable
 * record. Never throws.
 *
 * @param {unknown} learning
 * @returns {string|null}
 */
function rejectedLearningKey(learning) {
  return learningKeyOf(learning);
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
 * Session Config placeholder convention: a path key whose committed value is a
 * marker that MUST be overridden host-locally (this repo ships
 * `plan-baseline-path: OVERRIDE-IN-owner.yaml` in CLAUDE.md — or AGENTS.md on
 * Codex CLI — § Session Config).
 * Treating the marker as a real path would create `./OVERRIDE-IN-owner.yaml/`.
 */
const PLACEHOLDER_PATH_RE = /^OVERRIDE-IN-/;

/**
 * Report that the `baseline` write-target was dropped for this run.
 *
 * stderr, never stdout — `scripts/lib/config.mjs` consumers parse stdout as JSON.
 * Same posture as {@link warnDroppedStoreRecords}: an attributable drop must be
 * VISIBLE, and a diagnostic must never become the failure it reports on.
 *
 * @param {string} reason
 */
function warnBaselineTargetDropped(reason) {
  try {
    console.warn(
      `⚠️  reconcile: target "baseline" DROPPED for this run — ${reason}. ` +
        `Resolution order is SO_BASELINE_PATH env > owner.yaml paths.baseline-path > ` +
        `committed plan-baseline-path. No baseline proposal is surfaced in the approval ` +
        `AUQ and nothing is written outside this repo; every other target is unaffected.`,
    );
  } catch {
    // A diagnostic must never become the failure it reports on.
  }
}

/**
 * Decide which reconcile targets can ACTUALLY be written this run (issue #1099).
 *
 * Two of the three no-op checks live here, upstream of both the approval AUQ and
 * the writer, because the important half is not the refused write — it is that
 * **the operator must never be asked to approve a write to a destination that
 * cannot exist.** A `baseline` target whose root is unresolvable, is still the
 * committed placeholder, or is not absolute is therefore dropped from the
 * effective list BEFORE proposals are surfaced. The third check (the root does
 * not exist on disk) belongs to `writer.mjs`, the only layer holding the
 * filesystem at write time.
 *
 * Pure and never-throws: it resolves nothing from disk and reads no env — the
 * caller passes the already-resolved `baselineRoot` (`config['plan-baseline-path']`,
 * which `scripts/lib/config.mjs` has already run through the full 3-tier chain).
 *
 * @param {{targets?: unknown, baselineRoot?: unknown}} [opts]
 * @returns {{targets: string[], baselineRoot: string|null, dropped: string[], reason: string|null}}
 *   `targets` — the effective list; `baselineRoot` — the ~-expanded root, or null
 *   when `baseline` is not in play; `dropped`/`reason` — the audit trail.
 */
export function resolveEffectiveTargets({ targets, baselineRoot } = {}) {
  const declared = Array.isArray(targets) ? targets.filter((t) => typeof t === 'string' && t.length > 0) : [];
  const list = [...new Set(declared.length > 0 ? declared : ['repo-local'])];

  if (!list.includes('baseline')) {
    return { targets: list, baselineRoot: null, dropped: [], reason: null };
  }

  const raw = typeof baselineRoot === 'string' ? baselineRoot.trim() : '';
  const expanded = raw === '' ? '' : expandTilde(raw);

  let reason = null;
  if (raw === '') {
    reason = 'no baseline path is configured on any tier';
  } else if (PLACEHOLDER_PATH_RE.test(raw)) {
    reason = `the committed placeholder "${raw}" was never overridden host-locally`;
  } else if (!isAbsolute(expanded)) {
    reason = `"${raw}" is not an absolute path after ~-expansion`;
  }

  if (reason === null) {
    return { targets: list, baselineRoot: expanded, dropped: [], reason: null };
  }

  warnBaselineTargetDropped(reason);
  return {
    targets: list.filter((t) => t !== 'baseline'),
    baselineRoot: null,
    dropped: ['baseline'],
    reason,
  };
}

/**
 * Default sidecar-candidate loader for the issue #484 idempotency dedupe
 * check (below, step 3a). Deliberately gated on `repoRoot` being a
 * caller-supplied, non-empty string — UNLIKE `defaultLoadLearnings` and
 * `realMergeCandidates`, this does NOT fall back to `process.cwd()` when
 * `repoRoot` is absent. Every existing engine test exercises this module via
 * `opts.learnings` with no `repoRoot`, precisely to avoid touching this repo's
 * OWN `.orchestrator/runtime/reconcile-candidates.jsonl`; a cwd fallback here
 * would silently read it. The disk-touching default is reserved for callers
 * that always pass an explicit `repoRoot` (the `/reconcile` skill resolves it
 * via `git rev-parse --show-toplevel`).
 * @param {string|undefined} repoRoot
 * @returns {{ records: import('./idempotency.mjs').ReconcileCandidate[] }}
 */
function defaultLoadCandidatesForDedupe(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return { records: [] };
  const { records } = realLoadCandidates({ repoRoot });
  return { records };
}

/** Frontmatter form emitted by renderer.mjs: `learning-key: <value>` (no backticks, no leading dash). */
const FRONTMATTER_LEARNING_KEY_RE = /^learning-key:\s*(.+)$/gm;
/** Provenance-body form emitted by renderer.mjs: `` - learning-key: `<value>` ``. */
const BODY_LEARNING_KEY_RE = /-\s*learning-key:\s*`([^`]+)`/g;
/** Provenance-body form emitted by renderer.mjs: `` - learning-id: `<value>` ``. */
const BODY_LEARNING_ID_RE = /-\s*learning-id:\s*`([^`]+)`/g;

/**
 * Scan `<repoRoot>/.claude/rules/*.md` for the provenance markers the
 * renderer stamps on every machine-generated rule — the frontmatter
 * `learning-key:` line and the body `## Provenance` block's `learning-key`/
 * `learning-id` bullets (`renderer.mjs`) — and return the two identity sets a
 * learning can already be materialized under. A learning whose derived
 * `learning_key` OR raw `.id` appears in either set already has a rule file
 * on disk: re-proposing it is the issue #484 defect (9 of 10 proposals in one
 * run were learnings a `.claude/rules/` file already covered).
 *
 * Gated the same way as {@link defaultLoadCandidatesForDedupe}: an absent
 * `repoRoot` yields empty sets rather than falling back to `process.cwd()`.
 * Never throws — a missing `.claude/rules/` dir or an unreadable file
 * degrades to "nothing materialized" for that source, never a crash.
 * @param {string|undefined} repoRoot
 * @returns {{ keys: Set<string>, ids: Set<string> }}
 */
function defaultReadMaterializedProvenance(repoRoot) {
  const keys = new Set();
  const ids = new Set();
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return { keys, ids };

  const rulesDir = join(repoRoot, '.claude', 'rules');
  let entries;
  try {
    entries = readdirSync(rulesDir);
  } catch {
    return { keys, ids }; // no rules dir yet → nothing materialized
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    let content;
    try {
      content = readFileSync(join(rulesDir, entry), 'utf8');
    } catch {
      continue; // unreadable file — skip it, do not fail the whole scan
    }
    for (const m of content.matchAll(FRONTMATTER_LEARNING_KEY_RE)) {
      const v = m[1].trim();
      if (v) keys.add(v);
    }
    for (const m of content.matchAll(BODY_LEARNING_KEY_RE)) {
      const v = m[1].trim();
      if (v) keys.add(v);
    }
    for (const m of content.matchAll(BODY_LEARNING_ID_RE)) {
      const v = m[1].trim();
      if (v && v !== 'n/a') ids.add(v);
    }
  }
  return { keys, ids };
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
 * @param {(repoRoot?: string) => { records: import('./idempotency.mjs').ReconcileCandidate[] }} [opts.loadCandidates]
 *        override the idempotency-sidecar read used by the issue #484 dedupe step (below,
 *        step 3a) — defaults to {@link defaultLoadCandidatesForDedupe} (repoRoot-gated, no
 *        cwd fallback; see that function's doc for why).
 * @param {(repoRoot?: string) => { keys: Set<string>, ids: Set<string> }} [opts.readMaterializedProvenance]
 *        override the `.claude/rules/` provenance scan used by the same dedupe step —
 *        defaults to {@link defaultReadMaterializedProvenance} (same repoRoot gate).
 * @param {boolean} [opts.dryRun]         - when true, compute proposals but SKIP the merge entirely.
 * @returns {Promise<ReconcileResult>}
 */
async function runReconcileInner(
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
    const loadCandidatesForDedupe =
      typeof opts.loadCandidates === 'function' ? opts.loadCandidates : defaultLoadCandidatesForDedupe;
    const readMaterializedProvenance =
      typeof opts.readMaterializedProvenance === 'function'
        ? opts.readMaterializedProvenance
        : defaultReadMaterializedProvenance;
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

    const confidenceOf = (l) =>
      l && typeof l === 'object' && typeof l.confidence === 'number' ? l.confidence : 0;

    /** @type {ReconcileProposal[]} */
    const proposals = [];
    /** @type {ReconcileRejection[]} */
    const rejected = [];
    /** @type {import('./idempotency.mjs').ReconcileCandidate[]} */
    const candidates = [];

    // --- Pipeline step 3a — idempotency + on-disk dedupe (issue #484) ------
    // Runs BEFORE the volume brake (step 3b) so an already-materialized
    // learning does not consume `maxProposalsPerRun` quota that a genuinely
    // new learning could use — the #484 defect measured on a real repo was
    // exactly this: 9 of 10 proposals in one run were learnings that already
    // had a `.claude/rules/` file on disk, crowding out the tenth new one.
    // Two independent sources both count as terminal, either is sufficient:
    //   - the idempotency sidecar already carries a `processed_at` stamp for
    //     this `learning_key` (`isProcessed`, previously computed but NEVER
    //     called from this module — the other half of #484);
    //   - a `.claude/rules/*.md` file already carries a matching
    //     `learning-key`/`learning-id` provenance marker, discovered by
    //     scanning disk directly (covers the case where a rule was written
    //     without ever going through this sidecar, e.g. hand-authored).
    const { records: existingCandidates } = loadCandidatesForDedupe(repoRoot) ?? { records: [] };
    const materialized = readMaterializedProvenance(repoRoot) ?? { keys: new Set(), ids: new Set() };

    /** @type {Array<Record<string, unknown>>} */
    const stillEligible = [];
    let alreadyMaterialized = 0;

    for (const learning of eligible) {
      const learningKey = rejectedLearningKey(learning);
      const learningId =
        learning &&
        typeof learning === 'object' &&
        typeof learning.id === 'string' &&
        learning.id.length > 0
          ? learning.id
          : null;

      const sidecarTerminal =
        learningKey !== null && isProcessed({ learning_key: learningKey }, existingCandidates);
      const onDisk =
        (learningKey !== null && materialized.keys.has(learningKey)) ||
        (learningId !== null && materialized.ids.has(learningId));

      if (!sidecarTerminal && !onDisk) {
        stillEligible.push(learning);
        continue;
      }

      alreadyMaterialized += 1;
      const type = learningType(learning);
      const reason = sidecarTerminal
        ? 'already processed — the idempotency sidecar already carries a terminal verdict for this learning-key'
        : 'already materialized — a .claude/rules/ file already carries this learning-key/learning-id';
      rejected.push({ learningKey, type, reason, status: 'rejected' });

      // Freshly discovered on-disk materialization (not yet reflected in the
      // sidecar): stamp it terminal now so a FUTURE run's `isProcessed()`
      // check catches it without re-scanning `.claude/rules/` every time.
      // Routed through the SAME `candidates` array + `merge()` call as every
      // other record produced this run (step 6 below), so — like everything
      // else here — it is skipped entirely under `dryRun`; this is not a
      // second write path.
      if (onDisk && !sidecarTerminal && learningKey !== null) {
        const stamped = buildCandidate({
          id: makeCandidateId(learningKey, `materialized-${type}`),
          learningKey,
          slug: '',
          status: 'proposed',
          reason,
          confidence: confidenceOf(learning),
          createdAt,
        });
        stamped.processed_at = createdAt;
        stamped.outcome = 'already-on-disk';
        candidates.push(stamped);
      }
    }

    // --- Pipeline step 3b — volume brake (#900 D) ---------------------------
    // Sort STILL-eligible learnings (post-dedupe) by confidence DESC (ties
    // keep their original, stable relative order) and keep only the top
    // `maxProposalsPerRun`. The rest are cut BEFORE they ever reach the
    // emitter — never proposed this run — and recorded as `capped`
    // rejections in step 4b below so a report stays honest about the cut
    // instead of silently dropping them.
    const sortedEligible = stillEligible
      .map((learning, index) => ({ learning, index }))
      .sort((a, b) => confidenceOf(b.learning) - confidenceOf(a.learning) || a.index - b.index)
      .map(({ learning }) => learning);
    const keptEligible = sortedEligible.slice(0, maxProposalsPerRun);
    const cappedEligible = sortedEligible.slice(maxProposalsPerRun);

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
      alreadyMaterialized,
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

/**
 * Ledger name of the reconcile run event (issue #1192). Catalogued in
 * `docs/events-schema.md`; `events-schema.mjs` needs no registration — it
 * validates the NAME shape only, and this name already satisfies it.
 */
export const RECONCILE_EVENT = 'orchestrator.reconcile.completed';

/** Clamp for the `reason` string on the abort path — a message can be long. */
const REASON_MAX_CHARS = 300;

/** The closed target enum `resolveEffectiveTargets` recognises. */
const KNOWN_TARGETS = ['repo-local', 'baseline'];

/**
 * Build the `orchestrator.reconcile.completed` payload from a finished run.
 *
 * Counter fields are written INCLUDING `0`: each was MEASURED over the whole
 * run, so a written zero is the payload (same contract as the vault-mirror run
 * event). The two absence-preserving exceptions are `store_records_dropped`
 * (absent ⇒ the candidate store was never inspected — dryRun, empty
 * short-circuit, error path) and `targets` (absent ⇒ the caller asserted no
 * target list). `aborted`/`reason` appear only when the never-throws guard
 * fired; their absence means "ran to the end", never "unknown".
 *
 * @param {ReconcileResult} result
 * @param {{ trigger?: string, targets?: string[], dryRun?: boolean, durationMs: number }} ctx
 * @returns {Record<string, unknown>}
 */
function buildReconcilePayload(result, ctx) {
  const summary = (result && result.summary) || {};
  /** @type {Record<string, unknown>} */
  const payload = {
    trigger: typeof ctx.trigger === 'string' && ctx.trigger.trim() !== '' ? ctx.trigger : 'unknown',
    dry_run: ctx.dryRun === true,
    learnings_total: summary.totalLearnings ?? 0,
    eligible: summary.eligible ?? 0,
    proposals: summary.proposed ?? 0,
    rejected: summary.rejected ?? 0,
    capped: summary.capped ?? 0,
    already_materialized: summary.alreadyMaterialized ?? 0,
    written: summary.written === true,
    duration_ms: ctx.durationMs,
  };
  // `targets` originates in operator-authored Session Config (`reconcile.targets`)
  // and is unbounded there. Allowlisted to the CLOSED enum `resolveEffectiveTargets`
  // recognises before it enters the ledger and the optional Clank webhook (Q2-F4):
  // anything else is not a target this engine can act on, so recording it would
  // be a verbatim echo of untrusted text, never a measurement. Omitted when empty.
  const targets = Array.isArray(ctx.targets)
    ? [...new Set(ctx.targets.filter((t) => KNOWN_TARGETS.includes(t)))]
    : [];
  if (targets.length > 0) payload.targets = targets;
  if (typeof summary.skipped === 'number') payload.store_records_dropped = summary.skipped;
  if (typeof result?.error === 'string' && result.error !== '') {
    payload.aborted = 'engine-error';
    payload.reason = result.error.slice(0, REASON_MAX_CHARS);
  }
  return payload;
}

/**
 * Record one reconcile run in the repo's event ledger — best-effort.
 *
 * Refuses the ambient `SO_PROJECT_DIR` destination when no `repoRoot` was
 * given: most engine tests call `runReconcile` without one, and a fallback
 * would append synthetic records to the operator's REAL fleet ledger on every
 * `npm test` (#1119, `scripts/lib/express-path.mjs`). Diagnostics on stderr.
 *
 * @param {ReconcileResult} result
 * @param {{ repoRoot?: string, trigger?: string, targets?: string[], dryRun?: boolean, durationMs: number }} ctx
 */
async function emitReconcileCompleted(result, ctx) {
  const { repoRoot } = ctx;
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    process.stderr.write(
      `reconcile: skipped ${RECONCILE_EVENT} — no repoRoot given; ` +
        'refusing the ambient SO_PROJECT_DIR destination (#1119).\n',
    );
    return;
  }
  const { emitEvent } = await import('../events.mjs');
  await emitEvent(RECONCILE_EVENT, buildReconcilePayload(result, ctx), { repoRoot });
}

/**
 * Public boundary: run the reconciliation pipeline and record the run.
 *
 * A thin WRAPPER, deliberately: the pipeline has three return points (empty
 * short-circuit, normal tail, never-throws catch), and an inline emit would
 * miss two of them — including the empty corpus and the error path, the two
 * runs an operator most needs recorded (`.claude/rules/host-resources.md`
 * § HR-105). Same shape as `runNarrativeMirror` + `mirrorNarrative` in
 * `scripts/lib/vault-status/narrative-mirror.mjs`.
 *
 * The emit is wrapped in try/catch because `emitEvent` THROWS
 * `EventValidationError` on an invalid record — without the catch, telemetry
 * would break this function's never-throws contract. The pipeline's result is
 * returned UNTOUCHED whether or not the ledger accepted the record.
 *
 * @param {Object} [params] - see {@link runReconcileInner}, plus:
 * @param {'skill'|'session-end'|'phase-skip'|string} [params.trigger] - which caller
 *        invoked this run; recorded ALWAYS (default `'unknown'`) so the per-trigger
 *        denominator is complete. Not read by the pipeline.
 * @param {string[]} [params.targets] - the caller's effective target list
 *        (`resolveEffectiveTargets`); recorded when non-empty, omitted otherwise.
 *        Not read by the pipeline.
 * @param {Object} [opts] - see {@link runReconcileInner}.
 * @returns {Promise<ReconcileResult>}
 */
export async function runReconcile(params = {}, opts = {}) {
  const t0 = Date.now();
  const result = await runReconcileInner(params, opts);
  try {
    await emitReconcileCompleted(result, {
      repoRoot: params.repoRoot,
      trigger: params.trigger,
      targets: params.targets,
      dryRun: params.dryRun === true || opts.dryRun === true,
      durationMs: Date.now() - t0,
    });
  } catch {
    // Best-effort telemetry — never the reason a reconcile run fails.
  }
  return result;
}
