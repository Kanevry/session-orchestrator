/**
 * tests/lib/events-attribution.test.mjs
 *
 * #1177 FA3 — the correlation envelope `emitEvent()` fills when the caller
 * passed none. Every test below names the bug it catches; the load-bearing one
 * is (c): a shared working copy means `session.lock` can name a PEER session
 * that won the acquire race (#1123), and stamping that peer's id onto this
 * session's records is a WRONG correlation, not a missing one.
 *
 * Isolation: every case builds a throwaway repo root (`mkdtemp`) carrying a
 * real `.orchestrator/session.lock` and `.claude/STATE.md`, and passes it as
 * `{ repoRoot }` — so nothing here reads or writes the live repo's ledger,
 * lock or STATE.md. `CLAUDE_CODE_SESSION_ID` is cleared per test because it is
 * the ONLY process-local identity source the fill consults (#1177 FX1 removed
 * STATE.md from the witness set — it is a shared working-copy file written by
 * the lock holder); leaving the ambient value in place would make the outcome
 * depend on the harness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emitEvent, attributionForRecord } from '@lib/events.mjs';

const OWN_UUID = '11111111-1111-4111-8111-111111111111';
const OWN_SEMANTIC = 'main-2026-09-02-session-1';
const PEER_UUID = '22222222-2222-4222-8222-222222222222';
const PEER_SEMANTIC = 'main-2026-09-02-session-9';

let root;
let savedSessionEnv;

async function writeLock(semantic, uuid) {
  await mkdir(path.join(root, '.orchestrator'), { recursive: true });
  await writeFile(
    path.join(root, '.orchestrator', 'session.lock'),
    JSON.stringify({
      session_id: uuid,
      started_at: new Date().toISOString(),
      last_heartbeat: new Date().toISOString(),
      mode: 'session',
      pid: process.pid,
      host: 'test-host',
      host_id: 'test-host',
      ttl_hours: 4,
      semantic_session_id: semantic,
    }),
    'utf8',
  );
}

async function writeStateMd(session) {
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(
    path.join(root, '.claude', 'STATE.md'),
    `---\nsession: ${session}\nstatus: active\n---\n\n# STATE\n`,
    'utf8',
  );
}

async function writeWaveScope(scope) {
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(
    path.join(root, '.claude', 'wave-scope.json'),
    JSON.stringify(scope),
    'utf8',
  );
}

/** Emit one event into the tmp repo and return the parsed record. */
async function emitAndRead(payload = {}) {
  await emitEvent('test.event', payload, { repoRoot: root });
  const raw = await readFile(
    path.join(root, '.orchestrator', 'metrics', 'events.jsonl'),
    'utf8',
  );
  const lines = raw.trim().split('\n');
  return JSON.parse(lines[lines.length - 1]);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'events-attr-'));
  savedSessionEnv = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
});

afterEach(async () => {
  if (savedSessionEnv === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
  else process.env.CLAUDE_CODE_SESSION_ID = savedSessionEnv;
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Session keys
// ---------------------------------------------------------------------------

/** The id keys actually present on the record — absence is asserted as `{}`,
 *  which also rules out a `null`/`''` placeholder that `'k' in record` would
 *  have accepted. */
function idKeys(record) {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([k]) => k === 'session_id' || k === 'semantic_session_id',
    ),
  );
}

describe('emitEvent — session correlation (#1177 FA3)', () => {
  // Each row names the wrong answer it rules out; the assertion shape is
  // identical, so they are one table rather than seven near-copies.
  it.each([
    {
      // Bug: a fabricated placeholder id would collide across every
      // unattributed CI run and read downstream as one real session.
      label: '(a) no lock → omits BOTH keys (never null, never empty string)',
      setup: async () => { await writeStateMd(OWN_SEMANTIC); },
      payload: {},
      expected: {},
    },
    {
      // Bug (#1177 FX1): STATE.md is a SHARED working-copy file written by the
      // lock holder, so it agrees with the lock about a PEER just as readily as
      // about us. Accepting it as a witness is what let a peer's ids through in
      // (c4); this row pins the doctrine that a shared file is never a witness
      // for WHICH PROCESS is emitting.
      label: '(c6) STATE.md agrees with the lock but no env id → omits both keys',
      setup: async () => {
        await writeLock(OWN_SEMANTIC, OWN_UUID);
        await writeStateMd(OWN_SEMANTIC);
      },
      payload: {},
      expected: {},
    },
    {
      // THE bug this fixpass exists for, reproduced 2026-09-02: the peer OWNS
      // the working copy (holds the lock AND wrote STATE.md), while this
      // process's own CLAUDE_CODE_SESSION_ID says otherwise. The old union
      // `ownIds.some(id => lockIds.includes(id))` matched on the peer-written
      // STATE.md label and stamped the PEER's session_id + semantic id onto
      // this session's records; the disagreeing process-local id could not veto.
      // FALSIFICATION: restore the union (re-admit STATE.md as a witness) and
      // this row goes red with the peer's two ids.
      label: '(c4) peer holds the lock AND wrote STATE.md, env id is mine → omits both',
      setup: async () => {
        process.env.CLAUDE_CODE_SESSION_ID = OWN_UUID;
        await writeLock(PEER_SEMANTIC, PEER_UUID);
        await writeStateMd(PEER_SEMANTIC);
      },
      payload: {},
      expected: {},
    },
    {
      // THE load-bearing case: in a shared working copy the lock can be held
      // by the session that won the acquire race. Attributing this session's
      // events to that peer is a wrong correlation, which is worse than none.
      label: '(c) lock names a PEER session (#1123) → omits both keys',
      setup: async () => {
        await writeLock(PEER_SEMANTIC, PEER_UUID);
        await writeStateMd(OWN_SEMANTIC);
      },
      payload: {},
      expected: {},
    },
    {
      // Bug: treating "cannot tell" as "mine" silently re-opens (c) on every
      // harness that exports no session id and has no STATE.md yet.
      label: '(c2) lock, but no STATE.md and no env id → omits both keys',
      setup: async () => { await writeLock(PEER_SEMANTIC, PEER_UUID); },
      payload: {},
      expected: {},
    },
    {
      // The second lock-independent source: a harness that exports the session
      // id but has no STATE.md must still get its records attributed.
      label: '(c3/c5) CLAUDE_CODE_SESSION_ID equals the lock raw id → fills both',
      setup: async () => {
        process.env.CLAUDE_CODE_SESSION_ID = OWN_UUID;
        await writeLock(OWN_SEMANTIC, OWN_UUID);
      },
      payload: {},
      expected: { session_id: OWN_UUID, semantic_session_id: OWN_SEMANTIC },
    },
    {
      // Bug: mixing a caller's session_id with a lock-derived
      // semantic_session_id yields a record whose two id fields name DIFFERENT
      // sessions — silently unjoinable telemetry.
      label: '(d) caller-supplied session_id → untouched, no semantic id added',
      setup: async () => {
        await writeLock(OWN_SEMANTIC, OWN_UUID);
        await writeStateMd(OWN_SEMANTIC);
      },
      payload: { session_id: 'x' },
      expected: { session_id: 'x' },
    },
    {
      // vault-mirror/telemetry.mjs deliberately pins attribution to
      // SO_PROJECT_DIR and passes both keys. The fill must not rewrite them.
      label: '(f) caller passes BOTH keys (vault-mirror style) → untouched',
      setup: async () => {
        await writeLock(OWN_SEMANTIC, OWN_UUID);
        await writeStateMd(OWN_SEMANTIC);
      },
      payload: { session_id: PEER_UUID, semantic_session_id: PEER_SEMANTIC },
      expected: { session_id: PEER_UUID, semantic_session_id: PEER_SEMANTIC },
    },
  ])('$label', async ({ setup, payload, expected }) => {
    await setup();
    expect(idKeys(await emitAndRead(payload))).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// wave
// ---------------------------------------------------------------------------

describe('emitEvent — wave correlation (#1177 FA3)', () => {
  beforeEach(async () => {
    // The env id is what proves this process is the lock holder (#1177 FX1);
    // STATE.md alone no longer does, so the wave fill needs it too.
    process.env.CLAUDE_CODE_SESSION_ID = OWN_UUID;
    await writeLock(OWN_SEMANTIC, OWN_UUID);
    await writeStateMd(OWN_SEMANTIC);
  });

  it.each([
    {
      // Bug: only 4.8% of records carried `wave`, so per-wave ledger analysis
      // had to join through a second file.
      label: '(e1) OWN manifest → fills wave',
      setup: () => writeWaveScope({ wave: 3, session_id: OWN_UUID, semantic_session_id: OWN_SEMANTIC }),
      payload: {},
      expected: { wave: 3 },
    },
    {
      // Bug: wave-scope.json is a shared working-copy artefact; a peer's
      // manifest would stamp this session's events with the peer's wave number.
      label: '(e2) FOREIGN manifest → omits wave',
      setup: () => writeWaveScope({ wave: 7, session_id: PEER_UUID, semantic_session_id: PEER_SEMANTIC }),
      payload: {},
      expected: {},
    },
    {
      // Bug (#1177 FX1): an UNBOUND manifest used to be trusted as "legacy".
      // Since #1123 BOTH writers stamp the binding, so a manifest without one
      // is a peer's or a stale artefact — trusting it stamps a foreign wave.
      label: '(e3) UNBOUND (session-less) manifest → omits wave',
      setup: () => writeWaveScope({ wave: 2, allowedPaths: [] }),
      payload: {},
      expected: {},
    },
    {
      // Bug (measured): `usable` accepted a STRING, so a manifest carrying
      // `"wave": "3"` wrote the string onto the record. The live ledger is
      // 1876/1876 numeric — one string splits every downstream group-by.
      label: '(e6) manifest wave "3" (string) → coerced to the number 3',
      setup: () =>
        writeWaveScope({ wave: '3', session_id: OWN_UUID, semantic_session_id: OWN_SEMANTIC }),
      payload: {},
      expected: { wave: 3 },
    },
    {
      label: '(e7) manifest wave "abc" → omits wave (never NaN)',
      setup: () =>
        writeWaveScope({ wave: 'abc', session_id: OWN_UUID, semantic_session_id: OWN_SEMANTIC }),
      payload: {},
      expected: {},
    },
    {
      label: '(e8) manifest wave 2.5 → omits wave (never a fraction)',
      setup: () =>
        writeWaveScope({ wave: 2.5, session_id: OWN_UUID, semantic_session_id: OWN_SEMANTIC }),
      payload: {},
      expected: {},
    },
    {
      label: "(e4) caller's own wave wins over the manifest",
      setup: () => writeWaveScope({ wave: 3, semantic_session: OWN_SEMANTIC }),
      payload: { wave: 9 },
      expected: { wave: 9 },
    },
    {
      label: '(e5) no manifest at all → omits wave',
      setup: async () => {},
      payload: {},
      expected: {},
    },
  ])('$label', async ({ setup, payload, expected }) => {
    await setup();
    const record = await emitAndRead(payload);
    expect(
      Object.fromEntries(Object.entries(record).filter(([k]) => k === 'wave')),
    ).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Cost + direct helper contract
// ---------------------------------------------------------------------------

describe('attributionForRecord', () => {
  // #1207 — the title below used to read "returns {} for a root with no
  // lock", but the body writes a matching lock AND asserts the FILLED
  // attribution, not `{}`. Retitled to describe what it actually asserts;
  // the perf bound stays attached here since it needs a real filled call.
  it('fills both keys when the process-local id matches the lock, and stays well under 1 ms/call', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = OWN_UUID;
    await writeLock(OWN_SEMANTIC, OWN_UUID);
    await writeStateMd(OWN_SEMANTIC);
    expect(attributionForRecord(root)).toEqual({
      session_id: OWN_UUID,
      semantic_session_id: OWN_SEMANTIC,
    });

    const start = process.hrtime.bigint();
    for (let i = 0; i < 100; i += 1) attributionForRecord(root);
    const msPerCall = Number(process.hrtime.bigint() - start) / 1e6 / 100;
    // Generous bound: a hot path called ~34 ways must not become a file-IO tax.
    // Measured locally at ~0.02 ms/call; 1 ms is the contract in the prompt.
    expect(msPerCall).toBeLessThan(1);
  });

  // (i) — the fake-regression case (#1207/#1123): a lock naming a PEER must
  // never be handed back just because THIS process happens to carry its own
  // (different) id. Swapping the implementation for the raw `sessionAttribution()`
  // call it wraps (no process-local confirmation) turns this test red — it
  // would return the peer's ids instead of `{}`.
  it('returns {} when the lock names a PEER even though this process carries its own id', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = OWN_UUID;
    await writeLock(PEER_SEMANTIC, PEER_UUID);
    expect(attributionForRecord(root)).toEqual({});
  });

  // (ii) — no STATE.md is written here at all. Proves the fill does not
  // secretly depend on STATE.md's presence (the #1177 FX1 witness this
  // function deliberately dropped) — a regression that reintroduced a
  // STATE.md read would pass the test above (which does write STATE.md) but
  // fail this one wherever the on-disk file itself became load-bearing.
  it('fills both keys from the lock alone when the process-local id matches, with no STATE.md present', async () => {
    process.env.CLAUDE_CODE_SESSION_ID = OWN_UUID;
    await writeLock(OWN_SEMANTIC, OWN_UUID);
    expect(attributionForRecord(root)).toEqual({
      session_id: OWN_UUID,
      semantic_session_id: OWN_SEMANTIC,
    });
  });
});
