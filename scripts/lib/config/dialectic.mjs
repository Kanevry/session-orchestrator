import { matchBlockHeader } from './block-header.mjs';

/**
 * dialectic.mjs — Parser for top-level `dialectic:` YAML block (#506).
 *
 * Drives the Dialectic-Deriver via /evolve --dialectic and session-end Phase 3.6.7.
 * Returns { cadence, model, "budget-tokens" }.
 * Fail-fast on unknown model value (per #506 EARS unwanted-behaviour);
 * silent fallback for out-of-range integers (matches cold-start.mjs precedent).
 *
 * Consumer: skills/evolve/SKILL.md Phase 6, skills/session-end/SKILL.md Phase 3.6.7.
 */

const ALLOWED_MODELS = new Set(['haiku', 'sonnet', 'opus']);

/**
 * Parse the top-level `dialectic:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   cadence:       5 (integer ≥ 0 — session count between auto-runs; 0 = disabled)
 *   model:         'haiku'
 *   budget-tokens: 8000 (integer ≥ 0)
 *
 * Throws if `model` is present but not one of haiku|sonnet|opus.
 *
 * @param {string} content — full file contents
 * @returns {{ cadence: number, model: string, "budget-tokens": number }}
 */
export function _parseDialectic(content) {
  const defaults = { cadence: 5, model: 'haiku', 'budget-tokens': 8000 };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (matchBlockHeader(line, 'dialectic')) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let cadence = 5;
  let model = 'haiku';
  let budgetTokens = 8000;

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
      case 'cadence': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) cadence = n;
        }
        break;
      }
      case 'model': {
        const lower = v.toLowerCase();
        if (!ALLOWED_MODELS.has(lower)) {
          throw new Error(`dialectic.model must be haiku|sonnet|opus, got '${v}'`);
        }
        model = lower;
        break;
      }
      case 'budget-tokens': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) budgetTokens = n;
        }
        break;
      }
    }
  }

  return { cadence, model, 'budget-tokens': budgetTokens };
}
