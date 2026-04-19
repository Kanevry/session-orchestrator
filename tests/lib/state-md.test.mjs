import { describe, it, expect } from 'vitest';
import {
  parseStateMd,
  serializeStateMd,
  touchUpdatedField,
  readCurrentTask,
} from '../../scripts/lib/state-md.mjs';

const SAMPLE = `---
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

describe('parseStateMd', () => {
  it('parses a valid STATE.md', () => {
    const result = parseStateMd(SAMPLE);
    expect(result).not.toBeNull();
    expect(result.frontmatter['schema-version']).toBe(1);
    expect(result.frontmatter['session-type']).toBe('deep');
    expect(result.frontmatter.issues).toEqual([182, 183, 184]);
    expect(result.frontmatter.status).toBe('active');
    expect(result.frontmatter['current-wave']).toBe(2);
    expect(result.frontmatter.updated).toBe('2026-04-19T17:30:00Z');
    expect(result.body).toContain('## Current Wave');
  });

  it('returns null for non-string input', () => {
    expect(parseStateMd(null)).toBeNull();
    expect(parseStateMd(42)).toBeNull();
    expect(parseStateMd(undefined)).toBeNull();
  });

  it('returns null when frontmatter block is missing', () => {
    expect(parseStateMd('# No frontmatter here')).toBeNull();
  });

  it('handles booleans and nulls', () => {
    const result = parseStateMd(`---
persistence: true
cross-repos: null
enforcement: warn
---

body
`);
    expect(result.frontmatter.persistence).toBe(true);
    expect(result.frontmatter['cross-repos']).toBeNull();
    expect(result.frontmatter.enforcement).toBe('warn');
  });

  it('parses integer arrays', () => {
    const result = parseStateMd(`---
issues: [1, 2, 3]
empty: []
---

body`);
    expect(result.frontmatter.issues).toEqual([1, 2, 3]);
    expect(result.frontmatter.empty).toEqual([]);
  });
});

describe('serializeStateMd', () => {
  it('round-trips a parsed STATE.md', () => {
    const parsed = parseStateMd(SAMPLE);
    const serialized = serializeStateMd(parsed);
    const reparsed = parseStateMd(serialized);
    expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
    expect(reparsed.body.trim()).toBe(parsed.body.trim());
  });

  it('emits valid YAML frontmatter delimiters', () => {
    const out = serializeStateMd({
      frontmatter: { a: 1, b: 'two' },
      body: 'body text',
    });
    expect(out.startsWith('---\n')).toBe(true);
    expect(out).toContain('\n---\n');
  });
});

describe('touchUpdatedField', () => {
  it('sets updated to the given timestamp', () => {
    const out = touchUpdatedField(SAMPLE, '2026-04-20T10:00:00Z');
    const reparsed = parseStateMd(out);
    expect(reparsed.frontmatter.updated).toBe('2026-04-20T10:00:00Z');
  });

  it('adds updated when missing', () => {
    const sansUpdated = SAMPLE.replace(/updated:.*\n/, '');
    const out = touchUpdatedField(sansUpdated, '2026-04-20T10:00:00Z');
    expect(out).toContain('updated: 2026-04-20T10:00:00Z');
  });

  it('returns input unchanged when no frontmatter', () => {
    const input = '# no frontmatter';
    expect(touchUpdatedField(input, '2026-01-01T00:00:00Z')).toBe(input);
  });
});

describe('readCurrentTask', () => {
  it('extracts wave number and description', () => {
    const task = readCurrentTask(SAMPLE);
    expect(task).toEqual({ waveNumber: 2, description: 'Wave 2 — Impl-Core' });
  });

  it('returns null when Current Wave section is absent', () => {
    const noSection = SAMPLE.replace(/## Current Wave[\s\S]*?(?=## )/, '');
    expect(readCurrentTask(noSection)).toBeNull();
  });

  it('returns null when STATE.md has no frontmatter', () => {
    expect(readCurrentTask('# plain markdown')).toBeNull();
  });

  it('handles descriptions without Wave prefix', () => {
    const contents = `---
status: idle
---

## Current Wave

(idle — no active session)
`;
    const task = readCurrentTask(contents);
    expect(task).toEqual({ waveNumber: null, description: '(idle — no active session)' });
  });
});
