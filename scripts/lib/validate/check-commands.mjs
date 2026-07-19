#!/usr/bin/env node
// check-commands.mjs — Validate that the commands directory contains .md files.
// Usage: check-commands.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..."
// Exit 0 = all checks passed; exit 1 = at least one failure.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-commands.mjs <plugin-root>');
  process.exit(1);
}

const PLUGIN_JSON_PATH = join(pluginRoot, '.claude-plugin', 'plugin.json');
const CONVENTIONAL_COMMANDS = 'commands';

let passed = 0;
let failed = 0;

function pass(msg) {
  console.log(`  PASS: ${msg}`);
  passed++;
}

function fail(msg) {
  console.log(`  FAIL: ${msg}`);
  failed++;
}

/**
 * Extract the YAML block at the beginning of a command file.
 *
 * @param {string} content
 * @returns {{ ok: true, yamlText: string } | { ok: false, diagnostic: string }}
 */
function extractInitialFrontmatter(content) {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { ok: false, diagnostic: 'missing YAML frontmatter opening delimiter' };
  }

  const closingDelimiter = lines.indexOf('---', 1);
  if (closingDelimiter === -1) {
    return { ok: false, diagnostic: 'missing YAML frontmatter closing delimiter' };
  }

  return { ok: true, yamlText: lines.slice(1, closingDelimiter).join('\n') };
}

/**
 * Parse and validate the frontmatter contract for one command file.
 *
 * @param {string} commandsDir
 * @param {string} filename
 */
function validateCommandFrontmatter(commandsDir, filename) {
  const content = readFileSync(join(commandsDir, filename), 'utf8');
  const extracted = extractInitialFrontmatter(content);
  if (!extracted.ok) {
    fail(`${filename}: ${extracted.diagnostic}`);
    return;
  }

  let frontmatter;
  try {
    frontmatter = yaml.load(extracted.yamlText, { schema: yaml.CORE_SCHEMA });
  } catch (error) {
    const reason = error?.reason ?? error?.message ?? String(error);
    const location = error?.mark
      ? ` at line ${error.mark.line + 1}, column ${error.mark.column + 1}`
      : '';
    fail(`${filename}: invalid YAML frontmatter: ${reason}${location}`);
    return;
  }

  if (frontmatter === null || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    fail(`${filename}: YAML frontmatter must be a non-null mapping/object`);
    return;
  }

  if (
    Object.hasOwn(frontmatter, 'argument-hint') &&
    typeof frontmatter['argument-hint'] !== 'string'
  ) {
    fail(`${filename}: argument-hint must be a string`);
  }
}

// ============================================================================
// Check 7: Command .md files exist
// ============================================================================
console.log('--- Check 7: command files ---');

// Read optional commands path from plugin.json
let commandsPath = '';
if (existsSync(PLUGIN_JSON_PATH)) {
  try {
    const json = JSON.parse(readFileSync(PLUGIN_JSON_PATH, 'utf8'));
    if (json.commands && typeof json.commands === 'string') {
      commandsPath = json.commands;
    }
  } catch {
    // Malformed plugin.json — fall back to conventional location
  }
}

// Resolve the commands directory
let commandsDir;
if (commandsPath) {
  // Strip leading "./" to allow join to work correctly
  commandsDir = join(pluginRoot, commandsPath.replace(/^\.\//, ''));
} else {
  commandsDir = join(pluginRoot, CONVENTIONAL_COMMANDS);
}

if (existsSync(commandsDir)) {
  let entries;
  try {
    entries = readdirSync(commandsDir);
  } catch {
    entries = [];
  }
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();

  if (mdFiles.length > 0) {
    pass(`commands directory contains ${mdFiles.length} .md files`);
    for (const filename of mdFiles) {
      validateCommandFrontmatter(commandsDir, filename);
    }
  } else {
    fail('commands directory is empty (no .md files)');
  }
} else {
  if (commandsPath) {
    fail(`commands path is not a directory: ${commandsPath}`);
  } else {
    fail(`commands directory not found at conventional location: ./${CONVENTIONAL_COMMANDS}`);
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
