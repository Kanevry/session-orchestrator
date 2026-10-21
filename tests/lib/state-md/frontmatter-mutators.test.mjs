import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseStateMd } from '@lib/state-md/yaml-parser.mjs';
import { setMissionStatusOnDisk } from '@lib/state-md/mission-status.mjs';
import { registerSelf } from '@lib/session-registry.mjs';
import { resetStateMdToIdleOnDisk } from '@lib/state-md/idle-reset.mjs';
import {
  evaluateFrontmatterSafe,
  resolveStateArtifactPath,
  resolveStateMdPath,
  resolveStateMdWritePath,
  markStateMdCompletedOnDisk,
  touchUpdatedField,
  updateFrontmatterFields,
  updateFrontmatterFieldsOnDisk,
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

beforeEach(() => {
  vi.stubEnv('SO_PLATFORM', 'claude');
  vi.stubEnv('SO_STATE_DIR', '');
});

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
  // regression in the platform mapping (e.g. 'codex'
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

  // #1618 — the bug: with the active platform's STATE.md absent, the resolver
  // took the first EXISTING legacy candidate, so a tracked `.codex/STATE.md`
  // of a finished foreign session received this session's mission-status
  // write. A foreign-platform file is only taken for a WRITE when its
  // `session-id` names this process (CLAUDE_CODE_SESSION_ID under
  // SO_PLATFORM=claude); the read resolver keeps its legacy fallback (#890).
  // Review follow-up: the rejected write must say why (one stderr WARN plus
  // `reason: 'foreign-state-md'`) instead of a silent `written: false` — also
  // when the process carries no id at all (Cursor/Pi, a bare shell).
  it.each([
    ['foreign session-id → active path, foreign file byte-identical', 'own-1111', 'foreign-0000', '.claude'],
    ['no process-local id → fail-closed, foreign file byte-identical', '', 'cur-1', '.claude'],
    ['own raw session-id → the other-platform file is this session\'s', 'own-1111', 'own-1111', '.codex'],
  ])('%s (#1618)', async (_name, ownId, codexSessionId, expectedDirectory) => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-owner-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', ownId);
      mkdirSync(join(root, '.codex'), { recursive: true });
      const codexPath = join(root, '.codex', 'STATE.md');
      const codexState = BASE.replace('status: active', `session-id: ${codexSessionId}\nstatus: completed`)
        .replace('## Body', '## Body\n\n## Mission Status\n\n- m-1 — task (wave 1): in-dev');
      writeFileSync(codexPath, codexState, 'utf8');

      expect(resolveStateMdWritePath(root)).toBe(join(root, expectedDirectory, 'STATE.md'));
      const result = await setMissionStatusOnDisk(root, 'm-1', 'completed');
      const warned = stderr.mock.calls.some(([line]) => String(line).includes('#1618'));
      if (expectedDirectory === '.claude') {
        expect(result.written).toBe(false);
        expect(result.reason).toBe('foreign-state-md');
        expect(warned).toBe(true);
        expect(readFileSync(codexPath, 'utf8')).toBe(codexState);
      } else {
        expect(result.written).toBe(true);
        expect(warned).toBe(false);
      }
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1636 Pkt 4 review (session-80, REFUTE HIGH): a Codex shell started from
  // a live Claude session inherits the parent's CLAUDE_CODE_SESSION_ID next to
  // its own CODEX_THREAD_ID. The parent id must never prove the parent's
  // `.claude/STATE.md` own — closing it would end a live peer's record (#1640
  // class). Pinned for both rows: the parent record stays byte-identical. Since
  // #1636 Pkt 4 the shell resolves 'codex' (CODEX_THREAD_ID, detectPlatform()
  // step 3), so the default target lands in the shell's OWN `.codex` record and
  // closes it; the explicit `.claude` target is still refused.
  it.each([
    ['default target', undefined, true, 'completed'],
    ['explicit .claude target (session-end 3.4)', '.claude/STATE.md', false, 'active'],
  ])('never closes the live parent .claude record from a nested two-id shell — %s (#1636)', async (_name, statePath, expectedWritten, expectedCodexStatus) => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-1636-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (const key of ['SO_PLATFORM', 'CODEX_PLUGIN_ROOT', 'CLAUDE_PLUGIN_ROOT', 'CURSOR_RULES_DIR', 'PI_PLUGIN_ROOT']) vi.stubEnv(key, '');
      vi.stubEnv('CODEX_THREAD_ID', 'codex-1');
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'claude-parent');
      vi.stubEnv('SO_SESSION_REGISTRY_DIR', join(root, 'registry'));
      await registerSelf({ sessionId: 'claude-parent', projectRoot: root, branch: 'main', platform: 'claude', mode: 'deep' });
      mkdirSync(join(root, '.claude-plugin'), { recursive: true });
      for (const [dir, id] of [['.claude', 'claude-parent'], ['.codex', 'codex-1']]) {
        mkdirSync(join(root, dir), { recursive: true });
        writeFileSync(join(root, dir, 'STATE.md'), BASE.replace('status: active', `session-id: ${id}\nstatus: active`), 'utf8');
      }
      const parentPath = join(root, '.claude', 'STATE.md');
      const parentBefore = readFileSync(parentPath, 'utf8');

      const result = await markStateMdCompletedOnDisk(root, statePath ? { currentWave: 1, statePath } : { currentWave: 1 });
      expect(result.written).toBe(expectedWritten);
      expect(readFileSync(join(root, '.codex', 'STATE.md'), 'utf8')).toMatch(new RegExp(`^status: ${expectedCodexStatus}$`, 'm'));
      expect(readFileSync(parentPath, 'utf8')).toBe(parentBefore);
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1618 review: the idle-reset path must report the rejected foreign file
  // too, and a rejected `.codex` must NOT be reported when a later candidate
  // (`.cursor`) is this session's own and actually receives the write.
  it.each([
    ['idle reset reports a foreign-only STATE.md', 'foreign-0000', null, 'foreign-state-md'],
    ['an own later candidate silences the rejected earlier one', 'foreign-0000', 'own-1111', null],
  ])('%s (#1618)', async (_name, codexSessionId, cursorSessionId, expectedReason) => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-owner-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'own-1111');
      const write = (dir, sid) => {
        mkdirSync(join(root, dir), { recursive: true });
        const body = BASE.replace('status: active', `session-id: ${sid}\nstatus: completed`);
        writeFileSync(join(root, dir, 'STATE.md'), body, 'utf8');
        return body;
      };
      const codexState = write('.codex', codexSessionId);
      if (cursorSessionId) write('.cursor', cursorSessionId);

      const result = await resetStateMdToIdleOnDisk(root);
      const warned = stderr.mock.calls.some(([line]) => String(line).includes('#1618'));
      expect(readFileSync(join(root, '.codex', 'STATE.md'), 'utf8')).toBe(codexState);
      if (expectedReason) {
        expect(result).toMatchObject({ changed: false, reason: expectedReason });
        expect(warned).toBe(true);
      } else {
        expect(result.path).toBe(join(root, '.cursor', 'STATE.md'));
        expect(warned).toBe(false);
      }
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1640 — the bug: the ownership rule only gated LEGACY candidates, so an
  // existing active-dir `.claude/STATE.md` of a FINISHED foreign session took
  // session-end Phase 3.7a's recommendation fields while this session's own
  // record was `.orchestrator/STATE.md` (measured in growth-engine). A
  // completed foreign record is now refused loudly, never written.
  it('foreign completed .claude/STATE.md is untouched and named on stderr (#1640)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-1640-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'own-1111');
      mkdirSync(join(root, '.claude'), { recursive: true });
      mkdirSync(join(root, '.orchestrator'), { recursive: true });
      const foreignPath = join(root, '.claude', 'STATE.md');
      const foreignState = BASE.replace('status: active', 'session-id: foreign-0000\nstatus: completed');
      writeFileSync(foreignPath, foreignState, 'utf8');
      writeFileSync(join(root, '.orchestrator', 'STATE.md'), BASE.replace('status: active', 'session-id: own-1111\nstatus: active'), 'utf8');

      const result = await updateFrontmatterFieldsOnDisk(root, { 'recommended-mode': 'deep' });

      expect(readFileSync(foreignPath, 'utf8')).toBe(foreignState);
      expect(result).toMatchObject({ written: false, reason: 'foreign-state-md' });
      expect(stderr.mock.calls.some(([line]) => String(line).includes(foreignPath))).toBe(true);
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1640 review HIGH-1 — the bug: after `/clear` the process carries a NEW
  // raw id while its own ACTIVE `.claude/STATE.md` still names the old one;
  // treating that file as foreign left `/close` unable to write
  // `status: completed`. Walks the close in its documented order on ONE
  // explicit statePath (AC3): 3.7a recommendations → 3.4 completion (which
  // re-stamps `session-id` to the closing id) → a 3.7a re-run, which must
  // still find its own completed record.
  it('a /clear\'ed session closes its own active record on one statePath (#1640)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-1640-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'after-clear-2222');
      vi.stubEnv('SO_SESSION_REGISTRY_DIR', join(root, 'registry'));
      mkdirSync(join(root, '.claude'), { recursive: true });
      const ownPath = join(root, '.claude', 'STATE.md');
      writeFileSync(ownPath, BASE.replace('status: active', 'session-id: before-clear-1111\nstatus: active'), 'utf8');
      const statePath = '.claude/STATE.md';

      const rec = await updateFrontmatterFieldsOnDisk(root, { 'recommended-mode': 'deep' }, { statePath });
      const done = await markStateMdCompletedOnDisk(root, { statePath, currentWave: 3 });
      const rerun = await updateFrontmatterFieldsOnDisk(root, { 'recommended-mode': 'feature' }, { statePath });

      expect([rec.written, done.written, rerun.written]).toEqual([true, true, true]);
      expect(parseStateMd(readFileSync(ownPath, 'utf8')).frontmatter).toMatchObject({
        'session-id': 'after-clear-2222',
        status: 'completed',
        'current-wave': 3,
        'recommended-mode': 'feature',
      });
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1640 review MED-1 — the bug: Phase 3.4's completion re-stamped the
  // session-id of a LIVE parallel session's active STATE.md (peer-B) to the
  // closing session's, locking B out of its own record. Rows: B is a
  // registered peer; B is registered but idle (heartbeat 20 min old — a
  // freshness window re-opened the steal, review fix-pass 4); the registry
  // cannot be read (fail-closed).
  it.each([
    ['a live peer session owns the record', 'live'],
    ['an idle peer (20-min-old heartbeat) owns the record', 'idle'],
    ['the session registry is unreadable', 'unreadable'],
  ])('3.4 completion refuses when %s, file byte-identical (#1640)', async (_name, registry) => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-1640-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'closing-A');
      const registryDir = join(root, 'registry');
      vi.stubEnv('SO_SESSION_REGISTRY_DIR', registryDir);
      if (registry !== 'unreadable') {
        await registerSelf({ sessionId: 'peer-B', projectRoot: root, branch: 'main', platform: 'claude', mode: 'deep' });
        if (registry === 'idle') {
          const entryFile = join(registryDir, 'active', 'peer-B.json');
          const entry = JSON.parse(readFileSync(entryFile, 'utf8'));
          entry.last_heartbeat = new Date(Date.now() - 20 * 60_000).toISOString();
          writeFileSync(entryFile, JSON.stringify(entry), 'utf8');
        }
      } else {
        mkdirSync(registryDir, { recursive: true });
        writeFileSync(join(registryDir, 'active'), 'not a directory', 'utf8');
      }
      mkdirSync(join(root, '.claude'), { recursive: true });
      const peerPath = join(root, '.claude', 'STATE.md');
      const peerState = BASE.replace('status: active', 'session-id: peer-B\nstatus: active');
      writeFileSync(peerPath, peerState, 'utf8');

      const result = await markStateMdCompletedOnDisk(root, { statePath: '.claude/STATE.md', currentWave: 2 });

      expect(result).toMatchObject({ written: false, reason: 'foreign-state-md' });
      expect(readFileSync(peerPath, 'utf8')).toBe(peerState);
      expect(stderr.mock.calls.some(([line]) => String(line).includes(peerPath))).toBe(true);
    } finally {
      stderr.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // #1640 counterpart: the session-start Idle Reset IS the hand-over that
  // rewrites the previous (foreign) session's completed record — the stricter
  // write rule must not refuse it.
  it('idle reset still takes the previous session\'s completed active-dir record (#1640)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'state-md-1640-'));
    try {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'own-1111');
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude', 'STATE.md'), BASE.replace('status: active', 'session-id: prev-0000\nstatus: completed'), 'utf8');

      const result = await resetStateMdToIdleOnDisk(root);

      expect(result).toMatchObject({ changed: true, path: join(root, '.claude', 'STATE.md') });
      expect(parseStateMd(readFileSync(join(root, '.claude', 'STATE.md'), 'utf8')).frontmatter.status).toBe('idle');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function stateArtifactRepo() {
  const root = mkdtempSync(join(tmpdir(), 'state-artifact-'));
  for (const directory of ['.claude', '.codex', '.override']) {
    mkdirSync(join(root, directory));
    writeFileSync(join(root, directory, 'wave-scope.json'), '{}');
  }
  return root;
}

describe('resolveStateArtifactPath', () => {
  // Bug: an override hid active-harness fallback, and absolute overrides were joined beneath repoRoot.
  it.each([
    ['relative override', () => '.override', '.override'],
    ['absolute override', (root) => join(root, '.override'), '.override'],
    ['missing override falls back to active harness before legacy', () => '.missing', '.codex'],
  ])('honors %s', (_name, overrideFor, expectedDirectory) => {
    const root = stateArtifactRepo();
    try {
      vi.stubEnv('SO_PLATFORM', 'codex');
      vi.stubEnv('SO_STATE_DIR', overrideFor(root));
      expect(resolveStateArtifactPath(root, 'wave-scope.json')).toBe(join(root, expectedDirectory, 'wave-scope.json'));
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
