/**
 * Session Config validator — plain-JS schema enforcement (no zod dependency).
 *
 * Consumed by scripts/validate-config.mjs (CLI wrapper) and indirectly by
 * scripts/parse-config.mjs when enforcement is warn|strict.
 *
 * Pure function: accepts the parsed config JSON, returns a result object.
 * Never throws. Never mutates input.
 */

const ENFORCEMENT_VALUES = new Set(['strict', 'warn', 'off']);
const VAULT_MODE_VALUES = new Set(['strict', 'warn', 'off']);

const REQUIRED_STRING_FIELDS = [
  'test-command',
  'typecheck-command',
  'lint-command',
];

/**
 * Validates a Session Config JSON object against the v1 schema.
 *
 * @param {unknown} config - parsed config JSON (from parse-config.sh)
 * @returns {{ok: true, config: object} | {ok: false, errors: Array<{path: string, rule: string, message: string}>}}
 */
export function validateSessionConfig(config) {
  const errors = [];

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return {
      ok: false,
      errors: [{ path: '$', rule: 'type', message: 'config must be a JSON object' }],
    };
  }

  for (const key of REQUIRED_STRING_FIELDS) {
    const value = config[key];
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push({
        path: key,
        rule: 'non-empty-string',
        message: `${key} must be a non-empty string`,
      });
    }
  }

  validateAgentsPerWave(config['agents-per-wave'], errors);

  const waves = config['waves'];
  if (!Number.isInteger(waves) || waves < 3) {
    errors.push({
      path: 'waves',
      rule: 'integer>=3',
      message: `waves must be an integer >= 3 (got ${JSON.stringify(waves)})`,
    });
  }

  if (typeof config['persistence'] !== 'boolean') {
    errors.push({
      path: 'persistence',
      rule: 'boolean',
      message: `persistence must be a boolean (got ${JSON.stringify(config['persistence'])})`,
    });
  }

  const enforcement = config['enforcement'];
  if (typeof enforcement !== 'string' || !ENFORCEMENT_VALUES.has(enforcement)) {
    errors.push({
      path: 'enforcement',
      rule: 'enum',
      message: `enforcement must be one of "strict"|"warn"|"off" (got ${JSON.stringify(enforcement)})`,
    });
  }

  validateVaultIntegration(config['vault-integration'], errors);
  validateVaultSync(config['vault-sync'], errors);

  if (config['docs-orchestrator'] !== undefined && config['docs-orchestrator'] !== null) {
    const doErrs = validateDocsOrchestrator(config['docs-orchestrator']);
    for (const msg of doErrs) errors.push({ path: 'docs-orchestrator', rule: 'object', message: msg });
  }

  if (config['vault-staleness'] !== undefined && config['vault-staleness'] !== null) {
    const vsErrs = validateVaultStaleness(config['vault-staleness']);
    for (const msg of vsErrs) errors.push({ path: 'vault-staleness', rule: 'object', message: msg });
  }

  if (config['gitlab-portfolio'] !== undefined && config['gitlab-portfolio'] !== null) {
    const gpErrs = validateGitlabPortfolio(config['gitlab-portfolio']);
    for (const msg of gpErrs) errors.push({ path: 'gitlab-portfolio', rule: 'object', message: msg });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, config };
}

function validateAgentsPerWave(value, errors) {
  if (Number.isInteger(value)) {
    if (value < 2) {
      errors.push({
        path: 'agents-per-wave',
        rule: 'integer>=2',
        message: `agents-per-wave must be an integer >= 2 (got ${value})`,
      });
    }
    return;
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const defaultVal = value['default'];
    if (!Number.isInteger(defaultVal) || defaultVal < 2) {
      errors.push({
        path: 'agents-per-wave.default',
        rule: 'integer>=2',
        message: `agents-per-wave.default must be an integer >= 2 (got ${JSON.stringify(defaultVal)})`,
      });
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === 'default') continue;
      if (!Number.isInteger(v) || v < 2) {
        errors.push({
          path: `agents-per-wave.${k}`,
          rule: 'integer>=2',
          message: `agents-per-wave.${k} must be an integer >= 2 (got ${JSON.stringify(v)})`,
        });
      }
    }
    return;
  }

  errors.push({
    path: 'agents-per-wave',
    rule: 'integer-or-object',
    message: `agents-per-wave must be an integer >= 2 or an object with numeric entries (got ${JSON.stringify(value)})`,
  });
}

function validateVaultIntegration(value, errors) {
  if (value === undefined || value === null) return;

  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      path: 'vault-integration',
      rule: 'object',
      message: `vault-integration must be an object (got ${JSON.stringify(value)})`,
    });
    return;
  }

  if ('enabled' in value && typeof value['enabled'] !== 'boolean') {
    errors.push({
      path: 'vault-integration.enabled',
      rule: 'boolean',
      message: `vault-integration.enabled must be a boolean (got ${JSON.stringify(value['enabled'])})`,
    });
  }

  if ('mode' in value && !VAULT_MODE_VALUES.has(value['mode'])) {
    errors.push({
      path: 'vault-integration.mode',
      rule: 'enum',
      message: `vault-integration.mode must be one of "strict"|"warn"|"off" (got ${JSON.stringify(value['mode'])})`,
    });
  }
}

function validateVaultSync(value, errors) {
  if (value === undefined || value === null) return;

  if (typeof value !== 'object' || Array.isArray(value)) {
    errors.push({
      path: 'vault-sync',
      rule: 'object',
      message: `vault-sync must be an object (got ${JSON.stringify(value)})`,
    });
    return;
  }

  if ('enabled' in value && typeof value['enabled'] !== 'boolean') {
    errors.push({
      path: 'vault-sync.enabled',
      rule: 'boolean',
      message: `vault-sync.enabled must be a boolean (got ${JSON.stringify(value['enabled'])})`,
    });
  }

  if ('mode' in value && !VAULT_MODE_VALUES.has(value['mode'])) {
    errors.push({
      path: 'vault-sync.mode',
      rule: 'enum',
      message: `vault-sync.mode must be one of "strict"|"warn"|"off" (got ${JSON.stringify(value['mode'])})`,
    });
  }

  if ('exclude' in value && !Array.isArray(value['exclude'])) {
    errors.push({
      path: 'vault-sync.exclude',
      rule: 'array',
      message: `vault-sync.exclude must be an array of strings (got ${JSON.stringify(value['exclude'])})`,
    });
  }
}

/**
 * Validate the docs-orchestrator sub-object.
 * @param {unknown} obj
 * @returns {string[]} array of error messages (empty = valid)
 */
export function validateDocsOrchestrator(obj) {
  if (obj === null || typeof obj !== 'object') return ['docs-orchestrator must be an object'];
  const errs = [];
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    errs.push('docs-orchestrator.enabled must be boolean');
  }
  if (obj.audiences !== undefined) {
    if (!Array.isArray(obj.audiences)) {
      errs.push('docs-orchestrator.audiences must be an array');
    } else {
      const valid = new Set(['user', 'dev', 'vault']);
      for (const a of obj.audiences) {
        if (typeof a !== 'string' || !valid.has(a)) {
          errs.push(`docs-orchestrator.audiences contains invalid audience: ${a}`);
        }
      }
    }
  }
  if (obj.mode !== undefined && !VAULT_MODE_VALUES.has(obj.mode)) {
    errs.push(`docs-orchestrator.mode must be one of ${[...VAULT_MODE_VALUES].join('|')}`);
  }
  return errs;
}

/**
 * Validate the resource-thresholds sub-object.
 * @param {unknown} obj
 * @returns {string[]} array of error messages (empty = valid)
 */
export function validateResourceThresholds(obj) {
  if (obj === null || typeof obj !== 'object') return ['resource-thresholds must be an object'];
  const errs = [];
  const numFields = ['ram-free-min-gb', 'ram-free-critical-gb', 'cpu-load-max-pct', 'concurrent-sessions-warn'];
  for (const field of numFields) {
    if (obj[field] !== undefined && (typeof obj[field] !== 'number' || !(obj[field] > 0) || !Number.isFinite(obj[field]))) {
      errs.push(`resource-thresholds.${field} must be a positive finite number`);
    }
  }
  if (obj['zombie-threshold-min'] !== undefined) {
    const v = obj['zombie-threshold-min'];
    if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v) || !Number.isInteger(v)) {
      errs.push('resource-thresholds.zombie-threshold-min must be a positive integer (minutes)');
    }
  }
  if (obj['ssh-no-docker'] !== undefined && typeof obj['ssh-no-docker'] !== 'boolean') {
    errs.push('resource-thresholds.ssh-no-docker must be a boolean');
  }
  return errs;
}

/**
 * Validate the gitlab-portfolio sub-object.
 * @param {unknown} obj
 * @returns {string[]} array of error messages (empty = valid)
 */
export function validateGitlabPortfolio(obj) {
  if (obj === null || typeof obj !== 'object') return ['gitlab-portfolio must be an object'];
  const errs = [];
  const VALID_MODES = new Set(['warn', 'strict', 'off']);
  const KNOWN_KEYS = new Set(['enabled', 'mode', 'stale-days', 'critical-labels']);

  if (obj['enabled'] !== undefined && typeof obj['enabled'] !== 'boolean') {
    errs.push('gitlab-portfolio.enabled must be boolean');
  }
  if (obj['mode'] !== undefined && !VALID_MODES.has(obj['mode'])) {
    errs.push(`gitlab-portfolio.mode must be one of ${[...VALID_MODES].join('|')}`);
  }
  if (obj['stale-days'] !== undefined) {
    const v = obj['stale-days'];
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 1) {
      errs.push('gitlab-portfolio.stale-days must be an integer >= 1');
    }
  }
  if (obj['critical-labels'] !== undefined) {
    if (!Array.isArray(obj['critical-labels'])) {
      errs.push('gitlab-portfolio.critical-labels must be an array of non-empty strings');
    } else {
      for (const label of obj['critical-labels']) {
        if (typeof label !== 'string' || label.length === 0) {
          errs.push('gitlab-portfolio.critical-labels entries must be non-empty strings');
          break;
        }
      }
    }
  }
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      errs.push(`gitlab-portfolio.${key}: unknown field`);
    }
  }
  return errs;
}

/**
 * Validate the vault-staleness sub-object.
 * @param {unknown} obj
 * @returns {string[]} array of error messages (empty = valid)
 */
export function validateVaultStaleness(obj) {
  if (obj === null || typeof obj !== 'object') return ['vault-staleness must be an object'];
  const errs = [];
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    errs.push('vault-staleness.enabled must be boolean');
  }
  if (obj.thresholds !== undefined) {
    if (obj.thresholds === null || typeof obj.thresholds !== 'object') {
      errs.push('vault-staleness.thresholds must be an object');
    } else {
      for (const tier of ['top', 'active', 'archived']) {
        if (
          obj.thresholds[tier] !== undefined &&
          (typeof obj.thresholds[tier] !== 'number' ||
            !(obj.thresholds[tier] > 0) ||
            !Number.isFinite(obj.thresholds[tier]))
        ) {
          errs.push(`vault-staleness.thresholds.${tier} must be a positive finite number (days)`);
        }
      }
    }
  }
  if (obj.mode !== undefined && !VAULT_MODE_VALUES.has(obj.mode)) {
    errs.push(`vault-staleness.mode must be one of ${[...VAULT_MODE_VALUES].join('|')}`);
  }
  return errs;
}

/**
 * Formats validation errors as a human-readable list (one per line).
 *
 * @param {Array<{path: string, rule: string, message: string}>} errors
 * @returns {string}
 */
export function formatErrors(errors) {
  return errors.map((e) => `  - ${e.path} (${e.rule}): ${e.message}`).join('\n');
}
