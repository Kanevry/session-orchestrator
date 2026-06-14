/**
 * skill-evolution.mjs — Parser for the top-level `skill-evolution:` YAML block
 * (Epic #643 Skill Self-Evolution Foundation / issue #646 C1-config).
 *
 * Returns `{ autonomy, "evidence-floor", judge, "judge-budget-tokens" }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * NOTE: `skill-evolution:` is a DISTINCT sibling block from the pre-existing
 * `evolve:` block. Do not confuse them; this parser only touches the
 * `skill-evolution:` header.
 *
 * Consumers:
 *  - `scripts/lib/config.mjs` (wired in Wave 3, reads parsed object)
 *  - Skills that implement the self-evolution autonomy gate
 */

const ALLOWED_AUTONOMY = ['off', 'advisory', 'autonomous-gated'];

/**
 * Parse the top-level `skill-evolution:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   autonomy:            'off'   (enum: off | advisory | autonomous-gated)
 *   evidence-floor:      0.5    (float in [0.0, 1.0])
 *   judge:               false  (boolean: on/true → true, else false)
 *   judge-budget-tokens: 8000   (integer > 0 — L3 judge per-call input budget, #645)
 *
 * @param {string} content — full file contents
 * @returns {{ autonomy: string, "evidence-floor": number, judge: boolean, "judge-budget-tokens": number }}
 */
export function _parseSkillEvolution(content) {
  const defaults = {
    autonomy: 'off',
    'evidence-floor': 0.5,
    judge: false,
    'judge-budget-tokens': 8000,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^skill-evolution:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let autonomy = 'off';
  let evidenceFloor = 0.5;
  let judge = false;
  let judgeBudgetTokens = 8000;

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
      case 'autonomy': {
        const lower = v.toLowerCase();
        if (ALLOWED_AUTONOMY.includes(lower)) autonomy = lower;
        // else: silently fall back to default 'off'
        break;
      }
      case 'evidence-floor': {
        if (/^\d+(\.\d+)?$/.test(v)) {
          const f = parseFloat(v);
          if (Number.isFinite(f) && f >= 0.0 && f <= 1.0) evidenceFloor = f;
          // else: silently fall back to default 0.5
        }
        break;
      }
      case 'judge': {
        const lower = v.toLowerCase();
        judge = lower === 'on' || lower === 'true';
        break;
      }
      case 'judge-budget-tokens': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (Number.isInteger(n) && n > 0) judgeBudgetTokens = n;
          // else: silently fall back to default 8000
        }
        break;
      }
    }
  }

  return {
    autonomy,
    'evidence-floor': evidenceFloor,
    judge,
    'judge-budget-tokens': judgeBudgetTokens,
  };
}
