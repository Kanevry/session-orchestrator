/**
 * config-writer.mjs — validates ecosystem policy shape and writes artifacts:
 * .orchestrator/policy/ecosystem.json and the ecosystem-health block in Session Config.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** @param {unknown} arr @param {string} field @param {string[]} errors */
function _validateEndpoints(arr, field, errors) {
  if (!Array.isArray(arr)) { errors.push(`${field} must be an array`); return; }
  for (let i = 0; i < arr.length; i++) {
    const ep = arr[i];
    if (ep === null || typeof ep !== 'object' || Array.isArray(ep)) {
      errors.push(`${field}[${i}] must be a plain object`); continue;
    }
    if (typeof ep['name'] !== 'string' || ep['name'].trim() === '')
      errors.push(`${field}[${i}].name must be a non-empty string`);
    if (typeof ep['url'] !== 'string' || ep['url'].trim() === '')
      errors.push(`${field}[${i}].url must be a non-empty string`);
  }
}

/** @param {unknown} arr @param {string} field @param {string[]} errors */
function _validatePipelines(arr, field, errors) {
  if (!Array.isArray(arr)) { errors.push(`${field} must be an array`); return; }
  for (let i = 0; i < arr.length; i++) {
    const pl = arr[i];
    if (pl === null || typeof pl !== 'object' || Array.isArray(pl)) {
      errors.push(`${field}[${i}] must be a plain object`); continue;
    }
    if (typeof pl['id'] !== 'string' || pl['id'].trim() === '')
      errors.push(`${field}[${i}].id must be a non-empty string`);
  }
}

/** @param {unknown} arr @param {string} field @param {string[]} errors */
function _validateLabels(arr, field, errors) {
  if (!Array.isArray(arr)) { errors.push(`${field} must be an array`); return; }
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== 'string' || arr[i].trim() === '')
      errors.push(`${field}[${i}] must be a non-empty string`);
  }
}

/**
 * Validates the ecosystem policy shape.
 * Returns [] when valid; an array of error strings when invalid.
 *
 * @param {unknown} policy
 * @returns {string[]}
 */
export function validateEcosystemPolicy(policy) {
  const errors = [];
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    errors.push('policy must be a plain object');
    return errors;
  }
  if (policy['version'] !== 1) {
    errors.push(`version must be 1, got ${JSON.stringify(policy['version'])}`);
  }
  if (policy['endpoints'] !== undefined) _validateEndpoints(policy['endpoints'], 'endpoints', errors);
  if (policy['pipelines'] !== undefined) _validatePipelines(policy['pipelines'], 'pipelines', errors);
  if (policy['criticalIssueLabels'] !== undefined)
    _validateLabels(policy['criticalIssueLabels'], 'criticalIssueLabels', errors);
  return errors;
}

// ---------------------------------------------------------------------------
// Session Config reader/writer
// ---------------------------------------------------------------------------

/**
 * Returns whether the Session Config section in `text` already contains an
 * ecosystem-health key.
 * @param {string} text
 * @param {RegExpMatchArray|null} startMatch
 * @returns {boolean}
 */
function _ecosystemBlockPresent(text, startMatch) {
  if (!startMatch || startMatch.index === undefined) return false;
  const afterBlock = text.slice(startMatch.index + startMatch[0].length);
  const nextHeadingMatch = afterBlock.match(/^## /m);
  const blockContent = nextHeadingMatch ? afterBlock.slice(0, nextHeadingMatch.index) : afterBlock;
  return /^\s*ecosystem-health\s*:/m.test(blockContent);
}

/**
 * Replaces an existing ecosystem-health block in `text` with `snippetLines`.
 * Returns the new text (which may equal `text` if the regex matched nothing different).
 * @param {string} text
 * @param {string[]} snippetLines
 * @returns {string}
 */
function _replaceEcosystemBlock(text, snippetLines) {
  return text.replace(/^ecosystem-health:(?:\n(?!##|\S).*)*\n?/m, snippetLines.join('\n') + '\n');
}

/**
 * Inserts a new ecosystem-health snippet into `text` within the Session Config
 * section, or appends a new section when none exists.
 * @param {string} text
 * @param {RegExpMatchArray|null} startMatch
 * @param {string[]} snippetLines
 * @returns {string}
 */
function _insertEcosystemBlock(text, startMatch, snippetLines) {
  const snippet = '\n' + snippetLines.join('\n');
  if (!startMatch || startMatch.index === undefined) {
    return text + '\n## Session Config\n' + snippet + '\n';
  }
  const afterStartIdx = startMatch.index + startMatch[0].length;
  const afterBlock = text.slice(afterStartIdx);
  const nextHeadingMatch = afterBlock.match(/^## /m);
  if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
    const insertAt = afterStartIdx + nextHeadingMatch.index;
    return text.slice(0, insertAt) + snippet + '\n' + text.slice(insertAt);
  }
  return text + snippet + '\n';
}

/**
 * Builds the YAML snippet lines for an ecosystem-health block.
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]}} config
 * @returns {string[]}
 */
function _buildEcosystemSnippetLines(config) {
  const lines = ['ecosystem-health:'];
  if (config.endpoints.length > 0) {
    lines.push('  health-endpoints:');
    for (const ep of config.endpoints) {
      lines.push(`    - name: ${ep.name}`);
      lines.push(`      url: ${ep.url}`);
    }
  }
  if (config.pipelines.length > 0) {
    lines.push('  pipelines:');
    for (const pl of config.pipelines) {
      const label = pl.label ? ` # ${pl.label}` : '';
      lines.push(`    - id: ${pl.id}${label}`);
    }
  }
  if (config.criticalIssueLabels.length > 0) {
    lines.push(
      `  critical-issue-labels: [${config.criticalIssueLabels.map((l) => JSON.stringify(l)).join(', ')}]`
    );
  }
  return lines;
}

/**
 * Resolves the config file path (CLAUDE.md or AGENTS.md).
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function resolveConfigFile(repoRoot) {
  const claude = join(repoRoot, 'CLAUDE.md');
  const agents = join(repoRoot, 'AGENTS.md');
  if (existsSync(claude)) return claude;
  if (existsSync(agents)) return agents;
  return null;
}

/**
 * Reads existing ecosystem-health config from the policy JSON file.
 * Uses .orchestrator/policy/ecosystem.json as the reliable source of truth
 * (valid JSON, precisely parseable). Returns null when missing or malformed.
 *
 * @param {string} repoRoot
 * @returns {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]} | null}
 */
export function readExistingEcosystemConfig(repoRoot) {
  const policyPath = join(repoRoot, '.orchestrator', 'policy', 'ecosystem.json');
  if (!existsSync(policyPath)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(policyPath, 'utf8'));
  } catch {
    return null;
  }
  const errors = validateEcosystemPolicy(parsed);
  if (errors.length > 0) return null;
  return {
    endpoints: Array.isArray(parsed.endpoints) ? parsed.endpoints : [],
    pipelines: Array.isArray(parsed.pipelines) ? parsed.pipelines : [],
    criticalIssueLabels: Array.isArray(parsed.criticalIssueLabels) ? parsed.criticalIssueLabels : [],
  };
}

/**
 * Writes (or updates) an `ecosystem-health:` block inside Session Config.
 * When `overwrite` is true and an ecosystem-health block already exists, it is
 * replaced with the new config (diff-aware merge). When `overwrite` is false
 * and ecosystem-health already exists, the function skips (legacy behaviour).
 *
 * @param {string} configFilePath
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]}} config
 * @param {boolean} dryRun
 * @param {boolean} [overwrite=false]
 * @returns {'written' | 'skipped' | 'error'}
 */
export function writeSessionConfigBlock(configFilePath, config, dryRun, overwrite = false) {
  let text;
  try {
    text = readFileSync(configFilePath, 'utf8');
  } catch {
    return 'error';
  }

  const startMatch = text.match(/^## Session Config[ \t]*(?:\r?\n|$)/m);
  const snippetLines = _buildEcosystemSnippetLines(config);

  if (_ecosystemBlockPresent(text, startMatch)) {
    if (!overwrite) return 'skipped';
    // Replace the existing ecosystem-health block with the new snippet.
    // The block spans from "ecosystem-health:" to the next top-level key or heading.
    const newText = _replaceEcosystemBlock(text, snippetLines);
    // If text did not change after replacement (regex produced the same string), skip.
    // Also skip if the only difference is trailing whitespace on the replaced block — this
    // happens when the existing file has an equivalent but differently formatted placeholder.
    if (newText === text) return 'skipped';
    if (!dryRun) {
      try { writeFileSync(configFilePath, newText, 'utf8'); } catch { return 'error'; }
    }
    return 'written';
  }

  // Insert path: append ecosystem-health block to Session Config section
  const newText = _insertEcosystemBlock(text, startMatch, snippetLines);
  if (!dryRun) {
    try { writeFileSync(configFilePath, newText, 'utf8'); } catch { return 'error'; }
  }
  return 'written';
}

/**
 * Writes .orchestrator/policy/ecosystem.json.
 *
 * @param {string} repoRoot
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]}} config
 * @param {boolean} dryRun
 * @returns {'written' | 'skipped' | 'error'}
 */
export function writePolicyFile(repoRoot, config, dryRun) {
  const policyDir = join(repoRoot, '.orchestrator', 'policy');
  const policyPath = join(policyDir, 'ecosystem.json');

  // Idempotency: read existing — if contents are identical, skip
  if (existsSync(policyPath)) {
    try {
      const existing = JSON.parse(readFileSync(policyPath, 'utf8'));
      // Re-check if it already has the same data (simple deep-equal via JSON round-trip)
      const proposed = buildPolicyObject(config);
      if (JSON.stringify(existing) === JSON.stringify(proposed)) {
        return 'skipped';
      }
    } catch {
      // malformed existing file — overwrite
    }
  }

  const policy = buildPolicyObject(config);
  if (!dryRun) {
    try {
      mkdirSync(policyDir, { recursive: true });
      writeFileSync(policyPath, JSON.stringify(policy, null, 2) + '\n', 'utf8');
    } catch {
      return 'error';
    }
  }
  return 'written';
}

export function buildPolicyObject(config) {
  return {
    version: 1,
    rationale:
      'Ecosystem health configuration. Generated by /bootstrap --ecosystem-health. Hand-edit to add or remove endpoints.',
    endpoints: config.endpoints,
    pipelines: config.pipelines,
    criticalIssueLabels: config.criticalIssueLabels,
  };
}
