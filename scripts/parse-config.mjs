#!/usr/bin/env node
/**
 * parse-config.mjs — Parse ## Session Config from CLAUDE.md or AGENTS.md and output validated JSON.
 * Part of Session Orchestrator v3.0.0 (originally parse-config.sh in v2).
 *
 * Usage: node scripts/parse-config.mjs [path/to/CLAUDE.md|AGENTS.md]
 *   If no path given, walks up from cwd to find project root and uses its CLAUDE.md (or AGENTS.md).
 *
 * Output: Single JSON object to stdout with ALL config fields (defaults applied).
 * Exit codes: 0 success, 1 error (message to stderr)
 *
 * Environment:
 *   SO_CONFIG_FILE             — override filename (e.g. "AGENTS.md") resolved from project root
 *   SO_SKIP_CONFIG_VALIDATION  — set to "1" to bypass validate-config.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, parse as parsePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSessionConfig } from './lib/config.mjs';

// ---------------------------------------------------------------------------
// memory.proposals parser (issue #501)
// Extends the memory object returned by _parseMemory() in config/memory.mjs.
// Scoped here because scripts/lib/config/memory.mjs is outside this wave's
// allowed paths — this is the minimal-diff alternative location.
// ---------------------------------------------------------------------------

/**
 * Parse the `proposals:` sub-block nested inside the top-level `memory:` block.
 *
 * YAML shape expected in CLAUDE.md:
 *   memory:
 *     banner:
 *       enabled: true
 *     proposals:
 *       enabled: true
 *       quota-per-wave: 5
 *       confidence-floor: 0.5
 *
 * Defaults:
 *   proposals.enabled:          true
 *   proposals.quota-per-wave:   5   (integer ≥ 0)
 *   proposals.confidence-floor: 0.5 (float 0.0..1.0)
 *
 * Tolerant: malformed values silently fall back to defaults.
 *
 * @param {string} content — full CLAUDE.md / AGENTS.md content
 * @returns {{ enabled: boolean, 'quota-per-wave': number, 'confidence-floor': number }}
 */
function _parseMemoryProposals(content) {
  const defaults = {
    enabled: true,
    'quota-per-wave': 5,
    'confidence-floor': 0.5,
  };

  const lines = content.split(/\r?\n/);
  let inMemoryBlock = false;
  let inProposalsBlock = false;
  const proposalsLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (!inMemoryBlock) {
      if (/^memory:\s*$/.test(line)) inMemoryBlock = true;
      continue;
    }

    // Exit memory block when we hit a non-indented, non-empty line
    if (line.length > 0 && !/^\s/.test(line)) break;

    if (!inProposalsBlock) {
      // Detect `  proposals:` sub-block header (exactly 2-space indent, matches memory.mjs convention)
      if (/^\s{2}proposals:\s*$/.test(line)) {
        inProposalsBlock = true;
      }
      continue;
    }

    // Exit proposals sub-block when we hit a 2-space sibling key (not 4-space child)
    if (/^\s{2}[a-zA-Z_-]+:/.test(line) && !/^\s{4}/.test(line)) break;

    proposalsLines.push(line);
  }

  if (proposalsLines.length === 0) return defaults;

  let enabled = true;
  let quotaPerWave = 5;
  let confidenceFloor = 0.5;

  for (const rawLine of proposalsLines) {
    // Strip inline comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    // Strip surrounding quotes (matches memory.mjs and cold-start.mjs quote-stripping behaviour)
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default is true → only flip to false on explicit "false"
        enabled = v.toLowerCase() !== 'false';
        break;
      case 'quota-per-wave': {
        if (/^\d+$/.test(v)) {
          const n = parseInt(v, 10);
          if (n >= 0) quotaPerWave = n;
        }
        break;
      }
      case 'confidence-floor': {
        const f = parseFloat(v);
        if (!isNaN(f) && f >= 0.0 && f <= 1.0) confidenceFloor = f;
        break;
      }
    }
  }

  return {
    enabled,
    'quota-per-wave': quotaPerWave,
    'confidence-floor': confidenceFloor,
  };
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Project-root resolution (walk up from cwd until .git / CLAUDE.md / AGENTS.md)
// ---------------------------------------------------------------------------

function findProjectRoot(startDir) {
  let dir = resolve(startDir);
  const { root } = parsePath(dir);

  while (true) {
    if (
      existsSync(join(dir, '.git')) ||
      existsSync(join(dir, 'CLAUDE.md')) ||
      existsSync(join(dir, 'AGENTS.md'))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir || dir === root) {
      // Reached filesystem root without finding a project root — return cwd
      return resolve(startDir);
    }
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Config file resolution (mirrors parse-config.sh lines 31-47)
// ---------------------------------------------------------------------------

function resolveConfigFile(argPath) {
  if (argPath) {
    const abs = resolve(argPath);
    if (!existsSync(abs)) {
      process.stderr.write(`parse-config.mjs: File not found: ${argPath}\n`);
      process.exit(1);
    }
    return abs;
  }

  const projectRoot = findProjectRoot(process.cwd());
  const soConfigFile = process.env.SO_CONFIG_FILE;

  if (soConfigFile) {
    const candidate = join(projectRoot, soConfigFile);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const claudeMd = join(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    return claudeMd;
  }

  const agentsMd = join(projectRoot, 'AGENTS.md');
  if (existsSync(agentsMd)) {
    return agentsMd;
  }

  process.stderr.write('parse-config.mjs: CLAUDE.md or AGENTS.md required\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const argPath = process.argv[2] ?? null;
const configFile = resolveConfigFile(argPath);

let content;
try {
  content = readFileSync(configFile, 'utf8');
} catch (err) {
  process.stderr.write(`parse-config.mjs: Failed to read ${configFile}: ${err.message}\n`);
  process.exit(1);
}

let config;
try {
  config = parseSessionConfig(content);
} catch (err) {
  process.stderr.write(`parse-config.mjs: Parse error: ${err.message}\n`);
  process.exit(1);
}

// Extend memory with proposals sub-block (issue #501).
// _parseMemory (in config/memory.mjs) only returns { banner: { enabled } };
// proposals are appended here to avoid touching the out-of-scope memory.mjs.
config.memory = {
  ...config.memory,
  proposals: _parseMemoryProposals(content),
};

// jq -n produces pretty-printed JSON without a trailing newline — match that format
const assembledJson = JSON.stringify(config, null, 2);

// ---------------------------------------------------------------------------
// Validation gate (mirrors parse-config.sh lines 281-286)
// ---------------------------------------------------------------------------

const validatorPath = join(SCRIPT_DIR, 'validate-config.mjs');
const skipValidation = process.env.SO_SKIP_CONFIG_VALIDATION === '1';

if (!skipValidation && existsSync(validatorPath)) {
  // Use spawnSync so we can capture both stdout and stderr regardless of exit code
  const result = spawnSync('node', [validatorPath], {
    input: assembledJson,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (result.error) {
    process.stderr.write(`parse-config.mjs: Failed to run validator: ${result.error.message}\n`);
    process.exit(1);
  }

  // Relay validator stderr (warnings or errors) to our stderr
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  if (result.status !== 0) {
    // strict enforcement: validator exited non-zero → suppress stdout, exit 1
    process.exit(1);
  }

  // Emit whatever the validator wrote to stdout (validate-config.mjs passes through raw input)
  process.stdout.write(result.stdout);
} else {
  // Match jq -n output: no trailing newline
  process.stdout.write(assembledJson);
}
