#!/usr/bin/env node
/**
 * generate-cursor-adapter.mjs — Cursor-native command + skill wrappers.
 *
 * Cursor loads slash commands from `.cursor/commands/*.md` and skills from
 * `.cursor/skills/<name>/SKILL.md`. The canonical sources stay `commands/` and
 * `skills/`; these wrappers keep one maintained body while giving Cursor a
 * native entry per command/skill (same pattern as `generate-pi-prompts.mjs`).
 *
 * Usage:
 *   node scripts/generate-cursor-adapter.mjs
 *   node scripts/generate-cursor-adapter.mjs --check
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  return readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function skillDirs() {
  return readdirSync(SKILLS_DIR)
    .filter((name) => isDir(path.join(SKILLS_DIR, name)) && existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')))
    .sort();
}

/**
 * Parse YAML-ish frontmatter including `>` / `|` folded scalars.
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

function yamlQuote(value) {
  if (value === undefined || value === '') return null;
  if (/[:#[\]{}&*!|>'"%@`]/.test(value) || value.includes('\n')) {
    return JSON.stringify(value);
  }
  return value;
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
  const frontmatter = [
    '---',
    frontmatterLine('description', yamlQuote(fields.description) ?? fields.description),
    frontmatterLine('argument-hint', fields['argument-hint']),
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

function isUserInvocable(value) {
  return value === 'true' || value === true;
}

function renderSkill(skillName) {
  const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  const fields = parseFrontmatter(readFileSync(skillPath, 'utf8'));
  const description = clampDescription(fields.description || `Session Orchestrator skill: ${skillName}`);
  const lines = [
    '---',
    `name: ${skillName}`,
    `description: ${yamlQuote(description)}`,
  ];
  if (!isUserInvocable(fields['user-invocable'])) {
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

function expectedCommands() {
  const commands = new Map();
  for (const commandFile of commandFiles()) {
    commands.set(commandFile, renderCommand(commandFile));
  }
  return commands;
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

const expectedCmds = expectedCommands();
const expectedSkillsMap = expectedSkills();
if (CHECK_ONLY) checkAll(expectedCmds, expectedSkillsMap);
else writeAll(expectedCmds, expectedSkillsMap);
