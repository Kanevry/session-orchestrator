#!/usr/bin/env node
/**
 * vault-relocation-rules.mjs — Pure classifier/rules layer for vault flat-corpus relocation.
 *
 * Classifies vault notes (sessions + learnings) into per-repo namespace buckets for
 * the "relocate flat corpus" operation (Issue #700 vault namespacing phase-2).
 *
 * This module is PURE: no `fs`, no `child_process`, no `process.cwd()`, no network.
 * All I/O lives in the C2 CLI module (relocate-vault-corpus.mjs).
 * EXCEPTION: loadVaultRelocationRules uses fs.existsSync/readFileSync to load the
 * optional operator config YAML — mirroring vault-migration-rules.mjs exactly.
 *
 * Schema (schema-version: 1):
 *
 *   schema-version: 1
 *   fallback-bucket: _unsorted     # default namespace when repo cannot be derived
 *   learnings-root: 40-learnings   # vault subdirectory for learning notes
 *   sessions-root: 50-sessions     # vault subdirectory for session notes
 *
 * Path: ~/.config/session-orchestrator/vault-relocation-rules.yaml
 *       (same per-user location convention as vault-migration-rules.yaml)
 *
 * Classification logic:
 *   SESSIONS: source-repo: frontmatter → resolveRepoNamespace({ vaultName: lastPathSegment(source-repo) })
 *             OR repo: frontmatter → resolveRepoNamespace({ vaultName: lastPathSegment(repo) })
 *             OR project/<slug> tag → resolveRepoNamespace({ vaultName: slug })
 *             OR fallback → _unsorted
 *   LEARNINGS: project: wikilink → resolveRepoNamespace({ vaultName: slug })
 *              source: free-text → resolveRepoNamespace({ vaultName: lastPathSegment })
 *              source_session: wikilink → look up in sessionRepoIndex
 *              OR fallback → _unsorted
 *
 * Security: every derived repo value MUST route through resolveRepoNamespace
 * for CP1/CP6/CP10 leak-guard. Files with NO derivable repo → '_unsorted'
 * (do NOT call resolveRepoNamespace with CWD-derived values for historical files).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import { resolveRepoNamespace } from './vault-mirror/namespace.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const VAULT_RELOCATION_RULES_PATH = join(
  homedir(),
  '.config',
  'session-orchestrator',
  'vault-relocation-rules.yaml',
);

// ---------------------------------------------------------------------------
// Test seam — mirrors _setSegmentsForTest pattern in migrate-vault-paths.mjs
// ---------------------------------------------------------------------------

/** @type {(opts: { vaultName: string | null }) => string} */
let _resolveNamespace = resolveRepoNamespace;

/**
 * Inject a custom namespace resolver for testing. Returns the previous resolver
 * so tests can restore it after each case.
 *
 * @param {(opts: { vaultName: string | null }) => string} fn
 * @returns {(opts: { vaultName: string | null }) => string}
 */
export function _setResolverForTest(fn) {
  const prev = _resolveNamespace;
  _resolveNamespace = fn;
  return prev;
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

/**
 * Return the default config shape — used when the YAML file does not exist
 * or fails to parse.
 *
 * @returns {{ fallbackBucket: string, learningsRoot: string, sessionsRoot: string }}
 */
export function getDefaults() {
  return {
    fallbackBucket: '_unsorted',
    learningsRoot: '40-learnings',
    sessionsRoot: '50-sessions',
  };
}

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------

/**
 * Load and validate the vault-relocation-rules config. Pure, never throws.
 *
 * @param {string} [filePath] - override for the default path (testing only)
 * @returns {{ config: ReturnType<typeof getDefaults>, source: 'file'|'defaults', errors: string[] }}
 */
export function loadVaultRelocationRules(filePath = VAULT_RELOCATION_RULES_PATH) {
  if (!existsSync(filePath)) {
    return { config: getDefaults(), source: 'defaults', errors: [] };
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      config: getDefaults(),
      source: 'defaults',
      errors: [`failed to read vault-relocation-rules.yaml: ${err.message}`],
    };
  }

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      config: getDefaults(),
      source: 'defaults',
      errors: [`failed to parse vault-relocation-rules.yaml: ${err.message}`],
    };
  }

  const { config, errors } = normalizeConfig(parsed);
  return { config, source: errors.length === 0 ? 'file' : 'defaults', errors };
}

// ---------------------------------------------------------------------------
// Internal: config normalization
// ---------------------------------------------------------------------------

/**
 * @param {unknown} obj
 * @returns {{ config: ReturnType<typeof getDefaults>, errors: string[] }}
 */
function normalizeConfig(obj) {
  const errors = [];
  const config = getDefaults();

  if (!isPlainObject(obj)) {
    return { config, errors: ['config must be a YAML mapping'] };
  }

  if (obj['fallback-bucket'] !== undefined) {
    if (typeof obj['fallback-bucket'] !== 'string') {
      errors.push('fallback-bucket must be a string');
    } else {
      config.fallbackBucket = obj['fallback-bucket'];
    }
  }

  if (obj['learnings-root'] !== undefined) {
    if (typeof obj['learnings-root'] !== 'string') {
      errors.push('learnings-root must be a string');
    } else {
      config.learningsRoot = obj['learnings-root'];
    }
  }

  if (obj['sessions-root'] !== undefined) {
    if (typeof obj['sessions-root'] !== 'string') {
      errors.push('sessions-root must be a string');
    } else {
      config.sessionsRoot = obj['sessions-root'];
    }
  }

  return { config, errors };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Parse the opening YAML frontmatter block of a vault note, extracting the
 * fields relevant to relocation classification: type, source-repo, repo, source,
 * project, source_session, tags, id.
 *
 * Handles both scalar values and simple YAML arrays (block-sequence `- item`
 * syntax). The existing parseFrontmatter from utils.mjs only handles scalars
 * and does not parse block-sequence arrays — tags are always arrays, so we
 * need this extended version.
 *
 * @param {string} content - raw file content
 * @returns {object} - parsed frontmatter fields (empty object if no block found)
 */
export function parseRelocationFrontmatter(content) {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const block = content.slice(3, end);
  const result = {};

  let currentKey = null;
  let currentArrayMode = false;

  for (const rawLine of block.split('\n')) {
    // Skip blank lines
    if (rawLine.trim() === '') {
      if (currentArrayMode && currentKey !== null) {
        // blank line ends a block sequence
        currentArrayMode = false;
        currentKey = null;
      }
      continue;
    }

    // Detect block-sequence items: lines starting with optional whitespace then '- '
    const arrayItemMatch = rawLine.match(/^\s+-\s+(.*)$/);
    if (arrayItemMatch && currentArrayMode && currentKey !== null) {
      const itemVal = stripQuotes(arrayItemMatch[1].trim());
      if (!Array.isArray(result[currentKey])) {
        result[currentKey] = [];
      }
      result[currentKey].push(itemVal);
      continue;
    }

    // If we encounter a non-array-item line while in array mode, end array mode
    if (currentArrayMode) {
      currentArrayMode = false;
      currentKey = null;
    }

    // Check for inline array: key: [a, b, c]
    const colonIdx = rawLine.indexOf(':');
    if (colonIdx === -1) continue;

    const key = rawLine.slice(0, colonIdx).trim();
    const rest = rawLine.slice(colonIdx + 1).trim();

    if (!key) continue;

    // Inline array: key: [item1, item2]
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1);
      result[key] = inner
        .split(',')
        .map((s) => stripQuotes(s.trim()))
        .filter((s) => s !== '');
      currentArrayMode = false;
      currentKey = null;
      continue;
    }

    // Block-sequence start: key: (empty value), next lines are '- item'
    if (rest === '') {
      currentKey = key;
      currentArrayMode = true;
      // Initialize as array (will be populated by subsequent '- item' lines)
      result[key] = [];
      continue;
    }

    // Scalar value
    result[key] = stripQuotes(rest);
    currentArrayMode = false;
    currentKey = null;
  }

  return result;
}

/**
 * Strip surrounding single or double quotes from a YAML scalar string value.
 *
 * @param {string} s
 * @returns {string}
 */
function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Collapse a slash-separated path to its last segment.
 * 'org/SomeRepo' → 'SomeRepo'
 *
 * @param {string} value
 * @returns {string}
 */
function lastPathSegment(value) {
  if (!value || !value.includes('/')) return value || '';
  const parts = value.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/**
 * Strip Obsidian wikilink syntax from a YAML value.
 * '"[[main-2026-06-19-session-1]]"' → 'main-2026-06-19-session-1'
 * '[[some-session]]' → 'some-session'
 *
 * @param {string} value
 * @returns {string}
 */
function stripWikilink(value) {
  if (!value) return '';
  // Strip surrounding quotes first
  const unquoted = stripQuotes(value.trim());
  // Match [[...]] and extract content
  const match = unquoted.match(/^\[\[(.+?)(?:\|[^\]]+)?\]\]$/);
  if (match) return match[1].trim();
  return unquoted;
}

/**
 * Find a `project/<slug>` tag in a tags array and return the slug, or null.
 *
 * @param {string[] | string | undefined} tags
 * @returns {string | null}
 */
function projectTag(tags) {
  if (!tags) return null;
  const arr = Array.isArray(tags) ? tags : [String(tags)];
  for (const tag of arr) {
    const trimmed = String(tag).trim();
    const m = trimmed.match(/^project\/(.+)$/i);
    if (m) return m[1].trim();
  }
  return null;
}

/**
 * Resolve a repo-like frontmatter value through the same leak-guarded namespace
 * path used for vault mirror writes. Degenerate values fall through so an empty
 * vaultName can never trigger CWD-derived attribution.
 *
 * @param {unknown} value
 * @param {'source-repo' | 'repo'} source
 * @returns {{ namespace: string, source: 'source-repo' | 'repo' } | null}
 */
function namespaceFromRepoSignal(value, source) {
  if (!value || typeof value !== 'string' || !value.trim()) return null;
  const seg = lastPathSegment(value.trim());
  if (!seg) return null;
  const namespace = _resolveNamespace({ vaultName: seg });
  return { namespace, source };
}

// ---------------------------------------------------------------------------
// Classification: sessions
// ---------------------------------------------------------------------------

/**
 * Derive the namespace for a session note.
 *
 * Priority:
 *   1. source-repo: frontmatter → resolveRepoNamespace({ vaultName: lastPathSegment(source-repo) })
 *   2. repo: frontmatter field  → resolveRepoNamespace({ vaultName: lastPathSegment(repo) })
 *   3. project/<slug> tag       → resolveRepoNamespace({ vaultName: slug })
 *   4. backfill index match     → entry.repo (ALREADY leak-guarded by backfill module)
 *   5. fallback                 → '_unsorted'
 *
 * The optional backfill index (W1-D5, Issue #700) supplies a repo for historical
 * sessions whose frontmatter carries NO in-file repo signal. Its entries are
 * ALREADY leak-guarded by the backfill module, so the matched repo is returned
 * verbatim — it MUST NOT be re-resolved through _resolveNamespace (re-resolving a
 * pre-guarded value risks a CWD-derive on a slug that no longer round-trips).
 * Backward-compat: `opts` defaults to `{}`, so all existing 1-arg call-sites are
 * unaffected and the branch is inert unless a backfillIndex is explicitly passed.
 *
 * @param {object} frontmatter
 * @param {{ backfillIndex?: Map<string, { repo: string, confidence: string, source: string }> }} [opts]
 * @returns {{ namespace: string, source: 'source-repo' | 'repo' | 'project-tag' | 'backfill' | 'fallback' }}
 */
export function namespaceForSession(frontmatter, opts = {}) {
  const sourceRepoResult = namespaceFromRepoSignal(frontmatter['source-repo'], 'source-repo');
  if (sourceRepoResult) return sourceRepoResult;

  const repoResult = namespaceFromRepoSignal(frontmatter.repo, 'repo');
  if (repoResult) return repoResult;

  const tagSlug = projectTag(frontmatter.tags);
  if (tagSlug) {
    const seg = lastPathSegment(tagSlug);
    if (seg) {
      const namespace = _resolveNamespace({ vaultName: seg });
      return { namespace, source: 'project-tag' };
    }
  }

  // Backfill index — consulted ONLY when the in-file signals above are absent.
  // The matched entry's repo is already leak-guarded by the backfill module, so
  // it is returned as-is (no _resolveNamespace re-resolution). A 'SKIP' confidence
  // means the backfill module could not confidently attribute a repo — fall through.
  const backfillIndex = opts.backfillIndex;
  if (backfillIndex && frontmatter.id) {
    const entry = backfillIndex.get(frontmatter.id);
    if (entry && entry.confidence !== 'SKIP') {
      return { namespace: entry.repo, source: 'backfill' };
    }
  }

  return { namespace: '_unsorted', source: 'fallback' };
}

// ---------------------------------------------------------------------------
// Classification: learnings
// ---------------------------------------------------------------------------

/**
 * Derive the namespace for a learning note.
 *
 * Priority:
 *   1. project: wikilink         → resolveRepoNamespace({ vaultName: lastPathSegment(slug) })
 *   2. source: free-text         → resolveRepoNamespace({ vaultName: lastPathSegment(source) })
 *   3. source_session: wikilink  → look up sessionId in sessionRepoIndex
 *   4. fallback                  → '_unsorted'
 *
 * @param {object} frontmatter
 * @param {Map<string, string>} sessionRepoIndex - Map<sessionId, namespace>
 * @returns {{ namespace: string, source: 'project' | 'source' | 'transitive' | 'fallback' }}
 */
export function namespaceForLearning(frontmatter, sessionRepoIndex) {
  // 1. project: wikilink (e.g. "[[01-projects/session-orchestrator]]")
  const project = frontmatter.project;
  if (project && typeof project === 'string' && project.trim()) {
    const raw = stripWikilink(project.trim());
    if (raw) {
      const seg = lastPathSegment(raw);
      // Degenerate-input guard (see namespaceForSession) — empty seg would
      // CWD-derive via deriveRepo(); fall through to the next signal instead.
      if (seg) {
        const namespace = _resolveNamespace({ vaultName: seg });
        return { namespace, source: 'project' };
      }
    }
  }

  // 2. source: free-text (e.g. "org/some-module ...")
  const source = frontmatter.source;
  if (source && typeof source === 'string' && source.trim()) {
    // Take only the first space-delimited word in case of additional text
    const firstWord = source.trim().split(/\s+/)[0];
    if (firstWord) {
      const seg = lastPathSegment(firstWord);
      if (seg) {
        const namespace = _resolveNamespace({ vaultName: seg });
        return { namespace, source: 'source' };
      }
    }
  }

  // 3. source_session: wikilink → look up in index
  const sourceSession = frontmatter.source_session;
  if (sourceSession && typeof sourceSession === 'string' && sourceSession.trim()) {
    const sessionId = stripWikilink(sourceSession.trim());
    if (sessionId && sessionRepoIndex.has(sessionId)) {
      const namespace = sessionRepoIndex.get(sessionId);
      return { namespace: namespace ?? '_unsorted', source: 'transitive' };
    }
  }

  // 4. Fallback
  return { namespace: '_unsorted', source: 'fallback' };
}

// ---------------------------------------------------------------------------
// Unified classifier
// ---------------------------------------------------------------------------

/**
 * Classify a vault note (session or learning) into its target namespace.
 *
 * Dispatches on frontmatter.type ('session' | 'learning').
 *
 * The optional backfillIndex (Issue #700) is forwarded to namespaceForSession so
 * historical sessions with no in-file repo signal can still be attributed. It is
 * absent-tolerant: when omitted, classification is byte-identical to prior behaviour.
 *
 * @param {{ frontmatter: object, sessionRepoIndex: Map<string, string>, backfillIndex?: Map<string, { repo: string, confidence: string, source: string }> }} opts
 * @returns {{ namespace: string, source: string, confident: boolean }}
 */
export function classifyOwner({ frontmatter, sessionRepoIndex, backfillIndex }) {
  const type = String(frontmatter.type ?? '').trim().toLowerCase();

  let result;
  if (type === 'session') {
    result = namespaceForSession(frontmatter, { backfillIndex });
  } else if (type === 'learning') {
    result = namespaceForLearning(frontmatter, sessionRepoIndex);
  } else {
    // Unknown type — fall back
    result = { namespace: '_unsorted', source: 'fallback' };
  }

  return { ...result, confident: isConfident(result.namespace) };
}

// ---------------------------------------------------------------------------
// Utility: confidence
// ---------------------------------------------------------------------------

/**
 * Returns true when the namespace is a specific, actionable repo slug.
 * False for sentinel values that indicate "could not determine" or "redacted".
 *
 * @param {string} namespace
 * @returns {boolean}
 */
export function isConfident(namespace) {
  return namespace !== '_unsorted' && namespace !== 'redacted-repo' && namespace !== 'unknown-repo';
}

// ---------------------------------------------------------------------------
// Utility: destination path computation
// ---------------------------------------------------------------------------

/**
 * Compute the target POSIX path for a relocated vault note.
 *
 * @param {{ basename: string, root: string, namespace: string }} opts
 * @returns {string} - e.g. '40-learnings/session-orchestrator/2026-06-21-note.md'
 */
export function computeDest({ basename, root, namespace }) {
  return `${root}/${namespace}/${basename}`;
}

// ---------------------------------------------------------------------------
// Utility: already-namespaced guard
// ---------------------------------------------------------------------------

/**
 * Returns true if the relative vault path already includes a subdirectory
 * (i.e. has been previously relocated into a per-repo namespace folder).
 *
 * 'foo/bar.md'  → true  (already in a subfolder)
 * 'bar.md'      → false (flat, top-level file)
 *
 * @param {string} relPath
 * @returns {boolean}
 */
export function isAlreadyNamespaced(relPath) {
  return relPath.includes('/');
}
