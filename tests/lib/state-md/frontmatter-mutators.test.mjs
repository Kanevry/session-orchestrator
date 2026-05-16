import { describe, it, expect } from 'vitest';
import { parseStateMd } from '@lib/state-md/yaml-parser.mjs';
import {
  touchUpdatedField,
  updateFrontmatterFields,
} from '@lib/state-md/frontmatter-mutators.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const BASE = `---
schema-version: 1
session-type: deep
status: active
updated: 2026-04-19T17:30:00Z
custom-extension: keep-me
---

## Body
`;

const NO_FRONTMATTER = '# plain markdown without frontmatter\n';

// ─── touchUpdatedField ───────────────────────────────────────────────────────

describe('touchUpdatedField', () => {
  it('overwrites existing updated field with the given timestamp', () => {
    const out = touchUpdatedField(BASE, '2026-05-01T12:00:00Z');
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter.updated).toBe('2026-05-01T12:00:00Z');
  });

  it('adds updated field when missing', () => {
    const withoutUpdated = BASE.replace(/updated:.*\n/, '');
    const out = touchUpdatedField(withoutUpdated, '2026-05-01T12:00:00Z');
    expect(out).toContain('updated: 2026-05-01T12:00:00Z');
  });

  it('returns input unchanged when there is no frontmatter', () => {
    expect(touchUpdatedField(NO_FRONTMATTER, '2026-01-01T00:00:00Z')).toBe(NO_FRONTMATTER);
  });

  it('preserves other frontmatter fields unchanged', () => {
    const out = touchUpdatedField(BASE, '2026-05-01T12:00:00Z');
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter['schema-version']).toBe(1);
    expect(parsed.frontmatter['session-type']).toBe('deep');
    expect(parsed.frontmatter.status).toBe('active');
    expect(parsed.frontmatter['custom-extension']).toBe('keep-me');
  });

  it('is idempotent — calling twice with the same timestamp yields the same result', () => {
    const ts = '2026-05-01T12:00:00Z';
    const first = touchUpdatedField(BASE, ts);
    const second = touchUpdatedField(first, ts);
    expect(parseStateMd(second).frontmatter.updated).toBe(ts);
    expect(parseStateMd(second).frontmatter).toEqual(parseStateMd(first).frontmatter);
  });
});

// ─── updateFrontmatterFields ─────────────────────────────────────────────────

describe('updateFrontmatterFields', () => {
  it('sets a new key', () => {
    const out = updateFrontmatterFields(BASE, { 'recommended-mode': 'feature' });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter['recommended-mode']).toBe('feature');
  });

  it('overwrites an existing key', () => {
    const out = updateFrontmatterFields(BASE, { status: 'completed' });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter.status).toBe('completed');
  });

  it('deletes a key when value is null', () => {
    const out = updateFrontmatterFields(BASE, { status: null });
    const parsed = parseStateMd(out);
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, 'status')).toBe(false);
  });

  it('deletes a key when value is undefined', () => {
    const out = updateFrontmatterFields(BASE, { status: undefined });
    const parsed = parseStateMd(out);
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, 'status')).toBe(false);
  });

  it('preserves untouched keys (additive semantics)', () => {
    const out = updateFrontmatterFields(BASE, { 'completion-rate': 0.9 });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter['custom-extension']).toBe('keep-me');
    expect(parsed.frontmatter['schema-version']).toBe(1);
    expect(parsed.frontmatter['session-type']).toBe('deep');
    expect(parsed.frontmatter.status).toBe('active');
  });

  it('returns input unchanged when there is no frontmatter', () => {
    expect(updateFrontmatterFields(NO_FRONTMATTER, { foo: 'bar' })).toBe(NO_FRONTMATTER);
  });

  it('returns input unchanged when fields argument is null', () => {
    expect(updateFrontmatterFields(BASE, null)).toBe(BASE);
  });

  it('returns input unchanged when fields argument is an array', () => {
    expect(updateFrontmatterFields(BASE, ['not', 'an', 'object'])).toBe(BASE);
  });

  it('handles multiple simultaneous key operations (set + delete)', () => {
    const out = updateFrontmatterFields(BASE, {
      'recommended-mode': 'feature',
      'completion-rate': 0.95,
      'custom-extension': null,
    });
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter['recommended-mode']).toBe('feature');
    expect(parsed.frontmatter['completion-rate']).toBe(0.95);
    expect(Object.prototype.hasOwnProperty.call(parsed.frontmatter, 'custom-extension')).toBe(false);
  });

  it('no-op on empty fields object — returns equivalent contents', () => {
    const out = updateFrontmatterFields(BASE, {});
    const parsed = parseStateMd(out);
    expect(parsed.frontmatter).toEqual(parseStateMd(BASE).frontmatter);
  });
});
