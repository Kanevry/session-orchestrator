/**
 * io.mjs — Dependency-free leaf for Session Config file IO.
 *
 * Holds the shared `readConfigFile` primitive so that both the orchestrator
 * (config.mjs) and the per-section parsers (e.g. config/cross-repo.mjs) can
 * import it without forming a cycle. This module imports ONLY Node built-ins —
 * never config.mjs, never any sibling config/*.mjs parser.
 *
 * Extracted from config.mjs to break the length-2 cycle
 * config.mjs ⇄ config/cross-repo.mjs (issue #664).
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read CLAUDE.md or AGENTS.md from the project root.
 * Precedence: if AGENTS.md exists AND env var SO_PLATFORM === "codex" or "pi", prefer AGENTS.md.
 * Otherwise CLAUDE.md. Throws if neither file found.
 * @param {string} projectRoot — absolute path to project root
 * @returns {Promise<string>} file contents as string (CRLF-tolerant)
 */
export async function readConfigFile(projectRoot) {
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  const agentsMd = join(projectRoot, 'AGENTS.md');

  const prefersAgents = process.env.SO_PLATFORM === 'codex' || process.env.SO_PLATFORM === 'pi';

  if (prefersAgents) {
    // Prefer AGENTS.md for Codex/Pi platforms
    try {
      await access(agentsMd);
      return await readFile(agentsMd, 'utf8');
    } catch {
      // Fall through to CLAUDE.md
    }
  }

  try {
    await access(claudeMd);
    return await readFile(claudeMd, 'utf8');
  } catch {
    // Try AGENTS.md as fallback (non-Codex)
  }

  try {
    await access(agentsMd);
    return await readFile(agentsMd, 'utf8');
  } catch {
    // Neither found
  }

  throw new Error(`config.mjs: neither CLAUDE.md nor AGENTS.md found in '${projectRoot}'`);
}
