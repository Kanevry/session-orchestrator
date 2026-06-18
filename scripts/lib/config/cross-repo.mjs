/**
 * cross-repo.mjs — Parser for the `cross-repo:` sub-block in Session Config (#469, #478).
 *
 * Exports:
 *   _parseCrossRepo(content)       — PURE, no side effects. Extracts cross-repo.projects from
 *                                    the top-level `cross-repo:` block in markdown content.
 *   getCrossRepoProjects(cwd?)     — async accessor: reads config file, parses, returns list.
 *
 * Uses block-scanner (not _parseKV) because the dot in "cross-repo.projects" is not
 * supported by the KV regex. Scans for a `cross-repo:` block and then reads `projects:`.
 */

// `readConfigFile` is imported from the dependency-free leaf config/io.mjs (a
// sibling), NOT from config.mjs. This avoids the former length-2 cycle
// config.mjs ⇄ config/cross-repo.mjs (config.mjs imports `_parseCrossRepo` from
// here). We deliberately do NOT import `parseSessionConfig` — calling it from
// `getCrossRepoProjects` would re-run `_parseCrossRepo` (double-parse). By calling
// `_parseCrossRepo` directly on the raw content we parse exactly once. (issue #664)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfigFile } from './io.mjs';

/**
 * Resolve the cross-repo confinement root. Defaults to ~/Projects.
 * Override via CROSS_REPO_CONFINEMENT_ROOT env (test-only — never set in production).
 *
 * @returns {string} absolute path
 */
export function getConfinementRoot() {
  const v = process.env.CROSS_REPO_CONFINEMENT_ROOT;
  return (v && v.trim()) ? v : join(homedir(), 'Projects');
}

// Allowlist: only characters that are safe in shell contexts and file paths.
// Rejects entries containing shell metacharacters (;, $, `, |, &, >, <, (, ), space, etc.).
const SAFE_PATH_RE = /^[A-Za-z0-9._~/-]+$/;

/**
 * Parse the `cross-repo:` block from markdown content and extract the `projects:` list.
 *
 * Behaviour-preserving lift of the IIFE that previously lived in config.mjs.
 * Scans lines for `cross-repo:` block header, then reads the `projects:` key inside.
 * Stops scanning at the next non-indented, non-empty line (next top-level YAML key).
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md file content
 * @returns {string[]} list of project paths, or [] when absent/empty/none/null
 */
export function _parseCrossRepo(content) {
  const lines = content.split(/\r?\n/);
  let inBlock = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (!inBlock) {
      if (/^cross-repo:\s*$/.test(line)) { inBlock = true; }
      continue;
    }

    // Stop at next top-level (non-indented, non-empty) key
    if (line.length > 0 && !/^\s/.test(line)) break;

    const m = line.match(/^\s+projects:\s*(.*)/);
    if (m) {
      const raw = m[1].replace(/\s*#.*$/, '').trim();
      if (!raw || raw === 'none' || raw === 'null') return [];
      const stripped = raw.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
      if (stripped === '') return [];
      // SEAM(#477): per-entry shell-meta validation — reject entries with shell metacharacters.
      return stripped.split(',').map(s => s.trim()).filter(s => {
        if (s.length === 0) return false;
        if (!SAFE_PATH_RE.test(s)) {
          process.stderr.write(`cross-repo: rejected project entry with shell metacharacter: ${JSON.stringify(s)}\n`);
          return false;
        }
        return true;
      });
    }
  }

  return [];
}

/**
 * Load cross-repo.projects from Session Config (CLAUDE.md / AGENTS.md) in the
 * given working directory (defaults to process.cwd()).
 *
 * Returns an empty array when the field is absent or the config file is not found.
 * Never throws.
 *
 * @param {string} [cwd] — directory to search for CLAUDE.md / AGENTS.md
 * @returns {Promise<string[]>}
 */
export async function getCrossRepoProjects(cwd = process.cwd()) {
  try {
    const mdContent = await readConfigFile(cwd);
    // Direct call (not via parseSessionConfig) — avoids the double-parse and tightens
    // the cycle surface to a single readConfigFile edge. See module-header note.
    return _parseCrossRepo(mdContent);
  } catch {
    return [];
  }
}
