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

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  createInterface,
} from 'node:fs';
import { join } from 'node:path';
import { createInterface as rlCreateInterface } from 'node:readline';

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
  const endpoints = policy['endpoints'];
  if (endpoints !== undefined) {
    if (!Array.isArray(endpoints)) {
      errors.push('endpoints must be an array');
    } else {
      for (let i = 0; i < endpoints.length; i++) {
        const ep = endpoints[i];
        if (ep === null || typeof ep !== 'object' || Array.isArray(ep)) {
          errors.push(`endpoints[${i}] must be a plain object`);
          continue;
        }
        if (typeof ep['name'] !== 'string' || ep['name'].trim() === '') {
          errors.push(`endpoints[${i}].name must be a non-empty string`);
        }
        if (typeof ep['url'] !== 'string' || ep['url'].trim() === '') {
          errors.push(`endpoints[${i}].url must be a non-empty string`);
        }
      }
    }
  }
  const pipelines = policy['pipelines'];
  if (pipelines !== undefined) {
    if (!Array.isArray(pipelines)) {
      errors.push('pipelines must be an array');
    } else {
      for (let i = 0; i < pipelines.length; i++) {
        const pl = pipelines[i];
        if (pl === null || typeof pl !== 'object' || Array.isArray(pl)) {
          errors.push(`pipelines[${i}] must be a plain object`);
          continue;
        }
        if (typeof pl['id'] !== 'string' || pl['id'].trim() === '') {
          errors.push(`pipelines[${i}].id must be a non-empty string`);
        }
      }
    }
  }
  const labels = policy['criticalIssueLabels'];
  if (labels !== undefined) {
    if (!Array.isArray(labels)) {
      errors.push('criticalIssueLabels must be an array');
    } else {
      for (let i = 0; i < labels.length; i++) {
        if (typeof labels[i] !== 'string' || labels[i].trim() === '') {
          errors.push(`criticalIssueLabels[${i}] must be a non-empty string`);
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Session Config reader/writer
// ---------------------------------------------------------------------------

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
 * Reads existing ecosystem-health config from Session Config block.
 * Returns null when not found.
 *
 * @param {string} configFilePath
 * @returns {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]} | null}
 */
export function readExistingEcosystemConfig(configFilePath) {
  if (!existsSync(configFilePath)) return null;
  let text;
  try {
    text = readFileSync(configFilePath, 'utf8');
  } catch {
    return null;
  }

  // Find the Session Config section
  const startMatch = text.match(/^## Session Config[ \t]*(?:\r?\n|$)/m);
  if (!startMatch || startMatch.index === undefined) return null;
  const afterBlock = text.slice(startMatch.index + startMatch[0].length);
  const nextHeadingMatch = afterBlock.match(/^## /m);
  const blockContent = nextHeadingMatch
    ? afterBlock.slice(0, nextHeadingMatch.index)
    : afterBlock;

  // Check for ecosystem-health: key in block
  if (!/^\s*ecosystem-health\s*:/m.test(blockContent)) return null;

  // Best-effort parse — we can't rely on full YAML here, just detect presence
  return { endpoints: [], pipelines: [], criticalIssueLabels: [] };
}

/**
 * Writes (or updates) an `ecosystem-health:` block inside Session Config.
 * If an `ecosystem-health:` key already exists, the function leaves it
 * unchanged (idempotent — caller controls re-write by checking first).
 *
 * @param {string} configFilePath
 * @param {{endpoints: object[], pipelines: object[], criticalIssueLabels: string[]}} config
 * @param {boolean} dryRun
 * @returns {'written' | 'skipped' | 'error'}
 */
export function writeSessionConfigBlock(configFilePath, config, dryRun) {
  let text;
  try {
    text = readFileSync(configFilePath, 'utf8');
  } catch {
    return 'error';
  }

  // Idempotency: if ecosystem-health already present in Session Config, skip
  const startMatch = text.match(/^## Session Config[ \t]*(?:\r?\n|$)/m);
  if (startMatch && startMatch.index !== undefined) {
    const afterBlock = text.slice(startMatch.index + startMatch[0].length);
    const nextHeadingMatch = afterBlock.match(/^## /m);
    const blockContent = nextHeadingMatch
      ? afterBlock.slice(0, nextHeadingMatch.index)
      : afterBlock;
    if (/^\s*ecosystem-health\s*:/m.test(blockContent)) {
      return 'skipped';
    }
  }

  // Build the YAML snippet to append
  const lines = ['', 'ecosystem-health:'];
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
    lines.push(`  critical-issue-labels: [${config.criticalIssueLabels.map((l) => JSON.stringify(l)).join(', ')}]`);
  }
  const snippet = lines.join('\n');

  // Append to Session Config section (before next ## heading)
  let newText;
  if (startMatch && startMatch.index !== undefined) {
    const afterStartIdx = startMatch.index + startMatch[0].length;
    const afterBlock = text.slice(afterStartIdx);
    const nextHeadingMatch = afterBlock.match(/^## /m);
    if (nextHeadingMatch && nextHeadingMatch.index !== undefined) {
      const insertAt = afterStartIdx + nextHeadingMatch.index;
      newText = text.slice(0, insertAt) + snippet + '\n' + text.slice(insertAt);
    } else {
      newText = text + snippet + '\n';
    }
  } else {
    // No Session Config section found — append one
    newText = text + '\n## Session Config\n' + snippet + '\n';
  }

  if (!dryRun) {
    try {
      writeFileSync(configFilePath, newText, 'utf8');
    } catch {
      return 'error';
    }
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

  // Collect answers (injected for tests, or prompted interactively)
  let endpointsRaw, pipelinesRaw, labelsRaw;

  if (answers) {
    endpointsRaw = answers.endpoints ?? '';
    pipelinesRaw = answers.pipelines ?? '';
    labelsRaw = answers.criticalIssueLabels ?? '';
  } else {
    const rl = rlCreateInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

    process.stdout.write(
      `\nEcosystem-Health Wizard\n` +
        `Detected: CI=${ciProvider}, package-manager=${packageManager ?? 'none'}\n\n`
    );

    endpointsRaw = await ask(
      `Health endpoints (format "Name|URL", comma-separated, blank to skip):\n> `
    );
    pipelinesRaw = await ask(
      `CI pipeline identifiers (format "id" or "id:label", comma-separated, blank to skip):\n> `
    );
    labelsRaw = await ask(
      `Critical issue labels (comma-separated, e.g. "priority:critical,severity:blocker", blank to skip):\n> `
    );

    rl.close();
  }

  const endpoints = parseEndpoints(endpointsRaw);
  const pipelines = parsePipelines(pipelinesRaw);
  const criticalIssueLabels = parseCommaSeparated(labelsRaw);

  const config = { endpoints, pipelines, criticalIssueLabels };

  // Validate
  const policy = buildPolicyObject(config);
  const validationErrors = validateEcosystemPolicy(policy);
  if (validationErrors.length > 0) {
    for (const e of validationErrors) {
      result.errors.push({ path: 'ecosystem.json', reason: e });
    }
    return result;
  }

  // Write policy file
  const policyPath = join(repoRoot, '.orchestrator', 'policy', 'ecosystem.json');
  const policyResult = writePolicyFile(repoRoot, config, dryRun);
  if (policyResult === 'written') result.written.push(policyPath);
  else if (policyResult === 'skipped') result.skipped.push(policyPath);
  else result.errors.push({ path: policyPath, reason: 'failed to write policy file' });

  // Write Session Config block
  const configFile = resolveConfigFile(repoRoot);
  if (configFile) {
    const configResult = writeSessionConfigBlock(configFile, config, dryRun);
    if (configResult === 'written') result.written.push(configFile);
    else if (configResult === 'skipped') result.skipped.push(configFile);
    else result.errors.push({ path: configFile, reason: 'failed to write Session Config block' });
  }

  // Print summary
  if (!answers) {
    process.stdout.write('\nEcosystem-Health Wizard complete.\n');
    if (result.written.length) process.stdout.write(`Written: ${result.written.join(', ')}\n`);
    if (result.skipped.length) process.stdout.write(`Skipped (already present): ${result.skipped.join(', ')}\n`);
    if (result.errors.length) process.stdout.write(`Errors: ${result.errors.map((e) => `${e.path}: ${e.reason}`).join(', ')}\n`);
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
