/**
 * transcript-history.mjs — Read-only inspection of the Claude Code transcript JSONL.
 *
 * Part of issue #519 ("gsd Pattern Adoption Quick-Wins", archived in the
 * private Meta-Vault, Pattern 3: gh-templates-first PreToolUse hook). Other
 * hooks call into this helper to answer "did the coordinator already Read a
 * matching template path during this session?".
 *
 * Schema reference (Claude Code hook contract): each PreToolUse stdin payload
 * carries a `transcript_path` field pointing at a JSONL file. Each line is one
 * record; assistant tool calls appear as:
 *
 *   { type: "assistant",
 *     message: { content: [ { type: "tool_use", name: "Read",
 *                             input: { file_path: "<abs path>" } }, ... ] } }
 *
 * We only ever read, never write. Failure (missing file, malformed JSON, no
 * permission) returns false — the caller is responsible for deciding whether
 * "no evidence of prior Read" should block or pass. The default-deny semantics
 * for the templates-first hook live in the caller, not here.
 *
 * No external dependencies — Node 20+ stdlib only.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Cap on transcript bytes read. A long session can grow to several MB; we
 * cap at 16 MiB to keep the hook hot-path bounded. Records older than this
 * cap will simply not be inspected — acceptable trade-off because a Read
 * relevant to the current `gh/glab create` is almost certainly recent.
 */
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

/**
 * Cap on simultaneous match attempts per pattern. Patterns are matched as
 * substrings, and the caller passes a small fixed list — but if a pathological
 * caller passed thousands of patterns we still keep work bounded.
 */
const MAX_PATTERNS = 64;

/**
 * Check whether the absolute path `filePath` appears to match the
 * pattern. Patterns are interpreted as substrings of the file path, with
 * one carve-out: a trailing slash means "directory match" — any path that
 * contains the pattern (sans trailing slash) followed by a path separator
 * counts as a hit, but the bare pattern alone does not.
 *
 * Examples:
 *   matchPathPattern("/repo/.github/PULL_REQUEST_TEMPLATE.md",
 *                    ".github/PULL_REQUEST_TEMPLATE.md") -> true
 *   matchPathPattern("/repo/.github/ISSUE_TEMPLATE/bug.md",
 *                    ".github/ISSUE_TEMPLATE/") -> true
 *   matchPathPattern("/repo/.github/ISSUE_TEMPLATE",
 *                    ".github/ISSUE_TEMPLATE/") -> false (no child)
 *   matchPathPattern("/repo/.github/ISSUE_TEMPLATE",
 *                    ".github/ISSUE_TEMPLATE") -> true (substring fallback)
 *
 * @param {string} filePath  Absolute or relative path observed in transcript
 * @param {string} pattern   Pattern from policy template_paths[]
 * @returns {boolean}
 */
export function matchPathPattern(filePath, pattern) {
  if (typeof filePath !== 'string' || typeof pattern !== 'string') return false;
  if (filePath.length === 0 || pattern.length === 0) return false;

  // Normalise both sides to POSIX-style separators for substring matching.
  // We don't resolve symlinks or canonicalise — fuzzy substring match is
  // intentional so that the policy file stays portable.
  const norm = (s) => s.replace(/\\/g, '/');
  const haystack = norm(filePath);
  const needle = norm(pattern);

  // Directory-style pattern (trailing slash): require pattern (sans slash)
  // followed by a separator somewhere in the path.
  if (needle.endsWith('/')) {
    const stem = needle.slice(0, -1);
    // Must appear with a path-separator before AND after, OR at start of path.
    const idx = haystack.indexOf(stem + '/');
    return idx !== -1;
  }

  // Plain substring match.
  return haystack.includes(needle);
}

/**
 * Extract every file_path value from `Read` tool_use entries in a single
 * transcript record (parsed JSON object). Returns an empty array when the
 * record contains no Read tool_use.
 *
 * @param {object} record  Parsed JSON object from one JSONL line
 * @returns {string[]}
 */
export function extractReadFilePaths(record) {
  if (!record || typeof record !== 'object') return [];
  // Only assistant records carry tool_use entries we care about.
  if (record.type !== 'assistant') return [];
  const msg = record.message;
  if (!msg || typeof msg !== 'object') return [];
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const paths = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_use') continue;
    if (block.name !== 'Read') continue;
    const fp = block.input?.file_path;
    if (typeof fp === 'string' && fp.length > 0) paths.push(fp);
  }
  return paths;
}

/**
 * Read the transcript JSONL file and return true when at least one prior
 * `Read` tool call's `file_path` matches any of `pathPatterns`.
 *
 * Fail-safe semantics: on any error (missing transcript, unreadable file,
 * malformed JSON line, etc.) the function returns false. The caller's hook
 * then treats absence-of-evidence as the default-deny path. This is the
 * correct safety posture for templates-first: when we cannot prove the
 * coordinator has read a template, we should not let an unguarded
 * `gh/glab create` through.
 *
 * @param {string[]} pathPatterns  Patterns from templates-policy.json
 * @param {string} transcriptPath  Absolute path to the session JSONL
 * @returns {Promise<{ matched: boolean, matchedPath: string|null }>}
 */
export async function hasReadInSession(pathPatterns, transcriptPath) {
  if (!Array.isArray(pathPatterns) || pathPatterns.length === 0) {
    return { matched: false, matchedPath: null };
  }
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return { matched: false, matchedPath: null };
  }
  if (!existsSync(transcriptPath)) {
    return { matched: false, matchedPath: null };
  }

  // Cap pattern list defensively.
  const patterns = pathPatterns.slice(0, MAX_PATTERNS).filter(
    (p) => typeof p === 'string' && p.length > 0,
  );
  if (patterns.length === 0) {
    return { matched: false, matchedPath: null };
  }

  let raw;
  try {
    raw = await readFile(transcriptPath, 'utf8');
  } catch {
    return { matched: false, matchedPath: null };
  }

  if (raw.length > MAX_TRANSCRIPT_BYTES) {
    // Inspect only the trailing slice — the most recent records are the
    // ones a templates-Read is likely to live in. Splitting at the next
    // newline ensures we don't start mid-record.
    const sliced = raw.slice(raw.length - MAX_TRANSCRIPT_BYTES);
    const nlIdx = sliced.indexOf('\n');
    raw = nlIdx === -1 ? sliced : sliced.slice(nlIdx + 1);
  }

  // Iterate line-by-line. Use split rather than readline streaming because
  // 16 MiB is small enough to hold in memory comfortably and avoids
  // dangling-handle issues on hook subprocess teardown.
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      // Skip malformed lines — partial writes from in-flight tool calls.
      continue;
    }
    const filePaths = extractReadFilePaths(record);
    if (filePaths.length === 0) continue;

    for (const fp of filePaths) {
      for (const pat of patterns) {
        if (matchPathPattern(fp, pat)) {
          return { matched: true, matchedPath: fp };
        }
      }
    }
  }

  return { matched: false, matchedPath: null };
}

/**
 * Convenience: return only the boolean. Useful for hot-path callers that
 * do not need the matched path. Falls through to hasReadInSession().
 *
 * @param {string[]} pathPatterns
 * @param {string} transcriptPath
 * @returns {Promise<boolean>}
 */
export async function hasReadInSessionBool(pathPatterns, transcriptPath) {
  const { matched } = await hasReadInSession(pathPatterns, transcriptPath);
  return matched;
}

// Re-export the path module's join so test fixtures can build platform-
// safe paths without re-importing 'node:path'. Not part of the public API
// contract — purely a convenience.
export const _join = path.join;
