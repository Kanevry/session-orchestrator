/**
 * reader.mjs — Read peer cards (USER.md / AGENT.md) from `.orchestrator/peers/`
 * for issue #503 (Wave 2 I6).
 *
 * Consumers:
 *   - session-start Phase 4 staleness banner (Wave 3)
 *   - /evolve --dialectic (future #506 — out of scope here)
 *
 * Design notes
 * ────────────
 *  • Reuses the canonical YAML-subset parser at `scripts/lib/state-md/yaml-parser.mjs`
 *    (`parseStateMd`). It returns `{ frontmatter, body }`, handles flow arrays
 *    (`[a, b, c]`), strings, booleans, integers, nulls — the same superset peer-cards
 *    need. "STATE.md" in the function name is incidental; the grammar is just
 *    "markdown with `---` YAML frontmatter".
 *  • Schema validation is delegated to `./schema.mjs` (I5). This module never
 *    decides what a valid peer card looks like; it just hands the parsed
 *    frontmatter to the validator and reports the verdict.
 *  • Read-only by contract. Never writes, never throws on missing files /
 *    malformed frontmatter — graceful degradation lets the banner caller
 *    decide UX (warn vs. silent).
 *  • Clock is injectable (`opts.now`) so staleness tests are deterministic.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseStateMd } from '../state-md/yaml-parser.mjs';
import {
  validatePeerCardFrontmatter,
  computeStalenessDays,
  STALENESS_THRESHOLD_DAYS,
} from './schema.mjs';

/**
 * @typedef {Object} PeerCard
 * @property {Record<string, unknown> | null} frontmatter — parsed YAML frontmatter, or null when missing/malformed
 * @property {string} body — markdown body after the closing `---` (empty string if none)
 * @property {number} stalenessDays — whole days since `frontmatter.updated`; `Infinity` if no `updated` field
 * @property {boolean} isStale — `stalenessDays > STALENESS_THRESHOLD_DAYS`
 * @property {{ ok: boolean, errors: string[] }} validation — schema verdict from `validatePeerCardFrontmatter`
 */

/**
 * @typedef {Object} PeerCardsResult
 * @property {PeerCard | null} user — USER.md card; null if file missing
 * @property {PeerCard | null} agent — AGENT.md card; null if file missing
 * @property {string} peersDir — absolute path to `.orchestrator/peers/`
 * @property {boolean} exists — whether peersDir exists on disk
 */

/**
 * Read peer cards from `<repoRoot>/.orchestrator/peers/`.
 *
 * @param {string} repoRoot — REQUIRED, absolute path to repo root
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<PeerCardsResult>}
 */
export async function readPeerCards(repoRoot, opts = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error(`readPeerCards: repoRoot is required (got ${typeof repoRoot}).`);
  }

  const peersDir = join(repoRoot, '.orchestrator', 'peers');

  if (!existsSync(peersDir)) {
    return { user: null, agent: null, peersDir, exists: false };
  }

  const now = opts.now ?? new Date();
  const userPath = join(peersDir, 'USER.md');
  const agentPath = join(peersDir, 'AGENT.md');

  const [user, agent] = await Promise.all([
    readOneCard(userPath, now),
    readOneCard(agentPath, now),
  ]);

  return { user, agent, peersDir, exists: true };
}

/**
 * Read and parse a single peer-card file. Returns null if the file is missing.
 * Never throws — degrades to a card with `validation.ok === false`.
 *
 * @param {string} absPath
 * @param {Date} now
 * @returns {Promise<PeerCard | null>}
 */
async function readOneCard(absPath, now) {
  if (!existsSync(absPath)) return null;

  let content;
  try {
    content = await readFile(absPath, 'utf8');
  } catch (err) {
    return {
      frontmatter: null,
      body: '',
      stalenessDays: Infinity,
      isStale: true,
      validation: { ok: false, errors: [`read failed: ${err.message}`] },
    };
  }

  const parsed = parseStateMd(content);
  if (parsed === null) {
    return {
      frontmatter: null,
      body: content,
      stalenessDays: Infinity,
      isStale: true,
      validation: { ok: false, errors: ['no frontmatter or malformed YAML'] },
    };
  }

  const { frontmatter, body } = parsed;
  const validation = validatePeerCardFrontmatter(frontmatter);
  const updatedIso = typeof frontmatter.updated === 'string' ? frontmatter.updated : null;
  const stalenessDays = updatedIso ? computeStalenessDays(updatedIso, now) : Infinity;
  const isStale = stalenessDays > STALENESS_THRESHOLD_DAYS;

  return { frontmatter, body, stalenessDays, isStale, validation };
}
