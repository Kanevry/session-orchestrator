import { describe, it, expect, vi } from 'vitest';
import {
  detectVcsForRepo,
  discoverVaultRepos,
} from '@lib/gitlab-portfolio/vcs-detect.mjs';

import path from 'node:path';

// ── detectVcsForRepo ───────────────────────────────────────────────────────────

describe('detectVcsForRepo — frontmatter fields', () => {
  it('returns gitlab when frontmatter has gitlab field', () => {
    const result = detectVcsForRepo({
      frontmatter: { gitlab: 'mygroup/myrepo' },
    });

    expect(result).toBe('gitlab');
  });

  it('returns github when frontmatter has github field (no gitlab)', () => {
    const result = detectVcsForRepo({
      frontmatter: { github: 'org/repo' },
    });

    expect(result).toBe('github');
  });

  it('prefers gitlab over github when both frontmatter fields are present', () => {
    const result = detectVcsForRepo({
      frontmatter: { gitlab: 'primary/repo', github: 'mirror/repo' },
    });

    expect(result).toBe('gitlab');
  });
});

describe('detectVcsForRepo — repo string heuristics', () => {
  it('returns gitlab for repo string containing gitlab.gotzendorfer.at', () => {
    const result = detectVcsForRepo({
      repo: 'gitlab.gotzendorfer.at/org/repo',
    });

    expect(result).toBe('gitlab');
  });

  it('returns gitlab for repo string containing gitlab.com', () => {
    const result = detectVcsForRepo({
      repo: 'gitlab.com/org/repo',
    });

    expect(result).toBe('gitlab');
  });

  it('returns github for repo string containing github.com', () => {
    const result = detectVcsForRepo({
      repo: 'github.com/org/repo',
    });

    expect(result).toBe('github');
  });

  it('returns github for shorthand org/repo format (fallback)', () => {
    const result = detectVcsForRepo({
      repo: 'some-org/some-repo',
    });

    expect(result).toBe('github');
  });
});

describe('detectVcsForRepo — no signal', () => {
  it('returns null when no frontmatter and no repo string provided', () => {
    const result = detectVcsForRepo({});

    expect(result).toBeNull();
  });

  it('returns null when called with undefined input', () => {
    const result = detectVcsForRepo(undefined);

    expect(result).toBeNull();
  });

  it('returns null when repo string has no recognizable pattern (single segment)', () => {
    const result = detectVcsForRepo({
      repo: 'barewordrepo',
    });

    // No slash → does not match shorthand pattern → null
    expect(result).toBeNull();
  });
});

// ── discoverVaultRepos ─────────────────────────────────────────────────────────

describe('discoverVaultRepos — happy path', () => {
  it('returns 2 entries when 2 project dirs each have _overview.md with gitlab/github', async () => {
    const vaultDir = '/fake/vault';
    const projectsDir = `${vaultDir}/01-projects`;

    const mockReaddir = vi.fn().mockResolvedValue(['proj-a', 'proj-b']);
    const mockStat = vi.fn().mockResolvedValue({ isDirectory: () => true });
    const mockReadFile = vi.fn().mockImplementation((filePath) => {
      if (filePath.includes('proj-a')) {
        return Promise.resolve('---\ngitlab: mygroup/proj-a\n---\n# Proj A\n');
      }
      if (filePath.includes('proj-b')) {
        return Promise.resolve('---\ngithub: org/proj-b\n---\n# Proj B\n');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await discoverVaultRepos({
      vaultDir,
      fs: { readdir: mockReaddir, readFile: mockReadFile, stat: mockStat },
    });

    expect(result).toHaveLength(2);

    const projA = result.find((r) => r.slug === 'proj-a');
    expect(projA).toBeDefined();
    expect(projA.repo).toBe('mygroup/proj-a');
    expect(projA.vcs).toBe('gitlab');
    expect(projA.overviewPath).toBe(path.join(projectsDir, 'proj-a', '_overview.md'));

    const projB = result.find((r) => r.slug === 'proj-b');
    expect(projB).toBeDefined();
    expect(projB.repo).toBe('org/proj-b');
    expect(projB.vcs).toBe('github');
  });
});

describe('discoverVaultRepos — skips projects without _overview.md', () => {
  it('silently omits project dir with no _overview.md file', async () => {
    const mockReaddir = vi.fn().mockResolvedValue(['has-overview', 'no-overview']);
    const mockStat = vi.fn().mockResolvedValue({ isDirectory: () => true });
    const mockReadFile = vi.fn().mockImplementation((filePath) => {
      if (filePath.includes('has-overview')) {
        return Promise.resolve('---\ngitlab: mygroup/has-overview\n---\n');
      }
      // no-overview: _overview.md does not exist
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await discoverVaultRepos({
      vaultDir: '/fake/vault',
      fs: { readdir: mockReaddir, readFile: mockReadFile, stat: mockStat },
    });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('has-overview');
  });
});

describe('discoverVaultRepos — skips projects lacking gitlab/github keys', () => {
  it('silently omits _overview.md with no gitlab or github frontmatter key', async () => {
    const mockReaddir = vi.fn().mockResolvedValue(['with-vcs', 'without-vcs']);
    const mockStat = vi.fn().mockResolvedValue({ isDirectory: () => true });
    const mockReadFile = vi.fn().mockImplementation((filePath) => {
      if (filePath.includes('with-vcs')) {
        return Promise.resolve('---\ngitlab: org/with-vcs\n---\n');
      }
      if (filePath.includes('without-vcs')) {
        // Has frontmatter but no gitlab/github keys
        return Promise.resolve('---\ntitle: No VCS\nauthor: Bernhard\n---\n# Without VCS\n');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await discoverVaultRepos({
      vaultDir: '/fake/vault',
      fs: { readdir: mockReaddir, readFile: mockReadFile, stat: mockStat },
    });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('with-vcs');
  });
});

describe('discoverVaultRepos — prefers gitlab over github when both present', () => {
  it('returns vcs:gitlab and uses the gitlab field when both gitlab and github are present', async () => {
    const mockReaddir = vi.fn().mockResolvedValue(['dual-vcs']);
    const mockStat = vi.fn().mockResolvedValue({ isDirectory: () => true });
    const mockReadFile = vi.fn().mockResolvedValue(
      '---\ngitlab: primary-group/dual-vcs\ngithub: mirror-org/dual-vcs\n---\n# Dual VCS\n',
    );

    const result = await discoverVaultRepos({
      vaultDir: '/fake/vault',
      fs: { readdir: mockReaddir, readFile: mockReadFile, stat: mockStat },
    });

    expect(result).toHaveLength(1);
    expect(result[0].vcs).toBe('gitlab');
    expect(result[0].repo).toBe('primary-group/dual-vcs');
  });
});

describe('discoverVaultRepos — empty/error cases', () => {
  it('returns empty array when vaultDir is null', async () => {
    const result = await discoverVaultRepos({ vaultDir: null });

    expect(result).toEqual([]);
  });

  it('returns empty array when 01-projects directory does not exist', async () => {
    const mockReaddir = vi.fn().mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const result = await discoverVaultRepos({
      vaultDir: '/nonexistent/vault',
      fs: { readdir: mockReaddir, readFile: vi.fn(), stat: vi.fn() },
    });

    expect(result).toEqual([]);
  });

  it('skips dotfile entries in 01-projects', async () => {
    const mockReaddir = vi.fn().mockResolvedValue(['.DS_Store', '.gitkeep', 'real-proj']);
    const mockStat = vi.fn().mockResolvedValue({ isDirectory: () => true });
    const mockReadFile = vi.fn().mockImplementation((filePath) => {
      if (filePath.includes('real-proj')) {
        return Promise.resolve('---\ngitlab: org/real-proj\n---\n');
      }
      return Promise.reject(new Error('ENOENT'));
    });

    const result = await discoverVaultRepos({
      vaultDir: '/fake/vault',
      fs: { readdir: mockReaddir, readFile: mockReadFile, stat: mockStat },
    });

    expect(result).toHaveLength(1);
    expect(result[0].slug).toBe('real-proj');
  });
});
