/**
 * utils.mjs — Shared utilities for vault-mirror (Issue #283 split).
 *
 * Exports: subjectToSlug, isValidSlug, uuidPrefix8, toDate,
 *          truncateAtWord, yamlQuoteIfNeeded, parseFrontmatter
 */

/**
 * Convert a subject string to a kebab slug.
 * - If subject contains slashes, collapse to last path segment.
 * - Replace dots and underscores with hyphens.
 * - Strip all non-[a-z0-9-] chars.
 * - Collapse consecutive hyphens.
 * - Trim leading/trailing hyphens.
 */
export function subjectToSlug(subject) {
  let s = subject;

  // Collapse slash paths to last segment
  if (s.includes('/')) {
    const parts = s.split('/').filter(Boolean);
    s = parts[parts.length - 1];
  }

  // Normalise: lowercase, dots/underscores → hyphens, strip invalid chars
  s = s
    .toLowerCase()
    .replace(/[._]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return s;
}

const slugRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSlug(s) {
  return slugRegex.test(s);
}

/** Derive the first 8 chars of a UUID (strip hyphens, take first 8 hex chars). */
export function uuidPrefix8(id) {
  return id.replace(/-/g, '').slice(0, 8);
}

/** Format a UTC ISO date string as YYYY-MM-DD. */
export function toDate(isoString) {
  if (!isoString) return '';
  return isoString.slice(0, 10);
}

/** Truncate a string to maxLen chars, ending at a word boundary. */
export function truncateAtWord(str, maxLen) {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(' ');
  return lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
}

/** Determine if a YAML title value needs quoting (contains : # \ or starts with -). */
export function yamlQuoteIfNeeded(value) {
  if (/[:#{}[\],&*?|<>=!%@`\\]/.test(value) || value.startsWith('-') || value.startsWith('"')) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}

// ── Frontmatter parser (minimal — only reads the opening --- block) ───────────

export function parseFrontmatter(content) {
  if (!content.startsWith('---')) return null;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return null;
  const block = content.slice(3, end).trim();
  const result = {};
  for (const line of block.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
