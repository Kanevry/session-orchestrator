#!/usr/bin/env node
// check-agents.mjs — Validate agent .md files have valid YAML frontmatter.
// Usage: check-agents.mjs <plugin-root>
// Outputs lines of the form "  PASS: ..." / "  FAIL: ..."
// Exit 0 = all checks passed; exit 1 = at least one failure.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [, , pluginRoot] = process.argv;

if (!pluginRoot) {
  console.error('Usage: check-agents.mjs <plugin-root>');
  process.exit(1);
}

const PLUGIN_JSON = join(pluginRoot, '.claude-plugin', 'plugin.json');
const CONVENTIONAL_AGENTS = 'agents';

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
 * Extract YAML frontmatter content (between first --- and second ---).
 * Returns null if no valid frontmatter block found.
 */
function extractFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : null;
}

/**
 * Get a scalar field value from frontmatter text.
 * Returns null if field not present.
 */
function getField(fm, name) {
  const m = fm.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}

/**
 * Check whether a field key is present in frontmatter (even with empty/block value).
 */
function hasField(fm, name) {
  return new RegExp(`^${name}:`, 'm').test(fm);
}

// ============================================================================
// Check 6: Agent .md files have valid YAML frontmatter
// ============================================================================
console.log('--- Check 6: agent frontmatter ---');

// Resolve agents directory from plugin.json or fall back to conventional location.
let agentsDir;
if (existsSync(PLUGIN_JSON)) {
  let pluginData = {};
  try {
    pluginData = JSON.parse(readFileSync(PLUGIN_JSON, 'utf8'));
  } catch {
    // ignore parse errors — fall back to conventional
  }
  const agentsPath = pluginData.agents;
  if (agentsPath) {
    // Strip leading ./ if present, then join to plugin root
    agentsDir = join(pluginRoot, agentsPath.replace(/^\.\//, ''));
  }
}
if (!agentsDir) {
  agentsDir = join(pluginRoot, CONVENTIONAL_AGENTS);
}

if (!existsSync(agentsDir)) {
  const agentsPath = (() => {
    try {
      return JSON.parse(readFileSync(PLUGIN_JSON, 'utf8')).agents;
    } catch {
      return null;
    }
  })();
  if (agentsPath) {
    fail(`agents path is not a directory: ${agentsPath}`);
  } else {
    fail(`agents directory not found at conventional location: ./${CONVENTIONAL_AGENTS}`);
  }
  console.log('');
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

const mdFiles = readdirSync(agentsDir).filter((f) => f.endsWith('.md'));

if (mdFiles.length === 0) {
  fail('agents directory is empty (no .md files)');
} else {
  for (const agentFile of mdFiles) {
    const agentName = agentFile;
    const filePath = join(agentsDir, agentFile);
    const content = readFileSync(filePath, 'utf8');

    const frontmatter = extractFrontmatter(content);

    if (!frontmatter) {
      fail(`${agentName}: missing YAML frontmatter`);
      continue;
    }

    // ------------------------------------------------------------------
    // Required fields check
    // ------------------------------------------------------------------
    const REQUIRED_FIELDS = ['name', 'description', 'model', 'color'];
    const missingFields = REQUIRED_FIELDS.filter((f) => !hasField(frontmatter, f));

    if (missingFields.length === 0) {
      pass(`${agentName}: all required frontmatter fields present`);
    } else {
      fail(`${agentName}: missing frontmatter fields: ${missingFields.join(' ')}`);
    }

    // ------------------------------------------------------------------
    // Format validation (only when fields are present)
    // ------------------------------------------------------------------

    // description: must be an inline value, not a YAML block scalar (> or |)
    if (hasField(frontmatter, 'description')) {
      const descVal = getField(frontmatter, 'description');
      if (descVal === null || /^[>|]/.test(descVal)) {
        const got = descVal ?? '';
        fail(`${agentName}: description must be an inline string, not a YAML block scalar (got: '${got}')`);
      }
    }

    // model: must be one of inherit | sonnet | opus | haiku
    if (hasField(frontmatter, 'model')) {
      const modelVal = getField(frontmatter, 'model');
      if (modelVal === null || !/^(inherit|sonnet|opus|haiku)$/.test(modelVal)) {
        const got = modelVal ?? '';
        fail(`${agentName}: model must be one of inherit|sonnet|opus|haiku (got: '${got}')`);
      }
    }

    // color: must be one of blue | cyan | green | yellow | magenta | red
    if (hasField(frontmatter, 'color')) {
      const colorVal = getField(frontmatter, 'color');
      if (colorVal === null || !/^(blue|cyan|green|yellow|magenta|red)$/.test(colorVal)) {
        const got = colorVal ?? '';
        fail(`${agentName}: color must be one of blue|cyan|green|yellow|magenta|red (got: '${got}')`);
      }
    }

    // tools: optional — but when present must be a comma-separated string, not a JSON array or YAML block scalar
    if (hasField(frontmatter, 'tools')) {
      const toolsVal = getField(frontmatter, 'tools');
      if (toolsVal !== null && /^\[/.test(toolsVal)) {
        fail(`${agentName}: tools must be a comma-separated string, not a JSON array (got: '${toolsVal}')`);
      } else if (toolsVal !== null && /^[>|]/.test(toolsVal)) {
        fail(`${agentName}: tools must be a comma-separated string, not a YAML block scalar (got: '${toolsVal}')`);
      }
    }
  }
}

console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);

process.exit(failed > 0 ? 1 : 0);
