import { describe, it, expect } from 'vitest';
import {
  parseStateMd,
  parseMissionStatus,
  writeMissionStatus,
} from '@lib/state-md.mjs';

/**
 * Minimal valid STATE.md fixture (no mission-status key).
 */
const BASE_STATE = `---
schema-version: 1
status: active
---

## Body
`;

/**
 * STATE.md fixture with an empty mission-status key.
 * The parser stores an empty block seq as `[]` when `mission-status:` appears
 * with no indented sequence items — but because the serializer emits empty
 * arrays as `[]` flow scalars, we parse that form here for the round-trip tests.
 */
const STATE_WITH_EMPTY_MISSION_STATUS = `---
schema-version: 1
status: active
mission-status: []
---

## Body
`;

/**
 * STATE.md fixture with one populated mission-status entry.
 */
const STATE_WITH_ONE_ENTRY = `---
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

// Test 1: parseMissionStatus({}) — key absent → null
describe('parseMissionStatus', () => {
  it('returns null when mission-status key is absent from frontmatter', () => {
    expect(parseMissionStatus({})).toBeNull();
  });

  // Test 2: parseMissionStatus({'mission-status': []}) → empty array
  it('returns an empty array when mission-status is an empty array', () => {
    const result = parseMissionStatus({ 'mission-status': [] });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  // Test 3: parseMissionStatus with a populated entry → array of 1
  it('returns an array of entries when mission-status is populated', () => {
    const entry = { id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' };
    const result = parseMissionStatus({ 'mission-status': [entry] });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entry);
  });

  it('returns null when frontmatter is null', () => {
    expect(parseMissionStatus(null)).toBeNull();
  });

  it('returns null when mission-status value is not an array (scalar null)', () => {
    // A bare `mission-status:` key with no value parses as null scalar
    expect(parseMissionStatus({ 'mission-status': null })).toBeNull();
  });

  it('returns a shallow copy — mutations do not affect the original', () => {
    const source = { 'mission-status': [{ id: 'm-1', task: 'x', wave: 1, status: 'brainstormed' }] };
    const result = parseMissionStatus(source);
    result.push({ id: 'm-extra', task: 'y', wave: 2, status: 'validated' });
    expect(source['mission-status']).toHaveLength(1);
  });
});

// Test 4: round-trip — write then parse produces the same array
describe('writeMissionStatus — round-trip', () => {
  it('written mission-status survives a parse round-trip', () => {
    const entries = [
      { id: 'm-1', task: 'implement feature', wave: 2, status: 'in-dev' },
      { id: 'm-2', task: 'write tests', wave: 4, status: 'brainstormed' },
    ];
    const updated = writeMissionStatus(BASE_STATE, entries);
    const parsed = parseStateMd(updated);
    expect(parsed).not.toBeNull();
    const recovered = parseMissionStatus(parsed.frontmatter);
    expect(recovered).toHaveLength(2);
    expect(recovered[0].id).toBe('m-1');
    expect(recovered[0].task).toBe('implement feature');
    expect(recovered[0].wave).toBe(2);
    expect(recovered[0].status).toBe('in-dev');
    expect(recovered[1].id).toBe('m-2');
    expect(recovered[1].status).toBe('brainstormed');
  });
});

// Test 5: writeMissionStatus(contents, null) — removes the key
describe('writeMissionStatus — null deletes the key', () => {
  it('removes mission-status from frontmatter when null is passed', () => {
    const withKey = writeMissionStatus(BASE_STATE, [{ id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' }]);
    // Verify the key was written first
    const withKeyParsed = parseStateMd(withKey);
    expect(Object.prototype.hasOwnProperty.call(withKeyParsed.frontmatter, 'mission-status')).toBe(true);

    // Now delete it
    const deleted = writeMissionStatus(withKey, null);
    const deletedParsed = parseStateMd(deleted);
    expect(Object.prototype.hasOwnProperty.call(deletedParsed.frontmatter, 'mission-status')).toBe(false);
  });

  it('removes mission-status when undefined is passed', () => {
    const withKey = writeMissionStatus(BASE_STATE, [{ id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' }]);
    const deleted = writeMissionStatus(withKey, undefined);
    const deletedParsed = parseStateMd(deleted);
    expect(Object.prototype.hasOwnProperty.call(deletedParsed.frontmatter, 'mission-status')).toBe(false);
  });
});

// Test 6: writeMissionStatus with a non-empty array produces correct YAML output
describe('writeMissionStatus — written output formatting', () => {
  it('output contains "mission-status:" and the entry fields', () => {
    const entries = [{ id: 'm-1', task: 'ship feature', wave: 2, status: 'brainstormed' }];
    const result = writeMissionStatus(BASE_STATE, entries);
    expect(result).toContain('mission-status:');
    expect(result).toContain('m-1');
    expect(result).toContain('ship feature');
    expect(result).toContain('brainstormed');
  });

  it('writes each entry field on its own line in block sequence format', () => {
    // Use a task string without spaces so the serializer won't JSON-quote it
    const entries = [{ id: 'm-1', task: 'implement-feature', wave: 3, status: 'validated' }];
    const result = writeMissionStatus(BASE_STATE, entries);
    // Block seq entries start with `  - id:` pattern
    expect(result).toMatch(/mission-status:/);
    expect(result).toMatch(/- id: m-1/);
    expect(result).toMatch(/task: implement-feature/);
    expect(result).toMatch(/wave: 3/);
    expect(result).toMatch(/status: validated/);
  });

  it('is a no-op when contents has no parseable frontmatter', () => {
    const bad = '# no frontmatter here';
    expect(writeMissionStatus(bad, [{ id: 'm-1', task: 'x', wave: 1, status: 'brainstormed' }])).toBe(bad);
  });
});

// Extra: parseMissionStatus integrates with parseStateMd for a block-seq fixture
describe('parseMissionStatus — integrated with parseStateMd', () => {
  it('extracts entries from a STATE.md with one mission-status block-seq entry', () => {
    const parsed = parseStateMd(STATE_WITH_ONE_ENTRY);
    expect(parsed).not.toBeNull();
    const result = parseMissionStatus(parsed.frontmatter);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m-1');
    expect(result[0].task).toBe('foo');
    expect(result[0].wave).toBe(1);
    expect(result[0].status).toBe('brainstormed');
  });

  it('returns null when STATE.md does not have a mission-status key', () => {
    const parsed = parseStateMd(BASE_STATE);
    expect(parsed).not.toBeNull();
    expect(parseMissionStatus(parsed.frontmatter)).toBeNull();
  });

  it('returns empty array when STATE.md has mission-status: [] (flow scalar)', () => {
    const parsed = parseStateMd(STATE_WITH_EMPTY_MISSION_STATUS);
    expect(parsed).not.toBeNull();
    const result = parseMissionStatus(parsed.frontmatter);
    expect(result).toEqual([]);
  });
});
