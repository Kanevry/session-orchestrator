/**
 * sessions-canonical.mjs — one record per physical session (#1167).
 *
 * `.orchestrator/metrics/sessions.jsonl` is APPEND-ONLY by design: nothing is
 * ever rewritten in place, so the same physical session can appear more than
 * once. A consumer that treats "one line = one session" therefore over-counts,
 * and every duration/effectiveness aggregate computed from the raw file is
 * silently wrong by however many duplicates happen to sit in its window.
 *
 * This module is the READ-side collapse. It never repairs the file (see § 3).
 *
 * ── THE THREE RULES, AND WHAT MEASURED THEM ─────────────────────────────────
 *
 * (1) NEWEST-WINS PER `session_id`.
 *     File order is chronological, so the LAST record carrying an id is the
 *     current one. This is the same reading rule
 *     `session-close-backfill.mjs::classifyExisting()` already applies (it
 *     takes `matches[matches.length - 1]`); this module generalises it to the
 *     whole file. Measured 2026-09-02 @ c3ab480 over 286 records: one id
 *     (2026-05-10) carries a byte-identical duplicate LINE — an older
 *     collision class than (3), and rule (1) alone resolves it.
 *
 * (2) NARROW COLLAPSE OF THE SYSTEMIC DOUBLE-STUB CLASS.
 *     Two `abandoned` records with an EXACT `started_at` + `completed_at`
 *     tuple match are one physical session recorded twice by the two backfill
 *     writers: `hooks/on-session-end.mjs` resolves the semantic id from
 *     `current-session.json` and writes `main-YYYY-MM-DD-session-N`, while
 *     `scripts/backfill-abandoned-sessions.mjs` could resolve a semantic id
 *     ONLY via `orchestrator.session.lock.acquired` — a session that lost the
 *     lock-acquire race has no such event, so it fell through to the synthetic
 *     mint (`<branch>-<date>-abandoned-<sha8>`, `_synthetic_session_id: true`)
 *     and wrote a SECOND stub for the same session. The join-back was
 *     impossible because `raw_session_id` is null on 286/286 records
 *     (`jq -s '[.[]|select(.raw_session_id != null)]|length'` → 0, measured
 *     2026-09-02 @ c3ab480), so the two records share no key at all — only
 *     their millisecond-identical timestamps.
 *     Measured population: 8 such pairs over 6 weeks (16 records), via
 *     `jq -r '[.started_at,.completed_at,.status]|@tsv' … | sort | uniq -d`.
 *     The NON-synthetic record survives; the synthetic mint is the artefact.
 *
 *     Deliberately narrow. The collapse requires BOTH records to be
 *     `status: 'abandoned'` and BOTH timestamps to be present and equal.
 *     `started_at` alone is NOT enough (two real sessions can start in the
 *     same millisecond of a re-fire), and `completed` records are never
 *     collapsed (an authoritative record is a truth claim about itself, never
 *     an artefact of a second writer).
 *
 * (3) AN ATTESTABLE `supersedes: X` REMOVES record X.
 *     The #1068 AC3/AC4 supersede path appends an authoritative `completed`
 *     record carrying a forward pointer to the backfilled `abandoned` stub it
 *     refutes. The stub is kept on disk verbatim (AC4 — forensic provenance);
 *     a canonical READER must drop it, or the same session is counted as both
 *     abandoned and completed.
 *
 *     Two constraints, both measured defects of the first implementation:
 *       - ORDER-INDEPENDENT. A record is dropped iff some SURVIVING record
 *         supersedes it (a fixpoint over the supersede graph; cycles broken by
 *         keeping the newest member). Deleting in file order made a chain
 *         `C → B → A` resolve to `{C, A}` or `{C}` depending on the
 *         permutation the appends happened to land in, and a mutual pair
 *         resolved by insertion order.
 *       - ATTESTABLE ONLY. The marker is honoured only when the target is not
 *         authoritative (`status` `abandoned`, or absent on a legacy stub —
 *         never `completed`) AND the two records share a join key (equal
 *         `raw_session_id`, or byte-equal `started_at` — the shape
 *         `session-close-backfill.mjs::synthesizeRecord()` emits, since stub
 *         and superseder are synthesized from the same gathered events).
 *         Without that constraint ONE appended line could delete ANY id from
 *         EVERY reader of this module, the armed autonomy verdict included. A
 *         refused marker keeps both records and is reported (never logged)
 *         via `canonicalizeSessionsDetailed().ignoredSupersedes`.
 *
 * RULE ORDER: (1) → (2) → (3). The double-stub collapse must run BEFORE
 * supersede removal: with the reverse order a `supersedes` append deleted the
 * authentic stub first, shrank the tuple group to a single member, and the
 * synthetic phantom then survived the very session that refuted it.
 *
 * ── WHAT THIS MODULE DOES NOT DO ────────────────────────────────────────────
 *   - It never writes. The 8 historical pairs stay on disk; the ledger is
 *     append-only and the duplicates are their own provenance.
 *   - It is not a phantom filter. `status: 'abandoned'` records SURVIVE here —
 *     dropping them is `session-schema/filters.mjs`'s job
 *     (`isRealSession` / `filterRealSessions` / `tailRealSessions`), and the
 *     two compose: canonicalize first, then filter.
 *
 * Plain Node ESM. Named exports. `canonicalizeSessions` is pure; only
 * `readCanonicalSessions` touches the filesystem (sync, `readFileSync`).
 */

import fs from 'node:fs';
import path from 'node:path';

const SESSIONS_REL = ['.orchestrator', 'metrics', 'sessions.jsonl'];

/**
 * True when the value is a usable record object (not null, not an array).
 * @param {unknown} v
 * @returns {boolean}
 */
function isRecordObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Non-empty string guard — `''` is never a usable id or timestamp. */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

/**
 * The timestamp a record is ordered by when a supersede CYCLE has to be broken:
 * `completed_at` when present, else `started_at`, else `''` (sorts last).
 * ISO-8601 strings compare lexicographically, so no Date parsing is needed.
 * @param {object} rec
 * @returns {string}
 */
function cycleOrderTimestamp(rec) {
  if (isNonEmptyString(rec.completed_at)) return rec.completed_at;
  if (isNonEmptyString(rec.started_at)) return rec.started_at;
  return '';
}

/**
 * True when `superseder`'s `supersedes` marker is ATTESTABLE against `target`.
 *
 * `supersedes` is a forward pointer inside an append-only file that anyone (or
 * any buggy writer) can append a line to, and a reader that obeys it blindly
 * lets a single appended line delete ANY id from EVERY consumer — including the
 * armed autonomy verdict. So the marker is honoured only for the shape the
 * #1068 writer actually produces: the stub it refutes is never an AUTHORITATIVE
 * record — its `status` is `abandoned`, or absent/null on a legacy stub, but
 * never any other declared status (a `completed` record is a truth claim about
 * itself and can never be deleted by an appended pointer) — and both records
 * were synthesized from the SAME gathered events, hence share an attestable
 * join key —
 *   - equal non-empty `raw_session_id` (the #1167 harness-uuid join), or
 *   - byte-equal non-empty `started_at` (`session-close-backfill.mjs`
 *     `synthesizeRecord()` derives `startedIso` from the same event set for the
 *     stub and for the record that supersedes it).
 * Anything else is a data-integrity anomaly: BOTH records are kept and the
 * marker is reported via `canonicalizeSessionsDetailed().ignoredSupersedes`.
 *
 * @param {object} superseder
 * @param {object} target
 * @returns {string|null} null when the marker is valid, else the reject reason
 */
function supersedeRejectReason(superseder, target) {
  // Absent/null `status` is a legacy stub, not an authoritative record; any
  // OTHER declared status (`completed` above all) is untouchable.
  if (isNonEmptyString(target.status) && target.status !== 'abandoned') {
    return 'target-not-abandoned';
  }
  const a = superseder.raw_session_id;
  const b = target.raw_session_id;
  if (isNonEmptyString(a) && isNonEmptyString(b) && a === b) return null;
  if (isNonEmptyString(superseder.started_at) && superseder.started_at === target.started_at) {
    return null;
  }
  return 'no-shared-join-key';
}

/**
 * Rule (3) — collapse the systemic two-writer double stub. Mutates `byId` by
 * deleting the synthetic twin of each qualifying pair.
 * @param {Map<string, object>} byId
 * @returns {void}
 */
function collapseAbandonedTuples(byId) {
  // Group ONLY the records eligible for the systemic double-stub class; every
  // other record bypasses this pass entirely and can never be dropped by it.
  const byTuple = new Map();
  for (const rec of byId.values()) {
    if (rec.status !== 'abandoned') continue;
    if (!isNonEmptyString(rec.started_at) || !isNonEmptyString(rec.completed_at)) continue;
    const key = `${rec.started_at} ${rec.completed_at}`;
    const group = byTuple.get(key);
    if (group) group.push(rec);
    else byTuple.set(key, [rec]);
  }
  for (const group of byTuple.values()) {
    if (group.length < 2) continue;
    const authentic = group.filter((r) => r._synthetic_session_id !== true);
    // All-synthetic (or all-authentic) groups are left intact: with no
    // non-synthetic record to prefer there is no evidence about WHICH one is
    // the artefact, and guessing would delete a session nobody can recover.
    if (authentic.length === 0 || authentic.length === group.length) continue;
    for (const rec of group) {
      if (rec._synthetic_session_id === true) byId.delete(rec.session_id);
    }
  }
}

/**
 * Rule (2) — order-independent supersede resolution. Mutates `byId` by deleting
 * every record that a SURVIVING record supersedes, and appends every rejected
 * marker to `ignored`.
 *
 * A record is dropped iff some record that itself survives supersedes it; the
 * marking is a fixpoint over the supersede graph, so it depends on the EDGES
 * only, never on the order the records appear in the file. A chain
 * `C → B → A` therefore always resolves to `{C, A}` (B is dropped by the
 * surviving C, so B's own marker no longer removes A).
 *
 * A cycle (`X → Y`, `Y → X`) has no fixpoint; it is broken deterministically by
 * keeping the NEWEST member (`completed_at ?? started_at`, ties by ascending
 * `session_id`) and re-running the propagation.
 *
 * @param {Map<string, object>} byId
 * @param {Array<{by: string, target: string, reason: string}>} ignored
 * @returns {void}
 */
function resolveSupersedes(byId, ignored) {
  /** targetId → Set of ids of records that validly supersede it. */
  const supersededBy = new Map();
  for (const rec of byId.values()) {
    const target = rec.supersedes;
    if (!isNonEmptyString(target) || target === rec.session_id) continue;
    const targetRec = byId.get(target);
    // A marker pointing at an id that is not present removes nothing; it is not
    // an anomaly either (the target may legitimately have been collapsed by
    // rule 3 first, or simply predate this window of the ledger).
    if (!targetRec) continue;
    const reason = supersedeRejectReason(rec, targetRec);
    if (reason !== null) {
      ignored.push({ by: rec.session_id, target, reason });
      continue;
    }
    const set = supersededBy.get(target);
    if (set) set.add(rec.session_id);
    else supersededBy.set(target, new Set([rec.session_id]));
  }
  if (supersededBy.size === 0) return;

  const ids = [...byId.keys()];
  /** id → 'alive' | 'dead'; absent = not yet decided. */
  const state = new Map();
  for (;;) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of ids) {
        if (state.has(id)) continue;
        const sup = supersededBy.get(id);
        if (!sup || sup.size === 0) {
          state.set(id, 'alive');
          changed = true;
          continue;
        }
        let anyAlive = false;
        let allDead = true;
        for (const s of sup) {
          const st = state.get(s);
          if (st === 'alive') anyAlive = true;
          if (st !== 'dead') allDead = false;
        }
        if (anyAlive) {
          state.set(id, 'dead');
          changed = true;
        } else if (allDead) {
          state.set(id, 'alive');
          changed = true;
        }
      }
    }
    const undecided = ids.filter((id) => !state.has(id));
    if (undecided.length === 0) break;
    // Cycle: keep the newest member, then let propagation settle the rest.
    undecided.sort((a, b) => {
      const ta = cycleOrderTimestamp(byId.get(a));
      const tb = cycleOrderTimestamp(byId.get(b));
      if (ta !== tb) return ta < tb ? 1 : -1;
      return a < b ? -1 : 1;
    });
    state.set(undecided[0], 'alive');
  }

  for (const [id, st] of state) {
    if (st === 'dead') byId.delete(id);
  }
}

/**
 * Collapse a raw sessions.jsonl record array to one record per physical
 * session AND report the supersede markers that were refused. Pure — the input
 * array is never mutated.
 *
 * Rules, applied in this order (see the module header for the measured
 * justification of each):
 *   1. newest-wins per `session_id` (file order is chronological);
 *   2. two `abandoned` records with an exact, both-present
 *      `started_at` + `completed_at` tuple collapse to the non-synthetic one;
 *   3. a surviving record's ATTESTABLE `supersedes: X` removes record `X`.
 *
 * The double-stub collapse runs BEFORE supersede removal so that a stub which
 * is itself about to be superseded still shadows its synthetic twin — with the
 * old order the twin outlived the record it duplicated (a `supersedes` append
 * shrank the tuple group to one member, and the phantom survived the session
 * that refuted it).
 *
 * Records without a usable `session_id` are dropped, unless
 * `keepUnidentified: true` (they cannot be deduplicated; a COUNT-style or
 * effectiveness-style consumer would rather keep them than shrink its `n`).
 *
 * Output order follows FIRST appearance of each surviving id in the input; kept
 * unidentified records are appended after them, in their original order.
 *
 * @param {Array<unknown>} records
 * @param {object} [opts]
 * @param {boolean} [opts.keepUnidentified=false] pass id-less record objects
 *   through untouched instead of dropping them.
 * @returns {{records: Array<object>, ignoredSupersedes: Array<{by: string,
 *   target: string, reason: string}>}}
 */
export function canonicalizeSessionsDetailed(records, { keepUnidentified = false } = {}) {
  if (!Array.isArray(records)) return { records: [], ignoredSupersedes: [] };

  // -- (1) newest-wins per id ------------------------------------------------
  // Map insertion order = FIRST appearance of the id; the stored value is the
  // LAST record carrying it, so a superseding append wins without reordering
  // the ledger's chronology.
  const byId = new Map();
  const unidentified = [];
  for (const rec of records) {
    if (!isRecordObject(rec)) continue;
    if (!isNonEmptyString(rec.session_id)) {
      if (keepUnidentified) unidentified.push(rec);
      continue;
    }
    byId.set(rec.session_id, rec);
  }

  // -- (2) narrow abandoned-tuple collapse -----------------------------------
  collapseAbandonedTuples(byId);

  // -- (3) supersede removal (order-independent, join-key constrained) -------
  const ignoredSupersedes = [];
  resolveSupersedes(byId, ignoredSupersedes);

  return { records: [...byId.values(), ...unidentified], ignoredSupersedes };
}

/**
 * Collapse a raw sessions.jsonl record array to one record per physical
 * session. Pure — the input array is never mutated. Thin wrapper over
 * `canonicalizeSessionsDetailed`, returning only the records (the array shape
 * every consumer reads).
 *
 * @param {Array<unknown>} records
 * @param {object} [opts] — see `canonicalizeSessionsDetailed`.
 * @param {boolean} [opts.keepUnidentified=false]
 * @returns {Array<object>} canonical records
 */
export function canonicalizeSessions(records, opts) {
  return canonicalizeSessionsDetailed(records, opts).records;
}

/**
 * Count DISTINCT physical sessions in RAW `sessions.jsonl` text. Pure — no fs,
 * so an async reader keeps its own `readFile` and only the counting rule is
 * shared (the two async consumers, `memory-banner.mjs` and
 * `cold-start-detector.mjs`, carried byte-identical copies of this body).
 *
 * Blank lines (incl. the trailing newline) are skipped. A line that does not
 * PARSE is not counted at all — it cannot be attributed to any session (this
 * replaces the pre-#1167 "count every non-empty line, never parse" rule).
 *
 * `canonicalizeSessions` DROPS records without a `session_id` (they cannot be
 * deduplicated). For a COUNT that would under-report rather than de-duplicate,
 * so id-less records are counted as-is and only the id-bearing ones go through
 * the identity collapse.
 *
 * @param {string} raw — full file contents.
 * @returns {number}
 */
export function countSessionsInJsonl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return 0;
  const parsed = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  const identified = parsed.filter((r) => isRecordObject(r) && isNonEmptyString(r.session_id));
  const anonymous = parsed.length - identified.length;
  return canonicalizeSessions(identified).length + anonymous;
}

/**
 * Read `sessions.jsonl` and return its canonical records (see
 * `canonicalizeSessions` for the three collapse rules).
 *
 * Synchronous by design — every consumer of the ledger in this repo reads it
 * with `readFileSync`, and the file is small (286 records / ~0.5 MB at the
 * time of writing). A missing/unreadable file yields `[]`; each malformed line
 * is skipped rather than aborting the whole read (same posture as the readers
 * in `session-close-backfill.mjs` and `backfill-abandoned-sessions.mjs`).
 *
 * @param {object} [args]
 * @param {string} [args.repoRoot] project root; the ledger is resolved as
 *   `<repoRoot>/.orchestrator/metrics/sessions.jsonl`. Defaults to
 *   `process.cwd()` when neither this nor `filePath` is given.
 * @param {string} [args.filePath] explicit ledger path (wins over `repoRoot`).
 * @returns {Array<object>} canonical records
 */
export function readCanonicalSessions({ repoRoot, filePath } = {}) {
  const resolved = isNonEmptyString(filePath)
    ? filePath
    : path.join(isNonEmptyString(repoRoot) ? repoRoot : process.cwd(), ...SESSIONS_REL);

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch {
    return [];
  }

  const parsed = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      parsed.push(JSON.parse(trimmed));
    } catch {
      /* skip malformed line */
    }
  }
  return canonicalizeSessions(parsed);
}
