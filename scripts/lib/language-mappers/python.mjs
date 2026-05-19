/**
 * language-mappers/python.mjs — Semantic slice extractor for Python source files.
 *
 * Uses conservative regex patterns anchored to column 0 (^) to detect
 * module-level declarations only.  No Python parser is available in Node,
 * so this is deliberately under-counting rather than mis-classifying.
 *
 * LIMITATIONS:
 *   - Multi-line parenthesised imports (`from x import (\n  a,\n  b\n)`) are
 *     intentionally SKIPPED — the closing paren cannot be matched reliably
 *     with a single-line regex, so only the `from x import a, b` single-line
 *     form is captured.
 *   - Nested function/class definitions (indented) are not detected because
 *     column-0 anchoring (`^def`, `^class`) naturally excludes them.
 *   - `if TYPE_CHECKING:` guarded imports (indented) are likewise excluded
 *     by the column-0 anchor.
 *   - `__all__` matching is limited to single-line lists and compact
 *     multi-line lists captured in one regex.  Very long or formatted lists
 *     may not be fully parsed; in that case `exported` falls back to the
 *     underscore-prefix heuristic.
 *   - Decorators (`@decorator`) before `def`/`class` are tolerated — the
 *     regex matches the `def`/`class` line itself.
 *   - endLine equals line (no body tracking in this regex proto).
 *   - Star imports (`from x import *`) produce a single slice with name '*'.
 *
 * Part of the Clawpatch Borrow Cluster (issue #416), Phase 2.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a 1-based line-number lookup table from content.
 * Returns a function: (byteOffset) → lineNumber.
 *
 * @param {string} content
 * @returns {(offset: number) => number}
 */
function makeLineResolver(content) {
  const lineStarts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1; // 1-based
  };
}

/**
 * Parse a `__all__ = [...]` list value string into individual name strings.
 * Handles single-quoted and double-quoted entries.
 *
 * @param {string} listBody  The inner content between `[` and `]`
 * @returns {Set<string>}
 */
function parseAllList(listBody) {
  const names = new Set();
  // Match both 'name' and "name" tokens
  for (const m of listBody.matchAll(/['"](\w+)['"]/g)) {
    names.add(m[1]);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

// `import os`, `import os, sys`, `import os.path`
// Column-0 anchored; captures up to end-of-line (no newline in group).
const RE_IMPORT_BARE = /^import\s+([\w.,][^\n]*)/gm;

// `from os import path`, `from os import path, getcwd`, `from os import *`
// Single-line only — multi-line paren form intentionally skipped.
// Uses a negative lookahead to reject lines that start with multi-line `(`
const RE_IMPORT_FROM = /^from\s+([\w.]+)\s+import\s+([^\\\n(][^\n]*)/gm;

// Module-level function definitions — column-0, captures name up to `(`
const RE_DEF = /^def\s+(\w+)\s*\(/gm;

// Module-level class definitions — column-0, captures name up to `:` or `(`
const RE_CLASS = /^class\s+(\w+)\s*[:(]/gm;

// `__all__ = [...]` — captures the list body. `s` flag for multi-line lists.
const RE_ALL = /^__all__\s*=\s*\[([^\]]*)\]/ms;

// SCREAMING_SNAKE_CASE constants: `FOO = ...`, `MAX_RETRIES = 3`
// Must start at column 0, name ≥ 3 chars, all-caps with underscores.
const RE_CONSTANT = /^([A-Z][A-Z0-9_]{2,})\s*=/gm;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// All slices produced by this mapper carry fidelity:'regex' (#474 MED-3) —
// they come from column-0 regex matches, not a real Python parser AST.
const FIDELITY = /** @type {'regex'} */ ('regex');

/**
 * Extract semantic slices from Python source code.
 *
 * @param {string} filePath   Source file path (used only for the slice `file` field).
 * @param {string} content    Raw Python source text.
 * @returns {Promise<import('./typescript.mjs').SemanticSlice[]>}
 */
export async function extractPythonSlices(filePath, content) {
  if (!content.trim()) return [];

  /** @type {import('./typescript.mjs').SemanticSlice[]} */
  const slices = [];
  const lineOf = makeLineResolver(content);

  // ------------------------------------------------------------------
  // 1. Parse __all__ first so we can refine exported flags below.
  // ------------------------------------------------------------------
  /** @type {Set<string>|null} */
  let allNames = null;
  const allMatch = RE_ALL.exec(content);
  if (allMatch) {
    allNames = parseAllList(allMatch[1]);
  }

  /**
   * Determine whether a module-level name is considered exported.
   * If `__all__` is defined, membership takes precedence.
   * Otherwise falls back to the single-underscore-prefix convention.
   *
   * @param {string} name
   * @returns {boolean}
   */
  function isExported(name) {
    if (allNames !== null) return allNames.has(name);
    return !name.startsWith('_');
  }

  // ------------------------------------------------------------------
  // 2. Bare imports: `import os` / `import os, sys`
  // ------------------------------------------------------------------
  for (const m of content.matchAll(RE_IMPORT_BARE)) {
    const line = lineOf(m.index);
    // Split comma-separated names and trim whitespace
    const names = m[1].split(',').map((n) => n.trim()).filter(Boolean);
    for (const name of names) {
      // Each bare `import` name is a dependency reference, not a public symbol
      slices.push({
        kind: 'export',
        name,
        file: filePath,
        line,
        endLine: line,
        exported: false,
        isNested: false,
        fidelity: FIDELITY,
      });
    }
  }

  // ------------------------------------------------------------------
  // 3. From imports: `from os import path, getcwd`
  // ------------------------------------------------------------------
  for (const m of content.matchAll(RE_IMPORT_FROM)) {
    const line = lineOf(m.index);
    const moduleName = m[1];
    const importsPart = m[2].trim();

    // Split comma-separated imported names
    const names = importsPart.split(',').map((n) => n.trim()).filter(Boolean);
    for (const name of names) {
      slices.push({
        kind: 'export',
        name: `${moduleName}.${name}`,
        file: filePath,
        line,
        endLine: line,
        exported: false,
        isNested: false,
        fidelity: FIDELITY,
        source: moduleName,
      });
    }
  }

  // ------------------------------------------------------------------
  // 4. Module-level functions: `def foo(`
  // ------------------------------------------------------------------
  for (const m of content.matchAll(RE_DEF)) {
    const line = lineOf(m.index);
    const name = m[1];
    slices.push({
      kind: 'function',
      name,
      file: filePath,
      line,
      endLine: line,
      exported: isExported(name),
      isNested: false,
      fidelity: FIDELITY,
    });
  }

  // ------------------------------------------------------------------
  // 5. Module-level classes: `class Foo:` / `class Foo(Base):`
  // ------------------------------------------------------------------
  for (const m of content.matchAll(RE_CLASS)) {
    const line = lineOf(m.index);
    const name = m[1];
    slices.push({
      kind: 'class',
      name,
      file: filePath,
      line,
      endLine: line,
      exported: isExported(name),
      isNested: false,
      fidelity: FIDELITY,
    });
  }

  // ------------------------------------------------------------------
  // 6. SCREAMING_SNAKE_CASE constants
  // ------------------------------------------------------------------
  for (const m of content.matchAll(RE_CONSTANT)) {
    const line = lineOf(m.index);
    const name = m[1];
    slices.push({
      kind: 'export',
      name,
      file: filePath,
      line,
      endLine: line,
      exported: true,
      isNested: false,
      fidelity: FIDELITY,
    });
  }

  // Sort by line ascending for stable output
  slices.sort((a, b) => a.line - b.line);

  return slices;
}
