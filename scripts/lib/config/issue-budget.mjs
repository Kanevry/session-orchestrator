import { matchBlockHeader } from './block-header.mjs';

/**
 * issue-budget.mjs — Parser for the `issue-budget:` block-style Session Config key.
 *
 * Bounds how many issues ONE session may create. Motivation (measured on the
 * private instance over four weeks): 1784 issues created against 1285 closed
 * (net +499), median inter-creation gap 2.6 s, 62 % of creations inside bursts
 * of >= 5 per minute. The pre-existing `discovery-confidence-threshold` /
 * `discovery-severity-threshold` knobs do NOT bound this: they are per-finding
 * QUALITY filters (and the `low` default filters nothing), they are only read
 * in skill prose, and the largest producers never consult them at all.
 *
 * This key is a QUANTITY cap, enforced mechanically by
 * `hooks/pre-bash-issue-budget.mjs` (shell path) and
 * `scripts/lib/spiral-carryover.mjs` `runCli()` (programmatic path), both via
 * `scripts/lib/issue-budget.mjs`.
 *
 * Returns `{ "max-per-session", mode, overflow }`.
 * Tolerant parser: malformed values silently fall back to defaults (the
 * `reconcile.min-rule-days` posture, NOT the noisier handover-gate WARN) —
 * a hook must never spam stderr on every single Bash call.
 *
 * Consumers: `scripts/lib/config.mjs`, `scripts/lib/issue-budget.mjs`,
 * `hooks/pre-bash-issue-budget.mjs`, `skills/session-end/SKILL.md` Phase 5.
 */

/** Valid `mode` values. */
const MODES = ['strict', 'warn', 'off'];

/** Valid `overflow` values. */
const OVERFLOW_SINKS = ['collect-issue', 'vault-note'];

/**
 * Parse the `issue-budget:` block from markdown content.
 *
 * Like every sibling block parser this scans the FULL content rather than the
 * `## Session Config` fence, so the block resolves identically whether it is
 * nested inside `## Session Config` (the documented home) or lifted to a
 * top-level block. Bold-bullet headers (`- **issue-budget:**`) are tolerated
 * via the shared `matchBlockHeader` (#830).
 *
 * Defaults:
 *   max-per-session: 12        integer >= 0; 0 means "no issue may be created"
 *                              (a valid, deliberately harsh setting). Malformed
 *                              or negative input falls back to 12.
 *   mode:            strict    strict | warn | off
 *   overflow:        collect-issue   collect-issue | vault-note
 *
 * YAML shape:
 *   issue-budget:
 *     max-per-session: 12
 *     mode: strict
 *     overflow: collect-issue
 *
 * @param {string} content — full file contents
 * @returns {{ "max-per-session": number, mode: string, overflow: string }}
 */
export function _parseIssueBudget(content) {
  const defaults = {
    'max-per-session': 12,
    mode: 'strict',
    overflow: 'collect-issue',
  };

  if (typeof content !== 'string' || content === '') return { ...defaults };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'issue-budget')) inBlock = true;
      continue;
    }
    // Stop at next column-0 non-empty line (sibling top-level key or H2 heading)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return { ...defaults };

  let maxPerSession = defaults['max-per-session'];
  let mode = defaults.mode;
  let overflow = defaults.overflow;

  for (const rawLine of blockLines) {
    // Strip inline comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'max-per-session':
        // Non-negative integer only; a leading '-' fails \d+ → default.
        if (/^\d+$/.test(v)) maxPerSession = parseInt(v, 10);
        break;

      case 'mode':
        if (MODES.includes(v.toLowerCase())) mode = v.toLowerCase();
        break;

      case 'overflow':
        if (OVERFLOW_SINKS.includes(v.toLowerCase())) overflow = v.toLowerCase();
        break;
    }
  }

  return {
    'max-per-session': maxPerSession,
    mode,
    overflow,
  };
}
