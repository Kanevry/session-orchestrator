#!/usr/bin/env node
/**
 * generate-pi-prompts.mjs — build Pi prompt-template wrappers for commands/*.md.
 *
 * Pi prompt templates expand `$@`; Session Orchestrator command files use the
 * cross-harness `$ARGUMENTS` placeholder. The generated wrapper keeps one
 * maintained command source while giving Pi a native prompt entry per command.
 *
 * Usage:
 *   node scripts/generate-pi-prompts.mjs
 *   node scripts/generate-pi-prompts.mjs --check
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const ROOT = path.dirname(SCRIPT_DIR);
const COMMANDS_DIR = path.join(ROOT, 'commands');
const PROMPTS_DIR = path.join(ROOT, 'pi', 'prompts');
const CHECK_ONLY = process.argv.includes('--check');

function commandFiles() {
  return readdirSync(COMMANDS_DIR)
    .filter((name) => name.endsWith('.md'))
    .sort();
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return {};
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return {};

  const fields = {};
  const block = content.slice(4, end).split('\n');
  for (const line of block) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2];
  }
  return fields;
}

function frontmatterLine(key, value) {
  if (value === undefined || value === '') return null;
  return `${key}: ${value}`;
}

function renderPrompt(commandFile) {
  const commandPath = path.join(COMMANDS_DIR, commandFile);
  const commandName = commandFile.replace(/\.md$/, '');
  const fields = parseFrontmatter(readFileSync(commandPath, 'utf8'));
  const frontmatter = [
    '---',
    frontmatterLine('description', fields.description),
    frontmatterLine('argument-hint', fields['argument-hint']),
    '---',
  ].filter(Boolean).join('\n');

  return `${frontmatter}

# /${commandName}

Use the Session Orchestrator command definition at \`commands/${commandFile}\`.

Arguments: $@

Read that command file and follow it exactly. When it references \`$ARGUMENTS\`, substitute the arguments above. Keep all Session Orchestrator platform fallbacks intact.
`;
}

function expectedPrompts() {
  const prompts = new Map();
  for (const commandFile of commandFiles()) {
    prompts.set(commandFile, renderPrompt(commandFile));
  }
  return prompts;
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

const expected = expectedPrompts();
if (CHECK_ONLY) checkPrompts(expected);
else writePrompts(expected);
