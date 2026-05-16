/**
 * vcs-detect.mjs — VCS auto-detection helpers for the gitlab-portfolio skill.
 *
 * Exports:
 *   discoverVaultRepos   — scan vault 01-projects/ for registered repos
 *   detectVcsForRepo     — resolve 'gitlab' | 'github' | null for a single spec
 *
 * Used by cli.mjs as the discovery step before aggregation.
 */

import os from 'node:os';
import fsP from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter as _parseFrontmatter } from '../vault-mirror/utils.mjs';

// ── detectVcsForRepo ──────────────────────────────────────────────────────────

/**
 * Resolve the VCS platform for a single repo spec.
 *
 * Priority:
 *   1. Explicit `frontmatter.gitlab` field present → 'gitlab'
 *   2. Explicit `frontmatter.github` field present → 'github'
 *   3. `repo` string contains 'gitlab.gotzendorfer.at' or matches known GitLab patterns → 'gitlab'
 *   4. `repo` string contains 'github.com' or looks like an <org>/<repo> shorthand → 'github'
 *   5. Otherwise → null (caller decides)
 *
 * @param {{ frontmatter?: Record<string, string>, repo?: string }} input
 * @returns {'gitlab'|'github'|null}
 */
export function detectVcsForRepo(input) {
  const { frontmatter, repo } = input ?? {};

  // 1. Frontmatter: explicit gitlab field
  if (frontmatter && frontmatter['gitlab']) {
    return 'gitlab';
  }

  // 2. Frontmatter: explicit github field
  if (frontmatter && frontmatter['github']) {
    return 'github';
  }

  if (repo && typeof repo === 'string') {
    // 3. Host-pattern: known GitLab instance or group prefix
    if (
      repo.includes('gitlab.gotzendorfer.at') ||
      repo.includes('gitlab.com') ||
      repo.startsWith('gitlab/')
    ) {
      return 'gitlab';
    }

    // 4. Host-pattern: GitHub
    if (repo.includes('github.com') || repo.startsWith('github/')) {
      return 'github';
    }

    // Shorthand <org>/<repo> with no host marker: assume GitHub (common convention).
    // We only do this as a last resort — explicit frontmatter fields are preferred.
    if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
      return 'github';
    }
  }

  return null;
}

// ── discoverVaultRepos ────────────────────────────────────────────────────────

/**
 * Discover registered repos from a vault directory.
 *
 * Scans `<vaultDir>/01-projects/<slug>/_overview.md` frontmatter for `gitlab:`
 * and/or `github:` keys. If BOTH are present, `gitlab` wins (it is the primary
 * VCS; `github` is typically a mirror).
 *
 * Projects without either field are silently skipped. Missing `_overview.md`
 * files are silently skipped.
 *
 * @param {{
 *   vaultDir: string,
 *   fs?: { readdir: Function, readFile: Function, stat: Function },
 *   parseFrontmatter?: (content: string) => Record<string, string> | null,
 * }} opts
 * @returns {Promise<Array<{
 *   slug: string,
 *   repo: string,
 *   vcs: 'gitlab'|'github',
 *   overviewPath: string,
 * }>>}
 */
export async function discoverVaultRepos(opts) {
  const {
    vaultDir: rawVaultDir,
    fs: injectedFs,
    parseFrontmatter = _parseFrontmatter,
  } = opts;

  if (!rawVaultDir || typeof rawVaultDir !== 'string') {
    return [];
  }

  // Expand ~ if present
  const vaultDir = rawVaultDir.startsWith('~')
    ? path.join(os.homedir(), rawVaultDir.slice(1))
    : rawVaultDir;

  // Resolve fs functions (injectable for tests)
  const fsReaddir = injectedFs?.readdir ?? fsP.readdir;
  const fsReadFile = injectedFs?.readFile ?? fsP.readFile;
  const fsStat = injectedFs?.stat ?? fsP.stat;

  const projectsDir = path.join(vaultDir, '01-projects');

  // Read the 01-projects directory
  let entries;
  try {
    entries = await fsReaddir(projectsDir);
  } catch {
    // 01-projects dir does not exist — return empty
    return [];
  }

  const results = [];

  for (const entry of entries) {
    // Skip dotfiles
    if (entry.startsWith('.')) continue;

    const entryPath = path.join(projectsDir, entry);

    // Skip non-directories
    let stat;
    try {
      stat = await fsStat(entryPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const slug = entry;
    const overviewPath = path.join(entryPath, '_overview.md');

    // Read _overview.md — skip if absent
    let content;
    try {
      content = await fsReadFile(overviewPath, 'utf8');
    } catch {
      continue;
    }

    // Parse frontmatter
    const fm = parseFrontmatter(content);
    if (!fm) continue;

    const gitlabField = fm['gitlab'];
    const githubField = fm['github'];

    // Determine VCS and repo identifier.
    // Priority: gitlab > github (gitlab is primary; github is typically a mirror).
    if (gitlabField && typeof gitlabField === 'string' && gitlabField.trim()) {
      results.push({
        slug,
        repo: gitlabField.trim(),
        vcs: 'gitlab',
        overviewPath,
      });
    } else if (githubField && typeof githubField === 'string' && githubField.trim()) {
      results.push({
        slug,
        repo: githubField.trim(),
        vcs: 'github',
        overviewPath,
      });
    }
    // Neither field present → skip silently
  }

  return results;
}
