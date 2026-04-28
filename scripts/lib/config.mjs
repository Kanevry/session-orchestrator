/**
 * config.mjs — Session Config reader for CLAUDE.md / AGENTS.md.
 *
 * Thin orchestrator. All parsing logic lives in scripts/lib/config/:
 *   coercers.mjs          — value coercion helpers (_coerceString, _coerceInteger, …)
 *   section-extractor.mjs — _extractConfigSection + _parseKV
 *   vault-sync.mjs        — _parseVaultSync
 *   drift-check.mjs       — _parseDriftCheck
 *   docs-orchestrator.mjs — _parseDocsOrchestrator
 *   vault-staleness.mjs   — _parseVaultStaleness
 *   events-rotation.mjs   — _parseEventsRotation
 *   vault-integration.mjs — _parseVaultIntegration + _parseResourceThresholds
 *
 * Originally ported from parse-config.sh (v2) plus its helper libs
 * config-yaml-parser.sh and config-json-coercion.sh. Windows + CRLF safe.
 *
 * Part of v3.0.0 migration (Epic #124, issue #132).
 * Split into per-section parsers: issue #284.
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

// Per-section parsers and coercers
import {
  _getVal,
  _coerceString,
  _coerceInteger,
  _coerceFloat,
  _coerceBoolean,
  _coerceList,
  _coerceEnum,
  _coerceObject,
  _coerceBoolObject,
  _coerceMaxTurns,
} from './config/coercers.mjs';

import { _extractConfigSection, _parseKV } from './config/section-extractor.mjs';
import { _parseVaultSync } from './config/vault-sync.mjs';
import { _parseDriftCheck } from './config/drift-check.mjs';
import { _parseDocsOrchestrator } from './config/docs-orchestrator.mjs';
import { _parseVaultStaleness } from './config/vault-staleness.mjs';
import { _parseEventsRotation } from './config/events-rotation.mjs';
import { _parseVaultIntegration, _parseResourceThresholds } from './config/vault-integration.mjs';

// Re-export the two functions that external callers import directly from this module.
export { _coerceEnum, _coerceCollisionRisk } from './config/coercers.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read CLAUDE.md or AGENTS.md from the project root.
 * Precedence: if AGENTS.md exists AND env var SO_PLATFORM === "codex", prefer AGENTS.md.
 * Otherwise CLAUDE.md. Throws if neither file found.
 * @param {string} projectRoot — absolute path to project root
 * @returns {Promise<string>} file contents as string (CRLF-tolerant)
 */
export async function readConfigFile(projectRoot) {
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  const agentsMd = join(projectRoot, 'AGENTS.md');

  const isCodex = process.env.SO_PLATFORM === 'codex';

  if (isCodex) {
    // Prefer AGENTS.md for Codex platform
    try {
      await access(agentsMd);
      return await readFile(agentsMd, 'utf8');
    } catch {
      // Fall through to CLAUDE.md
    }
  }

  try {
    await access(claudeMd);
    return await readFile(claudeMd, 'utf8');
  } catch {
    // Try AGENTS.md as fallback (non-Codex)
  }

  try {
    await access(agentsMd);
    return await readFile(agentsMd, 'utf8');
  } catch {
    // Neither found
  }

  throw new Error(`config.mjs: neither CLAUDE.md nor AGENTS.md found in '${projectRoot}'`);
}

/**
 * Parse ## Session Config block from markdown content.
 * Applies all defaults for missing keys.
 * @param {string} mdContent — full CLAUDE.md content
 * @returns {object} config object with EXACT same shape as parse-config.sh stdout
 * @throws if any enum value is invalid
 */
export function parseSessionConfig(mdContent) {
  const sectionLines = _extractConfigSection(mdContent);
  const kv = _parseKV(sectionLines);

  // String fields
  const vcs = _coerceString(kv, 'vcs', undefined);
  const gitlabHost = _coerceString(kv, 'gitlab-host', undefined);
  const mirror = _coerceString(kv, 'mirror', undefined);
  const special = _coerceString(kv, 'special', undefined);
  const pencil = _coerceString(kv, 'pencil', undefined);
  const testCommand = _coerceString(kv, 'test-command', 'pnpm test --run');
  const typecheckCommand = _coerceString(kv, 'typecheck-command', 'tsgo --noEmit');
  const lintCommand = _coerceString(kv, 'lint-command', 'pnpm lint');
  const baselineRef = _coerceString(kv, 'baseline-ref', undefined);
  const baselineProjectId = _coerceString(kv, 'baseline-project-id', undefined);
  const planBaselinePath = _coerceString(kv, 'plan-baseline-path', undefined);
  const planDefaultVisibility = _coerceString(kv, 'plan-default-visibility', 'internal');
  const planPrdLocation = _coerceString(kv, 'plan-prd-location', 'docs/prd/');
  const planRetroLocation = _coerceString(kv, 'plan-retro-location', 'docs/retro/');

  // Integer fields
  const agentsPerWave = _coerceInteger(kv, 'agents-per-wave', 6);
  const waves = _coerceInteger(kv, 'waves', 5);
  const recentCommits = _coerceInteger(kv, 'recent-commits', 20);
  const issueLimit = _coerceInteger(kv, 'issue-limit', 50);
  const staleBranchDays = _coerceInteger(kv, 'stale-branch-days', 7);
  const staleIssueDays = _coerceInteger(kv, 'stale-issue-days', 30);
  const ssotFreshnessDays = _coerceInteger(kv, 'ssot-freshness-days', 5);
  const pluginFreshnessDays = _coerceInteger(kv, 'plugin-freshness-days', 30);
  const memoryCleanupThreshold = _coerceInteger(kv, 'memory-cleanup-threshold', 5);
  const learningExpiryDays = _coerceInteger(kv, 'learning-expiry-days', 30);
  const learningsSurfaceTopN = _coerceInteger(kv, 'learnings-surface-top-n', 15);
  const groundingInjectionMaxFiles = _coerceInteger(kv, 'grounding-injection-max-files', 3);
  const discoveryConfidenceThreshold = _coerceInteger(kv, 'discovery-confidence-threshold', 60);
  // discovery-parallelism: bounded 1..16, silent fallback to default 5 (matches events-rotation pattern)
  const discoveryParallelism = (() => {
    const raw = _getVal(kv, 'discovery-parallelism', '5');
    if (!/^\d+$/.test(raw)) return 5;
    const n = parseInt(raw, 10);
    if (n < 1 || n > 16) return 5;
    return n;
  })();

  // Float fields
  const learningDecayRate = _coerceFloat(kv, 'learning-decay-rate', 0.05, 0.0, 1.0);

  // Boolean fields
  const persistence = _coerceBoolean(kv, 'persistence', true);
  const ecosystemHealth = _coerceBoolean(kv, 'ecosystem-health', false);
  const discoveryOnClose = _coerceBoolean(kv, 'discovery-on-close', false);
  const reasoningOutput = _coerceBoolean(kv, 'reasoning-output', false);
  const groundingCheck = _coerceBoolean(kv, 'grounding-check', true);
  const allowDestructiveOps = _coerceBoolean(kv, 'allow-destructive-ops', false);
  const resourceAwareness = _coerceBoolean(kv, 'resource-awareness', true);
  const enableHostBanner = _coerceBoolean(kv, 'enable-host-banner', true);

  // List fields
  const crossRepos = _coerceList(kv, 'cross-repos', undefined);
  const ssotFiles = _coerceList(kv, 'ssot-files', undefined);
  const discoveryProbes = _coerceList(kv, 'discovery-probes', '[all]');
  const discoveryExcludePaths = _coerceList(kv, 'discovery-exclude-paths', '[]');
  const healthEndpoints = _coerceList(kv, 'health-endpoints', undefined);
  const worktreeExclude = _coerceList(
    kv,
    'worktree-exclude',
    '[node_modules, dist, build, .next, .nuxt, coverage, .cache, .turbo, .vercel, out]'
  );

  // Enum fields
  const enforcement = _coerceEnum(kv, 'enforcement', 'warn', ['strict', 'warn', 'off']);
  const isolation = _coerceEnum(kv, 'isolation', 'auto', ['worktree', 'none', 'auto']);
  const discoverySeverityThreshold = _coerceEnum(kv, 'discovery-severity-threshold', 'low', ['critical', 'high', 'medium', 'low']);

  // Object fields
  const agentMapping = _coerceObject(kv, 'agent-mapping');
  if (agentMapping !== null) {
    // Validate role keys against canonical list from skills/_shared/config-reading.md
    const ALLOWED_ROLES = ['impl', 'test', 'db', 'ui', 'security', 'compliance', 'docs', 'perf'];
    const invalidKeys = [];
    for (const [k, v] of Object.entries(agentMapping)) {
      if (!ALLOWED_ROLES.includes(k)) {
        invalidKeys.push(k);
        continue;
      }
      if (typeof v !== 'string' || v === '') {
        throw new Error(
          `config.mjs: agent-mapping role '${k}' has invalid value '${v}' (expected non-empty string)`
        );
      }
    }
    if (invalidKeys.length > 0) {
      throw new Error(
        `config.mjs: agent-mapping contains invalid role key(s): ${invalidKeys.join(', ')} ` +
          `(allowed: ${ALLOWED_ROLES.join(', ')})`
      );
    }
  }
  const enforcementGates = _coerceBoolObject(kv, 'enforcement-gates');

  // Special field
  const maxTurns = _coerceMaxTurns(kv);

  // vault-integration sub-keys
  const vaultIntegration = _parseVaultIntegration(kv);

  // resource-thresholds sub-keys (v3.1.0 env-aware — issue #166)
  const resourceThresholds = _parseResourceThresholds(kv);

  // vault-sync: parsed from full content (can live outside Session Config)
  const vaultSync = _parseVaultSync(mdContent);

  // drift-check: parsed from full content (standalone top-level block)
  const driftCheck = _parseDriftCheck(mdContent);

  // docs-orchestrator: parsed from full content (standalone top-level block)
  const docsOrchestrator = _parseDocsOrchestrator(mdContent);

  // vault-staleness: parsed from full content (standalone top-level block)
  const vaultStaleness = _parseVaultStaleness(mdContent);

  // events-rotation: parsed from full content (standalone top-level block)
  const eventsRotation = _parseEventsRotation(mdContent);

  return {
    'agents-per-wave': agentsPerWave,
    'waves': waves,
    'recent-commits': recentCommits,
    'special': special,
    'vcs': vcs,
    'gitlab-host': gitlabHost,
    'mirror': mirror,
    'cross-repos': crossRepos,
    'pencil': pencil,
    'ecosystem-health': ecosystemHealth,
    'health-endpoints': healthEndpoints,
    'issue-limit': issueLimit,
    'stale-branch-days': staleBranchDays,
    'stale-issue-days': staleIssueDays,
    'test-command': testCommand,
    'typecheck-command': typecheckCommand,
    'lint-command': lintCommand,
    'ssot-files': ssotFiles,
    'ssot-freshness-days': ssotFreshnessDays,
    'plugin-freshness-days': pluginFreshnessDays,
    'discovery-on-close': discoveryOnClose,
    'discovery-probes': discoveryProbes,
    'discovery-exclude-paths': discoveryExcludePaths,
    'discovery-severity-threshold': discoverySeverityThreshold,
    'discovery-confidence-threshold': discoveryConfidenceThreshold,
    'discovery-parallelism': discoveryParallelism,
    'persistence': persistence,
    'memory-cleanup-threshold': memoryCleanupThreshold,
    'learning-expiry-days': learningExpiryDays,
    'learnings-surface-top-n': learningsSurfaceTopN,
    'learning-decay-rate': learningDecayRate,
    'enforcement': enforcement,
    'isolation': isolation,
    'max-turns': maxTurns,
    'baseline-ref': baselineRef,
    'baseline-project-id': baselineProjectId,
    'plan-baseline-path': planBaselinePath,
    'plan-default-visibility': planDefaultVisibility,
    'plan-prd-location': planPrdLocation,
    'plan-retro-location': planRetroLocation,
    'agent-mapping': agentMapping,
    'enforcement-gates': enforcementGates,
    'reasoning-output': reasoningOutput,
    'grounding-injection-max-files': groundingInjectionMaxFiles,
    'grounding-check': groundingCheck,
    'allow-destructive-ops': allowDestructiveOps,
    'resource-awareness': resourceAwareness,
    'enable-host-banner': enableHostBanner,
    'resource-thresholds': resourceThresholds,
    'worktree-exclude': worktreeExclude,
    'vault-integration': vaultIntegration,
    'vault-sync': vaultSync,
    'drift-check': driftCheck,
    'docs-orchestrator': docsOrchestrator,
    'vault-staleness': vaultStaleness,
    'events-rotation': eventsRotation,
  };
}

/**
 * Lookup a config value, falling back to default.
 * @param {object} config — result of parseSessionConfig
 * @param {string} key — key name (e.g., "agents-per-wave")
 * @param {*} defaultValue — fallback if key missing or null
 * @returns {*} the config value or defaultValue
 */
export function getConfigValue(config, key, defaultValue = null) {
  const val = config[key];
  if (val === undefined || val === null) return defaultValue;
  return val;
}
