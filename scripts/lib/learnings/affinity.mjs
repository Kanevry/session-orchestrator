/**
 * learnings/affinity.mjs — pure relatedness primitive for learnings.
 *
 * ONE surface, two consumers:
 *   - scope→learning relevance (#1014): how relevant is this learning to a
 *     wave-agent's declared file scope + task title?
 *   - learning→learning similarity (#1016): which other learnings may
 *     duplicate or contradict this one?
 *
 * Both collapse into `affinity(a, b)` because both sides are read through the
 * same {@link AffinityContext} union: a bag of file paths plus a bag of text.
 * A scope descriptor `{file_paths, text}` and a learning record are, for the
 * purpose of "how related are these two things", the same shape.
 *
 * ## What this module is
 *
 * A relatedness function. Given two things, how related are they? That is all.
 *
 * ## What this module is NOT (deliberate boundary)
 *
 *   - No fs. Reading learnings.jsonl belongs to `learnings/io.mjs` / `surfaceTopN`.
 *   - No clock. Recency decay and confidence floors belong to
 *     `learnings/surface.mjs` — note {@link effectiveScore} there takes an
 *     explicit `nowMs`; that time axis stays OUT of this file so `affinity` is
 *     referentially transparent.
 *   - No top-K, no thresholds, no char caps, no formatting, no Session Config.
 *     Those decide WHICH things are chosen and HOW they are printed — policy,
 *     owned by the consumers.
 *
 * The one-line test: if removing it would change *which* things are chosen or
 * *how they are printed*, it is policy and belongs to a consumer; if removing
 * it would change *how related two things are*, it belongs here.
 *
 * ## Import graph (acyclic by construction)
 *
 * Exactly one sibling edge: `affinity.mjs → ./schema.mjs`, plus stdlib —
 * and here not even stdlib. `schema.mjs` is a pure leaf that imports only
 * `node:crypto` and is contractually forbidden from importing siblings, so no
 * cycle is reachable. Never import `../learnings.mjs` from here.
 *
 * Dialect handling imports {@link normalizeDialects}, NOT `normalizeLearning`:
 * the latter emits deduped `console.error` WARNs for a missing `schema_version`
 * and for missing legacy fields (schema.mjs), which inside an N×M affinity loop
 * over the corpus would spam stderr on every agent dispatch. `normalizeDialects`
 * does the one thing needed here — legacy `files` read as `file_paths`.
 *
 * ## Contract
 *
 *   1. Every returned number is finite and in [0,1]. Never NaN/Infinity.
 *   2. Symmetric: affinity(a,b).score === affinity(b,a).score. (#1016 halves an
 *      O(n²) pass on this.)
 *   3. Deterministic and pure: no clock, no fs, no randomness, no network.
 *   4. Never throws. Hostile input yields the all-zero result — a ranking
 *      primitive on the dispatch hot path must never abort a wave. (Matches the
 *      read-path convention of `surfaceTopN` returning [] on an unreadable file;
 *      deliberately NOT `validateLearning`'s throwing ValidationError.)
 *   5. Path matching is segment-aware: exact > directory-prefix > shared
 *      ancestor, on `/`-split segments, case-SENSITIVE (Linux CI is the
 *      authority). Glob metacharacters are compared literally — this module
 *      never expands globs; the caller pre-expands.
 *   6. Fields read: `file_paths[]` (+ legacy `files`), `type`, `subject`,
 *      `insight`, `evidence` (may legally be an array — not coerced), `title`,
 *      and the context-only `text`.
 *      Fields deliberately NOT read: `confidence`, `created_at`/`updated_at`/
 *      `expires_at`/`last_reinforced`, `scope`, `host_class`, `anonymized`,
 *      `source_session`, `id` — ranking/policy/privacy axes owned elsewhere.
 */

import { normalizeDialects } from './schema.mjs';

/**
 * @typedef {{file_paths?: string[], files?: string[], text?: string, type?: string}} AffinityContext
 *   The union both consumers pass. A raw learning record satisfies it as-is
 *   (it carries `file_paths`/`files` and `type`); a scope descriptor satisfies
 *   it with `{file_paths, text}`.
 */

/**
 * @typedef {{filePaths: string[], tokens: string[], type: string|null}} NormalizedContext
 */

/**
 * @typedef {{score: number, pathScore: number, tokenScore: number,
 *            typeMatch: boolean, sharedPaths: string[], sharedTokens: string[]}} AffinityResult
 */

/** Blend weights + tokenizer floor. Callers may override per call via `opts`. */
export const AFFINITY_DEFAULTS = Object.freeze({
  pathWeight: 0.6,
  tokenWeight: 0.4,
  minTokenLength: 3,
});

/**
 * Per-pair path scores. The ORDER is the contract (exact > prefix > ancestor);
 * the exact magnitudes are tuning. `PATH_ANCESTOR_MAX` is a strict upper bound
 * never reached — the ancestor branch only runs when the shared prefix is
 * shorter than both paths, so its ratio is always < 1 and its score < 0.5,
 * keeping it strictly below `PATH_PREFIX`.
 */
const PATH_EXACT = 1;
const PATH_PREFIX = 0.75;
const PATH_ANCESTOR_MAX = 0.5;

/** Cap on the reported `sharedTokens` — a diagnostic list, not a payload. */
const SHARED_TOKEN_CAP = 32;

/** Max nesting depth followed when tokenizing an array-valued field. */
const MAX_TEXT_DEPTH = 3;

/** Text-bearing fields read for tokens, in a fixed order (determinism). */
const TEXT_FIELDS = Object.freeze(['text', 'title', 'subject', 'insight', 'evidence']);

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Clamp to a finite [0,1]. Non-finite input (NaN from an empty division,
 *  Infinity from a bad weight) collapses to 0 rather than escaping. */
function _clamp01(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

/** True for a plain-ish object we may read properties off (not null, not array). */
function _isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** The all-zero result. Built fresh per call so a consumer can never mutate a
 *  shared singleton out from under the next caller. */
function _emptyResult() {
  return {
    score: 0,
    pathScore: 0,
    tokenScore: 0,
    typeMatch: false,
    sharedPaths: [],
    sharedTokens: [],
  };
}

/**
 * Canonicalize a repo-relative path for comparison: trim, strip leading `./`
 * (repeatable), strip trailing `/`. Case is preserved — Linux CI is the
 * authority, so `Scripts/` and `scripts/` are different paths.
 * Returns '' for anything unusable.
 */
function _normalizePath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  while (s.startsWith('./')) s = s.slice(2);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * Score one path pair on `/`-split segments.
 *
 * exact (1) > directory-prefix (0.75) > shared-ancestor (< 0.5, scaled by how
 * much of the longer path the shared prefix covers) > unrelated (0).
 *
 * Segment-aware, never string-prefix: `scripts/lib/learn` is NOT a prefix of
 * `scripts/lib/learnings/io.mjs`, it is a 2-segment shared ancestor.
 */
function _pairScore(aNorm, bNorm) {
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return PATH_EXACT;

  const aSeg = aNorm.split('/').filter(Boolean);
  const bSeg = bNorm.split('/').filter(Boolean);
  if (aSeg.length === 0 || bSeg.length === 0) return 0;

  const min = Math.min(aSeg.length, bSeg.length);
  let shared = 0;
  while (shared < min && aSeg[shared] === bSeg[shared]) shared++;

  if (shared === 0) return 0;
  // Equality was handled above, so a full-shorter match means the shorter path
  // is a strict directory prefix of the longer one.
  if (shared === min) return PATH_PREFIX;
  return PATH_ANCESTOR_MAX * (shared / Math.max(aSeg.length, bSeg.length));
}

/** Best score of `p` against any path in `others`. */
function _bestAgainst(p, others) {
  let best = 0;
  for (const q of others) {
    const s = _pairScore(p, q);
    if (s > best) best = s;
    if (best === PATH_EXACT) break;
  }
  return best;
}

/**
 * Aggregate two path lists into one [0,1] score.
 *
 * Mean-of-best-match in BOTH directions, averaged — symmetric by construction.
 * A one-directional "mean over a of best in b" is the naive form and is NOT
 * symmetric when the lists differ in size, which would break contract point 2.
 *
 * O(n·m): scopes are a handful of paths and the corpus is ~10² entries, so the
 * product is trivial. Revisit if a caller ever passes a scope above ~200 paths.
 */
function _pathScoreFromLists(aPaths, bPaths) {
  if (aPaths.length === 0 || bPaths.length === 0) return 0;

  let sumA = 0;
  for (const p of aPaths) sumA += _bestAgainst(p, bPaths);
  let sumB = 0;
  for (const q of bPaths) sumB += _bestAgainst(q, aPaths);

  return _clamp01((sumA / aPaths.length + sumB / bPaths.length) / 2);
}

/** Jaccard over token sets: |A∩B| / |A∪B|. Symmetric by construction. */
function _tokenScoreFromLists(aTokens, bTokens) {
  const setA = new Set(aTokens);
  const setB = new Set(bTokens);
  if (setA.size === 0 || setB.size === 0) return 0;

  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  if (union <= 0) return 0;
  return _clamp01(inter / union);
}

/** Sorted, deduped intersection of two string lists. */
function _sharedSorted(a, b) {
  const setB = new Set(b);
  const out = new Set();
  for (const v of a) if (setB.has(v)) out.add(v);
  return [...out].sort();
}

/** Resolve caller opts over AFFINITY_DEFAULTS, rejecting non-finite/negative
 *  weights and non-integer token floors rather than propagating them. */
function _resolveOpts(opts) {
  const o = _isRecord(opts) ? opts : {};
  const weight = (v, fallback) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
  return {
    pathWeight: weight(o.pathWeight, AFFINITY_DEFAULTS.pathWeight),
    tokenWeight: weight(o.tokenWeight, AFFINITY_DEFAULTS.tokenWeight),
    minTokenLength:
      Number.isInteger(o.minTokenLength) && o.minTokenLength >= 1
        ? o.minTokenLength
        : AFFINITY_DEFAULTS.minTokenLength,
  };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Split text into comparable lowercase tokens.
 *
 * Accepts a string, or an array of strings (legacy `evidence` may legally be an
 * array and is deliberately not coerced upstream — see schema.mjs). Nested
 * arrays are followed to {@link MAX_TEXT_DEPTH}. Anything else yields [].
 *
 * Tokens are lowercased, split on any non-alphanumeric run, filtered to
 * `minTokenLength` or longer, and deduped in first-appearance order (stable,
 * so equal inputs always produce an equal array).
 *
 * @param {unknown} text
 * @param {{minTokenLength?: number}} [opts]
 * @returns {string[]}
 */
export function tokenize(text, opts) {
  const { minTokenLength } = _resolveOpts(opts);
  const out = [];
  const seen = new Set();

  const walk = (value, depth) => {
    if (typeof value === 'string') {
      for (const raw of value.toLowerCase().split(/[^a-z0-9]+/)) {
        if (raw.length < minTokenLength || seen.has(raw)) continue;
        seen.add(raw);
        out.push(raw);
      }
      return;
    }
    if (Array.isArray(value) && depth < MAX_TEXT_DEPTH) {
      for (const el of value) walk(el, depth + 1);
    }
  };

  walk(text, 0);
  return out;
}

/**
 * Project any {@link AffinityContext}-ish input onto the normalized shape the
 * scorers compare. Total: hostile input yields the empty context, never a throw.
 *
 * Legacy `files` is read as `file_paths` via {@link normalizeDialects}
 * (`reserializeTimestamps: false` — this module never reads timestamps, so
 * re-parsing them would be pure waste).
 *
 * @param {unknown} input
 * @param {{minTokenLength?: number}} [opts] — tokenizer tuning; optional.
 * @returns {NormalizedContext}
 */
export function toAffinityContext(input, opts) {
  if (!_isRecord(input)) return { filePaths: [], tokens: [], type: null };

  try {
    let record = input;
    try {
      record = normalizeDialects(input, { reserializeTimestamps: false });
    } catch {
      // A dialect quirk must never abort a ranking pass — fall back to the raw
      // record and read `files` directly below.
      record = input;
    }
    if (!_isRecord(record)) record = input;

    const rawPaths = Array.isArray(record.file_paths)
      ? record.file_paths
      : Array.isArray(record.files)
        ? record.files
        : [];

    const filePaths = [];
    const seenPaths = new Set();
    for (const p of rawPaths) {
      const norm = _normalizePath(p);
      if (norm.length === 0 || seenPaths.has(norm)) continue;
      seenPaths.add(norm);
      filePaths.push(norm);
    }

    const { minTokenLength } = _resolveOpts(opts);
    const tokens = [];
    const seenTokens = new Set();
    for (const field of TEXT_FIELDS) {
      for (const t of tokenize(record[field], { minTokenLength })) {
        if (seenTokens.has(t)) continue;
        seenTokens.add(t);
        tokens.push(t);
      }
    }

    const type =
      typeof record.type === 'string' && record.type.trim().length > 0
        ? record.type.trim()
        : null;

    return { filePaths, tokens, type };
  } catch {
    // Exotic shape (throwing getter, hostile Proxy). Every scorer downstream
    // stays total because this is the ONLY place raw input is read.
    return { filePaths: [], tokens: [], type: null };
  }
}

/**
 * File-path relatedness of two contexts, in [0,1].
 * Segment-aware and symmetric — see {@link _pairScore} and
 * {@link _pathScoreFromLists}.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function pathAffinity(a, b) {
  return _pathScoreFromLists(toAffinityContext(a).filePaths, toAffinityContext(b).filePaths);
}

/**
 * Text relatedness of two contexts, in [0,1] (Jaccard over token sets).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number}
 */
export function tokenAffinity(a, b) {
  return _tokenScoreFromLists(toAffinityContext(a).tokens, toAffinityContext(b).tokens);
}

/**
 * The primitive both consumers call.
 *
 * `score` is the weight-normalized blend of `pathScore` and `tokenScore`:
 * `(pw·path + tw·token) / (pw + tw)`, so it stays in [0,1] for ANY non-negative
 * weight pair, not only ones that sum to 1.
 *
 * `typeMatch` is REPORTED, never folded into `score`. Whether a same-type pair
 * deserves a boost is a ranking decision, and ranking is the consumer's.
 *
 * `sharedPaths` lists exactly-overlapping normalized paths only — a
 * directory-prefix pair raises `pathScore` without appearing here.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @param {{pathWeight?: number, tokenWeight?: number, minTokenLength?: number}} [opts]
 * @returns {AffinityResult}
 */
export function affinity(a, b, opts) {
  try {
    const { pathWeight, tokenWeight, minTokenLength } = _resolveOpts(opts);
    const ctxA = toAffinityContext(a, { minTokenLength });
    const ctxB = toAffinityContext(b, { minTokenLength });

    const pathScore = _pathScoreFromLists(ctxA.filePaths, ctxB.filePaths);
    const tokenScore = _tokenScoreFromLists(ctxA.tokens, ctxB.tokens);

    const totalWeight = pathWeight + tokenWeight;
    const score =
      totalWeight > 0
        ? _clamp01((pathWeight * pathScore + tokenWeight * tokenScore) / totalWeight)
        : 0;

    return {
      score,
      pathScore,
      tokenScore,
      typeMatch: ctxA.type !== null && ctxB.type !== null && ctxA.type === ctxB.type,
      sharedPaths: _sharedSorted(ctxA.filePaths, ctxB.filePaths),
      sharedTokens: _sharedSorted(ctxA.tokens, ctxB.tokens).slice(0, SHARED_TOKEN_CAP),
    };
  } catch {
    // Last-resort net for an exotic input shape (getter that throws, Proxy).
    // Contract point 4: this runs on the dispatch hot path and must never
    // abort a wave. Every reachable path above is already total.
    return _emptyResult();
  }
}
