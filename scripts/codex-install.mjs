#!/usr/bin/env node
/**
 * codex-install.mjs — Install Session Orchestrator into the active Codex plugin catalog.
 *
 * Behaviour-parity port of codex-install.sh (issue #218).
 *
 * Exit codes:
 *   0 — success
 *   1 — missing dependency or file operation failure
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { die, requireJq } from './lib/common.mjs';

// ---------------------------------------------------------------------------
// Resolve SO_ROOT (parent of scripts/)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const SO_ROOT = path.dirname(SCRIPT_DIR);

// ---------------------------------------------------------------------------
// Validate dependencies
// ---------------------------------------------------------------------------

try {
  requireJq();
} catch (e) {
  die(e.message);
}

// Also need rsync
try {
  execSync('command -v rsync', { stdio: 'ignore', shell: true });
} catch {
  die('rsync is required but not installed. Install via: brew install rsync');
}

// ---------------------------------------------------------------------------
// Path constants (mirror the .sh variables exactly)
// ---------------------------------------------------------------------------

const PLUGIN_NAME = 'session-orchestrator';
const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const CODEX_CONFIG = path.join(CODEX_HOME, 'config.toml');
const ACTIVE_SYNC_ROOT = path.join(CODEX_HOME, '.tmp', 'plugins');
const ACTIVE_MARKETPLACE = path.join(ACTIVE_SYNC_ROOT, '.agents', 'plugins', 'marketplace.json');
const ACTIVE_PLUGIN_DIR = path.join(ACTIVE_SYNC_ROOT, 'plugins', PLUGIN_NAME);
const FALLBACK_MARKETPLACE = path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json');
const FALLBACK_PLUGIN_DIR = path.join(os.homedir(), 'plugins', PLUGIN_NAME);

// ---------------------------------------------------------------------------
// Determine active vs fallback mode (mirrors the .sh if/else block)
// ---------------------------------------------------------------------------

function _isDirSync(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

let USE_ACTIVE_SYNC = false;
let MARKETPLACE_PATH;
let PLUGIN_DEST;
let MARKETPLACE_NAME;

if (existsSync(ACTIVE_MARKETPLACE) && _isDirSync(path.join(ACTIVE_SYNC_ROOT, 'plugins'))) {
  USE_ACTIVE_SYNC = true;
  MARKETPLACE_PATH = ACTIVE_MARKETPLACE;
  PLUGIN_DEST = ACTIVE_PLUGIN_DIR;
  // jq -r '.name // "openai-curated"' "$ACTIVE_MARKETPLACE"
  try {
    const raw = execFileSync('jq', ['-r', '.name // "openai-curated"', ACTIVE_MARKETPLACE], { encoding: 'utf8' });
    MARKETPLACE_NAME = raw.trim();
  } catch {
    MARKETPLACE_NAME = 'openai-curated';
  }
} else {
  MARKETPLACE_PATH = FALLBACK_MARKETPLACE;
  PLUGIN_DEST = FALLBACK_PLUGIN_DIR;
  MARKETPLACE_NAME = 'local';
}

// ---------------------------------------------------------------------------
// Create required directories
// mkdir -p "$(dirname "$MARKETPLACE_PATH")" "$(dirname "$PLUGIN_DEST")" "$PLUGIN_DEST"
// ---------------------------------------------------------------------------

try {
  mkdirSync(path.dirname(MARKETPLACE_PATH), { recursive: true });
  mkdirSync(path.dirname(PLUGIN_DEST), { recursive: true });
  mkdirSync(PLUGIN_DEST, { recursive: true });
} catch (e) {
  die(`Failed to create directories: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Print banner
// ---------------------------------------------------------------------------

process.stdout.write('Session Orchestrator — Codex Setup\n');
process.stdout.write('=================================\n');
process.stdout.write('\n');
process.stdout.write(`Source:      ${SO_ROOT}\n`);
process.stdout.write(`Destination: ${PLUGIN_DEST}\n`);
process.stdout.write(`Marketplace: ${MARKETPLACE_PATH}\n`);
process.stdout.write(`Catalog:     ${MARKETPLACE_NAME}\n`);
process.stdout.write('\n');

// ---------------------------------------------------------------------------
// rsync plugin files (mirrors the .sh rsync command exactly)
// ---------------------------------------------------------------------------

try {
  execFileSync('rsync', [
    '-a',
    '--delete',
    '--exclude', '.git',
    '--exclude', 'node_modules',
    '--exclude', '.claude',
    '--exclude', '.codex',
    '--exclude', '.cursor',
    '--exclude', '.orchestrator',
    '--exclude', 'coverage',
    '--exclude', 'dist',
    SO_ROOT + '/',
    PLUGIN_DEST + '/',
  ], { stdio: 'inherit' });
} catch (e) {
  die(`rsync failed: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Create marketplace.json if it does not exist
// ---------------------------------------------------------------------------

if (!existsSync(MARKETPLACE_PATH)) {
  const initial = JSON.stringify({
    name: MARKETPLACE_NAME,
    interface: { displayName: 'Local Plugins' },
    plugins: [],
  }, null, 2) + '\n';
  try {
    writeFileSync(MARKETPLACE_PATH, initial, 'utf8');
  } catch (e) {
    die(`Failed to write marketplace.json: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Upsert plugin entry in marketplace.json via jq
// Mirrors the jq + mv pattern in the .sh script exactly
// ---------------------------------------------------------------------------

const tmpMarketplace = path.join(os.tmpdir(), `so-marketplace-${Date.now()}.json`);

try {
  // Inline jq filter — identical to the .sh heredoc filter
  const jqFilter = [
    '.plugins |= (',
    '  map(select(.name != $plugin)) + [',
    '    {',
    '      "name": $plugin,',
    '      "source": {',
    '        "source": "local",',
    '        "path": ("./plugins/" + $plugin)',
    '      },',
    '      "policy": {',
    '        "installation": "AVAILABLE",',
    '        "authentication": "ON_INSTALL"',
    '      },',
    '      "category": "Coding"',
    '    }',
    '  ]',
    ')',
  ].join('\n');

  const output = execFileSync('jq', ['--arg', 'plugin', PLUGIN_NAME, jqFilter, MARKETPLACE_PATH], {
    encoding: 'utf8',
  });
  writeFileSync(tmpMarketplace, output, 'utf8');
  execFileSync('mv', [tmpMarketplace, MARKETPLACE_PATH]);
} catch (e) {
  try { rmSync(tmpMarketplace, { force: true }); } catch { /* ignore */ }
  die(`Failed to update marketplace.json: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Ensure config.toml exists
// mkdir -p "$(dirname "$CODEx_CONFIG")" && touch "$CODEx_CONFIG"
// ---------------------------------------------------------------------------

try {
  mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true });
  if (!existsSync(CODEX_CONFIG)) {
    writeFileSync(CODEX_CONFIG, '', 'utf8');
  }
} catch (e) {
  die(`Failed to ensure config.toml: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Update config.toml: upsert [plugins."<name>@<marketplace>"] with enabled = true
//
// Port of the awk script in codex-install.sh.  The awk script's logic:
//   - When the target section header is found: print it, enter in_target mode, set seen=1
//   - When a different [plugins."..."] section starts: if in_target and no enabled written, print it first
//   - While in_target: if a line matches /^enabled = /, replace with "enabled = true" and mark wrote_enabled
//   - At END: if in_target and no enabled written, print it; if section never seen, append it
// ---------------------------------------------------------------------------

const CONFIG_KEY = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const targetSection = `[plugins."${CONFIG_KEY}"]`;

function updateConfigToml(content, section) {
  const lines = content.split('\n');
  const output = [];
  let inTarget = false;
  let seen = false;
  let wroteEnabled = false;

  for (const line of lines) {
    if (line === section) {
      output.push(line);
      inTarget = true;
      seen = true;
      continue;
    }

    if (/^\[plugins\."/.test(line)) {
      if (inTarget && !wroteEnabled) {
        output.push('enabled = true');
        wroteEnabled = true;
      }
      inTarget = false;
    }

    if (inTarget && /^enabled = /.test(line)) {
      output.push('enabled = true');
      wroteEnabled = true;
      continue;
    }

    output.push(line);
  }

  // END block from awk
  if (inTarget && !wroteEnabled) {
    output.push('enabled = true');
  }
  if (!seen) {
    output.push('');
    output.push(section);
    output.push('enabled = true');
  }

  return output.join('\n');
}

const tmpConfig = path.join(os.tmpdir(), `so-config-${Date.now()}.toml`);

try {
  const existingConfig = readFileSync(CODEX_CONFIG, 'utf8');
  const updatedConfig = updateConfigToml(existingConfig, targetSection);
  writeFileSync(tmpConfig, updatedConfig, 'utf8');
  execFileSync('mv', [tmpConfig, CODEX_CONFIG]);
} catch (e) {
  try { rmSync(tmpConfig, { force: true }); } catch { /* ignore */ }
  die(`Failed to update config.toml: ${e.message}`);
}

// ---------------------------------------------------------------------------
// Done — final output mirrors the .sh exactly
// ---------------------------------------------------------------------------

process.stdout.write('Done.\n');
process.stdout.write('\n');
if (USE_ACTIVE_SYNC) {
  process.stdout.write('Installed into the active Codex desktop sync catalog.\n');
} else {
  process.stdout.write('Installed into the fallback local Codex marketplace.\n');
}
process.stdout.write('Restart Codex completely to reload plugin commands.\n');
