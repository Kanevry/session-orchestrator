/**
 * learnings/store-role.mjs — host-local role of the canonical learnings store (#1516).
 *
 * A vault repo synced between two hosts must not have BOTH hosts rewrite
 * `learnings.jsonl` wholesale (tmp+rename): every rewrite conflicts on merge,
 * and `merge=union` cannot apply to a rewritten file. One host stays the
 * `writer` (default); the other opts into `inbox` and only ever APPENDS to the
 * sibling `learnings-inbox.jsonl`, which the writer ingests.
 *
 * Fail-closed: ONLY "nothing configured" means writer. A role that is set but
 * unusable — an invalid `SO_LEARNINGS_STORE_ROLE`, an owner.yaml that exists
 * but cannot be read, or one that names a top-level `learnings` key whose
 * `store-role` did not survive loading (typo in the value or the key,
 * unparseable file, missing YAML parser) — resolves to `invalid`, and every WRITE path for the canonical
 * store refuses via {@link assertStoreRoleUsable}. Readers keep working.
 *
 * Deliberately import-light: the only repo import is `../owner-yaml.mjs`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadOwnerConfig, resolveOwnerYamlPath } from '../owner-yaml.mjs';

/** Valid store roles. `writer` is the default when nothing is configured. */
export const STORE_ROLES = Object.freeze(['writer', 'inbox']);

const ENV_KEY = 'SO_LEARNINGS_STORE_ROLE';
const CANONICAL_STORE = 'learnings.jsonl';

/**
 * A top-level `learnings` key in the RAW owner.yaml text (block style, plain
 * or quoted key). Ceiling (BV-004): a flow-style top-level mapping
 * (`{learnings: {...}}`) is not detected, so a broken one of those still
 * resolves to writer. Revisit-trigger: an owner.yaml written in flow style.
 */
const LEARNINGS_KEY_RE = /^["']?learnings["']?\s*:/m;

/**
 * @typedef {{ role: 'writer'|'inbox', source: 'env'|'owner-yaml'|'default' }
 *   | { role: 'invalid', source: 'env'|'owner-yaml', reason: string }} StoreRoleResult
 */

/** @type {Map<string, StoreRoleResult>} */
const cache = new Map();

/**
 * Thrown by {@link assertStoreRoleUsable} when a write to the canonical store
 * is attempted while this host's store role is invalid. Nothing was written.
 */
export class LearningsStoreRoleError extends Error {
  /**
   * @param {'env'|'owner-yaml'} source
   * @param {string} reason
   */
  constructor(source, reason) {
    super(
      `learnings store role is invalid (${source}: ${reason}) — nothing written; ` +
        `fix owner.yaml learnings.store-role or ${ENV_KEY}`,
    );
    this.name = 'LearningsStoreRoleError';
    this.source = source;
    this.reason = reason;
  }
}

/**
 * The owner.yaml half of {@link resolveStoreRole}.
 *
 * @param {string} ownerPath
 * @param {(opts: {path: string}) => any} loadOwner
 * @returns {StoreRoleResult}
 */
function resolveFromOwnerYaml(ownerPath, loadOwner) {
  const loaded = loadOwner({ path: ownerPath });
  const section = loaded?.config?.learnings;
  const fromOwner = section?.['store-role'];
  if (STORE_ROLES.includes(fromOwner)) return { role: fromOwner, source: 'owner-yaml' };

  let raw;
  try {
    raw = readFileSync(ownerPath, 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT') return { role: 'writer', source: 'default' };
    return { role: 'invalid', source: 'owner-yaml', reason: `owner.yaml unreadable (${err?.code ?? 'error'})` };
  }
  if (!LEARNINGS_KEY_RE.test(raw)) return { role: 'writer', source: 'default' };
  // A learnings section that loaded as an object without a store-role, or as
  // an empty `learnings:` (null), is "key absent" — writer (#1686). A section
  // with any other key was dropped by owner-yaml validation, so it is
  // undefined here. Anything else means the configured value was lost.
  if (section === null && loaded?.config && 'learnings' in loaded.config) return { role: 'writer', source: 'default' };
  const isObject = section !== null && typeof section === 'object' && !Array.isArray(section);
  if (isObject && (fromOwner === undefined || fromOwner === null)) return { role: 'writer', source: 'default' };
  const dropped = Array.isArray(loaded?.droppedSections)
    ? loaded.droppedSections.find((d) => d?.section === 'learnings')
    : undefined;
  const reason =
    dropped?.errors?.[0] ??
    (loaded?.reason ? `owner.yaml ${loaded.reason}` : null) ??
    (fromOwner !== undefined ? `store-role ${JSON.stringify(fromOwner)} not one of ${STORE_ROLES.join(', ')}` : null) ??
    'learnings section present but unusable';
  return { role: 'invalid', source: 'owner-yaml', reason };
}

/**
 * Resolve this host's learnings-store role.
 *
 * Precedence: env `SO_LEARNINGS_STORE_ROLE` (trimmed) > owner.yaml
 * `learnings.store-role` > `writer`. A non-empty env value that is not a role
 * resolves to `invalid` (no fallback to owner.yaml); so does an owner.yaml
 * that exists but is unreadable, or that names a top-level `learnings` key
 * whose `store-role` did not load as a valid role. Only an absent file, or one
 * without a `learnings` key / `store-role` (an empty `learnings:` included),
 * means `writer`. Memoized per
 * process on (env value, owner.yaml path). Never throws: an unexpected error
 * resolves to `invalid` (fail-closed), not to writer.
 *
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string|undefined>,
 *   loadOwner?: (opts: {path: string}) => {config?: any} }} [opts] — `loadOwner`
 *   defaults to `loadOwnerConfig` (test seam)
 * @returns {StoreRoleResult} `role: 'writer'|'inbox'|'invalid'`; `reason` only on invalid
 */
export function resolveStoreRole({ env = process.env, loadOwner } = {}) {
  let source = /** @type {'env'|'owner-yaml'} */ ('owner-yaml');
  try {
    const envValue = (env[ENV_KEY] || '').trim();
    const ownerPath = resolveOwnerYamlPath(env);
    const key = `${envValue}\u0000${ownerPath}`;
    const hit = cache.get(key);
    if (hit) return hit;

    /** @type {StoreRoleResult} */
    let result;
    if (envValue !== '') {
      source = 'env';
      result = STORE_ROLES.includes(envValue)
        ? { role: /** @type {'writer'|'inbox'} */ (envValue), source: 'env' }
        : {
            role: 'invalid',
            source: 'env',
            reason: `${ENV_KEY}=${JSON.stringify(envValue)} not one of ${STORE_ROLES.join(', ')}`,
          };
    } else {
      result = resolveFromOwnerYaml(ownerPath, loadOwner ?? loadOwnerConfig);
    }
    cache.set(key, result);
    return result;
  } catch (err) {
    return { role: 'invalid', source, reason: `store role not resolvable (${err?.message ?? String(err)})` };
  }
}

/**
 * Refuse a write to the canonical store while this host's role is invalid.
 * Call it on every WRITE path before any lock or disk write; other files and
 * readers are unaffected.
 *
 * @param {string} filePath
 * @throws {LearningsStoreRoleError} iff `filePath` is the canonical store and the role is invalid
 */
export function assertStoreRoleUsable(filePath) {
  if (!isCanonicalStore(filePath)) return;
  const resolved = resolveStoreRole();
  if (resolved.role === 'invalid') throw new LearningsStoreRoleError(resolved.source, resolved.reason);
}

/** Clear the memo. Tests only. */
export function _resetStoreRoleCacheForTests() {
  cache.clear();
}

/**
 * True iff `filePath` names the canonical store (`learnings.jsonl`). Only that
 * file gets the inbox behaviour; any other path keeps the plain store semantics.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
export function isCanonicalStore(filePath) {
  return typeof filePath === 'string' && path.basename(filePath) === CANONICAL_STORE;
}

/**
 * Sibling inbox file the `inbox` role appends to.
 * @param {string} storePath
 * @returns {string}
 */
export function inboxPathFor(storePath) {
  return path.join(path.dirname(storePath), 'learnings-inbox.jsonl');
}

/**
 * Sibling receipts file the writer appends `{id, ingested_at}` lines to once
 * an inbox record has been ingested into the live store.
 * @param {string} storePath
 * @returns {string}
 */
export function receiptsPathFor(storePath) {
  return path.join(path.dirname(storePath), 'learnings-inbox-ingested.jsonl');
}

/**
 * Sibling archive file (expired learnings).
 * @param {string} storePath
 * @returns {string}
 */
export function archivePathFor(storePath) {
  return path.join(path.dirname(storePath), 'learnings-archive.jsonl');
}
