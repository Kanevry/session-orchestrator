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
 * `vault-dir` has one more tier (agents/vault#319), see `resolveVaultDir`:
 *   1. SO_VAULT_DIR env
 *   2. owner.yaml `vault-dirs:` entry whose `match.path-prefix` contains the cwd
 *   3. owner.yaml paths.vault-dir
 *   4. committed Session Config value
 * Without tier 2 a single host-wide `paths.vault-dir` silently redirected every
 * repo on the host into ONE vault, including a repo whose committed config names
 * a different one.
 *
 * `resolveVaultIntegrationHost` is the host-local switch for the
 * `vault-integration` gate itself (SO#1448). It may only LOWER the committed
 * level (strict → warn → off), never raise it.
 *
 * SYNCHRONOUS by design: `parseSessionConfig` in scripts/lib/config.mjs is sync,
 * so this layer reuses the SYNC owner loader (`loadOwnerConfig`) and exposes only
 * sync functions. An empty/whitespace value at any tier is treated as "unset" and
 * falls through to the next tier.
 */

import { loadOwnerConfig } from '../owner-yaml.mjs';
import { resolveNamedBaseline } from '../named-baseline-resolver.mjs';

/** Maps a logical path key to its environment-variable name. */
const ENV_KEYS = /** @type {const} */ ({
  'vault-dir': 'SO_VAULT_DIR',
  'baseline-path': 'SO_BASELINE_PATH',
  // #725 D5 — host-local pseudonym map for vault-mirror namespace resolution.
  'namespace-map-path': 'SO_NAMESPACE_MAP',
  // #728a — host-local confidential customer/repo name list for CP11 leak scanning.
  'confidential-names-file': 'SO_CONFIDENTIAL_NAMES_FILE',
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
 * HEALTH PASSTHROUGH (#1251): the owner loader reports HOW its result came about
 * (`source`, `reason`, `droppedSections`). Discarding those forced callers that
 * need them — CP11 in check-owner-leakage.mjs is the live one — to load owner.yaml
 * a SECOND time just to see the health of the load this function already did. They
 * are passed through verbatim; `ownerConfig` and `env` keep their exact prior
 * meaning, so callers reading only those two (scripts/lib/config.mjs,
 * scripts/lib/vault-mirror/namespace.mjs) are unaffected. On a throwing loader all
 * three health fields stay `undefined`, exactly like `ownerConfig`.
 *
 * @param {{ env?: Record<string, string|undefined>, ownerLoader?: () => { config: object, source?: string, reason?: string, droppedSections?: Array<{section: string, errors: string[]}> } }} [opts]
 * @returns {{ ownerConfig: object|undefined, env: Record<string, string|undefined>, source: string|undefined, reason: string|undefined, droppedSections: Array<{section: string, errors: string[]}>|undefined }}
 */
export function loadHostPaths({ env = process.env, ownerLoader = loadOwnerConfig } = {}) {
  let ownerConfig;
  let source;
  let reason;
  let droppedSections;
  try {
    const loaded = ownerLoader();
    ownerConfig = loaded?.config;
    source = loaded?.source;
    reason = loaded?.reason;
    droppedSections = loaded?.droppedSections;
  } catch {
    ownerConfig = undefined;
  }
  return { ownerConfig, env, source, reason, droppedSections };
}

/**
 * Resolve a host-local path with precedence: env-var > owner.yaml paths[key] >
 * committedDefault. An empty/whitespace string at a tier is treated as "unset"
 * (fall through to the next tier). When no override is set, `committedDefault`
 * passes through unchanged — including `null`/`undefined`, preserving back-compat.
 *
 * @param {'vault-dir'|'baseline-path'|'namespace-map-path'|'confidential-names-file'} key — logical path key
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

/**
 * @param {unknown} v
 * @returns {v is string}
 */
function isNonBlank(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Resolve `vault-dir` and report which tier produced it (agents/vault#319).
 *
 * Precedence (highest first): SO_VAULT_DIR env > owner.yaml `vault-dirs:`
 * path-prefix match against the cwd > owner.yaml `paths.vault-dir` > committed.
 * The env tier stays on top because tests/setup/vault-guard.mjs relies on it to
 * shadow every host-local vault for the whole suite.
 *
 * `cwd` in the ctx is a test-only DI seam; production reads `process.cwd()`.
 *
 * @param {string|null|undefined} committed — value the committed Session Config produced
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object, cwd?: string }} [ctx] — from loadHostPaths()
 * @returns {{ value: string|null|undefined, source: 'env'|'match'|'owner'|'committed' }}
 */
export function resolveVaultDir(committed, { env = process.env, ownerConfig, cwd } = {}) {
  const envVal = env?.[ENV_KEYS['vault-dir']];
  if (isNonBlank(envVal)) return { value: envVal, source: 'env' };

  const matched = resolveNamedBaseline({
    cwd: cwd ?? process.cwd(),
    ownerConfig,
    env,
    section: 'vault-dirs',
    envKey: ENV_KEYS['vault-dir'],
  });
  if (matched.source === 'match' && isNonBlank(matched.path)) {
    return { value: matched.path, source: 'match' };
  }

  const ownerVal = ownerConfig?.paths?.['vault-dir'];
  if (isNonBlank(ownerVal)) return { value: ownerVal, source: 'owner' };

  return { value: committed, source: 'committed' };
}

/** vault-integration levels, weakest first. The index order IS the ordering. */
const VAULT_INTEGRATION_LEVELS = /** @type {readonly string[]} */ (['off', 'warn', 'strict']);

/**
 * @param {unknown} v
 * @returns {'off'|'warn'|'strict'|undefined} a valid level, or undefined for unset/invalid
 */
function coerceVaultIntegrationLevel(v) {
  if (typeof v !== 'string') return undefined;
  const lower = v.trim().toLowerCase();
  return VAULT_INTEGRATION_LEVELS.includes(lower)
    ? /** @type {'off'|'warn'|'strict'} */ (lower)
    : undefined;
}

/**
 * Overlay the host-local `vault-integration` switch onto the committed block
 * (SO#1448). Precedence: env `SO_VAULT_INTEGRATION=off|warn|strict` > owner.yaml
 * `vault-integration: { enabled: false | mode: off|warn|strict }` > committed.
 * An invalid value at a tier counts as unset and falls through, mirroring
 * resolveDispatcherAutonomy in dispatcher-autonomy.mjs.
 *
 * LOWER-ONLY: the host's level is applied only when it is weaker than the
 * committed one. A host that could raise it would mirror repos into the vault
 * that never opted in, so `enabled: true` or a stronger mode is ignored.
 * Applying `off` sets both `enabled: false` and `mode: 'off'`, so either
 * consumer check (`enabled`, `mode != off`) sees the integration as off.
 *
 * @param {{ enabled?: boolean, mode?: string } & Record<string, unknown>} vi — parsed committed block
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object }} [ctx] — from loadHostPaths()
 * @returns {Record<string, unknown> & { enabled?: boolean, mode?: string, 'host-override': 'env:SO_VAULT_INTEGRATION'|'owner.yaml'|null }}
 *   a copy of `vi`; `host-override` names the tier that lowered it, `null` when none did
 */
export function resolveVaultIntegrationHost(vi, { env = process.env, ownerConfig } = {}) {
  /** @type {Record<string, unknown> & { enabled?: boolean, mode?: string, 'host-override': 'env:SO_VAULT_INTEGRATION'|'owner.yaml'|null }} */
  const result = { ...vi, 'host-override': null };

  /** @type {'off'|'warn'|'strict'|undefined} */
  let requested = coerceVaultIntegrationLevel(env?.SO_VAULT_INTEGRATION);
  /** @type {'env:SO_VAULT_INTEGRATION'|'owner.yaml'} */
  let source = 'env:SO_VAULT_INTEGRATION';
  if (requested === undefined) {
    const owner = ownerConfig?.['vault-integration'];
    if (owner !== null && typeof owner === 'object' && !Array.isArray(owner)) {
      requested = owner.enabled === false ? 'off' : coerceVaultIntegrationLevel(owner.mode);
      source = 'owner.yaml';
    }
  }
  if (requested === undefined) return result;

  const committedLevel =
    vi?.enabled === true ? (coerceVaultIntegrationLevel(vi.mode) ?? 'warn') : 'off';
  if (
    VAULT_INTEGRATION_LEVELS.indexOf(requested) >= VAULT_INTEGRATION_LEVELS.indexOf(committedLevel)
  ) {
    return result;
  }

  if (requested === 'off') {
    result.enabled = false;
    result.mode = 'off';
  } else {
    result.mode = requested;
  }
  result['host-override'] = source;
  return result;
}
