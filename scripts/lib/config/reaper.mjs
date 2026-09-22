import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';

/**
 * reaper.mjs — Parser for the top-level `reaper:` YAML block
 * (PRD `docs/prd/2026-09-20-prozessgruppen-kill-und-waisen-waechter.md` §4,
 * Epic #1425 / issue #1432 B4).
 *
 * Configures the orphan watchdog that `hooks/post-tool-batch-wave-signal.mjs`
 * (PostToolBatch) and `hooks/on-stop.mjs` (Stop + SubagentStop) trigger as a
 * detached fire-and-forget scan. The scan itself lives in
 * `scripts/lib/orphan-reaper.mjs`; this module only reads the numbers.
 *
 * DEFAULT OFF. `enabled` defaults to `false` — unlike `loop-guard`, this signal
 * can SEND SIGNALS to processes, so it ships inert and is armed per repo only
 * after its firing rate has been measured (`.claude/rules/host-resources.md`
 * HR-101: a class above ~10 % is a broken instrument; HR-105: a rule nothing
 * records is unfalsifiable).
 *
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Returns `{ enabled, mode, 'min-age-seconds', 'min-scan-interval-seconds',
 * 'kill-grace-ms', 'verify-wait-ms', 'max-hook-latency-ms', 'false-alarm-window' }`.
 */

/**
 * Startwerte für Stufe 1 — NOT calibrated. Every number carries its provenance
 * from the PRD §4 parameter table ("keine Zahl ohne ihre Population").
 *
 * RUNTIME SSOT is `REAPER_DEFAULTS` in `scripts/lib/orphan-reaper.mjs`; these
 * literals mirror it deliberately rather than importing it, because that module
 * pulls `process-group.mjs` + `resource-probe/parsers.mjs` into the config
 * import graph, which every `parseSessionConfig()` caller would then pay for.
 * The parity is held by a test, not by an import
 * (`tests/lib/config/reaper.test.mjs` § defaults mirror REAPER_DEFAULTS).
 */
/** 300 s — DevWatchdog's hard limit for `tsgo`; the 2026-09-20 orphans were 7–17 min old. */
const DEFAULT_MIN_AGE_SECONDS = 300;
/** 30 s — DevWatchdog's normal scan cadence; keeps a PostToolBatch storm from taxing every tool call. */
const DEFAULT_MIN_SCAN_INTERVAL_SECONDS = 30;
/** 10 000 ms — `DEFAULT_KILL_GRACE_MS` from `dispatch-common.mjs:61`; repo convention, not newly invented. */
const DEFAULT_KILL_GRACE_MS = 10_000;
/** 500 ms — wait before reading the effect back; without it the 2026-09-20 check falsely reported "still alive". */
const DEFAULT_VERIFY_WAIT_MS = 500;
/** 50 ms — ceiling a scan may delay a hook by; above that the scan counts as too expensive. */
const DEFAULT_MAX_HOOK_LATENCY_MS = 50;
/** 50 decisions — rolling window over the JSONL audit (B5), so the rate has a population on quiet hosts too. */
const DEFAULT_FALSE_ALARM_WINDOW = 50;

/** `report` = decide + audit only (dryRun); `kill` = send signals (PRD Stufe 2, after calibration). */
const MODE_VALUES = new Set(['report', 'kill']);
const DEFAULT_MODE = 'report';

/**
 * Coerce a raw string into a finite integer >= `min`, else `fallback`.
 *
 * @param {string} raw
 * @param {number} fallback
 * @param {number} min
 * @returns {number}
 */
function parseBoundedInt(raw, fallback, min) {
  if (!/^-?\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) return fallback;
  return n;
}

/**
 * Parse the top-level `reaper:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, mode: string, 'min-age-seconds': number,
 *   'min-scan-interval-seconds': number, 'kill-grace-ms': number,
 *   'verify-wait-ms': number, 'max-hook-latency-ms': number,
 *   'false-alarm-window': number}}
 */
export function _parseReaper(content) {
  let enabled = false;
  let mode = DEFAULT_MODE;
  let minAgeSeconds = DEFAULT_MIN_AGE_SECONDS;
  let minScanIntervalSeconds = DEFAULT_MIN_SCAN_INTERVAL_SECONDS;
  let killGraceMs = DEFAULT_KILL_GRACE_MS;
  let verifyWaitMs = DEFAULT_VERIFY_WAIT_MS;
  let maxHookLatencyMs = DEFAULT_MAX_HOOK_LATENCY_MS;
  let falseAlarmWindow = DEFAULT_FALSE_ALARM_WINDOW;

  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'reaper')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default is false → only an explicit "true" arms the watchdog.
        enabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        // An unknown mode falls back to the INERT one — never to `kill`.
        mode = MODE_VALUES.has(v.toLowerCase()) ? v.toLowerCase() : DEFAULT_MODE;
        break;
      case 'min-age-seconds':
        minAgeSeconds = parseBoundedInt(v, DEFAULT_MIN_AGE_SECONDS, 0);
        break;
      case 'min-scan-interval-seconds':
        minScanIntervalSeconds = parseBoundedInt(v, DEFAULT_MIN_SCAN_INTERVAL_SECONDS, 1);
        break;
      case 'kill-grace-ms':
        killGraceMs = parseBoundedInt(v, DEFAULT_KILL_GRACE_MS, 0);
        break;
      case 'verify-wait-ms':
        verifyWaitMs = parseBoundedInt(v, DEFAULT_VERIFY_WAIT_MS, 0);
        break;
      case 'max-hook-latency-ms':
        maxHookLatencyMs = parseBoundedInt(v, DEFAULT_MAX_HOOK_LATENCY_MS, 1);
        break;
      case 'false-alarm-window':
        falseAlarmWindow = parseBoundedInt(v, DEFAULT_FALSE_ALARM_WINDOW, 1);
        break;
    }
  }

  // Self-healing clamp: a `min-age-seconds` below the scan interval is dead
  // config — a process younger than one scan period can be born and reaped
  // between two scans, so the watchdog would fire on processes it has never
  // seen before. Widen the age floor to at least one scan period (the same
  // shape as loop-guard's window >= threshold clamp).
  if (minAgeSeconds < minScanIntervalSeconds) minAgeSeconds = minScanIntervalSeconds;

  return {
    enabled,
    mode,
    'min-age-seconds': minAgeSeconds,
    'min-scan-interval-seconds': minScanIntervalSeconds,
    'kill-grace-ms': killGraceMs,
    'verify-wait-ms': verifyWaitMs,
    'max-hook-latency-ms': maxHookLatencyMs,
    'false-alarm-window': falseAlarmWindow,
  };
}
