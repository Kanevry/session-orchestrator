/**
 * learnings/expiry-sweep.mjs — mechanical expiry/archive sweep for learnings.jsonl.
 *
 * Epic #723 B4. Fleet audit found expired-resident learnings accumulating in
 * 6+ repos (Vault: 70% expired) because nothing MECHANICALLY moves expired
 * entries out of the active store — `memory-cleanup-soft-limit` and the
 * `evolve` confidence-decay pass both operate on the live store but never
 * relocate anything. This module is the missing mechanical sweep: it
 * partitions `learnings.jsonl` into KEEP (still active, or too-recently
 * expired to move yet) and ARCHIVE (expired past the grace window), appends
 * the archive candidates to an append-only sidecar, then rewrites the store
 * with only the KEEP set.
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

const MS_PER_DAY = 86_400_000;
const DEFAULT_GRACE_DAYS = 14;

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

  const nowMs =
    now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.now();
  const graceMs =
    (Number.isFinite(graceDays) && graceDays >= 0 ? graceDays : DEFAULT_GRACE_DAYS) * MS_PER_DAY;

  const { entries } = await readLearnings(filePath);

  const keep = [];
  const archiveCandidates = [];

  for (const entry of entries) {
    const expiresMs = typeof entry?.expires_at === 'string' ? Date.parse(entry.expires_at) : NaN;
    const isExpired = Number.isFinite(expiresMs) && expiresMs <= nowMs;
    if (!isExpired) {
      keep.push(entry);
      continue;
    }
    // Expired — but does it clear the grace window?
    if (expiresMs + graceMs < nowMs) {
      archiveCandidates.push(entry);
    } else {
      keep.push(entry);
    }
  }

  if (dryRun) {
    return {
      scanned: entries.length,
      kept: keep.length,
      archived: archiveCandidates.length,
      dryRun: true,
      archivePath,
    };
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
  if (archiveCandidates.length > 0) {
    const nowIso = new Date(nowMs).toISOString();
    const body =
      archiveCandidates
        .map((e) => JSON.stringify({ ...e, _archived_at: nowIso, _archive_reason: 'expired' }))
        .join('\n') + '\n';
    await mkdir(path.dirname(archivePath), { recursive: true });
    await appendFile(archivePath, body, 'utf8');
  }

  // Re-validates (cheap, idempotent) and snapshots a `.bak-<ISO>` backup of
  // the current store before the atomic rename (io.mjs #721). The KEEP batch
  // already passed the dry-run probe above, so this call cannot throw here.
  await rewriteLearnings(filePath, keep, { dryRun: false });

  return {
    scanned: entries.length,
    kept: keep.length,
    archived: archiveCandidates.length,
    dryRun: false,
    archivePath,
  };
}
