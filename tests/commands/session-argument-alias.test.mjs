/**
 * tests/commands/session-argument-alias.test.mjs
 *
 * Contract between the `/session ultradeep` ARGUMENT ALIAS documented in
 * `commands/session.md` and the code that has to carry its two halves:
 * the closed `session_type` set (`scripts/lib/session-schema/constants.mjs`)
 * and the `session-profile` STATE.md accessors (`scripts/lib/state-md.mjs`).
 *
 * THE BUG THIS CATCHES (TV-001): the alias degrades to a plain `deep` session
 * and the profile silently disappears. There are exactly two ways that happens
 * and both are invisible at runtime —
 *
 *   (a) the alias resolves to `session-type: ultradeep`. Nothing REJECTS that
 *       value downstream; it is MISLABELLED. `scripts/lib/telemetry/schema.mjs`
 *       maps an unknown session type to `'other'` and
 *       `scripts/lib/session-close-backfill.mjs` labels it `'housekeeping'`.
 *       The session is then recorded as something it never was.
 *   (b) the alias resolves to `deep` and drops the profile half, which is
 *       indistinguishable from a plain `/session deep` — the 7-wave shape and
 *       its Synthesis-Gate quietly never happen.
 *
 * NOT A PROSE PIN (`.claude/rules/test-value.md` TV-002c). No sentence of the
 * command file is asserted. Two STRUCTURES are extracted — the `argument-hint`
 * token list and the resolution block's key/value pairs — and the values are
 * then put to the REAL enum and the REAL accessors.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { VALID_SESSION_TYPES } from '@lib/session-schema/constants.mjs';
import { readSessionProfile, setSessionProfile, parseStateMd } from '@lib/state-md.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const COMMAND_DOC = path.join(REPO_ROOT, 'commands', 'session.md');
const ALIAS = 'ultradeep';

const text = readFileSync(COMMAND_DOC, 'utf8');

/** Tokens of the frontmatter `argument-hint: "[a|b|c]"` line. */
function argumentHintTokens(doc) {
  const line = doc.split('\n').find((l) => l.startsWith('argument-hint:'));
  if (!line) return null;
  const bracket = line.match(/\[([^\]]+)\]/);
  return bracket ? bracket[1].split('|').map((t) => t.trim()) : null;
}

/**
 * Key/value pairs of the first fenced ```yaml block that follows the heading
 * introducing the alias. Trailing `# comments` are stripped.
 */
function aliasResolutionBlock(doc) {
  const headingIdx = doc.indexOf('### Argument alias:');
  if (headingIdx === -1) return null;
  const fence = doc.slice(headingIdx).match(/```ya?ml\n([\s\S]*?)\n```/);
  if (!fence) return null;
  const out = {};
  for (const raw of fence[1].split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

describe('/session ultradeep — argument alias (PRD 2026-09-06)', () => {
  it('argument-hint offers the alias alongside the three real types', () => {
    // Catches: the alias exists in the body but no operator can discover it.
    expect(argumentHintTokens(text)).toEqual(['housekeeping', 'feature', 'deep', ALIAS]);
  });

  it('resolves to session-type deep PLUS the profile — both halves, neither alone', () => {
    // Catches failure (a) and (b) above in one assertion: an exact-shape
    // comparison, so a missing profile key and a mislabelled type both fail.
    expect(aliasResolutionBlock(text)).toEqual({
      'session-type': 'deep',
      'session-profile': ALIAS,
    });
  });

  it('the resolved session-type is a real member of the closed enum', () => {
    expect(VALID_SESSION_TYPES).toContain(aliasResolutionBlock(text)['session-type']);
  });

  it('the alias itself is NOT a session type — that is the whole point', () => {
    // If this ever passes, the alias has become a fourth enum value and the two
    // silent-mislabel paths named in the docblock are live again.
    expect(VALID_SESSION_TYPES).not.toContain(ALIAS);
  });

  it('the documented resolution survives a real STATE.md write', () => {
    const resolution = aliasResolutionBlock(text);
    const doc = ['---', 'session: s-1', `session-type: ${resolution['session-type']}`, '---', '', '## Current Wave', ''].join('\n');
    const written = setSessionProfile(doc, resolution['session-profile']);

    expect(readSessionProfile(written)).toBe(ALIAS);
    expect(parseStateMd(written).frontmatter['session-type']).toBe('deep');
  });

  it('a plain deep session carries no profile at all', () => {
    // The counterfactual half: without it, a reader that always returns
    // 'ultradeep' would pass every assertion above.
    const plainDeep = ['---', 'session: s-2', 'session-type: deep', '---', '', '## Current Wave', ''].join('\n');
    expect(readSessionProfile(plainDeep)).toBeNull();
  });
});
