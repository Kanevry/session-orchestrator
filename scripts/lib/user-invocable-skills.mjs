/**
 * scripts/lib/user-invocable-skills.mjs
 *
 * ONE definition of "this skill is an operator-facing slash command".
 *
 * Since the #1370 command→skill fold (2026-09-16) `commands/` holds only the two
 * names that cannot be a skill (`session`, `templates-ack` — see
 * `tests/commands/headless-bare-command-availability.test.mjs` for the measured
 * mechanism). Every other slash command IS a skill, marked by an EXPLICIT
 * `user-invocable: true` in its SKILL.md frontmatter. Consumers that used to
 * count or link `commands/*.md` therefore need the union:
 *
 *   commands/*.md  ∪  skills with explicit `user-invocable: true`
 *
 * This module exists so that union has one implementation rather than one per
 * consumer (site-numbers tile, sunset walker linkage, the guard tests). It is
 * deliberately tiny and dependency-free: `scripts/lib/sunset/walker.mjs` imports it,
 * and the walker sits in the hook import graph, which must load WITHOUT
 * node_modules (GH#62/#63) — so no `js-yaml` here; the frontmatter parser is the
 * repo's own `parseAgentFrontmatter`, already in that graph.
 *
 * PARSED, never line-matched: `.claude/rules/test-hygiene.md` records that a
 * line-regex frontmatter reader is blind to unparseable YAML and mis-measures
 * block scalars. A SKILL.md whose frontmatter does not parse is treated as NOT
 * user-invocable — fail-closed, and loud where it matters because such a file
 * already fails `check-skills`/`validate-plugin`.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseAgentFrontmatter } from './agent-frontmatter.mjs';

/**
 * YAML 1.1 boolean lookalikes that YAML 1.2 / js-yaml's CORE_SCHEMA (what
 * `generate-codex-skills` parses with) reads as PLAIN STRINGS, not as `true`.
 * They are therefore NOT user-invocable here either — but silently demoting a
 * skill on one of them is the #1370 defect class, so each one gets a WARN.
 */
const TRUTHY_LOOKALIKE = /^(?:yes|y|on|t|1)$/i;

/**
 * Strip a trailing `#` comment, honouring quotes: `true # note` is the same
 * declaration as `true`, but `"a # b"` carries the hash as content.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTrailingComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    // A `#` opens a YAML comment only at the start or after whitespace.
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i);
  }
  return text;
}

/**
 * Normalise a raw frontmatter scalar to the token a YAML parser would see:
 * trim, drop a trailing comment, drop one layer of matching surrounding quotes.
 *
 * @param {string} text
 * @returns {string}
 */
function normaliseScalar(text) {
  let out = stripTrailingComment(text).trim();
  if (out.length >= 2 && (out[0] === '"' || out[0] === "'") && out[out.length - 1] === out[0]) {
    out = out.slice(1, -1).trim();
  }
  return out;
}

/**
 * THE one normaliser for `user-invocable` — the marker "this skill is an
 * operator-facing slash command". Every generator (Cursor, Pi, Codex) and every
 * counter (site-numbers tile, drift-check `command-count`, the guard tests) must
 * route through this function; four private re-implementations disagreeing on a
 * quoted value is the defect this replaces.
 *
 * Explicit-true only. `undefined` (flag absent) is NOT user-invocable: the whole
 * point of the marker is that it is written down, so a skill that forgot it is a
 * defect to surface, not a default to guess.
 *
 * Accepted: the boolean `true`, and a string that normalises to `true`
 * case-insensitively — so `"true"`, `'true'`, `True`, `true # note` and
 * `true ` (trailing space, invisible in an editor) all read as the same
 * declaration. Trailing-whitespace tolerance is load-bearing rather than
 * cosmetic: without it a stray space silently demotes a skill out of the
 * generated adapters with no diagnostic anywhere.
 *
 * REJECTED: `yes` / `y` / `on` / `t` / `1`. Those are YAML 1.1 booleans; under
 * YAML 1.2 — which is what js-yaml's CORE_SCHEMA in `generate-codex-skills`
 * applies — they are plain strings, and this predicate follows the parser rather
 * than inventing a fifth dialect. Because the demotion is the surprising half,
 * each one emits exactly one stderr WARN naming the file.
 *
 * The same normalisation governs the SIBLING boolean marker
 * `disable-model-invocation` (the Cursor and Codex adapters read it with this
 * predicate). The WARN therefore names the key it was asked about rather than a
 * hard-coded `user-invocable`: measured 2026-09-18, a `disable-model-invocation:
 * yes` demotion reported `user-invocable: "yes"`, sending the operator to a
 * line that does not exist in that file.
 *
 * The NOUN follows the key too (#1388 P10). Naming the key while hard-coding
 * "is NOT a slash-command marker" told a `disable-model-invocation: yes` author
 * that his value failed to be something it never was — a correct key with a
 * wrong subject reads as a broken diagnostic. The default phrase is unchanged
 * for `user-invocable`, so the four existing call sites see identical text.
 *
 * @param {unknown} value the raw frontmatter value
 * @param {string} [file] path named in the WARN when a truthy-looking value is demoted
 * @param {string} [key] frontmatter key named in the WARN (default `user-invocable`)
 * @returns {boolean}
 */
const MARKER_NOUN = Object.freeze({
  'user-invocable': 'a slash-command marker',
  'disable-model-invocation': 'a model-invocation opt-out marker',
});
const DEFAULT_MARKER_NOUN = 'a boolean marker';

export function isUserInvocableValue(value, file, key = 'user-invocable') {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const token = normaliseScalar(value);
  if (token.toLowerCase() === 'true') return true;
  if (TRUTHY_LOOKALIKE.test(token)) {
    const where = file ? `${file}: ` : '';
    process.stderr.write(
      `WARN ${where}${key}: ${JSON.stringify(value)} is NOT ${MARKER_NOUN[key] ?? DEFAULT_MARKER_NOUN} — `
        + `only \`true\` is (YAML 1.2 reads yes/on/1 as strings). Write \`${key}: true\`.\n`,
    );
  }
  return false;
}

/**
 * Parse a SKILL.md's YAML frontmatter. Returns `null` when there is no
 * frontmatter block or it does not parse.
 *
 * @param {string} content
 * @returns {Record<string, unknown>|null}
 */
export function parseSkillFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const parsed = parseAgentFrontmatter(content);
  return parsed.ok ? parsed.frontmatter : null;
}

/**
 * Names of skills carrying an explicit `user-invocable: true`, sorted.
 *
 * @param {string} repoRoot plugin root (the directory holding `skills/`)
 * @returns {string[]}
 */
export function userInvocableSkills(repoRoot) {
  const dir = path.join(repoRoot, 'skills');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const names = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    let fm;
    try {
      fm = parseSkillFrontmatter(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (fm && isUserInvocableValue(fm['user-invocable'], file)) names.push(entry.name);
  }
  return names.sort();
}

/** Names of `commands/*.md` files (without the extension), sorted. */
export function commandFileNames(repoRoot) {
  const dir = path.join(repoRoot, 'commands');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

/**
 * The product's "slash commands" set: `commands/*.md` ∪ explicitly
 * user-invocable skills, deduplicated by NAME.
 *
 * Dedup is load-bearing rather than defensive: a name present as BOTH is the
 * picker-duplicate bug (the body runs, and the entry lists twice), so it must
 * count once here and go red in the guard test — never inflate the number.
 *
 * @param {string} repoRoot
 * @returns {string[]} sorted unique names
 */
export function slashCommandNames(repoRoot) {
  return [...new Set([...commandFileNames(repoRoot), ...userInvocableSkills(repoRoot)])].sort();
}
