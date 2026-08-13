/**
 * learnings/judgment.mjs — the RELATION-judgment contract and its fail-closed
 * enforcement (#1016).
 *
 * ## Why this exists (the honest justification)
 *
 * NOT "clean up the contradictions we have". A wave-1 measurement over the live
 * corpus found zero true contradictions (max pairwise Jaccard 0.14, 0 exact
 * `(type, subject)` collisions, 97.9% of pairs at zero token overlap). Building
 * for a backlog that does not exist would be slop.
 *
 * The real justification is narrower: **four consumers of a `contradicted`
 * verdict already ship, and none has a producer.**
 *
 *   - `skills/evolve/SKILL.md:211`   — `-0.2 if contradicted`
 *   - `skills/evolve/SKILL.md:252`   — do NOT reset `expires_at` for contradicted
 *   - `skills/_shared/config-reading.md:134` — the lifecycle-state definition
 *   - `skills/session-end/learning-patterns.md:64` — the write step
 *
 * Today the only path into that branch is an operator hand-picking "Reduce
 * confidence" in an AUQ. This module is the missing producer — and, more
 * importantly, the gate that decides when a produced verdict is trustworthy
 * enough to reach any of those four.
 *
 * ## What this module is NOT
 *
 * NOT an LLM call. The judge invocation belongs to the `/evolve` wiring; here it
 * is an INJECTED function (`opts.judge`) that returns a candidate verdict.
 * NOT a write path: nothing here touches `learnings.jsonl`, the archive, or the
 * store. {@link applyVerdict} dispatches to caller-supplied effect handlers and
 * is the single choke point where a judgment may become an effect.
 * NOT a candidate-pool builder: which neighbours are worth showing is a sibling
 * concern (`./affinity.mjs` + its consumer). This module takes the pool as given.
 *
 * ## Why `store` is absent from the decision enum
 *
 * The persist decision already has an owner and its own operator AUQ
 * (`skills/evolve/SKILL.md` Step 3.4). Re-introducing `store` here would build a
 * SECOND, ungated write door into the same file. "No relation found" is
 * {@link JUDGMENT_DECISIONS `skip`}, not a store.
 *
 * `update` is split into `refine` and `supersede` because their remedies are
 * opposite: refinement keeps both records and links them, supersession archives
 * the old one (`_archive_reason: 'superseded'`, see `./expiry-sweep.mjs`). A
 * single `update` under-determines an irreversible branch.
 *
 * `abstain` is distinct from `skip` and the distinction is load-bearing:
 * `skip` = judged, no relation. `abstain` = could not judge. Collapsing them is
 * exactly how fail-open sneaks in — it makes an undecided case indistinguishable
 * from a decided one in telemetry and turns the `skip` count into a lie. Both
 * write nothing; only the counters differ.
 *
 * ## Surface, not scope — the canonical false positive
 *
 * Two LIVE records look like opposites at subject level and are NOT a
 * contradiction:
 *
 *   `5bd963d4-…` a rule-loader frontmatter key is INERT  → `rule-loader.mjs` key `paths:`
 *   `fe22ff1a-…` a rule-loader frontmatter key is LIVE   → `rule-loader.mjs` key `expires-at`
 *
 * Same file, different keys. Nothing mechanical separates them: measured
 * 2026-08-13 over the 100 live records, `scope` is `local` in 100/100 and
 * `host_class` is absent in 89/100 — **neither field discriminates**, and only
 * 17/100 carry `file_paths` at all (both records above carry none). A judgment
 * must therefore resolve its `surface` to IDENTIFIER level — file plus the key /
 * function / flag named in the insight text — which is why `surface` is a
 * required, non-empty field on every relation decision.
 *
 * ## Fail-CLOSED contract
 *
 * **The batch is atomic.** One malformed decision voids the WHOLE batch, not
 * just its own entry. Per-decision salvage is fail-open wearing a
 * partial-success costume.
 *
 * "No write" means, per decision type:
 *
 *   | decision            | no-write means                                                              |
 *   |---------------------|-----------------------------------------------------------------------------|
 *   | `skip` / `abstain`  | trivially none                                                              |
 *   | `refine`            | no rule file; no store mutation; no confidence delta; no `expires_at` reset; no link stamped |
 *   | `supersede`         | no archive append; no store rewrite; no `_archive_reason`/`_superseded_by` stamp |
 *   | `merge`             | no merged record; no source archived; the candidate is NOT consumed — it stays queued |
 *   | `contradict`        | no `-0.2`; no `expires_at` touched; **and no AskUserQuestion rendered**      |
 *
 * That last clause is the non-obvious one: **rendering an AUQ from an unreadable
 * judgment IS the write.** The AUQ is the write authorization — a garbled
 * verdict an operator approves has failed open *through the human*. Fail-closed
 * therefore means the operator never sees a proposal derived from an unreadable
 * judgment; it does not mean "the operator gets to decide about the garbage".
 * Structurally: the AUQ renderer is registered in {@link EFFECT_BY_DECISION}
 * alongside the archive writer, so it is unreachable by the same gate.
 *
 * One rule covering all eight failure modes: **the ONLY value that may be
 * written on any judgment path is a decision the parser produced and the
 * id-validity gate accepted. There is no default. There is no fallback member.
 * An absent decision performs nothing.**
 *
 * Consequences, spelled out because each was a named MUST-NOT:
 *   - No fallback decision on unparseable output (that is the upstream bug this
 *     issue exists to avoid) and no retry-with-repair into a write.
 *   - No salvage of the valid subset of a partial batch.
 *   - A phantom target id never creates the record and never gets dropped so the
 *     rest can proceed — a `supersede` with a silently truncated target list
 *     archives the WRONG record.
 *   - No coercion of an enum near-miss to the nearest member: coercion is how
 *     `abstain` becomes a write.
 *   - An empty response never reads as "no relation → safe". Absence of a
 *     verdict is not a verdict of no-relation.
 *   - A timeout never blocks session close and never auto-retries; the candidate
 *     simply stays queued (`requeueCandidate`).
 *
 * ## Tolerance boundary (deliberate)
 *
 * {@link parseJudgment} accepts a parsed object or a raw JSON string, and
 * NOTHING else — no fenced-code-block extraction, no trailing-comma repair, no
 * case-folding. Any tolerance added here is tolerance applied at the fail-closed
 * boundary itself. Providers that wrap JSON in prose must be unwrapped BEFORE
 * this call, by the caller, in a layer that cannot write.
 *
 * ## Contract
 *
 *   1. Never throws. Every entry point returns a verdict / result object.
 *   2. `verdict.ok === false` implies `verdict.decisions.length === 0` and
 *      `verdict.requeueCandidate === true`.
 *   3. {@link applyVerdict} invokes an effect handler only when
 *      `verdict.ok === true`, and validates every required handler is wired
 *      BEFORE invoking the first one (atomicity).
 *   4. Deterministic and clock-free: no `Date.now()`, no fs, no network.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Enums — closed vocabularies. Nothing coerces INTO these; membership is exact.
// ---------------------------------------------------------------------------

/** The six decisions. `store` is deliberately absent — see the module header. */
export const JUDGMENT_DECISIONS = Object.freeze([
  'skip',
  'refine',
  'supersede',
  'merge',
  'contradict',
  'abstain',
]);

/** Decisions that assert a relation to at least one other record. */
export const RELATION_DECISIONS = Object.freeze(['refine', 'supersede', 'merge', 'contradict']);

/** Decisions that assert no relation (`skip`) or no judgment (`abstain`). */
export const NO_RELATION_DECISIONS = Object.freeze(['skip', 'abstain']);

/**
 * The eight failure modes. Closed set — the free-text `detail` field carries
 * the discriminator within a mode, so the counter vocabulary stays stable for
 * telemetry across releases.
 */
export const FAILURE_MODES = Object.freeze([
  'unparseable',
  'partial',
  'phantom_id',
  'self_reference',
  'empty',
  'timeout',
  'enum_violation',
  'duplicate_target',
]);

/**
 * Decision → the effect-handler key {@link applyVerdict} may invoke for it.
 * `null` means "this decision performs nothing" (see the no-write table).
 *
 * `contradict` maps to `proposeContradiction` — the AskUserQuestion renderer —
 * on purpose: registering the AUQ in the SAME map as the archive writer is what
 * makes "an AUQ is a write" structural rather than a comment someone can miss.
 */
export const EFFECT_BY_DECISION = Object.freeze({
  skip: null,
  abstain: null,
  refine: 'refine',
  supersede: 'supersede',
  merge: 'merge',
  contradict: 'proposeContradiction',
});

/**
 * How many neighbours may be presented in one judgment input.
 *
 * Ceiling: 12 — the judge prompt is a budget, and the measured corpus tops out
 * at 0.14 pairwise Jaccard, so a wider net adds noise, not signal. Revisit if
 * the corpus develops genuine clusters (max pairwise similarity > ~0.4) or if
 * live judgments start naming a truncated-away record in their rationale.
 */
export const DEFAULT_MAX_NEIGHBOURS = 12;

/**
 * Judge wall-clock budget. Ceiling: 60s — a judgment pass runs at session-end
 * next to the close gates, and a stuck provider must never hold the close.
 * Revisit if a batched multi-candidate judge call replaces the per-candidate one.
 */
export const DEFAULT_JUDGE_TIMEOUT_MS = 60_000;

/**
 * The discrimination hint handed to the judge. Its facts are MEASURED, not
 * assumed (see the module header for the command and date) — a hint that told
 * the judge to lean on `scope` or `host_class` would be steering it by a field
 * that is constant across the corpus.
 */
export const SURFACE_HINT = [
  'Judge the SURFACE, not the subject line.',
  '',
  'Measured 2026-08-13 over the 100 live records: `scope` is "local" in 100/100 and',
  '`host_class` is absent in 89/100. NEITHER FIELD DISCRIMINATES — do not use them to',
  'separate or to relate two records. Only 17/100 carry `file_paths` at all.',
  '',
  'Resolve the surface to IDENTIFIER level: the file plus the specific key, function,',
  'flag, or command the record is about — taking identifiers from `file_paths` AND from',
  'the identifiers named in the insight text, since most records carry no `file_paths`.',
  '',
  'Two records that name the SAME FILE but DIFFERENT identifiers are NOT in conflict.',
  'Worked example from the live corpus, which is NOT a contradiction:',
  '  A: a rule-loader frontmatter key is inert  -> surface: rule-loader.mjs frontmatter key "paths:"',
  '  B: a rule-loader frontmatter key is live   -> surface: rule-loader.mjs frontmatter key "expires-at"',
  'Same file, different keys, same `scope`, both without `host_class`.',
  '',
  'When the surface cannot be resolved to identifier level, answer "abstain" — never',
  'guess a relation from a file name alone.',
].join('\n');

/**
 * The output shape, co-located with the validator that enforces it. The judge
 * prompt MUST embed this rather than restating the shape in skill prose: a
 * restatement drifts silently, and the failure mode of drift here is that every
 * batch voids and the feature is dead while looking wired.
 */
export const JUDGMENT_OUTPUT_CONTRACT = [
  'Answer with JSON only, exactly this shape:',
  '',
  '{"candidate_id": "<the candidate id you were given>",',
  ' "decisions": [',
  '   {"decision": "skip|refine|supersede|merge|contradict|abstain",',
  '    "target_ids": ["<id from the presented neighbours>"],',
  '    "surface": "<file + identifier this decision is about>",',
  '    "rationale": "<one sentence that NAMES the surface>",',
  '    "confidence": 0.0}',
  ' ]}',
  '',
  'Rules the reader enforces (a violation voids the WHOLE batch — nothing is written):',
  '  - `decision` must be one of the six members EXACTLY, lowercase. No other value.',
  '  - `target_ids` must be empty for `skip` and `abstain`, and non-empty otherwise.',
  '  - Every target id must be one of the ids presented to you. Never invent an id.',
  '  - Never put the candidate id in `target_ids`.',
  '  - Never name the same target id twice, in one decision or across the batch.',
  '  - `surface` and `rationale` are required for refine/supersede/merge/contradict,',
  '    and the rationale must name the surface.',
  '  - `confidence` is a number in [0,1] on every decision.',
  '  - Emit `abstain` when you cannot judge. Never guess, never emit a default.',
].join('\n');

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** A judge cannot forge a module-private Symbol, so a timeout cannot be spoofed. */
const TIMEOUT_SENTINEL = Symbol('judgment-timeout');

/** True for a plain-ish object we may read properties off (arrays excluded). */
function _isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Non-empty string after trimming. */
function _isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Confidence must be a real number in [0,1]. NaN/Infinity/null all fail. */
function _isValidConfidence(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * A record is LIVE only if it carries no archive tombstone. `_archived_at` /
 * `_archive_reason` are stamped by `./expiry-sweep.mjs` on everything that
 * leaves the active store. Presenting an archived record as a neighbour would
 * invite a `supersede` that archives an already-archived record — a legal-looking
 * path to a dangling tombstone pointer.
 */
function _isLive(entry) {
  if (!_isRecord(entry)) return false;
  return entry._archived_at === undefined && entry._archive_reason === undefined;
}

/**
 * Does the rationale name the surface?
 *
 * Lexical containment: the whole surface, or any of its tokens of length >= 3.
 * Ceiling: this is lexical, NOT semantic — a rationale that refers to the
 * surface only by synonym is rejected, and rejection means the batch voids.
 * That asymmetry is deliberate (a false void costs one missed judgment; a
 * vacuous rationale costs an unreviewable write). Revisit if live judgments trip
 * this on more than a rare case.
 */
function _rationaleNamesSurface(rationale, surface) {
  const r = rationale.toLowerCase();
  const s = surface.toLowerCase().trim();
  if (s.length > 0 && r.includes(s)) return true;
  const tokens = s.split(/[^a-z0-9_.-]+/).filter((t) => t.length >= 3);
  return tokens.some((t) => r.includes(t));
}

/** The zero-value counter block. Built fresh — never a shared mutable singleton. */
function _emptyCounters() {
  /** @type {Record<string, number>} */
  const failure_modes = {};
  for (const m of FAILURE_MODES) failure_modes[m] = 0;
  /** @type {Record<string, number>} */
  const decisions = {};
  for (const d of JUDGMENT_DECISIONS) decisions[d] = 0;
  return { batches: 1, voided: 0, failure_modes, decisions };
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * @typedef {{decision: string, target_ids: string[], surface: string,
 *            rationale: string, confidence: number}} JudgmentDecision
 *
 * @typedef {{ok: boolean, candidate_id: string|null, decisions: JudgmentDecision[],
 *            failureMode: string|null, detail: string, requeueCandidate: boolean,
 *            counters: object}} Verdict
 */

/**
 * Build a voided verdict — the ONLY shape any failure path produces.
 *
 * Exported so the `/evolve` wiring can void on a transport failure it detects
 * before this module ever sees output (a dropped connection, a refused call)
 * without hand-rolling a second, subtly different "nothing happened" object.
 *
 * A voided verdict carries ZERO decisions by construction: there is no field a
 * caller could read to salvage a partial batch. `requeueCandidate` is always
 * true — the candidate was not consumed and stays queued for the next pass.
 *
 * @param {string} failureMode — one of {@link FAILURE_MODES}
 * @param {string} [detail] — free-text discriminator; never used for control flow
 * @param {string|null} [candidateId]
 * @returns {Verdict}
 */
export function voidVerdict(failureMode, detail = '', candidateId = null) {
  const counters = _emptyCounters();
  const mode = FAILURE_MODES.includes(failureMode) ? failureMode : 'unparseable';
  counters.voided = 1;
  counters.failure_modes[mode] += 1;
  // A voided batch resolves to abstain, never to skip: an undecided case must
  // stay distinguishable from a decided one in telemetry.
  counters.decisions.abstain += 1;
  return {
    ok: false,
    candidate_id: typeof candidateId === 'string' ? candidateId : null,
    decisions: [],
    failureMode: mode,
    detail: typeof detail === 'string' ? detail : '',
    requeueCandidate: true,
    counters,
  };
}

/**
 * Build the corpus fingerprint: the set of ids a verdict may legally name.
 *
 * The valid id set is exactly the ids PRESENTED to the judge, not the whole
 * store. That is the stronger gate and it subsumes the weaker one: a judge
 * cannot legitimately relate the candidate to a record it was never shown, and
 * "was this id presented" is checkable without a second read of the store —
 * which is the whole point of shipping the fingerprint inside the input.
 *
 * @param {object[]} records — the neighbours that will be presented
 * @returns {{ids: string[], count: number, digest: string}}
 */
export function buildCorpusFingerprint(records) {
  const seen = new Set();
  if (Array.isArray(records)) {
    for (const r of records) {
      const id = _isRecord(r) ? r.id : undefined;
      if (typeof id === 'string' && id.length > 0) seen.add(id);
    }
  }
  const ids = [...seen].sort();
  // Digest over the sorted ids lets a caller detect a verdict computed against a
  // DIFFERENT presentation (a stale retry, a reordered pool) for the price of
  // one hash; `parseJudgment` enforces it only when the verdict echoes it back.
  const digest = createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16);
  return { ids, count: ids.length, digest };
}

/**
 * Assemble the judgment input.
 *
 * Neighbours are filtered to LIVE records only, the candidate is never its own
 * neighbour, and the set is capped at `maxNeighbours` in the order given (the
 * caller's ranking is authoritative — this module adds no second ranking).
 *
 * @param {object} args
 * @param {object} args.candidate — the record under judgment
 * @param {object[]} args.neighbours — bounded candidate pool, LIVE store only
 * @param {number} [args.maxNeighbours=DEFAULT_MAX_NEIGHBOURS]
 * @returns {{candidate: object, neighbours: object[], corpus_fingerprint: object,
 *            surface_hint: string, decisions_allowed: readonly string[],
 *            output_contract: string}|null}
 *   `null` when the candidate has no usable id — an input whose id gate cannot
 *   be checked must not be judged at all.
 */
export function buildJudgmentInput({
  candidate,
  neighbours,
  maxNeighbours = DEFAULT_MAX_NEIGHBOURS,
} = {}) {
  if (!_isRecord(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null;
  }
  const cap =
    Number.isInteger(maxNeighbours) && maxNeighbours >= 0 ? maxNeighbours : DEFAULT_MAX_NEIGHBOURS;

  const pool = [];
  const seenIds = new Set();
  for (const n of Array.isArray(neighbours) ? neighbours : []) {
    if (pool.length >= cap) break;
    if (!_isLive(n)) continue;
    if (typeof n.id !== 'string' || n.id.length === 0) continue;
    if (n.id === candidate.id) continue; // never its own neighbour — see F4
    if (seenIds.has(n.id)) continue;
    seenIds.add(n.id);
    pool.push(n);
  }

  return {
    candidate,
    neighbours: pool,
    corpus_fingerprint: buildCorpusFingerprint(pool),
    surface_hint: SURFACE_HINT,
    decisions_allowed: JUDGMENT_DECISIONS,
    output_contract: JUDGMENT_OUTPUT_CONTRACT,
  };
}

/**
 * Parse and validate a candidate verdict against its input. Never throws.
 *
 * Precedence is declaration order below; the FIRST violation encountered voids
 * the batch and names the mode. Validation is total before anything is returned:
 * there is no path that returns a subset of the decisions.
 *
 * @param {string|object} raw — raw JSON text, or an already-parsed object
 * @param {object} input — the {@link buildJudgmentInput} result the judge saw
 * @returns {Verdict}
 */
export function parseJudgment(raw, input) {
  // The id gate is uncheckable without a usable input, so an unusable input is
  // itself a void — never a permissive pass-through.
  if (
    !_isRecord(input) ||
    !_isRecord(input.candidate) ||
    typeof input.candidate.id !== 'string' ||
    input.candidate.id.length === 0 ||
    !_isRecord(input.corpus_fingerprint) ||
    !Array.isArray(input.corpus_fingerprint.ids)
  ) {
    return voidVerdict('partial', 'judgment-input-unusable: cannot check the id gate');
  }

  const candidateId = input.candidate.id;
  const validIds = new Set(input.corpus_fingerprint.ids);

  // F5 — empty response. Zero bytes / whitespace / nullish is NOT "no relation".
  if (raw === null || raw === undefined) {
    return voidVerdict('empty', 'judge returned no output', candidateId);
  }
  if (typeof raw === 'string' && raw.trim().length === 0) {
    return voidVerdict('empty', 'judge returned an empty string', candidateId);
  }

  // F1 — unparseable. No fence stripping, no repair (see § Tolerance boundary).
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return voidVerdict('unparseable', `JSON.parse failed: ${err?.message ?? err}`, candidateId);
    }
  }
  if (!_isRecord(parsed)) {
    return voidVerdict(
      'unparseable',
      `expected a JSON object envelope, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      candidateId,
    );
  }

  // F2 — partial. Envelope fields.
  if (parsed.candidate_id !== candidateId) {
    return voidVerdict(
      'partial',
      `candidate_id mismatch: expected ${candidateId}, got ${JSON.stringify(parsed.candidate_id)}`,
      candidateId,
    );
  }
  if (parsed.corpus_fingerprint !== undefined) {
    // Only enforced when the judge echoes it back — an echo that disagrees means
    // the verdict was computed against a different presentation.
    const echoed = _isRecord(parsed.corpus_fingerprint)
      ? parsed.corpus_fingerprint.digest
      : parsed.corpus_fingerprint;
    if (echoed !== input.corpus_fingerprint.digest) {
      return voidVerdict(
        'partial',
        'corpus_fingerprint echo does not match the input',
        candidateId,
      );
    }
  }
  if (!Array.isArray(parsed.decisions)) {
    return voidVerdict('partial', 'envelope has no `decisions` array', candidateId);
  }
  if (parsed.decisions.length === 0) {
    return voidVerdict('empty', 'envelope carries zero decisions', candidateId);
  }

  /** @type {JudgmentDecision[]} */
  const decisions = [];
  const targetsSeen = new Set();

  for (let i = 0; i < parsed.decisions.length; i++) {
    const d = parsed.decisions[i];
    const at = `decisions[${i}]`;

    if (!_isRecord(d)) return voidVerdict('partial', `${at} is not an object`, candidateId);

    // F2 before F7: an ABSENT decision field is partial output; a PRESENT but
    // wrong one (including casing drift) is an enum violation.
    if (d.decision === undefined || d.decision === null) {
      return voidVerdict('partial', `${at} has no \`decision\``, candidateId);
    }
    // F7 — enum violation. Exact membership. Nothing is coerced to the nearest
    // member: coercion is how `abstain` becomes a write.
    if (typeof d.decision !== 'string' || !JUDGMENT_DECISIONS.includes(d.decision)) {
      return voidVerdict(
        'enum_violation',
        `${at}.decision is not an exact enum member: ${JSON.stringify(d.decision)}`,
        candidateId,
      );
    }
    if (d.candidate_id !== undefined && d.candidate_id !== candidateId) {
      return voidVerdict(
        'partial',
        `${at}.candidate_id mismatch: ${JSON.stringify(d.candidate_id)}`,
        candidateId,
      );
    }

    const isRelation = RELATION_DECISIONS.includes(d.decision);

    if (!Array.isArray(d.target_ids)) {
      return voidVerdict('partial', `${at} has no \`target_ids\` array`, candidateId);
    }
    // Empty IFF skip/abstain — both directions are a shape violation.
    if (isRelation && d.target_ids.length === 0) {
      return voidVerdict('partial', `${at}.target_ids is empty for "${d.decision}"`, candidateId);
    }
    if (!isRelation && d.target_ids.length > 0) {
      return voidVerdict(
        'partial',
        `${at}.target_ids must be empty for "${d.decision}"`,
        candidateId,
      );
    }

    for (const tid of d.target_ids) {
      if (!_isNonEmptyString(tid)) {
        return voidVerdict(
          'partial',
          `${at}.target_ids contains a non-string id: ${JSON.stringify(tid)}`,
          candidateId,
        );
      }
      // F4 — self-reference. Archiving a record into itself is data loss through
      // a legal-looking path. Checked before the phantom gate so a self-reference
      // is never mis-reported as a phantom id.
      if (tid === candidateId) {
        return voidVerdict(
          'self_reference',
          `${at}.target_ids names the candidate itself (${tid})`,
          candidateId,
        );
      }
      // F3 — phantom id. The bad id is NOT dropped so the rest can proceed: a
      // `supersede` with a truncated target list archives the wrong record.
      if (!validIds.has(tid)) {
        return voidVerdict(
          'phantom_id',
          `${at}.target_ids names an id that was never presented: ${tid}`,
          candidateId,
        );
      }
      // F8 — duplicate target. Applying in array order would let the second
      // write operate on an already-archived record.
      if (targetsSeen.has(tid)) {
        return voidVerdict('duplicate_target', `${at}.target_ids repeats ${tid}`, candidateId);
      }
      targetsSeen.add(tid);
    }

    // `surface` / `rationale` are required on RELATION decisions only. A decision
    // that writes nothing needs no surface — and demanding one would void batches
    // for a field that guards nothing.
    if (isRelation) {
      if (!_isNonEmptyString(d.surface)) {
        return voidVerdict('partial', `${at} has no non-empty \`surface\``, candidateId);
      }
      if (!_isNonEmptyString(d.rationale)) {
        return voidVerdict('partial', `${at} has no non-empty \`rationale\``, candidateId);
      }
      if (!_rationaleNamesSurface(d.rationale, d.surface)) {
        return voidVerdict(
          'partial',
          `${at}.rationale does not name the surface "${d.surface}"`,
          candidateId,
        );
      }
    } else if (d.surface !== undefined && typeof d.surface !== 'string') {
      return voidVerdict('partial', `${at}.surface is not a string`, candidateId);
    } else if (d.rationale !== undefined && typeof d.rationale !== 'string') {
      return voidVerdict('partial', `${at}.rationale is not a string`, candidateId);
    }

    if (!_isValidConfidence(d.confidence)) {
      return voidVerdict(
        'partial',
        `${at}.confidence is not a number in [0,1]: ${JSON.stringify(d.confidence)}`,
        candidateId,
      );
    }

    decisions.push(
      Object.freeze({
        decision: d.decision,
        target_ids: Object.freeze([...d.target_ids]),
        surface: typeof d.surface === 'string' ? d.surface : '',
        rationale: typeof d.rationale === 'string' ? d.rationale : '',
        confidence: d.confidence,
      }),
    );
  }

  const counters = _emptyCounters();
  for (const d of decisions) counters.decisions[d.decision] += 1;

  return {
    ok: true,
    candidate_id: candidateId,
    decisions,
    failureMode: null,
    detail: '',
    // A `merge` consumes the candidate only once it is APPLIED; on any void the
    // candidate is untouched and stays queued.
    requeueCandidate: false,
    counters,
  };
}

/**
 * Run the injected judge under a timeout and validate whatever comes back.
 * Never throws, never retries, never blocks longer than `timeoutMs`.
 *
 * A judge that throws maps to `unparseable` — no readable verdict came back, and
 * every MUST-NOT of that mode applies identically (no default, no repair-retry,
 * no AUQ). The thrown message lands in `detail`, which is diagnostic only.
 *
 * @param {object} input — a {@link buildJudgmentInput} result
 * @param {object} opts
 * @param {(input: object) => any} opts.judge — injected; returns raw JSON text or an object
 * @param {number} [opts.timeoutMs=DEFAULT_JUDGE_TIMEOUT_MS]
 * @returns {Promise<Verdict>}
 */
export async function judgeCandidate(input, opts = {}) {
  const candidateId = _isRecord(input) && _isRecord(input.candidate) ? input.candidate.id : null;
  const judge = _isRecord(opts) ? opts.judge : undefined;
  if (typeof judge !== 'function') {
    return voidVerdict('unparseable', 'no judge function injected', candidateId ?? null);
  }
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_JUDGE_TIMEOUT_MS;

  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
      // Unref so a resolved-early judge lets the process exit without waiting
      // out the full budget (testing.md § Async & Timeout Patterns).
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    const raw = await Promise.race([Promise.resolve().then(() => judge(input)), timeout]);
    if (raw === TIMEOUT_SENTINEL) {
      // F6 — never applies a partially-streamed array, never auto-retries, never
      // blocks session close. The candidate simply stays queued.
      return voidVerdict('timeout', `judge exceeded ${timeoutMs}ms`, candidateId ?? null);
    }
    return parseJudgment(raw, input);
  } catch (err) {
    return voidVerdict('unparseable', `judge threw: ${err?.message ?? err}`, candidateId ?? null);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The single choke point where a judgment may become an effect.
 *
 * Refuses outright unless `verdict.ok === true`, so every one of the eight
 * failure modes reaches zero handler invocations — including
 * `proposeContradiction`, the AskUserQuestion renderer, because rendering an AUQ
 * from an unreadable judgment IS the write.
 *
 * Handlers are resolved for the WHOLE batch before the first invocation: an
 * unwired handler refuses the batch instead of applying the decisions that
 * happened to come first.
 *
 * Ceiling: already-invoked effects are NOT rolled back when a later handler
 * throws — transactionality across heterogeneous effects (archive append + store
 * rewrite + AUQ) belongs to the caller that owns those resources. Revisit if a
 * batch can carry more than one relation decision with interdependent writes.
 *
 * @param {Verdict} verdict
 * @param {Record<string, (decision: JudgmentDecision, verdict: Verdict) => any>} [effects]
 * @returns {Promise<{applied: boolean, invoked: string[], results: any[], refused: string|null}>}
 */
export async function applyVerdict(verdict, effects = {}) {
  const refuse = (reason) => ({ applied: false, invoked: [], results: [], refused: reason });

  if (!_isRecord(verdict) || verdict.ok !== true || !Array.isArray(verdict.decisions)) {
    return refuse(
      `verdict-not-ok:${_isRecord(verdict) ? (verdict.failureMode ?? 'unknown') : 'malformed'}`,
    );
  }
  if (verdict.decisions.length === 0) return refuse('verdict-has-no-decisions');

  const handlers = _isRecord(effects) ? effects : {};

  // Pass 1 — resolve every required handler. Nothing is invoked yet.
  /** @type {{decision: JudgmentDecision, key: string, fn: Function}[]} */
  const plan = [];
  for (const d of verdict.decisions) {
    const key = EFFECT_BY_DECISION[d.decision];
    if (!key) continue; // skip / abstain perform nothing
    const fn = handlers[key];
    if (typeof fn !== 'function') return refuse(`effect-not-wired:${key}`);
    plan.push({ decision: d, key, fn });
  }

  // Pass 2 — invoke.
  const invoked = [];
  const results = [];
  for (const step of plan) {
    try {
      results.push(await step.fn(step.decision, verdict));
      invoked.push(step.key);
    } catch (err) {
      return {
        applied: false,
        invoked,
        results,
        refused: `effect-threw:${step.key}:${err?.message ?? err}`,
      };
    }
  }

  return { applied: true, invoked, results, refused: null };
}
