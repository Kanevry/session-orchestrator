/**
 * telemetry-flush-health-banner.mjs — #1255
 *
 * Surfaces the ONE telemetry-flush outcome nobody could see: a flush the
 * sandbox guard refused.
 *
 * ## Why this module exists
 *
 * `scripts/lib/telemetry/sync.mjs` fails CLOSED since 4.0.0 — when its
 * environment probe cannot complete its checks it returns
 * `{ sandbox: true, reason: 'sandbox:probe-failed' }` and sends nothing. That
 * is the right default, and `sync.mjs` stays deliberately SILENT about it (it
 * runs inside the SessionEnd teardown budget, where a banner has no reader).
 *
 * The refusal therefore reaches exactly one sink: `hooks/on-session-end.mjs`
 * emits `orchestrator.telemetry.flush` with `{ outcome, reason }` into
 * `.orchestrator/metrics/events.jsonl`. Measured 2026-09-07 (W1-D6 census):
 * NO consumer read that reason back out — a repo could refuse every flush for
 * weeks and the only visible difference from a healthy repo was an absence.
 * That is `.claude/rules/host-resources.md` § HR-105 ("a rule you cannot
 * falsify is not a rule") applied to the flush path.
 *
 * This probe closes the loop on the NEXT session start, which is the first
 * moment a human is actually looking: it reads the LAST flush record and warns
 * when that record is a sandbox refusal. Newest-wins by construction — a later
 * successful flush silently clears the warning, so the banner reports the
 * CURRENT state of the channel, never its history.
 *
 * Never throws. Never mutates input. No network.
 *
 * @module scripts/lib/telemetry-flush-health-banner
 */

import { existsSync, openSync, readSync, fstatSync, closeSync } from 'node:fs';
import path from 'node:path';

/**
 * Bytes of `events.jsonl` read from the END of the file.
 *
 * The ledger is append-only and grows without bound (33k+ records in this repo
 * alone), so a full `readFileSync` on a SessionStart hook's critical path is
 * the wrong shape — this probe shares a 2s budget with ~18 siblings.
 *
 * NAMED CEILING (BV-004): a flush record older than the last 64 KB of the
 * ledger is invisible to this probe and reads as "no flush recorded" → `null`
 * (silent). At the observed record width (~120-400 bytes) that window holds
 * roughly 150-500 events, and a flush is emitted once per session close — so
 * the window covers the last flush unless ~150+ events landed after it without
 * one, which cannot happen inside a single session's teardown.
 * REVISIT TRIGGER: if the per-session event volume ever exceeds ~150 records
 * between two session ends, raise this or index the ledger — do not silently
 * accept the truncation.
 */
export const TAIL_BYTES = 64 * 1024;

/** The event name `hooks/on-session-end.mjs` emits for every flush attempt. */
const FLUSH_EVENT = 'orchestrator.telemetry.flush';

/**
 * Bound an untrusted ledger `reason` before it is interpolated into a terminal
 * banner: strip C0/DEL control bytes (a record could carry an ANSI escape) and
 * cap the length. Mirrors the sibling bound in
 * `scripts/lib/session-start-probes.mjs` (`.slice(0, 200)` on a probe error).
 *
 * @param {unknown} reason
 * @returns {string}
 */
function sanitizeReason(reason) {
  // eslint-disable-next-line no-control-regex -- stripping control bytes IS the job
  return String(reason).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120);
}

/**
 * Read the last `TAIL_BYTES` of a file as UTF-8.
 *
 * Returns a DISCRIMINATED result rather than `string|null`, because "the
 * ledger could not be read" and "the ledger holds nothing alarming" are the
 * two states this probe exists to keep apart (HR-105): collapsing an EACCES
 * onto `null` renders an unreadable channel as a healthy one.
 *
 * @param {string} file
 * @returns {{text: string} | {missing: true} | {error: string}}
 */
function readTail(file) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const start = size - length;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString('utf8') };
  } catch (err) {
    if (err?.code === 'ENOENT') return { missing: true };
    return { error: typeof err?.code === 'string' ? err.code : 'EUNKNOWN' };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Classify the telemetry-flush channel from the LAST recorded flush event.
 *
 * Scans the ledger tail BACKWARDS and stops at the first
 * `orchestrator.telemetry.flush` record it can parse — newest wins, so an
 * older refusal followed by a successful flush produces no banner.
 *
 * Returns `null` (silent) when: `repoRoot` is not a string, the ledger is
 * ABSENT, no flush record sits in the tail window, or the newest flush
 * record's `reason` does not start with `sandbox:`. A malformed line is
 * SKIPPED (it is not a flush record we can read), never a throw — the ledger's
 * last line is routinely a partial write when another process is appending.
 *
 * An UNREADABLE ledger (EACCES/EIO/…, i.e. anything other than "not there") is
 * NOT silent: it returns a `ledger-unreadable` warning. "The guard state
 * cannot be confirmed" must not display like "the last flush was fine" — that
 * collapse is the exact HR-105 defect this module's header cites as its reason
 * to exist, one layer down.
 *
 * This probe reports the LAST outcome regardless of its age (no clock seam):
 * a refusal does not expire on its own — only a later successful flush clears
 * it.
 *
 * @param {{repoRoot: string}} opts
 * @returns {null | {severity: 'warn', reason: string, message: string}}
 */
export function checkTelemetryFlushHealth({ repoRoot } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const file = path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
    if (!existsSync(file)) return null;

    const tail = readTail(file);
    if (tail.missing) return null;
    if (tail.error) {
      return {
        severity: 'warn',
        reason: 'ledger-unreadable',
        message:
          '⚠ Telemetry: flush-health unknown — .orchestrator/metrics/events.jsonl ' +
          `could not be read (${sanitizeReason(tail.error)}); ` +
          'the sandbox guard state cannot be confirmed.',
      };
    }
    if (!tail.text) return null;

    const lines = tail.text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        // Malformed (or a tail-truncated first line) — not readable as a flush
        // record, so it cannot be the newest one. Keep scanning backwards.
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      if (record.event !== FLUSH_EVENT) continue;

      // First flush record found scanning backwards = the newest one.
      const rawReason = record.reason;
      if (typeof rawReason !== 'string' || !rawReason.startsWith('sandbox:')) return null;

      // The ledger is an untrusted string source for banner purposes: bound the
      // reason on BOTH surfaces (the field a consumer may render itself, and
      // the message we render) rather than only on the one we happen to own.
      const reason = sanitizeReason(rawReason);

      return {
        severity: 'warn',
        reason,
        message:
          `⚠ Telemetry: last flush refused by the sandbox guard (${reason}) — ` +
          'the guard could not complete its checks and failed closed; no ping was sent. ' +
          'See docs/telemetry.md § Sandbox guard.',
      };
    }

    return null;
  } catch {
    // Defensive catch-all — a banner probe must never throw (fail-open).
    return null;
  }
}

/**
 * Convenience renderer: the banner message string, or `''` when silent.
 *
 * @param {{repoRoot: string}} opts
 * @returns {string}
 */
export function renderBanner({ repoRoot } = {}) {
  const result = checkTelemetryFlushHealth({ repoRoot });
  return result ? result.message : '';
}
