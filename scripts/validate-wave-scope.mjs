#!/usr/bin/env node
/**
 * validate-wave-scope.mjs — Validate .claude/wave-scope.json before enforcement hooks consume it.
 *
 * Part of v3.0 Bash→Node migration (Epic #124). Replaces validate-wave-scope.sh
 * which depended on scripts/lib/common.sh → scripts/lib/platform.sh (removed).
 *
 * Usage:
 *   node validate-wave-scope.mjs <path-to-wave-scope.json>
 *   cat wave-scope.json | node validate-wave-scope.mjs
 *
 * Exit codes:
 *   0 — valid (validated JSON echoed to stdout)
 *   1 — invalid (error messages written to stderr)
 */

import { readFileSync, existsSync, statSync } from 'node:fs';

function die(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function readInput(argv) {
  const arg = argv[2];
  if (arg) {
    if (!existsSync(arg) || !statSync(arg).isFile()) {
      die(`File not found: ${arg}`);
    }
    return readFileSync(arg, 'utf8');
  }
  return readFileSync(0, 'utf8');
}

function parseJson(input) {
  try {
    return JSON.parse(input);
  } catch {
    die('Input is not valid JSON');
  }
}

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
    if (entry.startsWith('/')) {
      errors.push(`allowedPaths contains absolute path: ${entry}`);
    }
    if (entry.includes('../')) {
      errors.push(`allowedPaths contains path traversal: ${entry}`);
    }
    if (entry === '**/*' || entry === '*') {
      warnings.push(`allowedPaths contains overly permissive pattern: ${entry}`);
    }
  }
}

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

function validateGates(obj, errors) {
  if (!('gates' in obj)) return;
  const gates = obj.gates;
  if (gates === null || typeof gates !== 'object' || Array.isArray(gates)) {
    const t = gates === null ? 'null' : Array.isArray(gates) ? 'array' : typeof gates;
    errors.push(`gates must be an object, got type: ${t}`);
    return;
  }
  const bad = Object.entries(gates).filter(([, v]) => typeof v !== 'boolean').map(([k]) => k);
  if (bad.length > 0) {
    errors.push(`gates values must be booleans, invalid entries: ${bad.join(', ')}`);
  }
}

function validate(input) {
  const obj = parseJson(input);
  const errors = [];
  const warnings = [];

  validateRequired(obj, errors);
  validateAllowedPaths(obj, errors, warnings);
  validateBlockedCommands(obj, errors);
  validateGates(obj, errors);

  for (const w of warnings) {
    process.stderr.write(`WARNING: ${w}\n`);
  }

  if (errors.length > 0) {
    for (const e of errors) {
      process.stderr.write(`ERROR: ${e}\n`);
    }
    process.exit(1);
  }

  process.stdout.write(input.endsWith('\n') ? input : input + '\n');
}

validate(readInput(process.argv));
