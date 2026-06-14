/**
 * engine.mjs — C2 auto-repair ORCHESTRATOR for the Skill Self-Evolution
 * Foundation (Epic #643 → issue #647).
 *
 * This is the HEART of #647: it composes the five W2 leaf modules into a single
 * repair engine that implements the gate-per-artifact-type decision matrix
 * (autonomy × posture × gate × evidence). R5 blast-radius enforcement lives here
 * — the matrix is the load-bearing deliverable, not the file-write mechanics.
 *
 * COMPOSITION (the five siblings, all DI-injectable via `opts`):
 *   - candidate-intake.mjs       → extractCandidates    (pure transform)
 *   - idempotency.mjs            → mergeCandidates / markProcessed / isProcessed
 *                                   / loadCandidates    (store I/O + supersession)
 *   - blast-radius-classifier.mjs→ classifyTarget       (R5 posture/gate triple)
 *   - config-validation-gate.mjs → runConfigValidationGate (deterministic gate)
 *   - mr-opener.mjs              → openRepairMr          (MR/PR for prose targets)
 *
 * PIPELINE:
 *   extractCandidates(learnings, driftResult)
 *     → mergeCandidates (persist + supersede)
 *     → for each NON-processed candidate:
 *         classify → decide per matrix → act
 *
 * DECISION MATRIX (implemented EXACTLY — see the gherkins / matrix rows):
 *   floor      = config['skill-evolution']['evidence-floor']   (default 0.5)
 *   evidenceOk = Number.isFinite(c.evidence) && c.evidence >= floor   (fail-closed)
 *   posture    = classifyTarget(target).posture
 *
 *   1. autonomy 'off'                         → advisory-only  (ALWAYS) [R4,R5,R13,R14,R16]
 *   2. posture 'always-mr' (plugin/local/unknown):
 *        autonomy 'advisory' | 'autonomous-gated' → open-mr      [R1,R2,R3,R15]
 *   3. posture 'autonomous-gated' (local-config):
 *        autonomy 'advisory'                  → advisory-only  [R11,R12]
 *        autonomy 'autonomous-gated':
 *          gateGreen && evidenceOk            → autonomous-apply [R6 — the ONLY one]
 *          else                               → open-mr (carries failing-gate ctx) [R7..R10,R17]
 *
 * INVARIANTS (W4 asserts these):
 *   - autonomous-apply happens in EXACTLY the R6 condition. Nowhere else.
 *   - autonomy:off ⇒ every outcome advisory-only.
 *   - plugin-skill / local-skill ⇒ outcome ∈ {open-mr, advisory-only} ONLY.
 *   - gate not green ⇒ no autonomous-apply.
 *   - evidence < floor (or missing/NaN) ⇒ no autonomous-apply.
 *   - empty candidate set ⇒ outcomes:[], summary all-zero, touches no disk.
 *
 * CONTRACT: NEVER throws. Per-candidate logic is wrapped so one failure becomes a
 * `no-op` outcome (with detail) and the loop continues.
 *
 * Part of Epic #643 → issue #647 (C2 auto-repair engine).
 */

import { extractCandidates as realExtractCandidates } from './candidate-intake.mjs';
import {
  mergeCandidates as realMergeCandidates,
  markProcessed as realMarkProcessed,
  isProcessed as realIsProcessed,
} from './idempotency.mjs';
import { classifyTarget as realClassifyTarget } from './blast-radius-classifier.mjs';
import { runConfigValidationGate as realRunConfigValidationGate } from './config-validation-gate.mjs';
import { openRepairMr as realOpenRepairMr } from './mr-opener.mjs';

/**
 * @typedef {import('./candidate-intake.mjs').RepairCandidate} RepairCandidate
 */

/**
 * @typedef {'autonomous-apply'|'open-mr'|'advisory-only'|'no-op'} RepairDecision
 */

/**
 * @typedef {Object} RepairOutcome
 * @property {string} candidateId  The candidate's idempotency id.
 * @property {string} targetPath   Repo-relative path the repair targets.
 * @property {import('./blast-radius-classifier.mjs').TargetType} targetType
 *           The R5 blast-radius target type.
 * @property {RepairDecision} decision  The matrix decision applied.
 * @property {string} detail        Human-readable detail / reason for the decision.
 */

/**
 * @typedef {Object} RepairSummary
 * @property {number} autonomousApplied  Count of `autonomous-apply` outcomes.
 * @property {number} mrsOpened          Count of `open-mr` outcomes.
 * @property {number} advisories         Count of `advisory-only` outcomes.
 * @property {number} blocked            Count of `no-op` outcomes (errors/skips).
 * @property {number} total              Count of all outcomes emitted.
 */

/**
 * @typedef {Object} RepairEngineResult
 * @property {RepairOutcome[]} outcomes
 * @property {RepairSummary} summary
 */

const DEFAULT_EVIDENCE_FLOOR = 0.5;
const VALID_AUTONOMY = new Set(['off', 'advisory', 'autonomous-gated']);

/**
 * Default no-op logger. Replaced by `opts.log` when provided.
 * @param {string} _level
 * @param {string} _msg
 * @returns {void}
 */
function noopLog(_level, _msg) {
  /* intentionally empty — diagnostics are opt-in via opts.log */
}

/**
 * Read the `skill-evolution` sub-config from the parsed Session Config, applying
 * conservative, fail-closed defaults. An absent / malformed block yields the
 * safe default (`autonomy: 'off'`, floor 0.5, judge false).
 *
 * @param {Record<string, unknown>|null|undefined} config — full parsed Session Config.
 * @returns {{ autonomy: 'off'|'advisory'|'autonomous-gated', evidenceFloor: number, judge: boolean }}
 */
function readSkillEvolutionConfig(config) {
  const block =
    config && typeof config === 'object' && typeof config['skill-evolution'] === 'object'
      ? /** @type {Record<string, unknown>} */ (config['skill-evolution'])
      : {};

  const rawAutonomy = block.autonomy;
  const autonomy =
    typeof rawAutonomy === 'string' && VALID_AUTONOMY.has(rawAutonomy)
      ? /** @type {'off'|'advisory'|'autonomous-gated'} */ (rawAutonomy)
      : 'off'; // fail-closed default

  const rawFloor = block['evidence-floor'];
  // Coerce a stringified floor (e.g. an unparsed `evidence-floor: "0.9"`) so an
  // operator's intended stricter gate is honoured instead of silently reverting
  // to the default. null/undefined/empty/object → NaN → default (never 0).
  const coercedFloor =
    typeof rawFloor === 'number'
      ? rawFloor
      : typeof rawFloor === 'string' && rawFloor.trim() !== ''
        ? Number(rawFloor)
        : NaN;
  const evidenceFloor =
    Number.isFinite(coercedFloor) && coercedFloor >= 0 && coercedFloor <= 1
      ? coercedFloor
      : DEFAULT_EVIDENCE_FLOOR;

  const judge = block.judge === true;

  return { autonomy, evidenceFloor, judge };
}

/**
 * Default applyConfigRepair seam (CONSERVATIVE foundation-slice stub).
 *
 * For the foundation slice the actual local-config file MUTATION stays behind
 * this seam: applying a learning's prose `proposed_change` to a config artifact
 * is delicate and out of scope for the GATING deliverable. The default logs the
 * intended change and returns `{ ok: true, applied: false, reason }` so the
 * matrix GATING is fully exercised end-to-end while the real file-write is
 * deferred. W4 / later slices inject a real mutator here.
 *
 * @param {RepairCandidate} candidate — the local-config candidate to apply.
 * @returns {Promise<{ ok: boolean, applied: boolean, reason?: string }>}
 */
async function defaultApplyConfigRepair(candidate) {
  return {
    ok: true,
    applied: false,
    reason: `apply-seam stub — real mutation deferred for ${candidate?.target_path ?? 'unknown'}`,
  };
}

/**
 * Default buildDiff seam — derive a {@link RepairDiff} from a candidate for the
 * MR-opener. For prose targets the foundation slice ships NO synthesised content
 * (a hand-authored diff is out of scope), so the default carries only the
 * proposed change as `raw` context. The MR-opener degrades gracefully when
 * `content` is absent (it opens an MR describing the change without rewriting
 * the file). W4 / later slices inject a real differ.
 *
 * @param {RepairCandidate} candidate
 * @returns {{ content?: string, raw?: string }}
 */
function defaultBuildDiff(candidate) {
  const proposed = candidate && typeof candidate.proposed_change === 'string'
    ? candidate.proposed_change
    : '';
  return { raw: proposed };
}

/**
 * Decide the matrix outcome for a single classified candidate. Pure decision
 * function over (autonomy, posture, gateGreen, evidenceOk) — no I/O. Returns the
 * decision plus a short detail string. The CALLER performs the side effects
 * (gate run, apply, MR open) — this only encodes the matrix branching for
 * non-config postures. The config branch is handled in {@link decideAndAct}
 * because it must run the gate before deciding.
 *
 * @param {'off'|'advisory'|'autonomous-gated'} autonomy
 * @param {import('./blast-radius-classifier.mjs').Posture} posture
 * @returns {{ decision: 'open-mr'|'advisory-only'|'config-branch', detail: string }}
 */
function decideNonConfig(autonomy, posture) {
  // Row group 1 — autonomy off ⇒ advisory-only ALWAYS (every target type).
  if (autonomy === 'off') {
    return { decision: 'advisory-only', detail: 'autonomy off — advisory only (safe default)' };
  }

  // Row group 2 — prose targets (plugin-skill / local-skill / unknown) ⇒
  // always-mr posture. MR is the floor; never autonomous. [R1,R2,R3,R15]
  if (posture === 'always-mr') {
    return { decision: 'open-mr', detail: 'always-mr posture — prose target routed through MR' };
  }

  // Otherwise this is the autonomous-gated (local-config) posture — the caller
  // must run the gate to decide. Signalled via the 'config-branch' sentinel.
  return { decision: 'config-branch', detail: '' };
}

/**
 * Run the matrix decision for one candidate and perform the corresponding side
 * effect. NEVER throws — any failure degrades to a `no-op` outcome.
 *
 * @param {Object} ctx
 * @param {RepairCandidate} ctx.candidate
 * @param {string} ctx.repoRoot
 * @param {{ autonomy: 'off'|'advisory'|'autonomous-gated', evidenceFloor: number }} ctx.se
 * @param {boolean} ctx.dryRun
 * @param {Object} ctx.seams — resolved DI seams.
 * @returns {Promise<RepairOutcome>}
 */
async function decideAndAct({ candidate, repoRoot, se, dryRun, seams }) {
  const { autonomy, evidenceFloor: floor } = se;
  const candidateId = candidate.id;
  const targetPath = candidate.target_path;

  // --- R5 blast-radius classification --------------------------------------
  const classification = seams.classifyTarget(targetPath, { repoRoot });
  const { targetType, posture } = classification;

  // --- evidence gate (fail-closed: missing / NaN ⇒ false) ------------------
  const evidenceOk = Number.isFinite(candidate.evidence) && candidate.evidence >= floor;

  // --- matrix branch for off / always-mr -----------------------------------
  const branch = decideNonConfig(autonomy, posture);
  if (branch.decision === 'advisory-only') {
    return finishAdvisory({ candidate, candidateId, targetPath, targetType, dryRun, seams, detail: branch.detail });
  }
  if (branch.decision === 'open-mr') {
    return finishOpenMr({
      candidate, candidateId, targetPath, targetType, repoRoot, dryRun, seams,
      detail: branch.detail,
    });
  }

  // --- config-branch: posture 'autonomous-gated' (local-config) ------------
  // autonomy 'advisory' ⇒ advisory-only (never auto-applies/opens MR autonomously,
  // even when gate+evidence would qualify). [R11,R12]
  if (autonomy === 'advisory') {
    return finishAdvisory({
      candidate, candidateId, targetPath, targetType, dryRun, seams,
      detail: 'advisory autonomy on local-config — advisory only (no autonomous action)',
    });
  }

  // autonomy 'autonomous-gated' on local-config — run the gate, then decide.
  // Both branches of the try/catch assign these, so no initializer is needed.
  let gateGreen;
  let gateDetail;
  try {
    const gate = await seams.runConfigValidationGate({ repoRoot });
    gateGreen = gate && gate.ok === true;
    gateDetail = gateGreen ? 'config-validation gate green' : 'config-validation gate not green';
  } catch (err) {
    // Gate threw (a real gate never throws, but a mocked seam might). Fail-closed.
    gateGreen = false;
    gateDetail = `config-validation gate errored: ${err?.message ?? String(err)}`;
  }

  // R6 — the ONLY autonomous-apply row: gate green AND evidence ≥ floor.
  if (gateGreen && evidenceOk) {
    if (dryRun === true) {
      // Dry-run: preview only — do NOT mutate or stamp.
      return {
        candidateId,
        targetPath,
        targetType,
        decision: 'autonomous-apply',
        detail: 'dry-run preview',
      };
    }
    // Real autonomous apply: applyConfigRepair → markProcessed.
    try {
      const applyResult = await seams.applyConfigRepair(candidate);
      const stamp = seams.markProcessed({ id: candidateId, repoRoot });
      const applied = applyResult && applyResult.applied === true;
      const stampOk = stamp && stamp.ok === true;
      const detailParts = [
        `gate green + evidence ${candidate.evidence} ≥ ${floor}`,
        applied ? 'applied' : `apply deferred (${applyResult?.reason ?? 'seam stub'})`,
        stampOk ? 'marked processed' : `markProcessed: ${stamp?.reason ?? 'unknown'}`,
      ];
      return {
        candidateId,
        targetPath,
        targetType,
        decision: 'autonomous-apply',
        detail: detailParts.join('; '),
      };
    } catch (err) {
      // Apply/stamp threw — degrade to no-op so the loop continues.
      return {
        candidateId,
        targetPath,
        targetType,
        decision: 'no-op',
        detail: `autonomous-apply errored: ${err?.message ?? String(err)}`,
      };
    }
  }

  // Else — gate fail OR evidence below floor OR gate un-evaluable ⇒ open-mr
  // (fallback; the MR carries the failing-gate context). [R7,R8,R9,R10,R17]
  const fallbackDetail = `fallback to MR — ${gateDetail}; evidence ${
    evidenceOk ? `≥ ${floor}` : `below ${floor} (or missing)`
  }`;
  return finishOpenMr({
    candidate, candidateId, targetPath, targetType, repoRoot, dryRun, seams,
    detail: fallbackDetail,
  });
}

/**
 * Build an `advisory-only` outcome.
 * @returns {RepairOutcome}
 */
function finishAdvisory({ candidateId, targetPath, targetType, detail }) {
  return { candidateId, targetPath, targetType, decision: 'advisory-only', detail };
}

/**
 * Open an MR for the candidate via the mr-opener seam, mapping its result to a
 * matrix outcome. NEVER throws (the seam itself never throws, but we guard the
 * call anyway). An MR opener `advisory`/`blocked` action maps to `advisory-only`
 * / `no-op` respectively, with the opener's reason carried into `detail`.
 *
 * @returns {Promise<RepairOutcome>}
 */
async function finishOpenMr({ candidate, candidateId, targetPath, targetType, repoRoot, dryRun, seams, detail }) {
  let diff;
  try {
    diff = seams.buildDiff(candidate);
  } catch (err) {
    return {
      candidateId, targetPath, targetType,
      decision: 'no-op',
      detail: `buildDiff errored: ${err?.message ?? String(err)}`,
    };
  }

  let result;
  try {
    result = await seams.openRepairMr(
      { candidate, diff, repoRoot, dryRun },
      { log: seams.log },
    );
  } catch (err) {
    return {
      candidateId, targetPath, targetType,
      decision: 'no-op',
      detail: `openRepairMr errored: ${err?.message ?? String(err)}`,
    };
  }

  const action = result && typeof result.action === 'string' ? result.action : 'advisory';
  const reason = result && typeof result.reason === 'string' ? result.reason : '';
  const combined = reason ? `${detail} → ${reason}` : detail;

  if (action === 'mr-opened') {
    const url = result.mrUrl ? ` (${result.mrUrl})` : '';
    return { candidateId, targetPath, targetType, decision: 'open-mr', detail: `${combined}${url}` };
  }
  if (action === 'advisory') {
    return { candidateId, targetPath, targetType, decision: 'open-mr', detail: combined };
  }
  // action === 'blocked' (gate failure inside the opener) → no-op.
  return { candidateId, targetPath, targetType, decision: 'no-op', detail: `blocked: ${combined}` };
}

/**
 * Run the C2 auto-repair engine.
 *
 * Composes the five W2 leaf modules into the gate-per-artifact-type decision
 * matrix. NEVER throws — per-candidate failures degrade to `no-op` outcomes.
 *
 * @param {Object} params
 * @param {string} params.repoRoot — absolute path to the repo root.
 * @param {Record<string, unknown>|null} [params.config] — full parsed Session Config
 *        (the engine reads `config['skill-evolution']`).
 * @param {Array<Record<string, unknown>>} [params.learnings] — `/evolve` learning records.
 * @param {{ status?: string, errors?: Array<Record<string, unknown>> }|null} [params.driftResult]
 *        claude-md-drift-check output.
 * @param {boolean} [params.dryRun=false] — when true, no mutation/MR/stamp; previews only.
 * @param {Object} [opts] — DI seams (all default to the real sibling functions).
 * @param {typeof realExtractCandidates} [opts.extractCandidates]
 * @param {typeof realMergeCandidates} [opts.mergeCandidates]
 * @param {typeof realMarkProcessed} [opts.markProcessed]
 * @param {typeof realIsProcessed} [opts.isProcessed]
 * @param {typeof realClassifyTarget} [opts.classifyTarget]
 * @param {typeof realRunConfigValidationGate} [opts.runConfigValidationGate]
 * @param {typeof realOpenRepairMr} [opts.openRepairMr]
 * @param {(candidate: RepairCandidate) => Promise<{ok:boolean, applied:boolean, reason?:string}>} [opts.applyConfigRepair]
 * @param {(candidate: RepairCandidate) => { content?: string, raw?: string }} [opts.buildDiff]
 * @param {(level: string, msg: string) => void} [opts.log]
 * @returns {Promise<RepairEngineResult>}
 */
export async function runRepairEngine(
  { repoRoot, config, learnings = [], driftResult = null, dryRun = false } = {},
  opts = {},
) {
  // --- Resolve DI seams (real siblings as defaults) ------------------------
  const seams = {
    extractCandidates:
      typeof opts.extractCandidates === 'function' ? opts.extractCandidates : realExtractCandidates,
    mergeCandidates:
      typeof opts.mergeCandidates === 'function' ? opts.mergeCandidates : realMergeCandidates,
    markProcessed:
      typeof opts.markProcessed === 'function' ? opts.markProcessed : realMarkProcessed,
    isProcessed: typeof opts.isProcessed === 'function' ? opts.isProcessed : realIsProcessed,
    classifyTarget:
      typeof opts.classifyTarget === 'function' ? opts.classifyTarget : realClassifyTarget,
    runConfigValidationGate:
      typeof opts.runConfigValidationGate === 'function'
        ? opts.runConfigValidationGate
        : realRunConfigValidationGate,
    openRepairMr: typeof opts.openRepairMr === 'function' ? opts.openRepairMr : realOpenRepairMr,
    applyConfigRepair:
      typeof opts.applyConfigRepair === 'function' ? opts.applyConfigRepair : defaultApplyConfigRepair,
    buildDiff: typeof opts.buildDiff === 'function' ? opts.buildDiff : defaultBuildDiff,
    log: typeof opts.log === 'function' ? opts.log : noopLog,
  };

  const se = readSkillEvolutionConfig(config);

  /** @type {RepairOutcome[]} */
  const outcomes = [];
  const summary = { autonomousApplied: 0, mrsOpened: 0, advisories: 0, blocked: 0, total: 0 };

  // --- Pipeline step 1 — intake (pure transform) ---------------------------
  let candidates;
  try {
    candidates = seams.extractCandidates({
      learnings,
      driftResult,
      repoRoot,
      evidenceFloor: se.evidenceFloor,
    });
  } catch (err) {
    seams.log('error', `engine: extractCandidates threw — ${err?.message ?? err}`);
    candidates = [];
  }
  if (!Array.isArray(candidates)) candidates = [];

  // Empty candidate set ⇒ outcomes:[], summary all-zero, touches no disk.
  if (candidates.length === 0) {
    return { outcomes, summary };
  }

  // --- Pipeline step 2 — merge (persist + supersede) -----------------------
  try {
    seams.mergeCandidates({ candidates, repoRoot });
  } catch (err) {
    seams.log('error', `engine: mergeCandidates threw — ${err?.message ?? err}`);
    // Persistence failure is non-fatal: continue with the in-memory candidates.
  }

  // --- Pipeline step 3 — per-candidate classify → decide → act -------------
  for (const candidate of candidates) {
    // Guard a malformed candidate (no id / target_path) → no-op.
    if (!candidate || typeof candidate.id !== 'string' || typeof candidate.target_path !== 'string') {
      outcomes.push({
        candidateId: candidate?.id ?? '(unknown)',
        targetPath: candidate?.target_path ?? '(unknown)',
        targetType: 'unknown',
        decision: 'no-op',
        detail: 'malformed candidate (missing id/target_path)',
      });
      continue;
    }

    // Skip candidates already processed (idempotency). Both branches assign.
    let processed;
    try {
      processed = seams.isProcessed({ id: candidate.id, repoRoot });
    } catch (err) {
      seams.log('error', `engine: isProcessed threw — ${err?.message ?? err}`);
      processed = false;
    }
    if (processed) {
      outcomes.push({
        candidateId: candidate.id,
        targetPath: candidate.target_path,
        targetType: 'unknown',
        decision: 'no-op',
        detail: 'already processed (idempotent skip)',
      });
      continue;
    }

    // Decide + act (never throws — degrades to no-op internally).
    let outcome;
    try {
      outcome = await decideAndAct({ candidate, repoRoot, se, dryRun, seams });
    } catch (err) {
      outcome = {
        candidateId: candidate.id,
        targetPath: candidate.target_path,
        targetType: 'unknown',
        decision: 'no-op',
        detail: `engine: decideAndAct threw — ${err?.message ?? String(err)}`,
      };
    }
    outcomes.push(outcome);
  }

  // --- Summary tally -------------------------------------------------------
  for (const o of outcomes) {
    summary.total += 1;
    if (o.decision === 'autonomous-apply') summary.autonomousApplied += 1;
    else if (o.decision === 'open-mr') summary.mrsOpened += 1;
    else if (o.decision === 'advisory-only') summary.advisories += 1;
    else summary.blocked += 1; // 'no-op'
  }

  return { outcomes, summary };
}
