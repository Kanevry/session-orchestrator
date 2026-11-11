import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';

/**
 * context-threshold.mjs — Parser for the top-level `context-threshold:` YAML
 * block (#1960).
 *
 * Drives `hooks/post-tool-context-threshold.mjs`: a PostToolUse hook that reads
 * the session's own context size from its transcript and injects one hint when
 * it crosses `prepare-k` (prepare the handover file, start no new wave) and one
 * when it crosses `handover-k` (hand over at the next MR cut). Values are in
 * THOUSANDS of tokens. Warn-only / non-blocking; profile-gate also applies.
 *
 * Returns `{ enabled, "prepare-k", "handover-k" }`.
 * Tolerant parser: malformed values fall back to defaults. If the two values
 * end up inverted (`handover-k <= prepare-k`), both fall back to the defaults —
 * an inverted pair would fire the handover hint before the prepare hint.
 *
 * Consumers: `hooks/post-tool-context-threshold.mjs`, `scripts/lib/config.mjs`.
 */

export const DEFAULT_PREPARE_K = 700;
export const DEFAULT_HANDOVER_K = 800;

/**
 * @param {string} raw
 * @param {number} fallback
 * @returns {number} positive integer, or `fallback`
 */
function parsePositiveInt(raw, fallback) {
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse the top-level `context-threshold:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults: enabled true, prepare-k 700, handover-k 800.
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, "prepare-k": number, "handover-k": number }}
 */
export function _parseContextThreshold(content) {
  const defaults = {
    enabled: true,
    'prepare-k': DEFAULT_PREPARE_K,
    'handover-k': DEFAULT_HANDOVER_K,
  };

  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'context-threshold')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let enabled = true;
  let prepareK = DEFAULT_PREPARE_K;
  let handoverK = DEFAULT_HANDOVER_K;

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
        // Default is true → only flip to false on explicit "false"
        enabled = v.toLowerCase() !== 'false';
        break;
      case 'prepare-k':
        prepareK = parsePositiveInt(v, DEFAULT_PREPARE_K);
        break;
      case 'handover-k':
        handoverK = parsePositiveInt(v, DEFAULT_HANDOVER_K);
        break;
    }
  }

  if (handoverK <= prepareK) {
    process.stderr.write(
      `⚠ context-threshold: handover-k (${handoverK}) must exceed prepare-k (${prepareK}) — falling back to ${DEFAULT_PREPARE_K}/${DEFAULT_HANDOVER_K}\n`,
    );
    prepareK = DEFAULT_PREPARE_K;
    handoverK = DEFAULT_HANDOVER_K;
  }

  return { enabled, 'prepare-k': prepareK, 'handover-k': handoverK };
}
