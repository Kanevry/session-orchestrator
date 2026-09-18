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

  const parsed = parseStateMd(foldMultilineLists(content));
  if (parsed === null) {
    return {
      frontmatter: null,
      body: stripFrontmatterBlock(content),
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

// `---\n<frontmatter>\n---\n` at the very start — same shape `parseStateMd` matches.
const FRONTMATTER_BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/;

/**
 * Fold multi-line list values of top-level frontmatter keys into the one-line
 * flow form (`key: [a, b]`) that `parseStateMd` understands. Two shapes (#1380):
 *   • a multi-line flow list — `key:\n  [\n    "a",\n    "b",\n  ]` — which is how
 *     Prettier reformats the one-line list `writer.mjs` emits;
 *   • a block list — `key:\n  - a\n  - b` — as a hand edit would write it.
 * Done here, not in the shared STATE.md parser: its mutators rely on `null` for
 * shapes it does not understand. A block list whose items are mappings
 * (`- name: x`) is left untouched — that is the parser's own block-seq form.
 * Content outside the frontmatter block is never modified.
 *
 * @param {string} content — full file content
 * @returns {string}
 */
function foldMultilineLists(content) {
  const m = FRONTMATTER_BLOCK_RE.exec(content);
  if (!m) return content;
  const lines = m[1].split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^([\w-]+):\s*$/.exec(lines[i]);
    const next = lines[i + 1];
    if (!key || next === undefined || !/^\s+\S/.test(next)) {
      out.push(lines[i]);
      continue;
    }
    if (next.trim().startsWith('[')) {
      let j = i + 1;
      const parts = [];
      while (j < lines.length && /^\s+\S/.test(lines[j])) {
        parts.push(lines[j].trim());
        if (lines[j].trim().endsWith(']')) break;
        j++;
      }
      if (j < lines.length && lines[j].trim().endsWith(']')) {
        const inner = parts.join(' ').slice(1, -1).trim().replace(/,\s*$/, '');
        out.push(`${key[1]}: [${inner.replace(/\s*,\s*/g, ', ')}]`);
        i = j;
        continue;
      }
    } else {
      let j = i + 1;
      const items = [];
      while (j < lines.length && /^\s+-\s+\S/.test(lines[j])) {
        items.push(lines[j].trim().slice(1).trim());
        j++;
      }
      const endsBlock = j >= lines.length || !/^\s/.test(lines[j]);
      if (items.length > 0 && endsBlock && !items.some((it) => /^[\w-]+:(\s|$)/.test(it))) {
        out.push(`${key[1]}: [${items.join(', ')}]`);
        i = j - 1;
        continue;
      }
    }
    out.push(lines[i]);
  }
  return `---\n${out.join('\n')}\n---${m[2]}${content.slice(m[0].length)}`;
}

/**
 * Remove a leading `---…---` frontmatter block so an unparseable one never reaches
 * a body consumer (the dialectic deriver payload) as if it were markdown (#1380).
 *
 * @param {string} content
 * @returns {string}
 */
function stripFrontmatterBlock(content) {
  const m = FRONTMATTER_BLOCK_RE.exec(content);
  if (!m) return content;
  const rest = content.slice(m[0].length);
  return rest.startsWith('\n') ? rest.slice(1) : rest;
}
