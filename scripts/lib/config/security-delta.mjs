import { matchBlockHeader } from './block-header.mjs';
import { preprocessBlockLines } from './block-preprocess.mjs';
import { MODES } from '../security-delta/contract.mjs';

/**
 * security-delta.mjs — Parser for the top-level `security-delta:` YAML block
 * (#1769, stage 1).
 *
 * Drives session-end Phase 2.4 and `scripts/security-delta.mjs`. Stage 1 knows
 * one key only — `mode` (off | warn | strict). Budget keys are deliberately
 * absent until a consumer needs them.
 *
 * Returns { mode }. Default `{ mode: 'off' }` when the block is absent (opt-in
 * rollout). Fail-fast on an unknown `mode` value (mirrors eval.mjs).
 *
 * PARSER GOTCHA (mirrors eval.mjs): the `security-delta:` key-line itself MUST
 * NOT carry an inline comment — `matchBlockHeader` then fails to match, the
 * block is never entered and the default `off` applies silently. Sub-key lines
 * tolerate inline comments.
 */

const ALLOWED_MODE = new Set(MODES);

/**
 * Parse the top-level `security-delta:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Throws if `mode` is present but not one of `off|warn|strict`.
 *
 * @param {string} content — full file contents
 * @returns {{ mode: 'off'|'warn'|'strict' }}
 */
export function _parseSecurityDelta(content) {
  const lines = preprocessBlockLines(content);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'security-delta')) inBlock = true;
      continue;
    }
    // Stop at next column-0 non-empty line (sibling top-level key or heading)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  let mode = 'off';

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    if (kvMatch[1] === 'mode') {
      const lower = v.toLowerCase();
      if (!ALLOWED_MODE.has(lower)) {
        throw new Error(`security-delta.mode must be off|warn|strict, got '${v}'`);
      }
      mode = lower;
    }
  }

  return { mode };
}
