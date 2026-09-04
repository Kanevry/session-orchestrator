/**
 * tests/lib/session-identity/own-session.test.mjs
 *
 * Unit tests for scripts/lib/session-identity/own-session.mjs (#1123).
 *
 * Every case below names the concrete bug it catches (TV-001). The shared
 * hazard is a working copy holding TWO live sessions, and the expensive
 * direction is the SILENT one: any id set narrower than what this process
 * actually carries — a gated tier, an invented phantom id — makes the session's
 * OWN manifest read `foreign`, which switches scope enforcement off for the
 * whole wave and logs it as if the guard had correctly stood down. The union's
 * own cost points the other way and is deliberate: a peer-owned `session.lock`
 * makes us enforce a peer's wave plan, which is a visible deny.
 *
 * NOTE ON ENV: `CLAUDE_CODE_SESSION_ID` is exported by the live harness, so it
 * is present in the vitest process. Every test therefore sets or deletes it
 * explicitly — a test that merely omits it would silently read the operator's
 * real session id and pass for the wrong reason.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readOwnSessionIds,
  readProcessLocalSessionIds,
  classifyManifestSession,
  MANIFEST_SESSION_KEYS,
  manifestSessionBinding,
} from '../../../scripts/lib/session-identity/own-session.mjs';

const ENV_KEY = 'CLAUDE_CODE_SESSION_ID';
let tmp;
let savedEnv;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'own-session-test-'));
  savedEnv = process.env[ENV_KEY];
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Write `.orchestrator/session.lock` into the tmp repo root. */
function writeLock(fields) {
  mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
  writeFileSync(
    join(tmp, '.orchestrator', 'session.lock'),
    JSON.stringify({
      started_at: new Date().toISOString(),
      mode: 'session',
      pid: process.pid,
      host: 'test-host',
      ttl_hours: 4,
      ...fields,
    }),
    'utf8',
  );
}

describe('readOwnSessionIds (#1123)', () => {
  it('UNIONS the hook payload id with the env var AND the lock ids', () => {
    // The bug this replaced a first-tier-wins reading to catch: with the tiers
    // gated, the READER's identity was a strict subset of the WRITER's. The
    // manifest's `session` comes from `sessionAttribution()` = the repo-global
    // `session.lock`; a payload id present at read time hid that lock tier, so
    // the session's OWN manifest classified `foreign` and the write gate
    // switched itself off for the whole wave — with an event indistinguishable
    // from correct behaviour.
    process.env[ENV_KEY] = 'ENV-SESSION';
    writeLock({ session_id: 'LOCK-SESSION', semantic_session_id: 'lock-semantic' });

    const ids = readOwnSessionIds(tmp, { hookInput: { session_id: 'HOOK-SESSION' } });

    expect([...ids].sort()).toEqual(
      ['ENV-SESSION', 'HOOK-SESSION', 'LOCK-SESSION', 'lock-semantic'].sort(),
    );
  });

  it('still resolves the env var AND the lock when the payload carries no id', () => {
    // The bug: a hook payload without a session_id (or a caller with no payload
    // at all) must still resolve every id this process legitimately carries —
    // dropping either source narrows the set toward a false `foreign`.
    process.env[ENV_KEY] = 'ENV-SESSION';
    writeLock({ session_id: 'LOCK-SESSION' });

    expect([...readOwnSessionIds(tmp, { hookInput: {} })].sort())
      .toEqual(['ENV-SESSION', 'LOCK-SESSION'].sort());
    expect([...readOwnSessionIds(tmp)].sort())
      .toEqual(['ENV-SESSION', 'LOCK-SESSION'].sort());
  });

  it('resolves a SUB-AGENT payload — own ids include parent_session_id, so the coordinator manifest is own', () => {
    // The bug (qa, HIGH): a dispatched wave agent's payload names ITSELF in
    // `session_id`, while the manifest names the COORDINATOR. Drop
    // `parent_session_id` and every agent's own set is `{subagent-uuid}`, every
    // manifest reads `foreign`, and Gate 3b allows every write of every wave —
    // each one logging an event that looks like the guard standing down
    // correctly. Asserted through the classifier, because the id set alone does
    // not show which disposition it buys.
    delete process.env[ENV_KEY];
    const ids = readOwnSessionIds(tmp, {
      hookInput: { session_id: 'SUBAGENT-UUID-3333', parent_session_id: 'COORD-UUID-1111' },
    });

    expect([...ids].sort()).toEqual(['COORD-UUID-1111', 'SUBAGENT-UUID-3333'].sort());
    expect(classifyManifestSession({ session: 'COORD-UUID-1111', wave: 2 }, ids).verdict)
      .toBe('own');
  });

  it('counts a DIVERGENT payload, env and lock id all as own — and a fourth id still as foreign', () => {
    // The bug: the three sources disagree in real harnesses — nested harnesses
    // diverge payload-vs-env (measured in `hooks/pre-bash-issue-budget.mjs`
    // `resolveSessionId`), and a session that lost the lock race writes the
    // PEER's lock id into its own manifest. Each divergence must stay `own`.
    // The second half is the security direction: the union only ADDS ids this
    // process carries, so an id from NO source is still foreign.
    process.env[ENV_KEY] = 'ENV-SESSION';
    writeLock({ session_id: 'LOCK-SESSION' });
    const ids = readOwnSessionIds(tmp, { hookInput: { session_id: 'HOOK-SESSION' } });

    expect(classifyManifestSession({ session: 'HOOK-SESSION' }, ids).verdict).toBe('own');
    expect(classifyManifestSession({ session: 'ENV-SESSION' }, ids).verdict).toBe('own');
    expect(classifyManifestSession({ session: 'LOCK-SESSION' }, ids).verdict).toBe('own');
    expect(classifyManifestSession({ session: 'NOBODY-HERE' }, ids).verdict).toBe('foreign');
  });

  it('resolves BOTH lock ids when no payload and no env var exist', () => {
    // The bug: harnesses that export no session env var (Codex CLI, Cursor) would
    // resolve NOTHING, every manifest would read `unknown`, and the whole
    // foreign-session check would be dead code on those platforms. Both ids are
    // needed because a manifest may name only the semantic form.
    delete process.env[ENV_KEY];
    writeLock({ session_id: 'LOCK-UUID', semantic_session_id: 'main-2026-01-01-session-1' });

    expect([...readOwnSessionIds(tmp)].sort()).toEqual(
      ['LOCK-UUID', 'main-2026-01-01-session-1'].sort(),
    );
  });

  it('never admits a whitespace-only id from any tier', () => {
    // The bug (development.md § env-var whitespace trap): `'   '` is TRUTHY, so a
    // naive check adds a phantom id. A phantom matches no manifest, so every
    // manifest would classify `foreign` and scope enforcement would silently
    // switch itself off repo-wide — the worst possible direction.
    process.env[ENV_KEY] = '   ';
    writeLock({ session_id: '  ', semantic_session_id: '\t' });

    expect([...readOwnSessionIds(tmp, { hookInput: { session_id: ' ' } })]).toEqual([]);
  });

  it('returns an EMPTY set for a MALFORMED lock — same as no lock at all (#1153 P7)', () => {
    // The bug: #1153 P7 replaced the `readLock()` import with a local read to
    // drop a 3249-line static closure from a module the live enforce-scope hook
    // loads on every Edit/Write. A read that is more tolerant than `readLock()`
    // would start admitting ids from a half-written or corrupt lock, where the
    // old code contributed none. Both non-ok shapes are pinned: invalid JSON,
    // and valid JSON that fails the lock schema (`pid` missing).
    delete process.env[ENV_KEY];
    mkdirSync(join(tmp, '.orchestrator'), { recursive: true });
    writeFileSync(join(tmp, '.orchestrator', 'session.lock'), '{ not json at all', 'utf8');
    expect(readOwnSessionIds(tmp).size).toBe(0);

    writeFileSync(
      join(tmp, '.orchestrator', 'session.lock'),
      JSON.stringify({ session_id: 'HALF-WRITTEN', started_at: 'x', mode: 'session', host: 'h', ttl_hours: 4 }),
      'utf8',
    );
    expect(readOwnSessionIds(tmp).size).toBe(0);
  });

  it('returns an EMPTY set — never throws — when nothing resolves', () => {
    // The bug: an unresolvable identity must be reported as such so the caller
    // can fall through unchanged. Throwing here would take a PreToolUse guard
    // down with it; guessing would disarm it.
    delete process.env[ENV_KEY];
    const ids = readOwnSessionIds(join(tmp, 'does-not-exist'), { hookInput: null });
    expect(ids).toBeInstanceOf(Set);
    expect(ids.size).toBe(0);
  });
});

describe('classifyManifestSession (#1123)', () => {
  it('classifies a matching raw session id as own', () => {
    const r = classifyManifestSession({ session: 'A', wave: 2 }, new Set(['A']));
    expect(r.verdict).toBe('own');
    expect(r.manifestIds).toEqual(['A']);
  });

  it('classifies a match on semantic_session ALONE as own', () => {
    // The bug: a harness that resolves only the semantic id (lock fallback on a
    // UUID-less harness) would read its OWN manifest as foreign and stop
    // enforcing its own wave scope.
    const r = classifyManifestSession(
      { session: 'RAW-UUID', semantic_session: 'main-2026-01-01-session-1' },
      new Set(['main-2026-01-01-session-1']),
    );
    expect(r.verdict).toBe('own');
  });

  it('classifies a manifest naming only OTHER sessions as foreign', () => {
    const r = classifyManifestSession(
      { session: 'PEER', semantic_session: 'peer-semantic' },
      new Set(['MINE']),
    );
    expect(r.verdict).toBe('foreign');
    expect(r.manifestIds).toEqual(['PEER', 'peer-semantic']);
  });

  it('classifies a manifest with NO session field as unknown, not foreign', () => {
    // The bug: treating a legacy (pre-#1123) manifest as foreign would disable
    // scope enforcement for every repo that has not adopted the field yet —
    // turning "cannot tell" into a silent feature-off.
    expect(classifyManifestSession({ wave: 2, allowedPaths: [] }, new Set(['MINE'])).verdict)
      .toBe('unknown');
    expect(classifyManifestSession({ session: '   ' }, new Set(['MINE'])).verdict)
      .toBe('unknown');
    expect(classifyManifestSession(null, new Set(['MINE'])).verdict).toBe('unknown');
  });

  it('classifies as unknown when OUR OWN identity is unresolvable', () => {
    // The bug: with an empty own-id set every manifest mismatches, so a
    // "mismatch means foreign" reading would disarm the guard on exactly the
    // harnesses that publish no session id.
    const r = classifyManifestSession({ session: 'PEER' }, new Set());
    expect(r.verdict).toBe('unknown');
    expect(r.manifestIds).toEqual(['PEER']);
  });
});

// ---------------------------------------------------------------------------
// readProcessLocalSessionIds (#1177 FX1)
// ---------------------------------------------------------------------------
//
// The bug this function exists to prevent: `readOwnSessionIds()` includes the
// `session.lock` tier, so using it to judge the LOCK ITSELF matches vacuously —
// a peer-owned lock reads as `own` 100% of the time. This sibling reads the
// process-local tiers ONLY, and never touches the working copy.

describe('readProcessLocalSessionIds (#1177 FX1)', () => {
  it('returns the hook payload ids and the env id, in tier order', () => {
    expect(
      readProcessLocalSessionIds({
        env: { CLAUDE_CODE_SESSION_ID: 'ENV' },
        hookInput: { session_id: 'HOOK', parent_session_id: 'PARENT' },
      }),
    ).toEqual(['HOOK', 'PARENT', 'ENV']);
  });

  it('returns [] when neither tier resolves — never a phantom id', () => {
    expect(readProcessLocalSessionIds({ env: {}, hookInput: null })).toEqual([]);
  });

  it('drops a whitespace-only env id (truthy but matches nothing)', () => {
    expect(readProcessLocalSessionIds({ env: { CLAUDE_CODE_SESSION_ID: '   ' } })).toEqual([]);
  });

  it('ignores a live session.lock in the cwd — only the env tier answers', () => {
    // The bug: reading the lock here makes the lock self-confirming, which is
    // exactly the peer-attribution defect (#1177 FX1). tmp carries a real lock
    // (written by the suite's own helper) and it must not appear in the result.
    writeLock({ session_id: 'LOCK-UUID', semantic_session_id: 'lock-label' });
    expect(readProcessLocalSessionIds({ env: { CLAUDE_CODE_SESSION_ID: 'ENV' } })).toEqual(['ENV']);
    // And with NO other tier to mask a reintroduced lock read: still empty.
    // This is the contract enforce-scope G3b depends on (#1194) — a lock tier
    // sneaking back would make a peer-owned lock self-confirming there.
    expect(readProcessLocalSessionIds({ env: {}, hookInput: null })).toEqual([]);
  });
});


// ---------------------------------------------------------------------------
// #1153 P2 — manifest key rename: `session`/`semantic_session` ->
// `session_id`/`semantic_session_id`, with the legacy pair still READ.
// ---------------------------------------------------------------------------

describe('manifest session-key rename (#1153 P2)', () => {
  const OWN = new Set(['RAW-UUID', 'main-2026-01-01-session-1']);

  it('classifies a manifest carrying the CURRENT key names', () => {
    const r = classifyManifestSession(
      { session_id: 'RAW-UUID', semantic_session_id: 'main-2026-01-01-session-1' },
      OWN,
    );
    expect(r.verdict).toBe('own');
    expect(r.manifestIds).toEqual(['RAW-UUID', 'main-2026-01-01-session-1']);
  });

  it('reaches the SAME verdict for the LEGACY key names (transition release)', () => {
    // A package upgraded mid-wave finds an old-format manifest on disk. Reading
    // it as UNBOUND would silently switch the hooks from stand-down to enforce.
    expect(
      classifyManifestSession({ session: 'PEER', semantic_session: 'peer-semantic' }, OWN).verdict,
    ).toBe('foreign');
    expect(classifyManifestSession({ session: 'RAW-UUID' }, OWN).verdict).toBe('own');
  });

  it('reads a HALF-migrated manifest per slot, not per manifest', () => {
    // New raw id + legacy semantic id is a real on-disk state during the
    // transition; a whole-manifest "is this legacy?" test would drop one id.
    const r = classifyManifestSession(
      { session_id: 'RAW-UUID', semantic_session: 'main-2026-01-01-session-1' },
      OWN,
    );
    expect(r.manifestIds).toEqual(['RAW-UUID', 'main-2026-01-01-session-1']);
  });

  it('is unchanged when both spellings are present and EQUAL', () => {
    const r = classifyManifestSession(
      { session_id: 'RAW-UUID', session: 'RAW-UUID' },
      OWN,
    );
    expect(r.verdict).toBe('own');
    expect(r.manifestIds).toEqual(['RAW-UUID']);
  });

  it('yields NO id for a slot whose two spellings DISAGREE (fail-closed)', () => {
    // Was: "prefers the CURRENT name". That direction was DISARMING — a peer
    // appending `"session_id": "attacker"` beside this session's legitimate
    // legacy `"session": "RAW-UUID"` made the slot resolve to an id we do not
    // carry, the verdict `foreign`, and enforce-scope stands down on `foreign`.
    // `validate-wave-scope.mjs` already calls this manifest an ERROR, but no
    // hook runs the validator. Dropping the slot collapses the verdict to
    // `unknown`, which every caller treats as "keep enforcing".
    const attacker = classifyManifestSession(
      { session_id: 'attacker', session: 'RAW-UUID' },
      OWN,
    );
    expect(attacker.manifestIds).toEqual([]);
    expect(attacker.verdict).toBe('unknown');

    // Symmetric: the conflict is a property of the slot, not of which spelling
    // holds the foreign value.
    expect(
      manifestSessionBinding({ session_id: 'RAW-UUID', session: 'PEER' }),
    ).toEqual({});

    // A conflict in ONE slot never swallows the other slot's agreement.
    expect(
      manifestSessionBinding({
        session_id: 'attacker',
        session: 'RAW-UUID',
        semantic_session_id: 'main-2026-01-01-session-1',
      }),
    ).toEqual({ semantic_session_id: 'main-2026-01-01-session-1' });
  });

  it('yields no ids for an ARRAY, which typeof calls an object', () => {
    // The array guard was dropped in an earlier rewrite while the JSDoc still
    // promised "a non-object yields no ids".
    expect(manifestSessionBinding([])).toEqual({});
    expect(manifestSessionBinding(Object.assign(['x'], { session_id: 'RAW-UUID' }))).toEqual({});
    expect(
      classifyManifestSession(Object.assign([], { session_id: 'PEER' }), OWN).verdict,
    ).toBe('unknown');
  });

  it('exports ONE key list for every reader to import', () => {
    expect(MANIFEST_SESSION_KEYS.current).toEqual(['session_id', 'semantic_session_id']);
    expect(MANIFEST_SESSION_KEYS.legacy).toEqual(['session', 'semantic_session']);
    expect(manifestSessionBinding({ semantic_session: '  padded  ' })).toEqual({
      semantic_session_id: 'padded',
    });
    expect(manifestSessionBinding(['not', 'a', 'record'])).toEqual({});
  });
});
