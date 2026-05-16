import { describe, it, expect } from 'vitest';
import {
  parseStateMd,
  serializeStateMd,
} from '@lib/state-md.mjs';

const WITH_DOCS_TASKS = `---
schema-version: 1
session-type: feature
status: active
current-wave: 2
total-waves: 5
issues: [230, 233]
docs-tasks:
  - id: docs-1
    audience: dev
    target-pattern: "skills/**/*.md"
    rationale: "New skill scaffolded"
    wave: 3
    status: planned
  - id: docs-2
    audience: user
    target-pattern: README.md
    rationale: "New --no-vault flag"
    wave: 3
    status: planned
---

## Current Wave

Wave 2 — Impl-Core
`;

describe('parseStateMd — block-seq of mappings (#244)', () => {
  it('parses a docs-tasks block sequence', () => {
    const parsed = parseStateMd(WITH_DOCS_TASKS);
    expect(parsed).not.toBeNull();
    const tasks = parsed.frontmatter['docs-tasks'];
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toEqual({
      id: 'docs-1',
      audience: 'dev',
      'target-pattern': 'skills/**/*.md',
      rationale: 'New skill scaffolded',
      wave: 3,
      status: 'planned',
    });
    expect(tasks[1].id).toBe('docs-2');
    expect(tasks[1].audience).toBe('user');
    expect(tasks[1].wave).toBe(3);
  });

  it('preserves scalar fields alongside the block sequence', () => {
    const parsed = parseStateMd(WITH_DOCS_TASKS);
    expect(parsed.frontmatter['schema-version']).toBe(1);
    expect(parsed.frontmatter['session-type']).toBe('feature');
    expect(parsed.frontmatter.issues).toEqual([230, 233]);
    expect(parsed.frontmatter['current-wave']).toBe(2);
  });

  it('handles a key with no value and no indented block (null)', () => {
    const parsed = parseStateMd(`---
schema-version: 1
docs-tasks:
status: active
---

body
`);
    expect(parsed).not.toBeNull();
    expect(parsed.frontmatter['docs-tasks']).toBeNull();
    expect(parsed.frontmatter.status).toBe('active');
  });

  it('handles a single-entry block sequence', () => {
    const parsed = parseStateMd(`---
schema-version: 1
docs-tasks:
  - id: docs-only
    audience: vault
    wave: 1
---

body
`);
    expect(parsed.frontmatter['docs-tasks']).toEqual([
      { id: 'docs-only', audience: 'vault', wave: 1 },
    ]);
  });

  it('round-trips through serialize → parse', () => {
    const parsed = parseStateMd(WITH_DOCS_TASKS);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
  });

  it('emits block-seq format when serializing an array of objects', () => {
    const out = serializeStateMd({
      frontmatter: {
        'schema-version': 1,
        'docs-tasks': [
          { id: 'docs-1', audience: 'dev', wave: 2 },
          { id: 'docs-2', audience: 'user', wave: 3 },
        ],
      },
      body: 'body',
    });
    expect(out).toContain('docs-tasks:\n  - id: docs-1\n    audience: dev\n    wave: 2\n  - id: docs-2');
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

  it('leaves scalar int arrays using flow style', () => {
    const out = serializeStateMd({
      frontmatter: { issues: [1, 2, 3] },
      body: '',
    });
    expect(out).toContain('issues: [1, 2, 3]');
  });
});
