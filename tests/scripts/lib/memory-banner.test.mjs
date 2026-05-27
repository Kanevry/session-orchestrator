/**
 * tests/scripts/lib/memory-banner.test.mjs
 *
 * PURE UNIT TESTS for scripts/lib/memory-banner.mjs (Issue #505).
 *
 * Covers (no file I/O — synthetic inputs only):
 *   - Group A: extractCardExcerpt
 *   - Group B: formatLearningLine
 *   - Group C: formatStatsLine
 *   - Group D: formatBanner (incl. fresh-repo fallback EXACT-MATCH)
 *   - Group E: formatBanner snapshot stability (inline)
 *   - Group F: truncateLine
 *   - Group G: renderMemoryBanner — gating logic only (vi.mock for I/O deps)
 *
 * Integration tests with real tmp dirs / real peer-card files live in
 * tests/scripts/lib/memory-banner.integration.test.mjs (P2 owns).
 *
 * Test-quality discipline (.claude/rules/test-quality.md):
 *   - Hardcoded literal expectations — no computed values
 *   - One AAA per test, no branching/loops inside `it`
 *   - Exact-string `.toBe()` for AC-mandated fresh-repo fallback
 *   - Falsification-checked (a single-char swap breaks each behavioural test)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock the four I/O dependencies BEFORE importing memory-banner so the
// mocks are wired up for renderMemoryBanner (Group G). The pure helpers
// (Groups A–F) are unaffected — they take synthetic inputs directly.
//
// Issue #512: `resolveMemoryDir` was extracted to `memory-paths.mjs`.
vi.mock('@lib/memory-paths.mjs', () => ({
  resolveMemoryDir: vi.fn(() => '/mocked/memory'),
}));
vi.mock('@lib/auto-dream.mjs', () => ({
  readDreamSignals: vi.fn(async () => ({ lastCleanupAt: null })),
}));
vi.mock('@lib/peer-cards/reader.mjs', () => ({
  readPeerCards: vi.fn(async () => ({ user: null, agent: null })),
}));
vi.mock('@lib/learnings/surface.mjs', () => ({
  surfaceTopN: vi.fn(async () => []),
}));

import {
  _truncateLine,
  _formatLearningLine,
  _formatStatsLine,
  _extractCardExcerpt,
  _formatBanner,
  readBannerInputs,
  renderMemoryBanner,
} from '@lib/memory-banner.mjs';

import { resolveMemoryDir } from '@lib/memory-paths.mjs';
import { readDreamSignals } from '@lib/auto-dream.mjs';
import { readPeerCards } from '@lib/peer-cards/reader.mjs';
import { surfaceTopN } from '@lib/learnings/surface.mjs';

// ---------------------------------------------------------------------------
// afterEach: defensive — reset mocks + clock between tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  // Re-prime default mock returns (vi.restoreAllMocks() resets implementations)
  vi.mocked(resolveMemoryDir).mockReturnValue('/mocked/memory');
  vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
  vi.mocked(readPeerCards).mockResolvedValue({ user: null, agent: null });
  vi.mocked(surfaceTopN).mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Group A — extractCardExcerpt
// ---------------------------------------------------------------------------

describe('_extractCardExcerpt', () => {
  it('returns [null, null] for an empty string body', () => {
    expect(_extractCardExcerpt('')).toEqual([null, null]);
  });

  it('returns [null, null] for null input', () => {
    expect(_extractCardExcerpt(null)).toEqual([null, null]);
  });

  it('returns [null, null] for undefined input', () => {
    expect(_extractCardExcerpt(undefined)).toEqual([null, null]);
  });

  it('returns [null, firstNonBlank] when body has no "## " header', () => {
    const body = 'just some content\nsecond line';
    expect(_extractCardExcerpt(body)).toEqual([null, 'just some content']);
  });

  it('returns ["Section", "First content"] when body has header + content', () => {
    const body = '## Section\nFirst content';
    expect(_extractCardExcerpt(body)).toEqual(['Section', 'First content']);
  });

  it('finds header when there are leading blank lines', () => {
    const body = '\n\n## Section\nFirst content';
    expect(_extractCardExcerpt(body)).toEqual(['Section', 'First content']);
  });

  it('skips blank lines between header and content', () => {
    const body = '## Section\n\n\nFirst content';
    expect(_extractCardExcerpt(body)).toEqual(['Section', 'First content']);
  });

  it('returns ["Section", null] when header has no following content', () => {
    const body = '## Section\n\n\n';
    expect(_extractCardExcerpt(body)).toEqual(['Section', null]);
  });

  it('strips leading whitespace from the first content line', () => {
    const body = '## Section\n    indented content';
    expect(_extractCardExcerpt(body)).toEqual(['Section', 'indented content']);
  });

  it('only matches "## " (h2), not "### " (h3) — h3 line becomes first content line', () => {
    // The regex is /^##\s+(.+?)\s*$/ — requires whitespace after the two `#`.
    // '### subheader' has `#` (not whitespace) after `##`, so the header match
    // fails. The line then falls into the content scan and is returned as the
    // first non-blank line (the skip-`## ` filter also rejects `### `).
    const body = '### subheader\nbody content';
    expect(_extractCardExcerpt(body)).toEqual([null, '### subheader']);
  });

  it('skips a subsequent ## header when searching for content', () => {
    const body = '## First Section\n## Second Section\nactual content';
    expect(_extractCardExcerpt(body)).toEqual(['First Section', 'actual content']);
  });

  it('returns [null, null] for whitespace-only body', () => {
    expect(_extractCardExcerpt('   \n\n   \n')).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// Group B — formatLearningLine
// ---------------------------------------------------------------------------

describe('_formatLearningLine', () => {
  it('formats a plain learning to the exact literal "  • x-y-z (0.9, pattern)"', () => {
    expect(_formatLearningLine({ subject: 'x-y-z', confidence: 0.9, type: 'pattern' }))
      .toBe('  • x-y-z (0.9, pattern)');
  });

  it('uses toFixed(1) which truncates 0.85 → "0.8" (banker rounding)', () => {
    expect(_formatLearningLine({ subject: 'x', confidence: 0.85, type: 'p' }))
      .toBe('  • x (0.8, p)');
  });

  it('uses toFixed(1) which rounds 0.95 → "0.9" (banker rounding)', () => {
    expect(_formatLearningLine({ subject: 'x', confidence: 0.95, type: 'p' }))
      .toBe('  • x (0.9, p)');
  });

  it('renders confidence=0 as "0.0"', () => {
    expect(_formatLearningLine({ subject: 'x', confidence: 0, type: 'p' }))
      .toBe('  • x (0.0, p)');
  });

  it('defaults non-numeric confidence to "0.0"', () => {
    expect(_formatLearningLine({ subject: 'x', confidence: 'nope', type: 'p' }))
      .toBe('  • x (0.0, p)');
  });

  it('defaults missing/empty type to "unknown"', () => {
    expect(_formatLearningLine({ subject: 'x', confidence: 0.5, type: '' }))
      .toBe('  • x (0.5, unknown)');
  });

  it('treats non-string subject as empty string', () => {
    expect(_formatLearningLine({ subject: 42, confidence: 0.5, type: 'p' }))
      .toBe('  •  (0.5, p)');
  });

  it('truncates an over-long subject, keeping the (conf, type) suffix intact', () => {
    const long = 'a'.repeat(80);
    const result = _formatLearningLine({ subject: long, confidence: 0.9, type: 'pattern' });
    // Suffix preserved at end
    expect(result.endsWith(' (0.9, pattern)')).toBe(true);
    // Total length ≤ 80
    expect(result.length).toBeLessThanOrEqual(80);
    // Ellipsis present before the suffix
    expect(result).toContain('…');
  });

  it('truncated long-subject result is exactly 80 chars wide', () => {
    const long = 'a'.repeat(80);
    const result = _formatLearningLine({ subject: long, confidence: 0.9, type: 'pattern' });
    expect(result.length).toBe(80);
  });

  it('passes special-char subjects (quotes, brackets) through verbatim — banner is plain text', () => {
    expect(_formatLearningLine({ subject: 'a"b[c]', confidence: 0.5, type: 't' }))
      .toBe('  • a"b[c] (0.5, t)');
  });

  it('falls back to plain truncation when the suffix alone overshoots width', () => {
    // type='a'.repeat(70) makes the suffix ~78 chars → budget < 0 → fall back
    // to _truncateLine(naive). Result must be exactly 80 chars with ellipsis.
    const longType = 'a'.repeat(70);
    const out = _formatLearningLine({ subject: 'sub', confidence: 0.5, type: longType });
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('drops orphan high-surrogate at the subject trim boundary', () => {
    // Build a subject where the truncation cut would land mid-surrogate-pair.
    // Budget for subject = 80 - 4 - len(' (0.9, p)') - 1 = 80 - 4 - 9 - 1 = 66.
    // Place '📚' (surrogate pair) so its high-surrogate sits at index 65 (last
    // kept code unit) → defensive trim drops it.
    const subj = 'x'.repeat(65) + '📚' + 'y'.repeat(20);
    const result = _formatLearningLine({ subject: subj, confidence: 0.9, type: 'p' });
    // Suffix preserved
    expect(result.endsWith(' (0.9, p)')).toBe(true);
    // No orphan high-surrogate emitted
    expect(result.includes('\uD83D')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group C — formatStatsLine
// ---------------------------------------------------------------------------

describe('_formatStatsLine', () => {
  it('formats all-present stats to exact literal with "days ago" suffix', () => {
    expect(_formatStatsLine({ memoryFiles: 12, sessionsEver: 42, daysSinceCleanup: 3 }))
      .toBe('12 memory files · 42 sessions ever · last cleanup 3 days ago');
  });

  it('renders "last cleanup: never" when daysSinceCleanup is null', () => {
    expect(_formatStatsLine({ memoryFiles: 12, sessionsEver: 42, daysSinceCleanup: null }))
      .toBe('12 memory files · 42 sessions ever · last cleanup: never');
  });

  it('renders "last cleanup: never" when daysSinceCleanup is undefined', () => {
    expect(_formatStatsLine({ memoryFiles: 12, sessionsEver: 42, daysSinceCleanup: undefined }))
      .toBe('12 memory files · 42 sessions ever · last cleanup: never');
  });

  it('renders all-zero values as exact literal', () => {
    expect(_formatStatsLine({ memoryFiles: 0, sessionsEver: 0, daysSinceCleanup: 0 }))
      .toBe('0 memory files · 0 sessions ever · last cleanup 0 days ago');
  });

  it('defaults non-numeric memoryFiles to 0', () => {
    expect(_formatStatsLine({ memoryFiles: 'nope', sessionsEver: 5, daysSinceCleanup: 1 }))
      .toBe('0 memory files · 5 sessions ever · last cleanup 1 days ago');
  });

  it('defaults non-numeric sessionsEver to 0', () => {
    expect(_formatStatsLine({ memoryFiles: 3, sessionsEver: null, daysSinceCleanup: null }))
      .toBe('3 memory files · 0 sessions ever · last cleanup: never');
  });
});

// ---------------------------------------------------------------------------
// Group D — formatBanner
// ---------------------------------------------------------------------------

describe('_formatBanner', () => {
  it('AC-mandated EXACT fresh-repo fallback literal when fresh===true', () => {
    expect(_formatBanner({ fresh: true })).toBe(
      "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.",
    );
  });

  it('fresh===true output has NO trailing newline', () => {
    const result = _formatBanner({ fresh: true });
    expect(result.endsWith('\n')).toBe(false);
  });

  it('fresh===true ignores every other input field (no learnings/stats/peers rendered)', () => {
    const result = _formatBanner({
      fresh: true,
      topLearnings: [{ subject: 'x', confidence: 0.9, type: 'p' }],
      stats: { memoryFiles: 99, sessionsEver: 99, daysSinceCleanup: 99 },
      peerExcerpts: { user: ['Section', 'Content'], agent: null },
    });
    expect(result).toBe(
      "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.",
    );
  });

  it('returns "" for null inputs', () => {
    expect(_formatBanner(null)).toBe('');
  });

  it('returns "" for undefined inputs', () => {
    expect(_formatBanner(undefined)).toBe('');
  });

  it('renders header + 5 learning lines + stats line + 2 peer excerpts', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [
        { subject: 'a', confidence: 0.9, type: 'p' },
        { subject: 'b', confidence: 0.8, type: 'p' },
        { subject: 'c', confidence: 0.7, type: 'p' },
        { subject: 'd', confidence: 0.6, type: 'p' },
        { subject: 'e', confidence: 0.5, type: 'p' },
      ],
      stats: { memoryFiles: 5, sessionsEver: 10, daysSinceCleanup: 1 },
      peerExcerpts: {
        user: ['Background', 'I am a dev'],
        agent: ['Style', 'Be terse'],
      },
    });
    const lines = result.split('\n');
    expect(lines).toEqual([
      '📚 Loaded from memory',
      '  • a (0.9, p)',
      '  • b (0.8, p)',
      '  • c (0.7, p)',
      '  • d (0.6, p)',
      '  • e (0.5, p)',
      '5 memory files · 10 sessions ever · last cleanup 1 days ago',
      '  USER.md — Background: I am a dev',
      '  AGENT.md — Style: Be terse',
    ]);
  });

  it('renders only N learning lines when topLearnings has N<5 entries', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [
        { subject: 'a', confidence: 0.9, type: 'p' },
        { subject: 'b', confidence: 0.8, type: 'p' },
        { subject: 'c', confidence: 0.7, type: 'p' },
      ],
      stats: { memoryFiles: 5, sessionsEver: 10, daysSinceCleanup: 1 },
      peerExcerpts: { user: null, agent: null },
    });
    const lines = result.split('\n');
    expect(lines.length).toBe(5); // header + 3 learnings + stats
    expect(lines[0]).toBe('📚 Loaded from memory');
    expect(lines[1]).toBe('  • a (0.9, p)');
    expect(lines[2]).toBe('  • b (0.8, p)');
    expect(lines[3]).toBe('  • c (0.7, p)');
    expect(lines[4]).toBe('5 memory files · 10 sessions ever · last cleanup 1 days ago');
  });

  it('skips BOTH peer excerpts when both are null', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [],
      stats: { memoryFiles: 1, sessionsEver: 1, daysSinceCleanup: null },
      peerExcerpts: { user: null, agent: null },
    });
    expect(result).toBe(
      [
        '📚 Loaded from memory',
        '1 memory files · 1 sessions ever · last cleanup: never',
      ].join('\n'),
    );
  });

  it('renders only USER.md line when only user excerpt is present', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [],
      stats: { memoryFiles: 1, sessionsEver: 1, daysSinceCleanup: null },
      peerExcerpts: { user: ['Section', 'Content'], agent: null },
    });
    expect(result).toBe(
      [
        '📚 Loaded from memory',
        '1 memory files · 1 sessions ever · last cleanup: never',
        '  USER.md — Section: Content',
      ].join('\n'),
    );
  });

  it('renders only AGENT.md line when only agent excerpt is present', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [],
      stats: { memoryFiles: 1, sessionsEver: 1, daysSinceCleanup: null },
      peerExcerpts: { user: null, agent: ['Style', 'Be terse'] },
    });
    expect(result).toBe(
      [
        '📚 Loaded from memory',
        '1 memory files · 1 sessions ever · last cleanup: never',
        '  AGENT.md — Style: Be terse',
      ].join('\n'),
    );
  });

  it('skips stats line when inputs.stats is null', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [{ subject: 'x', confidence: 0.9, type: 'p' }],
      stats: null,
      peerExcerpts: { user: null, agent: null },
    });
    expect(result).toBe(
      [
        '📚 Loaded from memory',
        '  • x (0.9, p)',
      ].join('\n'),
    );
  });

  it('skips entries that are not objects in topLearnings', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [
        null,
        'not-an-object',
        { subject: 'good', confidence: 0.5, type: 'p' },
      ],
      stats: null,
      peerExcerpts: { user: null, agent: null },
    });
    expect(result).toBe(
      [
        '📚 Loaded from memory',
        '  • good (0.5, p)',
      ].join('\n'),
    );
  });

  it('renders peer line with section-only when content is null', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [],
      stats: null,
      peerExcerpts: { user: ['Section', null], agent: null },
    });
    expect(result).toBe(
      [
        '📚 Loaded from memory',
        '  USER.md — Section',
      ].join('\n'),
    );
  });

  it('renders peer line with content-only when section is null', () => {
    const result = _formatBanner({
      fresh: false,
      topLearnings: [],
      stats: null,
      peerExcerpts: { user: [null, 'Just content'], agent: null },
    });
    expect(result).toBe(
      [
        '📚 Loaded from memory',
        '  USER.md — Just content',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Group E — formatBanner snapshot stability (inline)
// ---------------------------------------------------------------------------

describe('_formatBanner snapshot stability', () => {
  it('renders a stable banner shape for a frozen synthetic input', () => {
    const inputs = {
      fresh: false,
      topLearnings: [
        { subject: 'count-drift-recurrence', confidence: 0.9, type: 'pattern' },
        { subject: 'mock-leakage', confidence: 0.7, type: 'pitfall' },
        { subject: 'auto-dream-cadence', confidence: 0.5, type: 'cadence' },
      ],
      stats: { memoryFiles: 12, sessionsEver: 42, daysSinceCleanup: 3 },
      peerExcerpts: {
        user: ['Background', 'A senior backend dev'],
        agent: ['Style', 'Be terse and exact'],
      },
    };
    expect(_formatBanner(inputs)).toMatchInlineSnapshot(`
      "📚 Loaded from memory
        • count-drift-recurrence (0.9, pattern)
        • mock-leakage (0.7, pitfall)
        • auto-dream-cadence (0.5, cadence)
      12 memory files · 42 sessions ever · last cleanup 3 days ago
        USER.md — Background: A senior backend dev
        AGENT.md — Style: Be terse and exact"
    `);
  });
});

// ---------------------------------------------------------------------------
// Group F — truncateLine
// ---------------------------------------------------------------------------

describe('_truncateLine', () => {
  it('returns short strings unchanged', () => {
    expect(_truncateLine('short', 80)).toBe('short');
  });

  it('truncates a 100-char string to exactly 80 chars including the ellipsis', () => {
    const out = _truncateLine('x'.repeat(100), 80);
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty string for empty input', () => {
    expect(_truncateLine('', 80)).toBe('');
  });

  it('returns input unchanged when length === width', () => {
    const exact = 'x'.repeat(80);
    expect(_truncateLine(exact, 80)).toBe(exact);
  });

  it('truncates to exactly width chars when input is longer than width by 1', () => {
    const out = _truncateLine('x'.repeat(81), 80);
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('defaults to width=80 when called with a single argument', () => {
    const out = _truncateLine('y'.repeat(100));
    expect(out.length).toBe(80);
  });

  it('returns empty string for non-string input', () => {
    expect(_truncateLine(null)).toBe('');
    expect(_truncateLine(undefined)).toBe('');
    expect(_truncateLine(42)).toBe('');
  });

  it('does not split a surrogate pair at the truncation boundary', () => {
    // '📚' is a 2-code-unit surrogate pair. Place one at the boundary to
    // confirm the defensive surrogate trim drops the orphan.
    const prefix = 'a'.repeat(78);
    const input = prefix + '📚' + 'b'.repeat(20);
    const out = _truncateLine(input, 80);
    // The high-surrogate at position 79 would be orphaned; the trim drops it
    // so the result is `aaa…aaa` + `…` = 79 chars total (one shorter than width).
    expect(out.length).toBe(79);
    expect(out.endsWith('…')).toBe(true);
    // The emoji was not partially included
    expect(out.includes('\uD83D')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Group G — renderMemoryBanner gating logic ONLY
// (vi.mock at file scope handles I/O deps; we only assert gating behaviour.)
// ---------------------------------------------------------------------------

describe('renderMemoryBanner gating', () => {
  it('returns empty string when config.persistence === false', async () => {
    const result = await renderMemoryBanner({
      repoRoot: '/some/repo',
      config: { persistence: false },
    });
    expect(result).toBe('');
  });

  it('returns empty string when config.memory.banner.enabled === false', async () => {
    const result = await renderMemoryBanner({
      repoRoot: '/some/repo',
      config: { persistence: true, memory: { banner: { enabled: false } } },
    });
    expect(result).toBe('');
  });

  it('skips I/O entirely when persistence=false (mocks should NOT be called)', async () => {
    await renderMemoryBanner({
      repoRoot: '/some/repo',
      config: { persistence: false },
    });
    expect(vi.mocked(surfaceTopN)).not.toHaveBeenCalled();
    expect(vi.mocked(readPeerCards)).not.toHaveBeenCalled();
  });

  it('defaults to ENABLED when config.memory is undefined (banner renders)', async () => {
    // No topLearnings, no sessions → triggers fresh-repo fallback
    vi.mocked(surfaceTopN).mockResolvedValue([]);
    vi.mocked(readPeerCards).mockResolvedValue({ user: null, agent: null });
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });

    const result = await renderMemoryBanner({
      repoRoot: '/some/repo',
      config: { persistence: true },
    });
    // Fresh-repo fallback (no learnings + no sessions)
    expect(result).toBe(
      "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.",
    );
  });

  it('defaults to ENABLED when config.memory.banner is undefined', async () => {
    const result = await renderMemoryBanner({
      repoRoot: '/some/repo',
      config: { persistence: true, memory: {} },
    });
    expect(result).toBe(
      "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.",
    );
  });

  it('renders when config is null (defensive: no gating triggered)', async () => {
    const result = await renderMemoryBanner({
      repoRoot: '/some/repo',
      config: null,
    });
    // null config: persistence!==false AND memory.banner.enabled!==false → proceeds
    expect(result).toBe(
      "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.",
    );
  });

  it('renders when config is undefined (defensive: no gating triggered)', async () => {
    const result = await renderMemoryBanner({
      repoRoot: '/some/repo',
    });
    expect(result).toBe(
      "📚 Memory: 0 entries yet (first session). I'll start learning from this session forward.",
    );
  });

  it('throws TypeError when repoRoot is missing', async () => {
    await expect(renderMemoryBanner({ config: { persistence: true } }))
      .rejects.toThrow(TypeError);
  });

  it('throws TypeError when repoRoot is empty string', async () => {
    await expect(renderMemoryBanner({ repoRoot: '', config: { persistence: true } }))
      .rejects.toThrow(TypeError);
  });

  it('renders full banner via mocked I/O when learnings + sessions exist', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([
      { subject: 'pat-1', confidence: 0.9, type: 'pattern' },
    ]);
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
    vi.mocked(readPeerCards).mockResolvedValue({
      user: { body: '## Background\nA test user' },
      agent: null,
    });

    const result = await renderMemoryBanner({
      repoRoot: '/some/repo',
      memoryDir: '/mocked/memory',
      config: { persistence: true },
    });
    // Not the fresh-repo fallback (topLearnings.length > 0).
    // Header is present, learning line is present.
    expect(result.startsWith('📚 Loaded from memory')).toBe(true);
    expect(result).toContain('  • pat-1 (0.9, pattern)');
  });
});

// ---------------------------------------------------------------------------
// Group H — readBannerInputs (gating contract only; full I/O is P2's job)
// ---------------------------------------------------------------------------

describe('readBannerInputs contract', () => {
  it('throws TypeError when repoRoot is missing', async () => {
    await expect(readBannerInputs({})).rejects.toThrow(TypeError);
  });

  it('throws TypeError when repoRoot is empty string', async () => {
    await expect(readBannerInputs({ repoRoot: '' })).rejects.toThrow(TypeError);
  });

  it('returns fresh=true when no learnings and no sessions (via mocks)', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([]);
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
    vi.mocked(readPeerCards).mockResolvedValue({ user: null, agent: null });

    const result = await readBannerInputs({
      repoRoot: '/some/repo',
      memoryDir: '/nonexistent/mem',
    });
    expect(result.fresh).toBe(true);
    expect(result.topLearnings).toEqual([]);
  });

  it('returns fresh=false when learnings exist (via mock)', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([
      { subject: 's', confidence: 0.9, type: 'p' },
    ]);
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
    vi.mocked(readPeerCards).mockResolvedValue({ user: null, agent: null });

    const result = await readBannerInputs({
      repoRoot: '/some/repo',
      memoryDir: '/nonexistent/mem',
    });
    expect(result.fresh).toBe(false);
    expect(result.topLearnings.length).toBe(1);
  });

  it('normalizes surfaceTopN entries to {subject, confidence, type} shape', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([
      { subject: 'a', confidence: 0.8, type: 'pattern', id: 'extra', noise: 'ignored' },
    ]);
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
    vi.mocked(readPeerCards).mockResolvedValue({ user: null, agent: null });

    const result = await readBannerInputs({
      repoRoot: '/some/repo',
      memoryDir: '/nonexistent/mem',
    });
    expect(result.topLearnings[0]).toEqual({
      subject: 'a',
      confidence: 0.8,
      type: 'pattern',
    });
  });

  it('defaults missing learning fields to safe values', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([
      { /* nothing */ },
    ]);
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
    vi.mocked(readPeerCards).mockResolvedValue({ user: null, agent: null });

    const result = await readBannerInputs({
      repoRoot: '/some/repo',
      memoryDir: '/nonexistent/mem',
    });
    expect(result.topLearnings[0]).toEqual({
      subject: '',
      confidence: 0,
      type: 'unknown',
    });
  });

  it('returns {user: null, agent: null} when normalised excerpts are both [null, null]', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([]);
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
    vi.mocked(readPeerCards).mockResolvedValue({
      user: { body: '' },
      agent: { body: '' },
    });

    const result = await readBannerInputs({
      repoRoot: '/some/repo',
      memoryDir: '/nonexistent/mem',
    });
    expect(result.peerExcerpts).toEqual({ user: null, agent: null });
  });

  it('parses peer-card bodies via extractCardExcerpt', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([]);
    vi.mocked(readDreamSignals).mockResolvedValue({ lastCleanupAt: null });
    vi.mocked(readPeerCards).mockResolvedValue({
      user: { body: '## Background\nI am here' },
      agent: null,
    });

    const result = await readBannerInputs({
      repoRoot: '/some/repo',
      memoryDir: '/nonexistent/mem',
    });
    expect(result.peerExcerpts.user).toEqual(['Background', 'I am here']);
    expect(result.peerExcerpts.agent).toBe(null);
  });

  // ---------------------------------------------------------------------------
  // G1 (#541) — daysSinceCleanup clock-skew clamp (memory-banner.mjs:375)
  //
  // Production code: `daysSinceCleanup = Math.max(0, Math.floor(deltaMs / 86_400_000))`
  // Falsification: removing `Math.max(0, ...)` lets a future lastCleanupAt
  // produce a NEGATIVE day count (e.g. -9). This test asserts === 0 with
  // hardcoded literals to catch that exact regression.
  // ---------------------------------------------------------------------------

  it('clamps daysSinceCleanup to 0 when lastCleanupAt is in the future (clock-skew defense)', async () => {
    vi.mocked(surfaceTopN).mockResolvedValue([]);
    vi.mocked(readPeerCards).mockResolvedValue({ user: null, agent: null });
    // lastCleanupAt is 9 days AFTER the injected clock — without the
    // Math.max clamp, daysSinceCleanup would be -9.
    vi.mocked(readDreamSignals).mockResolvedValue({
      lastCleanupAt: '2026-06-01T00:00:00Z',
    });

    const result = await readBannerInputs({
      repoRoot: '/some/repo',
      memoryDir: '/nonexistent/mem',
      now: new Date('2026-05-23T00:00:00Z'),
    });

    expect(result.stats.daysSinceCleanup).toBe(0);
  });
});
