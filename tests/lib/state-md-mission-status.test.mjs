import { describe, it, expect } from 'vitest';
import {
  parseStateMd,
  parseMissionStatus,
  writeMissionStatus,
  setMissionStatus,
  readMissionStatus,
} from '@lib/state-md.mjs';
import {
  parseMissionStatusStrict,
  MISSION_STATUS_VALUES,
} from '@lib/state-md/mission-status.mjs';

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

// ─── Entry-shape validation (#1111) ──────────────────────────────────────────
//
// Bug caught: before #1111 `parseMissionStatus` returned `raw.slice()` — every
// element of the array, whatever its shape. Measured before the fix, 2026-08-24
// @ f0766e1, on `[1, 'x', null, { id: 'm-1' }, { nope: true }]`:
//   [1,"x",null,{"id":"m-1"},{"nope":true}]
// All five reached session-end Phase 1.9/1.10 (which counts them per `status`)
// and `vault-status/narrative-mirror.mjs` (which renders one table row each) as
// plausible tasks. Nothing reported them, because no validator existed.

/**
 * Verbatim copy of the block notation the live `.claude/STATE.md` frontmatter
 * carried at f0766e1 (first three entries). A COPY on purpose: a test that reads
 * the live file pins that file's state and breaks when the session moves on.
 */
const STATE_LIVE_SHAPE = `---
schema-version: 1
session-type: deep
session: main-2026-08-24-session-1
status: active
mission-status:
  - id: m-1
    task: "W1 Discovery D1-D4 (Session-Feld-Design, hostname, PRD-Eigentum, #1151-Reverify)"
    wave: 1
    status: completed
  - id: m-2
    task: "#1123 Fall 1 wave-scope Session-Feld (A1 Writer/Schema + A2 Leser) + #1082-Rest"
    wave: 2
    status: in-dev
  - id: m-10
    task: "#1111-Rest parseMissionStatus-Validierung"
    wave: 2
    status: in-dev
---

## Body
`;

describe('parseMissionStatus — entry-shape validation (#1111)', () => {
  it.each([
    ['a bare number', 1, 'not-a-mapping'],
    ['a bare string', 'm-1', 'not-a-mapping'],
    ['null', null, 'not-a-mapping'],
    ['an array', ['m-1'], 'not-a-mapping'],
    ['a flow-mangled key', { '{ id': 'm-1, task: x', status: 'brainstormed' }, 'invalid-id'],
    ['an id outside the writer grammar', { id: 'M_1', status: 'in-dev' }, 'invalid-id'],
    ['a missing status', { id: 'm-1', task: 'x', wave: 1 }, 'invalid-status'],
    ['an empty status', { id: 'm-1', status: '   ' }, 'invalid-status'],
    ['a non-scalar task', { id: 'm-1', task: { a: 1 }, status: 'in-dev' }, 'invalid-task'],
    ['a non-scalar wave', { id: 'm-1', wave: [2], status: 'in-dev' }, 'invalid-wave'],
  ])('rejects %s and reports it as %s', (_label, entry, reason) => {
    const frontmatter = { 'mission-status': [entry] };
    expect(parseMissionStatus(frontmatter)).toEqual([]);
    expect(parseMissionStatusStrict(frontmatter).invalid).toEqual([{ index: 0, reason }]);
  });

  it('keeps valid siblings and reports the reject by its RAW array index', () => {
    const good = { id: 'm-1', task: 'foo', wave: 1, status: 'in-dev' };
    const alsoGood = { id: 'm-3', task: 'bar', wave: 2, status: 'completed' };
    const strict = parseMissionStatusStrict({ 'mission-status': [good, 'junk', alsoGood] });

    expect(strict.items).toEqual([good, alsoGood]);
    expect(strict.invalid).toEqual([{ index: 1, reason: 'not-a-mapping' }]);
    expect(strict.warnings).toEqual([]);
  });

  it.each([
    ['key absent', {}],
    ['frontmatter is null', null],
    ['value is a scalar null', { 'mission-status': null }],
  ])('reports no rejects and null items when %s', (_label, frontmatter) => {
    expect(parseMissionStatusStrict(frontmatter)).toEqual({
      items: null,
      invalid: [],
      warnings: [],
    });
  });

  it('keeps a truthful partial { id, status } recovery entry', () => {
    // Regression pin for the refutation of "wave must be a positive integer":
    // `recoverFrontmatterMissionStatus` emits partial entries BY DESIGN (#1084),
    // and a reader that required the metadata would delete what the writer in
    // this very module had just produced — the two-surface divergence again.
    const out = setMissionStatus(STATE_LEGACY_EMPTY_FRONTMATTER_WITH_BODY, 'm-1', 'completed');
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', status: 'completed' },
    ]);
  });
});

describe('parseMissionStatusStrict — warnings stay in items', () => {
  it('warns on an out-of-enum status without dropping it', () => {
    // `setMissionStatus` mirrors any status onto BOTH surfaces on purpose. A
    // reader that dropped out-of-enum values would hide on the frontmatter
    // surface exactly what the writer makes visible on the body one.
    const entry = { id: 'm-1', task: 'foo', wave: 1, status: 'blocked-on-review' };
    const strict = parseMissionStatusStrict({ 'mission-status': [entry] });

    expect(strict.items).toEqual([entry]);
    expect(strict.invalid).toEqual([]);
    expect(strict.warnings).toEqual([{ index: 0, reason: 'status-not-in-enum' }]);
    expect(MISSION_STATUS_VALUES).not.toContain('blocked-on-review');
  });

  it('warns on a duplicate id', () => {
    // Bug caught: `syncFrontmatterMissionStatus` updates only the FIRST match, so
    // a duplicated id keeps a stale status forever while Phase 1.10 counts the
    // task twice.
    const strict = parseMissionStatusStrict({
      'mission-status': [
        { id: 'm-1', status: 'in-dev' },
        { id: 'm-1', status: 'completed' },
      ],
    });

    expect(strict.items).toHaveLength(2);
    expect(strict.warnings).toEqual([{ index: 1, reason: 'duplicate-id' }]);
  });

  it.each(MISSION_STATUS_VALUES)('accepts the enum value %s without warning', (status) => {
    const strict = parseMissionStatusStrict({
      'mission-status': [{ id: 'm-1', task: 'foo', wave: 1, status }],
    });
    expect(strict.warnings).toEqual([]);
    expect(strict.items).toHaveLength(1);
  });
});

describe('parseMissionStatus — live STATE.md block shape (#1111)', () => {
  it('parses the live block notation with no rejects and no warnings', () => {
    const strict = parseMissionStatusStrict(parseStateMd(STATE_LIVE_SHAPE).frontmatter);

    expect(strict.invalid).toEqual([]);
    expect(strict.warnings).toEqual([]);
    expect(strict.items).toEqual([
      {
        id: 'm-1',
        task: 'W1 Discovery D1-D4 (Session-Feld-Design, hostname, PRD-Eigentum, #1151-Reverify)',
        wave: 1,
        status: 'completed',
      },
      {
        id: 'm-2',
        task: '#1123 Fall 1 wave-scope Session-Feld (A1 Writer/Schema + A2 Leser) + #1082-Rest',
        wave: 2,
        status: 'in-dev',
      },
      { id: 'm-10', task: '#1111-Rest parseMissionStatus-Validierung', wave: 2, status: 'in-dev' },
    ]);
  });

  it('round-trips through writeMissionStatus unchanged', () => {
    const items = parseMissionStatus(parseStateMd(STATE_LIVE_SHAPE).frontmatter);
    const rewritten = writeMissionStatus(STATE_LIVE_SHAPE, items);

    expect(parseMissionStatus(parseStateMd(rewritten).frontmatter)).toEqual(items);
    // Second cycle is a byte-fixpoint — the writer's own output re-serializes identically.
    expect(writeMissionStatus(rewritten, items)).toBe(rewritten);
  });
});

// ─── One flow item must not disable the whole document (#1111 regression) ────
//
// TV-001 — the bug this catches: the #1111 fix rejected the WHOLE document
// (`parseStateMd` → `null`) as soon as ONE list item opened a flow collection.
// Every mutator in this family starts with `parseStateMd(contents); if (parsed
// === null) return contents;` — so on a STATE.md carrying 12 healthy block
// entries and one hand-written `- { … }` entry, `setMissionStatus` returned its
// input BYTE-IDENTICAL: the body bullet was never written, the frontmatter
// never synced, and the on-disk wrapper reported a successful no-op write
// (`after === before` short-circuits before any guard). Silent-wrong (#1111's
// mangled `{ id` key) had been traded for silent-absent. Measured before the
// fix, 2026-08-24: `setMissionStatus(fixture, 'm-1', 'completed') === fixture`
// → true, and `parseMissionStatus(parseStateMd(fixture).frontmatter)` → null.
// No existing test could see it: the #1111 suite feeds documents whose ONLY
// item is the flow item, where a null document and a dropped item look alike.

const TWELVE_BLOCK_ITEMS = Array.from({ length: 12 }, (_, n) =>
  `  - id: m-${n + 1}\n    task: block task ${n + 1}\n    wave: ${(n % 4) + 1}\n    status: in-dev`
).join('\n');

const STATE_WITH_ONE_FLOW_ITEM = `---
schema-version: 1
status: active
mission-status:
${TWELVE_BLOCK_ITEMS}
  - { id: m-13, task: "hand-written flow item", wave: 5, status: brainstormed }
custom-extension: keep-me
---

## Mission Status

- m-1: in-dev (updated 2026-08-24T09:00:00.000Z)
`;

describe('setMissionStatus — one flow item does not disable the document (#1111 regression)', () => {
  it('writes the body bullet instead of returning the input unchanged', () => {
    const out = setMissionStatus(STATE_WITH_ONE_FLOW_ITEM, 'm-1', 'completed');

    expect(out).not.toBe(STATE_WITH_ONE_FLOW_ITEM);
    expect(readMissionStatus(out, 'm-1')).toBe('completed');
  });

  it('mirrors the status onto the frontmatter entry of the same id', () => {
    const out = setMissionStatus(STATE_WITH_ONE_FLOW_ITEM, 'm-1', 'completed');
    const items = parseMissionStatus(parseStateMd(out).frontmatter);

    expect(items.find((e) => e.id === 'm-1').status).toBe('completed');
  });

  it('keeps all 13 entries — the 12 block items AND the flow item', () => {
    const out = setMissionStatus(STATE_WITH_ONE_FLOW_ITEM, 'm-1', 'completed');
    const items = parseMissionStatus(parseStateMd(out).frontmatter);

    expect(items).toHaveLength(13);
    expect(items.map((e) => e.id)).toEqual([
      'm-1', 'm-2', 'm-3', 'm-4', 'm-5', 'm-6', 'm-7', 'm-8', 'm-9', 'm-10', 'm-11', 'm-12', 'm-13',
    ]);
    expect(items[12]).toEqual({
      id: 'm-13',
      task: 'hand-written flow item',
      wave: 5,
      status: 'brainstormed',
    });
  });

  it('reports no invalid entries — the flow item is a valid entry, not a mangled key', () => {
    const strict = parseMissionStatusStrict(parseStateMd(STATE_WITH_ONE_FLOW_ITEM).frontmatter);

    expect(strict.invalid).toEqual([]);
    expect(strict.warnings).toEqual([]);
    // #1111's original damage: a key literally named `{ id`. Never again.
    expect(strict.items.flatMap((e) => Object.keys(e)).filter((k) => k.startsWith('{'))).toEqual([]);
  });

  it('preserves unrelated frontmatter keys through the write', () => {
    const out = setMissionStatus(STATE_WITH_ONE_FLOW_ITEM, 'm-1', 'completed');
    const { frontmatter } = parseStateMd(out);

    expect(frontmatter['custom-extension']).toBe('keep-me');
    expect(frontmatter['schema-version']).toBe(1);
    expect(frontmatter.status).toBe('active');
  });
});
