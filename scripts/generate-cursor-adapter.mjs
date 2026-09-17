#!/usr/bin/env node
/**
 * generate-cursor-adapter.mjs — Cursor-native command + skill wrappers.
 *
 * Cursor loads slash commands from `.cursor/commands/*.md` and skills from
 * `.cursor/skills/<name>/SKILL.md`. The canonical sources stay `commands/` and
 * `skills/`; these wrappers keep one maintained body while giving Cursor a
 * native entry per command/skill (same pattern as `generate-pi-prompts.mjs`).
 *
 * `.cursor/commands/` is generated from the UNION of two sources: every
 * `commands/*.md`, plus every skill whose frontmatter carries an explicit
 * `user-invocable: true`. The second source exists because the operator-facing
 * slash-command marker moved INTO the skill frontmatter when the command bodies
 * were folded into their same-named `skills/<name>/SKILL.md`. A name present in
 * both sources is a generator ERROR, not a precedence question — two documents
 * claiming one public `/name` is a merge that did not finish.
 *
 * `disable-model-invocation` is propagated from the SOURCE frontmatter and is
 * NOT derived from `user-invocable` — see {@link disablesModelInvocation} for
 * the two grounds and the measurement behind them.
 *
 * Usage:
 *   node scripts/generate-cursor-adapter.mjs
 *   node scripts/generate-cursor-adapter.mjs --check
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isUserInvocableValue } from './lib/user-invocable-skills.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const ROOT = path.dirname(SCRIPT_DIR);
const COMMANDS_DIR = path.join(ROOT, 'commands');
const SKILLS_DIR = path.join(ROOT, 'skills');
const CURSOR_COMMANDS_DIR = path.join(ROOT, '.cursor', 'commands');
const CURSOR_SKILLS_DIR = path.join(ROOT, '.cursor', 'skills');
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
 * Parse YAML-ish frontmatter including `>` / `|` folded scalars.
 *
 * A UTF-8 BOM before the opening `---`, or CRLF line endings, used to make the
 * two probes below miss the block entirely: the file parsed as "no
 * frontmatter", so every flag in it (`user-invocable`,
 * `disable-model-invocation`) silently disappeared and the skill was demoted
 * out of `.cursor/commands/` with no diagnostic anywhere. Both are normalised
 * away first — the same treatment `parseAgentFrontmatter`
 * (`scripts/lib/agent-frontmatter.mjs`) gives them.
 *
 * NOT replaced by the shared `parseSkillFrontmatter`: that one returns the
 * `__BLOCK_SCALAR__` sentinel for a `description: >`, which is the form every
 * merged skill actually uses — routing through it would emit the sentinel as
 * the wrapper description.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
function parseFrontmatter(content) {
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

/**
 * Values that YAML would read as a non-string scalar even though every
 * character in them is "safe". `argument-hint: no` is a boolean, not the
 * string "no"; `description: 3` is an integer. A consumer asserting
 * `typeof value === 'string'` fails on a file that looks perfectly fine.
 */
const YAML_SCALAR_LOOKALIKE = /^(?:true|false|yes|no|on|off|null|nan|[-+]?\.?inf|~)$/i;

/**
 * A value safe to emit as a YAML *plain* (unquoted) scalar.
 *
 * Deliberately an ALLOW-list. Its predecessor was a deny-list of special
 * characters, which is unenumerable by construction: it caught `[` and `:`
 * but not a leading `-` (block-sequence entry), not surrounding whitespace,
 * and not the scalar look-alikes above. An allow-list fails closed — an
 * unforeseen shape gets quoted, which is never wrong, only noisier.
 */
const YAML_PLAIN_SAFE = /^[A-Za-z0-9_][A-Za-z0-9 _.,()/-]*$/;

/**
 * Render a frontmatter VALUE as YAML.
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

function renderCommand(commandFile) {
  const commandPath = path.join(COMMANDS_DIR, commandFile);
  const commandName = commandFile.replace(/\.md$/, '');
  const fields = parseFrontmatter(readFileSync(commandPath, 'utf8'));
  // EVERY value goes through yamlQuote(). `argument-hint` did not, and its
  // canonical form is a bare bracket list (`[mode] [--flag]`) — a YAML flow
  // sequence, which is GH#54: Copilot CLI >= 1.0.65 silently DROPS a command
  // file whose `argument-hint` is not a string. Fixed in `commands/` and
  // `pi/prompts/` by 93b40dd (v3.16.0) and re-introduced here on every
  // generation, because this mirror re-derived the frontmatter by hand.
  const frontmatter = [
    '---',
    frontmatterLine('description', yamlQuote(fields.description)),
    frontmatterLine('argument-hint', yamlQuote(fields['argument-hint'])),
    '---',
  ].filter(Boolean).join('\n');

  return `${frontmatter}

# /${commandName}

Use the Session Orchestrator command definition at \`commands/${commandFile}\`.

Arguments: $ARGUMENTS

Read that command file and follow it exactly. When it references \`$ARGUMENTS\`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the command says to invoke a skill, Read \`skills/<skill-name>/SKILL.md\` and follow it. Supporting files (\`soul.md\`, phase docs) live in that same \`skills/<skill-name>/\` directory.
`;
}

/**
 * Skills that declare themselves operator-facing slash commands.
 *
 * The predicate is `isUserInvocableValue` from `scripts/lib/user-invocable-skills.mjs`
 * — the ONE normaliser for this marker, shared with the Pi and Codex generators
 * and with every counter. The private copy this replaced read only a
 * whitespace-trimmed bare `true`, so `True` and `true # note` were demoted HERE
 * while the shared counter listed them as commands; the SKILL.md path is passed
 * so a demotion WARN names the file.
 *
 * @returns {string[]} skill names, sorted
 */
function userInvocableSkills() {
  return skillDirs().filter((name) => {
    const file = path.join(SKILLS_DIR, name, 'SKILL.md');
    const fields = parseFrontmatter(readFileSync(file, 'utf8'));
    return isUserInvocableValue(fields['user-invocable'], file);
  });
}

/**
 * A `.cursor/commands/<name>.md` wrapper for a skill that IS the slash command
 * (`user-invocable: true`). Same contract as {@link renderCommand}, pointing at
 * the skill body instead of a command file.
 *
 * @param {string} skillName
 * @returns {string}
 */
function renderSkillCommand(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  const fields = parseFrontmatter(readFileSync(skillPath, 'utf8'));
  const description = clampDescription(fields.description || `Session Orchestrator skill: ${skillName}`);
  // Same GH#54 rule as renderCommand: `argument-hint` ALWAYS goes through
  // yamlQuote(), because its canonical authored form (`[mode] [--flag]`) is a
  // YAML flow sequence when emitted bare.
  // The command wrapper carries the SOURCE value only — never the library-skill
  // ground of {@link disablesModelInvocation}, which cannot apply here: this
  // surface exists BECAUSE the skill is `user-invocable: true`. Propagated so an
  // operator-only command stays operator-only on whichever of the two surfaces
  // Cursor reads the policy from (same mapping the Codex adapter makes onto
  // `policy.allow_implicit_invocation`, `scripts/generate-codex-skills.mjs`).
  const frontmatter = [
    '---',
    frontmatterLine('description', yamlQuote(description)),
    frontmatterLine('argument-hint', yamlQuote(fields['argument-hint'])),
    isUserInvocableValue(fields['disable-model-invocation'], skillPath) ? 'disable-model-invocation: true' : null,
    '---',
  ].filter(Boolean).join('\n');

  return `${frontmatter}

# /${skillName}

Use the Session Orchestrator skill definition at \`skills/${skillName}/SKILL.md\`.

Arguments: $ARGUMENTS

Read that skill file and follow it exactly. When it references \`$ARGUMENTS\`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.

Cursor has no Skill tool. When the skill says to invoke another skill, Read \`skills/<skill-name>/SKILL.md\` and follow it. Supporting files (\`soul.md\`, phase docs) live in that same \`skills/<skill-name>/\` directory.
`;
}

/**
 * Emit `disable-model-invocation: true` into a Cursor wrapper?
 *
 * TWO independent grounds, OR-ed — the flag is a restriction, so the rule is
 * fail-closed:
 *   1. the SOURCE skill declares it (the single truth for operator-only skills).
 *      That flag is an INDEPENDENT axis from `user-invocable`, not its inverse:
 *      six skills carry BOTH (measured 2026-09-17: bootstrap, brainstorm, close,
 *      go, plan, release), and deriving the wrapper's flag from `user-invocable`
 *      alone emitted NO flag for exactly those six — letting a Cursor model
 *      auto-invoke `/close`, `/go` and `/release`;
 *   2. the skill is not `user-invocable`, i.e. a library skill whose Cursor
 *      wrapper is reached by an explicit Read from a command body, never by a
 *      model's own dispatch. This ground predates the #1 fix and is kept
 *      deliberately: dropping it would REMOVE the flag from 24 of 50 wrappers
 *      (measured 2026-09-17) on no Cursor-side evidence, which is the one
 *      direction a guard fix must never move.
 *
 * Truth table — both readings normalised by `isUserInvocableValue`, so every
 * form a YAML parser reads as `true` (`True`, `"true"`, `true # note`) counts
 * as `true` on BOTH axes. Ground 2 made that load-bearing rather than cosmetic:
 * while this file kept a private bare-`true` predicate, a `True`-marked
 * user-invocable skill read as NOT user-invocable HERE and got the restriction
 * STAMPED, while the shared counter listed it as a command:
 *
 *   | source flag | user-invocable | emitted |
 *   |-------------|----------------|---------|
 *   | true        | true           | yes (1) |
 *   | true        | false/absent   | yes (1+2) |
 *   | false/absent| true           | no      |
 *   | false/absent| false/absent   | yes (2) |
 *
 * @param {Record<string, string>} fields source skill frontmatter
 * @param {string} [file] SKILL.md path, named in a demotion WARN
 * @returns {boolean}
 */
function disablesModelInvocation(fields, file) {
  return isUserInvocableValue(fields['disable-model-invocation'], file)
    || !isUserInvocableValue(fields['user-invocable'], file);
}

function renderSkill(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  const fields = parseFrontmatter(readFileSync(skillPath, 'utf8'));
  const description = clampDescription(fields.description || `Session Orchestrator skill: ${skillName}`);
  // Same rule as renderCommand: no frontmatter value is emitted raw. `name` is
  // a directory basename today, so it is plain-safe in practice — routing it
  // through yamlQuote() is what keeps that true after the next skill is added.
  const lines = [
    '---',
    `name: ${yamlQuote(skillName)}`,
    `description: ${yamlQuote(description)}`,
  ];
  if (disablesModelInvocation(fields, skillPath)) {
    lines.push('disable-model-invocation: true');
  }
  lines.push('---');

  return `${lines.join('\n')}

# ${skillName}

Canonical skill: \`skills/${skillName}/SKILL.md\`

Read that file and follow it exactly. Resolve relative links against \`skills/${skillName}/\`, not this wrapper.

Cursor has no Skill tool. Treat "invoke the ${skillName} skill" as: Read \`skills/${skillName}/SKILL.md\`.
`;
}

/**
 * The expected `.cursor/commands/` set: every `commands/*.md` PLUS every skill
 * marked `user-invocable: true`.
 *
 * @returns {Map<string, string>} file name → content, sorted by file name
 * @throws {Error} when one public name is claimed by both sources
 */
function expectedCommands() {
  const commands = new Map();
  for (const commandFile of commandFiles()) {
    commands.set(commandFile, renderCommand(commandFile));
  }

  const collisions = [];
  for (const skillName of userInvocableSkills()) {
    const fileName = `${skillName}.md`;
    if (commands.has(fileName)) {
      collisions.push(skillName);
      continue;
    }
    commands.set(fileName, renderSkillCommand(skillName));
  }
  if (collisions.length > 0) {
    throw new Error(
      `${collisions.length} public name(s) claimed by BOTH commands/ and a user-invocable skill: ${collisions.join(', ')}. `
      + 'Exactly one document may own a slash command — delete the commands/<name>.md whose body was folded into skills/<name>/SKILL.md, '
      + 'or drop `user-invocable: true` from the skill.',
    );
  }

  return new Map([...commands].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function expectedSkills() {
  const skills = new Map();
  for (const skillName of skillDirs()) {
    skills.set(skillName, renderSkill(skillName));
  }
  return skills;
}

function checkMap(expected, dir, kind, fileNameOf) {
  const failures = [];
  for (const [name, content] of expected) {
    const filePath = path.join(dir, fileNameOf(name));
    if (!existsSync(filePath)) {
      failures.push(`${kind} ${name}: missing`);
      continue;
    }
    const actual = readFileSync(filePath, 'utf8');
    if (actual !== content) failures.push(`${kind} ${name}: stale`);
  }
  return failures;
}

function listGeneratedMarkdown(dir, recursiveDirs = false) {
  if (!existsSync(dir)) return [];
  if (!recursiveDirs) {
    return readdirSync(dir).filter((name) => name.endsWith('.md'));
  }
  return readdirSync(dir).filter((name) => isDir(path.join(dir, name)) && existsSync(path.join(dir, name, 'SKILL.md')));
}

function checkAll(expectedCmds, expectedSkillsMap) {
  const failures = [
    ...checkMap(expectedCmds, CURSOR_COMMANDS_DIR, 'command', (name) => name),
    ...checkMap(expectedSkillsMap, CURSOR_SKILLS_DIR, 'skill', (name) => path.join(name, 'SKILL.md')),
  ];

  const expectedCommandNames = new Set(expectedCmds.keys());
  for (const name of listGeneratedMarkdown(CURSOR_COMMANDS_DIR)) {
    if (!expectedCommandNames.has(name)) failures.push(`command ${name}: orphan`);
  }

  const expectedSkillNames = new Set(expectedSkillsMap.keys());
  for (const name of listGeneratedMarkdown(CURSOR_SKILLS_DIR, true)) {
    if (!expectedSkillNames.has(name)) failures.push(`skill ${name}: orphan`);
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`FAIL: ${failure}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(`cursor adapter: ${expectedCmds.size} command(s), ${expectedSkillsMap.size} skill(s) up to date\n`);
}

function writeAll(expectedCmds, expectedSkillsMap) {
  mkdirSync(CURSOR_COMMANDS_DIR, { recursive: true });
  if (existsSync(CURSOR_COMMANDS_DIR)) {
    for (const name of readdirSync(CURSOR_COMMANDS_DIR)) {
      if (name.endsWith('.md') && !expectedCmds.has(name)) {
        rmSync(path.join(CURSOR_COMMANDS_DIR, name));
      }
    }
  }
  for (const [name, content] of expectedCmds) {
    writeFileSync(path.join(CURSOR_COMMANDS_DIR, name), content, 'utf8');
  }

  mkdirSync(CURSOR_SKILLS_DIR, { recursive: true });
  for (const name of existsSync(CURSOR_SKILLS_DIR) ? readdirSync(CURSOR_SKILLS_DIR) : []) {
    const skillDir = path.join(CURSOR_SKILLS_DIR, name);
    if (isDir(skillDir) && !expectedSkillsMap.has(name)) {
      rmSync(skillDir, { recursive: true, force: true });
    }
  }
  for (const [name, content] of expectedSkillsMap) {
    const skillDir = path.join(CURSOR_SKILLS_DIR, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
  }

  process.stdout.write(`cursor adapter: wrote ${expectedCmds.size} command(s), ${expectedSkillsMap.size} skill(s)\n`);
}

let expectedCmds;
let expectedSkillsMap;
try {
  expectedCmds = expectedCommands();
  expectedSkillsMap = expectedSkills();
} catch (error) {
  // Loud and diagnosable: a source conflict must never degrade into a partial
  // write or a stack trace read as "some node thing went wrong".
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.exit(1);
}
if (CHECK_ONLY) checkAll(expectedCmds, expectedSkillsMap);
else writeAll(expectedCmds, expectedSkillsMap);
