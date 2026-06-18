/**
 * learnings/surface.mjs — surface top-N active learnings from a JSONL file.
 *
 * Extracted from scripts/autopilot.mjs (pre-refactor was L128-167) so multiple
 * consumers can share the same filter + sort + cap pipeline (autopilot loop
 * signals + session-start banner, etc.). Pure, stdlib-only, async fs.
 *
 * Filter semantics:
 *   - confidence is strictly > floor (default 0.3). 0.31 is kept; 0.30 is dropped.
 *   - entries without a numeric `confidence` field are treated as 0 (dropped).
 *   - entries with a parseable `expires_at` whose epoch is <= now are dropped.
 *     Entries without `expires_at` are considered not-expired.
 *   - malformed JSON lines are silently skipped (no throw).
 *   - missing file returns `[]` (no throw).
 *
 * Ranking (#670 — time-decay):
 *   The active-filter above is UNCHANGED — a learning still has to clear the
 *   confidence floor to be eligible. Among eligible entries, the SORT key is the
 *   recency-decayed effective score, not raw confidence:
 *
 *     effectiveScore = max(
 *       confidence × 0.5^(ageDays / halfLifeDays),   // half-life decay
 *       confidence × floorFactor                      // catastrophic-loss floor
 *     )
 *
 *   - ageDays derives from the entry's recency timestamp: the first present of
 *     `last_reinforced` / `last_accessed` / `updated_at`, falling back to
 *     `created_at`. (The canonical learnings.jsonl schema carries only
 *     `created_at`; the reinforcement fields are read defensively in case a
 *     future schema stamps them — see #670.)
 *   - halfLifeDays default 90 (conservative — decay is a tiebreaker, not a cliff).
 *   - floorFactor default 0.1 — a 0.95-confidence entry never drops below 0.095
 *     no matter how old, so durable learnings still surface.
 *   - Multiplicative blend with a floor (NOT additive — additive can invert
 *     rankings).
 *   - When decay is DISABLED (or for entries with no parseable timestamp), the
 *     effective score is the raw confidence, restoring pure-confidence order.
 *
 * Sort: effectiveScore DESC, then created_at DESC tiebreaker (newest first).
 * Slice: `.slice(0, n)` after sort.
 */

import { readFile } from 'node:fs/promises';

const MS_PER_DAY = 86_400_000;

/** Conservative decay defaults — see #670. Floor means nothing vanishes. */
export const DECAY_DEFAULTS = Object.freeze({
  enabled: true,
  halfLifeDays: 90,
  floorFactor: 0.1,
});

/**
 * Bridge the kebab-case Session Config decay object (as produced by
 * `_parseEvolveDecay` in `scripts/lib/config/evolve.mjs` and surfaced on the
 * parsed config under `config['evolve.decay']`) into the camelCase shape that
 * `surfaceTopN`'s `opts.decay` expects (#670).
 *
 * Key mapping:
 *   `enabled`        → `enabled`
 *   `half-life-days` → `halfLifeDays`
 *   `floor-factor`   → `floorFactor`
 *
 * Only keys actually present on the input are copied through; absent keys are
 * left undefined so `surfaceTopN` falls back to DECAY_DEFAULTS for them (same
 * behaviour as passing no `decay` at all). A nullish input returns `undefined`,
 * which surfaceTopN treats identically to the all-defaults case.
 *
 * Pure — no I/O, no mutation of the argument.
 *
 * @param {{enabled?: boolean, 'half-life-days'?: number, 'floor-factor'?: number}|null|undefined} evolveDecay
 * @returns {{enabled?: boolean, halfLifeDays?: number, floorFactor?: number}|undefined}
 */
export function decayOptsFromConfig(evolveDecay) {
  if (evolveDecay === null || typeof evolveDecay !== 'object') return undefined;

  /** @type {{enabled?: boolean, halfLifeDays?: number, floorFactor?: number}} */
  const out = {};
  if ('enabled' in evolveDecay) out.enabled = evolveDecay.enabled;
  if ('half-life-days' in evolveDecay) out.halfLifeDays = evolveDecay['half-life-days'];
  if ('floor-factor' in evolveDecay) out.floorFactor = evolveDecay['floor-factor'];
  return out;
}

/**
 * Resolve an entry's recency basis (epoch ms) for decay. Prefers an explicit
 * reinforcement/access timestamp when the schema carries one, else `created_at`.
 * Returns NaN when no field is a parseable date — callers treat NaN as "no decay".
 *
 * @param {Record<string, unknown>} entry
 * @returns {number} epoch ms, or NaN when unresolvable
 */
function _recencyMs(entry) {
  for (const field of ['last_reinforced', 'last_accessed', 'updated_at', 'created_at']) {
    const v = entry[field];
    if (typeof v === 'string') {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) return ms;
    }
  }
  return NaN;
}

/**
 * Compute the recency-decayed effective score for a single entry.
 *
 * @param {Record<string, unknown>} entry — must carry a numeric `confidence`
 * @param {number} nowMs — injected clock (epoch ms)
 * @param {{enabled: boolean, halfLifeDays: number, floorFactor: number}} decay
 * @returns {number} effective score (never exceeds confidence; never below confidence×floorFactor)
 */
export function effectiveScore(entry, nowMs, decay) {
  const confidence = typeof entry.confidence === 'number' ? entry.confidence : 0;
  if (!decay || decay.enabled === false) return confidence;

  const recencyMs = _recencyMs(entry);
  // No parseable timestamp → cannot age the entry → fall back to raw confidence.
  if (!Number.isFinite(recencyMs)) return confidence;

  // Clamp negative ages (future timestamps / clock skew) to 0 so decay never
  // BOOSTS an entry above its confidence.
  const ageDays = Math.max(0, (nowMs - recencyMs) / MS_PER_DAY);
  const halfLifeDays = decay.halfLifeDays > 0 ? decay.halfLifeDays : DECAY_DEFAULTS.halfLifeDays;
  const floorFactor =
    typeof decay.floorFactor === 'number' ? decay.floorFactor : DECAY_DEFAULTS.floorFactor;

  const decayed = confidence * Math.pow(0.5, ageDays / halfLifeDays);
  const floor = confidence * floorFactor;
  return Math.max(decayed, floor);
}

/**
 * Surface the top-N active learnings from a learnings.jsonl file.
 *
 * @param {string} filePath - absolute path to learnings.jsonl
 * @param {number} [n=5] - how many to surface (cap)
 * @param {object} [opts]
 * @param {Date|number} [opts.now] - injectable clock; defaults to new Date()
 * @param {number} [opts.confidenceFloor=0.3] - filter threshold (entries with confidence <= floor are dropped)
 * @param {object} [opts.decay] - time-decay tuning (#670)
 * @param {boolean} [opts.decay.enabled=true] - when false, restores pure-confidence ranking
 * @param {number} [opts.decay.halfLifeDays=90] - half-life in days for the 0.5^(age/halfLife) factor
 * @param {number} [opts.decay.floorFactor=0.1] - effective score never drops below confidence×floorFactor
 * @returns {Promise<Array<{id?: string, type?: string, subject?: string, confidence: number, created_at?: string}>>}
 *   Entries are sorted by effectiveScore DESC, then created_at DESC (tiebreaker),
 *   then sliced to `n`. Returns [] on missing/unreadable file or all-empty input.
 */
export async function surfaceTopN(filePath, n = 5, opts = {}) {
  const { now: nowOpt, confidenceFloor = 0.3, decay: decayOpt } = opts;
  const nowMs =
    nowOpt instanceof Date
      ? nowOpt.getTime()
      : typeof nowOpt === 'number'
        ? nowOpt
        : Date.now();

  // Merge caller decay overrides over the conservative defaults. A partial
  // `{ enabled: false }` keeps the default half-life/floor (harmless when off).
  const decay = {
    enabled: decayOpt?.enabled ?? DECAY_DEFAULTS.enabled,
    halfLifeDays: decayOpt?.halfLifeDays ?? DECAY_DEFAULTS.halfLifeDays,
    floorFactor: decayOpt?.floorFactor ?? DECAY_DEFAULTS.floorFactor,
  };

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return [];
  }

  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const active = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // skip malformed lines
      continue;
    }
    if (typeof entry.confidence !== 'number' || entry.confidence <= confidenceFloor) continue;
    if (typeof entry.expires_at === 'string') {
      const expiresMs = Date.parse(entry.expires_at);
      if (Number.isFinite(expiresMs) && expiresMs <= nowMs) continue;
    }
    active.push(entry);
  }

  // Sort by recency-decayed effectiveScore DESC, then created_at DESC (newest
  // first as tiebreaker). The active-filter above is UNCHANGED — decay only
  // re-ranks the survivors.
  active.sort((a, b) => {
    const scoreDiff = effectiveScore(b, nowMs, decay) - effectiveScore(a, nowMs, decay);
    if (scoreDiff !== 0) return scoreDiff;
    const aTime = typeof a.created_at === 'string' ? Date.parse(a.created_at) : 0;
    const bTime = typeof b.created_at === 'string' ? Date.parse(b.created_at) : 0;
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });

  return active.slice(0, n);
}
