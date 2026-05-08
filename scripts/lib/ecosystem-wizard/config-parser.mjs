/**
 * config-parser.mjs — pure parsing utilities for comma-separated user input.
 * Converts raw wizard answer strings into typed endpoint/pipeline/label arrays.
 */

/**
 * Parses a comma-separated string into a trimmed array, filtering empty items.
 * @param {string} input
 * @returns {string[]}
 */
export function parseCommaSeparated(input) {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses endpoint input lines. Format: "Name|URL" per entry, separated by commas.
 * @param {string} input
 * @returns {Array<{name: string, url: string}>}
 */
export function parseEndpoints(input) {
  return parseCommaSeparated(input)
    .map((entry) => {
      const pipe = entry.indexOf('|');
      if (pipe === -1) return null;
      const name = entry.slice(0, pipe).trim();
      const url = entry.slice(pipe + 1).trim();
      if (!name || !url) return null;
      return { name, url };
    })
    .filter(Boolean);
}

/**
 * Parses pipeline input lines. Format: "id" or "id:label" per entry.
 * @param {string} input
 * @returns {Array<{id: string, label?: string}>}
 */
export function parsePipelines(input) {
  return parseCommaSeparated(input)
    .map((entry) => {
      const colon = entry.indexOf(':');
      if (colon === -1) {
        return entry.trim() ? { id: entry.trim() } : null;
      }
      const id = entry.slice(0, colon).trim();
      const label = entry.slice(colon + 1).trim();
      if (!id) return null;
      return label ? { id, label } : { id };
    })
    .filter(Boolean);
}
