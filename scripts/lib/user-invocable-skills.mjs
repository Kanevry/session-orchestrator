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
 * Explicit-true only. `undefined` (flag absent) is NOT user-invocable: the whole
 * point of the marker is that it is written down, so a skill that forgot it is a
 * defect to surface, not a default to guess.
 *
 * Accepts the boolean and the string form because a frontmatter value may arrive
 * quoted (`user-invocable: "true"`), which `generate-codex-skills` already has to
 * tolerate on the same key.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUserInvocableValue(value) {
  return value === true || value === 'true';
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
    if (fm && isUserInvocableValue(fm['user-invocable'])) names.push(entry.name);
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
