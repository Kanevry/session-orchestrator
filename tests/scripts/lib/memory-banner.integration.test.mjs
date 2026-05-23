/**
 * tests/scripts/lib/memory-banner.integration.test.mjs
 *
 * Integration tests for #505 Phase 6.7 "What I Remembered" banner.
 *
 * Exercises the FULL `readBannerInputs` + `renderMemoryBanner` path against
 * real on-disk fixtures:
 *   - `<tmpRepo>/.orchestrator/metrics/learnings.jsonl`
 *   - `<tmpRepo>/.orchestrator/metrics/sessions.jsonl`
 *   - `<tmpRepo>/.orchestrator/peers/USER.md` + `AGENT.md`
 *   - `<tmpMemoryDir>/MEMORY.md` + `session-*.md`
 *
 * Sibling P1 unit-test file: tests/scripts/lib/memory-banner.test.mjs
 * (pure formatter / helper coverage with synthetic inputs).
 *
 * This file MUST NOT touch ~/.claude/projects/... — every test passes an
 * isolated tmp `memoryDir` to `readBannerInputs` / `renderMemoryBanner`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readBannerInputs, renderMemoryBanner } from '@lib/memory-banner.mjs';

// ─────────────────────────────────────────────────────────────────────────
// Fixture helpers
// ─────────────────────────────────────────────────────────────────────────

/**
 * Write `.orchestrator/metrics/learnings.jsonl` with the supplied entries.
 */
function writeLearningsJsonl(tmpRepo, entries) {
  const dir = join(tmpRepo, '.orchestrator', 'metrics');
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, 'learnings.jsonl'), lines, 'utf8');
}

/**
 * Write `.orchestrator/metrics/sessions.jsonl` with the supplied entries.
 * Pass `''` (empty string) for entries to write a zero-byte file.
 */
function writeSessionsJsonl(tmpRepo, entries) {
  const dir = join(tmpRepo, '.orchestrator', 'metrics');
  mkdirSync(dir, { recursive: true });
  const content = entries.length === 0
    ? ''
    : entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, 'sessions.jsonl'), content, 'utf8');
}

/**
 * Write `.orchestrator/peers/{USER,AGENT}.md` peer card with the supplied
 * body. Frontmatter contains the minimum schema-valid set of fields.
 */
function writePeerCard(tmpRepo, kind, body) {
  const dir = join(tmpRepo, '.orchestrator', 'peers');
  mkdirSync(dir, { recursive: true });
  const id = kind === 'user' ? 'usr-test' : 'agt-test';
  const target = kind === 'user' ? 'user' : 'agent';
  const filename = kind === 'user' ? 'USER.md' : 'AGENT.md';
  const content = [
    '---',
    `id: ${id}`,
    'type: peer-card',
    `target: ${target}`,
    'created: 2026-05-23T00:00:00Z',
    'updated: 2026-05-23T00:00:00Z',
    '---',
    '',
    body,
    '',
  ].join('\n');
  writeFileSync(join(dir, filename), content, 'utf8');
}

/**
 * Populate `<tmpMemoryDir>` with the named `.md` files (each gets a single
 * line of content so they are non-zero-byte but the contents are not
 * inspected by readBannerInputs — only the count matters).
 */
function writeMemoryFiles(tmpMemoryDir, names) {
  mkdirSync(tmpMemoryDir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(tmpMemoryDir, name), `# ${name}\n`, 'utf8');
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────

describe('memory-banner integration (#505)', () => {
  let tmpRepo;
  let tmpMemoryDir;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'so-mem-banner-repo-'));
    tmpMemoryDir = mkdtempSync(join(tmpdir(), 'so-mem-banner-mem-'));
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
    rmSync(tmpMemoryDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  // ───────────────────────────────────────────────────────────────────────
  // Group I — renderMemoryBanner EMPTY fixture → fresh fallback
  // ───────────────────────────────────────────────────────────────────────

  describe('Group I: empty fixture renders fresh-repo fallback', () => {
    it('returns EXACT fresh-line when no learnings, empty sessions.jsonl, no peers, no memory files', async () => {
      writeSessionsJsonl(tmpRepo, []); // zero-byte file
      // No learnings.jsonl, no peers dir, no memory files.

      const banner = await renderMemoryBanner({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        config: { persistence: true, memory: { banner: { enabled: true } } },
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(banner).toBe(
        "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.",
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Group II — renderMemoryBanner FULL fixture → exact inline snapshot
  // ───────────────────────────────────────────────────────────────────────

  describe('Group II: full fixture renders header + 5 learnings + stats + 2 peer lines', () => {
    it('matches the deterministic banner snapshot end-to-end', async () => {
      // 5 learnings — confidence-sorted DESC; the 0.5 one falls right above
      // the surfaceTopN floor (> 0.3) so it is included.
      writeLearningsJsonl(tmpRepo, [
        {
          id: 'l-1',
          type: 'pattern',
          subject: 'top-confidence-pattern',
          confidence: 0.9,
          created_at: '2026-05-01T00:00:00Z',
        },
        {
          id: 'l-2',
          type: 'gotcha',
          subject: 'second-best-gotcha',
          confidence: 0.85,
          created_at: '2026-05-02T00:00:00Z',
        },
        {
          id: 'l-3',
          type: 'workflow',
          subject: 'third-workflow-tip',
          confidence: 0.8,
          created_at: '2026-05-03T00:00:00Z',
        },
        {
          id: 'l-4',
          type: 'tool',
          subject: 'fourth-tool-insight',
          confidence: 0.7,
          created_at: '2026-05-04T00:00:00Z',
        },
        {
          id: 'l-5',
          type: 'process',
          subject: 'fifth-process-note',
          confidence: 0.5,
          created_at: '2026-05-05T00:00:00Z',
        },
      ]);

      // 10 sessions; the most recent carries memory_cleanup_at so
      // daysSinceCleanup is deterministic.
      // now = 2026-05-23T12:00:00Z
      // memory_cleanup_at = 2026-05-20T12:00:00Z  → delta = 3.0 days → floor = 3
      const sessionEntries = [];
      for (let i = 1; i <= 10; i += 1) {
        const entry = {
          session_id: `s-${i}`,
          started_at: `2026-05-${String(i).padStart(2, '0')}T00:00:00Z`,
        };
        if (i === 10) {
          entry.memory_cleanup_at = '2026-05-20T12:00:00Z';
        }
        sessionEntries.push(entry);
      }
      writeSessionsJsonl(tmpRepo, sessionEntries);

      // Peer cards with `## <section>` + content body.
      writePeerCard(tmpRepo, 'user', '## Preferences\nprefers terse output');
      writePeerCard(tmpRepo, 'agent', '## Habits\nuses parallel agents');

      // 5 memory files: MEMORY.md + 4 session-*.md
      writeMemoryFiles(tmpMemoryDir, [
        'MEMORY.md',
        'session-2026-05-19.md',
        'session-2026-05-20.md',
        'session-2026-05-21.md',
        'session-2026-05-22.md',
      ]);

      const banner = await renderMemoryBanner({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        config: { persistence: true, memory: { banner: { enabled: true } } },
        now: new Date('2026-05-23T12:00:00Z'),
      });

      // Note: (0.85).toFixed(1) === "0.8" in V8 due to IEEE 754
      // representation of 0.85 as 0.8499999…; that is the documented
      // formatLearningLine behaviour, not a test bug. The third 0.8 entry
      // also formats as "0.8", which is the intended floor behaviour
      // for two distinct confidences that share a one-decimal rendering.
      expect(banner).toMatchInlineSnapshot(`
        "📚 Loaded from memory
          • top-confidence-pattern (0.9, pattern)
          • second-best-gotcha (0.8, gotcha)
          • third-workflow-tip (0.8, workflow)
          • fourth-tool-insight (0.7, tool)
          • fifth-process-note (0.5, process)
        5 memory files · 10 sessions ever · last cleanup 3 days ago
          USER.md — Preferences: prefers terse output
          AGENT.md — Habits: uses parallel agents"
      `);
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Group III — PARTIAL fixture (no peer cards) — header + learnings + stats only
  // ───────────────────────────────────────────────────────────────────────

  describe('Group III: partial fixture (no peers) omits peer excerpt lines', () => {
    it('renders header + 3 learning lines + stats but no USER.md / AGENT.md lines', async () => {
      writeLearningsJsonl(tmpRepo, [
        {
          id: 'l-1',
          type: 'pattern',
          subject: 'aaa-first',
          confidence: 0.9,
          created_at: '2026-05-01T00:00:00Z',
        },
        {
          id: 'l-2',
          type: 'gotcha',
          subject: 'bbb-second',
          confidence: 0.7,
          created_at: '2026-05-02T00:00:00Z',
        },
        {
          id: 'l-3',
          type: 'workflow',
          subject: 'ccc-third',
          confidence: 0.5,
          created_at: '2026-05-03T00:00:00Z',
        },
      ]);
      writeSessionsJsonl(tmpRepo, [
        { session_id: 's-1', started_at: '2026-05-01T00:00:00Z' },
        { session_id: 's-2', started_at: '2026-05-02T00:00:00Z' },
        { session_id: 's-3', started_at: '2026-05-03T00:00:00Z' },
        { session_id: 's-4', started_at: '2026-05-04T00:00:00Z' },
        { session_id: 's-5', started_at: '2026-05-05T00:00:00Z' },
      ]);
      // No peers dir, no memory files.

      const banner = await renderMemoryBanner({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        config: { persistence: true, memory: { banner: { enabled: true } } },
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(banner).toBe(
        [
          '📚 Loaded from memory',
          '  • aaa-first (0.9, pattern)',
          '  • bbb-second (0.7, gotcha)',
          '  • ccc-third (0.5, workflow)',
          '0 memory files · 5 sessions ever · last cleanup: never',
        ].join('\n'),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Group IV — Gating: persistence=false → empty string
  // ───────────────────────────────────────────────────────────────────────

  describe('Group IV: persistence=false silences the banner', () => {
    it('returns empty string when config.persistence === false even with a full fixture', async () => {
      writeLearningsJsonl(tmpRepo, [
        {
          id: 'l-1',
          type: 'pattern',
          subject: 'visible-only-when-enabled',
          confidence: 0.9,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);
      writeSessionsJsonl(tmpRepo, [
        { session_id: 's-1', started_at: '2026-05-01T00:00:00Z' },
      ]);
      writePeerCard(tmpRepo, 'user', '## Preferences\nprefers terse output');
      writeMemoryFiles(tmpMemoryDir, ['MEMORY.md']);

      const banner = await renderMemoryBanner({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        config: { persistence: false, memory: { banner: { enabled: true } } },
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(banner).toBe('');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Group V — Gating: memory.banner.enabled=false → empty string
  // ───────────────────────────────────────────────────────────────────────

  describe('Group V: memory.banner.enabled=false silences the banner', () => {
    it('returns empty string when banner is explicitly disabled', async () => {
      writeLearningsJsonl(tmpRepo, [
        {
          id: 'l-1',
          type: 'pattern',
          subject: 'still-silenced',
          confidence: 0.9,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);
      writeSessionsJsonl(tmpRepo, [
        { session_id: 's-1', started_at: '2026-05-01T00:00:00Z' },
      ]);
      writePeerCard(tmpRepo, 'user', '## Preferences\nprefers terse output');
      writeMemoryFiles(tmpMemoryDir, ['MEMORY.md']);

      const banner = await renderMemoryBanner({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        config: { persistence: true, memory: { banner: { enabled: false } } },
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(banner).toBe('');
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Group VI — Default-on: absence of memory block does NOT silence
  // ───────────────────────────────────────────────────────────────────────

  describe('Group VI: config without memory block defaults to enabled', () => {
    it('renders the banner when config = {persistence: true} (no memory subtree)', async () => {
      writeLearningsJsonl(tmpRepo, [
        {
          id: 'l-1',
          type: 'pattern',
          subject: 'default-on-visible',
          confidence: 0.9,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);
      writeSessionsJsonl(tmpRepo, [
        { session_id: 's-1', started_at: '2026-05-01T00:00:00Z' },
        { session_id: 's-2', started_at: '2026-05-02T00:00:00Z' },
      ]);

      const banner = await renderMemoryBanner({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        config: { persistence: true }, // no memory key at all
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(banner).toBe(
        [
          '📚 Loaded from memory',
          '  • default-on-visible (0.9, pattern)',
          '0 memory files · 2 sessions ever · last cleanup: never',
        ].join('\n'),
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Group VII — readBannerInputs direct: shape + daysSinceCleanup FLOOR
  // ───────────────────────────────────────────────────────────────────────

  describe('Group VII: readBannerInputs direct call returns the documented shape', () => {
    it('returns topLearnings sorted by confidence DESC, exact stats with floored daysSinceCleanup, and peerExcerpts', async () => {
      writeLearningsJsonl(tmpRepo, [
        {
          id: 'l-1',
          type: 'pattern',
          subject: 'alpha',
          confidence: 0.95,
          created_at: '2026-05-01T00:00:00Z',
        },
        {
          id: 'l-2',
          type: 'gotcha',
          subject: 'beta',
          confidence: 0.6,
          created_at: '2026-05-02T00:00:00Z',
        },
      ]);
      // now            = 2026-05-23T12:00:00Z
      // lastCleanupAt  = 2026-05-20T11:59:59Z
      // delta          = (3 days + 0:00:01) → floor = 3
      writeSessionsJsonl(tmpRepo, [
        { session_id: 's-1', started_at: '2026-05-01T00:00:00Z' },
        { session_id: 's-2', started_at: '2026-05-02T00:00:00Z' },
        {
          session_id: 's-3',
          started_at: '2026-05-03T00:00:00Z',
          memory_cleanup_at: '2026-05-20T11:59:59Z',
        },
      ]);
      writePeerCard(tmpRepo, 'user', '## Preferences\nprefers terse output');
      writePeerCard(tmpRepo, 'agent', '## Habits\nuses parallel agents');
      writeMemoryFiles(tmpMemoryDir, ['MEMORY.md', 'session-2026-05-22.md']);

      const inputs = await readBannerInputs({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(inputs).toEqual({
        topLearnings: [
          { subject: 'alpha', confidence: 0.95, type: 'pattern' },
          { subject: 'beta', confidence: 0.6, type: 'gotcha' },
        ],
        stats: {
          memoryFiles: 2,
          sessionsEver: 3,
          daysSinceCleanup: 3,
        },
        peerExcerpts: {
          user: ['Preferences', 'prefers terse output'],
          agent: ['Habits', 'uses parallel agents'],
        },
        fresh: false,
      });
    });

    it('floors daysSinceCleanup when the delta has a fractional remainder', async () => {
      writeLearningsJsonl(tmpRepo, [
        {
          id: 'l-1',
          type: 'pattern',
          subject: 'only',
          confidence: 0.9,
          created_at: '2026-05-01T00:00:00Z',
        },
      ]);
      // now            = 2026-05-23T12:00:00Z
      // lastCleanupAt  = 2026-05-21T18:00:00Z
      // delta          = 1 day 18 hours → floor = 1
      writeSessionsJsonl(tmpRepo, [
        {
          session_id: 's-1',
          started_at: '2026-05-01T00:00:00Z',
          memory_cleanup_at: '2026-05-21T18:00:00Z',
        },
      ]);

      const inputs = await readBannerInputs({
        repoRoot: tmpRepo,
        memoryDir: tmpMemoryDir,
        now: new Date('2026-05-23T12:00:00Z'),
      });

      expect(inputs.stats.daysSinceCleanup).toBe(1);
    });
  });
});
