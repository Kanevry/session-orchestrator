/**
 * learnings/expiry-sweep.mjs — mechanical archive-safe writers for learnings.jsonl.
 *
 * Epic #723 B4 (`sweepExpiredLearnings`) + issue #1017 (`pruneLearnings`).
 *
 * Fleet audit found expired-resident learnings accumulating in 6+ repos
 * (Vault: 70% expired) because nothing MECHANICALLY moves expired entries out
 * of the active store — `memory-cleanup-soft-limit` and the `evolve`
 * confidence-decay pass both operate on the live store but never relocate
 * anything. This module is the missing mechanical sweep: it partitions
 * `learnings.jsonl` into KEEP (still active, or too-recently expired to move
 * yet) and ARCHIVE (expired past the grace window), appends the archive
 * candidates to an append-only sidecar, then rewrites the store with only the
 * KEEP set.
 *
 * #1017 — the SAME pipeline, one predicate apart. `/evolve`'s prune step
 * ("remove entries where `expires_at` < now OR `confidence` <= 0", then
 * consolidate duplicates, then rewrite the store) was specified as coordinator
 * PROSE doing a read-modify-`>`-rewrite by hand, with no archive append at
 * all. Measured consequence on the live corpus: 11 of 13 `learning-id`
 * provenance pointers in rendered `.claude/rules/*.md` resolved to NOTHING —
 * the ids were in neither the store, the archive, nor any `.bak-*` snapshot
 * (85% dead pointers). {@link pruneLearnings} is that path routed through this
 * file's pipeline instead: the two callers differ ONLY in how they partition
 * (time-driven vs decision-driven); the crash-safe ordering, the KEEP-batch
 * probe, and the `.bak` snapshot are one shared code path, never two.
 *
 * Design constraints (deliberate, do not "simplify" away):
 *   - NEVER deletes data. Archive is append-only; the store rewrite is the
 *     ONLY destructive step, and it reuses `rewriteLearnings()` from io.mjs
 *     (#721), which itself snapshots a `.bak-<ISO>` backup before the atomic
 *     rename — the same safety net that protects every other bulk rewrite.
 *   - Grace period (default 14 days): an entry that JUST expired stays in the
 *     active store for `graceDays` more days. This absorbs two things: (a)
 *     TTL edge-noise near the boundary, and (b) a window for /evolve's
 *     confidence-reinforcement pass to re-stamp `expires_at` before the entry
 *     is moved out from under it. Without the grace window, a recurring
 *     learning could ping-pong between store and archive on every sweep.
 *   - Crash-safe ordering: the archive APPEND happens before the store
 *     REWRITE. A crash between the two steps leaves the entry in BOTH places
 *     (harmless — the archive is append-only and never de-duplicated on
 *     read) rather than in NEITHER (data loss, if the rewrite completed but
 *     the archive append had not yet happened).
 *   - KEEP-batch validated BEFORE the archive append: a `rewriteLearnings(...,
 *     { dryRun: true })` probe validates the KEEP set (throws on an
 *     invalid-but-parseable record) with zero disk writes. Without this
 *     probe, an invalid KEEP record would survive `readLearnings()` only to
 *     blow up the REAL rewrite AFTER the archive append had already landed —
 *     on a repeated `--apply` run that duplicates the archive append every
 *     time while the store is never actually pruned.
 *   - Read/normalize is delegated to `readLearnings()`; the destructive
 *     rewrite is delegated to `rewriteLearnings()`. This file does not
 *     implement its own JSONL writer for the store — see io.mjs #721
 *     (the incident that destroyed 107 live learnings via a bespoke writer
 *     with no backup/dry-run safety net).
 *
 * Sibling-module import convention (learnings.mjs barrel doc): import
 * directly from `./io.mjs`, never from `../learnings.mjs`, to preserve the
 * acyclic dependency graph.
 */

import { existsSync } from 'node:fs';
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { readLearnings, rewriteLearnings } from './io.mjs';

/**
 * Composite-key separator for the in-memory consolidation Map.
 *
 * Built via `String.fromCharCode(0)` rather than a literal NUL byte in this file.
 * A single NUL makes a tracked text file classify as BINARY, and grep/ugrep then
 * skip it SILENTLY — exit 1, no output, no warning. That removed an entire deny
 * path from a security census once (see the recorded anti-pattern rule on NUL
 * bytes and grep-based audits). The separator byte is unchanged at runtime.
 */
const KEY_SEP = String.fromCharCode(0);

const MS_PER_DAY = 86_400_000;
const DEFAULT_GRACE_DAYS = 14;

/**
 * Canonical, key-order-independent JSON for a record — the identity of LAST
 * RESORT, used only when a record carries no usable `id`.
 *
 * `JSON.stringify` is not sufficient here: two reads of the same record can
 * differ in key ORDER (the store and the `--entries` sidecar are separate
 * files, written by separate passes), and an order-sensitive fingerprint would
 * read those as two different records.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',')}}`;
  }
  // `undefined` has no JSON form — normalize it to the same token as null so a
  // present-but-undefined key cannot make a record unfingerprintable.
  return JSON.stringify(value) ?? 'null';
}

/**
 * Reconciliation identity for {@link pruneLearnings} step (3): the `id` when
 * the record carries a usable one, else a content fingerprint.
 *
 * The fallback is load-bearing, not a nicety. `id` IS a required schema field,
 * but `validateLearning` only checks key PRESENCE — `id: ''`, `id: null` and
 * `id: undefined` all pass it, and `readLearnings()` never rejects anything —
 * so an id-less record can and does reach disk. Such a record can never appear
 * in `keep` (which is built from `next` alone), so leaving it unreconciled
 * meant the store rewrite dropped it with no archive line: gone from BOTH
 * places, which is the exact #1017 data loss this module exists to prevent.
 *
 * @param {object} entry
 * @returns {string}
 */
function reconcileKey(entry) {
  const id = entry?.id;
  return typeof id === 'string' && id.length > 0
    ? `id${KEY_SEP}${id}`
    : `sig${KEY_SEP}${stableStringify(entry)}`;
}

/**
 * Closed vocabulary for `_archive_reason` (#1017). Every record that leaves
 * the active store carries exactly one of these, so the archive answers WHY a
 * `learning-id` stopped resolving — not merely THAT it did.
 *
 *   expired    — `expires_at` elapsed (past the grace window, for the sweep).
 *   pruned     — dropped by a decision: confidence decayed to <= 0, or the
 *                caller removed it from the next store generation.
 *   superseded — a duplicate `(type, subject)` lost to a higher-confidence
 *                twin. Carries `_superseded_by: <winning id>`.
 *   merged     — folded into another record. Carries `_merged_into: <id>`.
 *
 * `superseded` / `merged` REQUIRE their tombstone pointer — an archive record
 * that says "this was replaced" without naming the replacement recreates the
 * dangling-pointer defect one level down. {@link normalizeArchiveVerdict}
 * fails closed on a missing pointer, before anything touches disk.
 */
export const ARCHIVE_REASONS = Object.freeze(['expired', 'pruned', 'superseded', 'merged']);

/** Reason -> the tombstone field that reason MUST carry. */
const TOMBSTONE_FIELD = Object.freeze({
  superseded: '_superseded_by',
  merged: '_merged_into',
});

/** Reason -> the camelCase caller-facing alias for its tombstone pointer. */
const TOMBSTONE_ALIAS = Object.freeze({
  superseded: 'supersededBy',
  merged: 'mergedInto',
});

/**
 * Normalize an archive verdict into `{reason, tombstone}` and fail closed on
 * an unknown reason or a missing tombstone pointer.
 *
 * Accepts a bare reason string (`'pruned'`) or an object
 * (`{reason: 'superseded', supersededBy: '<id>'}`; the underscore form
 * `_superseded_by` is accepted too, so a caller may pass the on-disk shape).
 *
 * Callers MUST normalize while building the archive batch — i.e. BEFORE the
 * first disk write — so a bad verdict aborts with the store and the archive
 * both untouched.
 *
 * @param {string|{reason: string, supersededBy?: string, mergedInto?: string}} raw
 * @returns {{reason: string, tombstone: object|null}}
 */
function normalizeArchiveVerdict(raw) {
  const v = typeof raw === 'string' ? { reason: raw } : (raw ?? {});
  const { reason } = v;
  if (!ARCHIVE_REASONS.includes(reason)) {
    throw new Error(
      `archive reason must be one of ${ARCHIVE_REASONS.join('|')}, got: ${JSON.stringify(reason)}`
    );
  }
  const field = TOMBSTONE_FIELD[reason];
  if (!field) return { reason, tombstone: null };
  const target = v[TOMBSTONE_ALIAS[reason]] ?? v[field];
  if (typeof target !== 'string' || target.length === 0) {
    throw new Error(`archive reason "${reason}" requires a non-empty ${field} pointer`);
  }
  return { reason, tombstone: { [field]: target } };
}

/** Stamp an archive record with its provenance tail. */
function tagArchiveRecord(entry, { reason, tombstone }, nowIso) {
  return { ...entry, _archived_at: nowIso, _archive_reason: reason, ...(tombstone ?? {}) };
}

/** `{expired: 2, superseded: 1}` roll-up over a normalized archive batch. */
function countByReason(batch) {
  const out = {};
  for (const { verdict } of batch) {
    out[verdict.reason] = (out[verdict.reason] ?? 0) + 1;
  }
  return out;
}

/** Resolve the `now` parameter (Date | epoch ms | undefined) to epoch ms. */
function resolveNowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  return Date.now();
}

/**
 * THE shared write pipeline — the only place in this module that touches disk.
 * Both public entry points funnel through it, so the crash-safe ordering, the
 * KEEP-batch probe, and the `.bak` snapshot cannot drift apart between the
 * time-driven and the decision-driven caller (#1017).
 *
 * Order is load-bearing (see the module header): probe the KEEP batch with
 * zero disk writes, THEN append the archive, THEN rewrite the store.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {string} opts.archivePath
 * @param {object[]} opts.keep — the next store generation
 * @param {{entry: object, verdict: {reason: string, tombstone: object|null}}[]} opts.archiveBatch
 * @param {number} opts.nowMs
 * @param {boolean} opts.dryRun
 * @returns {Promise<{kept: number, archived: number, byReason: Record<string, number>}>}
 */
async function archiveThenRewrite({ filePath, archivePath, keep, archiveBatch, nowMs, dryRun }) {
  const byReason = countByReason(archiveBatch);
  if (dryRun) {
    return { kept: keep.length, archived: archiveBatch.length, byReason };
  }

  // Validate the KEEP batch BEFORE the archive append (dry-run rewrite: throws
  // on a bad record, writes nothing). Without this, an invalid-but-parseable
  // KEEP record survives readLearnings() but blows up rewriteLearnings() later
  // — AFTER the archive append already landed. On a repeated --apply run that
  // duplicates the archive append every time (never de-duplicated on read)
  // while the store is never actually pruned. Validating first means a bad
  // record throws here, before anything on disk has been touched.
  await rewriteLearnings(filePath, keep, { dryRun: true });

  // Crash-safe ordering: archive append FIRST. A duplicate re-append after a
  // crash is harmless (append-only, never de-duplicated on read); the reverse
  // order risks losing an archive-worthy entry if the process dies after the
  // store rewrite but before the archive write.
  if (archiveBatch.length > 0) {
    const nowIso = new Date(nowMs).toISOString();
    const body =
      archiveBatch
        .map(({ entry, verdict }) => JSON.stringify(tagArchiveRecord(entry, verdict, nowIso)))
        .join('\n') + '\n';
    await mkdir(path.dirname(archivePath), { recursive: true });
    await appendFile(archivePath, body, 'utf8');
  }

  // Re-validates (cheap, idempotent) and snapshots a `.bak-<ISO>` backup of
  // the current store before the atomic rename (io.mjs #721). The KEEP batch
  // already passed the dry-run probe above, so this call cannot throw here.
  await rewriteLearnings(filePath, keep, { dryRun: false });

  return { kept: keep.length, archived: archiveBatch.length, byReason };
}

/**
 * Sweep expired learnings out of `filePath` into `archivePath`.
 *
 * Partition rule (relative to `now`):
 *   - KEEP:    `expires_at` unparseable/absent, OR not yet expired, OR expired
 *              but within `graceDays` of expiry (grace window).
 *   - ARCHIVE: `expires_at` parseable AND expired AND
 *              `expiresMs + graceDays*86400000 < now` (grace window elapsed).
 *
 * @param {object} opts
 * @param {string} opts.filePath - absolute/relative path to the active learnings.jsonl
 * @param {string} opts.archivePath - absolute/relative path to the append-only archive sidecar
 * @param {Date|number} [opts.now] - injectable clock; defaults to `Date.now()`
 * @param {boolean} [opts.dryRun=true] - when true, computes counts but writes nothing
 * @param {number} [opts.graceDays=14] - days past expiry before an entry is archived
 * @returns {Promise<{scanned: number, kept: number, archived: number, dryRun: boolean, archivePath: string}>}
 *   Never throws on a missing store — returns the zeroed shape instead. Both
 *   `filePath` and `archivePath` are required; a missing/invalid `filePath`
 *   throws a plain `Error` (programmer error, not a runtime data condition).
 */
export async function sweepExpiredLearnings({
  filePath,
  archivePath,
  now,
  dryRun = true,
  graceDays = DEFAULT_GRACE_DAYS,
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('sweepExpiredLearnings: filePath is required');
  }
  if (typeof archivePath !== 'string' || archivePath.length === 0) {
    throw new Error('sweepExpiredLearnings: archivePath is required');
  }

  if (!existsSync(filePath)) {
    return { scanned: 0, kept: 0, archived: 0, dryRun, archivePath };
  }

  const nowMs = resolveNowMs(now);
  const graceMs =
    (Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : DEFAULT_GRACE_DAYS) * MS_PER_DAY;

  const { entries } = await readLearnings(filePath);

  const keep = [];
  const archiveBatch = [];
  const expiredVerdict = normalizeArchiveVerdict('expired');

  for (const entry of entries) {
    const expiresMs = typeof entry?.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN;
    const isExpired = Number.isFinite(expiresMs) && expiresMs <= nowMs;
    if (!isExpired) {
      keep.push(entry);
      continue;
    }
    // Expired — but does it clear the grace window?
    if (expiresMs + graceMs < nowMs) {
      archiveBatch.push({ entry, verdict: expiredVerdict });
    } else {
      keep.push(entry);
    }
  }

  const { kept, archived } = await archiveThenRewrite({
    filePath,
    archivePath,
    keep,
    archiveBatch,
    nowMs,
    dryRun,
  });

  // Result shape is pinned by the CLI (`scripts/sweep-expired-learnings.mjs`)
  // and its JSON contract — deliberately WITHOUT `byReason`, which only the
  // multi-reason prune path below can populate meaningfully.
  return { scanned: entries.length, kept, archived, dryRun, archivePath };
}

/**
 * Decision-driven sibling of {@link sweepExpiredLearnings} — the archive-safe
 * replacement for `/evolve`'s prune + consolidate + rewrite steps (#1017).
 *
 * Same pipeline, different predicate. Every record that leaves the store is
 * appended to the archive with a reason from {@link ARCHIVE_REASONS} first;
 * the store rewrite goes through `rewriteLearnings()` (validation + `.bak`
 * snapshot + atomic rename), never a `>` redirect.
 *
 * Three ways a record leaves the store, each routed to its own reason:
 *   1. **prune predicate** — `expires_at` elapsed (`expired`) or
 *      `confidence <= 0` (`pruned`). This is `/evolve` SKILL.md Step 3.5(6) /
 *      Step 4.4(3) verbatim, minus the deletion.
 *   2. **consolidation** — duplicate `(type, subject)` with a NON-EMPTY
 *      subject: the highest-confidence record wins, the losers are archived
 *      `superseded` with `_superseded_by: <winner id>`. Null/empty-subject
 *      records are NEVER collapsed (issue #284) — each is keyed by its `id`.
 *   3. **caller drop** — a record present on disk but absent from `entries`
 *      (the caller's next store generation). This is the mechanical guarantee
 *      that makes the prose-driven caller safe by construction: whatever an
 *      LLM-authored next generation omits is tombstoned automatically rather
 *      than silently deleted. Reconciliation is by `id`, falling back to a
 *      content fingerprint for a record with no usable one, and it COUNTS
 *      rather than tests membership — see {@link reconcileKey}. Deliberate
 *      ceiling: an id-less record the caller MUTATED (rather than dropped)
 *      fingerprints as a drop, so it is tombstoned while the mutated copy
 *      stays in the store — a duplicate archive line, never a loss. Revisit if
 *      a caller ever needs to mutate id-less records in bulk; the fix is to
 *      stamp an `id` at the read funnel, not to loosen this loop.
 *
 * **No `graceDays` here, by design.** The grace window exists for two reasons
 * (see the module header): TTL edge-noise, and "a window for /evolve's
 * confidence-reinforcement pass to re-stamp `expires_at` before the entry is
 * moved out from under it". On THIS path reason 2 is structurally already
 * satisfied: `/evolve` applies its reinforcement (+0.15 and a fresh
 * `expires_at`) in the SAME run, strictly before the prune step — so an entry
 * still expired at prune time is one the analyzer just declined to reinforce,
 * not one that is about to be. Carrying a grace window here would instead
 * CHANGE `/evolve`'s documented prune semantics (entries the operator expects
 * gone would linger). The ping-pong hazard the grace window guards against on
 * the sweep is also cheap here: this path archives rather than deletes, so a
 * later re-derivation costs a duplicate archive line, not data.
 *
 * @param {object} opts
 * @param {string} opts.filePath - active learnings.jsonl
 * @param {string} opts.archivePath - append-only archive sidecar
 * @param {object[]} [opts.entries] - the caller's next store generation (post
 *   confidence-update / append). Defaults to the on-disk set, i.e. a pure
 *   prune+consolidate pass.
 * @param {Date|number} [opts.now] - injectable clock
 * @param {boolean} [opts.dryRun=true]
 * @param {string|Function} [opts.dropReason='pruned'] - verdict for case 3
 *   above: a reason string, or `(entry) => reason|{reason, supersededBy, mergedInto}`
 *   for per-record routing (this is the seam a later `merged` producer uses).
 * @returns {Promise<{scanned: number, kept: number, archived: number,
 *   byReason: Record<string, number>, dryRun: boolean, archivePath: string}>}
 */
export async function pruneLearnings({
  filePath,
  archivePath,
  entries,
  now,
  dryRun = true,
  dropReason = 'pruned',
} = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('pruneLearnings: filePath is required');
  }
  if (typeof archivePath !== 'string' || archivePath.length === 0) {
    throw new Error('pruneLearnings: archivePath is required');
  }
  if (entries !== undefined && !Array.isArray(entries)) {
    throw new Error('pruneLearnings: entries must be an array when provided');
  }

  const nowMs = resolveNowMs(now);
  const { entries: current } = await readLearnings(filePath);
  const next = entries ?? current;

  if (next.length === 0 && current.length === 0) {
    return { scanned: 0, kept: 0, archived: 0, byReason: {}, dryRun, archivePath };
  }

  const resolveDrop = (entry) =>
    normalizeArchiveVerdict(typeof dropReason === 'function' ? dropReason(entry) : dropReason);

  const archiveBatch = [];
  const survivors = [];

  // (1) prune predicate — SKILL.md Step 3.5(6) / 4.4(3), routed by cause.
  for (const entry of next) {
    const expiresMs = typeof entry?.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN;
    if (Number.isFinite(expiresMs) && expiresMs < nowMs) {
      archiveBatch.push({ entry, verdict: normalizeArchiveVerdict('expired') });
      continue;
    }
    if (typeof entry?.confidence === 'number' && entry.confidence <= 0) {
      archiveBatch.push({ entry, verdict: normalizeArchiveVerdict('pruned') });
      continue;
    }
    survivors.push(entry);
  }

  // (2) consolidation — highest confidence wins per (type, non-empty subject).
  const winners = new Map();
  for (const entry of survivors) {
    const subject = typeof entry?.subject === 'string' ? entry.subject.trim() : '';
    if (subject.length === 0) continue; // #284: never collapse null/empty subjects
    const key = `${entry?.type}${KEY_SEP}${subject}`;
    const incumbent = winners.get(key);
    const score = typeof entry?.confidence === 'number' ? entry.confidence : -Infinity;
    const incumbentScore =
      incumbent && typeof incumbent.confidence === 'number' ? incumbent.confidence : -Infinity;
    if (!incumbent || score > incumbentScore) winners.set(key, entry);
  }
  const keep = [];
  for (const entry of survivors) {
    const subject = typeof entry?.subject === 'string' ? entry.subject.trim() : '';
    if (subject.length === 0) {
      keep.push(entry);
      continue;
    }
    const winner = winners.get(`${entry?.type}${KEY_SEP}${subject}`);
    if (winner === entry) {
      keep.push(entry);
      continue;
    }
    archiveBatch.push({
      entry,
      verdict: normalizeArchiveVerdict({ reason: 'superseded', supersededBy: String(winner?.id) }),
    });
  }

  // (3) caller drops — on disk but absent from the next generation.
  //
  // Identity is {@link reconcileKey}: the `id` when the record has a usable
  // one, else a content fingerprint. NOTHING is skipped here — a record this
  // loop passes over is a record the store rewrite deletes without a tombstone,
  // because `keep` is built from `next` alone (loops 1-2) and an on-disk record
  // absent from `next` has no other way in. This loop IS the rescue; an early
  // `continue` in it is a silent delete, not a no-op.
  //
  // COUNTS, not membership: `next` may legitimately carry fewer copies of a key
  // than the store does (identical id-less records; a duplicate `id` on disk
  // reconciled against one entry in `next`). Set-membership would skip every
  // copy while `keep` holds only one — dropping the surplus with no archive
  // line, the same hole one level down. A multiset archives exactly the surplus.
  const nextKeyCounts = new Map();
  for (const entry of next) {
    const key = reconcileKey(entry);
    nextKeyCounts.set(key, (nextKeyCounts.get(key) ?? 0) + 1);
  }
  let dropped = 0;
  for (const entry of current) {
    const key = reconcileKey(entry);
    const remaining = nextKeyCounts.get(key) ?? 0;
    if (remaining > 0) {
      nextKeyCounts.set(key, remaining - 1);
      continue;
    }
    archiveBatch.push({ entry, verdict: resolveDrop(entry) });
    dropped += 1;
  }

  const { kept, archived, byReason } = await archiveThenRewrite({
    filePath,
    archivePath,
    keep,
    archiveBatch,
    nowMs,
    dryRun,
  });

  return { scanned: next.length + dropped, kept, archived, byReason, dryRun, archivePath };
}
