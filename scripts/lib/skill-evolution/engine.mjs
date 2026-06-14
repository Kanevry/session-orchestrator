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

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

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
 * The ONE supported autonomous-apply shape (Option A — re-derive from prose).
 * Anchored to the `command-count` `proposed_change` template emitted by
 * candidate-intake.mjs (`Update narrative '<N> commands' to actual <M>`).
 * Both numbers are embedded in the prose string; capturing them avoids a
 * candidate-schema change. Anything that does not match is OUT OF WHITELIST.
 * @type {RegExp}
 */
const COMMAND_COUNT_SHAPE = /'(\d+)\s+commands'\s+to\s+actual\s+(\d+)/;

/**
 * The string a not-yet-applied unsupported shape returns as its `reason`. The
 * engine narrowly matches `/unsupported-shape/` against this to re-route to the
 * MR path (rather than silently stamping a candidate it cannot apply).
 */
const UNSUPPORTED_SHAPE_REASON = 'unsupported-shape — out of whitelist';

/**
 * Parse the whitelisted command-count shape out of a candidate's PROSE
 * `proposed_change`. Returns the claimed (narrative) and actual (filesystem)
 * counts, or `null` when the prose is not the supported shape.
 * @param {RepairCandidate} candidate
 * @returns {{ claimedN: number, actualM: number } | null}
 */
function parseCommandCountShape(candidate) {
  const proposed =
    candidate && typeof candidate.proposed_change === 'string' ? candidate.proposed_change : '';
  const m = COMMAND_COUNT_SHAPE.exec(proposed);
  if (!m) return null;
  return { claimedN: Number(m[1]), actualM: Number(m[2]) };
}

/**
 * Resolve a candidate's `target_path` against `repoRoot` with a fail-closed
 * repo-escape guard (mirrors mr-opener.mjs Step 3 + blast-radius-classifier.mjs).
 * Returns the absolute path when the target is genuinely inside the repo, or
 * `null` when it escapes / is the root itself / inputs are unusable.
 * @param {string} repoRoot
 * @param {string} targetPath
 * @returns {string|null}
 */
function resolveInsideRepo(repoRoot, targetPath) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  if (typeof targetPath !== 'string' || targetPath.length === 0) return null;
  const abs = path.resolve(repoRoot, targetPath);
  const rel = path.relative(repoRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * Apply the command-count number swap to file content. Finds the FIRST narrative
 * occurrence of `<claimedN>` immediately preceding a `commands` token (tolerating
 * the `/commands` and `slash commands` narrative variants the drift-check matches
 * via `/\b(\d+)\s+(?:\/)?commands?\b/`, and an optional wrapping single-quote),
 * and replaces ONLY that leading number with `actualM`. Every other byte — and
 * the `commands` token itself — is preserved verbatim.
 *
 * Returns the rewritten content, or `null` when no occurrence is found OR the
 * narrative number already equals `actualM` (idempotent no-op).
 * @param {string} content
 * @param {number} claimedN
 * @param {number} actualM
 * @returns {string|null}
 */
function applyCommandCountSwap(content, claimedN, actualM) {
  if (typeof content !== 'string' || content.length === 0) return null;
  if (claimedN === actualM) return null; // already current — no-op
  // Anchor on the claimed number followed by the (drift-check-shaped) commands
  // token. \b before the number prevents matching a substring of a larger int
  // (e.g. claimedN=8 must not match inside "18 commands"). The number group is
  // the only segment we replace; the trailing token group is re-emitted as-is.
  const swapRe = new RegExp(`\\b${claimedN}(\\s+(?:/|slash\\s+)?commands?\\b)`);
  if (!swapRe.test(content)) return null; // claimed text not found — no-op
  return content.replace(swapRe, `${actualM}$1`);
}

/**
 * Default applyConfigRepair seam — the REAL autonomous mutator (issue #651).
 *
 * Implements the §C2-G2 contract for the whitelisted `command-count` drift
 * shape ONLY. Every step is defense-in-depth + idempotent:
 *   1. Repo-escape guard: resolve target inside `repoRoot`; escape ⇒ no-op.
 *   2. Whitelist: parse the command-count shape from PROSE; miss ⇒
 *      `unsupported-shape` (the engine re-routes that to an MR — never stamps).
 *   3. Mutation: swap the ONE narrative number, atomically (tmp + rename),
 *      content-level idempotent (already-current / text-absent ⇒ no write).
 *
 * NEVER throws — every error path degrades to `{ ok: true, applied: false }`.
 * Does NOT stamp `processed_at`; the engine owns the G2 stamp.
 *
 * @param {RepairCandidate} candidate — the local-config candidate to apply.
 * @param {string} [repoRoot] — repo root for path resolution (engine injects it).
 * @returns {Promise<{ ok: boolean, applied: boolean, reason?: string }>}
 */
async function defaultApplyConfigRepair(candidate, repoRoot) {
  // Step 1 — repo-escape guard (fail-closed; mirrors mr-opener.mjs L353-361).
  const abs = resolveInsideRepo(repoRoot, candidate?.target_path);
  if (abs === null) {
    return { ok: true, applied: false, reason: 'target escapes repo' };
  }

  // Step 2 — whitelist gate. Only the command-count shape may auto-apply.
  const parsed = parseCommandCountShape(candidate);
  if (parsed === null) {
    return { ok: true, applied: false, reason: UNSUPPORTED_SHAPE_REASON };
  }
  const { claimedN, actualM } = parsed;

  // Step 3 — scoped, minimal, idempotent mutation (atomic write-back).
  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: true, applied: false, reason: `read failed: ${err?.message ?? String(err)}` };
  }

  const next = applyCommandCountSwap(content, claimedN, actualM);
  if (next === null || next === content) {
    return { ok: true, applied: false, reason: 'already-current (no-op)' };
  }

  try {
    const dir = path.dirname(abs);
    const tmpFile = path.join(dir, `.${path.basename(abs)}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(tmpFile, next, { encoding: 'utf8' });
    renameSync(tmpFile, abs);
  } catch (err) {
    return { ok: true, applied: false, reason: `write failed: ${err?.message ?? String(err)}` };
  }

  return { ok: true, applied: true };
}

/**
 * Default buildDiff seam — derive a {@link RepairDiff} from a candidate for the
 * MR-opener (issue #651). For the whitelisted `command-count` shape on a config
 * target it computes the FULL rewritten file content (same one-line swap as the
 * apply seam) so the MR-opener can write the change; otherwise — unsupported
 * prose shape, read error, or escape — it degrades to a `{ raw }`-only describe
 * MR (the MR-opener opens a description-only MR when `content` is absent).
 *
 * Synchronous and NEVER throws.
 *
 * @param {RepairCandidate} candidate
 * @param {string} [repoRoot] — repo root for path resolution (engine injects it).
 * @returns {{ content?: string, raw?: string }}
 */
function defaultBuildDiff(candidate, repoRoot) {
  const proposed =
    candidate && typeof candidate.proposed_change === 'string' ? candidate.proposed_change : '';

  const abs = resolveInsideRepo(repoRoot, candidate?.target_path);
  const parsed = parseCommandCountShape(candidate);
  if (abs === null || parsed === null) {
    return { raw: proposed };
  }
  const { claimedN, actualM } = parsed;

  let content;
  try {
    content = readFileSync(abs, 'utf8');
  } catch {
    return { raw: proposed };
  }

  const next = applyCommandCountSwap(content, claimedN, actualM);
  if (next === null || next === content) {
    // Already current / claimed text absent → nothing to rewrite; describe only.
    return { raw: proposed };
  }

  // Synthesise a minimal unified-diff preview of the one changed line. The
  // describe path (`raw`) names the exact old/new narrative lines for the MR body.
  const oldLine = `${claimedN} commands`;
  const newLine = `${actualM} commands`;
  const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
  return {
    content: next,
    raw: `--- a/${rel}\n+++ b/${rel}\n-${oldLine}\n+${newLine}\n`,
  };
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
      const applyResult = await seams.applyConfigRepair(candidate, repoRoot);
      const applied = applyResult && applyResult.applied === true;
      const applyReason = typeof applyResult?.reason === 'string' ? applyResult.reason : '';

      // Re-route NARROWLY: only when the apply was declined because the shape is
      // OUT OF WHITELIST do we open an MR (so the change is not silently
      // stamped-and-dropped). Every OTHER non-applied reason that WON'T change on
      // retry (already-current, target escapes repo) keeps the existing
      // stamp-and-return behaviour — and existing engine.test.mjs mocks (generic
      // results without an `unsupported-shape` reason) are unaffected.
      if (!applied && /unsupported-shape/.test(applyReason)) {
        return finishOpenMr({
          candidate, candidateId, targetPath, targetType, repoRoot, dryRun, seams,
          detail: `apply declined (${applyReason}) — routed to MR`,
        });
      }

      // TRANSIENT I/O failure (read/write): do NOT stamp (so the drift retries on
      // a future run once the FS issue clears) and do NOT count as an apply (so
      // telemetry isn't inflated by a buried failure). Degrade to a `no-op` that
      // surfaces the error reason. (#651 FIX 2 — silent-failure / telemetry-inflate)
      if (!applied && /read failed|write failed/i.test(applyReason)) {
        return {
          candidateId,
          targetPath,
          targetType,
          decision: 'no-op',
          detail: `autonomous-apply aborted — ${applyReason} (not stamped; will retry)`,
        };
      }

      const stamp = seams.markProcessed({ id: candidateId, repoRoot });
      const stampOk = stamp && stamp.ok === true;
      const detailParts = [
        `gate green + evidence ${candidate.evidence} ≥ ${floor}`,
        applied ? 'applied' : `apply deferred (${applyReason || 'seam stub'})`,
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
    diff = seams.buildDiff(candidate, repoRoot);
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
 * @param {(candidate: RepairCandidate, repoRoot?: string) => Promise<{ok:boolean, applied:boolean, reason?:string}>} [opts.applyConfigRepair]
 * @param {(candidate: RepairCandidate, repoRoot?: string) => { content?: string, raw?: string }} [opts.buildDiff]
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
