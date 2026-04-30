#!/usr/bin/env node
// check-json-files.mjs — Validate hooks and mcpServers JSON file contents.
// Usage: check-json-files.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..."
// Exit 0 = all checks passed; exit 1 = at least one failure.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-json-files.mjs <plugin-root>');
  process.exit(1);
}

const PLUGIN_JSON = join(pluginRoot, '.claude-plugin', 'plugin.json');
const CONVENTIONAL_HOOKS = 'hooks/hooks.json';

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

function isValidJson(filePath) {
  try {
    JSON.parse(readFileSync(filePath, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

// Read plugin.json to resolve configured paths
let pluginData = {};
if (existsSync(PLUGIN_JSON)) {
  try {
    pluginData = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
  } catch {
    // plugin.json invalid — proceed with empty data; path checks will use auto-discovery
  }
}

// ============================================================================
// Check 5: hooks file is valid JSON (if it's a .json file)
// ============================================================================
console.log('--- Check 5: hooks JSON validity ---');

const hooksPath = pluginData.hooks ?? '';
if (hooksPath && hooksPath.endsWith('.json')) {
  const hooksAbs = join(pluginRoot, hooksPath.replace(/^\.\//, ''));
  if (existsSync(hooksAbs)) {
    if (isValidJson(hooksAbs)) {
      pass('hooks file is valid JSON');
    } else {
      fail(`hooks file is not valid JSON: ${hooksPath}`);
    }
  } else {
    fail('hooks file not found (already reported above)');
  }
} else {
  const hooksAbs = join(pluginRoot, CONVENTIONAL_HOOKS);
  if (existsSync(hooksAbs)) {
    if (isValidJson(hooksAbs)) {
      pass(`hooks file is valid JSON (auto-discovered at ./${CONVENTIONAL_HOOKS})`);
    } else {
      fail(`hooks file is not valid JSON: ./${CONVENTIONAL_HOOKS}`);
    }
  } else {
    pass('hooks is not a JSON file or not specified (skipped)');
  }
}

// ============================================================================
// Check 5b: mcpServers file is valid JSON (if specified)
// ============================================================================
console.log('');
console.log('--- Check 5b: mcpServers JSON validity ---');

const mcpPath = pluginData.mcpServers ?? '';
if (mcpPath && mcpPath.endsWith('.json')) {
  const mcpAbs = join(pluginRoot, mcpPath.replace(/^\.\//, ''));
  if (existsSync(mcpAbs)) {
    if (isValidJson(mcpAbs)) {
      pass('mcpServers file is valid JSON');
    } else {
      fail(`mcpServers file is not valid JSON: ${mcpPath}`);
    }
  } else {
    fail('mcpServers file not found (already reported above)');
  }
} else {
  const mcpAbs = join(pluginRoot, '.mcp.json');
  if (existsSync(mcpAbs)) {
    if (isValidJson(mcpAbs)) {
      pass('mcpServers file is valid JSON (auto-discovered at ./.mcp.json)');
    } else {
      fail('mcpServers file is not valid JSON: ./.mcp.json');
    }
  } else {
    pass('mcpServers not found at conventional location (optional, skipped)');
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
