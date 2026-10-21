#!/usr/bin/env node
// check-component-paths.mjs — Validate plugin component path fields resolve to real locations.
// Covers: commands, agents, hooks, mcpServers path resolution from plugin.json.
// Usage: check-component-paths.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..."
// Exit 0 = all checks passed; exit 1 = at least one failure.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-component-paths.mjs <plugin-root>');
  process.exit(1);
}

const PLUGIN_JSON = join(pluginRoot, '.claude-plugin', 'plugin.json');

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

// ============================================================================
// Check 4: Component path fields resolve to real files/directories
// ============================================================================
console.log('--- Check 4: component paths ---');

// Load plugin.json — required for all checks below
let json;
try {
  json = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
} catch {
  fail(`plugin.json not found or invalid JSON at ${PLUGIN_JSON}`);
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

// Conventional auto-discovery locations (relative to plugin root)
const CONVENTIONAL = {
  commands: 'commands',
  agents: 'agents',
  hooks: 'hooks/hooks.json',
  mcpServers: '.mcp.json',
};

/**
 * Strip a leading "./" from a path string.
 * @param {string} p
 * @returns {string}
 */
function stripLeadingDotSlash(p) {
  return p.replace(/^\.\//, '');
}

/**
 * Check that a component path field either resolves to a real path or
 * falls back to a conventional location.
 *
 * @param {string} field        - JSON field name (e.g. "commands")
 * @param {string} conventional - Conventional relative path under pluginRoot
 * @param {boolean} optional    - If true, missing conventional path is a PASS
 */
function checkComponentPath(field, conventional, optional = false) {
  const value = json[field];
  // hooks/mcpServers also accept inline config objects (plugins-reference §
  // Component path forms). An inline object carries no path to resolve; arrays
  // may mix paths and objects, so each string entry is checked as a path.
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') checkExplicitPath(field, entry);
      else pass(`${field} inline config entry (no path to resolve)`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    pass(`${field} is an inline config object (no path to resolve)`);
    return;
  }
  const relPath = value || '';

  if (!relPath) {
    // No explicit value — try conventional auto-discovery
    const absPath = join(pluginRoot, conventional);
    if (existsSync(absPath)) {
      pass(`${field} auto-discovered at: ./${conventional}`);
    } else if (optional) {
      pass(`${field} not found at conventional location (optional, skipped)`);
    } else {
      fail(`${field} not found at conventional location: ./${conventional}`);
    }
    return;
  }

  checkExplicitPath(field, relPath);
}

/**
 * Check one explicit component path: must start with "./" and exist.
 * @param {string} field
 * @param {string} relPath
 */
function checkExplicitPath(field, relPath) {
  // Explicit value — must start with "./"
  if (!relPath.startsWith('./')) {
    fail(`${field} path does not start with ./: ${relPath}`);
    return;
  }

  const absPath = join(pluginRoot, stripLeadingDotSlash(relPath));
  if (existsSync(absPath)) {
    pass(`${field} resolves to: ${relPath}`);
  } else {
    fail(`${field} path does not exist: ${relPath} (resolved to ${absPath})`);
  }
}

checkComponentPath('commands', CONVENTIONAL.commands);
checkComponentPath('agents', CONVENTIONAL.agents);
checkComponentPath('hooks', CONVENTIONAL.hooks);
checkComponentPath('mcpServers', CONVENTIONAL.mcpServers, true);

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
