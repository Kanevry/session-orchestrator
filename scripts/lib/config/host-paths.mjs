/**
 * host-paths.mjs — Host-local path resolution layer (issue #653).
 *
 * Resolves machine-specific paths (`vault-dir`, projects-baseline path) from a
 * host-local source instead of the version-controlled Session Config. This keeps
 * personal absolute paths out of committed CLAUDE.md (a dual privacy + portability
 * hazard the owner-leakage scanner P1–P9 does not catch) while still letting the
 * committed default act as a fallback for unconfigured hosts.
 *
 * Precedence (highest first):
 *   1. env-var               (SO_VAULT_DIR / SO_BASELINE_PATH)
 *   2. owner.yaml paths[key]  (host-local, never committed — ~/.config/session-orchestrator/owner.yaml)
 *   3. committed Session Config default (the value the committed CLAUDE.md —
 *      AGENTS.md on Codex CLI — produced)
 *
 * SYNCHRONOUS by design: `parseSessionConfig` in scripts/lib/config.mjs is sync,
 * so this layer reuses the SYNC owner loader (`loadOwnerConfig`) and exposes only
 * sync functions. An empty/whitespace value at any tier is treated as "unset" and
 * falls through to the next tier.
 */

import { loadOwnerConfig } from '../owner-yaml.mjs';

/** Maps a logical path key to its environment-variable name. */
const ENV_KEYS = /** @type {const} */ ({
  'vault-dir': 'SO_VAULT_DIR',
  'baseline-path': 'SO_BASELINE_PATH',
  // #725 D5 — host-local pseudonym map for vault-mirror namespace resolution.
  'namespace-map-path': 'SO_NAMESPACE_MAP',
});

/**
 * Load the host-local resolution context once (owner.yaml + env), so a caller can
 * resolve many keys without re-reading disk per key.
 *
 * Defensive: `loadOwnerConfig` never throws, but the try/catch guards against a
 * future loader change. `ownerConfig` may be the raw parsed object — it is NOT
 * merged with defaults, so a real owner.yaml without a `paths:` section yields
 * `ownerConfig.paths === undefined`. Callers must read defensively.
 *
 * @param {{ env?: Record<string, string|undefined>, ownerLoader?: () => { config: object } }} [opts]
 * @returns {{ ownerConfig: object|undefined, env: Record<string, string|undefined> }}
 */
export function loadHostPaths({ env = process.env, ownerLoader = loadOwnerConfig } = {}) {
  let ownerConfig;
  try {
    ownerConfig = ownerLoader().config;
  } catch {
    ownerConfig = undefined;
  }
  return { ownerConfig, env };
}

/**
 * Resolve a host-local path with precedence: env-var > owner.yaml paths[key] >
 * committedDefault. An empty/whitespace string at a tier is treated as "unset"
 * (fall through to the next tier). When no override is set, `committedDefault`
 * passes through unchanged — including `null`/`undefined`, preserving back-compat.
 *
 * @param {'vault-dir'|'baseline-path'|'namespace-map-path'} key — logical path key
 * @param {string|null|undefined} committedDefault — value the committed Session Config produced
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object }} [ctx] — from loadHostPaths()
 * @returns {string|null|undefined} resolved value
 */
export function resolveHostPath(key, committedDefault, { env = process.env, ownerConfig } = {}) {
  const envName = ENV_KEYS[key];
  const envVal = envName ? env[envName] : undefined;
  if (typeof envVal === 'string' && envVal.trim() !== '') return envVal;

  const ownerVal = ownerConfig?.paths?.[key];
  if (typeof ownerVal === 'string' && ownerVal.trim() !== '') return ownerVal;

  return committedDefault;
}
