import { matchBlockHeader } from './block-header.mjs';

/**
 * handover-gate.mjs — Parser for the top-level `handover-gate:` YAML block
 * (PRD 2026-07-07 /close Handover-Alignment-Gate — Epic #724).
 *
 * Drives the interactive Handover-Alignment-Gate in session-end Phase 1.65:
 * gates carryover-candidate filing behind an AskUserQuestion triage pass
 * instead of the silent-filing status quo.
 *
 * Returns `{ enabled, "max-open-questions" }`.
 * Tolerant parser: malformed values silently fall back to defaults, EXCEPT
 * `max-open-questions` — a malformed or negative value emits a stderr WARN
 * before falling back (PRD §3.A FA5 "Unwanted behaviour" explicitly requires
 * the WARN here — a deliberate minor divergence from sibling block parsers
 * like `reconcile.min-rule-days`, which fall back silently).
 *
 * Consumer: `scripts/lib/config.mjs`, `skills/session-end/SKILL.md` Phase 1.65.
 */

/**
 * Parse the top-level `handover-gate:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled:            true
 *   max-open-questions: 3 (integer >= 0; 0 is a VALID value — "no questions
 *                          in the gate", the Open-Questions channel itself
 *                          stays active). Malformed or negative input falls
 *                          back to 3 and emits a stderr WARN.
 *
 * YAML shape:
 *   handover-gate:
 *     enabled: true
 *     max-open-questions: 3
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, "max-open-questions": number }}
 */
export function _parseHandoverGate(content) {
  const defaults = {
    enabled: true,
    'max-open-questions': 3,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'handover-gate')) inBlock = true;
      continue;
    }
    // Stop at next column-0 non-empty line (sibling top-level key or H2 heading)
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let enabled = true;
  let maxOpenQuestions = 3;

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
      case 'enabled':
        // Default is true → only flip to false on explicit "false"
        enabled = v.toLowerCase() !== 'false';
        break;

      case 'max-open-questions': {
        if (/^\d+$/.test(v)) {
          // Non-negative integer (0 is valid — see defaults doc above)
          maxOpenQuestions = parseInt(v, 10);
        } else {
          // Malformed (non-numeric, empty) or negative (fails the \d+ test) —
          // PRD §3.A FA5 requires a stderr WARN on this fallback path.
          process.stderr.write(
            `⚠ handover-gate.max-open-questions: '${v}' invalid — falling back to 3\n`
          );
          maxOpenQuestions = 3;
        }
        break;
      }
    }
  }

  return {
    enabled,
    'max-open-questions': maxOpenQuestions,
  };
}
