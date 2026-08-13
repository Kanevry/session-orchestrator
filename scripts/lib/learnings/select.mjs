/**
 * learnings/select.mjs — choose which learnings enter ONE dispatched agent's
 * compact index, given that agent's declared file scope (#1014).
 *
 * ## The problem
 *
 * 89 learnings accumulated across 233 sessions and a wave-agent receives ZERO of
 * them: the only read paths are a coordinator banner, an autopilot call, and a
 * nudge banner — none reaches a dispatched agent. This module is the selection
 * half of closing that loop; a sibling CLI renders/injects the result.
 *
 * ## Why two tiers (the measured reason)
 *
 * Only **17 of 89** live learnings (19.1%) carry a non-empty `file_paths`. A
 * purely scope-matched index is therefore EMPTY for most agents — the feature
 * would ship and deliver nothing. So selection runs in two tiers with SPLIT
 * budgets:
 *
 *   (a) SCOPED — learnings whose `file_paths` relate to the agent's scope
 *       (see {@link SCOPE_MATCH_MIN_PATH_SCORE}), capped at `maxScoped`.
 *   (b) GLOBAL — top-scoring remaining learnings (typically the path-less 81%),
 *       capped separately at `maxGlobal`.
 *
 * The caps are SPLIT, never shared: a single shared cap lets the global tier
 * crowd out the per-agent signal that is #1014's whole point. The split is
 * observable in the return value (`scopeMatched` / `globalCount`) so the ratio
 * stays measurable in production.
 *
 * The irony that motivates tier (b): the single most relevant learning for
 * building this very feature carries no `file_paths` — tier (a) alone drops it.
 *
 * ## Composition (this module re-implements nothing)
 *
 *   - `affinity()` from `./affinity.mjs` — the frozen relatedness surface. The
 *     agent's scope descriptor `{file_paths, text}` and a learning record are
 *     the same shape to it.
 *   - `effectiveScore()` / `surfaceTopN()` from `./surface.mjs` — the reader,
 *     the active-filter, and the #670 time-decay ranking. There is no second
 *     reader here and no second decay implementation.
 *
 * NOT used: `filterByScope()` from `./filters.mjs`. Despite the name it filters
 * the PRIVACY enum `['local','private','public']` (schema.mjs), not file scope.
 * The file-scope axis lives in `file_paths[]`. This trap has misled readers
 * before — do not "fix" it here.
 *
 * ## What this module owns
 *
 * Policy: thresholds, split caps, the char budget, tie-breaking, and the
 * one-line rendering the budget is measured against. Ranking is ours precisely
 * because `affinity()` reports `typeMatch` without folding it into its score.
 * We deliberately apply NO same-type boost: a scope descriptor carries no
 * `type`, so `typeMatch` is structurally always false on this axis.
 *
 * ## Budget
 *
 * {@link LEARNINGS_INDEX_MAX_CHARS} is a CODE CONSTANT with no
 * `0 = unlimited` sentinel — that sentinel is the explicit upstream mistake
 * #1014 exists to avoid. 2000 chars is 1.12% of the measured 178,095-byte
 * per-agent prompt baseline and 0.92× the median `.claude/rules/` file.
 * Repo precedent for literal caps: `LOOP_MD_MAX_BYTES = 25_000`,
 * `DEFAULT_MAX_LINE_CHARS = 400`, `MAX_TEXT_LEN = 256`.
 *
 * ## Contract
 *
 *   1. Never throws. Hostile input yields {@link emptySelection} — this runs on
 *      the dispatch hot path and must never abort a wave (same posture as
 *      `affinity()` and `surfaceTopN()`).
 *   2. Zero matches yield an EMPTY selection: `text === ''`, no placeholder
 *      line. Callers rely on empty-means-inject-nothing.
 *   3. `selection.text.length <= maxChars` always. An entry that does not fit
 *      is DROPPED (and `truncated` set), never emitted half-rendered.
 *   4. Deterministic: same inputs → same ordering. Ties break by
 *      **score DESC, then `created_at` DESC, then `id` ASC**.
 *   5. Expired and sub-floor entries are never selected.
 */

import { affinity } from './affinity.mjs';
import { DECAY_DEFAULTS, effectiveScore, surfaceTopN } from './surface.mjs';

// ---------------------------------------------------------------------------
// Constants — exported so a later wave can wire Session Config keys onto them
// without touching the logic below (config lookups are deliberately absent).
// ---------------------------------------------------------------------------

/**
 * Hard character cap on the rendered index. NO `0 = unlimited` sentinel.
 * 2000 = 1.12% of the measured 178,095 B per-agent prompt baseline.
 */
export const LEARNINGS_INDEX_MAX_CHARS = 2000;

/**
 * Per-entry line cap. 12 entries × ~122 B measured at 1,469 B total, so 160
 * leaves headroom for a long subject without letting one entry eat the budget.
 */
export const LEARNINGS_INDEX_MAX_LINE_CHARS = 160;

/** Split budgets — scoped signal can never be crowded out by the global tier. */
export const DEFAULT_MAX_SCOPED = 8;
export const DEFAULT_MAX_GLOBAL = 4;

/**
 * Minimum `pathScore` for tier (a) membership.
 *
 * Calibrated against `affinity`'s segment-aware pair scores:
 *   - exact path                          → 1.0    (in)
 *   - directory prefix                    → 0.75   (in)
 *   - sibling in the same dir, depth 4     → 0.375  (in)
 *   - sibling in the same dir, depth 2     → 0.25   (in, exactly on the boundary)
 *   - cousin dirs (`scripts/lib/a` vs `scripts/hooks/b`) → 0.167 (out)
 *
 * Only dyadic ratios land exactly on the boundary, so `>=` is safe here; the
 * excluded cases sit an order of magnitude below it.
 *
 * Deliberately NOT `sharedPaths.length === 0`: `sharedPaths` lists EXACT
 * overlaps only, so a directory-prefix match scores 0.75 without appearing
 * there. Using it as a proxy would silently drop the strongest partial matches.
 */
export const SCOPE_MATCH_MIN_PATH_SCORE = 0.25;

/**
 * Blend of relevance (affinity to this agent's scope) against quality
 * (recency-decayed confidence). Relevance dominates — per-agent differentiation
 * IS the acceptance criterion. Weight-normalized like `affinity()`, so the
 * result stays in [0,1] for any non-negative pair.
 */
export const SELECT_WEIGHTS = Object.freeze({ relevanceWeight: 0.7, qualityWeight: 0.3 });

/**
 * How many active entries the file entry-point pulls before ranking.
 * Ceiling: the live corpus is ~10² entries and scoring is O(pool × scopePaths);
 * revisit if the corpus passes ~1,000 entries, where a pre-filter would pay off.
 */
export const CANDIDATE_POOL_SIZE = 200;

/** Mirrors `surfaceTopN`'s default — entries at or below this are dropped. */
export const DEFAULT_CONFIDENCE_FLOOR = 0.3;

/**
 * @typedef {{file_paths?: string[], text?: string}} AgentScope
 *   A dispatched agent's declared file scope plus its task text.
 *
 * @typedef {{entry: object, score: number, relevance: number, quality: number,
 *            pathScore: number, scoped: boolean, line: string}} SelectedLearning
 *
 * @typedef {{entries: object[], selected: SelectedLearning[], lines: string[],
 *            text: string, chars: number, scopeMatched: number,
 *            globalCount: number, candidates: number, truncated: boolean}} Selection
 */

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** True for a plain-ish object we may read properties off. */
function _isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Positive integer option, else the fallback. `0` is a legal cap (select none). */
function _capOpt(v, fallback) {
  return Number.isInteger(v) && v >= 0 ? v : fallback;
}

/**
 * The active gate: confidence strictly above the floor, and not expired.
 *
 * Deliberately re-stated rather than imported: `surfaceTopN` inlines this filter
 * and exports no predicate, and {@link selectLearnings} must hold contract
 * point 5 for callers that hand it raw entries. Idempotent on the
 * {@link selectLearningsFromFile} path, where `surfaceTopN` already applied it.
 */
function _isActive(entry, nowMs, confidenceFloor) {
  if (typeof entry.confidence !== 'number' || entry.confidence <= confidenceFloor) return false;
  if (typeof entry.expires_at === 'string') {
    const expiresMs = Date.parse(entry.expires_at);
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return false;
  }
  return true;
}

/** Epoch ms from a Date | number | undefined clock option. */
function _resolveNowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

/** Merge caller decay overrides over the conservative #670 defaults. */
function _resolveDecay(decayOpt) {
  return {
    enabled: decayOpt?.enabled ?? DECAY_DEFAULTS.enabled,
    halfLifeDays: decayOpt?.halfLifeDays ?? DECAY_DEFAULTS.halfLifeDays,
    floorFactor: decayOpt?.floorFactor ?? DECAY_DEFAULTS.floorFactor,
  };
}

/** Date.parse or 0 — used only as a tiebreaker, never as a filter. */
function _createdMs(entry) {
  const v = entry?.created_at;
  if (typeof v !== 'string') return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Total order over scored candidates (contract point 4):
 * score DESC → created_at DESC → id ASC. Array.prototype.sort is stable
 * (ES2019+), so fully-equal records keep input order.
 */
function _compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const timeDiff = _createdMs(b.entry) - _createdMs(a.entry);
  if (timeDiff !== 0) return timeDiff;
  const aId = typeof a.entry.id === 'string' ? a.entry.id : '';
  const bId = typeof b.entry.id === 'string' ? b.entry.id : '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * The zero-value selection. Built fresh per call so no consumer can mutate a
 * shared singleton. `text` is `''` — never a "no learnings found" placeholder.
 *
 * @returns {Selection}
 */
export function emptySelection() {
  return {
    entries: [],
    selected: [],
    lines: [],
    text: '',
    chars: 0,
    scopeMatched: 0,
    globalCount: 0,
    candidates: 0,
    truncated: false,
  };
}

/**
 * Render ONE learning as a single index line, whitespace-collapsed and capped.
 *
 * Collapsing whitespace is load-bearing, not cosmetic: a multi-line `insight`
 * would otherwise break the one-line-per-entry shape the char budget is
 * measured against.
 *
 * @param {object} entry
 * @param {{maxLineChars?: number}} [opts]
 * @returns {string} the line, or '' when the entry carries no renderable text
 */
export function renderIndexLine(entry, opts = {}) {
  if (!_isRecord(entry)) return '';
  const maxLineChars = _capOpt(opts.maxLineChars, LEARNINGS_INDEX_MAX_LINE_CHARS);
  if (maxLineChars <= 0) return '';

  const flat = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const type = flat(entry.type);
  const subject = flat(entry.subject);
  const insight = flat(entry.insight);

  const head = [type, subject].filter(Boolean).join('/');
  if (!head && !insight) return '';

  let line = `- ${head}${head && insight ? ': ' : ''}${insight}`;
  if (line.length > maxLineChars) line = `${line.slice(0, maxLineChars - 1)}…`;
  return line;
}

/**
 * Score one learning against an agent scope.
 *
 * `score` = weight-normalized blend of relevance (`affinity().score`) and
 * quality (`effectiveScore()` — recency-decayed confidence). `typeMatch` is
 * deliberately not folded in; see the module header.
 *
 * @param {object} entry
 * @param {AgentScope} scope
 * @param {{now?: Date|number, decay?: object, affinityOpts?: object}} [opts]
 * @returns {{score: number, relevance: number, quality: number, pathScore: number}}
 */
export function scoreLearning(entry, scope, opts = {}) {
  const zero = { score: 0, relevance: 0, quality: 0, pathScore: 0 };
  if (!_isRecord(entry)) return zero;

  try {
    const nowMs = _resolveNowMs(opts.now);
    const decay = _resolveDecay(opts.decay);
    const aff = affinity(scope, entry, opts.affinityOpts);
    const quality = effectiveScore(entry, nowMs, decay);
    const q = Number.isFinite(quality) ? Math.min(Math.max(quality, 0), 1) : 0;

    const { relevanceWeight, qualityWeight } = SELECT_WEIGHTS;
    const total = relevanceWeight + qualityWeight;
    const score = total > 0 ? (relevanceWeight * aff.score + qualityWeight * q) / total : 0;

    return {
      score: Number.isFinite(score) ? score : 0,
      relevance: aff.score,
      quality: q,
      pathScore: aff.pathScore,
    };
  } catch {
    return zero;
  }
}

/**
 * Select the learnings that go into ONE agent's compact index.
 *
 * Two tiers with SPLIT budgets (see module header), then a greedy fill against
 * the char cap in render order (scoped first, then global). An entry whose line
 * does not fit is dropped and `truncated` is set — never emitted partially.
 *
 * @param {object[]} entries — candidate learnings (already read from disk)
 * @param {AgentScope} scope — the agent's declared file scope + task text
 * @param {object} [opts]
 * @param {number} [opts.maxScoped=DEFAULT_MAX_SCOPED]
 * @param {number} [opts.maxGlobal=DEFAULT_MAX_GLOBAL]
 * @param {number} [opts.maxChars=LEARNINGS_INDEX_MAX_CHARS]
 * @param {number} [opts.maxLineChars=LEARNINGS_INDEX_MAX_LINE_CHARS]
 * @param {number} [opts.minPathScore=SCOPE_MATCH_MIN_PATH_SCORE]
 * @param {number} [opts.confidenceFloor=DEFAULT_CONFIDENCE_FLOOR]
 * @param {Date|number} [opts.now] — injectable clock
 * @param {object} [opts.decay] — #670 decay tuning, forwarded to effectiveScore
 * @param {object} [opts.affinityOpts] — forwarded to affinity()
 * @returns {Selection}
 */
export function selectLearnings(entries, scope, opts = {}) {
  try {
    if (!Array.isArray(entries) || entries.length === 0) return emptySelection();

    const o = _isRecord(opts) ? opts : {};
    const maxScoped = _capOpt(o.maxScoped, DEFAULT_MAX_SCOPED);
    const maxGlobal = _capOpt(o.maxGlobal, DEFAULT_MAX_GLOBAL);
    const maxChars = _capOpt(o.maxChars, LEARNINGS_INDEX_MAX_CHARS);
    const maxLineChars = _capOpt(o.maxLineChars, LEARNINGS_INDEX_MAX_LINE_CHARS);
    const minPathScore =
      typeof o.minPathScore === 'number' && Number.isFinite(o.minPathScore)
        ? o.minPathScore
        : SCOPE_MATCH_MIN_PATH_SCORE;
    const confidenceFloor =
      typeof o.confidenceFloor === 'number' && Number.isFinite(o.confidenceFloor)
        ? o.confidenceFloor
        : DEFAULT_CONFIDENCE_FLOOR;
    const nowMs = _resolveNowMs(o.now);
    const scoreOpts = { now: nowMs, decay: o.decay, affinityOpts: o.affinityOpts };

    /** @type {SelectedLearning[]} */
    const scoped = [];
    /** @type {SelectedLearning[]} */
    const global = [];
    let candidates = 0;

    for (const entry of entries) {
      if (!_isRecord(entry)) continue;
      if (!_isActive(entry, nowMs, confidenceFloor)) continue;
      candidates++;

      const s = scoreLearning(entry, scope, scoreOpts);
      const line = renderIndexLine(entry, { maxLineChars });
      if (line.length === 0) continue;

      const isScoped = s.pathScore >= minPathScore;
      const cand = {
        entry,
        score: s.score,
        relevance: s.relevance,
        quality: s.quality,
        pathScore: s.pathScore,
        scoped: isScoped,
        line,
      };
      (isScoped ? scoped : global).push(cand);
    }

    scoped.sort(_compareCandidates);
    global.sort(_compareCandidates);

    // Split caps: the global tier can never displace scoped signal.
    const ordered = [...scoped.slice(0, maxScoped), ...global.slice(0, maxGlobal)];

    /** @type {SelectedLearning[]} */
    const selected = [];
    const lines = [];
    let chars = 0;
    let truncated = scoped.length > maxScoped || global.length > maxGlobal;

    for (const cand of ordered) {
      const next = chars === 0 ? cand.line.length : chars + 1 + cand.line.length;
      if (next > maxChars) {
        truncated = true;
        continue;
      }
      chars = next;
      selected.push(cand);
      lines.push(cand.line);
    }

    const text = lines.join('\n');
    return {
      entries: selected.map((c) => c.entry),
      selected,
      lines,
      text,
      chars: text.length,
      scopeMatched: selected.filter((c) => c.scoped).length,
      globalCount: selected.filter((c) => !c.scoped).length,
      candidates,
      truncated,
    };
  } catch {
    // Contract point 1 — a ranking primitive on the dispatch hot path must
    // never abort a wave. Every reachable path above is already total.
    return emptySelection();
  }
}

/**
 * File entry-point: read active learnings via `surfaceTopN` (the ONE reader —
 * it owns the active-filter and the #670 decay ranking), then select.
 *
 * @param {string} filePath — absolute path to learnings.jsonl
 * @param {AgentScope} scope
 * @param {object} [opts] — everything {@link selectLearnings} accepts, plus
 *   `poolSize` (how many active entries to pull before ranking).
 * @returns {Promise<Selection>} `emptySelection()` on a missing/unreadable file
 */
export async function selectLearningsFromFile(filePath, scope, opts = {}) {
  try {
    const o = _isRecord(opts) ? opts : {};
    const poolSize = _capOpt(o.poolSize, CANDIDATE_POOL_SIZE);
    const nowMs = _resolveNowMs(o.now);
    const confidenceFloor =
      typeof o.confidenceFloor === 'number' && Number.isFinite(o.confidenceFloor)
        ? o.confidenceFloor
        : DEFAULT_CONFIDENCE_FLOOR;

    const entries = await surfaceTopN(filePath, poolSize, {
      now: nowMs,
      confidenceFloor,
      decay: o.decay,
    });
    return selectLearnings(entries, scope, { ...o, now: nowMs, confidenceFloor });
  } catch {
    return emptySelection();
  }
}
