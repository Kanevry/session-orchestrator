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
 * Each reader declares its need as `REQUIRED_EVENTS_WINDOW_DAYS` next to its
 * `readEventsWithRotations(` call — a finite number of days, or `null` when it
 * has no fixed window (it then cannot set a retention floor and reports its own
 * truncation through the reader's `complete:false`). This probe takes the MAX
 * of the finite declarations and compares it against the span the retained
 * archives plus the live ledger cover. No new Session Config key: it reads the
 * existing `events-rotation.max-backups` from the config the runner passes.
 *
 * ## When it fires (HR-101 — a signal may only warn if it is rare)
 *
 * Only when the archive ring is FULL (`archives >= max-backups`). Below that
 * nothing has been pruned under the current config, so the retained ledger IS
 * the whole history — a two-hour-old repo covering two hours is not "short
 * retention", and judging it so would fire on every young repo's start.
 *
 * ## Three states, never two
 *
 *   - **not measured** — no live ledger and no archive directory:
 *     `{severity:'ok', kind:'not-measured', reason:'no-events-ledger'}` (the
 *     registry's precondition records this as `skipped`, never `ran-clean`).
 *   - **unmeasurable** — the archive directory exists but cannot be listed, or
 *     a reader's declaration cannot be read: `{severity:'warn', degraded:true}`.
 *     An unreadable source must never read as "retention is fine".
 *   - **measured** — `null` (covered, ring not full, or no finite requirement)
 *     or `{severity:'warn', kind:'retention-short', message, …}`.
 *
 * Cost: one `readdirSync` per session start. The reader modules are imported
 * ONLY on the rare full-ring branch, so the common start pays no import.
 *
 * @module scripts/lib/events-retention-banner
 */

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ARCHIVE_DIR_NAME, ARCHIVE_NAME_RE } from './events-schema.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** `_parseEventsRotation`'s own default (`scripts/lib/config/events-rotation.mjs`). */
const DEFAULT_MAX_BACKUPS = 5;

/**
 * Every module that reads the rotated ledger via `readEventsWithRotations(`.
 * Census 2026-10-02 @ `86e636a9`:
 * `rg -n "readEventsWithRotations\(" scripts hooks skills` → 3 call sites
 * (engine.mjs, sync.mjs, telemetry-stats.mjs) beside the definition and prose.
 * A test re-runs that census, so a fourth reader cannot join unlisted.
 */
export const EVENTS_WINDOW_READERS = Object.freeze([
  { label: 'eval/engine', spec: './eval/engine.mjs' },
  { label: 'telemetry/sync', spec: './telemetry/sync.mjs' },
  { label: 'tmux-layout/telemetry-stats', spec: './tmux-layout/telemetry-stats.mjs' },
]);

/**
 * Epoch ms of the START of an archive's range, from its name alone. An
 * `unknown` first stamp falls back to the LAST stamp — a later instant, so the
 * covered span is understated and the probe errs toward reporting.
 *
 * @param {string} name — matches `ARCHIVE_NAME_RE`
 * @returns {number} NaN when unparseable
 */
function archiveStartMs(name) {
  const m = /^events-(\d{8}T\d{6}Z|unknown)_(\d{8}T\d{6}Z)/.exec(name);
  if (!m) return Number.NaN;
  const stamp = m[1] === 'unknown' ? m[2] : m[1];
  const p = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  return p ? Date.UTC(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +p[6]) : Number.NaN;
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
 *   degraded?: boolean, reason?: string, coverageDays?: number,
 *   requiredDays?: number, requiredBy?: string, archives?: number, maxBackups?: number}>}
 */
export async function checkEventsRetention({ repoRoot, config, now = Date.now() } = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') return null;
  const metricsDir = path.join(repoRoot, '.orchestrator', 'metrics');
  const archiveDir = path.join(metricsDir, ARCHIVE_DIR_NAME);
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
  if (names.length === 0 && !existsSync(path.join(metricsDir, 'events.jsonl'))) {
    return { severity: 'ok', kind: 'not-measured', reason: 'no-events-ledger' };
  }

  const raw = config?.['events-rotation']?.['max-backups'];
  const maxBackups = Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_MAX_BACKUPS;
  // Ring not full ⇒ nothing pruned under this config ⇒ the retained ledger is
  // the whole history. See the module header (HR-101).
  if (names.length < maxBackups) return null;

  const oldestMs = Math.min(...names.map(archiveStartMs));
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
  if (!Number.isFinite(oldestMs)) {
    return {
      severity: 'warn',
      degraded: true,
      kind: 'unmeasurable',
      message: `⚠ events-retention: no archive name in ${ARCHIVE_DIR_NAME}/ carries a parseable date — retention span not measured, which is not the same as covered.`,
    };
  }
  if (required.days === null) return null;

  const coverageDays = (nowMs - oldestMs) / DAY_MS;
  if (coverageDays >= required.days) return null;
  const cov = coverageDays.toFixed(1);
  return {
    severity: 'warn',
    kind: 'retention-short',
    message: `⚠ events-retention: the rotated events ledger covers ${cov}d (${names.length} archives at events-rotation.max-backups: ${maxBackups}), but ${required.by} reads a ${required.days}d window — older events are pruned before it reads them; raise events-rotation.max-backups or max-size-mb.`,
    coverageDays,
    requiredDays: required.days,
    requiredBy: required.by,
    archives: names.length,
    maxBackups,
  };
}
