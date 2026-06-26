/**
 * utils.mjs — Shared utilities for vault-mirror (Issue #283 split).
 *
 * Exports: subjectToSlug, isValidSlug, uuidPrefix8, toDate,
 *          truncateAtWord, yamlQuoteIfNeeded, parseFrontmatter,
 *          slugifyTagSegment, buildTag, slugifyIdSafe, TAG_MAX_LENGTH,
 *          resolveSourceSessionLink
 */

import { parseSessionId } from '../session-id.mjs';

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

/**
 * Max length of a single vault tag string. Mirrors the authoritative
 * vaultFrontmatterSchema (`tags[].max(64)` in skills/vault-sync/validator.mjs).
 */
export const TAG_MAX_LENGTH = 64;

/**
 * Slugify ONE tag segment to a kebab slug matching the schema's per-segment
 * regex (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`).
 *
 * Unlike {@link subjectToSlug}, this does NOT collapse slashes — callers pass a
 * single segment at a time so {@link buildTag} can preserve the `/`-separated
 * tag hierarchy. Whitespace, dots and underscores become hyphens (so
 * "Deep Mode" → "deep-mode"); all other non-`[a-z0-9-]` chars are stripped. An
 * empty result falls back to "unknown" so the enclosing tag never contains an
 * empty `/`-segment (which would violate tagPathRegex).
 *
 * @param {string} input
 * @returns {string}
 */
export function slugifyTagSegment(input) {
  const slug = String(input ?? '')
    .toLowerCase()
    .replace(/[\s._]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unknown';
}

/**
 * Build a schema-valid vault tag from path segments (#602). Each segment is
 * kebab-slugified (preserving the `/`-separated hierarchy), and the joined tag
 * is capped at {@link TAG_MAX_LENGTH} characters. When truncation lands on a
 * separator or hyphen, the trailing char is removed so the result still matches
 * the schema's tagPathRegex.
 *
 * @param {Array<string>|string} segments
 * @returns {string}
 */
export function buildTag(segments) {
  const slugged = (Array.isArray(segments) ? segments : [segments]).map((s) =>
    slugifyTagSegment(s),
  );
  if (slugged.length === 0) return 'unknown';
  let tag = slugged.join('/');
  if (tag.length > TAG_MAX_LENGTH) {
    // Trim to the cap, then strip any trailing separator/hyphen exposed by the
    // cut so the tail segment stays a valid kebab slug.
    tag = tag.slice(0, TAG_MAX_LENGTH).replace(/[/-]+$/, '');
  }
  return tag;
}

/**
 * Slugify a value for use as a vault note `id` (#602), guaranteeing the
 * schema's kebab + min-length-2 contract. Returns null when no usable slug
 * remains (caller treats this as an invalid entry).
 *
 * @param {string} input
 * @returns {string|null}
 */
export function slugifyIdSafe(input) {
  // Normalise whitespace to hyphens first (so "My ID" → "my-id" rather than
  // "myid"), then delegate to subjectToSlug for the rest of the kebab contract.
  const normalised = String(input ?? '').replace(/\s+/g, '-');
  const slug = subjectToSlug(normalised);
  if (!slug) return null;
  // Schema requires min length 2; pad a single-char slug deterministically.
  return slug.length >= 2 ? slug : `${slug}-x`;
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

// ── Source-session link resolver (Issue #704) ─────────────────────────────────

/**
 * Decide whether a learning's source_session should be emitted as an Obsidian
 * wiki-link or as plain text.
 *
 * When `opts.noteExists` is provided (a function `(slug: string) => boolean`),
 * the decision is EXISTENCE-based: the target slug is looked up in the caller's
 * known-sessions Set built from the real vault's 50-sessions directory. This is
 * the authoritative path used by process.mjs and eliminates false-negatives for
 * legacy/HHmm session IDs whose vault notes exist but don't match the strict
 * semantic regex (e.g. `main-2026-04-23-1255`, `main-2026-05-25-deep`).
 *
 * Without the predicate (unit-test / vault-less run), the function falls back to
 * strict format-validity (semantic `<branch>-<YYYY-MM-DD>-<mode>-<N>` or UUID-v4)
 * — identical to the Wave-2 behaviour, never worse.
 *
 * @param {unknown} source_session
 * @param {{ noteExists?: (slug: string) => boolean }} [opts]
 * @returns {{ isLink: boolean, target: string }}
 */
export function resolveSourceSessionLink(source_session, opts = {}) {
  const raw = source_session === null || source_session === undefined ? '' : String(source_session).trim();
  if (!raw || raw === 'unknown') return { isLink: false, target: raw || 'unknown' };
  // Provenance tags like "agent-proposed@wave-1" are never session notes.
  if (/@/.test(raw)) return { isLink: false, target: raw };
  const slug = subjectToSlug(raw) || raw;
  if (typeof opts.noteExists === 'function') {
    // EXISTENCE-based (authoritative when a predicate is supplied).
    return opts.noteExists(slug) ? { isLink: true, target: slug } : { isLink: false, target: raw };
  }
  // Fallback (no predicate, e.g. unit tests / no vault): strict format validity.
  const parsed = parseSessionId(raw);
  const ok = parsed !== null && (parsed.format === 'semantic' || parsed.format === 'uuid');
  return ok ? { isLink: true, target: slug } : { isLink: false, target: raw };
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
