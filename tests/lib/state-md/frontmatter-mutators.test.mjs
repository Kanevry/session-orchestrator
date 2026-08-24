import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStateMd } from '@lib/state-md/yaml-parser.mjs';
import {
  evaluateFrontmatterSafe,
  resolveStateMdPath,
  touchUpdatedField,
  updateFrontmatterFields,
  writeStateMd,
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

afterEach(() => {
  vi.unstubAllEnvs();
});

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

// ─── resolveStateMdPath ─────────────────────────────────────────────────────

describe('resolveStateMdPath', () => {
  it('falls back to .pi/STATE.md when SO_PLATFORM is pi and no state file exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-path-'));
    try {
      vi.stubEnv('SO_PLATFORM', 'pi');
      expect(resolveStateMdPath(root)).toBe(join(root, '.pi', 'STATE.md'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the active platform state file when multiple STATE.md files exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-path-'));
    try {
      mkdirSync(join(root, '.claude'), { recursive: true });
      mkdirSync(join(root, '.pi'), { recursive: true });
      writeFileSync(join(root, '.claude', 'STATE.md'), BASE, 'utf8');
      writeFileSync(join(root, '.pi', 'STATE.md'), BASE, 'utf8');
      vi.stubEnv('SO_PLATFORM', 'pi');

      expect(resolveStateMdPath(root)).toBe(join(root, '.pi', 'STATE.md'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Pins the full SO_PLATFORM → state-dir routing table. Without it, a
  // regression in preferredStateMdCandidate's switch (e.g. `case 'codex'`
  // falling through to '.claude/STATE.md') is invisible: on a Codex / Cursor /
  // pi repo the create-on-first-write branch would silently plant STATE.md in
  // the wrong platform directory, and every later read resolves the stale one.
  // SO_STATE_DIR is neutralised per row because it short-circuits the switch.
  it.each([
    ['claude', '.claude'],
    ['codex', '.codex'],
    ['cursor', '.cursor'],
    ['pi', '.pi'],
  ])('routes SO_PLATFORM=%s to the %s state dir when no STATE.md exists yet', (platform, stateDir) => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-route-'));
    try {
      vi.stubEnv('SO_STATE_DIR', '');
      vi.stubEnv('SO_PLATFORM', platform);

      expect(resolveStateMdPath(root)).toBe(join(root, stateDir, 'STATE.md'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ─── One flow item does not disable the mutators (#1111 regression) ──────────
//
// TV-001 — the bug this catches: with the first #1111 fix, `parseStateMd`
// returned `null` for a whole document as soon as ONE list item opened a flow
// collection. Both mutators here open with `if (parsed === null) return
// contents;`, so on the fixture below they returned their input BYTE-IDENTICAL:
// `updated` was never touched, no key was ever set or deleted, and the on-disk
// wrappers reported a clean no-op (`after === before` short-circuits every
// guard). Measured before the fix, 2026-08-24:
// `touchUpdatedField(FLOW_ITEM_STATE, ts) === FLOW_ITEM_STATE` → true.

const FLOW_ITEM_STATE = `---
schema-version: 1
status: active
updated: 2026-04-19T17:30:00Z
custom-extension: keep-me
mission-status:
  - id: m-1
    task: block item
    wave: 1
    status: in-dev
  - { id: m-2, task: "hand-written flow item", wave: 2, status: brainstormed }
---

## Body
`;

describe('mutators — a document containing one flow list item (#1111 regression)', () => {
  it('touchUpdatedField writes the timestamp instead of returning the input unchanged', () => {
    const out = touchUpdatedField(FLOW_ITEM_STATE, '2026-05-01T12:00:00Z');

    expect(out).not.toBe(FLOW_ITEM_STATE);
    expect(parseStateMd(out).frontmatter.updated).toBe('2026-05-01T12:00:00Z');
  });

  it('updateFrontmatterFields still sets, deletes and preserves the other keys', () => {
    const out = updateFrontmatterFields(FLOW_ITEM_STATE, {
      'recommended-mode': 'feature',
      'custom-extension': null,
    });
    const { frontmatter } = parseStateMd(out);

    expect(frontmatter['recommended-mode']).toBe('feature');
    expect(Object.prototype.hasOwnProperty.call(frontmatter, 'custom-extension')).toBe(false);
    expect(frontmatter['schema-version']).toBe(1);
    expect(frontmatter.status).toBe('active');
  });

  it('carries BOTH list items through the write, the flow one included', () => {
    const out = updateFrontmatterFields(FLOW_ITEM_STATE, { status: 'completed' });

    expect(parseStateMd(out).frontmatter['mission-status']).toEqual([
      { id: 'm-1', task: 'block item', wave: 1, status: 'in-dev' },
      { id: 'm-2', task: 'hand-written flow item', wave: 2, status: 'brainstormed' },
    ]);
  });
});

// ─── evaluateFrontmatterSafe: present-but-unparseable is NOT safe ────────────
//
// The bug this catches: the guard treated `parseStateMd(after) === null` as
// SAFE across the board ("nothing frontmatter-shaped to verify"). That verdict
// is right for content with no fence and wrong for content WITH one — a write
// whose frontmatter this repo's own parser cannot read back was waved through
// by the very check meant to refuse corrupt frontmatter. The counterweight (no
// fence at all ⇒ still inert) stays pinned in frontmatter-safe-guard.test.mjs.

describe('evaluateFrontmatterSafe — fence present but unparseable', () => {
  it('reports unsafe rather than "nothing to verify"', () => {
    const unparseable = '---\nschema-version: 1\n  bad-indent: oops\n---\n\n## Body\n';

    expect(parseStateMd(unparseable)).toBeNull();
    const result = evaluateFrontmatterSafe(unparseable);
    expect(result.unsafe).toBe(true);
    expect(result.reason).toContain('could not read it back');
  });
});

// ─── A dropped list item is announced, not silently erased ──────────────────
//
// The bug this catches: the parser drops a list item it cannot represent (a flow
// SEQUENCE item — see yaml-parser.mjs `parseBlockValue`), and the FIRST write
// after that is what erases it from disk for good. Without this WARN the item is
// simply gone: the mutator reports a clean `written: true`, the file is one entry
// shorter, and nothing anywhere says why. Refusing the write instead would
// re-create the very no-op the #1111 regression fix removed, so the contract is
// "write, but say what was lost".

describe('writeStateMd — announces list items the parser could not preserve', () => {
  it('WARNs with the key, source index and reason, and still performs the write', async () => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-drop-'));
    const stderrChunks = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    try {
      vi.stubEnv('SO_STATE_DIR', '');
      vi.stubEnv('SO_PLATFORM', 'claude');
      const statePath = join(root, '.claude', 'STATE.md');
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(
        statePath,
        `---
schema-version: 1
updated: 2026-04-19T17:30:00Z
mission-status:
  - id: m-1
    status: in-dev
  - [ id: m-2, status: in-dev ]
---

## Body
`,
        'utf8'
      );

      const result = await writeStateMd(root, (contents) =>
        touchUpdatedField(contents, '2026-05-01T12:00:00Z')
      );

      expect(result.written).toBe(true);
      expect(stderrChunks.join('')).toContain('mission-status[1] (flow-sequence-item)');
      expect(parseStateMd(result.contents).frontmatter.updated).toBe('2026-05-01T12:00:00Z');
      expect(parseStateMd(result.contents).frontmatter['mission-status']).toEqual([
        { id: 'm-1', status: 'in-dev' },
      ]);
    } finally {
      stderrSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
