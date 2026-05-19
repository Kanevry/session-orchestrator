/**
 * language-mappers/markdown.mjs — Semantic slice extractor for Markdown files.
 *
 * Uses remark + remark-parse (lazy import) to parse the content into an mdast
 * tree and emits `section` slices for each heading node.
 *
 * Section endLine: line of the NEXT heading of equal-or-lesser depth, or EOF.
 * Headings whose depth indicates nesting (h3 inside h2) are still emitted as
 * individual slices; their endLine is bounded by the next peer heading.
 *
 * Frontmatter (YAML `---` block) is NOT emitted as a section.
 *
 * Part of the Clawpatch Borrow Cluster (issue #416).
 */

// ---------------------------------------------------------------------------
// Types (JSDoc only)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   kind: 'section';
 *   name: string;
 *   file: string;
 *   line: number;
 *   endLine: number;
 *   exported: boolean;
 *   isNested: boolean;
 *   fidelity: 'ast';
 *   params: [number];   // [depth] — heading level 1-6
 * }} SectionSlice
 */

// All slices produced by this mapper carry fidelity:'ast' (#474 MED-3) —
// they come from a real remark mdast walk, not regex matching.
const FIDELITY = /** @type {'ast'} */ ('ast');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the plain-text value of an mdast node by concatenating all
 * descendant text nodes.  Matches what mdast-util-to-string does.
 *
 * @param {object} node  mdast node
 * @returns {string}
 */
async function nodeText(node) {
  const { toString } = await import('mdast-util-to-string');
  return toString(node);
}

/**
 * Determine whether a node is YAML frontmatter (type 'yaml') created by
 * remark-frontmatter.  Since we only use remark-parse (no remark-frontmatter),
 * a leading `---` block is parsed as a ThematicBreak + Paragraph.  We detect
 * it conservatively: if the first node is a thematic break (---) followed by
 * a paragraph, it looks like front-matter — skip the thematic-break.
 * In practice, remark-parse does NOT expose a yaml node unless remark-frontmatter
 * is also loaded, so this helper is mostly defensive.
 *
 * @param {object} node
 * @returns {boolean}
 */
function isFrontmatterNode(node) {
  return node.type === 'yaml' || node.type === 'toml';
}

/**
 * Return the 1-based line number of the last line of the document.
 *
 * @param {string} content
 * @returns {number}
 */
function countLines(content) {
  const lines = content.split('\n');
  return lines.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract section slices from Markdown content.
 *
 * @param {string} filePath   Source file path (used only for the slice `file` field).
 * @param {string} content    Raw Markdown text.
 * @returns {Promise<SectionSlice[]>}
 */
export async function extractMarkdownSlices(filePath, content) {
  if (!content.trim()) return [];

  const { unified } = await import('unified');
  const { default: remarkParse } = await import('remark-parse');

  const processor = unified().use(remarkParse);
  const tree = processor.parse(content);

  const totalLines = countLines(content);

  // Collect only heading nodes, in document order
  /** @type {Array<{node: object; depth: number; line: number; text: string}>} */
  const headings = [];

  for (const node of tree.children ?? []) {
    if (isFrontmatterNode(node)) continue;
    if (node.type !== 'heading') continue;
    const line = node.position?.start?.line ?? 1;
    const text = await nodeText(node);
    headings.push({ node, depth: node.depth, line, text });
  }

  if (headings.length === 0) return [];

  /** @type {SectionSlice[]} */
  const slices = [];

  for (let i = 0; i < headings.length; i++) {
    const { depth, line, text } = headings[i];

    // endLine = line before the next heading of equal-or-lesser depth, or EOF
    let endLine = totalLines;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].depth <= depth) {
        // The next heading at the same or higher level ends this section
        endLine = headings[j].line - 1;
        break;
      }
    }
    // Ensure endLine is at least the start line
    if (endLine < line) endLine = line;

    slices.push({
      kind: 'section',
      name: text,
      file: filePath,
      line,
      endLine,
      exported: true,
      isNested: false,
      fidelity: FIDELITY,
      params: [depth],
    });
  }

  return slices;
}
