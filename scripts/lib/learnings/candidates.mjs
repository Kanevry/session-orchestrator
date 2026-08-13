/**
 * learnings/candidates.mjs — build the per-seed CANDIDATE POOL for
 * learning→learning duplicate/contradiction judgment (#1016).
 *
 * ## What this module is
 *
 * The cheap mechanical half of "which learnings might duplicate or contradict
 * this one?". It narrows N² pairs down to a small, bounded, per-seed shortlist.
 * A sibling module makes the actual duplicate/contradiction JUDGMENT on those
 * shortlists; `/evolve` wires the two together.
 *
 * ## What this module is NOT (deliberate boundary)
 *
 *   - **Not a verdict.** A pool member is a *maybe*, never a duplicate. Nothing
 *     here decides, merges, rewrites, or deletes a learning.
 *   - **Not a clustering pass.** No transitive closure, no union-find, no
 *     connected components — see accepted failure mode 2 below. Measured: even
 *     at K=3 the directed pool graph collapses into a 99-of-100 giant component,
 *     so "cluster the corpus" returns *the corpus*.
 *   - **Not a ranker of quality.** `confidence` is carried through as metadata
 *     and never scored on. Recency decay lives in `surface.mjs::effectiveScore`;
 *     that time axis stays out of here (the ONLY clock reading is the expiry
 *     gate, and it is injectable).
 *   - **Not a renderer.** No char budgets, no lines, no prompt text —
 *     `select.mjs` owns that shape for the other consumer.
 *
 * ## Import graph (acyclic by construction)
 *
 * `candidates.mjs → {affinity, kebab, io, schema}.mjs`, all of which are leaves
 * or import only `schema.mjs`. Deliberately NOT re-exported from the
 * `scripts/lib/learnings.mjs` barrel — `surface.mjs`, `affinity.mjs` and
 * `kebab.mjs` set that precedent: consumers import the leaf directly.
 *
 * ## The algorithm (measured, not preferred)
 *
 * A wave-1 discovery pass measured the live corpus (100 records, 2026-08-13) and
 * fixed every threshold below against ground truth. They are measured knees. Do
 * not re-tune them from taste; re-measure or leave them alone.
 *
 * **Stage 0 — corpus prep (once per run).**
 *   1. Read through the existing funnel (`io.mjs::readLearnings` →
 *      `schema.mjs::normalizeLearning`) so producer dialects (`files` →
 *      `file_paths`) and type aliases (`gotcha` → `anti-pattern`) are already
 *      canonical. The in-memory entry point re-applies {@link normalizeDialects}
 *      so both entry points score the same shape.
 *   2. Drop expired records — they may neither seed a pool nor join one.
 *   3. Derive `learning_key` = `` `${type}/${kebab(title || subject)}` `` using
 *      the SHARED {@link kebab}. A divergent kebab does not produce an ugly
 *      slug, it forks the key space (see `kebab.mjs`).
 *   4. Exact-key pass FIRST: identical `learning_key`s are duplicates under the
 *      existing contract and are resolved before any scoring. This fires on
 *      nothing in today's corpus — kept because it is free and it is the rule
 *      that already governs this key space.
 *
 * **Stage 1 — tokenisation.** `subject ∪ insight`, lowercased, split on every
 * non-`[a-z0-9]` run, length > 2, minus {@link STOPWORDS}.
 *
 *   - `evidence` is deliberately EXCLUDED: 63.4% of the vocabulary is already
 *     hapax and `evidence` is dense with dates and one-off identifiers. (It may
 *     also legally be an array — `schema.mjs` documents this and does not
 *     coerce it.)
 *   - The **German half of the stoplist is mandatory, not optional.** 7 of 89
 *     measured records are German, and the single highest-scoring pair in the
 *     entire corpus (0.356 — above every ground-truth pair) was a German↔German
 *     pair driven purely by shared function words. Without it, the score
 *     measures *language*, not content.
 *
 * **Stage 2 — IDF-weighted Dice over all unordered pairs.**
 * ```
 * idf(w)    = log((N+1) / (df(w) + 0.5))            // df over the FILTERED corpus
 * base(i,j) = 2·Σ_{w∈Ti∩Tj} idf(w) / (Σ_{w∈Ti} idf(w) + Σ_{w∈Tj} idf(w))
 * score     = base + pathBoost(i,j)
 * ```
 * IDF-Dice rather than plain Jaccard because plain Jaccard has no usable tail
 * here: 78 pairs ≥0.10 vs 11, and with 47-token mean sets and 63.4% hapax its
 * p99 is 0.0789.
 *
 * `type` is **neither a filter nor a boost** — the counter-intuitive measured
 * result. Both strongest ground-truth links are CROSS-type (0.2127 and 0.1735),
 * and a type-equality gate drops ground-truth connectivity from 6/6 to 4/6 while
 * still retaining 26% of all pairs. It rides along as metadata only.
 *
 * **Stage 3 — per-seed pool.** `top-K by score, j ≠ i, score ≥ FLOOR`, with
 * K = {@link CANDIDATE_TOP_K} and FLOOR = {@link CANDIDATE_FLOOR}.
 *
 * ## Why each number
 *
 *   - **FLOOR 0.085** — the last threshold at which the ground-truth arc stays
 *     connected. At 0.090 the `EXIT0~TOCONTAIN` bridge (0.0882) snaps and the
 *     arc splits. Retains 172/4950 = 3.47% of pairs.
 *   - **K 8** — every ground-truth pair that matters ranks ≤4 for at least one
 *     endpoint; 8 is 2× headroom.
 *   - **path boost 0.050** — strictly BELOW the floor, so a zero-token pair can
 *     never enter a pool on paths alone. Hard invariant, pinned by a test.
 *   - **dir boost 0.025** — a 2-level directory prefix is 11.5× less selective
 *     than an exact path overlap (138 vs 12 pairs), so it gets strictly less
 *     weight.
 *
 * ## Accepted failure modes — each with its ceiling and revisit trigger
 *
 *   1. **80.9% of records carry no usable `file_paths`**, so the boost is
 *      identically 0 for them. CEILING: the boost may only ever RAISE a score,
 *      never gate one — `PATH_BOOST_EXACT < CANDIDATE_FLOOR` is the mechanical
 *      form of that ceiling. REVISIT when `file_paths` coverage crosses 50%.
 *   2. **Non-transitivity is by design** — the ground-truth arc is recoverable
 *      only by chaining pools. CEILING: a consumer may walk at most
 *      {@link MAX_POOL_HOPS} hops from a seed; beyond that the reachable set
 *      approaches the giant component. REVISIT only with a fresh component-size
 *      measurement, never on intuition.
 *   3. **Clique recall is 33% (5 of 15) and will not improve by lowering the
 *      floor.** CEILING: never set `floor` below 0.060 — at 0.060 you retain
 *      11.21% of pairs to gain exactly ONE more ground-truth pair, with
 *      connectivity unchanged. REVISIT if recall itself becomes the acceptance
 *      criterion, in which case the fix is a better signal, not a lower floor.
 *   4. **Two languages only (en/de).** A third language enters unstoplisted and
 *      the function-word collision of failure mode 3's German case returns.
 *      REVISIT when a non-en/de record lands in the corpus.
 *
 * ## Cost
 *
 * Measured at N=100: 13.1 ms for the full pairwise pass, 2.65 µs/pair. O(N²) is
 * the correct choice — the viability boundary is ~N=2000, which at the observed
 * ~2.3 learnings/session growth rate is years away and is additionally capped by
 * the per-type TTL policy (`LEARNING_TTL_DAYS`). CEILING: do NOT build an
 * inverted index below that boundary; REVISIT at N≈2000.
 *
 * ## Contract
 *
 *   1. **Never throws.** Hostile input yields {@link emptyPools}. This feeds an
 *      `/evolve` housekeeping path; a malformed corpus line must degrade to
 *      "no pools", never abort the run. (Same posture as `affinity()`,
 *      `surfaceTopN()` and `selectLearnings()`.)
 *   2. **Deterministic and clock-injectable.** Same records + same `now` → the
 *      same pools in the same order. Ties break by score DESC → `created_at`
 *      DESC → `id` ASC, mirroring `select.mjs`.
 *   3. **Symmetric scoring, asymmetric pools.** `score(i,j) === score(j,i)`, but
 *      `j ∈ pool(i)` does NOT imply `i ∈ pool(j)` — top-K is per seed.
 *   4. Every emitted `score` is finite and in `[0, 1 + PATH_BOOST_EXACT]`.
 *   5. Expired records never seed and never join a pool.
 *   6. Fields read: `subject`, `insight` (tokens), `file_paths[]` (+ legacy
 *      `files`, via the dialect normalizer), `type` + `title` (key + metadata),
 *      `expires_at` (the one gate), `created_at`/`id` (tie-breaks only).
 *      Deliberately NOT read: `confidence`, `evidence`, `scope`, `host_class`,
 *      `source_session`.
 */

import { tokenize } from './affinity.mjs';
import { readLearnings } from './io.mjs';
import { kebab } from './kebab.mjs';
import { normalizeDialects } from './schema.mjs';

// ---------------------------------------------------------------------------
// Constants — measured knees (see module header). Exported so a consumer can
// cite them rather than restate them; overriding them is a re-measurement, not
// a preference.
// ---------------------------------------------------------------------------

/**
 * Minimum pair score for pool membership. The last threshold at which the
 * ground-truth arc stays connected (the 0.0882 `EXIT0~TOCONTAIN` bridge sits
 * just above it). Retains 3.47% of all pairs.
 */
export const CANDIDATE_FLOOR = 0.085;

/** Per-seed pool cap. Every ground-truth pair ranks ≤4 for one endpoint; 2× headroom. */
export const CANDIDATE_TOP_K = 8;

/**
 * Boost for an exact `file_paths` overlap. STRICTLY BELOW {@link CANDIDATE_FLOOR}
 * on purpose: a pair with zero shared tokens can never enter a pool on paths
 * alone. This inequality is a hard invariant, not a coincidence — a test pins it.
 */
export const PATH_BOOST_EXACT = 0.05;

/** Boost for a shared 2-level directory prefix — 11.5× less selective, so half the weight. */
export const PATH_BOOST_DIR = 0.025;

/** How many leading directory segments define the directory-prefix boost. */
export const DIR_PREFIX_SEGMENTS = 2;

/**
 * Documented ceiling for consumers (accepted failure mode 2): a pool graph walk
 * may chain at most this many hops from a seed. Beyond 2 the reachable set
 * approaches the measured 99-of-100 giant component, i.e. "the corpus".
 */
export const MAX_POOL_HOPS = 2;

/** Token length floor — tokens shorter than this are dropped before stoplisting. */
export const MIN_TOKEN_LENGTH = 3;

/** Cap on the reported `sharedTokens` — a diagnostic for the judge, not a payload. */
const SHARED_TOKEN_CAP = 8;

/**
 * English + German function words, dropped after tokenisation.
 *
 * Two notes that look like omissions but are not:
 *
 *   - Words of 1–2 characters (`is`, `to`, `of`, `an`, …) are absent because
 *     {@link MIN_TOKEN_LENGTH} already removes them; listing them would be dead
 *     weight.
 *   - Umlaut forms (`für`, `über`) are listed for completeness but are already
 *     shredded by the ASCII tokenizer (`ü` is a separator, leaving `f`/`r` — both
 *     under the length floor). They earn their place only if the tokenizer ever
 *     gains transliteration.
 *
 * The German half is load-bearing — see the module header. Adding a THIRD
 * language requires extending this set in the same commit (failure mode 4).
 *
 * Deliberately NOT `Object.freeze`d: freezing a Set seals its properties, not
 * its contents — `.add()` still works — so a freeze here would advertise a
 * guarantee it cannot keep. Treat it as read-only by convention.
 */
export const STOPWORDS = /** @type {ReadonlySet<string>} */ (
  new Set([
    // English (standard function-word list, ≥3 chars)
    'about', 'above', 'after', 'again', 'against', 'all', 'and', 'any', 'are',
    'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but',
    'can', 'did', 'does', 'doing', 'down', 'during', 'each', 'few', 'for',
    'from', 'further', 'had', 'has', 'have', 'having', 'her', 'here', 'hers',
    'herself', 'him', 'himself', 'his', 'how', 'into', 'its', 'itself', 'just',
    'more', 'most', 'nor', 'not', 'off', 'once', 'only', 'other', 'our', 'ours',
    'ourselves', 'out', 'over', 'own', 'same', 'she', 'should', 'some', 'such',
    'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then',
    'there', 'these', 'they', 'this', 'those', 'through', 'too', 'under',
    'until', 'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while',
    'who', 'whom', 'why', 'will', 'with', 'you', 'your', 'yours', 'yourself',
    'yourselves',
    // German — mandatory half (see module header)
    'der', 'die', 'das', 'und', 'nicht', 'ist', 'ein', 'eine', 'einen', 'auf',
    'mit', 'von', 'dem', 'den', 'für', 'fuer', 'wird', 'werden', 'sich', 'aber',
    'nur', 'noch', 'schon', 'beim', 'durch',
  ])
);

/**
 * @typedef {{record: object, key: string|null, score: number, base: number,
 *            boost: number, type: string|null, sharedTokens: string[]}} PoolCandidate
 *
 * @typedef {{seed: object, key: string|null, type: string|null,
 *            candidates: PoolCandidate[]}} CandidatePool
 *
 * @typedef {{key: string, kept: object, dropped: object[]}} DuplicateGroup
 *
 * @typedef {{pools: CandidatePool[], duplicates: DuplicateGroup[],
 *            stats: {input: number, expired: number, unkeyable: number,
 *                    duplicateGroups: number, duplicatesDropped: number,
 *                    scored: number, pairs: number, retained: number,
 *                    seedsWithPool: number}}} CandidatePools
 */

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** True for a plain-ish object we may read properties off (not null, not array). */
function _isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Canonicalize a repo-relative path: trim, strip leading `./`, strip trailing
 * `/`. Case-SENSITIVE — Linux CI is the authority.
 *
 * Re-stated rather than imported: `affinity.mjs` keeps its equivalent private
 * and that module is frozen. The two must agree on canonical form; they are six
 * lines each and the shape is pinned by a test here.
 */
function _normalizePath(p) {
  if (typeof p !== 'string') return '';
  let s = p.trim();
  while (s.startsWith('./')) s = s.slice(2);
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** Normalized, deduped, non-empty file paths of a record. Never throws. */
function _recordPaths(record) {
  const raw = Array.isArray(record?.file_paths)
    ? record.file_paths
    : Array.isArray(record?.files)
      ? record.files
      : [];
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    const norm = _normalizePath(p);
    if (norm.length === 0 || seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * The directory key of a path: up to {@link DIR_PREFIX_SEGMENTS} leading
 * DIRECTORY segments (the last segment is the filename and is dropped).
 *
 * `scripts/lib/learnings/candidates.mjs` → `scripts/lib`
 * `hooks/emit.mjs`                       → `hooks`      (only one dir level exists)
 * `README.md`                            → `''`         (no directory at all)
 *
 * A top-level file therefore has NO directory key and can never earn the
 * directory boost — right, because "both live at the repo root" is not evidence
 * of relatedness.
 */
function _dirKey(pathNorm) {
  const segs = pathNorm.split('/').filter(Boolean);
  if (segs.length < 2) return '';
  return segs.slice(0, Math.min(DIR_PREFIX_SEGMENTS, segs.length - 1)).join('/');
}

/** Date.parse or 0 — tie-break only, never a filter. */
function _createdMs(record) {
  const v = record?.created_at;
  if (typeof v !== 'string') return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

/** Epoch ms from a Date | number | undefined clock option. */
function _resolveNowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  return Date.now();
}

/**
 * The expiry gate. Matches the repo's existing active-filter convention exactly
 * (`surface.mjs::surfaceTopN`, `select.mjs::_isActive`): a record whose
 * `expires_at` parses and is `<= now` is expired. An unparseable or absent
 * `expires_at` reads as not-expired.
 *
 * Deliberately NO confidence floor here — the other two consumers filter on
 * confidence because they INJECT into a prompt. This one only proposes pairs
 * for judgment, and a low-confidence record is exactly the kind that a
 * duplicate/contradiction pass should be allowed to look at.
 */
function _isExpired(record, nowMs) {
  if (typeof record.expires_at !== 'string') return false;
  const ms = Date.parse(record.expires_at);
  return Number.isFinite(ms) && ms <= nowMs;
}

/** Total order over pool candidates: score DESC → created_at DESC → id ASC. */
function _compareCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const timeDiff = _createdMs(b.record) - _createdMs(a.record);
  if (timeDiff !== 0) return timeDiff;
  const aId = typeof a.record.id === 'string' ? a.record.id : '';
  const bId = typeof b.record.id === 'string' ? b.record.id : '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Representative pick inside an exact-key group: created_at DESC → id ASC. */
function _compareRepresentatives(a, b) {
  const timeDiff = _createdMs(b) - _createdMs(a);
  if (timeDiff !== 0) return timeDiff;
  const aId = typeof a.id === 'string' ? a.id : '';
  const bId = typeof b.id === 'string' ? b.id : '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/** Dialect-normalize one record, falling back to the raw shape on any quirk. */
function _canonical(record) {
  try {
    const out = normalizeDialects(record, { reserializeTimestamps: false });
    return _isRecord(out) ? out : record;
  } catch {
    // A dialect quirk must never abort a pooling run.
    return record;
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** The zero-value result. Built fresh per call — no shared singleton to mutate. */
export function emptyPools() {
  return {
    pools: [],
    duplicates: [],
    stats: {
      input: 0,
      expired: 0,
      unkeyable: 0,
      duplicateGroups: 0,
      duplicatesDropped: 0,
      scored: 0,
      pairs: 0,
      retained: 0,
      seedsWithPool: 0,
    },
  };
}

/**
 * Logical identity of a learning: `` `${type}/${kebab(title || subject)}` ``.
 *
 * Returns `null` when either half is unusable — mirroring
 * `validate/check-learning-provenance.mjs::learningKeyOf`, so an unkeyable
 * record simply does not participate in the exact-key pass. It still seeds and
 * joins pools: a missing title is not a reason to hide a learning from dedupe.
 *
 * @param {unknown} record
 * @returns {string|null}
 */
export function learningKey(record) {
  if (!_isRecord(record)) return null;
  const type = typeof record.type === 'string' ? record.type.trim() : '';
  const titleOrSubject =
    (typeof record.title === 'string' && record.title.trim() !== '' ? record.title : '') ||
    (typeof record.subject === 'string' && record.subject.trim() !== '' ? record.subject : '');
  if (type === '' || titleOrSubject === '') return null;
  const slug = kebab(titleOrSubject);
  // `kebab` may legally return '' (all-symbol input) — an empty slug is not an
  // identity, so such a record is unkeyable rather than colliding with every
  // other empty-slug record of the same type.
  if (slug === '') return null;
  return `${type}/${slug}`;
}

/**
 * Content tokens of one record: `subject ∪ insight`, minus {@link STOPWORDS}.
 *
 * Reuses `affinity.mjs::tokenize` for the lowercase/split/length/dedupe half —
 * a second tokenizer would be a second definition of "same word". The stoplist
 * and the field selection are the parts this module owns; `affinity()` reads
 * FIVE text fields including `evidence`, which is exactly what must not happen
 * here (module header, Stage 1).
 *
 * @param {unknown} record
 * @returns {string[]} deduped tokens in first-appearance order
 */
export function candidateTokens(record) {
  if (!_isRecord(record)) return [];
  try {
    const out = [];
    const seen = new Set();
    for (const field of ['subject', 'insight']) {
      for (const t of tokenize(record[field], { minTokenLength: MIN_TOKEN_LENGTH })) {
        if (STOPWORDS.has(t) || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * File-path boost for one pair: exact overlap > shared 2-level directory prefix
 * > nothing. Returns 0 when either side declares no usable path.
 *
 * The returned value is strictly less than {@link CANDIDATE_FLOOR} by
 * construction, so it can only ever RAISE a score above the floor that token
 * overlap already carried — never create a link on its own (accepted failure
 * mode 1's ceiling).
 *
 * @param {unknown} aPaths — normalized or raw path list
 * @param {unknown} bPaths
 * @returns {number} 0 | PATH_BOOST_DIR | PATH_BOOST_EXACT
 */
export function pathBoost(aPaths, bPaths) {
  const a = Array.isArray(aPaths) ? aPaths.map(_normalizePath).filter(Boolean) : [];
  const b = Array.isArray(bPaths) ? bPaths.map(_normalizePath).filter(Boolean) : [];
  if (a.length === 0 || b.length === 0) return 0;

  const exactB = new Set(b);
  for (const p of a) if (exactB.has(p)) return PATH_BOOST_EXACT;

  const dirsB = new Set();
  for (const p of b) {
    const d = _dirKey(p);
    if (d) dirsB.add(d);
  }
  for (const p of a) {
    const d = _dirKey(p);
    if (d && dirsB.has(d)) return PATH_BOOST_DIR;
  }
  return 0;
}

/**
 * Build the per-seed candidate pools for a set of learnings.
 *
 * @param {unknown} records — learning records (already read from disk)
 * @param {object} [opts]
 * @param {Date|number} [opts.now] — injectable clock for the expiry gate
 * @param {number} [opts.topK=CANDIDATE_TOP_K] — per-seed cap
 * @param {number} [opts.floor=CANDIDATE_FLOOR] — minimum pair score
 * @returns {CandidatePools} pools (non-empty ones only, in input order), the
 *   exact-key duplicate groups, and the counters the thresholds are judged by.
 *
 * The `seed` / `record` values handed back are the DIALECT-NORMALIZED shape
 * (legacy `files` read as `file_paths`, aliased types canonicalized), not the
 * caller's object identity — match them by `id`/`key`, never by `===`.
 * A seed with no candidates emits no pool; absence IS the "nothing related"
 * signal, so no empty-pool placeholders are returned.
 */
export function buildCandidatePools(records, opts = {}) {
  try {
    if (!Array.isArray(records) || records.length === 0) return emptyPools();

    const o = _isRecord(opts) ? opts : {};
    const nowMs = _resolveNowMs(o.now);
    const topK = Number.isInteger(o.topK) && o.topK >= 0 ? o.topK : CANDIDATE_TOP_K;
    const floor =
      typeof o.floor === 'number' && Number.isFinite(o.floor) ? o.floor : CANDIDATE_FLOOR;

    const result = emptyPools();
    const stats = result.stats;
    stats.input = records.length;

    // --- Stage 0.1/0.2: canonicalize + expiry gate ---------------------------
    /** @type {object[]} */
    const active = [];
    // Identity-dedupe: the same object reference passed twice would otherwise
    // become a pair with itself (score 1.0) and pollute every counter.
    const seenRefs = new Set();
    for (const raw of records) {
      if (!_isRecord(raw)) continue;
      if (seenRefs.has(raw)) continue;
      seenRefs.add(raw);
      const record = _canonical(raw);
      if (!_isRecord(record)) continue;
      if (_isExpired(record, nowMs)) {
        stats.expired++;
        continue;
      }
      active.push(record);
    }

    // --- Stage 0.3/0.4: exact learning_key pass, BEFORE any scoring ----------
    /** @type {Map<string, object[]>} */
    const byKey = new Map();
    /** @type {object[]} */
    const unkeyed = [];
    const keyOf = new Map();
    for (const record of active) {
      const key = learningKey(record);
      keyOf.set(record, key);
      if (key === null) {
        stats.unkeyable++;
        unkeyed.push(record);
        continue;
      }
      const group = byKey.get(key);
      if (group) group.push(record);
      else byKey.set(key, [record]);
    }

    /** Survivors of the exact-key pass, in input order. */
    const kept = new Set(unkeyed);
    for (const [key, group] of byKey) {
      if (group.length === 1) {
        kept.add(group[0]);
        continue;
      }
      const ranked = [...group].sort(_compareRepresentatives);
      kept.add(ranked[0]);
      stats.duplicateGroups++;
      stats.duplicatesDropped += ranked.length - 1;
      result.duplicates.push({ key, kept: ranked[0], dropped: ranked.slice(1) });
    }
    const pool = active.filter((r) => kept.has(r));
    stats.scored = pool.length;
    if (pool.length < 2) return result;

    // --- Stage 1: tokenise ---------------------------------------------------
    const tokenSets = pool.map((r) => new Set(candidateTokens(r)));
    const paths = pool.map((r) => _recordPaths(r));

    // --- Stage 2: IDF over the FILTERED corpus -------------------------------
    const n = pool.length;
    /** @type {Map<string, number>} */
    const df = new Map();
    for (const set of tokenSets) {
      for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
    }
    /** @type {Map<string, number>} */
    const idf = new Map();
    for (const [t, count] of df) idf.set(t, Math.log((n + 1) / (count + 0.5)));

    const idfSums = tokenSets.map((set) => {
      let sum = 0;
      for (const t of set) sum += idf.get(t) ?? 0;
      return sum;
    });

    // --- Stage 2/3: one pass over all unordered pairs ------------------------
    // O(N²) by design — 2.65 µs/pair measured, viable to ~N=2000. No inverted
    // index below that boundary (module header § Cost).
    /** @type {PoolCandidate[][]} */
    const perSeed = Array.from({ length: n }, () => []);

    for (let i = 0; i < n; i++) {
      const setI = tokenSets[i];
      for (let j = i + 1; j < n; j++) {
        stats.pairs++;
        const setJ = tokenSets[j];

        // Intersect over the smaller set — same result, half the work.
        const [small, large] = setI.size <= setJ.size ? [setI, setJ] : [setJ, setI];
        let interIdf = 0;
        const shared = [];
        for (const t of small) {
          if (!large.has(t)) continue;
          interIdf += idf.get(t) ?? 0;
          shared.push(t);
        }

        const denom = idfSums[i] + idfSums[j];
        const base = denom > 0 ? (2 * interIdf) / denom : 0;
        const boost = pathBoost(paths[i], paths[j]);
        const score = base + boost;
        if (!Number.isFinite(score) || score < floor) continue;
        stats.retained++;

        // Diagnostic only — the strongest shared terms, so a downstream judge
        // can see WHY the pair surfaced. Deterministic: idf DESC, then alpha.
        shared.sort((a, b) => {
          const d = (idf.get(b) ?? 0) - (idf.get(a) ?? 0);
          return d !== 0 ? d : a < b ? -1 : a > b ? 1 : 0;
        });
        const sharedTokens = shared.slice(0, SHARED_TOKEN_CAP);

        perSeed[i].push({
          record: pool[j],
          key: keyOf.get(pool[j]) ?? null,
          score,
          base,
          boost,
          type: typeof pool[j].type === 'string' ? pool[j].type : null,
          sharedTokens,
        });
        perSeed[j].push({
          record: pool[i],
          key: keyOf.get(pool[i]) ?? null,
          score,
          base,
          boost,
          type: typeof pool[i].type === 'string' ? pool[i].type : null,
          sharedTokens,
        });
      }
    }

    // --- Stage 3: top-K per seed. No union, no closure (failure mode 2). -----
    for (let i = 0; i < n; i++) {
      if (perSeed[i].length === 0) continue;
      perSeed[i].sort(_compareCandidates);
      const candidates = perSeed[i].slice(0, topK);
      if (candidates.length === 0) continue;
      stats.seedsWithPool++;
      result.pools.push({
        seed: pool[i],
        key: keyOf.get(pool[i]) ?? null,
        type: typeof pool[i].type === 'string' ? pool[i].type : null,
        candidates,
      });
    }

    return result;
  } catch {
    // Contract point 1 — every reachable path above is already total; this is
    // the last-resort net for an exotic input shape (throwing getter, Proxy).
    return emptyPools();
  }
}

/**
 * File entry-point: read through the existing funnel (`readLearnings` →
 * `normalizeLearning`, so dialects and type aliases are canonical), then pool.
 *
 * There is no second reader here on purpose — a private read path would be a
 * second place for the dialect normalization to drift out of.
 *
 * @param {string} filePath — absolute path to learnings.jsonl
 * @param {object} [opts] — everything {@link buildCandidatePools} accepts
 * @returns {Promise<CandidatePools>} {@link emptyPools} on a missing/unreadable file
 */
export async function buildCandidatePoolsFromFile(filePath, opts = {}) {
  try {
    const { entries } = await readLearnings(filePath);
    return buildCandidatePools(entries, opts);
  } catch {
    return emptyPools();
  }
}
