/**
 * section-extractor.mjs — Extract and parse the ## Session Config KV block.
 *
 * Ported from config-yaml-parser.sh (v2). Used by parseSessionConfig in config.mjs.
 */

// ---------------------------------------------------------------------------
// Section extraction (ported from config-yaml-parser.sh)
// ---------------------------------------------------------------------------

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

    if (line === '## Session Config') {
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
      // Format 2: key: value (key starts with letter, rest alphanum/hyphen/underscore)
      const fmt2 = line.match(/^\s*([a-zA-Z][a-zA-Z0-9_-]+):\s+(.*)/);
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
