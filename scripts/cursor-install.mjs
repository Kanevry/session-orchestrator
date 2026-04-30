#!/usr/bin/env node
/**
 * cursor-install.mjs — Install Session Orchestrator Cursor rules into a project.
 *
 * Behaviour-parity port of cursor-install.sh (issue #218).
 *
 * Usage:
 *   node cursor-install.mjs [TARGET]
 *
 *   TARGET — path to the project to install into (default: process.cwd())
 *
 * Exit codes:
 *   0 — success
 *   1 — source rules not found
 */

import { existsSync, mkdirSync, readdirSync, symlinkSync, statSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Resolve SO_ROOT (parent of scripts/)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const SO_ROOT = path.dirname(SCRIPT_DIR);

// ---------------------------------------------------------------------------
// Parse arguments — TARGET defaults to cwd (mirrors: TARGET="${1:-$(pwd)}")
// ---------------------------------------------------------------------------

const TARGET = process.argv[2] ?? process.cwd();

// ---------------------------------------------------------------------------
// Print banner
// ---------------------------------------------------------------------------

process.stdout.write('Session Orchestrator — Cursor IDE Setup\n');
process.stdout.write('========================================\n');
process.stdout.write('\n');
process.stdout.write(`Source: ${SO_ROOT}/.cursor/rules/\n`);
process.stdout.write(`Target: ${TARGET}/.cursor/rules/\n`);
process.stdout.write('\n');

// ---------------------------------------------------------------------------
// Validate source
// ---------------------------------------------------------------------------

const SOURCE_RULES_DIR = path.join(SO_ROOT, '.cursor', 'rules');

if (!existsSync(SOURCE_RULES_DIR) || !statSync(SOURCE_RULES_DIR).isDirectory()) {
  process.stderr.write(`ERROR: Source rules not found at ${SOURCE_RULES_DIR}/\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Create target directory
// mkdir -p "$TARGET/.cursor/rules"
// ---------------------------------------------------------------------------

const TARGET_RULES_DIR = path.join(TARGET, '.cursor', 'rules');
mkdirSync(TARGET_RULES_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Symlink each .mdc file (mirrors the for-loop in the .sh script)
// ---------------------------------------------------------------------------

function _isSymlink(p) {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

function _isFile(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

let count = 0;

const entries = readdirSync(SOURCE_RULES_DIR);
for (const filename of entries) {
  if (!filename.endsWith('.mdc')) continue;

  const mdcFile = path.join(SOURCE_RULES_DIR, filename);

  // Only process regular files (mirrors: [[ ! -f "$mdc_file" ]] && continue)
  if (!_isFile(mdcFile)) continue;

  const targetPath = path.join(TARGET_RULES_DIR, filename);

  if (_isSymlink(targetPath)) {
    process.stdout.write(`  SKIP: ${filename} (symlink exists)\n`);
  } else if (existsSync(targetPath)) {
    process.stdout.write(`  SKIP: ${filename} (file exists — not overwriting)\n`);
  } else {
    symlinkSync(mdcFile, targetPath);
    process.stdout.write(`  LINK: ${filename}\n`);
    count++;
  }
}

// ---------------------------------------------------------------------------
// Done — mirrors the .sh final output exactly
// ---------------------------------------------------------------------------

process.stdout.write('\n');
process.stdout.write(`Done! ${count} rules linked.\n`);
process.stdout.write('\n');
process.stdout.write('Next steps:\n');
process.stdout.write("  1. Ensure CLAUDE.md (or AGENTS.md on Codex CLI) has a '## Session Config' section\n");
process.stdout.write('  2. (Optional) Configure hooks in Cursor Settings > Hooks:\n');
process.stdout.write(`     - afterFileEdit:          ${SO_ROOT}/hooks/enforce-scope.sh\n`);
process.stdout.write(`     - beforeShellExecution:   ${SO_ROOT}/hooks/enforce-commands.sh\n`);
process.stdout.write('  3. Open your project in Cursor and type /session to start!\n');
