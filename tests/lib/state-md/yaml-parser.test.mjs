import { describe, it, expect } from 'vitest';
import { parseStateMd, serializeStateMd } from '../../../scripts/lib/state-md/yaml-parser.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FULL_SAMPLE = `---
schema-version: 1
session-type: deep
branch: feat/example
issues: [182, 183, 184]
started_at: 2026-04-19T17:05:00+02:00
status: active
current-wave: 2
total-waves: 5
updated: 2026-04-19T17:30:00Z
session: feat-example-2026-04-19-1705
---

## Current Wave

Wave 2 — Impl-Core

## Wave History

### Wave 1 — Discovery
- Agent X: done
`;

const WITH_BLOCK_SEQ = `---
schema-version: 1
session-type: feature
status: active
docs-tasks:
  - id: docs-1
    audience: dev
    wave: 3
    status: planned
  - id: docs-2
    audience: user
    wave: 3
    status: planned
---

## Body
`;

const WITH_MISSION_STATUS = `---
schema-version: 1
status: active
mission-status:
  - id: m-1
    task: foo
    wave: 1
    status: brainstormed
---

## Body
`;

// ─── parseStateMd — happy paths ──────────────────────────────────────────────

describe('parseStateMd — happy paths', () => {
  it('parses scalar string and integer fields', () => {
    const result = parseStateMd(FULL_SAMPLE);
    expect(result).not.toBeNull();
    expect(result.frontmatter['schema-version']).toBe(1);
    expect(result.frontmatter['session-type']).toBe('deep');
    expect(result.frontmatter.branch).toBe('feat/example');
    expect(result.frontmatter.status).toBe('active');
    expect(result.frontmatter['current-wave']).toBe(2);
    expect(result.frontmatter['total-waves']).toBe(5);
  });

  it('parses flow-style integer arrays', () => {
    const result = parseStateMd(FULL_SAMPLE);
    expect(result.frontmatter.issues).toEqual([182, 183, 184]);
  });

  it('separates body from frontmatter correctly', () => {
    const result = parseStateMd(FULL_SAMPLE);
    expect(result.body).toContain('## Current Wave');
    expect(result.body).toContain('Wave 2 — Impl-Core');
    expect(result.body).not.toContain('schema-version');
  });

  it('strips leading newline from body', () => {
    const result = parseStateMd(FULL_SAMPLE);
    // body should not start with a newline — parseStateMd strips the leading \n
    expect(result.body.startsWith('\n')).toBe(false);
  });

  it('parses boolean values (true/false)', () => {
    const result = parseStateMd(`---
persistence: true
cross-repos: false
enforcement: warn
---

body
`);
    expect(result.frontmatter.persistence).toBe(true);
    expect(result.frontmatter['cross-repos']).toBe(false);
    expect(result.frontmatter.enforcement).toBe('warn');
  });

  it('parses null via "null" and "~" scalars', () => {
    const result = parseStateMd(`---
a: null
b: ~
c: some-value
---

body
`);
    expect(result.frontmatter.a).toBeNull();
    expect(result.frontmatter.b).toBeNull();
    expect(result.frontmatter.c).toBe('some-value');
  });

  it('parses empty flow array []', () => {
    const result = parseStateMd(`---
issues: []
---

body
`);
    expect(result.frontmatter.issues).toEqual([]);
  });

  it('parses floating-point scalars', () => {
    const result = parseStateMd(`---
ratio: 0.75
rate: 1.0
---

body
`);
    expect(result.frontmatter.ratio).toBe(0.75);
    expect(result.frontmatter.rate).toBe(1.0);
  });

  it('parses single-quoted and double-quoted strings', () => {
    const result = parseStateMd(`---
a: "hello world"
b: 'foo bar'
---

body
`);
    expect(result.frontmatter.a).toBe('hello world');
    expect(result.frontmatter.b).toBe('foo bar');
  });

  it('parses block-sequence of mappings (docs-tasks)', () => {
    const result = parseStateMd(WITH_BLOCK_SEQ);
    expect(result).not.toBeNull();
    const tasks = result.frontmatter['docs-tasks'];
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({ id: 'docs-1', audience: 'dev', wave: 3, status: 'planned' });
    expect(tasks[1].id).toBe('docs-2');
    expect(tasks[1].audience).toBe('user');
  });

  it('parses block-sequence of mappings (mission-status)', () => {
    const result = parseStateMd(WITH_MISSION_STATUS);
    expect(result).not.toBeNull();
    const ms = result.frontmatter['mission-status'];
    expect(Array.isArray(ms)).toBe(true);
    expect(ms).toHaveLength(1);
    expect(ms[0].id).toBe('m-1');
    expect(ms[0].task).toBe('foo');
    expect(ms[0].wave).toBe(1);
    expect(ms[0].status).toBe('brainstormed');
  });

  it('handles a key with no value and no indented block (null scalar)', () => {
    const result = parseStateMd(`---
schema-version: 1
docs-tasks:
status: active
---

body
`);
    expect(result).not.toBeNull();
    expect(result.frontmatter['docs-tasks']).toBeNull();
    expect(result.frontmatter.status).toBe('active');
  });

  it('preserves scalar fields alongside a block sequence', () => {
    const result = parseStateMd(WITH_BLOCK_SEQ);
    expect(result.frontmatter['schema-version']).toBe(1);
    expect(result.frontmatter['session-type']).toBe('feature');
    expect(result.frontmatter.status).toBe('active');
  });

  it('handles negative integers', () => {
    const result = parseStateMd(`---
offset: -5
count: -100
---

body
`);
    expect(result.frontmatter.offset).toBe(-5);
    expect(result.frontmatter.count).toBe(-100);
  });

  it('handles CRLF line endings in frontmatter', () => {
    const crlf = '---\r\nstatus: active\r\nupdated: 2026-01-01T00:00:00Z\r\n---\r\nbody\r\n';
    const result = parseStateMd(crlf);
    expect(result).not.toBeNull();
    expect(result.frontmatter.status).toBe('active');
    expect(result.frontmatter.updated).toBe('2026-01-01T00:00:00Z');
  });

  it('handles CRLF line endings in body', () => {
    const crlf = '---\r\nstatus: active\r\n---\r\n## Section\r\nContent here\r\n';
    const result = parseStateMd(crlf);
    expect(result).not.toBeNull();
    // body is preserved as-is (CRLFs intact in body)
    expect(result.body).toContain('## Section');
  });
});

// ─── parseStateMd — error paths ──────────────────────────────────────────────

describe('parseStateMd — error paths', () => {
  it('returns null for non-string input (null)', () => {
    expect(parseStateMd(null)).toBeNull();
  });

  it('returns null for non-string input (number)', () => {
    expect(parseStateMd(42)).toBeNull();
  });

  it('returns null for non-string input (undefined)', () => {
    expect(parseStateMd(undefined)).toBeNull();
  });

  it('returns null when frontmatter block is missing', () => {
    expect(parseStateMd('# No frontmatter here')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseStateMd('')).toBeNull();
  });

  it('returns null for malformed block entry missing a colon', () => {
    const malformed = `---
schema-version: 1
docs-tasks:
  - id: docs-1
    just-a-value
---

body
`;
    expect(parseStateMd(malformed)).toBeNull();
  });

  it('returns null for unexpected deeper nesting inside an entry', () => {
    const malformed = `---
schema-version: 1
docs-tasks:
  - id: docs-1
    nested:
      child: value
---

body
`;
    expect(parseStateMd(malformed)).toBeNull();
  });

  it('returns null when top-level line has unexpected leading indent', () => {
    const malformed = `---
schema-version: 1
  stray: indent
---

body
`;
    expect(parseStateMd(malformed)).toBeNull();
  });

  it('returns null when a top-level key has no colon', () => {
    const malformed = `---
status active
---

body
`;
    expect(parseStateMd(malformed)).toBeNull();
  });
});

// ─── serializeStateMd — happy paths ──────────────────────────────────────────

describe('serializeStateMd — happy paths', () => {
  it('emits valid frontmatter delimiters', () => {
    const out = serializeStateMd({ frontmatter: { a: 1, b: 'two' }, body: 'body text' });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('\n---\n');
  });

  it('serializes boolean scalars as true/false literals', () => {
    const out = serializeStateMd({ frontmatter: { flag: true, off: false }, body: '' });
    expect(out).toContain('flag: true');
    expect(out).toContain('off: false');
  });

  it('serializes null as the null literal', () => {
    const out = serializeStateMd({ frontmatter: { empty: null }, body: '' });
    expect(out).toContain('empty: null');
  });

  it('serializes flow-style integer arrays', () => {
    const out = serializeStateMd({ frontmatter: { issues: [1, 2, 3] }, body: '' });
    expect(out).toContain('issues: [1, 2, 3]');
  });

  it('serializes empty array as flow style []', () => {
    const out = serializeStateMd({ frontmatter: { items: [] }, body: '' });
    expect(out).toContain('items: []');
  });

  it('serializes block-seq of mappings with correct indentation', () => {
    const out = serializeStateMd({
      frontmatter: {
        'docs-tasks': [
          { id: 'docs-1', audience: 'dev', wave: 2 },
          { id: 'docs-2', audience: 'user', wave: 3 },
        ],
      },
      body: 'body',
    });
    expect(out).toContain('docs-tasks:\n  - id: docs-1\n    audience: dev\n    wave: 2\n  - id: docs-2');
  });

  it('JSON-quotes strings containing spaces', () => {
    const out = serializeStateMd({ frontmatter: { msg: 'hello world' }, body: '' });
    expect(out).toContain('msg: "hello world"');
  });

  it('emits bare strings for simple identifiers (no quoting)', () => {
    const out = serializeStateMd({ frontmatter: { status: 'active', branch: 'feat/x' }, body: '' });
    expect(out).toContain('status: active');
    expect(out).toContain('branch: feat/x');
  });

  it('preserves body content after the frontmatter', () => {
    const out = serializeStateMd({ frontmatter: { a: 1 }, body: '## My Section\n\nContent here\n' });
    const bodyStart = out.indexOf('\n---\n') + 5;
    expect(out.slice(bodyStart)).toContain('## My Section');
  });
});

// ─── round-trip ──────────────────────────────────────────────────────────────

describe('parseStateMd ↔ serializeStateMd round-trip', () => {
  it('round-trips a full STATE.md without data loss', () => {
    const parsed = parseStateMd(FULL_SAMPLE);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
    expect(reparsed.body.trim()).toBe(parsed.body.trim());
  });

  it('round-trips a block-seq fixture', () => {
    const parsed = parseStateMd(WITH_BLOCK_SEQ);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
  });

  it('round-trips mission-status block-seq fixture', () => {
    const parsed = parseStateMd(WITH_MISSION_STATUS);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter['mission-status']).toEqual(parsed.frontmatter['mission-status']);
  });

  it('round-trips scalar types without coercion', () => {
    const src = `---
count: 7
ratio: 0.5
enabled: true
label: hello
---

body
`;
    const parsed = parseStateMd(src);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter.count).toBe(7);
    expect(reparsed.frontmatter.ratio).toBe(0.5);
    expect(reparsed.frontmatter.enabled).toBe(true);
    expect(reparsed.frontmatter.label).toBe('hello');
  });

  it('round-trips quoted strings that contain spaces', () => {
    const src = `---
rationale: "hello world"
---

body
`;
    const parsed = parseStateMd(src);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter.rationale).toBe('hello world');
  });
});
