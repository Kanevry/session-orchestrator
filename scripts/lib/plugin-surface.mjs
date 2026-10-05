/**
 * plugin-surface.mjs — the one enumeration of the plugin's public sources
 * (`commands/*.md`, `skills/<name>/SKILL.md`) and the one hand-written
 * frontmatter parser the Cursor and Pi wrapper generators share (#1240).
 *
 * Four generators derive harness surfaces from the same sources
 * (`generate-agents-skills.mjs`, `generate-codex-skills.mjs`,
 * `generate-cursor-adapter.mjs`, `generate-pi-prompts.mjs`). Before this module
 * the agents/codex pair skipped names with a leading `.` or `_` while the
 * cursor/pi pair did not, so a `commands/_draft.md` produced Cursor and Pi
 * wrappers but no Codex or `.agents` mirror. {@link isHiddenSourceName} is now
 * the single filter all four apply.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * A source name with a leading `.` or `_` is private (drafts, `_shared/`
 * helpers, dotfiles) and never becomes a public command or skill.
 *
 * @param {string} name file or directory name
 * @returns {boolean}
 */
export function isHiddenSourceName(name) {
  return /^[._]/.test(name);
}

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

/**
 * Public `commands/*.md` file names (with extension), sorted.
 *
 * @param {string} root plugin root
 * @returns {string[]}
 */
export function listCommandFiles(root) {
  const dir = path.join(root, 'commands');
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md') && !isHiddenSourceName(name) && isFile(path.join(dir, name)))
    .sort();
}

/**
 * Public `skills/<name>` directory names that carry a SKILL.md, sorted.
 *
 * @param {string} root plugin root
 * @returns {string[]}
 */
export function listSkillDirs(root) {
  const dir = path.join(root, 'skills');
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !isHiddenSourceName(name) && isDir(path.join(dir, name)) && existsSync(path.join(dir, name, 'SKILL.md')))
    .sort();
}

/**
 * Parse YAML-ish frontmatter including `>` / `|` folded scalars, returning
 * DECODED values (one layer of surrounding quotes stripped). Not js-yaml on
 * purpose: the Cursor/Pi wrappers re-emit these values verbatim, and every
 * merged skill uses `description: >`, which this parser folds to its text.
 *
 * A UTF-8 BOM before the opening `---`, or CRLF line endings, used to make the
 * probes below miss the block entirely: the file parsed as "no frontmatter",
 * so every flag in it (`user-invocable`, `disable-model-invocation`) silently
 * disappeared and the skill was demoted out of the generated surface with no
 * diagnostic anywhere. Both are normalised away first — the same treatment
 * `parseAgentFrontmatter` (`scripts/lib/agent-frontmatter.mjs`) gives them.
 *
 * NOT replaced by the shared `parseSkillFrontmatter`: that one returns the
 * `__BLOCK_SCALAR__` sentinel for a `description: >`, which would be emitted
 * as the wrapper description.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseFrontmatter(content) {
  const text = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content).replace(/\r\n?/g, '\n');
  if (!text.startsWith('---\n')) return {};
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return {};

  const lines = text.slice(4, end).split('\n');
  const fields = {};
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1];
    const raw = match[2];
    if (raw === '>' || raw === '| ' || raw === '|' || raw === '>-' || raw === '|-') {
      const folded = [];
      i += 1;
      while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('\t') || lines[i] === '')) {
        folded.push(lines[i].replace(/^\s+/, ''));
        i += 1;
      }
      const joiner = raw.startsWith('|') ? '\n' : ' ';
      fields[key] = folded.filter(Boolean).join(joiner).trim();
      continue;
    }
    fields[key] = raw.replace(/^["']|["']$/g, '');
    i += 1;
  }
  return fields;
}
