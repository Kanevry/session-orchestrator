/**
 * language-mappers/index.mjs — Entry point for semantic slice extraction.
 *
 * Dispatches to language-specific mappers based on file extension or an
 * explicit `options.language` override.  Phase 1 supports TypeScript/JS and
 * Markdown; Phase 2 will add Swift and Python (filed as follow-up issue).
 *
 * Part of the Clawpatch Borrow Cluster (issue #416).
 */

import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Every possible kind value that a SemanticSlice may carry.
 * Consumers should treat this as a closed enum for Phase 1.
 * @type {readonly string[]}
 */
export const SLICE_KINDS = Object.freeze([
  'function',
  'class',
  'interface',
  'type',
  'export',
  'section',
]);

/**
 * Map from normalised file extension to language key.
 * @type {Record<string, string>}
 */
const EXT_TO_LANG = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.md': 'md',
  '.mdx': 'md',
  '.swift': 'swift',
  '.py': 'py',
};

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Derive the language key from a file path.
 *
 * @param {string} filePath
 * @returns {'ts'|'js'|'md'|'swift'|'py'|null}
 */
export function languageFromPath(filePath) {
  if (typeof filePath !== 'string') return null;
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

// ---------------------------------------------------------------------------
// Core dispatcher (W3-Q2 MED-005: per-process mapper cache)
// ---------------------------------------------------------------------------

let tsMapperPromise = null;
let mdMapperPromise = null;
let swiftMapperPromise = null;
let pyMapperPromise = null;

function loadTsMapper() {
  if (tsMapperPromise === null) {
    tsMapperPromise = import('./typescript.mjs').then((m) => m.extractTypeScriptSlices);
  }
  return tsMapperPromise;
}

function loadMdMapper() {
  if (mdMapperPromise === null) {
    mdMapperPromise = import('./markdown.mjs').then((m) => m.extractMarkdownSlices);
  }
  return mdMapperPromise;
}

function loadSwiftMapper() {
  if (swiftMapperPromise === null) {
    swiftMapperPromise = import('./swift.mjs').then((m) => m.extractSwiftSlices);
  }
  return swiftMapperPromise;
}

function loadPyMapper() {
  if (pyMapperPromise === null) {
    pyMapperPromise = import('./python.mjs').then((m) => m.extractPythonSlices);
  }
  return pyMapperPromise;
}

/**
 * Extract semantic slices from `content` for the file at `filePath`.
 *
 * @param {string} filePath   Relative or absolute path — used to derive language
 *                            when `options.language` is not supplied.
 * @param {string} content    Raw text content of the file.
 * @param {{ language?: 'ts'|'js'|'md'|'swift'|'py' }} [options]
 * @returns {Promise<import('./typescript.mjs').SemanticSlice[]>}
 * @throws {Error} When language is unsupported or the underlying parser fails.
 */
export async function extractSemanticSlices(filePath, content, options = {}) {
  if (typeof filePath !== 'string') {
    throw new TypeError('extractSemanticSlices: filePath must be a string');
  }
  if (typeof content !== 'string') {
    throw new TypeError('extractSemanticSlices: content must be a string');
  }

  const lang = options.language ?? languageFromPath(filePath);

  if (lang === 'ts' || lang === 'js') {
    const extract = await loadTsMapper();
    return extract(filePath, content);
  }

  if (lang === 'md') {
    const extract = await loadMdMapper();
    return extract(filePath, content);
  }

  if (lang === 'swift') {
    const extract = await loadSwiftMapper();
    return extract(filePath, content);
  }

  if (lang === 'py') {
    const extract = await loadPyMapper();
    return extract(filePath, content);
  }

  throw new Error(
    `extractSemanticSlices: unsupported language '${lang ?? 'unknown'}' for file '${filePath}'. ` +
      `Supports: .ts, .tsx, .js, .jsx, .mjs, .cjs, .md, .mdx, .swift, .py.`,
  );
}
