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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
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
// #699 — memory_cleanup_at stamp makes lastCleanupAt advance + cadence resets
// ---------------------------------------------------------------------------

describe('readDreamSignals — #699: memory_cleanup_at stamp advances lastCleanupAt', () => {
  it('latest memory_cleanup_at becomes lastCleanupAt and sessions after it count from zero', async () => {
    // Scenario: 4 sessions before cleanup, then cleanup stamps memory_cleanup_at,
    // then 2 sessions after. sessionsSinceCleanup must be 2 (not 6 or 3).
    const { repoRoot, memoryDir } = makeFakeRepo({
      sessions: [
        { started_at: '2026-06-01T08:00:00Z' },
        { started_at: '2026-06-02T08:00:00Z' },
        { started_at: '2026-06-03T08:00:00Z' },
        { started_at: '2026-06-04T08:00:00Z' },
        // The cleanup session: started AFTER the four above, carries the stamp.
        {
          started_at: '2026-06-05T08:00:00Z',
          completed_at: '2026-06-05T08:30:00Z',
          memory_cleanup_at: '2026-06-05T08:30:00Z',
        },
        // Two sessions after cleanup — only these should be counted.
        { started_at: '2026-06-06T09:00:00Z' },
        { started_at: '2026-06-07T09:00:00Z' },
      ],
    });
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    expect(signals.lastCleanupAt).toBe('2026-06-05T08:30:00Z');
    expect(signals.sessionsSinceCleanup).toBe(2);
  });

  it('when the most recent session carries memory_cleanup_at, sessionsSinceCleanup is 0', async () => {
    // Scenario matching a healthy no-op cleanup on the last session: cadence resets to 0.
    const { repoRoot, memoryDir } = makeFakeRepo({
      sessions: [
        { started_at: '2026-06-10T08:00:00Z' },
        { started_at: '2026-06-11T08:00:00Z' },
        // Most recent session runs cleanup (even no-op) and stamps.
        {
          started_at: '2026-06-12T08:00:00Z',
          completed_at: '2026-06-12T08:45:00Z',
          memory_cleanup_at: '2026-06-12T08:45:00Z',
        },
      ],
    });
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    expect(signals.lastCleanupAt).toBe('2026-06-12T08:45:00Z');
    expect(signals.sessionsSinceCleanup).toBe(0);
  });

  it('picks the MAXIMUM memory_cleanup_at across multiple stamped entries', async () => {
    // Two entries carry memory_cleanup_at; the later one wins.
    const { repoRoot, memoryDir } = makeFakeRepo({
      sessions: [
        {
          started_at: '2026-06-01T08:00:00Z',
          memory_cleanup_at: '2026-06-01T08:30:00Z',
        },
        { started_at: '2026-06-02T09:00:00Z' },
        {
          started_at: '2026-06-03T08:00:00Z',
          memory_cleanup_at: '2026-06-03T08:45:00Z',
        },
        // One session after the latest cleanup.
        { started_at: '2026-06-04T10:00:00Z' },
      ],
    });
    const signals = await readDreamSignals({ repoRoot, memoryDir });
    expect(signals.lastCleanupAt).toBe('2026-06-03T08:45:00Z');
    expect(signals.sessionsSinceCleanup).toBe(1);
  });
});

describe('shouldDispatchAutoDream — #699: cadence does NOT trigger after recent cleanup', () => {
  it('does NOT trigger on cadence when sessionsSinceCleanup is below threshold (recent no-op stamp)', async () => {
    // After a no-op cleanup stamps memory_cleanup_at, only 2 sessions have passed.
    // With threshold=5, cadence must NOT fire.
    const result = await shouldDispatchAutoDream({
      repoRoot: '/x',
      memoryDir: '/x',
      threshold: 5,
      softLimit: 180,
      signals: {
        memoryLines: 10,
        sessionsSinceCleanup: 2,
        lastCleanupAt: '2026-06-12T08:45:00Z',
      },
    });
    expect(result.trigger).toBe(false);
    expect(result.reason).toMatch(/under-thresholds/);
  });

  it('still triggers on cadence when sessionsSinceCleanup reaches threshold despite a prior stamp', async () => {
    // 5 sessions have passed since the stamped cleanup: threshold met → trigger.
    const result = await shouldDispatchAutoDream({
      repoRoot: '/x',
      memoryDir: '/x',
      threshold: 5,
      softLimit: 180,
      signals: {
        memoryLines: 10,
        sessionsSinceCleanup: 5,
        lastCleanupAt: '2026-06-05T08:30:00Z',
      },
    });
    expect(result.trigger).toBe(true);
    expect(result.reason).toMatch(/cadence-threshold-met/);
  });

  it('full disk roundtrip: sessions.jsonl with memory_cleanup_at stamp → shouldDispatchAutoDream does not trigger', async () => {
    // This is the end-to-end regression test for #699:
    // Before the fix, a no-op cleanup left lastCleanupAt=null → sessionsSinceCleanup
    // counted ALL entries → false cadence trigger. With the stamp, it resets.
    const { repoRoot, memoryDir } = makeFakeRepo({
      memoryLines: 10, // well below softLimit=180
      sessions: [
        { started_at: '2026-06-08T08:00:00Z' },
        { started_at: '2026-06-09T08:00:00Z' },
        {
          started_at: '2026-06-10T08:00:00Z',
          completed_at: '2026-06-10T08:30:00Z',
          memory_cleanup_at: '2026-06-10T08:30:00Z', // stamp from no-op cleanup
        },
        { started_at: '2026-06-11T09:00:00Z' },
      ],
    });
    const result = await shouldDispatchAutoDream({
      repoRoot,
      memoryDir,
      threshold: 5,
      softLimit: 180,
    });
    // Only 1 session after the cleanup: 1 < 5 → must NOT trigger.
    expect(result.trigger).toBe(false);
    expect(result.signals.sessionsSinceCleanup).toBe(1);
    expect(result.signals.lastCleanupAt).toBe('2026-06-10T08:30:00Z');
  });
});

// ---------------------------------------------------------------------------
// Indirect coverage of internal helpers via applyPendingDream
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// #717 — applyPendingDream refuses unsupported sidecar formats
// ---------------------------------------------------------------------------
// isGitStyleDiff() / countFencedBlocks() are internal (not exported), so these
// are covered indirectly through applyPendingDream — the public consumer.

describe('applyPendingDream — #717: unsupported-format guard', () => {
  it('refuses a multi-fence git-style-diff sidecar (3 diff hunks against different files): unsupported-format, MEMORY.md untouched, sidecar preserved', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const originalMemory = 'a\nb\nc\n';
    writeFileSync(join(memoryDir, 'MEMORY.md'), originalMemory, 'utf8');

    // Mirrors the real #717 incident: 3 separate ```diff fences, each a
    // git-style unified-diff hunk (--- / +++ / @@ markers) against a
    // DIFFERENT file — exactly the shape extractDiffBlock() would otherwise
    // silently truncate to just the first hunk if applied naively.
    const multiFenceDiff = [
      '```diff',
      '--- a/MEMORY.md',
      '+++ b/MEMORY.md',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
      '```',
      '',
      '```diff',
      '--- a/user_profile.md',
      '+++ b/user_profile.md',
      '@@ -1,1 +1,1 @@',
      '-old profile line',
      '+new profile line',
      '```',
      '',
      '```diff',
      '--- a/session-history.md',
      '+++ b/session-history.md',
      '@@ -1,1 +1,1 @@',
      '-old history line',
      '+new history line',
      '```',
    ].join('\n');

    await writePendingDream({ repoRoot, diff: multiFenceDiff, sourceSession: 'sess-717-a' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result).toEqual({ applied: false, reason: 'unsupported-format' });
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(originalMemory);
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(true);
  });

  it('refuses a SINGLE fenced block that itself contains git-style diff markers', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const originalMemory = 'x\ny\nz\n';
    writeFileSync(join(memoryDir, 'MEMORY.md'), originalMemory, 'utf8');

    const singleGitDiff = [
      '```diff',
      '--- a/MEMORY.md',
      '+++ b/MEMORY.md',
      '@@ -1,2 +1,2 @@',
      '-old',
      '+new',
      '```',
    ].join('\n');

    await writePendingDream({ repoRoot, diff: singleGitDiff, sourceSession: 'sess-717-b' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result).toEqual({ applied: false, reason: 'unsupported-format' });
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(originalMemory);
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(true);
  });

  it('refuses a multi-fence body even when the FIRST fence alone is not git-style (exercises the countFencedBlocks discriminator independently of isGitStyleDiff)', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const originalMemory = 'p\nq\nr\n';
    writeFileSync(join(memoryDir, 'MEMORY.md'), originalMemory, 'utf8');

    // First fence is plain markdown with no diff markers — isGitStyleDiff()
    // on the extracted (first) block alone would say false. The SECOND fence
    // is what must trip the refusal via countFencedBlocks(body) > 1.
    const twoFenceBody = [
      '```markdown',
      '# Memory Index',
      '- [Note](note.md) — some note',
      '```',
      '',
      '```markdown',
      '# Second Section',
      '- [Other](other.md) — another note',
      '```',
    ].join('\n');

    await writePendingDream({ repoRoot, diff: twoFenceBody, sourceSession: 'sess-717-d' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result).toEqual({ applied: false, reason: 'unsupported-format' });
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(originalMemory);
  });

  it('false-positive guard: a legitimate single markdown fence with MEMORY.md-typical bullet lines is still applied (not refused)', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'old body\n', 'utf8');

    // Real MEMORY.md bullets use markdown link syntax with a leading hyphen —
    // a naive `^[+-]` matcher would false-positive these as diff hunk lines.
    const legitimateBody = [
      '```markdown',
      '# Memory Index',
      '',
      '## Project',
      '- [User Profile](user_profile.md) — Austrian dev, GitLab ecosystem',
      '- [Session History](session-history.md) — 5 sessions, reverse-chronological',
      '```',
    ].join('\n');

    await writePendingDream({ repoRoot, diff: legitimateBody, sourceSession: 'sess-717-c' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(true);
    const memoryContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(memoryContent).toContain('- [User Profile](user_profile.md) — Austrian dev, GitLab ecosystem');
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #720 — applyPendingDream refuses fences tagged with an unrecognized
// language (extractDiffBlock() only recognizes `diff` / `markdown` / untagged)
// ---------------------------------------------------------------------------
// hasUnrecognizedFence() is internal (not exported), so these are covered
// indirectly through applyPendingDream — the public consumer.

describe('applyPendingDream — #720: foreign-tagged fence guard', () => {
  it('refuses a single ```js fence: unsupported-format, MEMORY.md untouched, sidecar preserved', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const originalMemory = 'orig-1\norig-2\n';
    writeFileSync(join(memoryDir, 'MEMORY.md'), originalMemory, 'utf8');

    // extractDiffBlock()'s regex only recognizes ```diff / ```markdown /
    // untagged ``` — a ```js tag fails the match entirely, falling back to
    // returning the RAW body (including the literal fence markers) verbatim.
    const jsFencedBody = ['```js', "console.log('hi');", '```'].join('\n');

    await writePendingDream({ repoRoot, diff: jsFencedBody, sourceSession: 'sess-720-a' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result).toEqual({ applied: false, reason: 'unsupported-format' });
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(originalMemory);
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(true);
  });

  it('refuses a single ```python fence: unsupported-format', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const originalMemory = 'orig-py\n';
    writeFileSync(join(memoryDir, 'MEMORY.md'), originalMemory, 'utf8');

    const pyFencedBody = ['```python', 'print("hi")', '```'].join('\n');

    await writePendingDream({ repoRoot, diff: pyFencedBody, sourceSession: 'sess-720-b' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result).toEqual({ applied: false, reason: 'unsupported-format' });
    expect(readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8')).toBe(originalMemory);
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(true);
  });

  it('regression: an UNTAGGED fence (```\\n...\\n```) is still applied, not refused', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'old body\n', 'utf8');

    const untaggedFenceBody = ['```', 'plain fenced content', '```'].join('\n');

    await writePendingDream({ repoRoot, diff: untaggedFenceBody, sourceSession: 'sess-720-c' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(true);
    const memoryContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(memoryContent).toContain('plain fenced content');
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
  });

  it('regression: a single ```markdown fence is still applied, not refused (L626-class)', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'old body\n', 'utf8');

    const markdownFenceBody = ['```markdown', '# Memory Index', '- entry one', '```'].join('\n');

    await writePendingDream({ repoRoot, diff: markdownFenceBody, sourceSession: 'sess-720-d' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(true);
    const memoryContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(memoryContent).toContain('- entry one');
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
  });

  it('pin: a body with NO fence at all (freeform) is still applied verbatim, unaffected by #720', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'), 'old body\n', 'utf8');

    const freeformBody = 'freeform replacement body, no fence markers at all';

    await writePendingDream({ repoRoot, diff: freeformBody, sourceSession: 'sess-720-e' });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(true);
    const memoryContent = readFileSync(join(memoryDir, 'MEMORY.md'), 'utf8');
    expect(memoryContent).toContain('freeform replacement body, no fence markers at all');
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
  });
});

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

// ---------------------------------------------------------------------------
// #788 — applyPendingDream stale-index drift guard
// ---------------------------------------------------------------------------
// applyPendingDream is a complete-replacement write frozen on the dry-run
// snapshot. If MEMORY.md was edited BETWEEN the producing --dry-run and this
// apply, a naive write would clobber those interim edits (the "clobber"
// incident class from the pending-dream reference note). #788 refuses with
// { applied: false, reason: 'stale-index', driftMs } when
// Math.floor(statSync(MEMORY.md).mtimeMs) > Date.parse(generated_at), leaving
// MEMORY.md untouched and PRESERVING the sidecar so --dry-run can re-run.
//
// ms-Floor semantics: generated_at (ISO) has whole-ms resolution; APFS mtime
// carries sub-ms precision. A MEMORY.md write in the SAME millisecond as the
// sidecar must NOT refuse — the Floor makes equal-ms look equal, and strict `>`
// then passes (Test 3 pins this). driftMs is the RAW (unfloored) delta, so we
// assert only a lower bound, never an exact value.
//
// Fake-regression proof (testing.md § Negative-Assertion): the guard lives in
// read-only production code, so it cannot be disabled here. Instead the Red-Fall
// (Test 1) was first RUN with a deliberately WRONG expectation
// (expect(result.applied).toBe(true)). vitest reported it RED:
//     AssertionError: expected false to be true // Object.is equality
//       - Expected: true   + Received: false
//     ❯ tests/lib/auto-dream.test.mjs:860 (drift: refuses with stale-index …)
// Correcting the expectation to .toBe(false) turned it green — proving the
// assertion is load-bearing (it fails exactly when the guard's refusal is not
// observed). Full transcript quoted in the wave report.

describe('applyPendingDream — #788: stale-index drift guard', () => {
  // Extract the sidecar's ISO `generated_at` so tests can pin MEMORY.md's mtime
  // deterministically relative to it (no hardcoded calendar dates — the
  // time-bomb bug class).
  function readGeneratedAt(repoRoot) {
    const raw = readFileSync(join(repoRoot, '.orchestrator', 'pending-dream.md'), 'utf8');
    const m = raw.match(/^generated_at:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  }

  it('drift: refuses with stale-index when MEMORY.md mtime is newer than generated_at, leaving the interim body untouched', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const memoryPath = join(memoryDir, 'MEMORY.md');

    // 1. Snapshot MEMORY.md the dry-run saw.
    writeFileSync(memoryPath, 'snapshot body the dry-run saw\n', 'utf8');
    // 2. Produce the sidecar (stamps generated_at = now).
    await writePendingDream({
      repoRoot,
      diff: '```markdown\nREPLACEMENT that must NOT land\n```\n',
      sourceSession: 'sess-788-drift',
    });
    // 3. Interim edit AFTER the dry-run — this is what a clobber would destroy.
    const interim = 'INTERIM edit that must survive the refused apply\n';
    writeFileSync(memoryPath, interim, 'utf8');
    // 4. Pin mtime deterministically 1s past generated_at → unambiguous drift.
    const generatedAt = readGeneratedAt(repoRoot);
    const future = new Date(Date.parse(generatedAt) + 1000);
    utimesSync(memoryPath, future, future);

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('stale-index');
    // driftMs is the RAW delta — assert lower bound only (never exact).
    expect(result.driftMs).toBeGreaterThanOrEqual(1000);
    // MEMORY.md is the interim version, NOT the refused replacement body.
    expect(readFileSync(memoryPath, 'utf8')).toBe(interim);
    // Sidecar preserved so the caller can re-run --dry-run.
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(true);
  });

  it('no drift: applies when MEMORY.md mtime predates generated_at, replacing the body and consuming the sidecar', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const memoryPath = join(memoryDir, 'MEMORY.md');

    // MEMORY.md written BEFORE the sidecar → its mtime predates generated_at.
    writeFileSync(memoryPath, 'stale snapshot body\n', 'utf8');
    await writePendingDream({
      repoRoot,
      diff: '```markdown\nfresh replacement body\n```\n',
      sourceSession: 'sess-788-nodrift',
    });
    // Pin mtime 1s BEFORE generated_at → deterministically no drift.
    const generatedAt = readGeneratedAt(repoRoot);
    const past = new Date(Date.parse(generatedAt) - 1000);
    utimesSync(memoryPath, past, past);

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(true);
    const memoryContent = readFileSync(memoryPath, 'utf8');
    expect(memoryContent).toContain('fresh replacement body');
    expect(memoryContent).not.toContain('stale snapshot body');
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
  });

  it('same-millisecond edge: applies when MEMORY.md mtime equals generated_at exactly (Floor semantics, not a drift signal)', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const memoryPath = join(memoryDir, 'MEMORY.md');

    writeFileSync(memoryPath, 'same-ms snapshot\n', 'utf8');
    await writePendingDream({
      repoRoot,
      diff: '```markdown\napplied same-ms body\n```\n',
      sourceSession: 'sess-788-samems',
    });
    // mtime pinned EXACTLY on generated_at's millisecond → Math.floor(mtimeMs)
    // == generatedMs, strict `>` is false → must apply (proves Floor semantics).
    const generatedAt = readGeneratedAt(repoRoot);
    const exact = new Date(Date.parse(generatedAt));
    utimesSync(memoryPath, exact, exact);

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(true);
    expect(readFileSync(memoryPath, 'utf8')).toContain('applied same-ms body');
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
  });

  it('missing MEMORY.md: applies (nothing to clobber, drift check is skipped)', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    const memoryPath = join(memoryDir, 'MEMORY.md');
    // No MEMORY.md written — existsSync(memoryPath) is false, drift check skipped.
    await writePendingDream({
      repoRoot,
      diff: '```markdown\nbootstrapped memory body\n```\n',
      sourceSession: 'sess-788-missing',
    });

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(true);
    expect(existsSync(memoryPath)).toBe(true);
    expect(readFileSync(memoryPath, 'utf8')).toContain('bootstrapped memory body');
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(false);
  });

  it('guard order: a >14d-old sidecar WITH MEMORY.md drift refuses as "stale", not "stale-index" (14d gate runs first)', async () => {
    const repoRoot = tmp();
    const memoryDir = join(repoRoot, '_memory');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    const memoryPath = join(memoryDir, 'MEMORY.md');

    // Ancient sidecar (30 days old) — the 14d gate must fire before the drift gate.
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const sidecar = [
      '---',
      `generated_at: ${ancient}`,
      'source_session: sess-788-order',
      'memory_lines_before: null',
      'proposed_lines_after: null',
      '---',
      '',
      '```markdown\nreplacement\n```\n',
    ].join('\n');
    writeFileSync(join(repoRoot, '.orchestrator', 'pending-dream.md'), sidecar, 'utf8');

    // MEMORY.md exists with an mtime pinned 5 days AFTER the ancient generated_at
    // → the drift condition (Math.floor(mtimeMs) > generatedMs) is ALSO satisfied.
    // If the 14d gate did NOT run first, this would return 'stale-index'.
    writeFileSync(memoryPath, 'current memory that also drifts\n', 'utf8');
    const driftMtime = new Date(Date.parse(ancient) + 5 * 24 * 60 * 60 * 1000);
    utimesSync(memoryPath, driftMtime, driftMtime);

    const result = await applyPendingDream({ repoRoot, memoryDir });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('stale');
    // Sidecar preserved by the stale-skip.
    expect(existsSync(join(repoRoot, '.orchestrator', 'pending-dream.md'))).toBe(true);
  });
});
