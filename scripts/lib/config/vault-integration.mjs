/**
 * vault-integration.mjs — Parsers for vault-integration and resource-thresholds
 * sub-keys from the Session Config KV map.
 *
 * Sub-keys are stored flat in the KV map (indented YAML inside their blocks
 * but treated as top-level key-value pairs by the shell parser).
 */

import { _coerceBoolean, _coerceInteger, _coerceString, _getVal } from './coercers.mjs';

// ---------------------------------------------------------------------------
// vault-integration
// ---------------------------------------------------------------------------

/**
 * Extract vault-integration sub-keys from the Session Config KV map.
 * @param {Map<string, string>} kv
 * @returns {{enabled: boolean, "vault-dir": string|null, mode: string}}
 */
export function _parseVaultIntegration(kv) {
  const enabled = _coerceBoolean(kv, 'enabled', false);
  const vaultDir = _coerceString(kv, 'vault-dir', undefined);
  // mode enum: warn|strict|off (hard is legacy alias — shell only allows warn/strict/off)
  const modeRaw = _getVal(kv, 'mode', 'warn');
  const modeAllowed = ['warn', 'strict', 'off'];
  const mode = modeAllowed.includes(modeRaw.toLowerCase()) ? modeRaw.toLowerCase() : 'warn';

  return { enabled, 'vault-dir': vaultDir, mode };
}

// ---------------------------------------------------------------------------
// resource-thresholds
// ---------------------------------------------------------------------------

// Sub-key names are deliberately unique across all blocks (no collision with
// vault-integration / vault-sync) because they are flattened into the same KV
// map by the Session Config parser. See the A5 note in parse-config.sh.

/**
 * Extract resource-thresholds sub-keys from the Session Config KV map.
 * @param {Map<string, string>} kv
 * @returns {{[key: string]: number|boolean}}
 */
export function _parseResourceThresholds(kv) {
  return {
    'ram-free-min-gb': _coerceInteger(kv, 'ram-free-min-gb', 4),
    'ram-free-critical-gb': _coerceInteger(kv, 'ram-free-critical-gb', 2),
    'cpu-load-max-pct': _coerceInteger(kv, 'cpu-load-max-pct', 80),
    'concurrent-sessions-warn': _coerceInteger(kv, 'concurrent-sessions-warn', 5),
    'ssh-no-docker': _coerceBoolean(kv, 'ssh-no-docker', true),
  };
}
