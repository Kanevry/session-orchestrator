/**
 * section-extractor.mjs — Extract and parse the ## Session Config KV block.
 *
 * Ported from config-yaml-parser.sh (v2). Used by parseSessionConfig in config.mjs.
 */

// ---------------------------------------------------------------------------
// Section extraction (ported from config-yaml-parser.sh)
// ---------------------------------------------------------------------------

/**
 * THE canonical predicate for "this line opens the `## Session Config` block".
 *
 * Exported (#959 follow-up) because this repo previously carried FIVE
 * independent copies of this fact, and the loosest of them —
 * `scripts/lib/claude-md-budget-lint.mjs` — was the module whose whole job is
 * to MEASURE the block. That asymmetry was not academic: the lint accepted a
 * heading decorated with a trailing HTML comment (`## Session Config <!-- … -->`,
 * a decoration this repo's own convention encourages on sibling headings),
 * while `_extractConfigSection` below rejected it. An author following the
 * cited convention therefore got a CLAUDE.md (or AGENTS.md on Codex CLI —
 * transparent aliases, see skills/_shared/instruction-file-resolution.md)
 * whose every runtime config key
 * silently fell back to its default, while the lint simultaneously reported
 * "148 exempt: '## Session Config'" — the instrument affirming the block is
 * present and runtime-critical at the exact moment the runtime cannot see it.
 *
 * The invariant this export exists to hold: **no consumer's predicate may
 * accept a heading this one rejects.** Importing beats re-deriving; a copy
 * that drifts loose is worse than no check at all.
 *
 * Intentionally EXACT (not a fuzzy regex) apart from CRLF tolerance — it is
 * the literal comparison `_extractConfigSection` has always used, merely
 * given a name. `##  Session Config` (two spaces), a trailing HTML comment,
 * and `## Session Config Convention` are all correctly rejected.
 *
 * Dependency note: this module imports NOTHING. Keep it that way — the budget
 * lint consumes this predicate at bootstrap-scaffold time, before
 * `.claude/rules/` (or most of the repo) exists.
 *
 * @param {string} line - a single line, with or without a trailing '\r'.
 * @returns {boolean}
 */
export function isSessionConfigHeading(line) {
  return typeof line === 'string' && line.replace(/\r$/, '') === '## Session Config';
}

/**
 * Extract the raw ## Session Config block lines from markdown content.
 * - CRLF-tolerant
 * - Skips code fence lines (``` alone on a line)
 * - Strips trailing whitespace from each line
 * @param {string} content
 * @returns {string[]} lines of the Session Config block
 */
export function _extractConfigSection(content) {
  const lines = content.split(/\r?\n/);
  const result = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (isSessionConfigHeading(line)) {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Next ## header closes the section
      if (/^## /.test(line)) break;
      // Skip standalone code fences
      if (line.trim() === '```') continue;
      // Strip trailing whitespace and collect
      result.push(line.replace(/\s+$/, ''));
    }
  }

  return result;
}

/**
 * Parse the key-value pairs from extracted Session Config lines.
 * Supports Format 1: `- **key:** value`
 * Supports Format 2: plain `key: value`
 * Last occurrence of a key wins.
 * @param {string[]} lines
 * @returns {Map<string, string>}
 */
export function _parseKV(lines) {
  // We accumulate all matches, last-match wins per key
  const allPairs = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    let key;
    let value;

    // Format 1: - **key:** value
    const fmt1 = line.match(/^\s*-\s+\*\*([^*:]+):\*\*\s*(.*)/);
    if (fmt1) {
      key = fmt1[1].trim();
      value = fmt1[2].trim();
    } else {
      // Format 2: key: value — supports both plain "key: value" and
      // YAML list-item form "- key: value" (issue #497). Key starts with
      // letter; rest is alphanum/hyphen/underscore.
      const fmt2 = line.match(/^\s*(?:-\s+)?([a-zA-Z][a-zA-Z0-9_-]+):\s+(.*)/);
      if (fmt2) {
        key = fmt2[1].trim();
        value = fmt2[2].trim();
      } else {
        continue;
      }
    }

    if (!key) continue;

    // Strip inline YAML comment (matches block-parser behaviour in _parseVaultSync etc.)
    value = value.replace(/\s+#.*$/, '').trim();

    // Strip surrounding double quotes from value
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }

    allPairs.push([key, value]);
  }

  // Last match wins: build the map by iterating in order
  const kv = new Map();
  for (const [k, v] of allPairs) {
    kv.set(k, v);
  }
  return kv;
}
