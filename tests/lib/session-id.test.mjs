/**
 * tests/lib/session-id.test.mjs
 *
 * Vitest suite for scripts/lib/session-id.mjs (Epic #568 P2.1 #572 + Epic #583 #585).
 *
 * Covers:
 *  - Group A: parseSessionId — dual-format (semantic + UUID + null-guards)
 *  - Group B: resolveSemanticSessionId — happy paths from PRD §3 P2 Gherkin rows
 *  - Group C: resolveSemanticSessionId — backward-compat / mixed UUID + semantic
 *  - Group D: SEMANTIC_ID_RE and UUID_V4_RE regex validation
 *  - Group E: history-aware n-increment (#585) — sessions.jsonl + STATE.md sources
 *
 * withStateMdLock is mocked to execute the callback synchronously without
 * acquiring any real lockfile, keeping the suite deterministic and fast.
 *
 * Date is pinned to 2026-05-27 via vi.useFakeTimers() in Group B/C/E tests.
 * vi.useRealTimers() is always restored in afterEach to prevent timer-leak.
 */

// ---------------------------------------------------------------------------
// Module-level mock — must be declared before imports (vitest hoists vi.mock)
// ---------------------------------------------------------------------------

vi.mock('../../scripts/lib/session-lock.mjs', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    withStateMdLock: async (_repoRoot, fn) => fn(),
  };
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveSemanticSessionId,
  parseSessionId,
  SEMANTIC_ID_RE,
  UUID_V4_RE,
} from '@lib/session-id.mjs';

// ---------------------------------------------------------------------------
// Shared tmp-dir lifecycle
// ---------------------------------------------------------------------------

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'session-id-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Group A — parseSessionId: dual-format (8 tests)
// ---------------------------------------------------------------------------

describe('Group A — parseSessionId: dual-format', () => {
  it('parses a minimal semantic id: branch=main, date=2026-05-27, mode=deep, n=1', () => {
    const result = parseSessionId('main-2026-05-27-deep-1');

    expect(result).not.toBeNull();
    expect(result.format).toBe('semantic');
    expect(result.branch).toBe('main');
    expect(result.date).toBe('2026-05-27');
    expect(result.mode).toBe('deep');
    expect(result.n).toBe(1);
    expect(result.raw).toBe('main-2026-05-27-deep-1');
  });

  it('parses a slash-branch semantic id: branch=feature/auth, mode=feature, n=3', () => {
    const result = parseSessionId('feature/auth-2026-05-27-feature-3');

    expect(result).not.toBeNull();
    expect(result.format).toBe('semantic');
    expect(result.branch).toBe('feature/auth');
    expect(result.date).toBe('2026-05-27');
    expect(result.mode).toBe('feature');
    expect(result.n).toBe(3);
    expect(result.raw).toBe('feature/auth-2026-05-27-feature-3');
  });

  // Also covers PRD §3 P2 row 3 (pre-P2 UUID vintage stays parseable) — the
  // former Group C duplicate of this case was removed as redundant (TV-002b).
  it('parses a UUID-v4 id: returns format=uuid with uuid field preserved', () => {
    const result = parseSessionId('550e8400-e29b-41d4-a716-446655440000');

    expect(result).not.toBeNull();
    expect(result.format).toBe('uuid');
    expect(result.uuid).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.raw).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns null for empty string', () => {
    const result = parseSessionId('');

    expect(result).toBeNull();
  });

  it('returns null for null input', () => {
    const result = parseSessionId(null);

    expect(result).toBeNull();
  });

  it('returns null for undefined input', () => {
    const result = parseSessionId(undefined);

    expect(result).toBeNull();
  });

  it('returns null for numeric input', () => {
    const result = parseSessionId(12345);

    expect(result).toBeNull();
  });

  it('returns null for a string that matches neither semantic nor UUID format', () => {
    const result = parseSessionId('not-a-valid-id');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group B — resolveSemanticSessionId: happy path (5 tests, PRD §3 P2 Gherkin)
// ---------------------------------------------------------------------------

describe('Group B — resolveSemanticSessionId: happy path', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
  });

  it('PRD §3 P2 row 1: empty activeSessions returns n=1', async () => {
    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-1');
  });

  it('PRD §3 P2 row 2: one matching session with n=1 returns n=2 (max+1)', async () => {
    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [{ sessionId: 'main-2026-05-27-deep-1' }],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-2');
  });

  it('non-matching date entries do not raise n — returns n=1', async () => {
    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [
        { sessionId: 'main-2026-05-26-deep-1' },
        { sessionId: 'main-2026-05-26-deep-2' },
      ],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-1');
  });

  it('gaps are never filled — returns max+1=8 when n=[1,3,7] all matching', async () => {
    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [
        { sessionId: 'main-2026-05-27-deep-1' },
        { sessionId: 'main-2026-05-27-deep-3' },
        { sessionId: 'main-2026-05-27-deep-7' },
      ],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-8');
  });

  it('mixed UUID and semantic entries — only semantic entries counted', async () => {
    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [
        { sessionId: '550e8400-e29b-41d4-a716-446655440000' },
        { sessionId: 'main-2026-05-27-deep-1' },
      ],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-2');
  });
});

// ---------------------------------------------------------------------------
// Group C — resolveSemanticSessionId: backward-compat / mixed (3 tests)
// ---------------------------------------------------------------------------

describe('Group C — resolveSemanticSessionId: backward-compat and mixed', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
  });

  it('activeSessions with only UUID entries do not count — returns n=1', async () => {
    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [
        { sessionId: '550e8400-e29b-41d4-a716-446655440000' },
        { sessionId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' },
      ],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-1');
  });

  it('roundtrip: parseSessionId on resolveSemanticSessionId output returns matching fields', async () => {
    const id = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
    });

    const parsed = parseSessionId(id);

    expect(parsed).not.toBeNull();
    expect(parsed.format).toBe('semantic');
    expect(parsed.branch).toBe('main');
    expect(parsed.date).toBe('2026-05-27');
    expect(parsed.mode).toBe('deep');
    expect(parsed.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Group D — regex validation (4 tests)
// ---------------------------------------------------------------------------

describe('Group D — SEMANTIC_ID_RE and UUID_V4_RE regex validation', () => {
  it('SEMANTIC_ID_RE matches a canonical semantic id', () => {
    expect(SEMANTIC_ID_RE.test('main-2026-05-27-deep-1')).toBe(true);
  });

  it('SEMANTIC_ID_RE matches a semantic id with leading zeros in n', () => {
    expect(SEMANTIC_ID_RE.test('main-2026-05-27-deep-001')).toBe(true);
  });

  it('SEMANTIC_ID_RE rejects uppercase characters', () => {
    expect(SEMANTIC_ID_RE.test('Main-2026-05-27-Deep-1')).toBe(false);
  });

  it('UUID_V4_RE matches a valid UUID-v4', () => {
    expect(UUID_V4_RE.test('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group D2 — AP2: parseSessionId strict-UUID rejection (#596 + #599)
//
// Verifies that the strict UUID_V4_RE (version nibble = '4', variant in
// {8,9,a,b}) causes parseSessionId to return null. The block contains TWO
// distinct case classes — do NOT conflate them (the pre-#599 comment did):
//
//   (a) DISCRIMINATING cases — a LOOSE pattern like /^[a-f0-9-]{36}$/i (the
//       looser alternative used by the test-side assertion regex in
//       tests/hooks/on-session-start.test.mjs) would WRONGLY accept these, but
//       the STRICT UUID_V4_RE rejects them. These are the load-bearing cases
//       against a loosening mutation: '36 dashes' (length 36 + only chars in
//       the loose class), the wrong VERSION nibble (1 not 4), and the wrong
//       VARIANT nibble (c not in {8,9,a,b}). Each was verified to satisfy the
//       loose regex while parseSessionId still returns null.
//
//   (b) The former GENERAL negative-input cases (empty string, plaintext) were
//       REMOVED (TV-002b): by this block's own analysis they fail ANY plausible
//       regex, do not discriminate strict-vs-loose, and duplicate Group A's
//       null-input contract tests verbatim.
//
// Surviving mutation: if UUID_V4_RE is loosened to /^[a-f0-9-]{36}$/i, the
// '36 dashes', wrong-version, and wrong-variant cases would wrongly return a
// non-null result → expect(result).toBeNull() FAILS.
// ---------------------------------------------------------------------------

describe('Group D2 — AP2: parseSessionId strict-UUID negative cases', () => {
  // DISCRIMINATING — loose /^[a-f0-9-]{36}$/i accepts, strict UUID_V4_RE rejects.
  it('returns null for 36 consecutive dashes (false-positive for loose /^[a-f0-9-]{36}$/i)', () => {
    // A loose regex /^[a-f0-9-]{36}$/i would accept this because '-' is in its
    // character class and total length is 36. UUID_V4_RE rejects it because the
    // segment structure ([0-9a-f]{8}-…) is not satisfied.
    const result = parseSessionId('-'.repeat(36));

    expect(result).toBeNull();
  });

  it('returns null for a non-v4 UUID (version nibble = 1, not 4)', () => {
    // UUID version nibble is the 13th character: '1' here vs required '4'.
    // The strict UUID_V4_RE requires the third group to start with '4'.
    // A loose /^[a-f0-9-]{36}$/i would wrongly accept this.
    const result = parseSessionId('12345678-1234-1234-1234-123456789012');

    expect(result).toBeNull();
  });

  it('#599: returns null for a wrong-VARIANT UUID (variant nibble = c, not in {8,9,a,b})', () => {
    // Version nibble is '4' (correct), but the variant nibble (first char of the
    // 4th group) is 'c' — UUID_V4_RE requires it to be one of {8,9,a,b}. This is
    // ONLY rejected by the strict variant guard: the loose /^[a-f0-9-]{36}$/i
    // would wrongly accept it (verified: loose.test === true). The existing
    // empty-string and 'not a valid id!!' cases below are killed by NON-regex
    // guards / structural mismatch, so they do NOT exercise the variant nibble —
    // this case is the only one that pins the {8,9,a,b} variant requirement.
    const result = parseSessionId('12345678-1234-4234-c234-123456789012');

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Group E — history-aware n-increment (#585): sessions.jsonl + STATE.md
// ---------------------------------------------------------------------------

// Helpers shared by E1..E9 — write real on-disk artefacts so the production
// readers exercise their actual code paths (the alternative is DI-only, which
// would skip the file-IO error handling in the helpers themselves).

function writeSessionsJsonl(root, lines) {
  const dir = join(root, '.orchestrator', 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'sessions.jsonl'), lines.map((l) => l).join('\n') + '\n', 'utf8');
}

function writeStateMd(root, frontmatterBody) {
  const dir = join(root, '.claude');
  mkdirSync(dir, { recursive: true });
  // Minimal STATE.md: frontmatter only. parseStateMd requires the closing `---\n` line.
  writeFileSync(join(dir, 'STATE.md'), `---\n${frontmatterBody}\n---\n`, 'utf8');
}

describe('Group E — history-aware n-increment (#585)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
  });

  it('E1: activeSessions=[deep-3], sessions.jsonl=[deep-1,deep-2] → returns deep-4', async () => {
    writeSessionsJsonl(repoRoot, [
      '{"session_id":"main-2026-05-27-deep-1","status":"closed"}',
      '{"session_id":"main-2026-05-27-deep-2","status":"closed"}',
    ]);

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [{ sessionId: 'main-2026-05-27-deep-3' }],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-4');
  });

  it('E2: history=[deep-1,deep-2,deep-3], activeSessions=[], STATE.md=deep-4 → returns deep-5', async () => {
    writeSessionsJsonl(repoRoot, [
      '{"session_id":"main-2026-05-27-deep-1","status":"closed"}',
      '{"session_id":"main-2026-05-27-deep-2","status":"closed"}',
      '{"session_id":"main-2026-05-27-deep-3","status":"closed"}',
    ]);
    writeStateMd(repoRoot, 'session: main-2026-05-27-deep-4');

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-5');
  });

  // E3 removed (TV-002b): "only activeSessions has deep-1 → deep-2" was a
  // verbatim duplicate of Group B "PRD §3 P2 row 2" — identical args, identical
  // expectation. The legacy-only path is additionally pinned by E8.

  it('E4: only STATE.md has deep-1, activeSessions=[], no sessions.jsonl → returns deep-2', async () => {
    writeStateMd(repoRoot, 'session: main-2026-05-27-deep-1');

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-2');
  });

  it('E5: only history has deep-1 + deep-3 (gap) → returns deep-4 (max+1, gap NOT filled)', async () => {
    writeSessionsJsonl(repoRoot, [
      '{"session_id":"main-2026-05-27-deep-1","status":"closed"}',
      '{"session_id":"main-2026-05-27-deep-3","status":"closed"}',
    ]);

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-4');
  });

  it('E6: malformed JSONL line is silently skipped, valid line still counted → returns deep-2', async () => {
    writeSessionsJsonl(repoRoot, [
      'not a json line at all',
      '{"session_id":"main-2026-05-27-deep-1","status":"closed"}',
      '{malformed without quotes}',
    ]);

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-2');
  });

  it('E7: missing sessions.jsonl + missing STATE.md → returns deep-1', async () => {
    // No files written — repoRoot is a fresh empty tmpdir.

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-1');
  });

  it('E8: consultHistory=false + consultStateMd=false → legacy behaviour (activeSessions only)', async () => {
    // History + STATE.md BOTH have deep-1..deep-5, but opt-out flags ignore them.
    writeSessionsJsonl(repoRoot, [
      '{"session_id":"main-2026-05-27-deep-1","status":"closed"}',
      '{"session_id":"main-2026-05-27-deep-2","status":"closed"}',
      '{"session_id":"main-2026-05-27-deep-3","status":"closed"}',
      '{"session_id":"main-2026-05-27-deep-4","status":"closed"}',
    ]);
    writeStateMd(repoRoot, 'session: main-2026-05-27-deep-5');

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [],
      repoRoot,
      history: { consultHistory: false, consultStateMd: false },
    });

    expect(result).toBe('main-2026-05-27-deep-1');
  });

  it('E9: invariant — next n is always strictly greater than every historical n (50 random buckets)', async () => {
    // Deterministic-but-varied bucket generator (no fast-check dep available).
    // For each iteration we synthesise a random history of (n) values for a fixed
    // (branch, date, mode) bucket and assert the returned n > max(historicalNs).
    const branch = 'main';
    const mode = 'deep';
    const today = '2026-05-27';
    let seed = 0x12345678;
    const rand = () => {
      // xorshift32 — deterministic, no Math.random dep on test order.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    const iterations = 50;
    for (let iter = 0; iter < iterations; iter += 1) {
      const len = 1 + Math.floor(rand() * 20); // 1..20 historical entries
      const historicalNs = [];
      for (let i = 0; i < len; i += 1) {
        historicalNs.push(1 + Math.floor(rand() * 1000)); // n in [1, 1000]
      }
      const readHistoryImpl = async () =>
        historicalNs.map((n) => `${branch}-${today}-${mode}-${n}`);
      const id = await resolveSemanticSessionId({
        branch,
        mode,
        activeSessions: [],
        repoRoot,
        history: { readHistoryImpl, consultStateMd: false },
      });
      const parsed = parseSessionId(id);
      expect(parsed).not.toBeNull();
      expect(parsed.format).toBe('semantic');
      // Hard invariant: returned n is strictly greater than every historical n.
      expect(parsed.n).toBe(Math.max(...historicalNs) + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Group F — events.jsonl as the fourth candidate source (#952 Teil B)
//
// The nameable bug (TV-001): a session that is killed before its SessionEnd
// hook fires never writes a sessions.jsonl record, so the `n` it consumed is
// invisible to sources A/B/C and the NEXT session mints the SAME id. STATE.md
// cannot cover the gap — it has exactly ONE `session:` slot, and an interleaved
// session of a different mode overwrites it (the mode filter then discards it).
//
// This is not hypothetical. Live ledger evidence, .orchestrator/metrics/events.jsonl:
//   06:45:11.980Z  main-2026-07-29-session-1  uuid 4c38fa82-…
//   09:32:17.445Z  main-2026-07-29-session-2  uuid 5d0a9655-…
//   17:29:48.286Z  main-2026-07-29-session-2  uuid 989a8485-…   ← same semantic id,
//                                                                  7h57m later
//
// events.jsonl is written at CLAIM time by hooks/_lib/lock-bootstrap.mjs, so a
// minted n survives a crash by construction — it is the only source that saw
// the 09:32 mint at 17:29.
//
// FIXTURE PROVENANCE (testing.md § "Fixtures Mirror Production Data"): the
// records below are the REAL 2026-07-29 lines, copied verbatim from the live
// events.jsonl. Only `host` is redacted (the original carries a resolvable
// network/institution hostname). Field set, ordering and timestamps are the
// production shape, not a shape invented to satisfy the reader.
// ---------------------------------------------------------------------------

// Golden records — do not hand-edit the field set; re-harvest from events.jsonl
// if the producer's schema changes.
const EVT_SESSION_1 =
  '{"timestamp":"2026-07-29T06:45:11.980Z","event":"orchestrator.session.lock.acquired","session_id":"4c38fa82-96c3-4621-ad5e-23f3f04a3f63","semantic_session_id":"main-2026-07-29-session-1","mode":"session","pid":79639,"host":"redacted.local","ttl_hours":4}';
const EVT_SESSION_2 =
  '{"timestamp":"2026-07-29T09:32:17.445Z","event":"orchestrator.session.lock.acquired","session_id":"5d0a9655-8b94-4808-b526-06df31a84a7e","semantic_session_id":"main-2026-07-29-session-2","mode":"session","pid":67767,"host":"redacted.local","ttl_hours":4}';
// A non-lock event, also copied from the live log — proves the event filter bites.
const EVT_AGENT_STOPPED =
  '{"timestamp":"2026-07-29T10:12:19.303Z","event":"orchestrator.agent.stopped","agent":"session-orchestrator:code-implementer"}';

function writeEventsJsonl(root, lines) {
  const dir = join(root, '.orchestrator', 'metrics');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'events.jsonl'), lines.join('\n') + '\n', 'utf8');
}

describe('Group F — events.jsonl mint-ledger source (#952)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // The real mint moment of the SECOND main-2026-07-29-session-2.
    vi.setSystemTime(new Date('2026-07-29T17:29:48.286Z'));
  });

  it('F1: reconstructs the 2026-07-29 collision — jsonl knows only session-1, events knows session-2 → session-3', async () => {
    // State of the ledger at 17:29:48, exactly as it was: session-1 closed
    // normally, deep-1 closed normally, session-2 had NOT yet written its
    // record (its SessionEnd fired at 17:29:50 — two seconds too late).
    writeSessionsJsonl(repoRoot, [
      '{"session_id":"main-2026-07-29-session-1","status":"closed"}',
      '{"session_id":"main-2026-07-29-deep-1","status":"closed"}',
    ]);
    // The single STATE.md slot was overwritten by the interleaved deep session,
    // and the mode filter discards it for mode='session'. Source C yields 0.
    writeStateMd(repoRoot, 'session: main-2026-07-29-deep-1');
    // Source D is the only one that remembers the 09:32 mint.
    writeEventsJsonl(repoRoot, [EVT_SESSION_1, EVT_AGENT_STOPPED, EVT_SESSION_2]);

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'session',
      activeSessions: [], // the 09:32 session is dead — its lockfile is gone
      repoRoot,
    });

    expect(result).toBe('main-2026-07-29-session-3');
  });

  it('F2: same fixture with consultEvents=false re-mints the collision (session-2) — the ledger is load-bearing', async () => {
    // Identical fixture to F1. The ONLY difference is the opt-out flag, so this
    // pins that source D — not some incidental other change — is what lifts n.
    writeSessionsJsonl(repoRoot, [
      '{"session_id":"main-2026-07-29-session-1","status":"closed"}',
      '{"session_id":"main-2026-07-29-deep-1","status":"closed"}',
    ]);
    writeStateMd(repoRoot, 'session: main-2026-07-29-deep-1');
    writeEventsJsonl(repoRoot, [EVT_SESSION_1, EVT_AGENT_STOPPED, EVT_SESSION_2]);

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'session',
      activeSessions: [],
      repoRoot,
      history: { consultEvents: false },
    });

    expect(result).toBe('main-2026-07-29-session-2');
  });

  it('F3: the read is a TAIL read — a >1 MiB events.jsonl still yields the last mint', async () => {
    // The reader takes a bounded 1 MiB window. A head-anchored read (or an
    // off-by-one on the offset) would silently miss today's mints on any log
    // past the window and degrade straight back to the F2 collision.
    // Pad well past 1 MiB with real-shaped non-lock events, then append the
    // 09:32 mint as the LAST record.
    const filler = new Array(12000).fill(EVT_AGENT_STOPPED);
    writeEventsJsonl(repoRoot, [EVT_SESSION_1, ...filler, EVT_SESSION_2]);

    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'session',
      activeSessions: [],
      repoRoot,
    });

    expect(result).toBe('main-2026-07-29-session-3');
  });
});
