/**
 * session-end/phase-skip.mjs — Tail-Diät skip-plan aggregator (Issue #724).
 *
 * The session-end Phase 3.6.x tail (3.6.3 Memory-Proposals, 3.6.4 Expired-Sweep,
 * 3.6.5 Auto-Dream, 3.6.6 Skill-Judge, 3.6.7 Auto-Dialectic, 3.6.8 Reconcile) is
 * the close-out abort-attractor: six phases, each ~50 lines of coordinator prose,
 * that in the overwhelming majority of sessions do nothing (no proposals queued,
 * nothing expired, under cadence, judge off, reconcile off). This aggregator
 * computes — side-effect-free — WHICH of the six should actually run, so the
 * coordinator loads only the detail procedure for the `run: true` phases and
 * emits a one-line `skippedReport` for the rest.
 *
 * Every one of the six phases already ships a mechanical fast-path in its own lib
 * (a config kill-switch, an `existsSync` short-circuit, or a cadence/trigger
 * decision). This module WRAPS those existing signals — it never re-implements
 * their logic. Config gates run FIRST as the cheap short-circuit (no disk touch),
 * then the input-detection helpers run only when the config gate passed.
 *
 * Side-effect-free contract:
 *   - reads only (existsSync / read helpers); writes NOTHING.
 *   - reconcile runs with `dryRun: true` so the candidate sidecar is never written.
 *   - the sweep runs with `dryRun: true` (its default) so the store is untouched.
 *
 * Never-throws contract (mirrors the banner-probe posture): a failure while
 * probing a single phase degrades to `run: true` (fail-open) with a
 * `probe-error: …` reason — when in doubt, RUN the phase rather than silently
 * lose it. `planTailPhases` itself never throws to its caller.
 *
 * Plain Node ESM, no external deps — Node 20+ stdlib + the six read-only signal
 * helpers only.
 *
 * @typedef {Object} PhaseDecision
 * @property {string}  phase       - the phase id, e.g. '3.6.3'.
 * @property {boolean} run         - true → coordinator runs the detail procedure.
 * @property {string}  reason      - human-readable reason for the decision.
 * @property {string}  inputSource - which signal drove the decision
 *   ('config-gate' | 'proposals.jsonl' | 'sweep-dry-run' | 'auto-dream-signal' |
 *    'skill-invocations.jsonl' | 'auto-dialectic-signal' | 'reconcile-dry-run' |
 *    'learnings.jsonl' | 'probe-error').
 *
 * @typedef {Object} TailPlan
 * @property {PhaseDecision[]} plan
 * @property {string} skippedReport
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { collectProposals } from '../memory-proposals/collector.mjs';
import { sweepExpiredLearnings } from '../learnings/expiry-sweep.mjs';
import { shouldDispatchAutoDream } from '../auto-dream.mjs';
import { shouldDispatchAutoDialectic } from '../auto-dialectic.mjs';
import { readSkillInvocations } from '../skill-invocations-schema.mjs';
import { runReconcile } from '../reconcile/engine.mjs';
import { resolveMemoryDir } from '../memory-paths.mjs';

// ---------------------------------------------------------------------------
// Decision constructors
// ---------------------------------------------------------------------------

/**
 * @param {string} phase
 * @param {boolean} run
 * @param {string} reason
 * @param {string} inputSource
 * @returns {PhaseDecision}
 */
function decision(phase, run, reason, inputSource) {
  return { phase, run, reason, inputSource };
}

/** Skip decision. */
function mkSkip(phase, reason, inputSource) {
  return decision(phase, false, reason, inputSource);
}

/** Run decision. */
function mkRun(phase, reason, inputSource) {
  return decision(phase, true, reason, inputSource);
}

/**
 * Fail-open decision for a probe that threw. Runs the phase (never silently
 * loses it) and stamps a `probe-error: …` reason.
 */
function mkProbeError(phase, err) {
  const msg = err && err.message ? err.message : String(err);
  return decision(phase, true, `probe-error: ${msg}`, 'probe-error');
}

// ---------------------------------------------------------------------------
// Config / platform helpers
// ---------------------------------------------------------------------------

/** persistence is off only when explicitly `false`; absent → treated as on. */
function isPersistenceOff(cfg) {
  return cfg && cfg.persistence === false;
}

/**
 * MEMORY.md (Auto-Dream signal source) lives under `~/.claude/projects/` — a
 * Claude Code-only path. Absent platform → treated as Claude Code (the common
 * coordinator context); any explicit non-Claude platform gates 3.6.5 off.
 */
function isClaudePlatform(platform) {
  if (platform === undefined || platform === null || platform === '') return true;
  const p = String(platform).toLowerCase();
  return p === 'claude' || p === 'claude-code' || p === 'claudecode';
}

// ---------------------------------------------------------------------------
// Per-phase deciders — each wraps an EXISTING signal helper, config-gate first.
// ---------------------------------------------------------------------------

/**
 * 3.6.3 Memory-Proposals Collection (#501). Config gate (persistence,
 * memory.proposals.enabled) → then `collectProposals` (existsSync short-circuit
 * on proposals.jsonl → empty queue).
 */
async function decideMemoryProposals({ repoRoot, cfg }) {
  const phase = '3.6.3';
  try {
    if (isPersistenceOff(cfg)) return mkSkip(phase, 'persistence=false', 'config-gate');
    if (cfg?.memory?.proposals?.enabled === false) {
      return mkSkip(phase, 'memory.proposals.enabled=false', 'config-gate');
    }
    const { queue, stats } = await collectProposals({
      repoRoot,
      minConfidence: cfg?.['auto-dream']?.['min-confidence'],
    });
    if (!Array.isArray(queue) || queue.length === 0) {
      return mkSkip(phase, `proposals empty (queued=${stats?.queued ?? 0})`, 'proposals.jsonl');
    }
    return mkRun(phase, `${queue.length} proposal(s) queued`, 'proposals.jsonl');
  } catch (err) {
    return mkProbeError(phase, err);
  }
}

/**
 * 3.6.4 Expired-Learnings Sweep (Epic #723 B4). No config gate — best-effort,
 * non-blocking. `sweepExpiredLearnings` runs in `dryRun: true` (writes nothing):
 * archived === 0 → nothing to move → skip.
 */
async function decideExpiredSweep({ repoRoot }) {
  const phase = '3.6.4';
  try {
    const filePath = path.join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl');
    if (!existsSync(filePath)) return mkSkip(phase, 'learnings.jsonl absent', 'learnings.jsonl');
    const archivePath = path.join(
      repoRoot,
      '.orchestrator',
      'metrics',
      'learnings-archive.jsonl',
    );
    const res = await sweepExpiredLearnings({ filePath, archivePath, dryRun: true });
    if (!res || res.archived === 0) {
      return mkSkip(phase, `nothing archive-eligible (scanned=${res?.scanned ?? 0})`, 'sweep-dry-run');
    }
    const plural = res.archived === 1 ? 'y' : 'ies';
    return mkRun(phase, `${res.archived} entr${plural} archive-eligible`, 'sweep-dry-run');
  } catch (err) {
    return mkProbeError(phase, err);
  }
}

/**
 * 3.6.5 Auto-Dream nudge (#502). Config gate (kill-switch threshold=0, platform)
 * → then `shouldDispatchAutoDream` (trigger:false branches → skip).
 */
async function decideAutoDream({ repoRoot, cfg, platform, memoryDir }) {
  const phase = '3.6.5';
  try {
    const threshold = cfg?.['memory-cleanup-threshold'] ?? 5;
    if (threshold === 0) {
      return mkSkip(phase, 'kill-switch (memory-cleanup-threshold=0)', 'config-gate');
    }
    if (!isClaudePlatform(platform)) {
      return mkSkip(phase, 'non-Claude-Code platform (memory dir unavailable)', 'config-gate');
    }
    const dir = memoryDir ?? resolveMemoryDir();
    const dec = await shouldDispatchAutoDream({
      repoRoot,
      memoryDir: dir,
      threshold,
      softLimit: cfg?.['memory-cleanup-soft-limit'] ?? 180,
    });
    if (!dec.trigger) return mkSkip(phase, dec.reason, 'auto-dream-signal');
    return mkRun(phase, dec.reason, 'auto-dream-signal');
  } catch (err) {
    return mkProbeError(phase, err);
  }
}

/**
 * 3.6.6 Skill-Applied Judge (#645 L3). Config gate (judge default OFF,
 * persistence) → then the judged-set emptiness check via
 * `readSkillInvocations` (mirrors runSkillJudge's `empty-input` gate: no
 * selected skill this session → nothing to judge → skip). This computes the
 * judged set the coordinator would compute anyway; it does NOT re-implement the
 * judge (runSkillJudge needs a live dispatch, which is not side-effect-free).
 *
 * `sessionId === null/undefined` (noSessionFilter) deliberately falls to the
 * BROADER match — every entry in skill-invocations.jsonl counts toward
 * `judged`, regardless of which session recorded it. This can over-count (a
 * `run: true` decision when the true current-session set would have been
 * empty), which is the fail-open direction: worst case the coordinator loads
 * the 3.6.6 detail procedure for nothing, since the REAL `runSkillJudge` self-
 * gates on its own empty-input check when it actually runs. It never
 * under-counts into a false skip.
 */
async function decideSkillJudge({ repoRoot, cfg, sessionId }) {
  const phase = '3.6.6';
  try {
    if (cfg?.['skill-evolution']?.judge !== true) {
      return mkSkip(phase, 'disabled (skill-evolution.judge=false)', 'config-gate');
    }
    if (isPersistenceOff(cfg)) return mkSkip(phase, 'persistence=false', 'config-gate');
    const invPath = path.join(repoRoot, '.orchestrator', 'metrics', 'skill-invocations.jsonl');
    const entries = await readSkillInvocations(invPath);
    const noSessionFilter = sessionId === null || sessionId === undefined;
    const judged = new Set(
      entries
        .filter((e) => noSessionFilter || e.session_id === sessionId)
        .map((e) => e.skill)
        .filter((s) => typeof s === 'string' && s.trim().length > 0),
    );
    if (judged.size === 0) {
      return mkSkip(phase, 'empty-input (no selected skills this session)', 'skill-invocations.jsonl');
    }
    return mkRun(phase, `${judged.size} selected skill(s) to judge`, 'skill-invocations.jsonl');
  } catch (err) {
    return mkProbeError(phase, err);
  }
}

/**
 * 3.6.7 Auto-Dialectic nudge (#506). Config gate (persistence, kill-switch
 * cadence=0) → then `shouldDispatchAutoDialectic` (the reference implementation
 * of the no-new-input-since-last-run pattern via `.orchestrator/dialectic-last-run`).
 */
async function decideAutoDialectic({ repoRoot, cfg }) {
  const phase = '3.6.7';
  try {
    if (isPersistenceOff(cfg)) return mkSkip(phase, 'persistence=false', 'config-gate');
    const cadence = cfg?.dialectic?.cadence ?? 5;
    if (cadence === 0) return mkSkip(phase, 'kill-switch (dialectic.cadence=0)', 'config-gate');
    const dec = await shouldDispatchAutoDialectic({ repoRoot, cadence });
    if (!dec.trigger) return mkSkip(phase, dec.reason, 'auto-dialectic-signal');
    return mkRun(phase, dec.reason, 'auto-dialectic-signal');
  } catch (err) {
    return mkProbeError(phase, err);
  }
}

/**
 * 3.6.8 Reconciliation Rule Proposals (#696). Config gate (persistence,
 * reconcile.enabled default OFF, learnings.jsonl present) → then `runReconcile`
 * with `dryRun: true` (SKIPs the candidate-sidecar merge — no write) and the
 * operator confidence-floor delivery gate. 0 proposals above floor → skip.
 * runReconcile never throws; an engine `error` is treated fail-open (run).
 */
async function decideReconcile({ repoRoot, cfg }) {
  const phase = '3.6.8';
  try {
    if (isPersistenceOff(cfg)) return mkSkip(phase, 'persistence=false', 'config-gate');
    if (cfg?.reconcile?.enabled !== true) {
      return mkSkip(phase, 'disabled (reconcile.enabled=false)', 'config-gate');
    }
    const learningsPath = path.join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl');
    if (!existsSync(learningsPath)) {
      return mkSkip(phase, 'learnings.jsonl absent', 'learnings.jsonl');
    }
    const { proposals, summary, error } = await runReconcile({
      repoRoot,
      ruleExpiryDays: cfg?.reconcile?.['rule-expiry-days'] ?? undefined,
      now: new Date(),
      dryRun: true, // never write the candidate sidecar from the aggregator
    });
    if (error) return mkProbeError(phase, new Error(error)); // fail-open on engine error
    const floor = cfg?.reconcile?.['confidence-floor'] ?? 0.5;
    const surfaced = (Array.isArray(proposals) ? proposals : []).filter(
      (p) => typeof p.confidence === 'number' && p.confidence >= floor,
    );
    if (surfaced.length === 0) {
      return mkSkip(
        phase,
        `0 proposals above confidence floor (eligible=${summary?.eligible ?? 0}, floor=${floor})`,
        'reconcile-dry-run',
      );
    }
    return mkRun(phase, `${surfaced.length} proposal(s) above confidence floor`, 'reconcile-dry-run');
  } catch (err) {
    return mkProbeError(phase, err);
  }
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

/**
 * Build the compact one-line skip report from a plan.
 *
 * @param {PhaseDecision[]} plan
 * @returns {string}
 */
export function buildSkippedReport(plan) {
  const parts = (Array.isArray(plan) ? plan : []).map((d) => {
    const verb = d.run ? 'RUN' : 'skipped';
    return `${d.phase} ${verb} (${d.reason})`;
  });
  return `Tail-Diät: ${parts.join(' · ')}`;
}

// ---------------------------------------------------------------------------
// Main aggregator
// ---------------------------------------------------------------------------

/**
 * Compute the run/skip plan for the six session-end Phase 3.6.x tail phases.
 *
 * NEVER throws — each phase probe fail-opens to `run: true`, and the top-level
 * guard converts any unexpected error into an all-run plan so the coordinator
 * runs the full tail rather than silently skipping it.
 *
 * @param {object} args
 * @param {string}  args.repoRoot   Absolute repo root.
 * @param {object}  args.config     Parsed Session Config object (from parse-config.mjs).
 * @param {string|null} [args.sessionId] Current session id (for the 3.6.6 judged-set filter).
 * @param {string}  [args.platform] Platform id ('claude' | 'codex' | 'cursor' | …).
 * @param {string}  [args.memoryDir] Optional Auto-Dream memory dir override (default resolveMemoryDir()).
 * @returns {Promise<TailPlan>}
 */
export async function planTailPhases({ repoRoot, config, sessionId, platform, memoryDir } = {}) {
  const cfg = config ?? {};
  try {
    const plan = await Promise.all([
      decideMemoryProposals({ repoRoot, cfg }),
      decideExpiredSweep({ repoRoot }),
      decideAutoDream({ repoRoot, cfg, platform, memoryDir }),
      decideSkillJudge({ repoRoot, cfg, sessionId }),
      decideAutoDialectic({ repoRoot, cfg }),
      decideReconcile({ repoRoot, cfg }),
    ]);
    return { plan, skippedReport: buildSkippedReport(plan) };
  } catch (err) {
    // Top-level fail-open guard: run the full tail rather than lose it silently.
    const msg = err && err.message ? err.message : String(err);
    const plan = ['3.6.3', '3.6.4', '3.6.5', '3.6.6', '3.6.7', '3.6.8'].map((p) =>
      decision(p, true, `probe-error: ${msg}`, 'probe-error'),
    );
    return { plan, skippedReport: buildSkippedReport(plan) };
  }
}
