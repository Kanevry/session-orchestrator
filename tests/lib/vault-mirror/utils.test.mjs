/**
 * Unit tests for scripts/lib/vault-mirror/utils.mjs
 * Focus: subjectToSlug, isValidSlug, uuidPrefix8, toDate,
 *        truncateAtWord, yamlQuoteIfNeeded, parseFrontmatter
 */

import { describe, it, expect } from 'vitest';
import {
  subjectToSlug,
  isValidSlug,
  uuidPrefix8,
  toDate,
  truncateAtWord,
  yamlQuoteIfNeeded,
  parseFrontmatter,
  resolveSourceSessionLink,
} from '@lib/vault-mirror/utils.mjs';

// ── subjectToSlug ─────────────────────────────────────────────────────────────

describe('subjectToSlug', () => {
  it('lowercases input', () => {
    expect(subjectToSlug('FooBar')).toBe('foobar');
  });

  it('collapses slash path to last segment', () => {
    expect(subjectToSlug('libs/node/cross-repo')).toBe('cross-repo');
  });

  it('collapses multiple leading slash segments', () => {
    expect(subjectToSlug('a/b/c/my-slug')).toBe('my-slug');
  });

  it('replaces dots with hyphens', () => {
    expect(subjectToSlug('use.strict.mode')).toBe('use-strict-mode');
  });

  it('replaces underscores with hyphens', () => {
    expect(subjectToSlug('snake_case_thing')).toBe('snake-case-thing');
  });

  it('strips non-alphanumeric non-hyphen chars (spaces)', () => {
    expect(subjectToSlug('hello world')).toBe('helloworld');
  });

  it('strips bracket characters', () => {
    expect(subjectToSlug('[object')).toBe('object');
  });

  it('collapses consecutive hyphens into one', () => {
    expect(subjectToSlug('foo--bar')).toBe('foo-bar');
  });

  it('trims leading hyphens', () => {
    expect(subjectToSlug('-leading-hyphen')).toBe('leading-hyphen');
  });

  it('trims trailing hyphens', () => {
    expect(subjectToSlug('trailing-hyphen-')).toBe('trailing-hyphen');
  });

  it('returns empty string for all-special input', () => {
    expect(subjectToSlug('!!!@@###')).toBe('');
  });

  it('handles a plain alphanumeric string unchanged', () => {
    expect(subjectToSlug('foobar123')).toBe('foobar123');
  });

  it('applies slash-collapse before other transforms', () => {
    // "a/FOO_BAR" → last segment "FOO_BAR" → lowercase + underscore→hyphen → "foo-bar"
    expect(subjectToSlug('a/FOO_BAR')).toBe('foo-bar');
  });
});

// ── isValidSlug ───────────────────────────────────────────────────────────────

describe('isValidSlug', () => {
  it('accepts a simple kebab slug', () => {
    expect(isValidSlug('my-slug')).toBe(true);
  });

  it('accepts a single word', () => {
    expect(isValidSlug('slug')).toBe(true);
  });

  it('accepts alphanumeric with hyphens', () => {
    expect(isValidSlug('s69-compose-pids')).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSlug('')).toBe(false);
  });

  it('rejects a string with leading hyphen', () => {
    expect(isValidSlug('-bad-slug')).toBe(false);
  });

  it('rejects a string with trailing hyphen', () => {
    expect(isValidSlug('bad-slug-')).toBe(false);
  });

  it('rejects uppercase characters', () => {
    expect(isValidSlug('BadSlug')).toBe(false);
  });

  it('rejects spaces', () => {
    expect(isValidSlug('bad slug')).toBe(false);
  });

  // ── issue #718: RegExp implicit ToString-coercion trap ─────────────────────
  // Without the `typeof s === 'string'` guard, `slugRegex.test(undefined)`
  // coerces its argument to the literal string "undefined", which matches the
  // kebab-slug pattern — so isValidSlug(undefined) returned `true` pre-fix.

  it('rejects undefined (RegExp ToString-coercion trap)', () => {
    expect(isValidSlug(undefined)).toBe(false);
  });

  it('rejects null (RegExp ToString-coercion trap)', () => {
    expect(isValidSlug(null)).toBe(false);
  });

  it('rejects a number input, even one that would stringify to a slug-shaped value', () => {
    expect(isValidSlug(123)).toBe(false);
  });

  it('accepts the literal STRING "undefined" (a genuine string is still validated normally)', () => {
    expect(isValidSlug('undefined')).toBe(true);
  });
});

// ── uuidPrefix8 ───────────────────────────────────────────────────────────────

describe('uuidPrefix8', () => {
  it('extracts first 8 hex chars from a UUID, stripping hyphens', () => {
    expect(uuidPrefix8('a1b2c3d4-0001-4000-8000-000000000001')).toBe('a1b2c3d4');
  });

  it('works for UUID starting with all zeros', () => {
    expect(uuidPrefix8('00000000-0001-4000-8000-abcdef123456')).toBe('00000000');
  });

  it('strips hyphens before slicing so result is exactly 8 hex chars', () => {
    // "11223344-..." → stripped → "11223344..." → first 8 = "11223344"
    expect(uuidPrefix8('11223344-5566-7788-9900-aabbccddeeff')).toBe('11223344');
  });
});

// ── toDate ────────────────────────────────────────────────────────────────────

describe('toDate', () => {
  it('extracts YYYY-MM-DD from an ISO datetime string', () => {
    expect(toDate('2026-04-13T10:00:00Z')).toBe('2026-04-13');
  });

  it('returns just the date when input is already a date string', () => {
    expect(toDate('2026-05-08')).toBe('2026-05-08');
  });

  it('returns empty string for null input', () => {
    expect(toDate(null)).toBe('');
  });

  it('returns empty string for undefined input', () => {
    expect(toDate(undefined)).toBe('');
  });

  it('returns empty string for empty string input', () => {
    expect(toDate('')).toBe('');
  });
});

// ── truncateAtWord ────────────────────────────────────────────────────────────

describe('truncateAtWord', () => {
  it('returns the original string when it fits within maxLen', () => {
    expect(truncateAtWord('short string', 20)).toBe('short string');
  });

  it('truncates at a word boundary when a space is found before maxLen', () => {
    expect(truncateAtWord('this is a long string that exceeds the limit', 20)).toBe('this is a long');
  });

  it('hard-truncates at maxLen when no space exists before the limit', () => {
    expect(truncateAtWord('averylongwordwithoutspaces', 10)).toBe('averylongw');
  });

  it('returns exact maxLen string when it fits exactly', () => {
    expect(truncateAtWord('exactly', 7)).toBe('exactly');
  });

  it('truncates to last word before boundary when space is found', () => {
    // "hello world end" with maxLen=14 → slice(0,14)="hello world en" → lastSpace=10 (at ' end') → "hello world"
    expect(truncateAtWord('hello world end', 14)).toBe('hello world');
  });
});

// ── yamlQuoteIfNeeded ─────────────────────────────────────────────────────────

describe('yamlQuoteIfNeeded', () => {
  it('returns simple value unquoted', () => {
    expect(yamlQuoteIfNeeded('simple-value')).toBe('simple-value');
  });

  it('quotes value containing a colon', () => {
    expect(yamlQuoteIfNeeded('Session 2026: deep')).toBe('"Session 2026: deep"');
  });

  it('quotes value containing a hash', () => {
    expect(yamlQuoteIfNeeded('issue #42')).toBe('"issue #42"');
  });

  it('quotes value starting with a hyphen', () => {
    expect(yamlQuoteIfNeeded('-start-with-hyphen')).toBe('"-start-with-hyphen"');
  });

  it('quotes value starting with a double-quote', () => {
    expect(yamlQuoteIfNeeded('"already quoted"')).toBe('"\\"already quoted\\""');
  });

  it('escapes backslashes inside quoted values', () => {
    const out = yamlQuoteIfNeeded('path\\to\\file:x');
    expect(out).toBe('"path\\\\to\\\\file:x"');
  });

  it('returns alphanumeric slug unchanged', () => {
    expect(yamlQuoteIfNeeded('plain-slug-123')).toBe('plain-slug-123');
  });
});

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('parses a valid frontmatter block into key-value pairs', () => {
    const content = '---\ntitle: Hello\nstatus: draft\n---\n\nBody text.';
    expect(parseFrontmatter(content)).toEqual({ title: 'Hello', status: 'draft' });
  });

  it('returns null when content does not start with ---', () => {
    expect(parseFrontmatter('title: Hello\n')).toBeNull();
  });

  it('returns null when there is no closing ---', () => {
    expect(parseFrontmatter('---\ntitle: Hello\n')).toBeNull();
  });

  it('strips surrounding double-quotes from values', () => {
    const content = '---\nid: "my-id"\n---\n';
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm.id).toBe('my-id');
  });

  it('strips surrounding single-quotes from values', () => {
    const content = "---\nname: 'value'\n---\n";
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm.name).toBe('value');
  });

  it('skips lines without a colon', () => {
    const content = '---\ntitle: Hello\nnocolon\nstatus: ok\n---\n';
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(Object.keys(fm)).toEqual(['title', 'status']);
  });

  it('returns the _generator field when present', () => {
    const content = '---\nid: test\n_generator: session-orchestrator-vault-mirror@1\n---\n';
    const fm = parseFrontmatter(content);
    expect(fm).not.toBeNull();
    expect(fm['_generator']).toBe('session-orchestrator-vault-mirror@1');
  });
});

// ── resolveSourceSessionLink (#704) ──────────────────────────────────────────

describe('resolveSourceSessionLink', () => {
  // ── Reject cases — isLink: false with sentinel target ────────────────────

  it('returns isLink: false with target "unknown" for empty string input', () => {
    expect(resolveSourceSessionLink('')).toEqual({ isLink: false, target: 'unknown' });
  });

  it('returns isLink: false with target "unknown" for null input', () => {
    expect(resolveSourceSessionLink(null)).toEqual({ isLink: false, target: 'unknown' });
  });

  it('returns isLink: false with target "unknown" for undefined input', () => {
    expect(resolveSourceSessionLink(undefined)).toEqual({ isLink: false, target: 'unknown' });
  });

  it('returns isLink: false with target "unknown" for the literal string "unknown"', () => {
    expect(resolveSourceSessionLink('unknown')).toEqual({ isLink: false, target: 'unknown' });
  });

  it('returns isLink: false for provenance tag containing @ (agent-proposed@wave-1)', () => {
    expect(resolveSourceSessionLink('agent-proposed@wave-1')).toEqual({
      isLink: false,
      target: 'agent-proposed@wave-1',
    });
  });

  // ── Existence path (noteExists predicate — authoritative) ─────────────────

  it('existence path: returns isLink: true when noteExists predicate returns true', () => {
    // The predicate is authoritative: it can validate legacy HHmm ids that do not
    // match SEMANTIC_ID_RE (e.g. 'main-2026-04-23-1255'). When the vault note exists,
    // isLink is true regardless of format.
    expect(resolveSourceSessionLink('main-2026-04-23-1255', { noteExists: () => true })).toEqual({
      isLink: true,
      target: 'main-2026-04-23-1255',
    });
  });

  it('existence path: returns isLink: false when noteExists predicate returns false', () => {
    // Same HHmm id, but vault note does not exist → plain text, no wikilink.
    expect(resolveSourceSessionLink('main-2026-04-23-1255', { noteExists: () => false })).toEqual({
      isLink: false,
      target: 'main-2026-04-23-1255',
    });
  });

  // ── Format fallback (no predicate — strict SEMANTIC_ID_RE / UUID-v4) ──────

  it('format fallback: returns isLink: true for semantic session ID main-2026-06-11-deep-1', () => {
    // Matches SEMANTIC_ID_RE: branch=main, date=2026-06-11, mode=deep, n=1
    expect(resolveSourceSessionLink('main-2026-06-11-deep-1')).toEqual({
      isLink: true,
      target: 'main-2026-06-11-deep-1',
    });
  });

  it('format fallback: returns isLink: false for mode-only id lacking counter (develop-2026-04-09-evolve)', () => {
    // 'develop-2026-04-09-evolve' has no trailing -<n> counter → does not match SEMANTIC_ID_RE
    expect(resolveSourceSessionLink('develop-2026-04-09-evolve')).toEqual({
      isLink: false,
      target: 'develop-2026-04-09-evolve',
    });
  });

  it('format fallback: returns isLink: false for legacy HHmm id (main-2026-04-23-1255) without predicate', () => {
    // 'main-2026-04-23-1255': SEMANTIC_ID_RE requires a [a-z-]+ mode between date and counter,
    // but '1255' starts with a digit — no match. This documents why the noteExists
    // existence predicate is required when the vault note may exist for legacy ids.
    expect(resolveSourceSessionLink('main-2026-04-23-1255')).toEqual({
      isLink: false,
      target: 'main-2026-04-23-1255',
    });
  });

  // ── target field contract ─────────────────────────────────────────────────

  it('target field is the raw input value when isLink is false, not the slugified version', () => {
    // resolveSourceSessionLink uses subjectToSlug('[object') = 'object' for the slug,
    // but the target must be the RAW value '[object', not 'object'.
    const result = resolveSourceSessionLink('[object');
    expect(result.isLink).toBe(false);
    expect(result.target).toBe('[object');
  });

  it('target field is "unknown" for empty string (never an empty string or a bracketed value)', () => {
    expect(resolveSourceSessionLink('').target).toBe('unknown');
  });
});
