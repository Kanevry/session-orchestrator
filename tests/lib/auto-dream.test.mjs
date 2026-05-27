/**
 * tests/lib/auto-dream.test.mjs
 *
 * Unit tests for scripts/lib/auto-dream.mjs (Issue #502, PRD F2.2).
 * Covers: readDreamSignals, shouldDispatchAutoDream, writePendingDream,
 * readPendingDream, applyPendingDream.
 *
 * Note: `resolveMemoryDir` was extracted to `scripts/lib/memory-paths.mjs`
 * in Issue #512; its tests live in `tests/lib/memory-paths.test.mjs`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  readDreamSignals,
  shouldDispatchAutoDream,
  writePendingDream,
  readPendingDream,
  applyPendingDream,
} from '@lib/auto-dream.mjs';

// ---------------------------------------------------------------------------
// tmp-dir lifecycle
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
  const d = mkdtempSync(join(tmpdir(), 'auto-dream-test-'));
  tmpDirs.push(d);
  return d;
}

/**
 * Create a fake repo skeleton with .orchestrator/metrics/sessions.jsonl and a
 * memoryDir/MEMORY.md. Returns { repoRoot, memoryDir, sessionsPath, memoryPath }.
 */
function makeFakeRepo({ memoryLines = 0, sessions = [] } = {}) {
  const repoRoot = tmp();
  const memoryDir = join(repoRoot, '_memory');
  const sessionsPath = join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
  const memoryPath = join(memoryDir, 'MEMORY.md');
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(repoRoot, '.orchestrator', 'metrics'), { recursive: true });
  if (memoryLines > 0) {
    // Write exactly memoryLines lines (n-1 newline separators).
    const body = new Array(memoryLines).fill('line').join('\n');
    writeFileSync(memoryPath, body, 'utf8');
  }
  if (sessions.length > 0) {
    const body = sessions.map((s) => JSON.stringify(s)).join('\n');
    writeFileSync(sessionsPath, body, 'utf8');
  }
  return { repoRoot, memoryDir, sessionsPath, memoryPath };
}

// ---------------------------------------------------------------------------
// readDreamSignals
// ---------------------------------------------------------------------------

describe('readDreamSignals', () => {
  it('returns memoryLines=0 when MEMORY.md does not exist', async () => {
    const { repoRoot, memoryDir } = makeFakeRepo();
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    expect(signals.memoryLines).toBe(0);
  });

  it('counts lines correctly: 3-line file returns memoryLines=3', async () => {
    const { repoRoot, memoryDir } = makeFakeRepo({ memoryLines: 3 });
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    expect(signals.memoryLines).toBe(3);
  });

  it('skips malformed JSON lines silently and processes the rest', async () => {
    const { repoRoot, memoryDir, sessionsPath } = makeFakeRepo();
    // Two valid + one malformed line
    const body = [
      JSON.stringify({ started_at: '2026-05-01T10:00:00Z', session_id: 'a' }),
      'this is not json{',
      JSON.stringify({ started_at: '2026-05-02T10:00:00Z', session_id: 'b' }),
    ].join('\n');
    writeFileSync(sessionsPath, body, 'utf8');
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    // No memory_cleanup_at exists → lastCleanupAt is null → count = all valid entries
    expect(signals.sessionsSinceCleanup).toBe(2);
    expect(signals.lastCleanupAt).toBe(null);
  });

  it('lastCleanupAt=null counts ALL valid sessions.jsonl entries', async () => {
    const { repoRoot, memoryDir } = makeFakeRepo({
      sessions: [
        { started_at: '2026-05-01T10:00:00Z' },
        { started_at: '2026-05-02T10:00:00Z' },
        { started_at: '2026-05-03T10:00:00Z' },
      ],
    });
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    expect(signals.lastCleanupAt).toBe(null);
    expect(signals.sessionsSinceCleanup).toBe(3);
  });

  it('lastCleanupAt set: counts only entries with started_at > lastCleanupAt', async () => {
    const { repoRoot, memoryDir } = makeFakeRepo({
      sessions: [
        // Older — should be excluded
        { started_at: '2026-04-01T10:00:00Z' },
        // Carries the cleanup timestamp
        { started_at: '2026-05-01T10:00:00Z', memory_cleanup_at: '2026-05-01T10:00:00Z' },
        // Newer — should be counted (2 of them)
        { started_at: '2026-05-02T10:00:00Z' },
        { started_at: '2026-05-03T10:00:00Z' },
      ],
    });
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    expect(signals.lastCleanupAt).toBe('2026-05-01T10:00:00Z');
    expect(signals.sessionsSinceCleanup).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// shouldDispatchAutoDream — decision rules
// ---------------------------------------------------------------------------

describe('shouldDispatchAutoDream', () => {
  it('threshold === 0 is a kill-switch: trigger=false even when signals would otherwise force trigger', async () => {
    // Construct signals that WOULD trip BOTH the cadence and soft-limit checks
    // (memoryLines=999 > softLimit=180; sessionsSinceCleanup=999 >> threshold=0).
    // The kill-switch must short-circuit before either condition is evaluated.
    const result = await shouldDispatchAutoDream({
      repoRoot: '/x',
      memoryDir: '/x',
      threshold: 0,
      softLimit: 180,
      signals: { memoryLines: 999, sessionsSinceCleanup: 999, lastCleanupAt: null },
    });
    expect(result.trigger).toBe(false);
    expect(result.reason).toMatch(/kill-switch/);
  });

  it('threshold === 0 kill-switch fires BEFORE any I/O probe (bogus paths do not error)', async () => {
    // Pass intentionally invalid repoRoot/memoryDir paths; the kill-switch must
    // short-circuit BEFORE any readDreamSignals call would touch disk.
    // If the kill-switch were removed, this call would still succeed (because
    // existsSync just returns false) — so the meaningful assertion is the reason.
    const result = await shouldDispatchAutoDream({
      repoRoot: '/nonexistent/path/that/should/not/be/probed',
      memoryDir: '/nonexistent/path/that/should/not/be/probed',
      threshold: 0,
      softLimit: 180,
    });
    expect(result.trigger).toBe(false);
    expect(result.reason).toMatch(/kill-switch/);
  });

  it('memoryLines > softLimit triggers dream (181 > 180)', async () => {
    const result = await shouldDispatchAutoDream({
      repoRoot: '/x',
      memoryDir: '/x',
      threshold: 5,
      softLimit: 180,
      signals: { memoryLines: 181, sessionsSinceCleanup: 0, lastCleanupAt: null },
    });
    expect(result.trigger).toBe(true);
    expect(result.reason).toMatch(/memory-soft-limit-exceeded/);
  });

  it('memoryLines === softLimit does NOT trigger (boundary: 180 == 180)', async () => {
    const result = await shouldDispatchAutoDream({
      repoRoot: '/x',
      memoryDir: '/x',
      threshold: 5,
      softLimit: 180,
      signals: { memoryLines: 180, sessionsSinceCleanup: 0, lastCleanupAt: null },
    });
    expect(result.trigger).toBe(false);
  });

  it('sessionsSinceCleanup >= threshold triggers (5 >= 5)', async () => {
    const result = await shouldDispatchAutoDream({
      repoRoot: '/x',
      memoryDir: '/x',
      threshold: 5,
      softLimit: 180,
      signals: { memoryLines: 0, sessionsSinceCleanup: 5, lastCleanupAt: null },
    });
    expect(result.trigger).toBe(true);
    expect(result.reason).toMatch(/cadence-threshold-met/);
  });

  it('sessionsSinceCleanup === threshold - 1 does NOT trigger (4 < 5)', async () => {
    const result = await shouldDispatchAutoDream({
      repoRoot: '/x',
      memoryDir: '/x',
      threshold: 5,
      softLimit: 180,
      signals: { memoryLines: 0, sessionsSinceCleanup: 4, lastCleanupAt: null },
    });
    expect(result.trigger).toBe(false);
    expect(result.reason).toMatch(/under-thresholds/);
  });
});

// ---------------------------------------------------------------------------
// writePendingDream — input validation + atomic write
// ---------------------------------------------------------------------------

describe('writePendingDream', () => {
  it('rejects empty diff with a TypeError', async () => {
    const repoRoot = tmp();
    await expect(writePendingDream({ repoRoot, diff: '' })).rejects.toThrow(TypeError);
  });

  it('rejects non-string diff with a TypeError', async () => {
    const repoRoot = tmp();
    // @ts-ignore — passing wrong type on purpose to test runtime guard
    await expect(writePendingDream({ repoRoot, diff: 12345 })).rejects.toThrow(TypeError);
  });

  it('writes the sidecar at .orchestrator/pending-dream.md with frontmatter + diff body', async () => {
    const repoRoot = tmp();
    const diff = '```diff\n-old\n+new\n```\n';
    const result = await writePendingDream({
      repoRoot,
      diff,
      sourceSession: 'sess-123',
      memoryLinesBefore: 200,
      proposedLinesAfter: 150,
    });

    expect(result.path).toBe(join(repoRoot, '.orchestrator', 'pending-dream.md'));
    expect(existsSync(result.path)).toBe(true);
    const content = readFileSync(result.path, 'utf8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('source_session: "sess-123"');
    expect(content).toContain('memory_lines_before: 200');
    expect(content).toContain('proposed_lines_after: 150');
    expect(content).toContain('```diff');
    expect(content).toContain('-old');
  });

  it('does not leave .tmp files behind after a successful write', async () => {
    const repoRoot = tmp();
    await writePendingDream({ repoRoot, diff: 'body' });
    // Verify no .tmp file remains alongside the sidecar.
    const dir = join(repoRoot, '.orchestrator');
    const entries = readdirSync(dir);
    const tmpFiles = entries.filter((f) => f.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });

  it('MED-1 cross-ref: writePendingDream rejects YAML frontmatter injection via newline-bearing sourceSession', async () => {
    const repoRoot = tmp();
    const result = await writePendingDream({
      repoRoot,
      diff: '```diff\n-old\n+new\n```\n',
      sourceSession: 'sess-attacker\n---\nstatus: applied\ngenerated_at: 2099-01-01T00:00:00Z',
      memoryLinesBefore: 100,
      proposedLinesAfter: 50,
    });
    const content = readFileSync(result.path, 'utf8');
    // Frontmatter must have exactly 2 '---' fences (open + close) — no injection
    const fenceMatches = content.match(/^---$/gm) || [];
    expect(fenceMatches.length).toBe(2);
    // The injected status:applied must NOT appear as a top-level YAML key
    expect(content).not.toMatch(/^status:\s*applied/m);
    // The value must be JSON-escaped
    expect(content).toContain('source_session: "sess-attacker\\n---\\nstatus: applied\\ngenerated_at: 2099-01-01T00:00:00Z"');
  });

  it('LOW-2 cross-ref: writePendingDream throws TypeError when diff is whitespace-only', async () => {
    const repoRoot = tmp();
    await expect(writePendingDream({ repoRoot, diff: ' ' })).rejects.toThrow(TypeError);
    await expect(writePendingDream({ repoRoot, diff: '\n\t  \n' })).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// readPendingDream
// ---------------------------------------------------------------------------

describe('readPendingDream', () => {
  it('returns null when sidecar is absent', async () => {
    const repoRoot = tmp();
    const out = await readPendingDream({ repoRoot });
    expect(out).toBe(null);
  });

  it('returns the raw file contents when sidecar exists', async () => {
    const repoRoot = tmp();
    await writePendingDream({ repoRoot, diff: 'hello' });
    const out = await readPendingDream({ repoRoot });
    expect(typeof out).toBe('string');
    expect(out).toContain('hello');
    expect(out).toContain('---');
  });
});

// ---------------------------------------------------------------------------
// applyPendingDream — full lifecycle (missing / stale / success)
// ---------------------------------------------------------------------------

describe('applyPendingDream', () => {
  it('returns {applied:false, reason:"missing"} when sidecar is absent', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const result = await applyPendingDream({ repoRoot, memoryDir });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('missing');
  });

  it('returns {applied:false, reason:"stale"} when generated_at is older than 14 days', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    // Hand-write a sidecar with a 30-day-old generated_at timestamp.
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sidecar = [
      '---',
      `generated_at: ${ancient}`,
      'source_session: stale-test',
      'memory_lines_before: null',
      'proposed_lines_after: null',
      '---',
      '',
      '```diff\nbody\n```\n',
    ].join('\n');
    writeFileSync(join(repoRoot, '.orchestrator', 'pending-dream.md'), sidecar, 'utf8');

    const result = await applyPendingDream({ repoRoot, memoryDir });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('stale');
    // Sidecar must still exist after a stale-skip (not consumed).
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(true);
  });

  it('on success: overwrites MEMORY.md, deletes sidecar, returns linesBefore/linesAfter', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'a\nb\nc\nd\ne\n', 'utf8');

    const newBody = '```markdown\nx\ny\n```\n';
    await writePendingDream({ repoRoot, diff: newBody, sourceSession: 'sess-x' });

    const result = await applyPendingDream({ repoRoot, memoryDir });
    expect(result.applied).toBe(true);
    expect(result.linesBefore).toBe(6); // 5 lines + trailing newline → 6 split chunks
    // Sidecar consumed.
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
    // MEMORY.md replaced with extracted fenced block contents.
    const memoryContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(memoryContent).toContain('x');
    expect(memoryContent).toContain('y');
    expect(memoryContent).not.toContain('```');
  });
});

// ---------------------------------------------------------------------------
// Indirect coverage of internal helpers via applyPendingDream
// ---------------------------------------------------------------------------

describe('applyPendingDream / extractDiffBlock + parsePendingDream (internal)', () => {
  it('treats a body without a fenced code block as the full replacement verbatim', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    // Freeform body, NO fenced block: extractDiffBlock returns body verbatim.
    const sidecar = [
      '---',
      `generated_at: ${new Date().toISOString()}`,
      'source_session: freeform',
      'memory_lines_before: null',
      'proposed_lines_after: null',
      '---',
      '',
      'freeform replacement body',
    ].join('\n');
    writeFileSync(join(repoRoot, '.orchestrator', 'pending-dream.md'), sidecar, 'utf8');

    await applyPendingDream({ repoRoot, memoryDir });
    const memoryContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(memoryContent).toContain('freeform replacement body');
  });

  it('handles sidecar with no YAML frontmatter (returns body verbatim, no crash)', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    // No `---` markers → parsePendingDream short-circuits to {frontmatter:{}, body:content}
    writeFileSync(join(repoRoot, '.orchestrator', 'pending-dream.md'), 'no-frontmatter body', 'utf8');

    const result = await applyPendingDream({ repoRoot, memoryDir });
    expect(result.applied).toBe(true);
    // With empty frontmatter, no staleness rejection happens.
    const memoryContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(memoryContent).toContain('no-frontmatter body');
  });
});
