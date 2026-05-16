import { describe, it, expect, vi } from 'vitest';
import {
  GENERATOR_MARKER,
  renderPortfolio,
  writePortfolio,
} from '@lib/gitlab-portfolio/markdown-writer.mjs';

// Fixed reference time
const NOW = new Date('2026-01-15T12:00:00Z');

// Helper: build a minimal summaries Map with one repo
function oneRepoSummaries(repo = 'org/repo-a') {
  return new Map([
    [repo, {
      openCount: 3,
      criticalCount: 1,
      staleCount: 0,
      nextMilestone: null,
      lastActivity: '2026-01-14T10:00:00Z',
      topThree: [
        { iid: 1, title: 'Bug A', labels: ['bug'], url: 'https://example.com/1' },
      ],
    }],
  ]);
}

// ── GENERATOR_MARKER ───────────────────────────────────────────────────────────

describe('GENERATOR_MARKER', () => {
  it('equals the documented sentinel value', () => {
    expect(GENERATOR_MARKER).toBe('session-orchestrator-gitlab-portfolio@1');
  });
});

// ── renderPortfolio ────────────────────────────────────────────────────────────

describe('renderPortfolio — frontmatter _generator sentinel', () => {
  it('includes _generator: session-orchestrator-gitlab-portfolio@1 in frontmatter', () => {
    const md = renderPortfolio(oneRepoSummaries(), { now: NOW });

    expect(md).toContain(`_generator: ${GENERATOR_MARKER}`);
  });

  it('produces a frontmatter block enclosed in --- delimiters', () => {
    const md = renderPortfolio(oneRepoSummaries(), { now: NOW });
    const lines = md.split('\n');

    expect(lines[0]).toBe('---');
    // Find closing ---
    const closingIdx = lines.indexOf('---', 1);
    expect(closingIdx).toBeGreaterThan(1);
  });
});

describe('renderPortfolio — deterministic alphabetical ordering', () => {
  it('sorts repos alphabetically regardless of insertion order', () => {
    const summaries = new Map([
      ['zebra/repo', { openCount: 1, criticalCount: 0, staleCount: 0, nextMilestone: null, lastActivity: null, topThree: [] }],
      ['alpha/repo', { openCount: 2, criticalCount: 0, staleCount: 0, nextMilestone: null, lastActivity: null, topThree: [] }],
      ['middle/repo', { openCount: 0, criticalCount: 0, staleCount: 0, nextMilestone: null, lastActivity: null, topThree: [] }],
    ]);

    const md = renderPortfolio(summaries, { now: NOW });

    const alphaPos = md.indexOf('alpha/repo');
    const middlePos = md.indexOf('middle/repo');
    const zebraPos = md.indexOf('zebra/repo');

    expect(alphaPos).toBeLessThan(middlePos);
    expect(middlePos).toBeLessThan(zebraPos);
  });

  it('produces identical output for identical input (modulo updated timestamp)', () => {
    const summaries = oneRepoSummaries();
    const md1 = renderPortfolio(summaries, { now: NOW, updatedPlaceholder: '__TS__' });
    const md2 = renderPortfolio(summaries, { now: NOW, updatedPlaceholder: '__TS__' });

    expect(md1).toBe(md2);
  });
});

describe('renderPortfolio — created date preservation', () => {
  it('uses passed createdIso instead of now when createdIso is provided', () => {
    const createdIso = '2025-12-01T00:00:00.000Z';
    const md = renderPortfolio(oneRepoSummaries(), { now: NOW, createdIso });

    expect(md).toContain(`created: ${createdIso}`);
  });

  it('falls back to now ISO when createdIso is not provided', () => {
    const md = renderPortfolio(oneRepoSummaries(), { now: NOW });

    // Should contain created: <NOW ISO>
    expect(md).toContain(`created: ${NOW.toISOString()}`);
  });
});

describe('renderPortfolio — body structure', () => {
  it('includes the GitLab Portfolio heading and a Summary section', () => {
    const md = renderPortfolio(oneRepoSummaries(), { now: NOW });

    expect(md).toContain('# GitLab Portfolio');
    expect(md).toContain('## Summary');
    expect(md).toContain('## Repos');
    expect(md).toContain('## Per-Repo Detail');
  });

  it('renders stale-days in the Summary table', () => {
    const md = renderPortfolio(oneRepoSummaries(), { now: NOW, staleDays: 45 });

    expect(md).toContain('>45 days');
  });

  it('includes repo data in the Repos table row', () => {
    const md = renderPortfolio(oneRepoSummaries('org/alpha'), { now: NOW });

    expect(md).toContain('org/alpha');
    expect(md).toContain('| 3 |'); // openCount = 3
  });
});

// ── writePortfolio ─────────────────────────────────────────────────────────────

describe('writePortfolio — dryRun: true', () => {
  it('returns action dry-run and does NOT call writeFileSync', () => {
    const mockWriteFile = vi.fn();
    const mockExists = vi.fn().mockReturnValue(false);

    const result = writePortfolio({
      outputPath: '/tmp/fake/PORTFOLIO.md',
      content: '---\n_generator: session-orchestrator-gitlab-portfolio@1\n---\n',
      now: NOW,
      dryRun: true,
      fs: {
        existsSync: mockExists,
        writeFileSync: mockWriteFile,
        readFileSync: vi.fn(),
        mkdirSync: vi.fn(),
      },
    });

    expect(result.action).toBe('dry-run');
    expect(result.path).toBe('/tmp/fake/PORTFOLIO.md');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('writePortfolio — existing file without _generator', () => {
  it('returns action skipped-handwritten and does NOT write', () => {
    const existingContent = '# Handwritten file\n\nNo generator here.\n';
    const mockWriteFile = vi.fn();

    const result = writePortfolio({
      outputPath: '/tmp/portfolio.md',
      content: '---\n_generator: session-orchestrator-gitlab-portfolio@1\n---\n# GitLab Portfolio\n',
      now: NOW,
      dryRun: false,
      fs: {
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue(existingContent),
        writeFileSync: mockWriteFile,
        mkdirSync: vi.fn(),
      },
    });

    expect(result.action).toBe('skipped-handwritten');
    expect(result.path).toBe('/tmp/portfolio.md');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('writePortfolio — existing file with matching _generator and identical content', () => {
  it('returns action skipped-noop and does NOT write when content is identical (modulo updated)', () => {
    const content = renderPortfolio(oneRepoSummaries(), { now: NOW });
    // Simulate existing file identical to what would be written
    const mockWriteFile = vi.fn();

    const result = writePortfolio({
      outputPath: '/tmp/portfolio.md',
      content,
      now: NOW,
      dryRun: false,
      fs: {
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue(content),
        writeFileSync: mockWriteFile,
        mkdirSync: vi.fn(),
      },
    });

    expect(result.action).toBe('skipped-noop');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

describe('writePortfolio — fresh write (file does not exist)', () => {
  it('returns action written and calls writeFileSync with the content', () => {
    const content = renderPortfolio(oneRepoSummaries(), { now: NOW });
    const mockWriteFile = vi.fn();
    const mockMkdir = vi.fn();

    const result = writePortfolio({
      outputPath: '/tmp/vault/PORTFOLIO.md',
      content,
      now: NOW,
      dryRun: false,
      fs: {
        existsSync: vi.fn().mockReturnValue(false),
        readFileSync: vi.fn(),
        writeFileSync: mockWriteFile,
        mkdirSync: mockMkdir,
      },
    });

    expect(result.action).toBe('written');
    expect(result.path).toBe('/tmp/vault/PORTFOLIO.md');
    expect(mockWriteFile).toHaveBeenCalledOnce();
    expect(mockWriteFile).toHaveBeenCalledWith('/tmp/vault/PORTFOLIO.md', content, 'utf8');
  });
});

describe('writePortfolio — existing file with different _generator', () => {
  it('returns action skipped-handwritten when _generator does not match the sentinel', () => {
    const existingContent = '---\n_generator: some-other-tool@2\ntype: dashboard\n---\n# Portfolio\n';
    const mockWriteFile = vi.fn();

    const result = writePortfolio({
      outputPath: '/tmp/portfolio.md',
      content: renderPortfolio(oneRepoSummaries(), { now: NOW }),
      now: NOW,
      dryRun: false,
      fs: {
        existsSync: vi.fn().mockReturnValue(true),
        readFileSync: vi.fn().mockReturnValue(existingContent),
        writeFileSync: mockWriteFile,
        mkdirSync: vi.fn(),
      },
    });

    expect(result.action).toBe('skipped-handwritten');
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
