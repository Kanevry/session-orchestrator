/**
 * markdown-fences.mjs — the ONE fenced-code-block tracker shared by every
 * Markdown-scanning validator/extractor in this repo (#1181).
 *
 * ## Why one module
 *
 * The same regex pair + open/close comparison had drifted into four separate
 * copies — `check-doc-cli-commands.mjs`, `check-skill-script-paths.mjs`,
 * `check-vcs-repo-flag.mjs` and `auq/parse.mjs` — each tracking fence depth
 * and language independently. A drifted copy is a silent one: nothing fails
 * when copy #3 diverges from copy #1, because each copy only has to agree
 * with itself.
 *
 * ## The rule this module encodes
 *
 * A fence opens on a line beginning with 3+ backticks or 3+ tildes, carrying
 * an optional info string (most commonly a language tag). It closes on a
 * line whose marker CHARACTER matches, whose LENGTH is at least the
 * opener's, and whose info string is empty — CommonMark reserves the info
 * string for the OPENING fence only, so a fence-shaped line that still
 * carries one is fence CONTENT (most often a nested fence one level in), not
 * a closer.
 *
 * ## The one real divergence between the four original copies, preserved as a parameter
 *
 * Three of the four copies anchor the fence-line regex only at the START of
 * the line — trailing text after the info string is simply not captured,
 * never rejected. `auq/parse.mjs`'s copy anchors at BOTH ends: a line
 * carrying anything past the info string besides trailing whitespace is not
 * recognised as a fence line at all. This is `{ wholeLine: true }` below —
 * a real behavioural difference, not stylistic, so it stays a caller-chosen
 * option rather than being silently resolved one way. Every other
 * consumer-specific behaviour (the shell-language predicate, blockquote
 * stripping, unbalanced-fence reporting) likewise stays at the call site —
 * this module owns only the fence-line grammar itself.
 */

/** Fence languages whose body is shell. Both `check-doc-cli-commands.mjs` and
 * `check-vcs-repo-flag.mjs` filtered on this identical literal set before
 * extraction; centralised here rather than kept as two copies of the same
 * five strings. */
export const SHELL_LANGS = Object.freeze(new Set(['bash', 'sh', 'shell', 'console', 'zsh']));

/** Start-anchored: matches CommonMark, tolerates trailing info-string text. */
const FENCE_LINE_START_RE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/;

/** Whole-line-anchored: nothing but whitespace may follow the info string. */
const FENCE_LINE_WHOLE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*([^\s`~]*)[ \t]*$/u;

/**
 * Match a candidate fence-marker line.
 *
 * @param {string} line
 * @param {{ wholeLine?: boolean }} [options] `wholeLine: true` requires the
 *   ENTIRE line (after the marker) to be nothing but the info string plus
 *   trailing whitespace — the stricter reading `auq/parse.mjs` needs.
 *   Default `false` only anchors the START of the line, matching
 *   CommonMark and the three `check-*.mjs` validators.
 * @returns {{ marker: string, length: number, info: string } | null}
 */
export function matchFenceLine(line, { wholeLine = false } = {}) {
  const match = (wholeLine ? FENCE_LINE_WHOLE_RE : FENCE_LINE_START_RE).exec(line);
  if (!match) return null;
  return { marker: match[1][0], length: match[1].length, info: match[2] ?? '' };
}

/**
 * Does `candidate` close the fence opened by `open`? Same marker character,
 * at least as long, and carrying no info string of its own.
 *
 * @param {{ marker: string, length: number }} open
 * @param {{ marker: string, length: number, info: string }} candidate
 * @returns {boolean}
 */
export function closesFence(open, candidate) {
  return candidate.marker === open.marker && candidate.length >= open.length && candidate.info === '';
}

/**
 * Normalise a fence's info string into a comparable language tag. Every
 * caller that classified a fence by language did `.toLowerCase()` (never
 * `.trim()`, since the capturing regex cannot include leading/trailing
 * whitespace in the first place) before comparing against a language set —
 * this makes that normalisation a single, explicit step instead of an
 * implicit property of the extraction regex.
 *
 * @param {string} info
 * @returns {string}
 */
export function normalizeLang(info) {
  return String(info ?? '').trim().toLowerCase();
}

/**
 * Strip a leading blockquote `>` chain so a quoted fence (`> \`\`\``) is
 * still recognised as a fence line. Only `check-skill-script-paths.mjs`
 * needs this — a fence inside a blockquote is still a fence there, but the
 * other callers never scan quoted content.
 *
 * @param {string} line
 * @returns {string}
 */
export function stripBlockquote(line) {
  return line.replace(/^(?:\s*>)+\s?/, '');
}

/**
 * Walk `text` line by line, tracking fence state, and call `onLine` for
 * every CONTENT line. Fence-marker lines themselves (the opener and the
 * closer) are consumed by the tracker and never handed to the callback —
 * all four original copies treated marker lines as structural, never as
 * scannable content. A fence-shaped line that neither opens nor validly
 * closes (a nested fence one level in) IS still content and reaches the
 * callback, exactly as in the original copies.
 *
 * @param {string} text
 * @param {(line: string, state: { lineNumber: number, inFence: boolean, lang: string | null }) => void} onLine
 * @param {{ wholeLine?: boolean, stripBlockquotes?: boolean }} [options]
 * @returns {{ unbalancedFenceLine: number | null }} the 1-based line of a
 *   fence that opened and never closed by EOF, or `null` if every fence
 *   this walk saw was balanced.
 */
export function forEachLine(text, onLine, options = {}) {
  const { wholeLine = false, stripBlockquotes = false } = options;
  const lines = text.split('\n');
  /** @type {{ marker: string, length: number, openLine: number } | null} */
  let fence = null;
  let lang = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const probe = stripBlockquotes ? stripBlockquote(raw) : raw;
    const candidate = matchFenceLine(probe, { wholeLine });
    if (candidate) {
      if (fence === null) {
        fence = { marker: candidate.marker, length: candidate.length, openLine: index + 1 };
        lang = normalizeLang(candidate.info);
        continue;
      }
      if (closesFence(fence, candidate)) {
        fence = null;
        lang = null;
        continue;
      }
      // Otherwise it is fence content (a nested fence inside a wider one) — falls through.
    }
    onLine(raw, { lineNumber: index + 1, inFence: fence !== null, lang });
  }

  return { unbalancedFenceLine: fence ? fence.openLine : null };
}

/**
 * Extract fence BLOCKS (an open/close pair plus its body) rather than a
 * per-line walk — the shape `auq/parse.mjs` needs, since it iterates fences
 * as units, not lines.
 *
 * An unbalanced fence (opens, never closes) contributes NO block, mirroring
 * the original `fencesOf()` contract: it silently drops the dangling opener
 * rather than reporting it. Unlike `check-skill-script-paths.mjs`, whose
 * unterminated fence is a doc DEFECT worth its own finding, `auq/parse.mjs`
 * scans AskUserQuestion blocks in production code and prose, where an
 * unterminated fence was never treated as a reportable condition in its own
 * right — only as "no block found here".
 *
 * @param {string} text
 * @param {{ wholeLine?: boolean }} [options]
 * @returns {Array<{ openLine: number, closeLine: number, lang: string, bodyLines: string[], bodyStartLine: number }>}
 */
export function scanFenceBlocks(text, options = {}) {
  const { wholeLine = false } = options;
  const lines = text.split('\n');
  /** @type {Array<{ openLine: number, closeLine: number, lang: string, bodyLines: string[], bodyStartLine: number }>} */
  const blocks = [];
  /** @type {{ marker: string, length: number, info: string, startIdx: number } | null} */
  let open = null;

  for (let index = 0; index < lines.length; index += 1) {
    const candidate = matchFenceLine(lines[index], { wholeLine });
    if (!candidate) continue;
    if (open === null) {
      open = { ...candidate, startIdx: index };
      continue;
    }
    if (!closesFence(open, candidate)) continue; // fence content (nested), not a close
    blocks.push({
      openLine: open.startIdx + 1,
      closeLine: index + 1,
      lang: open.info,
      bodyLines: lines.slice(open.startIdx + 1, index),
      bodyStartLine: open.startIdx + 2,
    });
    open = null;
  }
  return blocks;
}
