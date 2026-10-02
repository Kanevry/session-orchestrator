/**
 * events-retention-banner.mjs — session-start probe: does the rotated events
 * ledger still hold the TIME WINDOW its readers need? (#1401 part 3, variant a)
 *
 * ## Why this exists
 *
 * `.orchestrator/metrics/events.jsonl` rotates into
 * `_archive/events-<firstTs>_<lastTs>.jsonl`, and `events-rotation.max-backups`
 * bounds the NUMBER of archives kept (`events-rotation.mjs` `pruneArchives`).
 * The readers of the rotated ledger need a TIME window instead. Count and time
 * are different units (`.claude/rules/host-resources.md` § HR-103), so nothing
 * noticed when a high write rate made "five archives" mean "less history than
 * a reader reads": the pruned records simply stopped existing.
 *
 * Each reader declares its need as `REQUIRED_EVENTS_WINDOW_DAYS` beside its call
 * to `readEventsWithRotations(`, `scanEventsBackwards(` or
 * `listEventSourcesNewestFirst(` — a finite number of days, or `null` when no
 * day count bounds its question (it then cannot set a retention floor, and its
 * declaration comment states what a cut history does to its answer). This probe
 * takes the MAX of the finite declarations and compares it against the span
 * the retained ledger covers. No new Session Config key: it reads the existing
 * `events-rotation.max-backups` from the config the runner passes.
 *
 * ## When it warns (HR-101 — a signal may only warn if it is rare)
 *
 * Only when the archive ring is FULL (`archives >= max-backups`). Below that
 * nothing has been pruned under the current config, so the retained ledger IS
 * the whole history — a two-hour-old repo covering two hours is not "short
 * retention", and judging it so would fire on every young repo's start.
 *
 * ## Rare vs. broken (HR-105, #1489 item 2)
 *
 * Measured 2026-10-02: 4 of 35 fleet ledgers hold any archive, at most 3 at
 * `max-backups: 5`, so the warning has never fired — and a warning that never
 * fires looks the same whether it is rare or dead. Every MEASURED answer
 * therefore carries the measurement, warn or not: `coverageDays` (now minus the
 * oldest readable event), `oldestEventAt`, `requiredDays`/`requiredBy`,
 * `archives`, `maxBackups`. The runner (`session-start-probes.mjs`) persists
 * only `outcome`/`reason`/`work_ms` per probe today, so these fields reach the
 * caller but not yet `orchestrator.probes.completed`.
 *
 * ## Three states, never two
 *
 *   - **not measured** — no live ledger and no `ARCHIVE_NAME_RE` archive in
 *     `_archive/` (absent, empty, or holding only foreign files):
 *     `{severity:'ok', kind:'not-measured', reason:'no-events-ledger'}`. The
 *     registry's precondition (`hasRotationArchive` in
 *     `session-start-probes.mjs`) lists `_archive/` the same way and skips
 *     exactly these inputs, so the runner records them as `skipped`, never as
 *     `ran-clean` — which is what severity ok would otherwise become.
 *   - **unmeasurable** — `_archive/` exists but cannot be listed, or a
 *     reader's declaration cannot be read: `{severity:'warn', degraded:true}`.
 *     An unreadable source must never read as "retention is fine".
 *   - **measured** — `{severity:'ok', kind:'ring-not-full'|'no-finite-window'|'covered', …}`
 *     or `{severity:'warn', kind:'retention-short', message, …}`.
 *
 * Cost: two `readdirSync` of `_archive/` per session start (the registry
 * precondition, then this probe), one ≤64 KiB head read of the active file and
 * of each legacy-ring file, and the import of every reader module to read its
 * declaration — 22-32 ms cold for all six in a fresh process (measured
 * 2026-10-02, load average ~5); two of them are session-start probes already
 * loaded in that process.
 *
 * @module scripts/lib/events-retention-banner
 */

import { closeSync, existsSync, openSync, readSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ARCHIVE_DIR_NAME, ARCHIVE_NAME_RE, LEGACY_RING_MAX } from './events-schema.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `_parseEventsRotation`'s own default (`scripts/lib/config/events-rotation.mjs`). */
const DEFAULT_MAX_BACKUPS = 5;

/**
 * How much of a ledger file's head is read for its first timestamp. NAMED
 * CEILING (BV-004): one record is ~300 B in this repo's ledger, so 64 KiB holds
 * hundreds; a file whose first 64 KiB carry no parseable `timestamp` reports
 * no stamp rather than a guessed one.
 */
const HEAD_BYTES = 64 * 1024;

/**
 * Every module that reads the rotated ledger. Census 2026-10-02 @ `84c107a1`:
 * `rg -n "readEventsWithRotations\(|scanEventsBackwards\(|listEventSourcesNewestFirst\(" --glob '!tests/**' scripts hooks skills`
 * → 6 call sites beside the definitions in `events.mjs` (and its internal
 * `listEventSourcesNewestFirst` call). A test re-runs that census, so a
 * seventh reader cannot join unlisted.
 */
export const EVENTS_WINDOW_READERS = Object.freeze([
  { label: 'eval/engine', spec: './eval/engine.mjs' },
  { label: 'telemetry/sync', spec: './telemetry/sync.mjs' },
  { label: 'tmux-layout/telemetry-stats', spec: './tmux-layout/telemetry-stats.mjs' },
  { label: 'maintenance-due-banner', spec: './maintenance-due-banner.mjs' },
  { label: 'instruction-budget-guard', spec: './instruction-budget-guard.mjs' },
  { label: 'backfill-abandoned-sessions', spec: '../backfill-abandoned-sessions.mjs' },
]);

/**
 * Epoch ms of the START of an archive's range, from its name alone. An
 * `unknown` first stamp falls back to the LAST stamp — a later instant, so the
 * covered span is understated and the probe errs toward reporting.
 *
 * Total over `ARCHIVE_NAME_RE` matches, the only names it is given: the regex
 * guarantees two digit stamps, and `Date.UTC` normalizes an out-of-range field
 * (month 13 → January of the next year) instead of returning NaN. The NaN
 * return exists only to type the regex miss; no caller can reach it.
 *
 * @param {string} name — matches `ARCHIVE_NAME_RE`
 * @returns {number} epoch ms; NaN only for a name outside `ARCHIVE_NAME_RE`
 */
function archiveStartMs(name) {
  const m = /^events-(\d{8}T\d{6}Z|unknown)_(\d{8}T\d{6}Z)/.exec(name);
  if (!m) return Number.NaN;
  const stamp = m[1] === 'unknown' ? m[2] : m[1];
  const p = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return p ? Date.UTC(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +p[6]) : Number.NaN;
}

/**
 * Epoch ms of the first parseable `timestamp` within the first
 * {@link HEAD_BYTES} of `file` — the file's oldest event, since every ledger
 * file is append-ordered. NaN when absent, unreadable, or stampless: the
 * caller then has no stamp from this file, never a guessed one.
 *
 * @param {string} file
 * @returns {number}
 */
function firstTimestampMs(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
      try {
        const ms = Date.parse(JSON.parse(line)?.timestamp);
        if (Number.isFinite(ms)) return ms;
      } catch {
        /* malformed, or the partial last line of the head — try the next */
      }
    }
  } catch {
    /* absent or unreadable — no stamp from this file */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
  return Number.NaN;
}

/**
 * The largest finite window any reader declares, with the reader naming it.
 *
 * @param {ReadonlyArray<{label: string, spec: string}>} readers
 * @returns {Promise<{days: number|null, by: string|null}>}
 * @throws when a reader cannot be imported or declares a non-window value
 */
async function maxRequiredWindow(readers) {
  const values = await Promise.all(
    readers.map(async (r) => {
      const mod = await import(new URL(r.spec, import.meta.url).href);
      const v = mod.REQUIRED_EVENTS_WINDOW_DAYS;
      if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        throw new Error(`${r.label} declares no REQUIRED_EVENTS_WINDOW_DAYS`);
      }
      return { days: v, by: r.label };
    }),
  );
  let best = { days: null, by: null };
  for (const v of values) {
    if (v.days !== null && (best.days === null || v.days > best.days)) best = v;
  }
  return best;
}

/**
 * Compare the retained events ledger's time span against the window its
 * readers need. Never throws; never blocks.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {object} [opts.config] — parsed Session Config (`events-rotation.max-backups`)
 * @param {number} [opts.now=Date.now()] — injectable clock, epoch ms
 * @returns {Promise<null|{severity: 'ok'|'warn', kind: string, message?: string,
 *   degraded?: boolean, reason?: string, coverageDays?: number|null,
 *   oldestEventAt?: string|null, requiredDays?: number|null, requiredBy?: string|null,
 *   archives?: number, maxBackups?: number}>} `null` only without a `repoRoot`.
 */
export async function checkEventsRetention({ repoRoot, config, now = Date.now() } = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') return null;
  const metricsDir = path.join(repoRoot, '.orchestrator', 'metrics');
  const archiveDir = path.join(metricsDir, ARCHIVE_DIR_NAME);
  const activePath = path.join(metricsDir, 'events.jsonl');
  const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  let names;
  try {
    names = readdirSync(archiveDir).filter((n) => ARCHIVE_NAME_RE.test(n));
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      return {
        severity: 'warn',
        degraded: true,
        kind: 'unmeasurable',
        message: `⚠ events-retention: could not list ${ARCHIVE_DIR_NAME}/ (${err?.code ?? 'error'}) — retention span not measured, which is not the same as covered.`,
      };
    }
    names = [];
  }
  // Mirrored by the registry precondition, which skips these inputs before the
  // runner could record this severity-ok answer as `ran-clean`.
  if (names.length === 0 && !existsSync(activePath)) {
    return { severity: 'ok', kind: 'not-measured', reason: 'no-events-ledger' };
  }

  let required;
  try {
    required = await maxRequiredWindow(EVENTS_WINDOW_READERS);
  } catch (err) {
    return {
      severity: 'warn',
      degraded: true,
      kind: 'unmeasurable',
      message: `⚠ events-retention: required window not readable (${String(err?.message ?? err).slice(0, 120)}) — retention span not judged, which is not the same as covered.`,
    };
  }

  // Oldest readable event across every source the readers read: archives by
  // name, the legacy ring and the active file by their first stamp.
  const starts = [
    ...names.map(archiveStartMs),
    ...Array.from({ length: LEGACY_RING_MAX }, (_, i) => `${activePath}.${i + 1}`)
      .filter((p) => existsSync(p))
      .map(firstTimestampMs),
    firstTimestampMs(activePath),
  ].filter(Number.isFinite);
  const oldestMs = starts.length > 0 ? Math.min(...starts) : Number.NaN;

  const raw = config?.['events-rotation']?.['max-backups'];
  const maxBackups = Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_BACKUPS;
  const measured = {
    coverageDays: Number.isFinite(oldestMs) ? (nowMs - oldestMs) / DAY_MS : null,
    oldestEventAt: Number.isFinite(oldestMs) ? new Date(oldestMs).toISOString() : null,
    requiredDays: required.days,
    requiredBy: required.by,
    archives: names.length,
    maxBackups,
  };

  // Ring not full ⇒ nothing pruned under this config ⇒ the retained ledger is
  // the whole history. See the module header (HR-101).
  if (names.length < maxBackups) return { severity: 'ok', kind: 'ring-not-full', ...measured };
  if (required.days === null) return { severity: 'ok', kind: 'no-finite-window', ...measured };
  // Finite here: the ring is full, so `names` is non-empty and
  // `archiveStartMs` is total over `ARCHIVE_NAME_RE` matches.
  if (measured.coverageDays >= required.days) return { severity: 'ok', kind: 'covered', ...measured };
  const cov = measured.coverageDays.toFixed(1);
  return {
    severity: 'warn',
    kind: 'retention-short',
    // Names what the rule judged (HR-106): the measured span against the
    // reader's DECLARED window — not a claim about how the reader reads.
    message: `⚠ events-retention: the rotated events ledger covers ${cov}d (${names.length} archives at events-rotation.max-backups: ${maxBackups}), less than the ${required.days}d window ${required.by} declares as REQUIRED_EVENTS_WINDOW_DAYS — events older than ${cov}d are not retained; raise events-rotation.max-backups or max-size-mb.`,
    ...measured,
  };
}
