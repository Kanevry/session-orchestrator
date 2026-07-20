/**
 * tests/scripts/lib/auto-dialectic.test.mjs
 *
 * Unit tests for scripts/lib/auto-dialectic.mjs (Issue #506, PRD F2.5).
 * Covers: DEFAULT_CADENCE, DIALECTIC_LAST_RUN_PATH, DIALECTIC_PENDING_PATH,
 * readDialecticLastRun, readDialecticSignals, shouldDispatchAutoDialectic,
 * writeDialecticLastRun, writeDialecticPending, readDialecticPending.
 *
 * Pattern: mirrors tests/lib/auto-dream.test.mjs exactly —
 *   - mkdtempSync per test via tmp() helper
 *   - afterEach rmSync + vi.restoreAllMocks()
 *   - hardcoded expected values, no computed expectations
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_CADENCE,
  DIALECTIC_LAST_RUN_PATH,
  DIALECTIC_PENDING_PATH,
  readDialecticLastRun,
  readDialecticSignals,
  shouldDispatchAutoDialectic,
  writeDialecticLastRun,
  writeDialecticPending,
  readDialecticPending,
} from '@lib/auto-dialectic.mjs';

// ---------------------------------------------------------------------------
// tmp-dir lifecycle — mirrors auto-dream.test.mjs exactly
// ---------------------------------------------------------------------------

let tmpDirs = [];

afterEach(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  tmpDirs = [];
  vi.restoreAllMocks();
});

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'auto-dialectic-test-'));
  tmpDirs.push(d);
  return d;
}

/**
 * Create a minimal repo skeleton with .orchestrator/metrics/ dirs seeded as
 * requested. Returns { repoRoot, sessionsPath, learningsPath }.
 */
function makeFakeRepo({ sessions = [], learnings = [], lastRunAt = null } = {}) {
  const repoRoot = tmp();
  const metricsDir = join(repoRoot, '.orchestrator', 'metrics');
  mkdirSync(metricsDir, { recursive: true });

  const sessionsPath = join(metricsDir, 'sessions.jsonl');
  const learningsPath = join(metricsDir, 'learnings.jsonl');

  if (sessions.length > 0) {
    writeFileSync(sessionsPath, sessions.map((s) => JSON.stringify(s)).join('\n'), 'utf8');
  }
  if (learnings.length > 0) {
    writeFileSync(learningsPath, learnings.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
  }
  if (lastRunAt !== null) {
    const lastRunFile = join(repoRoot, DIALECTIC_LAST_RUN_PATH);
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(lastRunFile, `${lastRunAt}\n`, 'utf8');
  }

  return { repoRoot, sessionsPath, learningsPath };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Constants', () => {
  it('DEFAULT_CADENCE is 5', () => {
    expect(DEFAULT_CADENCE).toBe(5);
  });

  it('DIALECTIC_LAST_RUN_PATH is .orchestrator/dialectic-last-run', () => {
    expect(DIALECTIC_LAST_RUN_PATH).toBe('.orchestrator/dialectic-last-run');
  });

  it('DIALECTIC_PENDING_PATH is .orchestrator/dialectic-pending.md', () => {
    expect(DIALECTIC_PENDING_PATH).toBe('.orchestrator/dialectic-pending.md');
  });
});

// ---------------------------------------------------------------------------
// readDialecticLastRun
// ---------------------------------------------------------------------------

describe('readDialecticLastRun', () => {
  it('returns null when the last-run file does not exist', async () => {
    const repoRoot = tmp();
    const result = await readDialecticLastRun({ repoRoot });
    expect(result).toBe(null);
  });

  it('returns the trimmed ISO timestamp string when file has valid content', async () => {
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, DIALECTIC_LAST_RUN_PATH), '2026-05-20T10:00:00.000Z\n', 'utf8');
    const result = await readDialecticLastRun({ repoRoot });
    expect(result).toBe('2026-05-20T10:00:00.000Z');
  });

  it('returns null when file exists but is empty (whitespace only)', async () => {
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, DIALECTIC_LAST_RUN_PATH), '   \n', 'utf8');
    const result = await readDialecticLastRun({ repoRoot });
    expect(result).toBe(null);
  });

  it('returns null when file exists but contains non-parseable content', async () => {
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, DIALECTIC_LAST_RUN_PATH), 'not-a-timestamp', 'utf8');
    const result = await readDialecticLastRun({ repoRoot });
    expect(result).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// readDialecticSignals
// ---------------------------------------------------------------------------

describe('readDialecticSignals', () => {
  it('returns zero counts and null lastRunAt when .orchestrator/ is absent', async () => {
    const repoRoot = tmp(); // no .orchestrator dir seeded
    const result = await readDialecticSignals({ repoRoot });
    expect(result).toEqual({ lastRunAt: null, sessionsSinceLast: 0, learningsSinceLast: 0 });
  });

  it('counts all sessions when no lastRunAt exists (3 sessions → sessionsSinceLast: 3)', async () => {
    const { repoRoot } = makeFakeRepo({
      sessions: [
        { started_at: '2026-05-01T10:00:00Z' },
        { started_at: '2026-05-02T10:00:00Z' },
        { started_at: '2026-05-03T10:00:00Z' },
      ],
    });
    const result = await readDialecticSignals({ repoRoot });
    expect(result.lastRunAt).toBe(null);
    expect(result.sessionsSinceLast).toBe(3);
    expect(result.learningsSinceLast).toBe(0);
  });

  it('counts only sessions newer than lastRunAt', async () => {
    const { repoRoot } = makeFakeRepo({
      sessions: [
        { started_at: '2026-04-01T10:00:00Z' }, // older than lastRunAt — excluded
        { started_at: '2026-05-10T10:00:00Z' }, // newer — counted
        { started_at: '2026-05-11T10:00:00Z' }, // newer — counted
      ],
      lastRunAt: '2026-05-05T00:00:00Z',
    });
    const result = await readDialecticSignals({ repoRoot });
    expect(result.lastRunAt).toBe('2026-05-05T00:00:00Z');
    expect(result.sessionsSinceLast).toBe(2);
  });

  it('counts only learnings newer than lastRunAt using created_at field', async () => {
    const { repoRoot } = makeFakeRepo({
      learnings: [
        { created_at: '2026-04-01T00:00:00Z', id: 'old' }, // excluded
        { created_at: '2026-05-10T00:00:00Z', id: 'new1' }, // counted
        { created_at: '2026-05-12T00:00:00Z', id: 'new2' }, // counted
      ],
      lastRunAt: '2026-05-05T00:00:00Z',
    });
    const result = await readDialecticSignals({ repoRoot });
    expect(result.learningsSinceLast).toBe(2);
  });

  it('falls back to updated_at when created_at is absent for learnings', async () => {
    const { repoRoot } = makeFakeRepo({
      learnings: [
        { updated_at: '2026-05-10T00:00:00Z', id: 'via-updated' }, // counted via fallback
      ],
      lastRunAt: '2026-05-05T00:00:00Z',
    });
    const result = await readDialecticSignals({ repoRoot });
    expect(result.learningsSinceLast).toBe(1);
  });

  it('skips malformed JSONL lines silently and processes valid entries', async () => {
    const repoRoot = tmp();
    mkdirSync(join(repoRoot, '.orchestrator', 'metrics'), { recursive: true });
    const sessionsPath = join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
    writeFileSync(
      sessionsPath,
      [
        JSON.stringify({ started_at: '2026-05-01T10:00:00Z' }),
        'not-valid-json{{{',
        JSON.stringify({ started_at: '2026-05-02T10:00:00Z' }),
      ].join('\n'),
      'utf8',
    );
    const result = await readDialecticSignals({ repoRoot });
    // 2 valid lines, no lastRunAt → counts both
    expect(result.sessionsSinceLast).toBe(2);
  });

  // -------------------------------------------------------------------------
  // #535 L-2 — fs error path coverage for readDialecticSignals.
  // The try/catch around readFile (production L137-139, L161-163) swallows
  // EISDIR/EACCES silently and leaves the counter at 0. Removing the catch
  // makes these tests fail (uncaught EISDIR rejection bubbles up).
  // Uses EISDIR trick (path is a directory) — avoids fragile vi.mock.
  // -------------------------------------------------------------------------

  it('L-2: returns sessionsSinceLast=0 when sessions.jsonl readFile fails (EISDIR via directory)', async () => {
    const repoRoot = tmp();
    const metricsDir = join(repoRoot, '.orchestrator', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    // Create sessions.jsonl as a DIRECTORY — existsSync()=true, readFile()=EISDIR
    mkdirSync(join(metricsDir, 'sessions.jsonl'));
    // Seed valid learnings so its branch still works
    writeFileSync(
      join(metricsDir, 'learnings.jsonl'),
      JSON.stringify({ id: 'L1', created_at: '2026-05-10T00:00:00Z' }) + '\n',
      'utf8',
    );

    const result = await readDialecticSignals({ repoRoot });
    expect(result.sessionsSinceLast).toBe(0);
    // Learnings branch unaffected — confirms the swallow is scoped, not global
    expect(result.learningsSinceLast).toBe(1);
  });

  it('L-2: returns learningsSinceLast=0 when learnings.jsonl readFile fails (EISDIR via directory)', async () => {
    const repoRoot = tmp();
    const metricsDir = join(repoRoot, '.orchestrator', 'metrics');
    mkdirSync(metricsDir, { recursive: true });
    // Seed valid sessions
    writeFileSync(
      join(metricsDir, 'sessions.jsonl'),
      JSON.stringify({ started_at: '2026-05-01T10:00:00Z' }) + '\n',
      'utf8',
    );
    // learnings.jsonl as directory → readFile rejects with EISDIR
    mkdirSync(join(metricsDir, 'learnings.jsonl'));

    const result = await readDialecticSignals({ repoRoot });
    expect(result.learningsSinceLast).toBe(0);
    // Sessions branch unaffected
    expect(result.sessionsSinceLast).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #834 — abandoned phantom stubs excluded from cadence counting
// ---------------------------------------------------------------------------
// Mirrors tests/lib/auto-dream.test.mjs's #834 coverage exactly: sessions.jsonl
// carries phantom `status: 'abandoned'` stubs (session-close backfill records
// for sessions that ended without a real close). A burst of abandoned stubs
// must not fire /evolve --dialectic off zero real work.

describe('readDialecticSignals — #834: abandoned phantom stubs excluded from cadence count', () => {
  it('5 abandoned phantoms + 2 real sessions since last run: sessionsSinceLast counts only the 2 real sessions', async () => {
    const abandoned = Array.from({ length: 5 }, (_, i) => ({
      status: 'abandoned',
      started_at: `2026-06-0${i + 1}T08:00:00Z`,
    }));
    const real = [
      { started_at: '2026-06-10T08:00:00Z' },
      { started_at: '2026-06-11T08:00:00Z' },
    ];
    const { repoRoot } = makeFakeRepo({ sessions: [...abandoned, ...real] });
    const result = await readDialecticSignals({ repoRoot });
    expect(result.sessionsSinceLast).toBe(2);
  });
});

describe('shouldDispatchAutoDialectic — #834: cadence must not fire off abandoned phantom stubs', () => {
  it('5 abandoned + 2 real sessions (7 raw lines), cadence=5: does NOT trigger (today it would, on 7 total)', async () => {
    const abandoned = Array.from({ length: 5 }, (_, i) => ({
      status: 'abandoned',
      started_at: `2026-06-0${i + 1}T08:00:00Z`,
    }));
    const real = [
      { started_at: '2026-06-10T08:00:00Z' },
      { started_at: '2026-06-11T08:00:00Z' },
    ];
    const { repoRoot } = makeFakeRepo({ sessions: [...abandoned, ...real] });
    const result = await shouldDispatchAutoDialectic({ repoRoot, cadence: 5 });
    expect(result.trigger).toBe(false);
    expect(result.signals.sessionsSinceLast).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// shouldDispatchAutoDialectic — decision branches
// ---------------------------------------------------------------------------

describe('shouldDispatchAutoDialectic — decision branches', () => {
  it('AC3 kill-switch: cadence=0 → trigger:false, exact reason string', async () => {
    const result = await shouldDispatchAutoDialectic({
      repoRoot: '/nonexistent',
      cadence: 0,
      signals: { lastRunAt: null, sessionsSinceLast: 999, learningsSinceLast: 999 },
    });
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('kill-switch (dialectic.cadence=0)');
  });

  it('kill-switch fires before any I/O (bogus repoRoot does not error when cadence=0)', async () => {
    const result = await shouldDispatchAutoDialectic({
      repoRoot: '/path/that/does/not/exist/at/all',
      cadence: 0,
    });
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('kill-switch (dialectic.cadence=0)');
  });

  it('AC4 no-input: sessions=0 AND learnings=0 → trigger:false, exact reason string', async () => {
    const result = await shouldDispatchAutoDialectic({
      repoRoot: '/x',
      cadence: 5,
      signals: { lastRunAt: null, sessionsSinceLast: 0, learningsSinceLast: 0 },
    });
    expect(result.trigger).toBe(false);
    expect(result.reason).toBe('no-new-input-since-last-run');
  });

  it('AC1 cadence met: sessions >= cadence → trigger:true, reason starts with cadence-threshold-met', async () => {
    const result = await shouldDispatchAutoDialectic({
      repoRoot: '/x',
      cadence: 5,
      signals: { lastRunAt: null, sessionsSinceLast: 7, learningsSinceLast: 0 },
    });
    expect(result.trigger).toBe(true);
    expect(result.reason.startsWith('cadence-threshold-met')).toBe(true);
  });

  it('under-threshold: sessions < cadence but > 0 → trigger:false, reason starts with under-threshold', async () => {
    const result = await shouldDispatchAutoDialectic({
      repoRoot: '/x',
      cadence: 5,
      signals: { lastRunAt: null, sessionsSinceLast: 3, learningsSinceLast: 1 },
    });
    expect(result.trigger).toBe(false);
    expect(result.reason.startsWith('under-threshold')).toBe(true);
  });

  it('boundary: sessions exactly equal to cadence → trigger:true (>= not >)', async () => {
    const result = await shouldDispatchAutoDialectic({
      repoRoot: '/x',
      cadence: 5,
      signals: { lastRunAt: null, sessionsSinceLast: 5, learningsSinceLast: 0 },
    });
    expect(result.trigger).toBe(true);
    expect(result.reason.startsWith('cadence-threshold-met')).toBe(true);
  });

  it('result always includes a signals object', async () => {
    const signals = { lastRunAt: null, sessionsSinceLast: 2, learningsSinceLast: 0 };
    const result = await shouldDispatchAutoDialectic({ repoRoot: '/x', cadence: 5, signals });
    expect(typeof result.signals).toBe('object');
    expect(result.signals).not.toBe(null);
  });

  it('reads signals from disk when signals param is omitted', async () => {
    const { repoRoot } = makeFakeRepo({
      sessions: [
        { started_at: '2026-05-01T10:00:00Z' },
        { started_at: '2026-05-02T10:00:00Z' },
        { started_at: '2026-05-03T10:00:00Z' },
        { started_at: '2026-05-04T10:00:00Z' },
        { started_at: '2026-05-05T10:00:00Z' },
      ],
    });
    // No pre-computed signals — module must read from disk
    const result = await shouldDispatchAutoDialectic({ repoRoot, cadence: 5 });
    expect(result.trigger).toBe(true);
    expect(result.signals.sessionsSinceLast).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// writeDialecticLastRun
// ---------------------------------------------------------------------------

describe('writeDialecticLastRun', () => {
  it('writes the ISO timestamp with trailing newline and returns {ok:true, path}', async () => {
    const repoRoot = tmp();
    const ts = '2026-05-23T12:00:00.000Z';
    const result = await writeDialecticLastRun({ repoRoot, isoTimestamp: ts });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(join(repoRoot, DIALECTIC_LAST_RUN_PATH));
    expect(existsSync(result.path)).toBe(true);
    const content = readFileSync(result.path, 'utf8');
    expect(content).toBe('2026-05-23T12:00:00.000Z\n');
  });

  it('creates .orchestrator/ directory when it does not exist', async () => {
    const repoRoot = tmp();
    // No .orchestrator dir pre-created — mkdir must be called by the function
    const result = await writeDialecticLastRun({
      repoRoot,
      isoTimestamp: '2026-05-23T12:00:00.000Z',
    });
    expect(result.ok).toBe(true);
    expect(existsSync(join(repoRoot, '.orchestrator'))).toBe(true);
  });

  it('round-trips: written timestamp is readable back via readDialecticLastRun', async () => {
    const repoRoot = tmp();
    const ts = '2026-05-22T08:30:00.000Z';
    await writeDialecticLastRun({ repoRoot, isoTimestamp: ts });
    const readBack = await readDialecticLastRun({ repoRoot });
    expect(readBack).toBe('2026-05-22T08:30:00.000Z');
  });

  it('returns {ok:false, error} when isoTimestamp is missing', async () => {
    const repoRoot = tmp();
    const result = await writeDialecticLastRun({ repoRoot });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  it('returns {ok:false, error} when repoRoot is missing', async () => {
    const result = await writeDialecticLastRun({ isoTimestamp: '2026-05-23T12:00:00.000Z' });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
  });

  it('does not leave .tmp files after a successful write', async () => {
    const repoRoot = tmp();
    await writeDialecticLastRun({ repoRoot, isoTimestamp: '2026-05-23T12:00:00.000Z' });
    const orchestratorDir = join(repoRoot, '.orchestrator');
    const entries = readdirSync(orchestratorDir);
    const tmpFiles = entries.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeDialecticPending
// ---------------------------------------------------------------------------

describe('writeDialecticPending', () => {
  it('writes sidecar with YAML frontmatter + diff body, returns {path, bytes}', async () => {
    const repoRoot = tmp();
    const diff = '```diff\n-old line\n+new line\n```\n';
    const result = await writeDialecticPending({
      repoRoot,
      diff,
      sourceSession: 'sess-abc',
      model: 'claude-haiku-4-5',
      learningsIn: 3,
      sessionsIn: 5,
    });

    expect(result.path).toBe(join(repoRoot, DIALECTIC_PENDING_PATH));
    expect(typeof result.bytes).toBe('number');
    expect(result.bytes).toBeGreaterThan(0);
    expect(existsSync(result.path)).toBe(true);

    const content = readFileSync(result.path, 'utf8');
    expect(content.startsWith('---\n')).toBe(true);
    expect(content).toContain('source_session: "sess-abc"');
    expect(content).toContain('model: "claude-haiku-4-5"');
    expect(content).toContain('learnings_in: 3');
    expect(content).toContain('sessions_in: 5');
    expect(content).toContain('generated_at:');
    expect(content).toContain('```diff');
    expect(content).toContain('-old line');
    expect(content).toContain('+new line');
  });

  it('renders cards_targeted as inline JSON list in frontmatter', async () => {
    const repoRoot = tmp();
    const result = await writeDialecticPending({
      repoRoot,
      diff: 'body',
      cardsTargeted: ['card-alpha', 'card-beta'],
    });
    const content = readFileSync(result.path, 'utf8');
    expect(content).toContain('cards_targeted: ["card-alpha", "card-beta"]');
  });

  it('renders cards_targeted as null when omitted', async () => {
    const repoRoot = tmp();
    await writeDialecticPending({ repoRoot, diff: 'body' });
    const content = readFileSync(join(repoRoot, DIALECTIC_PENDING_PATH), 'utf8');
    expect(content).toContain('cards_targeted: null');
  });

  it('renders cards_targeted as empty list [] when array is empty', async () => {
    const repoRoot = tmp();
    const result = await writeDialecticPending({ repoRoot, diff: 'body', cardsTargeted: [] });
    const content = readFileSync(result.path, 'utf8');
    expect(content).toContain('cards_targeted: []');
    expect(content).not.toContain('cards_targeted: null');
  });

  it('escapes cardsTargeted entries containing quotes, backslashes, brackets, newlines', async () => {
    const repoRoot = tmp();
    const evil = 'evil-"]\\}-\n-injected';
    const result = await writeDialecticPending({ repoRoot, diff: 'body', cardsTargeted: ['ok', evil] });
    const content = readFileSync(result.path, 'utf8');
    // JSON.stringify escapes the embedded chars; frontmatter list still parses round-trip
    expect(content).toContain(`cards_targeted: ["ok", ${JSON.stringify(evil)}]`);
    // Spot-check: no raw newline inside the list (would break YAML)
    const lineWithList = content.split('\n').find((l) => l.startsWith('cards_targeted:'));
    expect(lineWithList).toBeDefined();
  });

  it('returns path matching repoRoot + DIALECTIC_PENDING_PATH', async () => {
    const repoRoot = tmp();
    const result = await writeDialecticPending({ repoRoot, diff: 'some content' });
    expect(result.path).toBe(join(repoRoot, '.orchestrator', 'dialectic-pending.md'));
  });

  it('bytes matches actual byte length of written content', async () => {
    const repoRoot = tmp();
    const diff = 'short diff';
    const result = await writeDialecticPending({ repoRoot, diff });
    const content = readFileSync(result.path, 'utf8');
    expect(result.bytes).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('bytes returns exact UTF-8 byte length (frozen fixture)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-23T10:00:00.000Z'));
    try {
      const repoRoot = tmp();
      const result = await writeDialecticPending({ repoRoot, diff: 'x'.repeat(50) });
      // Frozen byte count — hardcoded after running with console.log(result.bytes).
      // Fixture: diff='x'.repeat(50), generatedAt='2026-05-23T10:00:00.000Z', all other fields default.
      // Regenerate by temporarily adding console.log(result.bytes) + running once.
      expect(result.bytes).toBe(238);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not leave .tmp files after a successful write', async () => {
    const repoRoot = tmp();
    await writeDialecticPending({ repoRoot, diff: 'content' });
    const orchestratorDir = join(repoRoot, '.orchestrator');
    const entries = readdirSync(orchestratorDir);
    const tmpFiles = entries.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it('throws TypeError when diff is empty string', async () => {
    const repoRoot = tmp();
    await expect(writeDialecticPending({ repoRoot, diff: '' })).rejects.toThrow(TypeError);
  });

  it('throws TypeError when diff is not a string', async () => {
    const repoRoot = tmp();
    // @ts-ignore — intentional wrong type
    await expect(writeDialecticPending({ repoRoot, diff: 42 })).rejects.toThrow(TypeError);
  });

  it('writes usage token counts into frontmatter when provided', async () => {
    const repoRoot = tmp();
    await writeDialecticPending({
      repoRoot,
      diff: 'body',
      usage: { input_tokens: 100, output_tokens: 200 },
    });
    const content = readFileSync(join(repoRoot, DIALECTIC_PENDING_PATH), 'utf8');
    expect(content).toContain('input_tokens: 100');
    expect(content).toContain('output_tokens: 200');
  });

  // -------------------------------------------------------------------------
  // #532 MED-1 — YAML-injection PoC tests
  // Verify JSON.stringify-wrapped scalars block newline-bearing payloads from
  // breaking out of the frontmatter block (e.g. forging `status: applied`).
  // Falsifies the security fix: removing JSON.stringify on the relevant lines
  // makes these tests fail (raw newline reaches output, fence count grows).
  // -------------------------------------------------------------------------

  it('MED-1: rejects YAML frontmatter injection via newline-bearing sourceSession', async () => {
    const repoRoot = tmp();
    await writeDialecticPending({
      repoRoot,
      diff: '```diff\n-old\n+new\n```\n',
      sourceSession: 'sess-attacker\n---\nstatus: applied\ngenerated_at: 2099-01-01T00:00:00Z',
      model: 'haiku',
    });
    const content = readFileSync(join(repoRoot, DIALECTIC_PENDING_PATH), 'utf8');
    // Frontmatter must have exactly 2 `---` fences (open + close) — no injection
    const fenceMatches = content.match(/^---$/gm) || [];
    expect(fenceMatches.length).toBe(2);
    // The injected `status: applied` must NOT appear as a top-level YAML key
    expect(content).not.toMatch(/^status:\s*applied/m);
    // The value must be JSON-escaped (quoted scalar with escaped newlines)
    expect(content).toContain(
      'source_session: "sess-attacker\\n---\\nstatus: applied\\ngenerated_at: 2099-01-01T00:00:00Z"',
    );
  });

  it('MED-1: rejects YAML frontmatter injection via newline-bearing model', async () => {
    const repoRoot = tmp();
    await writeDialecticPending({
      repoRoot,
      diff: '```diff\n-old\n+new\n```\n',
      sourceSession: 'sess-x',
      model: 'haiku\n---\nstatus: applied',
    });
    const content = readFileSync(join(repoRoot, DIALECTIC_PENDING_PATH), 'utf8');
    const fenceMatches = content.match(/^---$/gm) || [];
    expect(fenceMatches.length).toBe(2);
    expect(content).not.toMatch(/^status:\s*applied/m);
    expect(content).toContain('model: "haiku\\n---\\nstatus: applied"');
  });

  // -------------------------------------------------------------------------
  // #532 LOW-2 — whitespace-only diff rejection
  // Production L316 uses `diff.trim().length === 0` to detect empty input.
  // Removing `.trim()` makes these tests fail (whitespace passes through).
  // -------------------------------------------------------------------------

  it('LOW-2: throws TypeError when diff is whitespace-only (single space)', async () => {
    const repoRoot = tmp();
    await expect(writeDialecticPending({ repoRoot, diff: ' ' })).rejects.toThrow(TypeError);
  });

  it('LOW-2: throws TypeError when diff is whitespace-only (tabs and newlines)', async () => {
    const repoRoot = tmp();
    await expect(writeDialecticPending({ repoRoot, diff: '\n\t  \n' })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// readDialecticPending
// ---------------------------------------------------------------------------

describe('readDialecticPending', () => {
  it('returns null when sidecar is absent', async () => {
    const repoRoot = tmp();
    const result = await readDialecticPending({ repoRoot });
    expect(result).toBe(null);
  });

  it('returns full file content including frontmatter when sidecar exists', async () => {
    const repoRoot = tmp();
    const diff = '```diff\n-old\n+new\n```\n';
    await writeDialecticPending({ repoRoot, diff, sourceSession: 'sess-xyz' });
    const result = await readDialecticPending({ repoRoot });
    expect(typeof result).toBe('string');
    expect(result).toContain('---');
    expect(result).toContain('source_session: "sess-xyz"');
    expect(result).toContain('```diff');
    expect(result).toContain('-old');
  });

  it('returns null when repoRoot is not provided', async () => {
    const result = await readDialecticPending({});
    expect(result).toBe(null);
  });

  it('L-2: returns null when readFile fails (EISDIR via directory at pending path)', async () => {
    const repoRoot = tmp();
    // Create dialectic-pending.md as a DIRECTORY — existsSync()=true, readFile()=EISDIR
    mkdirSync(join(repoRoot, '.orchestrator', 'dialectic-pending.md'), { recursive: true });
    const result = await readDialecticPending({ repoRoot });
    expect(result).toBe(null);
  });
});
