/**
 * scripts/lib/frontend-detect/rules.mjs
 *
 * Deterministic frontend-slop rule registry (regex tier — no LLM, no API key,
 * no browser). Each rule is a pure function over file text that returns zero or
 * more matches with the offending line + snippet.
 *
 * Design provenance: the rule *catalogue* (which AI-generated design tells to
 * detect) is inspired by pbakaus/impeccable (Apache-2.0) and our own
 * `.claude/rules/frontend.md`. The detection *code* here is a clean-room
 * regex-tier reimplementation — we deliberately skip impeccable's heavier
 * static-HTML CSS-cascade + Puppeteer tiers (cost ≫ value for a pre-commit /
 * discovery probe; see the analysis in the linked backlog issue).
 *
 * The load-bearing idea we adopt: every prose design rule should have a
 * MECHANICAL counterpart. `ruleRef` ties each detector rule back to the prose
 * guidance it enforces — the "Disziplin statt Mechanik" pattern applied to a
 * domain (frontend quality) we previously enforced with prose alone.
 *
 * Rule contract:
 *   {
 *     id: string,                 // stable kebab-case id
 *     ruleRef: string,            // prose-guidance anchor it enforces
 *     severity: 'high'|'medium'|'low',
 *     category: 'ai-slop'|'quality',
 *     title: string,
 *     recommendation: string,
 *     fpRisk: 'low'|'medium'|'high',   // false-positive risk (honesty signal)
 *     scan(content: string): Array<{ line: number, snippet: string, value?: string }>
 *   }
 *
 * A "match" is reported with a 1-based line number and a trimmed snippet of the
 * offending source line.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Convert a 0-based string index to a 1-based line number.
 * @param {string} content
 * @param {number} index
 * @returns {number}
 */
function lineOf(content, index) {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/**
 * Return the trimmed full source line containing `index`, capped to 160 chars.
 * @param {string} content
 * @param {number} index
 * @returns {string}
 */
function snippetAt(content, index) {
  const start = content.lastIndexOf('\n', index - 1) + 1;
  let end = content.indexOf('\n', index);
  if (end === -1) end = content.length;
  const raw = content.slice(start, end).trim();
  return raw.length > 160 ? `${raw.slice(0, 157)}…` : raw;
}

/**
 * Run a global regex over content and emit one match per hit.
 * Deduplicates by line so a single offending line reports once.
 * @param {string} content
 * @param {RegExp} re — MUST have the global flag
 * @returns {Array<{ line: number, snippet: string, value: string }>}
 */
function scanRegex(content, re) {
  const out = [];
  const seenLines = new Set();
  let m;
  // Defensive: reset lastIndex in case a non-fresh regex is passed.
  re.lastIndex = 0;
  while ((m = re.exec(content)) !== null) {
    const line = lineOf(content, m.index);
    if (seenLines.has(line)) continue;
    seenLines.add(line);
    out.push({ line, snippet: snippetAt(content, m.index), value: m[0].trim() });
    // Guard against zero-width matches looping forever.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// Purple / indigo / violet color tokens — the canonical AI-gradient palette.
const PURPLE_TOKENS = [
  'purple',
  'violet',
  'indigo',
  'fuchsia',
  'rebeccapurple',
  '#7c3aed',
  '#8b5cf6',
  '#a855f7',
  '#6366f1',
  '#818cf8',
  '#d946ef',
  '#c084fc',
  '#9333ea',
];
const BLUE_TOKENS = ['blue', '#3b82f6', '#2563eb', '#60a5fa', '#0ea5e9', '#06b6d4', 'cyan'];

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** @type {Array<import('./detect.mjs').Rule>} */
export const RULES = [
  {
    id: 'gradient-text',
    ruleRef: 'frontend.md#absolute-bans (gradient text)',
    severity: 'high',
    category: 'ai-slop',
    title: 'Gradient text (background-clip:text + gradient)',
    recommendation:
      'Decorative, never meaningful. Use a single solid color; carry emphasis with weight or size.',
    fpRisk: 'low',
    scan(content) {
      const matches = [];
      // CSS form: background-clip:text (or -webkit-) anywhere AND a gradient() anywhere.
      const hasClipText = /(?:-webkit-)?background-clip\s*:\s*text\b/i.test(content);
      const hasGradient = /\b(?:linear|radial|conic)-gradient\s*\(/i.test(content);
      if (hasClipText && hasGradient) {
        matches.push(...scanRegex(content, /(?:-webkit-)?background-clip\s*:\s*text\b/gi));
      }
      // Tailwind form: the `bg-clip-text` utility is the unambiguous tell.
      matches.push(...scanRegex(content, /\bbg-clip-text\b/g));
      return dedupeByLine(matches);
    },
  },

  {
    id: 'side-stripe-border',
    ruleRef: 'frontend.md#absolute-bans (side-stripe borders)',
    severity: 'high',
    category: 'ai-slop',
    title: 'Side-stripe accent border (border-left/right ≥ 2px)',
    recommendation:
      'Never intentional as a colored accent. Use full borders, a background tint, a leading icon/number, or nothing.',
    fpRisk: 'low',
    scan(content) {
      const matches = [];
      // CSS: border-left: 4px solid <color>  (width >= 2, not transparent/none)
      const css = /border-(?:left|right)\s*:\s*(\d+)px\s+(?:solid|dashed|dotted|double)\b(?![^;]*\b(?:transparent|none)\b)/gi;
      let m;
      css.lastIndex = 0;
      while ((m = css.exec(content)) !== null) {
        if (Number(m[1]) >= 2) {
          matches.push({ line: lineOf(content, m.index), snippet: snippetAt(content, m.index), value: m[0].trim() });
        }
      }
      // Tailwind: border-l-2 / border-l-4 / border-l-8 / border-r-4 ...
      matches.push(...scanRegex(content, /\bborder-(?:l|r)-(?:2|4|8)\b/g));
      return dedupeByLine(matches);
    },
  },

  {
    id: 'overused-font',
    ruleRef: 'frontend.md / development.md (avoid overused fonts)',
    severity: 'medium',
    category: 'ai-slop',
    title: 'Overused primary font (Inter / Roboto / Arial / Helvetica)',
    recommendation:
      'Every model reaches for these. Pick a font with a point of view; keep these only as fallbacks deeper in the stack.',
    fpRisk: 'medium',
    scan(content) {
      // First family in a font-family stack is one of the overused four.
      return scanRegex(content, /font-family\s*:\s*["']?(?:Inter|Roboto|Arial|Helvetica)\b/gi);
    },
  },

  {
    id: 'bounce-easing',
    ruleRef: 'frontend.md#motion (no bounce/elastic easing)',
    severity: 'medium',
    category: 'ai-slop',
    title: 'Bounce / elastic / overshoot easing',
    recommendation: 'Feels dated. Ease out with exponential curves (ease-out-quart / quint / expo). No overshoot.',
    fpRisk: 'low',
    scan(content) {
      const matches = [];
      // Keyword easings.
      matches.push(...scanRegex(content, /\b(?:bounce|elastic|wobble|spring)\b/gi));
      // cubic-bezier with a y-control point > 1 or < 0 (overshoot).
      const cb = /cubic-bezier\(\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gi;
      let m;
      cb.lastIndex = 0;
      while ((m = cb.exec(content)) !== null) {
        const y1 = Number(m[2]);
        const y2 = Number(m[4]);
        if (y1 > 1 || y2 > 1 || y1 < 0 || y2 < 0) {
          matches.push({ line: lineOf(content, m.index), snippet: snippetAt(content, m.index), value: m[0].trim() });
        }
      }
      return dedupeByLine(matches);
    },
  },

  {
    id: 'ai-purple-gradient',
    ruleRef: 'frontend.md / PRODUCT anti-references (purple-to-blue gradients)',
    severity: 'medium',
    category: 'ai-slop',
    title: 'Purple / indigo AI gradient',
    recommendation:
      'The single most recognizable AI tell. If purple is genuinely the brand, keep it flat; otherwise pick a committed strategy.',
    fpRisk: 'high',
    scan(content) {
      const matches = [];
      const grad = /\b(?:linear|radial|conic)-gradient\s*\(([^)]*)\)/gi;
      let m;
      grad.lastIndex = 0;
      while ((m = grad.exec(content)) !== null) {
        const args = m[1].toLowerCase();
        const purpleHits = PURPLE_TOKENS.filter((t) => args.includes(t)).length;
        const blueHits = BLUE_TOKENS.filter((t) => args.includes(t)).length;
        // Tell = two purples, OR a purple→blue ramp.
        if (purpleHits >= 2 || (purpleHits >= 1 && blueHits >= 1)) {
          matches.push({ line: lineOf(content, m.index), snippet: snippetAt(content, m.index), value: m[0].trim().slice(0, 80) });
        }
      }
      return dedupeByLine(matches);
    },
  },

  {
    id: 'pure-black-ink',
    ruleRef: 'frontend.md (never pure black/gray — always tint)',
    severity: 'low',
    category: 'quality',
    title: 'Pure black text color (#000 / black / rgb(0,0,0))',
    recommendation: 'Pure black reads harsh on screen. Tint toward the brand hue (e.g. very dark, slightly hued ink).',
    fpRisk: 'medium',
    scan(content) {
      return scanRegex(
        content,
        /color\s*:\s*(?:#000(?:000)?\b|black\b|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))/gi,
      );
    },
  },

  {
    id: 'arbitrary-z-index',
    ruleRef: 'frontend.md#layout (semantic z-index scale, never 999/9999)',
    severity: 'low',
    category: 'quality',
    title: 'Arbitrary z-index (999 / 9999 …)',
    recommendation: 'Build a semantic z-index scale (dropdown → sticky → modal → toast → tooltip). Never magic numbers.',
    fpRisk: 'low',
    scan(content) {
      return scanRegex(content, /z-index\s*:\s*(?:9{3,})\b/gi);
    },
  },

  {
    id: 'layout-property-transition',
    ruleRef: 'frontend.md#motion (don\'t animate layout properties)',
    severity: 'low',
    category: 'quality',
    title: 'Animating layout properties (width/height/margin/…)',
    recommendation:
      'Animating layout props thrashes the main thread. Animate transform/opacity; reserve layout animation for genuine need.',
    fpRisk: 'medium',
    scan(content) {
      // `transition:` shorthand whose property list includes a layout prop.
      return scanRegex(
        content,
        /transition\s*:\s*[^;{}]*\b(?:width|height|top|left|right|bottom|margin|padding)\b/gi,
      );
    },
  },
];

/**
 * Collapse multiple matches on the same line into one (stable order).
 * @param {Array<{line:number, snippet:string, value?:string}>} matches
 */
function dedupeByLine(matches) {
  const byLine = new Map();
  for (const mt of matches) {
    if (!byLine.has(mt.line)) byLine.set(mt.line, mt);
  }
  return [...byLine.values()].sort((a, b) => a.line - b.line);
}

/** Stable list of rule ids (for config validation + tests). */
export const RULE_IDS = RULES.map((r) => r.id);
