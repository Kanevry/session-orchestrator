/**
 * learnings/store-role.mjs — host-local role of the canonical learnings store (#1516).
 *
 * A vault repo synced between two hosts must not have BOTH hosts rewrite
 * `learnings.jsonl` wholesale (tmp+rename): every rewrite conflicts on merge,
 * and `merge=union` cannot apply to a rewritten file. One host stays the
 * `writer` (default); the other opts into `inbox` and only ever APPENDS to the
 * sibling `learnings-inbox.jsonl`, which the writer ingests.
 *
 * The role is per STORE, not per host (#1754): owner.yaml
 * `learnings.inbox-repos` lists repo roots whose stores are `inbox` on this
 * host, so a replica host appends only into a synced vault repo while its
 * other, local-only repos stay writers. `learnings.store-role` remains the
 * host-wide role for every store outside the list.
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

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { loadOwnerConfig, resolveOwnerYamlPath } from '../owner-yaml.mjs';

/** Valid store roles. `writer` is the default when nothing is configured. */
export const STORE_ROLES = Object.freeze(['writer', 'inbox']);

const ENV_KEY = 'SO_LEARNINGS_STORE_ROLE';
const CANONICAL_STORE = 'learnings.jsonl';

/**
 * A top-level `learnings` key in the RAW owner.yaml text (block style, plain
 * or quoted key). Parsed validation failures are detected via droppedSections
 * in any YAML form. Ceiling (BV-004): when parsing fails or is unavailable,
 * indented/flow mappings and escaped keys may evade this raw-text fallback.
 * Revisit-trigger: unparseable owner.yaml using one of those forms.
 */
const LEARNINGS_KEY_RE = /^["']?learnings["']?\s*:/m;

/**
 * @typedef {{ role: 'writer'|'inbox', source: 'env'|'owner-yaml'|'default', repo?: string }
 *   | { role: 'invalid', source: 'env'|'owner-yaml', reason: string }} StoreRoleResult
 *   `repo` is set only when the store lies inside a listed `inbox-repos` root
 *   (the matched root, resolved); then `role` is `inbox` and `source` `owner-yaml`.
 */

/**
 * Memo per (env value, owner.yaml path): the host-wide result plus the
 * `inbox-repos` list. The repo match depends on the store path, so it is
 * computed per call from this entry, never cached.
 * @type {Map<string, { result: StoreRoleResult, inboxRepos: string[] }>}
 */
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
        `fix owner.yaml learnings.store-role / learnings.inbox-repos or ${ENV_KEY}`,
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
 * @returns {{ result: StoreRoleResult, inboxRepos: string[] }} `inboxRepos` is
 *   empty whenever the host-wide result is invalid (fail-closed wins)
 */
function resolveFromOwnerYaml(ownerPath, loadOwner) {
  const loaded = loadOwner({ path: ownerPath });
  const section = loaded?.config?.learnings;
  const listed = section?.['inbox-repos'];
  const inboxRepos = Array.isArray(listed) ? listed.filter((r) => typeof r === 'string' && r !== '') : [];
  const result = hostWideFromOwnerYaml(ownerPath, loaded, section);
  return { result, inboxRepos: result.role === 'invalid' ? [] : inboxRepos };
}

/**
 * Host-wide role from an already-loaded owner.yaml (`learnings.store-role`).
 *
 * @param {string} ownerPath
 * @param {any} loaded - the loadOwner result
 * @param {any} section - `loaded.config.learnings`
 * @returns {StoreRoleResult}
 */
function hostWideFromOwnerYaml(ownerPath, loaded, section) {
  const dropped = Array.isArray(loaded?.droppedSections)
    ? loaded.droppedSections.find((d) => d?.section === 'learnings')
    : undefined;
  if (dropped) {
    return { role: 'invalid', source: 'owner-yaml', reason: dropped.errors?.[0] ?? 'learnings section present but unusable' };
  }
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
  // A learnings section that loaded as an object without a store-role (an
  // `inbox-repos`-only section included), or as
  // an empty `learnings:` (null), is "key absent" — writer (#1686). A section
  // with any other key was dropped by owner-yaml validation, so it is
  // undefined here. Anything else means the configured value was lost.
  if (section === null && loaded?.config && 'learnings' in loaded.config) return { role: 'writer', source: 'default' };
  const isObject = section !== null && typeof section === 'object' && !Array.isArray(section);
  if (isObject && (fromOwner === undefined || fromOwner === null)) return { role: 'writer', source: 'default' };
  const reason =
    (loaded?.reason ? `owner.yaml ${loaded.reason}` : null) ??
    (fromOwner !== undefined ? `store-role ${JSON.stringify(fromOwner)} not one of ${STORE_ROLES.join(', ')}` : null) ??
    'learnings section present but unusable';
  return { role: 'invalid', source: 'owner-yaml', reason };
}

/**
 * Canonicalise a path for the inbox-repos match: resolve it, realpath its
 * deepest EXISTING ancestor and re-append the rest, so a store file that does
 * not exist yet still matches a root reached through a symlink (macOS `/var`
 * → `/private/var`).
 *
 * @param {string} p
 * @returns {string}
 */
function canonicalPath(p) {
  let head = path.resolve(p);
  const tail = [];
  for (;;) {
    if (existsSync(head)) {
      try {
        return path.join(realpathSync.native(head), ...tail);
      } catch {
        return path.join(head, ...tail);
      }
    }
    const parent = path.dirname(head);
    if (parent === head) return path.join(head, ...tail);
    tail.unshift(path.basename(head));
    head = parent;
  }
}

/**
 * The first listed `inbox-repos` root that contains `storePath`, or null.
 *
 * Ceiling (BV-004): the match is by path, so a linked worktree of a listed
 * repo is a different path and needs its own entry. Revisit-trigger: a vault
 * worktree on the replica host writes learnings.
 *
 * @param {string[]} roots - owner.yaml entries (absolute or `~/`-prefixed; owner-yaml validated them)
 * @param {string} storePath
 * @param {string} home - expansion target for a leading `~/`
 * @returns {string|null} the matched root, canonicalised
 */
function matchInboxRepo(roots, storePath, home) {
  const store = canonicalPath(storePath);
  for (const entry of roots) {
    const expanded = entry.startsWith('~/') ? path.join(home, entry.slice(2)) : entry;
    if (!path.isAbsolute(expanded)) continue;
    const root = canonicalPath(expanded);
    const rel = path.relative(root, store);
    const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
    if (!outside) return root;
  }
  return null;
}

/**
 * Resolve the learnings-store role — for the store at `storePath` when given.
 *
 * Precedence: env `SO_LEARNINGS_STORE_ROLE` (trimmed) > `storePath` inside a
 * repo root listed in owner.yaml `learnings.inbox-repos` (→ `inbox`, `repo` =
 * the matched root; #1754) > owner.yaml `learnings.store-role` > `writer`.
 * A non-empty env value that is not a role
 * resolves to `invalid` (no fallback to owner.yaml); so does an owner.yaml
 * that exists but is unreadable, or that names a top-level `learnings` key
 * whose section did not survive validation (a bad `store-role` or
 * `inbox-repos`, an unknown key) — whatever `storePath` is. Only an absent
 * file, or one without a `learnings` key / `store-role` (an empty
 * `learnings:` included), means `writer` outside the listed repos. The loaded
 * owner.yaml is memoized per process on (env value, owner.yaml path); the
 * repo match is computed per call. A leading `~/` in an entry expands against
 * `env.HOME` (trimmed), else `os.homedir()`. Never throws: an unexpected
 * error resolves to `invalid` (fail-closed), not to writer.
 *
 * @param {{ env?: NodeJS.ProcessEnv | Record<string, string|undefined>,
 *   loadOwner?: (opts: {path: string}) => {config?: any},
 *   storePath?: string }} [opts] — `loadOwner` defaults to `loadOwnerConfig`
 *   (test seam); `storePath` is the store being read or written — without it
 *   only the host-wide role applies
 * @returns {StoreRoleResult} `role: 'writer'|'inbox'|'invalid'`; `reason` only on invalid
 */
export function resolveStoreRole({ env = process.env, loadOwner, storePath } = {}) {
  let source = /** @type {'env'|'owner-yaml'} */ ('owner-yaml');
  try {
    const envValue = (env[ENV_KEY] || '').trim();
    if (envValue !== '') source = 'env';
    const ownerPath = resolveOwnerYamlPath(env);
    const key = `${envValue}\u0000${ownerPath}`;
    let entry = cache.get(key);
    if (!entry) {
      entry =
        envValue !== ''
          ? {
              result: STORE_ROLES.includes(envValue)
                ? { role: /** @type {'writer'|'inbox'} */ (envValue), source: 'env' }
                : {
                    role: 'invalid',
                    source: 'env',
                    reason: `${ENV_KEY}=${JSON.stringify(envValue)} not one of ${STORE_ROLES.join(', ')}`,
                  },
              inboxRepos: [],
            }
          : resolveFromOwnerYaml(ownerPath, loadOwner ?? loadOwnerConfig);
      cache.set(key, entry);
    }
    if (typeof storePath === 'string' && storePath !== '' && entry.inboxRepos.length > 0) {
      const repo = matchInboxRepo(entry.inboxRepos, storePath, (env.HOME || '').trim() || homedir());
      if (repo !== null) return { role: 'inbox', source: 'owner-yaml', repo };
    }
    return entry.result;
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
  const resolved = resolveStoreRole({ storePath: filePath });
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
