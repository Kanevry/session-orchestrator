#!/usr/bin/env node
/**
 * vault-migration-rules.mjs — Per-user config loader for the vault migration scripts.
 *
 * Reads ~/.config/session-orchestrator/vault-migration-rules.yaml and returns
 * structured defaults for the operator-private slug / username-rewrite data
 * that the migration scripts (migrate-vault-paths.mjs, migrate-cold-start-seed.mjs)
 * used to carry as hardcoded literals.
 *
 * Out of scope for this loader: argument-parsing, YAML schema versioning beyond
 * v1, runtime mutation. The migration scripts retain `--repos` / `--from` / `--to`
 * CLI args as the override path; this loader only supplies sensible defaults.
 *
 * Schema (schema-version: 1):
 *
 *   schema-version: 1
 *   username-rewrites:
 *     - from: '/Users/oldname/'
 *       to:   '/Users/newname/'
 *   audited-repos:   # default --repos for migrate-vault-paths.mjs
 *     - repo-name-or-absolute-path
 *   dormant-repos:   # default --repos for migrate-cold-start-seed.mjs
 *     - '~/Projects/path/to/dormant-repo'
 *
 * All three sections are optional. Missing file → defaults are empty arrays;
 * the migration scripts then fall back to their CLI-args path or print a
 * helpful error if no override is given.
 *
 * Path: ~/.config/session-orchestrator/vault-migration-rules.yaml
 *       (same per-user location convention as owner.yaml — outside every repo,
 *        appended to ~/.gitignore by the migration-script bootstrap on first
 *        write).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

export const VAULT_MIGRATION_RULES_PATH = join(
  homedir(),
  '.config',
  'session-orchestrator',
  'vault-migration-rules.yaml',
);

/**
 * Return the empty-defaults shape — used when the file does not exist or
 * fails to parse. Callers decide whether to error or fall back to CLI args.
 *
 * @returns {{ usernameRewrites: Array<{from:string,to:string}>, auditedRepos: string[], dormantRepos: string[] }}
 */
export function getDefaults() {
  return {
    usernameRewrites: [],
    auditedRepos: [],
    dormantRepos: [],
  };
}

/**
 * Load and validate the vault-migration-rules config. Pure, never throws.
 *
 * @param {string} [filePath] - override for the default path (testing only)
 * @returns {{ config: ReturnType<typeof getDefaults>, source: 'file'|'defaults', errors: string[] }}
 */
export function loadVaultMigrationRules(filePath = VAULT_MIGRATION_RULES_PATH) {
  if (!existsSync(filePath)) {
    return { config: getDefaults(), source: 'defaults', errors: [] };
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      config: getDefaults(),
      source: 'defaults',
      errors: [`failed to read vault-migration-rules.yaml: ${err.message}`],
    };
  }

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      config: getDefaults(),
      source: 'defaults',
      errors: [`failed to parse vault-migration-rules.yaml: ${err.message}`],
    };
  }

  const { config, errors } = normalize(parsed);
  return { config, source: errors.length === 0 ? 'file' : 'defaults', errors };
}

/**
 * Normalize a parsed YAML object into the canonical shape, returning errors
 * for malformed entries. Unknown sections are ignored (forward-compatible).
 *
 * @param {unknown} obj
 * @returns {{ config: ReturnType<typeof getDefaults>, errors: string[] }}
 */
function normalize(obj) {
  const errors = [];
  const config = getDefaults();

  if (!isPlainObject(obj)) {
    return { config, errors: ['config must be a YAML mapping'] };
  }

  // username-rewrites: [{ from: string, to: string }]
  const rewrites = obj['username-rewrites'];
  if (rewrites !== undefined) {
    if (!Array.isArray(rewrites)) {
      errors.push('username-rewrites must be an array');
    } else {
      for (let i = 0; i < rewrites.length; i++) {
        const r = rewrites[i];
        if (!isPlainObject(r) || typeof r.from !== 'string' || typeof r.to !== 'string') {
          errors.push(`username-rewrites[${i}]: must have string 'from' and 'to' fields`);
          continue;
        }
        config.usernameRewrites.push({ from: r.from, to: r.to });
      }
    }
  }

  // audited-repos: string[]
  const audited = obj['audited-repos'];
  if (audited !== undefined) {
    if (!Array.isArray(audited) || !audited.every((s) => typeof s === 'string')) {
      errors.push('audited-repos must be an array of strings');
    } else {
      config.auditedRepos = audited.slice();
    }
  }

  // dormant-repos: string[]
  const dormant = obj['dormant-repos'];
  if (dormant !== undefined) {
    if (!Array.isArray(dormant) || !dormant.every((s) => typeof s === 'string')) {
      errors.push('dormant-repos must be an array of strings');
    } else {
      config.dormantRepos = dormant.slice();
    }
  }

  return { config, errors };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
