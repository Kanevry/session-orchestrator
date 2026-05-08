/**
 * wizard-prompt.mjs — interactive wizard orchestration for ecosystem-health setup.
 * Prompts the user, merges answers with existing config, and writes artifacts.
 *
 * Cross-imports (allowed per #325 split plan):
 *   - config-writer.mjs: buildPolicyObject, writePolicyFile, resolveConfigFile,
 *                        writeSessionConfigBlock, readExistingEcosystemConfig,
 *                        validateEcosystemPolicy
 *   - config-parser.mjs: parseEndpoints, parsePipelines, parseCommaSeparated
 */

import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  buildPolicyObject,
  writePolicyFile,
  resolveConfigFile,
  writeSessionConfigBlock,
  readExistingEcosystemConfig,
  validateEcosystemPolicy,
} from './config-writer.mjs';
import { parseEndpoints, parsePipelines, parseCommaSeparated } from './config-parser.mjs';
import { detectCiProvider } from './ci-detector.mjs';
import { detectPackageManagerFromRoot, readPackageScripts } from './package-manager-detector.mjs';

// ---------------------------------------------------------------------------
// Private helpers
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
