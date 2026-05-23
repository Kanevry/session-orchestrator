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
