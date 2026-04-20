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
 * Formats validation errors as a human-readable list (one per line).
 *
 * @param {Array<{path: string, rule: string, message: string}>} errors
 * @returns {string}
 */
export function formatErrors(errors) {
  return errors.map((e) => `  - ${e.path} (${e.rule}): ${e.message}`).join('\n');
}
