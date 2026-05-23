/**
 * writer.mjs — Atomic writer for peer-card markdown files.
 *
 * Peer cards live at `.orchestrator/peers/{USER,AGENT}.md` and carry a frontmatter
 * block followed by markdown body. Writes are crash-safe via tmp + rename (POSIX
 * atomic same-filesystem rename), and the writer ENFORCES the EARS unwanted-behaviour
 * rule from #503: a peer-card missing the required `id` field fails with
 * `peer-card missing required field: id` and writes nothing.
 *
 * Full frontmatter validation is delegated to schema.mjs (`validatePeerCardFrontmatter`);
 * if validation fails for any reason (missing fields, wrong types, etc.) the writer
 * returns `{ ok: false, errors }` and leaves the target file untouched.
 *
 * Auto-fill semantics (only when caller omits the field):
 *   - type            → 'peer-card'
 *   - target          → from the function argument
 *   - updated         → current ISO timestamp
 *   - created         → mirrors `updated` if absent
 *   - source_sessions → []
 *   - `id` is NEVER auto-filled — callers must provide it (EARS gate).
 *
 * Part of #503 (Wave 2; sibling to schema.mjs / reader.mjs / merger.mjs).
 */

import { writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { validatePeerCardFrontmatter } from './schema.mjs';

/** Generator sentinel — currently informational; merger/reader may use it for skip-on-manual-edit. */
export const GENERATOR_MARKER = 'session-orchestrator-peer-card@1';

// Frontmatter keys serialized in this order. Anything else is appended.
const ORDERED_KEYS = ['id', 'type', 'target', 'created', 'updated', 'source_sessions', 'title', 'tags'];

// YAML special chars that force quoting of scalar string values.
const YAML_SPECIAL = /[:#&*!|>'"%@`,[\]{}]/;

/**
 * Serialize a flat frontmatter object to a YAML `---` block.
 *
 * Peer-card frontmatter is intentionally flat (no nested objects per schema), so this
 * helper handles scalars, string arrays, and string-keyed booleans/numbers. Strings
 * containing YAML-special characters are quoted via JSON.stringify (safe superset of
 * YAML double-quoted scalar).
 *
 * @param {Record<string, unknown>} fm
 * @returns {string}  YAML block including the opening and closing `---` markers.
 */
function serializeFrontmatter(fm) {
  const lines = ['---'];

  const writeKey = (key, value) => {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => JSON.stringify(v)).join(', ')}]`);
    } else if (typeof value === 'string') {
      const needsQuoting = YAML_SPECIAL.test(value);
      lines.push(`${key}: ${needsQuoting ? JSON.stringify(value) : value}`);
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  };

  for (const key of ORDERED_KEYS) {
    if (key in fm) writeKey(key, fm[key]);
  }
  for (const key of Object.keys(fm)) {
    if (!ORDERED_KEYS.includes(key)) writeKey(key, fm[key]);
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * Atomically write a peer card to `.orchestrator/peers/{USER,AGENT}.md`.
 *
 * @param {string} repoRoot              Absolute path to the repo root (required).
 * @param {'user'|'agent'} target        Which peer card to write.
 * @param {{ frontmatter: object, body: string }} card  Card content.
 * @returns {Promise<{ ok: true, path: string } | { ok: false, errors: string[] }>}
 * @throws {Error} On invalid input (bad repoRoot, bad target, bad card).
 */
export async function writePeerCard(repoRoot, target, card) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw new Error(`writePeerCard: repoRoot is required (got ${typeof repoRoot}).`);
  }
  if (target !== 'user' && target !== 'agent') {
    throw new Error(`writePeerCard: target must be 'user' or 'agent' (got ${JSON.stringify(target)}).`);
  }
  if (!card || typeof card !== 'object') {
    throw new Error('writePeerCard: card must be an object.');
  }

  // Build the effective frontmatter with auto-filled derived fields.
  // Note: `id` is INTENTIONALLY not auto-filled — the EARS gate below depends on this.
  const fm = { ...card.frontmatter };
  fm.type = 'peer-card';
  fm.target = target;
  fm.updated = fm.updated || new Date().toISOString();
  fm.created = fm.created || fm.updated;
  fm.source_sessions = fm.source_sessions || [];

  // EARS unwanted-behaviour gate (#503): refuse to write without id.
  if (!fm.id) {
    return { ok: false, errors: ['peer-card missing required field: id'] };
  }

  // Full schema validation — schema.mjs is the source of truth for valid shapes.
  const validation = validatePeerCardFrontmatter(fm);
  if (!validation.ok) {
    return { ok: false, errors: validation.errors };
  }

  const filename = target === 'user' ? 'USER.md' : 'AGENT.md';
  const peersDir = join(repoRoot, '.orchestrator', 'peers');
  const finalPath = join(peersDir, filename);

  await mkdir(peersDir, { recursive: true });

  const bodyStr = typeof card.body === 'string' ? card.body : '';
  const content = `${serializeFrontmatter(fm)}\n\n${bodyStr.trimStart()}`;
  const tmpPath = `${finalPath}.${randomUUID().slice(0, 8)}.tmp`;

  try {
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, finalPath);
    return { ok: true, path: finalPath };
  } catch (err) {
    // Best-effort cleanup of orphaned tmp file. Swallow secondary failures —
    // the primary error is what the caller needs to see.
    try {
      await unlink(tmpPath);
    } catch {
      /* tmp file may not exist if writeFile failed before creating it */
    }
    throw err;
  }
}

/**
 * Write both user and agent peer cards. Per-file atomic; NOT cross-file atomic
 * (a crash between the two writes can leave one updated and the other on disk
 * as the previous version — callers that need cross-file atomicity must wrap
 * with their own staging logic).
 *
 * @param {string} repoRoot
 * @param {{ user?: {frontmatter: object, body: string}, agent?: {frontmatter: object, body: string} }} cards
 * @returns {Promise<{ user?: { ok: true, path: string } | { ok: false, errors: string[] }, agent?: { ok: true, path: string } | { ok: false, errors: string[] } }>}
 */
export async function writePeerCards(repoRoot, cards) {
  if (!cards || typeof cards !== 'object') {
    throw new Error('writePeerCards: cards must be an object.');
  }
  const results = {};
  if (cards.user) results.user = await writePeerCard(repoRoot, 'user', cards.user);
  if (cards.agent) results.agent = await writePeerCard(repoRoot, 'agent', cards.agent);
  return results;
}
