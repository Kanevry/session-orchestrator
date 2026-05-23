/**
 * tests/scripts/lib/peer-cards/staleness-banner.test.mjs
 *
 * Unit tests for scripts/lib/peer-cards/staleness-banner.mjs.
 * Mocks readPeerCards to isolate banner orchestration logic from the reader.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@lib/peer-cards/reader.mjs', () => ({
  readPeerCards: vi.fn(),
}));

import { checkPeerCardsStaleness } from '@lib/peer-cards/staleness-banner.mjs';
import { readPeerCards } from '@lib/peer-cards/reader.mjs';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FRESH_CARD = { frontmatter: { id: 'x' }, stalenessDays: 5, isStale: false, validation: { ok: true } };
const STALE_USER = { frontmatter: { id: 'u' }, stalenessDays: 45, isStale: true, validation: { ok: true } };
const STALE_AGENT = { frontmatter: { id: 'a' }, stalenessDays: 35, isStale: true, validation: { ok: true } };

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('checkPeerCardsStaleness()', () => {
  beforeEach(() => {
    vi.mocked(readPeerCards).mockReset();
  });

  it('returns null when called with no arguments', async () => {
    const result = await checkPeerCardsStaleness();
    expect(result).toBeNull();
  });

  it('returns null when repoRoot is null', async () => {
    const result = await checkPeerCardsStaleness({ repoRoot: null });
    expect(result).toBeNull();
  });

  it('returns null when repoRoot is a number (non-string)', async () => {
    const result = await checkPeerCardsStaleness({ repoRoot: 123 });
    expect(result).toBeNull();
  });

  it('returns null when readPeerCards throws', async () => {
    vi.mocked(readPeerCards).mockRejectedValue(new Error('disk error'));
    const result = await checkPeerCardsStaleness({ repoRoot: '/some/repo' });
    expect(result).toBeNull();
  });

  it('returns null when result.exists is false (no peers dir)', async () => {
    vi.mocked(readPeerCards).mockResolvedValue({ exists: false });
    const result = await checkPeerCardsStaleness({ repoRoot: '/some/repo' });
    expect(result).toBeNull();
  });

  it('returns warn banner when both USER and AGENT are stale', async () => {
    vi.mocked(readPeerCards).mockResolvedValue({
      exists: true,
      user: STALE_USER,
      agent: STALE_AGENT,
    });
    const result = await checkPeerCardsStaleness({ repoRoot: '/repo' });
    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('USER.md');
    expect(result.message).toContain('AGENT.md');
    expect(result.message).toContain('45d');
    expect(result.message).toContain('35d');
    expect(result.stale).toHaveLength(2);
  });

  it('returns banner listing only USER.md when only USER is stale', async () => {
    vi.mocked(readPeerCards).mockResolvedValue({
      exists: true,
      user: STALE_USER,
      agent: FRESH_CARD,
    });
    const result = await checkPeerCardsStaleness({ repoRoot: '/repo' });
    expect(result).not.toBeNull();
    expect(result.message).toContain('USER.md');
    expect(result.message).not.toContain('AGENT.md');
    expect(result.stale).toHaveLength(1);
  });

  it('returns banner listing only AGENT.md when only AGENT is stale', async () => {
    vi.mocked(readPeerCards).mockResolvedValue({
      exists: true,
      user: FRESH_CARD,
      agent: STALE_AGENT,
    });
    const result = await checkPeerCardsStaleness({ repoRoot: '/repo' });
    expect(result).not.toBeNull();
    expect(result.message).toContain('AGENT.md');
    expect(result.message).not.toContain('USER.md');
    expect(result.stale).toHaveLength(1);
  });

  it('excludes stale card with null frontmatter (malformed) from banner', async () => {
    vi.mocked(readPeerCards).mockResolvedValue({
      exists: true,
      user: { frontmatter: null, stalenessDays: Infinity, isStale: true, validation: { ok: false } },
      agent: FRESH_CARD,
    });
    const result = await checkPeerCardsStaleness({ repoRoot: '/repo' });
    expect(result).toBeNull();
  });

  it('excludes stale card with stalenessDays === Infinity from banner', async () => {
    vi.mocked(readPeerCards).mockResolvedValue({
      exists: true,
      user: { frontmatter: { id: 'u' }, stalenessDays: Infinity, isStale: true, validation: { ok: true } },
      agent: FRESH_CARD,
    });
    const result = await checkPeerCardsStaleness({ repoRoot: '/repo' });
    expect(result).toBeNull();
  });

  it('returns null when both cards are fresh', async () => {
    vi.mocked(readPeerCards).mockResolvedValue({
      exists: true,
      user: FRESH_CARD,
      agent: FRESH_CARD,
    });
    const result = await checkPeerCardsStaleness({ repoRoot: '/repo' });
    expect(result).toBeNull();
  });
});
