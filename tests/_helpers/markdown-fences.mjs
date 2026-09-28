/**
 * tests/_helpers/markdown-fences.mjs — fenced code blocks out of a Markdown
 * document, for tests that EXECUTE a command a skill body documents instead of
 * pinning its prose (TV-002c).
 *
 * ## Why this exists
 *
 * Two tests extract the same `/evolve` Step 3.5(5) recipe from
 * `skills/evolve/references/evolve-analyze-mode.md` and grew their own
 * near-copies of this parser: a regex that paired ```` ```bash ```` with the next
 * ```` ``` ```` and captured the closing fence's indentation, and a line-based
 * scanner. The recipe sits inside a numbered list, so its fence is indented; the
 * line-based form pairs fences sequentially and is the one kept here.
 *
 * ## Contract
 *
 * - A fence is any line whose first non-whitespace characters are three
 *   backticks. The text after them (trimmed, up to the first whitespace) is the
 *   language tag; the closing fence is the next such line.
 * - Each body is returned VERBATIM (indentation included — bash ignores leading
 *   whitespace), joined with `\n`, without the fence lines. Nothing about the
 *   extracted string is the calling test's invention.
 * - An unterminated trailing fence yields no block.
 *
 * @module tests/_helpers/markdown-fences
 */

/**
 * Every fenced code block body in `markdown`, in document order.
 *
 * @param {string} markdown - the Markdown document text
 * @param {{ lang?: string }} [options] - `lang` keeps only blocks whose opening
 *   fence carries exactly this language tag (e.g. `'bash'`)
 * @returns {string[]} block bodies, fence lines excluded
 */
export function fencedBlocks(markdown, { lang } = {}) {
  const blocks = [];
  let body = null;
  let blockLang = '';
  for (const line of markdown.split('\n')) {
    const fence = line.match(/^\s*```\s*(\S*)/);
    if (fence) {
      if (body === null) {
        body = [];
        blockLang = fence[1];
      } else {
        if (lang === undefined || blockLang === lang) blocks.push(body.join('\n'));
        body = null;
      }
      continue;
    }
    if (body !== null) body.push(line);
  }
  return blocks;
}

/**
 * Every fenced code block body in `markdown` that mentions `needle`.
 *
 * @param {string} markdown - the Markdown document text
 * @param {string} needle - substring the block body must contain
 * @param {{ lang?: string }} [options] - see {@link fencedBlocks}
 * @returns {string[]} matching block bodies, fence lines excluded
 */
export function fencedBlocksMentioning(markdown, needle, options) {
  return fencedBlocks(markdown, options).filter((b) => b.includes(needle));
}
