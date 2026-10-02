#!/usr/bin/env node
/**
 * cursor-install.mjs — Install Session Orchestrator Cursor surface into a project.
 *
 * Links rules, slash-command wrappers, skill wrappers, and writes `.cursor/hooks.json`
 * so `/session` is a native Cursor command and hooks fire through the payload bridge.
 *
 * Usage:
 *   node cursor-install.mjs [TARGET]
 *
 *   TARGET — path to the project to install into (default: process.cwd())
 *
 * Exit codes:
 *   0 — success
 *   1 — source rules not found, or TARGET is not an existing directory
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  symlinkSync,
  statSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CURSOR_TO_CANONICAL_EVENT } from './lib/cursor-hook-bridge.mjs';
import { shellQuote as shQuote } from './lib/sh-quote.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const SO_ROOT = path.dirname(SCRIPT_DIR);

const TARGET = process.argv[2] ?? process.cwd();

if (!existsSync(TARGET) || !statSync(TARGET).isDirectory()) {
  process.stderr.write(`ERROR: Target directory does not exist: ${TARGET}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Print banner
// ---------------------------------------------------------------------------

process.stdout.write('Session Orchestrator — Cursor IDE Setup\n');
process.stdout.write('========================================\n');
process.stdout.write('\n');
process.stdout.write(`Source: ${SO_ROOT}/.cursor/rules/\n`);
process.stdout.write(`Target: ${TARGET}/.cursor/rules/\n`);
process.stdout.write('\n');

const SOURCE_RULES_DIR = path.join(SO_ROOT, '.cursor', 'rules');

if (!existsSync(SOURCE_RULES_DIR) || !statSync(SOURCE_RULES_DIR).isDirectory()) {
  process.stderr.write(`ERROR: Source rules not found at ${SOURCE_RULES_DIR}/\n`);
  process.exit(1);
}

function _isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function _isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function _isDir(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function linkPath(source, dest, label) {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (_isSymlink(dest)) {
    // existsSync follows the link: false means it points at nothing.
    const state = existsSync(dest) ? 'symlink exists' : 'dangling symlink — not replacing';
    process.stdout.write(`  SKIP: ${label} (${state})\n`);
    return 'skip';
  }
  if (existsSync(dest)) {
    process.stdout.write(`  SKIP: ${label} (file exists — not overwriting)\n`);
    return 'skip';
  }
  symlinkSync(source, dest);
  process.stdout.write(`  LINK: ${label}\n`);
  return 'link';
}

let ruleLinks = 0;

const TARGET_RULES_DIR = path.join(TARGET, '.cursor', 'rules');
mkdirSync(TARGET_RULES_DIR, { recursive: true });

const entries = readdirSync(SOURCE_RULES_DIR);
for (const filename of entries) {
  if (!filename.endsWith('.mdc')) continue;
  const mdcFile = path.join(SOURCE_RULES_DIR, filename);
  if (!_isFile(mdcFile)) continue;
  const result = linkPath(mdcFile, path.join(TARGET_RULES_DIR, filename), filename);
  if (result === 'link') ruleLinks += 1;
}

const SOURCE_COMMANDS_DIR = path.join(SO_ROOT, '.cursor', 'commands');
const TARGET_COMMANDS_DIR = path.join(TARGET, '.cursor', 'commands');
let commandLinks = 0;
if (_isDir(SOURCE_COMMANDS_DIR)) {
  mkdirSync(TARGET_COMMANDS_DIR, { recursive: true });
  for (const filename of readdirSync(SOURCE_COMMANDS_DIR)) {
    if (!filename.endsWith('.md')) continue;
    const source = path.join(SOURCE_COMMANDS_DIR, filename);
    if (!_isFile(source)) continue;
    const result = linkPath(source, path.join(TARGET_COMMANDS_DIR, filename), `commands/${filename}`);
    if (result === 'link') commandLinks += 1;
  }
}

const SOURCE_SKILLS_DIR = path.join(SO_ROOT, '.cursor', 'skills');
const TARGET_SKILLS_DIR = path.join(TARGET, '.cursor', 'skills');
let skillLinks = 0;
if (_isDir(SOURCE_SKILLS_DIR)) {
  mkdirSync(TARGET_SKILLS_DIR, { recursive: true });
  for (const name of readdirSync(SOURCE_SKILLS_DIR)) {
    const source = path.join(SOURCE_SKILLS_DIR, name);
    if (!_isDir(source)) continue;
    const result = linkPath(source, path.join(TARGET_SKILLS_DIR, name), `skills/${name}`);
    if (result === 'link') skillLinks += 1;
  }
}

/**
 * Remove the links an earlier install left for a wrapper this plugin no longer
 * ships (#1501 item 6: 05c0264f dropped `commands/navigator.md` and
 * `skills/navigator`, and every installed project kept a dead link). An entry is
 * removed only when it is a symlink, dangles, AND resolves inside this plugin's
 * `.cursor/<kind>/` — so it is provably ours. Regular files and live links are
 * the project's own; a dangling link into another root is not ours to delete
 * and gets a WARN — unless this plugin ships that name, where linkPath() has
 * already reported it as dangling.
 * @param {'rules'|'commands'|'skills'} kind
 */
function pruneDeadLinks(kind) {
  const sourceDir = path.join(SO_ROOT, '.cursor', kind);
  const targetDir = path.join(TARGET, '.cursor', kind);
  if (!_isDir(targetDir)) return;
  for (const name of readdirSync(targetDir)) {
    const dest = path.join(targetDir, name);
    if (!_isSymlink(dest) || existsSync(dest)) continue;
    const pointsTo = path.resolve(path.dirname(dest), readlinkSync(dest));
    const rel = path.relative(sourceDir, pointsTo);
    const ours = rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
    if (ours) {
      unlinkSync(dest);
      process.stdout.write(`  PRUNE: ${kind}/${name} (dangling link into ${sourceDir})\n`);
    } else if (!existsSync(path.join(sourceDir, name))) {
      process.stdout.write(`  WARN: ${kind}/${name} (dangling link outside this plugin, left alone: ${pointsTo})\n`);
    }
  }
}

for (const kind of ['rules', 'commands', 'skills']) pruneDeadLinks(kind);

function renderHooksJson(soRoot) {
  const runNode = shQuote(path.join(soRoot, 'hooks', 'run-node.sh'));
  const bridge = shQuote(path.join(soRoot, 'scripts', 'lib', 'cursor-hook-bridge.mjs'));
  const hooks = {};
  for (const eventName of Object.keys(CURSOR_TO_CANONICAL_EVENT)) {
    hooks[eventName] = [
      { command: `sh ${runNode} ${bridge} --event ${eventName}` },
    ];
  }
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
}

const targetHooksPath = path.join(TARGET, '.cursor', 'hooks.json');
let hooksWritten = 0;
if (_isSymlink(targetHooksPath) || existsSync(targetHooksPath)) {
  process.stdout.write('  SKIP: hooks.json (file exists — not overwriting)\n');
} else {
  mkdirSync(path.dirname(targetHooksPath), { recursive: true });
  writeFileSync(targetHooksPath, renderHooksJson(SO_ROOT), 'utf8');
  process.stdout.write('  WRITE: hooks.json\n');
  hooksWritten = 1;
}

process.stdout.write('\n');
process.stdout.write(`Done! ${ruleLinks} rules linked, ${commandLinks} commands, ${skillLinks} skills, ${hooksWritten} hooks.json written.\n`);
process.stdout.write('\n');
process.stdout.write('Next steps:\n');
process.stdout.write("  1. Ensure CLAUDE.md (or AGENTS.md on Codex CLI) has a '## Session Config' section\n");
process.stdout.write('  2. Reload Cursor (hooks.json is watched; restart if /session is missing)\n');
process.stdout.write('  3. Type /session to start\n');
