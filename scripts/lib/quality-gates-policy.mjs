/**
 * Quality-gates policy loader.
 *
 * Reads .orchestrator/policy/quality-gates.json (issue #183).
 * Consumed by scripts/run-quality-gate.mjs and the quality-gates skill.
 *
 * Policy-file-first: when a valid policy exists, its commands take precedence
 * over the project-instruction file's Session Config (CLAUDE.md, or AGENTS.md
 * on Codex CLI — see skills/_shared/instruction-file-resolution.md). Falls
 * back to caller-provided defaults when the file is missing or malformed.
 *
 * Never throws.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_KEYS = ['test', 'typecheck', 'lint'];

/**
 * Loads and shape-validates the quality-gates policy file.
 *
 * @param {string} repoRoot - repository root (where .orchestrator/ lives)
 * @returns {object|null} parsed policy, or null if missing/invalid
 */
export function loadQualityGatesPolicy(repoRoot) {
  const path = join(repoRoot, '.orchestrator/policy/quality-gates.json');
  if (!existsSync(path)) return null;

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    process.stderr.write(`⚠ quality-gates policy: malformed JSON at ${path}: ${err.message}\n`);
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`⚠ quality-gates policy: root must be an object (${path})\n`);
    return null;
  }
  if (parsed['version'] !== 1) {
    process.stderr.write(`⚠ quality-gates policy: unsupported version ${JSON.stringify(parsed['version'])} (${path})\n`);
    return null;
  }
  const commands = parsed['commands'];
  if (commands === null || typeof commands !== 'object' || Array.isArray(commands)) {
    process.stderr.write(`⚠ quality-gates policy: commands must be an object (${path})\n`);
    return null;
  }
  for (const key of REQUIRED_KEYS) {
    const entry = commands[key];
    if (
      entry === null ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry['command'] !== 'string' ||
      entry['command'].trim() === ''
    ) {
      process.stderr.write(`⚠ quality-gates policy: commands.${key}.command must be a non-empty string (${path})\n`);
      return null;
    }
  }
  return parsed;
}

/**
 * Resolves a command from policy or falls back to the caller's default.
 *
 * @param {object|null} policy - result of loadQualityGatesPolicy
 * @param {"test"|"typecheck"|"lint"} key
 * @param {string} fallback - fallback command when policy lacks the key
 * @returns {string}
 */
export function resolveCommand(policy, key, fallback) {
  if (policy && policy.commands && policy.commands[key] && typeof policy.commands[key].command === 'string') {
    return policy.commands[key].command;
  }
  return fallback;
}

/**
 * Maps a Session Config key (e.g. "test-command") from the project-instruction
 * file (CLAUDE.md or AGENTS.md alias) to the policy-file key ("test"). Used by
 * run-quality-gate.mjs.
 *
 * @param {string} configKey
 * @returns {"test"|"typecheck"|"lint"|null}
 */
export function configKeyToPolicyKey(configKey) {
  if (configKey === 'test-command') return 'test';
  if (configKey === 'typecheck-command') return 'typecheck';
  if (configKey === 'lint-command') return 'lint';
  return null;
}
