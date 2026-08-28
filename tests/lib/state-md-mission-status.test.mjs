import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseStateMd,
  parseMissionStatus,
  writeMissionStatus,
  setMissionStatus,
  readMissionStatus,
} from '@lib/state-md.mjs';
import {
  parseMissionStatusStrict,
  recoverFrontmatterMissionStatusDetailed,
  setMissionStatusOnDisk,
  setMissionStatusDetailed,
  MISSION_STATUS_VALUES,
} from '@lib/state-md/mission-status.mjs';

/** Builds a STATE.md with an empty registry and the given `## Mission Status` lines. */
function stateWithBodyLines(...bodyLines) {
  return `---
schema-version: 1
status: active
mission-status: []
---

## Mission Status
${bodyLines.join('\n')}
`;
}

/** `recoverFrontmatterMissionStatusDetailed` fed from a STATE.md string. */
function recoverFrom(contents) {
  const parsed = parseStateMd(contents);
  return recoverFrontmatterMissionStatusDetailed(parsed.frontmatter, parsed.body);
}

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

  // Rewritten for #1104: these four cases pinned the ALL-OR-NOTHING abort ("keeps an
  // empty registry when the body contains %s"). The contract is now per line — the
  // unreadable line is skipped, its canonical sibling still recovers — so each case
  // carries a healthy sibling (`m-7`) whose survival is the actual assertion.
  it.each([
    ['prose', 'manual review required', 'non-canonical'],
    ['pipe-bearing status', '- m-4: completed|testing (updated 2026-08-20T00:00:00.000Z)', 'unsafe-status'],
    ['unsafe mission ID', '- m_1: completed (updated 2026-08-20T00:00:00.000Z)', 'non-canonical'],
    ['non-writer timestamp', '- m-4: completed (updated yesterday)', 'non-canonical'],
  ])('skips %s and still recovers the canonical sibling', (_label, bodyLine, reason) => {
    const contents = stateWithBodyLines(
      '- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)',
      bodyLine
    );
    const out = setMissionStatus(contents, 'm-2', 'completed');

    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-7', status: 'brainstormed' },
      { id: 'm-2', status: 'completed' },
    ]);
    // Skipped means SKIPPED, never fabricated: the bad line contributes no entry.
    expect(recoverFrom(contents).skipped).toEqual([{ line: bodyLine, reason }]);
  });

  it('skips only the duplicate bullet and keeps the first occurrence', () => {
    // The FIRST bullet wins because `setMissionStatus` (in-place replace) and
    // `readMissionStatus` both operate on the first matching bullet — a recovery
    // that preferred the last would disagree with both readers on the same file.
    const contents = stateWithBodyLines(
      '- m-1: brainstormed (updated 2026-08-20T00:00:00.000Z)',
      '- m-1: validated (updated 2026-08-20T00:00:00.000Z)'
    );
    const out = setMissionStatus(contents, 'm-2', 'completed');

    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-1', status: 'brainstormed' },
      { id: 'm-2', status: 'completed' },
    ]);
    expect(recoverFrom(contents).skipped).toEqual([
      { line: '- m-1: validated (updated 2026-08-20T00:00:00.000Z)', reason: 'duplicate-id' },
    ]);
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

// ─── #1104: one unreadable body line no longer freezes the registry ──────────
//
// TV-001 — the bugs these catch:
//
// (a) `recoverFrontmatterMissionStatus` aborted the WHOLE section at the first
//     non-canonical line (`if (match === null) return frontmatter`). Census over
//     all 16 host-local `<repo>/.claude/STATE.md` (2026-08-21, issue #1104):
//     exactly ONE repo carried the #1084 shape (frontmatter `[]` + body entries),
//     and its bullets were hand-written — `- m-1 D1 ADR-Delta: completed`, no
//     `(updated <ISO>)`. So the recovery served 0 of the 1 file it was built for,
//     and every canonical sibling below that line was lost with it.
//
// (b) `setMissionStatus` gated `taskId` on `typeof taskId === 'string'` while the
//     recovery required `[a-z][a-z0-9]*(-[a-z0-9]+)*-\d+`. The writer therefore
//     produced body lines its own recovery could never read back (measured in the
//     issue: `- Docs_2: in-dev (updated …)` beside `- m-1: completed (…)`, with
//     `fm: []`), and the resulting freeze was indistinguishable from "nothing to do".

const LEGACY_HANDWRITTEN_BULLET = '- m-1 D1 ADR-Delta: completed';

describe('recovery skips per line instead of abandoning the section (#1104)', () => {
  it('recovers the canonical entry beside a hand-written legacy bullet', () => {
    const contents = stateWithBodyLines(
      LEGACY_HANDWRITTEN_BULLET,
      '- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)'
    );

    const out = setMissionStatus(contents, 'm-7', 'completed');

    // Before #1104 this was `[]`: the legacy line on row 1 aborted the merge.
    expect(parseMissionStatus(parseStateMd(out).frontmatter)).toEqual([
      { id: 'm-7', status: 'completed' },
    ]);
    // The legacy line is left in the body verbatim — skipped, never rewritten.
    expect(out).toContain(LEGACY_HANDWRITTEN_BULLET);
  });

  it('reports the skipped line and its reason through the detailed export', () => {
    const detailed = recoverFrom(
      stateWithBodyLines(
        LEGACY_HANDWRITTEN_BULLET,
        '- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)'
      )
    );

    expect(detailed.skipped).toEqual([
      { line: LEGACY_HANDWRITTEN_BULLET, reason: 'non-canonical' },
    ]);
    expect(parseMissionStatus(detailed.frontmatter)).toEqual([
      { id: 'm-7', status: 'brainstormed' },
    ]);
  });

  it('reports an empty skip list when every body line is canonical', () => {
    // The discriminator the issue asks for: "declined N lines" must not look like
    // "nothing to do". A clean body reports `[]`, a dirty one reports the lines.
    const detailed = recoverFrom(
      stateWithBodyLines('- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)')
    );

    expect(detailed.skipped).toEqual([]);
  });

  it('reports a shape-valid but impossible timestamp as invalid-timestamp', () => {
    // Distinct from `non-canonical`: this line MATCHES the writer regex — only
    // `Date` refutes it. Collapsing the two reasons would hide which half failed.
    const line = '- m-4: completed (updated 2026-02-30T00:00:00.000Z)';
    const detailed = recoverFrom(stateWithBodyLines(line));

    expect(detailed.skipped).toEqual([{ line, reason: 'invalid-timestamp' }]);
    expect(parseMissionStatus(detailed.frontmatter)).toEqual([]);
  });
});

describe('setMissionStatus refuses an id its own recovery cannot read (#1104)', () => {
  it.each([
    ['an underscore id from the issue census', 'Docs_2'],
    ['an uppercase id', 'M-1'],
    ['an id with no numeric suffix', 'docs'],
    ['the id this module\'s docblock wrongly advertised until #1104', 'w2-a10'],
  ])('returns contents unchanged for %s', (_label, taskId) => {
    const contents = stateWithBodyLines(
      '- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)'
    );

    // Before #1104: a body line `- Docs_2: in-dev (updated …)` was written, which
    // then poisoned the recovery of every OTHER line in the same section.
    expect(setMissionStatus(contents, taskId, 'in-dev')).toBe(contents);
  });

  // The gate is the grammar, not a freeze — and the docblock's example list is
  // now load-bearing, because a coordinator that copies a rejected example gets
  // a silent no-op instead of a bad line. Measured 2026-08-28: `w2-a10` (the
  // example the docblock carried until #1104) is REJECTED — hence its row above.
  it.each([['m-1'], ['docs-2'], ['w2-1'], ['w2-a-10']])(
    'writes %s — every id the docblock advertises',
    (taskId) => {
      const contents = stateWithBodyLines(
        '- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)'
      );
      const out = setMissionStatus(contents, taskId, 'in-dev');

      expect(readMissionStatus(out, taskId)).toBe('in-dev');
    }
  );
});

describe('setMissionStatusOnDisk warns about skipped body lines (#1104)', () => {
  const roots = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
  });

  function seedRepo(contents) {
    const root = mkdtempSync(join(tmpdir(), 'so-mission-status-1104-'));
    roots.push(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'STATE.md'), contents, 'utf8');
    return root;
  }

  it('emits one stderr WARN naming the count and the first reason', async () => {
    // Option 3 at the seam: the pure recovery cannot report, so the layer that
    // already does I/O must — otherwise a declined recovery is byte-identical to
    // a clean one, which is the silence this issue is about.
    const root = seedRepo(
      stateWithBodyLines(
        LEGACY_HANDWRITTEN_BULLET,
        '- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)'
      )
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await setMissionStatusOnDisk(root, 'm-7', 'completed');

    const warns = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('mission-status recovery skipped'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('skipped 1 body line(s)');
    expect(warns[0]).toContain('non-canonical');
    expect(warns[0]).toContain(LEGACY_HANDWRITTEN_BULLET);

    // The WARN reports, it never blocks: the write still lands.
    expect(result.written).toBe(true);
    expect(parseMissionStatus(parseStateMd(readFileSync(result.path, 'utf8')).frontmatter)).toEqual(
      [{ id: 'm-7', status: 'completed' }]
    );
  });

  // Bug this catches (TV-001): the recovery's merge short-circuits — `if
  // (added.length === 0) return { frontmatter, skipped }` — and the WHOLE
  // point of #1104's Option 3 is that the report survives that early return.
  // A body where EVERY bullet is non-canonical is precisely that case (the
  // measured #1104 shape: one repo, all bullets hand-written), and it is the
  // one where an operator most needs the line, because the frontmatter comes
  // back byte-identical and nothing else says why. RED if the WARN is ever
  // gated on `added.length` — a plausible "only report when we changed
  // something" refactor.
  it('reports skipped lines even when the merge adds nothing at all', async () => {
    const NON_CANONICAL = [
      '- m-1 D1 ADR-Delta: completed',
      '- m-2: done yesterday',
      '* m-3: completed (updated 2026-08-20T00:00:00.000Z)',
    ];
    const contents = stateWithBodyLines(...NON_CANONICAL);

    // Pure half: every line declined, frontmatter untouched.
    const { frontmatter, skipped } = recoverFrontmatterMissionStatusDetailed(
      parseStateMd(contents).frontmatter,
      parseStateMd(contents).body
    );
    expect(skipped).toHaveLength(NON_CANONICAL.length);
    expect(frontmatter['mission-status']).toEqual(
      parseStateMd(contents).frontmatter['mission-status']
    );

    // Seam half: the wrapper still says so.
    const root = seedRepo(contents);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await setMissionStatusOnDisk(root, 'm-9', 'completed');

    const warns = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('mission-status recovery skipped'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`skipped ${NON_CANONICAL.length} body line(s)`);
  });

  it('stays silent when every body line is canonical', async () => {
    const root = seedRepo(
      stateWithBodyLines('- m-7: brainstormed (updated 2026-08-20T00:00:00.000Z)')
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await setMissionStatusOnDisk(root, 'm-7', 'completed');

    expect(
      stderr.mock.calls
        .map(([chunk]) => String(chunk))
        .filter((line) => line.includes('mission-status recovery skipped'))
    ).toEqual([]);
  });
});

// ─── Flow-style frontmatter must never fold into `id` (#1104, 2026-08-22) ────
//
// TV-001 — the bug: session main-2026-08-22-session-3 wrote its 21 entries in
// flow style; the FIRST `updateFrontmatterFields` (for `current-wave`) folded
// each whole record into the `id` value —
//   - { id: "m-1, task: \"…\", wave: 1, status: validated}" }
// — after which `setMissionStatus(c, 'm-1', …)` no longer found `m-1`, appended
// a new entry each time, and left 42 entries (21 with `status: undefined`).
// Verbatim fixture from the issue comment, including the NO-SPACE `- {id:` form
// the existing #1111 regression block does not exercise (it uses `- { id: `).

const STATE_FLOW_STYLE_VERBATIM = `---
schema-version: 1
status: active
mission-status:
  - {id: m-1, task: "Klaeren ob PreToolUse auf AskUserQuestion feuert", wave: 1, status: validated}
---

## Mission Status

- m-1: validated (updated 2026-08-22T00:00:00.000Z)
`;

describe('flow-style mission-status survives the first frontmatter write (#1104)', () => {
  it('keeps id, task, wave and status as separate fields', () => {
    const out = setMissionStatus(STATE_FLOW_STYLE_VERBATIM, 'm-1', 'completed');
    const items = parseMissionStatus(parseStateMd(out).frontmatter);

    expect(items).toEqual([
      {
        id: 'm-1',
        task: 'Klaeren ob PreToolUse auf AskUserQuestion feuert',
        wave: 1,
        status: 'completed',
      },
    ]);
  });

  it('updates in place instead of appending a second entry for the same id', () => {
    // The silent data growth: 21 status writes produced 42 entries because the
    // mangled id never matched again.
    let out = STATE_FLOW_STYLE_VERBATIM;
    for (const status of ['in-dev', 'testing', 'completed']) {
      out = setMissionStatus(out, 'm-1', status);
    }
    const items = parseMissionStatus(parseStateMd(out).frontmatter);

    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('completed');
    expect(items.flatMap((e) => Object.keys(e)).filter((k) => k.startsWith('{'))).toEqual([]);
  });
});

// ─── every refusal names itself (2026-08-28, W4 panel ARCH-MED-5) ────────────
//
// Bug this catches (TV-001): `setMissionStatus` declines to write in FIVE ways,
// and the on-disk wrapper could name exactly ONE — it re-derived the reason by
// re-testing `MISSION_STATUS_ID_RE` itself. The other four returned `contents`
// unchanged, which `writeStateMd` reports as `written: false`: byte-identical
// to "the file already said that". Re-deriving at the seam is WHY four of five
// were invisible, so the reason now travels with the result
// (`setMissionStatusDetailed`) instead of being guessed again downstream.

describe('setMissionStatusDetailed names every refusal path', () => {
  const VALID = `---\nschema-version: 1\nmission-status: []\n---\n\n## Mission Status\n\n`;

  it.each([
    ['bad-contents', null, 'm-1', 'in-dev'],
    ['bad-id', VALID, '', 'in-dev'],
    ['bad-id', VALID, undefined, 'in-dev'],
    ['id-grammar', VALID, 'Docs_2', 'in-dev'],
    ['id-grammar', VALID, 'm1', 'in-dev'],
    ['bad-status', VALID, 'm-1', ''],
    ['unparseable', 'no frontmatter here at all', 'm-1', 'in-dev'],
  ])('refuses with %s', (reason, contents, taskId, status) => {
    const out = setMissionStatusDetailed(contents, taskId, status);

    expect(out.refused).toBe(reason);
    // A refusal never rewrites: the merge-only view is the identity here, which
    // is exactly what made it indistinguishable from a no-op write.
    expect(out.contents).toBe(contents);
    expect(setMissionStatus(contents, taskId, status)).toBe(contents);
  });

  it('omits `refused` entirely on the success path', () => {
    const out = setMissionStatusDetailed(VALID, 'm-1', 'in-dev');
    expect('refused' in out).toBe(false);
    expect(readMissionStatus(out.contents, 'm-1')).toBe('in-dev');
  });
});

describe('setMissionStatusOnDisk warns on every refusal path (#1104 follow-up)', () => {
  const roots = [];
  afterEach(() => {
    vi.restoreAllMocks();
    while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
  });

  /** @param {string|null} contents  null ⇒ leave STATE.md absent */
  function seed(contents) {
    const root = mkdtempSync(join(tmpdir(), 'so-mission-refusal-'));
    roots.push(root);
    mkdirSync(join(root, '.claude'), { recursive: true });
    if (contents !== null) writeFileSync(join(root, '.claude', 'STATE.md'), contents, 'utf8');
    return root;
  }

  const SEEDED = `---\nschema-version: 1\nmission-status: []\n---\n\n## Mission Status\n\n`;

  // `bad-contents` is unreachable through this wrapper by construction —
  // `writeStateMd` always hands the transformer a string — so the four the
  // wrapper CAN reach are enumerated here and the fifth is covered purely above.
  it.each([
    ['bad-id', SEEDED, '', 'in-dev'],
    ['id-grammar', SEEDED, 'Docs_2', 'in-dev'],
    ['bad-status', SEEDED, 'm-1', ''],
    ['unparseable', null, 'm-1', 'in-dev'],
  ])('writes one WARN naming %s and reports written:false', async (reason, contents, taskId, status) => {
    const root = seed(contents);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const result = await setMissionStatusOnDisk(root, taskId, status);

    const warns = stderr.mock.calls
      .map(([chunk]) => String(chunk))
      .filter((line) => line.includes('setMissionStatusOnDisk:'));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain(`reason: ${reason}`);
    expect(warns[0]).toContain('nothing written');

    expect(result.written).toBe(false);
    expect(result.reason).toBe(reason);
  });
});
