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

  it('PRD §3 P2 row 3: parseSessionId for a UUID-v4 (pre-P2 vintage) returns format=uuid', () => {
    const result = parseSessionId('550e8400-e29b-41d4-a716-446655440000');

    expect(result).not.toBeNull();
    expect(result.format).toBe('uuid');
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

  it('E3: only activeSessions has deep-1 → returns deep-2 (legacy path still works)', async () => {
    const result = await resolveSemanticSessionId({
      branch: 'main',
      mode: 'deep',
      activeSessions: [{ sessionId: 'main-2026-05-27-deep-1' }],
      repoRoot,
    });

    expect(result).toBe('main-2026-05-27-deep-2');
  });

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
