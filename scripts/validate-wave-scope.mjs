#!/usr/bin/env node
/**
 * validate-wave-scope.mjs — Validate .claude/wave-scope.json before enforcement hooks consume it.
 *
 * Part of v3.0 Bash→Node migration (Epic #124). Replaces validate-wave-scope.sh
 * which depended on scripts/lib/common.sh → scripts/lib/platform.sh (removed).
 *
 * Usage:
 *   node scripts/validate-wave-scope.mjs <path-to-wave-scope.json>
 *   cat wave-scope.json | node scripts/validate-wave-scope.mjs
 *   node scripts/validate-wave-scope.mjs --assert-subset <agent-filescope.json> < wave-scope.json
 *
 * Flags:
 *   --assert-subset <path>  After schema validation passes, read the agent
 *                           fileScope file (a JSON array of strings) and assert
 *                           it is a subset of wave-scope.allowedPaths (#796).
 *                           Fails (exit 1) with "missing: [...]" on violation.
 *
 * Exit codes:
 *   0 — valid (validated JSON echoed to stdout)
 *   1 — invalid input / validation failure (error messages written to stderr)
 *   2 — I/O error (file not found, unreadable stdin, unreadable --assert-subset file)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { warn } from './lib/common.mjs';
import { assertFileScopeSubset } from './lib/scope-gate.mjs';

/**
 * Write an error to stderr and exit with the given code.
 * @param {string} msg
 * @param {number} [code=1]
 * @returns {never}
 */
function die(msg, code = 1) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(code);
}

/**
 * Parse CLI flags out of argv, leaving positional args behind.
 *
 * Recognised: `--assert-subset <path>` (#796). Everything else is treated as a
 * positional argument (the wave-scope.json file path), preserving legacy
 * behaviour where argv[2] is the input file.
 *
 * @param {string[]} argv - full process.argv
 * @returns {{ assertSubset: string|null, positionals: string[] }}
 */
function parseArgs(argv) {
  const positionals = [];
  let assertSubset = null;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--assert-subset') {
      assertSubset = argv[i + 1];
      if (assertSubset === undefined) {
        die('--assert-subset requires a file-path argument', 1);
      }
      i++; // consume the value
    } else {
      positionals.push(a);
    }
  }
  return { assertSubset, positionals };
}

/**
 * Read raw input: from a file path arg or from stdin (fd 0).
 *
 * Exit codes used here:
 *   1 — bad argument (file path argument given but file not found)
 *   2 — unexpected I/O error (file exists but cannot be read, stdin failure)
 *
 * @param {string|undefined} arg - the positional wave-scope.json file path (or undefined for stdin)
 * @returns {string}
 */
function readInput(arg) {
  if (arg) {
    // Exit 1: file not found is a user/argument error
    if (!existsSync(arg) || !statSync(arg).isFile()) {
      die(`File not found: ${arg}`, 1);
    }
    // Exit 2: file exists but cannot be read is an I/O error
    try {
      return readFileSync(arg, 'utf8');
    } catch (err) {
      die(`Cannot read file ${arg}: ${err.message}`, 2);
    }
  }
  // Exit 2: stdin read failure is an I/O error
  try {
    return readFileSync(0, 'utf8');
  } catch (err) {
    die(`Cannot read stdin: ${err.message}`, 2);
  }
}

/**
 * Parse raw JSON input; exits 1 on parse failure.
 * @param {string} input
 * @returns {unknown}
 */
function parseJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    die('Input is not valid JSON');
  }
}

/**
 * Validate required scalar fields: wave, role, enforcement.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 */
function validateRequired(obj, errors) {
  // wave — positive integer
  if (!('wave' in obj) || obj.wave === null || obj.wave === undefined) {
    errors.push('Missing required field: wave');
  } else if (typeof obj.wave !== 'number' || !Number.isInteger(obj.wave) || obj.wave <= 0) {
    errors.push(`wave must be a positive integer, got: ${JSON.stringify(obj.wave)}`);
  }

  // role — non-empty string
  const roleType = obj.role === null ? 'null' : typeof obj.role;
  if (!('role' in obj) || roleType !== 'string') {
    errors.push(`role must be a string, got type: ${roleType}`);
  } else if (obj.role.length === 0) {
    errors.push('role must be a non-empty string');
  }

  // enforcement — one of strict|warn|off
  const enfType = obj.enforcement === null ? 'null' : typeof obj.enforcement;
  if (!('enforcement' in obj) || enfType !== 'string') {
    errors.push(`enforcement must be a string, got type: ${enfType}`);
  } else if (!['strict', 'warn', 'off'].includes(obj.enforcement)) {
    errors.push(`enforcement must be one of: strict, warn, off — got: ${obj.enforcement}`);
  }
}

/**
 * Validate allowedPaths array: must exist, be an array of non-empty strings,
 * with no absolute paths and no path-traversal segments.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 * @param {string[]} warnings
 */
function validateAllowedPaths(obj, errors, warnings) {
  if (!('allowedPaths' in obj)) {
    errors.push('Missing required field: allowedPaths');
    return;
  }
  const ap = obj.allowedPaths;
  if (!Array.isArray(ap)) {
    errors.push(`allowedPaths must be an array, got type: ${ap === null ? 'null' : typeof ap}`);
    return;
  }
  for (const entry of ap) {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push('allowedPaths contains empty string');
      continue;
    }
    // Reject absolute paths (must be repo-relative)
    if (entry.startsWith('/')) {
      errors.push(`allowedPaths contains absolute path: ${entry}`);
    }
    // Reject path traversal: any `../` segment
    if (entry.includes('../')) {
      errors.push(`allowedPaths contains path traversal: ${entry}`);
    }
    // Warn on overly permissive glob patterns
    if (entry === '**/*' || entry === '*') {
      warnings.push(`allowedPaths contains overly permissive pattern: ${entry}`);
    }
  }
}

/**
 * Validate blockedCommands: must exist and be an array.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 */
function validateBlockedCommands(obj, errors) {
  if (!('blockedCommands' in obj)) {
    errors.push('Missing required field: blockedCommands');
    return;
  }
  if (!Array.isArray(obj.blockedCommands)) {
    const t = obj.blockedCommands === null ? 'null' : typeof obj.blockedCommands;
    errors.push(`blockedCommands must be an array, got type: ${t}`);
  }
}

/**
 * Validate optional gates field: if present must be an object of string→boolean entries.
 * @param {Record<string, unknown>} obj
 * @param {string[]} errors
 */
function validateGates(obj, errors) {
  if (!('gates' in obj)) return;
  const gates = obj.gates;
  if (gates === null || typeof gates !== 'object' || Array.isArray(gates)) {
    const t = gates === null ? 'null' : Array.isArray(gates) ? 'array' : typeof gates;
    errors.push(`gates must be an object, got type: ${t}`);
    return;
  }
  const bad = Object.entries(gates)
    .filter(([, v]) => typeof v !== 'boolean')
    .map(([k]) => k);
  if (bad.length > 0) {
    errors.push(`gates values must be booleans, invalid entries: ${bad.join(', ')}`);
  }
}

/**
 * Read the agent fileScope sidecar file and assert it is a subset of the
 * wave's allowedPaths union (#796). Exits on failure; returns on success.
 *
 * Exit codes:
 *   1 — fileScope file is not valid JSON, is not an array of strings, or the
 *       subset assertion fails (validation error)
 *   2 — fileScope file is missing / not a regular file / unreadable (I/O error)
 *
 * @param {Record<string, unknown>} obj - the already schema-validated wave-scope object
 * @param {string} fileScopePath - path to the agent fileScope JSON file
 */
function assertSubsetOrDie(obj, fileScopePath) {
  if (!existsSync(fileScopePath) || !statSync(fileScopePath).isFile()) {
    die(`Cannot read --assert-subset file: ${fileScopePath}`, 2);
  }
  let raw;
  try {
    raw = readFileSync(fileScopePath, 'utf8');
  } catch (err) {
    die(`Cannot read --assert-subset file ${fileScopePath}: ${err.message}`, 2);
  }
  let fileScope;
  try {
    fileScope = JSON.parse(raw);
  } catch {
    die(`--assert-subset file is not valid JSON: ${fileScopePath}`, 1);
  }
  if (!Array.isArray(fileScope) || !fileScope.every((e) => typeof e === 'string')) {
    die('--assert-subset file must be a JSON array of strings', 1);
  }
  const { ok, missing } = assertFileScopeSubset(fileScope, obj.allowedPaths);
  if (!ok) {
    die(`agent fileScope not ⊆ allowedPaths — missing: [${missing.join(', ')}]`, 1);
  }
}

/**
 * Main validation entry point. Reads input, validates, exits with appropriate code.
 * @param {string} input - raw JSON string
 * @param {string|null} [assertSubsetPath] - optional agent fileScope file for the #796 subset assertion
 */
function validate(input, assertSubsetPath = null) {
  const obj = parseJson(input);
  const errors = [];
  const warnings = [];

  validateRequired(obj, errors);
  validateAllowedPaths(obj, errors, warnings);
  validateBlockedCommands(obj, errors);
  validateGates(obj, errors);

  for (const w of warnings) {
    warn(w);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`ERROR: ${e}\n`);
    }
    process.exit(1);
  }

  // #796 — optional dispatch-time subset assertion (runs only after schema validation passes)
  if (assertSubsetPath) {
    assertSubsetOrDie(obj, assertSubsetPath);
  }

  // Echo validated JSON to stdout (trailing newline normalised)
  process.stdout.write(input.endsWith('\n') ? input : input + '\n');
}

const { assertSubset, positionals } = parseArgs(process.argv);
validate(readInput(positionals[0]), assertSubset);
