/**
 * ecosystem-wizard.mjs — #188
 * Interactive wizard that detects CI provider and package manager, prompts
 * for health endpoints / pipelines / critical-issue labels, then writes:
 *   1. A `## ecosystem-health` block in Session Config (CLAUDE.md or AGENTS.md)
 *   2. .orchestrator/policy/ecosystem.json
 *
 * Stdlib-only, no network calls, no external deps, never throws.
 * Output shape: { written: string[], skipped: string[], errors: Array<{path, reason}> }
 *
 * CLI entry: node scripts/lib/ecosystem-wizard.mjs --repo-root <path> [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detects CI provider from repo structure.
 * @param {string} repoRoot
 * @returns {'gitlab' | 'github' | 'none'}
 */
export function detectCiProvider(repoRoot) {
  if (existsSync(join(repoRoot, '.gitlab-ci.yml'))) return 'gitlab';
  if (existsSync(join(repoRoot, '.github', 'workflows'))) return 'github';
  return 'none';
}

/**
 * Detects package manager from lockfile presence.
 * @param {string} repoRoot
 * @returns {'pnpm' | 'yarn' | 'bun' | 'npm' | null}
 */
export function detectPackageManagerFromRoot(repoRoot) {
  if (existsSync(join(repoRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(repoRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(repoRoot, 'bun.lockb'))) return 'bun';
  if (existsSync(join(repoRoot, 'package-lock.json'))) return 'npm';
  return null;
}

/**
 * Reads package.json scripts to surface script names (informational).
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function readPackageScripts(repoRoot) {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return Object.keys(pkg.scripts || {});
  } catch {
    return [];
  }
}

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

function buildPolicyObject(config) {
  return {
    version: 1,
    rationale:
      'Ecosystem health configuration. Generated by /bootstrap --ecosystem-health. Hand-edit to add or remove endpoints.',
    endpoints: config.endpoints,
    pipelines: config.pipelines,
    criticalIssueLabels: config.criticalIssueLabels,
  };
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

/**
 * Parses a comma-separated string into a trimmed array, filtering empty items.
 * @param {string} input
 * @returns {string[]}
 */
export function parseCommaSeparated(input) {
  return input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parses endpoint input lines. Format: "Name|URL" per entry, separated by commas.
 * @param {string} input
 * @returns {Array<{name: string, url: string}>}
 */
export function parseEndpoints(input) {
  return parseCommaSeparated(input)
    .map((entry) => {
      const pipe = entry.indexOf('|');
      if (pipe === -1) return null;
      const name = entry.slice(0, pipe).trim();
      const url = entry.slice(pipe + 1).trim();
      if (!name || !url) return null;
      return { name, url };
    })
    .filter(Boolean);
}

/**
 * Parses pipeline input lines. Format: "id" or "id:label" per entry.
 * @param {string} input
 * @returns {Array<{id: string, label?: string}>}
 */
export function parsePipelines(input) {
  return parseCommaSeparated(input)
    .map((entry) => {
      const colon = entry.indexOf(':');
      if (colon === -1) {
        return entry.trim() ? { id: entry.trim() } : null;
      }
      const id = entry.slice(0, colon).trim();
      const label = entry.slice(colon + 1).trim();
      if (!id) return null;
      return label ? { id, label } : { id };
    })
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main wizard — helpers
// ---------------------------------------------------------------------------

/**
 * Serialises an existing ecosystem config into display strings suitable for
 * interactive prompts or blank-answer fallback.
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]} | null} existingConfig
 * @returns {{currentEndpoints: string, currentPipelines: string, currentLabels: string}}
 */
function _serializeCurrentValues(existingConfig) {
  if (!existingConfig) {
    return { currentEndpoints: '', currentPipelines: '', currentLabels: '' };
  }
  const currentEndpoints = existingConfig.endpoints.map((ep) => `${ep.name}|${ep.url}`).join(', ');
  const currentPipelines = existingConfig.pipelines
    .map((pl) => (pl.label ? `${pl.id}:${pl.label}` : pl.id))
    .join(', ');
  const currentLabels = existingConfig.criticalIssueLabels.join(', ');
  return { currentEndpoints, currentPipelines, currentLabels };
}

/**
 * Prompts the user interactively and returns the raw answer strings.
 * Blank answers are pre-filled from existing values when a config is present.
 *
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]} | null} existingConfig
 * @param {string} ciProvider
 * @param {string|null} packageManager
 * @returns {Promise<{endpointsRaw: string, pipelinesRaw: string, labelsRaw: string}>}
 */
async function _promptInteractiveAnswers(existingConfig, ciProvider, packageManager) {
  const { currentEndpoints, currentPipelines, currentLabels } = _serializeCurrentValues(existingConfig);

  process.stdout.write(
    `\nEcosystem-Health Wizard\n` +
      `Detected: CI=${ciProvider}, package-manager=${packageManager ?? 'none'}\n` +
      (existingConfig ? '(Existing config found — press Enter to keep current values)\n' : '') +
      '\n'
  );

  const endpointPrompt = currentEndpoints
    ? `Health endpoints [current: ${currentEndpoints}]:\n> `
    : `Health endpoints (format "Name|URL", comma-separated, blank to skip):\n> `;
  const pipelinePrompt = currentPipelines
    ? `CI pipeline identifiers [current: ${currentPipelines}]:\n> `
    : `CI pipeline identifiers (format "id" or "id:label", comma-separated, blank to skip):\n> `;
  const labelsPrompt = currentLabels
    ? `Critical issue labels [current: ${currentLabels}]:\n> `
    : `Critical issue labels (comma-separated, e.g. "priority:critical,severity:blocker", blank to skip):\n> `;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  let endpointsRaw = await ask(endpointPrompt);
  let pipelinesRaw = await ask(pipelinePrompt);
  let labelsRaw = await ask(labelsPrompt);
  rl.close();

  // When user presses Enter (blank) in interactive mode, keep current value.
  if (existingConfig) {
    if (endpointsRaw.trim() === '') endpointsRaw = currentEndpoints;
    if (pipelinesRaw.trim() === '') pipelinesRaw = currentPipelines;
    if (labelsRaw.trim() === '') labelsRaw = currentLabels;
  }

  return { endpointsRaw, pipelinesRaw, labelsRaw };
}

/**
 * Resolves the final config by parsing raw answer strings and falling back
 * to existing values for any field that produced an empty result.
 *
 * AC-3: Empty answer strings use existing values; non-empty answers override.
 *
 * @param {{endpointsRaw: string, pipelinesRaw: string, labelsRaw: string}} raws
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]} | null} existingConfig
 * @returns {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]}}
 */
function _mergeAnswersWithExisting({ endpointsRaw, pipelinesRaw, labelsRaw }, existingConfig) {
  let endpoints = parseEndpoints(endpointsRaw);
  let pipelines = parsePipelines(pipelinesRaw);
  let criticalIssueLabels = parseCommaSeparated(labelsRaw);

  if (existingConfig) {
    // Only fall back to existing when the new answer produced nothing (blank input).
    if (endpoints.length === 0 && endpointsRaw.trim() === '') endpoints = existingConfig.endpoints;
    if (pipelines.length === 0 && pipelinesRaw.trim() === '') pipelines = existingConfig.pipelines;
    if (criticalIssueLabels.length === 0 && labelsRaw.trim() === '') {
      criticalIssueLabels = existingConfig.criticalIssueLabels;
    }
  }

  return { endpoints, pipelines, criticalIssueLabels };
}

/**
 * Records a write-result ('written'|'skipped'|'error') into `result`.
 * @param {{written: string[], skipped: string[], errors: Array<{path:string,reason:string}>}} result
 * @param {'written'|'skipped'|'error'} outcome
 * @param {string} filePath
 * @param {string} errorReason
 */
function _recordWriteResult(result, outcome, filePath, errorReason) {
  if (outcome === 'written') result.written.push(filePath);
  else if (outcome === 'skipped') result.skipped.push(filePath);
  else result.errors.push({ path: filePath, reason: errorReason });
}

/**
 * Writes the policy JSON and Session Config block; records results.
 * Separated from runEcosystemWizard to keep that function under 60 lines.
 *
 * @param {string} repoRoot
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]}} config
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]} | null} existingConfig
 * @param {boolean} dryRun
 * @param {{written: string[], skipped: string[], errors: Array<{path:string,reason:string}>}} result
 */
function _writeArtifacts(repoRoot, config, existingConfig, dryRun, result) {
  // Write policy file (writePolicyFile handles its own idempotency via JSON diff)
  const policyPath = join(repoRoot, '.orchestrator', 'policy', 'ecosystem.json');
  _recordWriteResult(result, writePolicyFile(repoRoot, config, dryRun), policyPath, 'failed to write policy file');

  // Write Session Config block.
  // Pass overwrite=true only when the config has actually changed relative to existing —
  // this prevents unnecessary rewrites (and format normalization) on idempotent re-runs.
  const configChanged =
    existingConfig !== null &&
    JSON.stringify(buildPolicyObject(existingConfig)) !== JSON.stringify(buildPolicyObject(config));
  const configFile = resolveConfigFile(repoRoot);
  if (configFile) {
    _recordWriteResult(
      result,
      writeSessionConfigBlock(configFile, config, dryRun, configChanged),
      configFile,
      'failed to write Session Config block'
    );
  }
}

// ---------------------------------------------------------------------------
// Main wizard
// ---------------------------------------------------------------------------

/**
 * Runs the ecosystem-health wizard.
 *
 * @param {{
 *   repoRoot: string,
 *   answers?: {
 *     endpoints: string,
 *     pipelines: string,
 *     criticalIssueLabels: string,
 *   },
 *   dryRun?: boolean,
 * }} opts
 * @returns {Promise<{
 *   written: string[],
 *   skipped: string[],
 *   errors: Array<{path: string, reason: string}>,
 *   detection: {ciProvider: string, packageManager: string|null, scripts: string[]},
 * }>}
 */
export async function runEcosystemWizard({ repoRoot, answers, dryRun = false } = {}) {
  const result = { written: [], skipped: [], errors: [] };

  if (!repoRoot) {
    result.errors.push({ path: '', reason: 'repoRoot is required' });
    return result;
  }

  // Detection phase
  const ciProvider = detectCiProvider(repoRoot);
  const packageManager = detectPackageManagerFromRoot(repoRoot);
  const scripts = readPackageScripts(repoRoot);
  result.detection = { ciProvider, packageManager, scripts };

  // AC-1: Read existing config on startup.
  // Missing or malformed policy → existingConfig is null → fresh-run mode.
  const existingConfig = readExistingEcosystemConfig(repoRoot);
  result.existingConfig = existingConfig; // expose for callers / tests

  // Collect raw answers (injected for tests, or prompted interactively)
  let raws;
  if (answers) {
    // AC-2: programmatic path — empty string means "keep existing value"
    raws = {
      endpointsRaw: answers.endpoints ?? '',
      pipelinesRaw: answers.pipelines ?? '',
      labelsRaw: answers.criticalIssueLabels ?? '',
    };
  } else {
    raws = await _promptInteractiveAnswers(existingConfig, ciProvider, packageManager);
  }

  // AC-3: Merge raw answers with existing config
  const config = _mergeAnswersWithExisting(raws, existingConfig);

  // Validate
  const validationErrors = validateEcosystemPolicy(buildPolicyObject(config));
  if (validationErrors.length > 0) {
    for (const e of validationErrors) result.errors.push({ path: 'ecosystem.json', reason: e });
    return result;
  }

  // Write artifacts (policy JSON + Session Config block)
  _writeArtifacts(repoRoot, config, existingConfig, dryRun, result);

  // Print summary (interactive mode only)
  if (!answers) {
    process.stdout.write('\nEcosystem-Health Wizard complete.\n');
    if (result.written.length) process.stdout.write(`Written: ${result.written.join(', ')}\n`);
    if (result.skipped.length) process.stdout.write(`Skipped (already present): ${result.skipped.join(', ')}\n`);
    if (result.errors.length)
      process.stdout.write(`Errors: ${result.errors.map((e) => `${e.path}: ${e.reason}`).join(', ')}\n`);
    process.stdout.write(`\nReview changes with: git status && git diff\n`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith('ecosystem-wizard.mjs')) {
  const args = process.argv.slice(2);
  const repoRootIdx = args.indexOf('--repo-root');
  const dryRun = args.includes('--dry-run');
  const repoRoot = repoRootIdx !== -1 ? args[repoRootIdx + 1] : process.cwd();

  runEcosystemWizard({ repoRoot, dryRun })
    .then((result) => {
      if (result.errors.length > 0) process.exit(1);
    })
    .catch((err) => {
      process.stderr.write(`ecosystem-wizard: ${err.message}\n`);
      process.exit(1);
    });
}
