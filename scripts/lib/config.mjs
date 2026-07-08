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
import { _parseDocsStaleness } from './config/docs-staleness.mjs';
import { _parseEventsRotation } from './config/events-rotation.mjs';
import { _parseVaultIntegration, _parseResourceThresholds } from './config/vault-integration.mjs';
import { _parseTest } from './config/test.mjs';
import { _parseGitlabPortfolio } from './config/gitlab-portfolio.mjs';
import { _parseWaveReviewers } from './config/wave-reviewers.mjs';
import { _parseCrossRepo } from './config/cross-repo.mjs';
import { _parsePersonaGateWave } from './config/persona-gate-wave.mjs';
import { _parseVaultMirrorQuality } from './config/vault-mirror-quality.mjs';
import { _parseColdStart } from './config/cold-start.mjs';
import { _parseAutoDream } from './config/auto-dream.mjs';
import { _parseStateMdLock } from './config/state-md-lock.mjs';
import { _parseHandoverGate } from './config/handover-gate.mjs';
import { _parseSlopcheck } from './config/slopcheck.mjs';
import { _parseDiscoveryValidator } from './config/discovery-validator.mjs';
import { _parseTemplatesFirst } from './config/templates-first.mjs';
import { _parseVerificationAutoFix } from './config/verification-auto-fix.mjs';
import { _parseDialectic } from './config/dialectic.mjs';
import { _parseMemory } from './config/memory.mjs';
import { _parseReconcile } from './config/reconcile.mjs';
import { _parseCustomPhases } from './config/custom-phases.mjs';
import { _parseEvolve, _parseEvolveDecay } from './config/evolve.mjs';
import { _parseSkillEvolution } from './config/skill-evolution.mjs';
import { _parseDispatcherAutonomy, resolveDispatcherAutonomy } from './config/dispatcher-autonomy.mjs';
import { loadHostPaths, resolveHostPath } from './config/host-paths.mjs';

// Re-export the two functions that external callers import directly from this module.
export { _coerceEnum, _coerceCollisionRisk } from './config/coercers.mjs';

// readConfigFile lives in the dependency-free leaf config/io.mjs so that
// config/cross-repo.mjs (and other parsers) can import it without forming a
// cycle back through config.mjs (issue #664). Re-exported here unchanged for
// back-compat — every existing `import { readConfigFile } from '.../config.mjs'`
// caller keeps working.
//
// ORCHESTRATOR-LEVEL CALLERS ONLY — config sub-parsers MUST import from
// ./config/io.mjs directly to avoid re-forming the import cycle that #664
// broke. Any *.mjs under scripts/lib/config/ that imports from '../config.mjs'
// is a cycle regression (see tests/lib/config/cycle-guard.test.mjs).
export { readConfigFile } from './config/io.mjs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse ## Session Config block from markdown content.
 * Applies all defaults for missing keys.
 * @param {string} mdContent — full CLAUDE.md content
 * @param {{ hostPaths?: { env?: Record<string, string|undefined>, ownerConfig?: object } }} [opts]
 *   — `hostPaths` injects the host-local resolution context (issue #653). Tests MUST pass a
 *   hermetic ctx (e.g. `{ env: {}, ownerConfig: undefined }`) when asserting COMMITTED values:
 *   the default reads the real `owner.yaml`, so a host-local `paths:` override would otherwise
 *   bleed into fixture assertions (incident: 2026-07-03 Full-Gate red after the operator set
 *   `paths.baseline-path` host-locally).
 * @returns {object} config object with EXACT same shape as parse-config.sh stdout
 * @throws if any enum value is invalid
 */
export function parseSessionConfig(mdContent, { hostPaths } = {}) {
  const sectionLines = _extractConfigSection(mdContent);
  const kv = _parseKV(sectionLines);

  // Host-local path resolution context (issue #653): env-var > owner.yaml paths[key] >
  // committed default. Loaded once so vault-dir + baseline-path resolve without
  // re-reading disk. Applied AFTER sub-parsers run (see vault-integration/vault-sync
  // overrides below) to keep the parsers pure for claude-md-drift-check's raw-value parity.
  const hostCtx = hostPaths ?? loadHostPaths();

  // String fields
  const vcs = _coerceString(kv, 'vcs', undefined);
  const gitlabHost = _coerceString(kv, 'gitlab-host', undefined);
  const mirror = _coerceString(kv, 'mirror', undefined);
  const special = _coerceString(kv, 'special', undefined);
  const pencil = _coerceString(kv, 'pencil', undefined);
  const testCommand = _coerceString(kv, 'test-command', 'npm test');
  const typecheckCommand = _coerceString(kv, 'typecheck-command', 'npm run typecheck');
  const lintCommand = _coerceString(kv, 'lint-command', 'npm run lint');
  const baselineRef = _coerceString(kv, 'baseline-ref', undefined);
  const baselineProjectId = _coerceString(kv, 'baseline-project-id', undefined);
  const planBaselinePath = resolveHostPath(
    'baseline-path',
    _coerceString(kv, 'plan-baseline-path', undefined),
    hostCtx
  );
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
  const memoryCleanupSoftLimit = _coerceInteger(kv, 'memory-cleanup-soft-limit', 180);
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

  // vault-integration: parsed from full content (block-scoped, avoids the
  // pre-#593 KV-name collision where `enabled:` was shared with 15+ other
  // blocks like docs-orchestrator/vault-staleness/slopcheck).
  const vaultIntegration = _parseVaultIntegration(mdContent);
  // Host-local override (issue #653) — applied here, NOT inside _parseVaultIntegration,
  // so claude-md-drift-check (which calls the parser directly) keeps seeing raw values.
  vaultIntegration['vault-dir'] = resolveHostPath('vault-dir', vaultIntegration['vault-dir'], hostCtx);

  // resource-thresholds sub-keys (v3.1.0 env-aware — issue #166)
  const resourceThresholds = _parseResourceThresholds(kv);

  // vault-sync: parsed from full content (can live outside Session Config)
  const vaultSync = _parseVaultSync(mdContent);
  // Host-local override (issue #653) — same host source as vault-integration above.
  vaultSync['vault-dir'] = resolveHostPath('vault-dir', vaultSync['vault-dir'], hostCtx);

  // drift-check: parsed from full content (standalone top-level block)
  const driftCheck = _parseDriftCheck(mdContent);

  // docs-orchestrator: parsed from full content (standalone top-level block)
  const docsOrchestrator = _parseDocsOrchestrator(mdContent);

  // vault-staleness: parsed from full content (standalone top-level block)
  const vaultStaleness = _parseVaultStaleness(mdContent);
  // docs-staleness: parsed from full content (standalone top-level block, #781)
  const docsStaleness = _parseDocsStaleness(mdContent);

  // events-rotation: parsed from full content (standalone top-level block)
  const eventsRotation = _parseEventsRotation(mdContent);

  // vault-mirror.quality: parsed from full content (PRD F1.2 / issue #504)
  const vaultMirror = _parseVaultMirrorQuality(mdContent);

  // cold-start: parsed from full content (PRD F1.3 / issue #500)
  const coldStart = _parseColdStart(mdContent);

  // auto-dream: parsed from full content (issue #566). The `min-confidence`
  // field is consumed by `collectProposals()` at session-end Phase 3.6.3 as a
  // SECOND confidence gate above `memory.proposals.confidence-floor`.
  const autoDream = _parseAutoDream(mdContent);

  // state-md-lock: parsed from full content (PRD gsd Pattern 1 / issues #517, #518)
  const stateMdLock = _parseStateMdLock(mdContent);

  // handover-gate: parsed from full content (PRD 2026-07-07 /close
  // Handover-Alignment-Gate — Epic #724)
  const handoverGate = _parseHandoverGate(mdContent);

  // slopcheck: parsed from full content (PRD gsd Pattern 2 / issues #517, #520)
  const slopcheck = _parseSlopcheck(mdContent);

  // skill-evolution: opt-in skill self-evolution autonomy block (OpenSpace C1 / issue #646)
  const skillEvolution = _parseSkillEvolution(mdContent);

  // dispatcher-autonomy: opt-in cross-repo dispatcher autonomy block (Epic #673 / issue #679).
  // Parser stays pure (raw committed value) for claude-md-drift-check raw-value parity;
  // the host-local override (env > owner.yaml > committed > off) is overlaid onto the
  // FINAL object only — mirroring the vault-dir resolveHostPath pattern above. Reuses the
  // already-loaded hostCtx.ownerConfig so owner.yaml is not read twice.
  const dispatcherAutonomy = _parseDispatcherAutonomy(mdContent);
  dispatcherAutonomy.autonomy = resolveDispatcherAutonomy({
    committed: dispatcherAutonomy.autonomy,
    ownerConfig: hostCtx.ownerConfig,
  });

  // discovery-validator: parsed from full content (PSA-006 enforcement / issue #567)
  const discoveryValidator = _parseDiscoveryValidator(mdContent);

  // templates-first: parsed from full content (PRD gsd Pattern 3 / issues #517, #519)
  const templatesFirst = _parseTemplatesFirst(mdContent);

  // verification-auto-fix: parsed from full content (PRD gsd Pattern 4 / issues #517, #521)
  const verificationAutoFix = _parseVerificationAutoFix(mdContent);

  // dialectic: parsed from full content (issue #506)
  const dialectic = _parseDialectic(mdContent);

  // memory: parsed from full content (issue #505 — banner opt-out)
  const memory = _parseMemory(mdContent);

  // reconcile: parsed from full content (FA4 #697 — config foundation for
  // FA3 #696 advisory rule-proposal delivery at session-end Phase 3.6.8).
  const reconcile = _parseReconcile(mdContent);

  // test: parsed from full content (standalone top-level block, /test epic #378)
  const testConfig = _parseTest(mdContent);

  // gitlab-portfolio: parsed from full content (standalone top-level block, GH #41)
  const gitlabPortfolio = _parseGitlabPortfolio(mdContent);

  // cross-repo.projects: delegated per-section parser (#478, MED-1)
  const crossRepoProjects = _parseCrossRepo(mdContent);

  // wave-reviewers: parsed from full content; dual-key shim (persona-reviewers → wave-reviewers, #461)
  const waveReviewers = _parseWaveReviewers(mdContent);
  if (waveReviewers.deprecated) {
    process.stderr.write(
      "Session Config: 'persona-reviewers' is deprecated — rename to 'wave-reviewers'. " +
        'Will be removed in v4.0.\n'
    );
  }

  // custom-phases: opt-in repo-declared deterministic phases run at session close /
  // housekeeping with exit-code gating + summary reporting (#637). Defaults to [].
  const customPhases = _parseCustomPhases(mdContent);

  // evolve.extra-sources: opt-in EXTRA learning sources for /evolve — sidecar JSON
  // files produced out-of-band by a domain measurement (e.g. an eval-learn regression
  // report). /evolve READS them and emits domain-regression candidates; it never runs
  // the measurement (read-only contract). Returned as 'evolve.extra-sources' (dotted,
  // mirroring the cross-repo.projects precedent). Defaults to []. (#638)
  const evolveExtraSources = _parseEvolve(mdContent);

  // evolve.decay: memory time-decay tuning nested UNDER the `evolve:` block (#670).
  // Adds a recency factor to learning surfacing — stale high-confidence learnings
  // decay (multiplicative half-life blend, with a catastrophic-loss floor) so they
  // no longer crowd out fresh signal. Conservative defaults (90-day half-life, 0.1
  // floor, enabled) make the change degrade gently. Consumed by surfaceTopN's
  // `opts.decay`. Nested (not a new top-level key) so claude-md-drift-check Check 6
  // parity is unaffected. Returned as 'evolve.decay' (dotted, mirroring
  // 'evolve.extra-sources').
  const evolveDecay = _parseEvolveDecay(mdContent);

  // persona-gate-wave: opt-in mid-wave persona-panel hook (#458). Returns null when absent.
  const personaGateWave = _parsePersonaGateWave(mdContent);
  if (personaGateWave !== null && personaGateWave.enabled === true && personaGateWave.mode === 'off') {
    process.stderr.write(
      "Session Config: 'persona-gate-wave' has enabled=true but mode=off — the hook will not fire. " +
        "Set mode to 'warn' or 'strict', or set enabled=false to silence this warning.\n"
    );
  }

  return {
    'agents-per-wave': agentsPerWave,
    'waves': waves,
    'recent-commits': recentCommits,
    'special': special,
    'vcs': vcs,
    'gitlab-host': gitlabHost,
    'mirror': mirror,
    'cross-repos': crossRepos,
    'cross-repo.projects': crossRepoProjects,
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
    'memory-cleanup-soft-limit': memoryCleanupSoftLimit,
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
    'vault-mirror': vaultMirror,
    'cold-start': coldStart,
    'auto-dream': autoDream,
    'state-md-lock': stateMdLock,
    'handover-gate': handoverGate,
    'slopcheck': slopcheck,
    'skill-evolution': skillEvolution,
    'dispatcher-autonomy': dispatcherAutonomy,
    'discovery-validator': discoveryValidator,
    'templates-first': templatesFirst,
    'verification-auto-fix': verificationAutoFix,
    'dialectic': dialectic,
    'memory': memory,
    'reconcile': reconcile,
    'vault-sync': vaultSync,
    'drift-check': driftCheck,
    'docs-orchestrator': docsOrchestrator,
    'vault-staleness': vaultStaleness,
    'docs-staleness': docsStaleness,
    'events-rotation': eventsRotation,
    'test': testConfig,
    'gitlab-portfolio': gitlabPortfolio,
    'wave-reviewers': waveReviewers,
    'persona-gate-wave': personaGateWave,
    'custom-phases': customPhases,
    'evolve.extra-sources': evolveExtraSources,
    'evolve.decay': evolveDecay,
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
