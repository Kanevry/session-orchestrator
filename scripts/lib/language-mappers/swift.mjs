/**
 * language-mappers/swift.mjs — Semantic slice extractor for Swift source files.
 *
 * Uses conservative regex patterns anchored to column 0 (^) to detect
 * module-level declarations only.  No Swift parser is available in Node,
 * so this is deliberately under-counting rather than mis-classifying.
 *
 * LIMITATIONS:
 *   - Extension members (extension Foo { func bar() }) are NOT detected;
 *     their declarations do not start at column 0 with the access modifier.
 *   - Multi-line @available or other attribute stacks before a `public func`
 *     are tolerated — the regex matches the line that contains `public func`,
 *     regardless of preceding attributes.
 *   - Generic type parameters are captured as part of the name (e.g.
 *     `func swap<T>` → name 'swap<T>') — downstream consumers should
 *     strip angle-bracket suffixes if needed.
 *   - Inline functions inside closures or nested scopes are not detected
 *     because they are not at column 0.
 *   - `internal`, `private`, `fileprivate` declarations are intentionally
 *     excluded; only `public` and `open` are enumerated.
 *   - endLine equals line (no body tracking in this regex proto).
 *
 * Part of the Clawpatch Borrow Cluster (issue #416), Phase 2.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a 1-based line-number lookup table from content split on '\n'.
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
    // Binary search for the largest lineStart ≤ offset
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

// ---------------------------------------------------------------------------
// Regex patterns (all anchored to column-0 with `m` flag)
// ---------------------------------------------------------------------------

// `import Foundation` / `import UIKit.UIView`
const RE_IMPORT = /^import\s+([\w.]+)/gm;

// `@_exported import ModuleName`
const RE_REEXPORT = /^@_exported\s+import\s+([\w.]+)/gm;

// `public func foo` / `open func foo` / `public static func foo` / `open static func foo`
// Captures function name including optional generic params up to '(' or '<'
const RE_PUBLIC_FUNC = /^(?:public|open)\s+(?:(?:static|class|mutating|override)\s+)*func\s+([\w<>]+)/gm;

// `public class Foo` / `open struct Foo` / `public final class Foo` / `public actor Foo`
// class/struct/actor all map to kind:'class'; enum maps to kind:'type'
const RE_PUBLIC_TYPE_CLASS = /^(?:public|open)\s+(?:(?:final|indirect|frozen)\s+)*(?:class|struct|actor)\s+(\w+)/gm;
const RE_PUBLIC_TYPE_ENUM = /^(?:public|open)\s+(?:(?:indirect|frozen)\s+)*enum\s+(\w+)/gm;

// `public let/var foo` / `open static var foo`
const RE_PUBLIC_VAR = /^(?:public|open)\s+(?:(?:static|lazy|class|override)\s+)*(?:let|var)\s+(\w+)/gm;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract semantic slices from Swift source code.
 *
 * @param {string} filePath   Source file path (used only for the slice `file` field).
 * @param {string} content    Raw Swift source text.
 * @returns {Promise<import('./typescript.mjs').SemanticSlice[]>}
 */
export async function extractSwiftSlices(filePath, content) {
  if (!content.trim()) return [];

  /** @type {import('./typescript.mjs').SemanticSlice[]} */
  const slices = [];
  const lineOf = makeLineResolver(content);

  // Imports → kind:'export', exported:false (same convention as imports in
  // other mappers — they expose a module dependency, not a public API symbol)
  for (const m of content.matchAll(RE_IMPORT)) {
    // Skip lines that are actually @_exported (caught separately below)
    const lineText = content.slice(
      content.lastIndexOf('\n', m.index) + 1,
      content.indexOf('\n', m.index) === -1 ? content.length : content.indexOf('\n', m.index),
    );
    if (lineText.trimStart().startsWith('@_exported')) continue;

    const line = lineOf(m.index);
    slices.push({
      kind: 'export',
      name: m[1],
      file: filePath,
      line,
      endLine: line,
      exported: false,
      isNested: false,
    });
  }

  // @_exported imports → kind:'export', exported:true (re-exports to consumers)
  for (const m of content.matchAll(RE_REEXPORT)) {
    const line = lineOf(m.index);
    slices.push({
      kind: 'export',
      name: m[1],
      file: filePath,
      line,
      endLine: line,
      exported: true,
      isNested: false,
    });
  }

  // Public/open functions → kind:'function', exported:true
  for (const m of content.matchAll(RE_PUBLIC_FUNC)) {
    const line = lineOf(m.index);
    slices.push({
      kind: 'function',
      name: m[1],
      file: filePath,
      line,
      endLine: line,
      exported: true,
      isNested: false,
    });
  }

  // Public/open class, struct, actor → kind:'class', exported:true
  for (const m of content.matchAll(RE_PUBLIC_TYPE_CLASS)) {
    const line = lineOf(m.index);
    slices.push({
      kind: 'class',
      name: m[1],
      file: filePath,
      line,
      endLine: line,
      exported: true,
      isNested: false,
    });
  }

  // Public/open enum → kind:'type', exported:true
  for (const m of content.matchAll(RE_PUBLIC_TYPE_ENUM)) {
    const line = lineOf(m.index);
    slices.push({
      kind: 'type',
      name: m[1],
      file: filePath,
      line,
      endLine: line,
      exported: true,
      isNested: false,
    });
  }

  // Public/open let/var → kind:'export', exported:true (public API properties)
  for (const m of content.matchAll(RE_PUBLIC_VAR)) {
    const line = lineOf(m.index);
    slices.push({
      kind: 'export',
      name: m[1],
      file: filePath,
      line,
      endLine: line,
      exported: true,
      isNested: false,
    });
  }

  // Sort by line ascending for stable output
  slices.sort((a, b) => a.line - b.line);

  return slices;
}
