/**
 * Unit tests for scripts/lib/vault-mirror/utils.mjs
 * Focus: subjectToSlug, isValidSlug, uuidPrefix8, toDate,
 *        truncateAtWord, yamlQuoteIfNeeded, parseFrontmatter,
 *        resolveSourceSessionLink
 *
 * Shape: one it.each table per pure function ({input, expected} rows).
 * The yamlQuoteIfNeeded round-trip rows (js-yaml parse-back) were merged in
 * from the former tests/unit/vault-mirror-utils.test.mjs — they assert the
 * quoted output is VALID YAML, which a string-shape assertion cannot.
 */

import { describe, it, expect } from 'vitest';
import { load as parseYaml } from 'js-yaml';
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
  it.each([
    { why: 'lowercases input', input: 'FooBar', expected: 'foobar' },
    { why: 'collapses slash path to last segment', input: 'libs/node/cross-repo', expected: 'cross-repo' },
    { why: 'collapses multiple leading slash segments', input: 'a/b/c/my-slug', expected: 'my-slug' },
    { why: 'replaces dots with hyphens', input: 'use.strict.mode', expected: 'use-strict-mode' },
    { why: 'replaces underscores with hyphens', input: 'snake_case_thing', expected: 'snake-case-thing' },
    { why: 'strips non-alphanumeric non-hyphen chars (spaces)', input: 'hello world', expected: 'helloworld' },
    { why: 'strips bracket characters', input: '[object', expected: 'object' },
    { why: 'collapses consecutive hyphens into one', input: 'foo--bar', expected: 'foo-bar' },
    { why: 'trims leading hyphens', input: '-leading-hyphen', expected: 'leading-hyphen' },
    { why: 'trims trailing hyphens', input: 'trailing-hyphen-', expected: 'trailing-hyphen' },
    { why: 'returns empty string for all-special input', input: '!!!@@###', expected: '' },
    { why: 'handles a plain alphanumeric string unchanged', input: 'foobar123', expected: 'foobar123' },
    // slash-collapse must run BEFORE lowercase + underscore→hyphen
    { why: 'applies slash-collapse before other transforms', input: 'a/FOO_BAR', expected: 'foo-bar' },
  ])('$why: $input', ({ input, expected }) => {
    expect(subjectToSlug(input)).toBe(expected);
  });
});

// ── isValidSlug ───────────────────────────────────────────────────────────────

describe('isValidSlug', () => {
  it.each([
    { why: 'accepts a simple kebab slug', input: 'my-slug', expected: true },
    { why: 'accepts a single word', input: 'slug', expected: true },
    { why: 'accepts alphanumeric with hyphens', input: 's69-compose-pids', expected: true },
    { why: 'rejects empty string', input: '', expected: false },
    { why: 'rejects a leading hyphen', input: '-bad-slug', expected: false },
    { why: 'rejects a trailing hyphen', input: 'bad-slug-', expected: false },
    { why: 'rejects uppercase characters', input: 'BadSlug', expected: false },
    { why: 'rejects spaces', input: 'bad slug', expected: false },
    // issue #718: without the `typeof s === 'string'` guard, slugRegex.test(undefined)
    // coerces to the literal string "undefined", which MATCHES the kebab pattern —
    // so isValidSlug(undefined) returned true pre-fix. Same trap for null/number.
    { why: 'rejects undefined (RegExp ToString-coercion trap)', input: undefined, expected: false },
    { why: 'rejects null (RegExp ToString-coercion trap)', input: null, expected: false },
    { why: 'rejects a number input that would stringify slug-shaped', input: 123, expected: false },
    // ...but a genuine string "undefined" is still validated normally.
    { why: 'accepts the literal STRING "undefined"', input: 'undefined', expected: true },
  ])('$why', ({ input, expected }) => {
    expect(isValidSlug(input)).toBe(expected);
  });
});

// ── uuidPrefix8 ───────────────────────────────────────────────────────────────

describe('uuidPrefix8', () => {
  it.each([
    { why: 'extracts first 8 hex chars, stripping hyphens', input: 'a1b2c3d4-0001-4000-8000-000000000001', expected: 'a1b2c3d4' },
    { why: 'works for a UUID starting with all zeros', input: '00000000-0001-4000-8000-abcdef123456', expected: '00000000' },
    { why: 'strips hyphens before slicing so the result is 8 hex chars', input: '11223344-5566-7788-9900-aabbccddeeff', expected: '11223344' },
  ])('$why', ({ input, expected }) => {
    expect(uuidPrefix8(input)).toBe(expected);
  });
});

// ── toDate ────────────────────────────────────────────────────────────────────

describe('toDate', () => {
  it.each([
    { why: 'extracts YYYY-MM-DD from an ISO datetime string', input: '2026-04-13T10:00:00Z', expected: '2026-04-13' },
    { why: 'returns the date unchanged when already a date string', input: '2026-05-08', expected: '2026-05-08' },
    { why: 'returns empty string for null input', input: null, expected: '' },
    { why: 'returns empty string for undefined input', input: undefined, expected: '' },
    { why: 'returns empty string for empty string input', input: '', expected: '' },
  ])('$why', ({ input, expected }) => {
    expect(toDate(input)).toBe(expected);
  });
});

// ── truncateAtWord ────────────────────────────────────────────────────────────

describe('truncateAtWord', () => {
  it.each([
    { why: 'returns the original string when it fits within maxLen', input: 'short string', maxLen: 20, expected: 'short string' },
    { why: 'truncates at a word boundary when a space precedes maxLen', input: 'this is a long string that exceeds the limit', maxLen: 20, expected: 'this is a long' },
    { why: 'hard-truncates at maxLen when no space exists before the limit', input: 'averylongwordwithoutspaces', maxLen: 10, expected: 'averylongw' },
    { why: 'returns the exact string when it is exactly maxLen', input: 'exactly', maxLen: 7, expected: 'exactly' },
    // slice(0,14)="hello world en" → lastSpace=11 → "hello world"
    { why: 'truncates back to the last whole word before the boundary', input: 'hello world end', maxLen: 14, expected: 'hello world' },
  ])('$why', ({ input, maxLen, expected }) => {
    expect(truncateAtWord(input, maxLen)).toBe(expected);
  });
});

// ── yamlQuoteIfNeeded ─────────────────────────────────────────────────────────

describe('yamlQuoteIfNeeded', () => {
  it.each([
    { why: 'returns a simple value unquoted', input: 'simple-value', expected: 'simple-value' },
    { why: 'returns an alphanumeric slug unchanged', input: 'plain-slug-123', expected: 'plain-slug-123' },
    // a space alone is NOT a quoting trigger
    { why: 'returns a spaced plain value unquoted', input: 'plain title', expected: 'plain title' },
    { why: 'quotes a value containing a colon', input: 'Session 2026: deep', expected: '"Session 2026: deep"' },
    { why: 'quotes a value containing a hash', input: 'issue #42', expected: '"issue #42"' },
    { why: 'quotes a value starting with a hyphen', input: '-start-with-hyphen', expected: '"-start-with-hyphen"' },
    { why: 'quotes and escapes a value starting with a double-quote', input: '"already quoted"', expected: '"\\"already quoted\\""' },
    { why: 'escapes double-quotes embedded mid-value', input: 'she said "hi": done', expected: '"she said \\"hi\\": done"' },
    { why: 'escapes backslashes inside quoted values', input: 'path\\to\\file:x', expected: '"path\\\\to\\\\file:x"' },
    // A bare backslash with NO colon/hash/leading-hyphen must still trigger quoting —
    // the colon-bearing row above would stay green even if `\` were not a trigger.
    { why: 'triggers quoting on a bare backslash alone', input: String.raw`a\b`, expected: String.raw`"a\\b"` },
  ])('$why', ({ input, expected }) => {
    expect(yamlQuoteIfNeeded(input)).toBe(expected);
  });

  // Round-trip through a REAL YAML parser: proves the escaped output is valid
  // YAML and decodes back to the original bytes. A string-shape assertion alone
  // cannot catch "well-formed-looking but YAML-invalid" escapes (the `\y`
  // PostgreSQL-regex regression: pre-fix output `"... \y ..."` was rejected by YAML).
  it.each([
    { why: 'PostgreSQL POSIX regex title with \\y and \\b', input: String.raw`PostgreSQL POSIX regex (~,~*) uses \y for word boundary, not \b` },
    { why: 'value containing both backslashes and double quotes', input: String.raw`mixed: \n and "quoted"` },
    { why: 'bare backslash value', input: String.raw`a\b` },
  ])('round-trips through js-yaml: $why', ({ input }) => {
    const quoted = yamlQuoteIfNeeded(input);
    expect(parseYaml(`title: ${quoted}\n`).title).toBe(input);
  });
});

// ── parseFrontmatter ──────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it.each([
    {
      why: 'parses a valid frontmatter block into key-value pairs',
      content: '---\ntitle: Hello\nstatus: draft\n---\n\nBody text.',
      expected: { title: 'Hello', status: 'draft' },
    },
    {
      why: 'returns null when content does not start with ---',
      content: 'title: Hello\n',
      expected: null,
    },
    {
      why: 'returns null when there is no closing ---',
      content: '---\ntitle: Hello\n',
      expected: null,
    },
    {
      why: 'strips surrounding double-quotes from values',
      content: '---\nid: "my-id"\n---\n',
      expected: { id: 'my-id' },
    },
    {
      why: 'strips surrounding single-quotes from values',
      content: "---\nname: 'value'\n---\n",
      expected: { name: 'value' },
    },
    {
      why: 'skips lines without a colon (no phantom key)',
      content: '---\ntitle: Hello\nnocolon\nstatus: ok\n---\n',
      expected: { title: 'Hello', status: 'ok' },
    },
    {
      why: 'returns the _generator field when present',
      content: '---\nid: test\n_generator: session-orchestrator-vault-mirror@1\n---\n',
      expected: { id: 'test', _generator: 'session-orchestrator-vault-mirror@1' },
    },
  ])('$why', ({ content, expected }) => {
    expect(parseFrontmatter(content)).toEqual(expected);
  });
});

// ── resolveSourceSessionLink (#704) ──────────────────────────────────────────

describe('resolveSourceSessionLink', () => {
  it.each([
    // ── Reject cases — isLink: false with sentinel target ────────────────────
    { why: 'empty string → sentinel target "unknown"', input: '', opts: undefined, expected: { isLink: false, target: 'unknown' } },
    { why: 'null → sentinel target "unknown"', input: null, opts: undefined, expected: { isLink: false, target: 'unknown' } },
    { why: 'undefined → sentinel target "unknown"', input: undefined, opts: undefined, expected: { isLink: false, target: 'unknown' } },
    { why: 'literal string "unknown" → not a link', input: 'unknown', opts: undefined, expected: { isLink: false, target: 'unknown' } },
    { why: 'provenance tag containing @ is never a link', input: 'agent-proposed@wave-1', opts: undefined, expected: { isLink: false, target: 'agent-proposed@wave-1' } },

    // ── Existence path — the noteExists predicate is authoritative and can
    //    validate legacy HHmm ids that do NOT match SEMANTIC_ID_RE ────────────
    { why: 'noteExists()===true makes a legacy HHmm id a link', input: 'main-2026-04-23-1255', opts: { noteExists: () => true }, expected: { isLink: true, target: 'main-2026-04-23-1255' } },
    { why: 'noteExists()===false leaves the same id plain text', input: 'main-2026-04-23-1255', opts: { noteExists: () => false }, expected: { isLink: false, target: 'main-2026-04-23-1255' } },

    // ── Format fallback (no predicate — strict SEMANTIC_ID_RE) ───────────────
    { why: 'semantic id branch-date-mode-counter is a link', input: 'main-2026-06-11-deep-1', opts: undefined, expected: { isLink: true, target: 'main-2026-06-11-deep-1' } },
    { why: 'mode-only id lacking the -<n> counter is not a link', input: 'develop-2026-04-09-evolve', opts: undefined, expected: { isLink: false, target: 'develop-2026-04-09-evolve' } },
    // '1255' starts with a digit, so SEMANTIC_ID_RE's [a-z-]+ mode slot does not
    // match — this is WHY the noteExists predicate exists for legacy ids.
    { why: 'legacy HHmm id without a predicate is not a link', input: 'main-2026-04-23-1255', opts: undefined, expected: { isLink: false, target: 'main-2026-04-23-1255' } },

    // ── target field contract: RAW input, never the slugified form ───────────
    // subjectToSlug('[object') === 'object', so a slug-leaking impl would return 'object'.
    { why: 'target is the RAW value, not the slugified one', input: '[object', opts: undefined, expected: { isLink: false, target: '[object' } },
  ])('$why', ({ input, opts, expected }) => {
    expect(resolveSourceSessionLink(input, opts)).toEqual(expected);
  });
});
