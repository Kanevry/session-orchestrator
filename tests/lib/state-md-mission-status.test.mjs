import { describe, it, expect } from 'vitest';
import {
  parseStateMd,
  parseMissionStatus,
  writeMissionStatus,
  setMissionStatus,
  readMissionStatus,
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

describe('parseMissionStatus', () => {
  it.each([
    ['key absent from frontmatter', {}],
    ['frontmatter is null', null],
    ['value is a scalar null (bare `mission-status:` key)', { 'mission-status': null }],
  ])('returns null when %s', (_label, frontmatter) => {
    expect(parseMissionStatus(frontmatter)).toBeNull();
  });

  it('returns an empty array when mission-status is an empty array', () => {
    const result = parseMissionStatus({ 'mission-status': [] });
    expect(result).toEqual([]);
  });

  it('returns an array of entries when mission-status is populated', () => {
    const entry = { id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' };
    const result = parseMissionStatus({ 'mission-status': [entry] });
    expect(result).toEqual([entry]);
  });

  it('returns a shallow copy — mutations do not affect the original', () => {
    const source = { 'mission-status': [{ id: 'm-1', task: 'x', wave: 1, status: 'brainstormed' }] };
    const result = parseMissionStatus(source);
    result.push({ id: 'm-extra', task: 'y', wave: 2, status: 'validated' });
    expect(source['mission-status']).toHaveLength(1);
  });
});

describe('writeMissionStatus — round-trip', () => {
  it('written mission-status survives a parse round-trip', () => {
    const entries = [
      { id: 'm-1', task: 'implement feature', wave: 2, status: 'in-dev' },
      { id: 'm-2', task: 'write tests', wave: 4, status: 'brainstormed' },
    ];
    const updated = writeMissionStatus(BASE_STATE, entries);
    const parsed = parseStateMd(updated);
    expect(parsed).not.toBeNull();
    expect(parseMissionStatus(parsed.frontmatter)).toEqual(entries);
  });
});

describe('writeMissionStatus — null/undefined delete the key', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('removes mission-status from frontmatter when %s is passed', (_label, sentinel) => {
    const withKey = writeMissionStatus(BASE_STATE, [
      { id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' },
    ]);
    const withKeyParsed = parseStateMd(withKey);
    expect(Object.prototype.hasOwnProperty.call(withKeyParsed.frontmatter, 'mission-status')).toBe(true);

    const deleted = writeMissionStatus(withKey, sentinel);
    const deletedParsed = parseStateMd(deleted);
    expect(Object.prototype.hasOwnProperty.call(deletedParsed.frontmatter, 'mission-status')).toBe(false);
  });
});

describe('writeMissionStatus — written output formatting', () => {
  it('writes each entry field on its own line in block sequence format', () => {
    // Use a task string without spaces so the serializer won't JSON-quote it
    const entries = [{ id: 'm-1', task: 'implement-feature', wave: 3, status: 'validated' }];
    const result = writeMissionStatus(BASE_STATE, entries);
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

describe('parseMissionStatus — integrated with parseStateMd', () => {
  it('extracts entries from a STATE.md with one mission-status block-seq entry', () => {
    const parsed = parseStateMd(STATE_WITH_ONE_ENTRY);
    expect(parsed).not.toBeNull();
    expect(parseMissionStatus(parsed.frontmatter)).toEqual([
      { id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' },
    ]);
  });

  it('returns null when STATE.md does not have a mission-status key', () => {
    const parsed = parseStateMd(BASE_STATE);
    expect(parsed).not.toBeNull();
    expect(parseMissionStatus(parsed.frontmatter)).toBeNull();
  });

  it('returns empty array when STATE.md has mission-status: [] (flow scalar)', () => {
    const parsed = parseStateMd(STATE_WITH_EMPTY_MISSION_STATUS);
    expect(parsed).not.toBeNull();
    expect(parseMissionStatus(parsed.frontmatter)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// setMissionStatus — characterization + the #960 frontmatter sync
//
// Nameable bug these guard: the frontmatter reader (parseMissionStatus, consumed
// by vault-status/narrative-mirror.mjs and session-end Phase 1.9/1.10) reported a
// status the live body writer (setMissionStatus) never wrote, because the two
// sat on different surfaces of STATE.md.
// ---------------------------------------------------------------------------

/** Frontmatter array AND body section populated — both surfaces in agreement. */
const STATE_BOTH_SURFACES = `---
schema-version: 1
status: active
mission-status:
  - id: m-1
    task: foo
    wave: 1
    status: brainstormed
  - id: m-2
    task: bar
    wave: 2
    status: validated
---

## Mission Status

- m-1: brainstormed (updated 2026-07-31T00:00:00.000Z)
- m-2: validated (updated 2026-07-31T00:00:00.000Z)
`;

/** Frontmatter array populated, body has NO `## Mission Status` section yet. */
const STATE_FM_ONLY = `---
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

/** Frontmatter array populated, `## Mission Status` section present but bullet-less. */
const STATE_EMPTY_SECTION = `---
schema-version: 1
status: active
mission-status:
  - id: m-1
    task: foo
    wave: 1
    status: brainstormed
---

## Mission Status

## Next Section
`;

/** Body section present, frontmatter carries no mission-status key at all. */
const STATE_BODY_ONLY = `---
schema-version: 1
status: active
---

## Mission Status

- m-1: brainstormed (updated 2026-07-31T00:00:00.000Z)
`;

/** Legacy state: a body entry exists, but its frontmatter registry is empty. */
const STATE_LEGACY_EMPTY_FRONTMATTER_WITH_BODY = `---
schema-version: 1
status: active
mission-status: []
---

## Mission Status
- m-1: completed (updated 2026-08-20T00:00:00.000Z)
`;

describe('setMissionStatus', () => {
  it('round-trips: frontmatter reader and body reader both report the new status', () => {
    const out = setMissionStatus(STATE_BOTH_SURFACES, 'm-1', 'in-dev');

    // Body surface
    expect(readMissionStatus(out, 'm-1')).toBe('in-dev');
    // Frontmatter surface — the reader that drifted before #960
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', task: 'foo', wave: 1, status: 'in-dev' },
      { id: 'm-2', task: 'bar', wave: 2, status: 'validated' },
    ]);
    // Sibling untouched on the body surface too
    expect(readMissionStatus(out, 'm-2')).toBe('validated');
  });

  it.each([
    ['section absent — created', STATE_FM_ONLY],
    ['section present but bullet-less', STATE_EMPTY_SECTION],
  ])('syncs both surfaces when the body %s', (_label, fixture) => {
    const out = setMissionStatus(fixture, 'm-1', 'testing');
    expect(readMissionStatus(out, 'm-1')).toBe('testing');
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', task: 'foo', wave: 1, status: 'testing' },
    ]);
  });

  it('appends a new id to a populated registry without touching existing metadata', () => {
    const out = setMissionStatus(STATE_BOTH_SURFACES, 'm-9', 'completed');
    expect(readMissionStatus(out, 'm-9')).toBe('completed');
    // The merge is a SUPERSET: m-1/m-2 keep their `task`/`wave`, and the new id
    // is mirrored as the same truthful partial entry the empty-registry recovery
    // already produces. Pinning "m-9 never appears" was pinning #1084 itself --
    // update-only mirroring is why the registry froze after its first recovery.
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', task: 'foo', wave: 1, status: 'brainstormed' },
      { id: 'm-2', task: 'bar', wave: 2, status: 'validated' },
      { id: 'm-9', status: 'completed' },
    ]);
  });

  it('keeps body and frontmatter ids equal across sequential writes after a recovery', () => {
    // The #1084 revisit trigger: Phase 1.9/1.10 counts the frontmatter, a plain
    // grep counts the body. Before the superset merge this produced 1 vs 3 --
    // a plausible undercount, which is worse than the obvious zero it replaced.
    let out = STATE_LEGACY_EMPTY_FRONTMATTER_WITH_BODY;
    out = setMissionStatus(out, 'm-1', 'completed');
    out = setMissionStatus(out, 'm-2', 'in-dev');
    out = setMissionStatus(out, 'm-3', 'in-dev');

    const frontmatterIds = parseMissionStatus(parseStateMd(out).frontmatter).map((e) => e.id);
    const bodyIds = out
      .split('\n')
      .map((l) => /^- ([^:]+): /.exec(l))
      .filter((m) => m !== null)
      .map((m) => m[1]);

    expect(frontmatterIds).toEqual(['m-1', 'm-2', 'm-3']);
    expect(bodyIds).toEqual(['m-1', 'm-2', 'm-3']);
  });

  it('recovers a truthful partial entry from an empty frontmatter registry', () => {
    const out = setMissionStatus(STATE_LEGACY_EMPTY_FRONTMATTER_WITH_BODY, 'm-1', 'completed');

    expect(readMissionStatus(out, 'm-1')).toBe('completed');
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', status: 'completed' },
    ]);
  });

  it('uses the exact Mission Status heading for set, read, and recovery', () => {
    const contents = `---
schema-version: 1
status: active
mission-status: []
---

## Mission Status Notes
- m-1: notes only (updated 2026-08-20T00:00:00.000Z)
## Mission Status
- m-1: brainstormed (updated 2026-08-20T00:00:00.000Z)
`;
    const out = setMissionStatus(contents, 'm-2', 'completed');

    expect(readMissionStatus(out, 'm-1')).toBe('brainstormed');
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', status: 'brainstormed' },
      { id: 'm-2', status: 'completed' },
    ]);
  });

  it('recovers sibling body entries in order and reads full status text', () => {
    const contents = `---
schema-version: 1
status: active
mission-status: []
---

## Mission Status
- m-1: brainstormed (updated 2026-08-20T00:00:00.000Z)
- m-2: needs manual testing (updated 2026-08-20T00:00:00.000Z)
`;
    const out = setMissionStatus(contents, 'm-1', 'completed');

    expect(readMissionStatus(out, 'm-2')).toBe('needs manual testing');
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', status: 'completed' },
      { id: 'm-2', status: 'needs manual testing' },
    ]);
  });

  it.each([
    ['prose', 'manual review required'],
    ['pipe-bearing status', '- m-1: completed|testing (updated 2026-08-20T00:00:00.000Z)'],
    ['unsafe mission ID', '- m_1: completed (updated 2026-08-20T00:00:00.000Z)'],
    ['non-writer timestamp', '- m-1: completed (updated yesterday)'],
  ])('keeps an empty registry when the body contains %s', (_label, bodyLine) => {
    const contents = `---
schema-version: 1
status: active
mission-status: []
---

## Mission Status
${bodyLine}
`;
    const out = setMissionStatus(contents, 'm-2', 'completed');

    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([]);
  });

  it('keeps an empty registry when canonical body bullets duplicate an ID', () => {
    const contents = `---
schema-version: 1
status: active
mission-status: []
---

## Mission Status
- m-1: brainstormed (updated 2026-08-20T00:00:00.000Z)
- m-1: validated (updated 2026-08-20T00:00:00.000Z)
`;
    const out = setMissionStatus(contents, 'm-2', 'completed');

    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([]);
  });

  it('updates the body when frontmatter carries no mission-status array', () => {
    const out = setMissionStatus(STATE_BODY_ONLY, 'm-1', 'completed');
    expect(readMissionStatus(out, 'm-1')).toBe('completed');
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toBeNull();
  });

  it.each([
    ['contents is not a string', 123, 'm-1', 'in-dev'],
    ['taskId is empty', STATE_BOTH_SURFACES, '', 'in-dev'],
    ['status is not a string', STATE_BOTH_SURFACES, 'm-1', null],
    ['contents has no parseable frontmatter', '# no frontmatter here', 'm-1', 'in-dev'],
  ])('returns contents unchanged when %s', (_label, contents, taskId, status) => {
    expect(setMissionStatus(contents, taskId, status)).toBe(contents);
  });
});

describe('readMissionStatus — legacy body lines', () => {
  it.each([
    ['missing writer timestamp', '- m-1: in-dev', 'in-dev'],
    ['extra bullet whitespace', '-   m-1:   in-dev', 'in-dev'],
    ['annotated status', '- m-1: in-dev — task', 'in-dev'],
  ])('returns the first status token for %s', (_label, line, expected) => {
    const contents = `---
schema-version: 1
status: active
---

## Mission Status
${line}
`;

    expect(readMissionStatus(contents, 'm-1')).toBe(expected);
  });
});
