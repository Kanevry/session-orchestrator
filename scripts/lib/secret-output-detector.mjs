/**
 * secret-output-detector.mjs — value-based SEC-008 detector for secret values
 * in a tool's OUTPUT (#1786).
 *
 * After-output detection does not prevent a leak — the value is already in the
 * transcript when PostToolUse fires. What it buys is time-to-rotation: on
 * 2026-10-23 a `/close` printed seven env secrets and nobody noticed until the
 * transcript was re-read. This module turns that into an immediate signal.
 *
 * Detector "V" only: a needle is a qualifying env VALUE, selected by the
 * masker's own filters (`secretNeedleEntries` in `./secret-masker.mjs` —
 * allowlist → key-name → length; never a second copy of those filters). A
 * shape/regex detector over `.gitleaks.toml` was measured at 88.9 % false
 * alarms (2026-10-25, 896 transcripts / 44,382 Bash results) and is
 * deliberately NOT built; V fired 0.05 per 1000 Bash calls with 0 false alarms.
 *
 * Pure, synchronous, no I/O, no module state: it runs inside
 * `hooks/post-bash-write-verify.mjs` on every Bash PostToolUse call.
 *
 * NAMED CEILING (BV-004): only values present in the CALLER's env are needles.
 * A value a command loads itself (`set -a; . ./.env.local`) never reaches the
 * hook process's env and is invisible here. Revisit trigger: a leak incident
 * from a self-loaded secrets file — the answer is NOT to read that file from a
 * hook (that would put the hook in the secret-reading business).
 *
 * VALUE DISCIPLINE: the result carries counts, key NAMES and a boolean only —
 * no value, no prefix, no hash, no value length. Nothing here logs or throws.
 */

import { secretNeedleEntries } from './secret-masker.mjs';

/**
 * Per-stream scan window: the first and the last this-many UTF-16 code units of
 * each stream are scanned; the middle of a longer stream is skipped.
 *
 * NAMED CEILING (BV-004): a needle that straddles the head/tail cut, or sits
 * wholly in the skipped middle, is missed — the result then says
 * `truncated: true`. Measured Bash output p99 is 17,572 B and the max 29,965 B
 * (2026-10-25), so the cap never cuts a measured call; it exists to bound the
 * hot path against a pathological one. Revisit trigger: a real truncated hit
 * that the cut hid. Units are code units, not bytes — for ASCII output identical.
 */
export const SCAN_WINDOW_CHARS = 64 * 1024;

/**
 * Extract the scannable streams from a PostToolUse `tool_response`.
 *
 * Claude Code sends an object `{ stdout, stderr, interrupted, isImage, … }`;
 * Codex fixtures send a STRING; the Cursor bridge forwards either. Anything
 * else is not scanned.
 *
 * @param {unknown} toolResponse
 * @returns {string[]}
 */
function streamsOf(toolResponse) {
  if (typeof toolResponse === 'string') return [toolResponse];
  if (toolResponse && typeof toolResponse === 'object') {
    const r = /** @type {Record<string, unknown>} */ (toolResponse);
    return [r.stdout, r.stderr].filter((s) => typeof s === 'string');
  }
  return [];
}

/**
 * Count non-overlapping literal occurrences of `needle` in `text`.
 * @param {string} text @param {string} needle @returns {number}
 */
function countOccurrences(text, needle) {
  let n = 0;
  let i = text.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = text.indexOf(needle, i + needle.length);
  }
  return n;
}

/**
 * Scan a tool response for qualifying env values.
 *
 * @param {{ toolResponse: unknown, env: Record<string, unknown> }} args
 * @returns {{ hits: number, envKeys: string[], truncated: boolean }}
 *   `hits` = total occurrences across streams; `envKeys` = sorted, unique key
 *   NAMES whose value occurred; `truncated` = a stream exceeded the scan window.
 */
export function detectSecretOutput({ toolResponse, env } = /** @type {any} */ ({})) {
  const result = { hits: 0, envKeys: /** @type {string[]} */ ([]), truncated: false };
  const streams = streamsOf(toolResponse);
  if (streams.length === 0) return result;
  const entries = secretNeedleEntries(env);
  if (entries.length === 0) return result;

  /** @type {string[]} */
  const windows = [];
  for (const s of streams) {
    if (s.length <= 2 * SCAN_WINDOW_CHARS) {
      windows.push(s);
    } else {
      // Head and tail are scanned SEPARATELY — joining them would let a
      // needle-shaped string be assembled across the cut.
      windows.push(s.slice(0, SCAN_WINDOW_CHARS), s.slice(-SCAN_WINDOW_CHARS));
      result.truncated = true;
    }
  }

  const keys = new Set();
  for (const [key, value] of entries) {
    // The incident shape is `JSON.stringify(<object holding env values>)`: a
    // value with `"`, `\` or a control character appears ESCAPED there, so its
    // serialized form is a second needle. NAMED CEILING (BV-004): one level of
    // JSON escaping only — a value that is double-encoded, line-wrapped,
    // base64- or URL-encoded is missed. Revisit trigger: a leak in one of those
    // forms.
    const escaped = JSON.stringify(value).slice(1, -1);
    let n = 0;
    for (const w of windows) {
      if (escaped === value) {
        n += countOccurrences(w, value);
        continue;
      }
      // A value ending in `\` is a PREFIX of its escaped form, so one serialized
      // occurrence would count twice. Count the escaped spans, then search the
      // raw form only outside them — NUL cannot occur in an env value.
      n += countOccurrences(w, escaped);
      n += countOccurrences(w.split(escaped).join('\u0000'), value);
    }
    if (n > 0) {
      result.hits += n;
      keys.add(key);
    }
  }
  result.envKeys = [...keys].sort();
  return result;
}
