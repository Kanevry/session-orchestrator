#!/usr/bin/env node
/**
 * generate-pi-prompts.mjs — build Pi prompt-template wrappers for commands/*.md.
 *
 * Pi prompt templates expand `$@`; Session Orchestrator command files use the
 * cross-harness `$ARGUMENTS` placeholder. The generated wrapper keeps one
 * maintained command source while giving Pi a native prompt entry per command.
 *
 * `pi/prompts/` is generated from the UNION of two sources: every
 * `commands/*.md`, plus every skill whose frontmatter carries an explicit
 * `user-invocable: true`. The second source exists because the operator-facing
 * slash-command marker moved INTO the skill frontmatter when the command bodies
 * were folded into their same-named `skills/<name>/SKILL.md`. A name present in
 * both sources is a generator ERROR, not a precedence question — two documents
 * claiming one public `/name` is a merge that did not finish.
 *
 * Usage:
 *   node scripts/generate-pi-prompts.mjs
 *   node scripts/generate-pi-prompts.mjs --check
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const ROOT = path.dirname(SCRIPT_DIR);
const COMMANDS_DIR = path.join(ROOT, 'commands');
const SKILLS_DIR = path.join(ROOT, 'skills');
const PROMPTS_DIR = path.join(ROOT, 'pi', 'prompts');
const CHECK_ONLY = process.argv.includes('--check');
const DESCRIPTION_MAX = 1024;

function isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function commandFiles() {
  if (!existsSync(COMMANDS_DIR)) return [];
  return readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function skillDirs() {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR)
    .filter((name) => isDir(path.join(SKILLS_DIR, name)) && existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
    .sort();
}

/**
 * Parse YAML-ish frontmatter including `>` / `|` folded scalars, returning
 * DECODED values (surrounding quotes stripped). Skill descriptions are folded
 * scalars in practice, which the previous line-at-a-time parser read as the
 * literal `>`. Mirrors `generate-cursor-adapter.mjs`.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};

  const lines = content.slice(4, end).split('\n');
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

/** @see generate-cursor-adapter.mjs — same allow-list, same reasoning. */
const YAML_SCALAR_LOOKALIKE = /^(?:true|false|yes|no|on|off|null|nan|[-+]?\.?inf|~)$/i;
const YAML_PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9 _.,()/-]*$/;

/**
 * Render a frontmatter VALUE as YAML. `argument-hint`'s canonical authored form
 * (`[mode] [--flag]`) is a YAML flow SEQUENCE when emitted bare — GH#54, which
 * made Copilot CLI >= 1.0.65 silently drop the file.
 *
 * @param {unknown} value
 * @returns {string|null} the YAML scalar, or `null` when there is nothing to emit
 */
function yamlQuote(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (text.trim() === '') return null;
  if (text !== text.trim()) return JSON.stringify(text);
  if (!YAML_PLAIN_SAFE.test(text)) return JSON.stringify(text);
  if (YAML_SCALAR_LOOKALIKE.test(text)) return JSON.stringify(text);
  if (/^\d/.test(text)) return JSON.stringify(text);
  return text;
}

function frontmatterLine(key, value) {
  if (value === undefined || value === '' || value === null) return null;
  return `${key}: ${value}`;
}

function clampDescription(text) {
  const collapsed = String(text || '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= DESCRIPTION_MAX) return collapsed;
  return collapsed.slice(0, DESCRIPTION_MAX - 1).trimEnd() + '…';
}

/**
 * The repo-wide marker for "operator-facing slash command".
 *
 * EXPLICIT means the literal `true` and nothing else: a missing key, `false`,
 * or any other value is a library skill. Surrounding whitespace is tolerated
 * (`user-invocable: true ` is the same declaration), because trailing spaces
 * are invisible in an editor and would otherwise silently demote a skill out of
 * `pi/prompts/` with no diagnostic anywhere.
 *
 * @param {unknown} value the raw frontmatter value
 * @returns {boolean}
 */
function isUserInvocable(value) {
  if (value === true) return true;
  return typeof value === 'string' && value.trim() === 'true';
}

/**
 * Skills that declare themselves operator-facing slash commands.
 * @returns {string[]} skill names, sorted
 */
function userInvocableSkills() {
  return skillDirs().filter((name) => {
    const fields = parseFrontmatter(readFileSync(path.join(SKILLS_DIR, name, 'SKILL.md'), 'utf8'));
    return isUserInvocable(fields['user-invocable']);
  });
}

function renderPrompt(commandFile) {
  const commandPath = path.join(COMMANDS_DIR, commandFile);
  const commandName = commandFile.replace(/\.md$/, '');
  const fields = parseFrontmatter(readFileSync(commandPath, 'utf8'));
  const frontmatter = [
    '---',
    frontmatterLine('description', yamlQuote(clampDescription(fields.description))),
    frontmatterLine('argument-hint', yamlQuote(fields['argument-hint'])),
    '---',
  ].filter(Boolean).join('\n');

  return `${frontmatter}

# /${commandName}

Use the Session Orchestrator command definition at \`commands/${commandFile}\`.

Arguments: $@

Read that command file and follow it exactly. When it references \`$ARGUMENTS\`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
`;
}

/**
 * A `pi/prompts/<name>.md` wrapper for a skill that IS the slash command
 * (`user-invocable: true`). Same contract as {@link renderPrompt}, pointing at
 * the skill body instead of a command file.
 *
 * @param {string} skillName
 * @returns {string}
 */
function renderSkillPrompt(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  const fields = parseFrontmatter(readFileSync(skillPath, 'utf8'));
  const description = clampDescription(fields.description || `Session Orchestrator skill: ${skillName}`);
  const frontmatter = [
    '---',
    frontmatterLine('description', yamlQuote(description)),
    frontmatterLine('argument-hint', yamlQuote(fields['argument-hint'])),
    '---',
  ].filter(Boolean).join('\n');

  return `${frontmatter}

# /${skillName}

Use the Session Orchestrator skill definition at \`skills/${skillName}/SKILL.md\`.

Arguments: $@

Read that skill file and follow it exactly. When it references \`$ARGUMENTS\`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
`;
}

/**
 * The expected `pi/prompts/` set: every `commands/*.md` PLUS every skill marked
 * `user-invocable: true`.
 *
 * @returns {Map<string, string>} file name -> content, sorted by file name
 * @throws {Error} when one public name is claimed by both sources
 */
function expectedPrompts() {
  const prompts = new Map();
  for (const commandFile of commandFiles()) {
    prompts.set(commandFile, renderPrompt(commandFile));
  }

  const collisions = [];
  for (const skillName of userInvocableSkills()) {
    const fileName = `${skillName}.md`;
    if (prompts.has(fileName)) {
      collisions.push(skillName);
      continue;
    }
    prompts.set(fileName, renderSkillPrompt(skillName));
  }
  if (collisions.length > 0) {
    throw new Error(
      `${collisions.length} public name(s) claimed by BOTH commands/ and a user-invocable skill: ${collisions.join(', ')}. `
      + 'Exactly one document may own a slash command — delete the commands/<name>.md whose body was folded into skills/<name>/SKILL.md, '
      + 'or drop `user-invocable: true` from the skill.',
    );
  }

  return new Map([...prompts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function checkPrompts(expected) {
  const failures = [];
  for (const [name, content] of expected) {
    const promptPath = path.join(PROMPTS_DIR, name);
    if (!existsSync(promptPath)) {
      failures.push(`${name}: missing`);
      continue;
    }
    const actual = readFileSync(promptPath, 'utf8');
    if (actual !== content) failures.push(`${name}: stale`);
  }

  const expectedNames = new Set(expected.keys());
  const actualNames = existsSync(PROMPTS_DIR)
    ? readdirSync(PROMPTS_DIR).filter((name) => name.endsWith('.md'))
    : [];
  for (const name of actualNames) {
    if (!expectedNames.has(name)) failures.push(`${name}: orphan`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`FAIL: ${failure}`);
    }
    process.exit(1);
  }

  console.log(`pi prompts: ${expected.size} file(s) up to date`);
}

function writePrompts(expected) {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  for (const name of readdirSync(PROMPTS_DIR)) {
    if (name.endsWith('.md') && !expected.has(name)) {
      rmSync(path.join(PROMPTS_DIR, name));
    }
  }
  for (const [name, content] of expected) {
    writeFileSync(path.join(PROMPTS_DIR, name), content, 'utf8');
  }
  console.log(`pi prompts: wrote ${expected.size} file(s)`);
}

let expected;
try {
  expected = expectedPrompts();
} catch (error) {
  // Loud and diagnosable: a source conflict must never degrade into a partial
  // write or a stack trace read as "some node thing went wrong".
  console.error(`FAIL: ${error.message}`);
  process.exit(1);
}
if (CHECK_ONLY) checkPrompts(expected);
else writePrompts(expected);
