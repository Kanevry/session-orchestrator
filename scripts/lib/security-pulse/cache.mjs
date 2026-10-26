/**
 * cache.mjs — host-local cache of the session-start security pulse (#1769, stage 2).
 *
 * Layout under `<resolvePrivateConfigDir()>/security-pulse/` (never inside a repo):
 *   - `host.json`            Node security floors per major + CISA KEV CVE ids,
 *                            each source with its own `fetched_at` / `status`.
 *   - `repos/<key>.json`     reduced lockfile findings of one repo at one HEAD;
 *                            `<key>` = first 16 hex of sha256(realpath(repoRoot)).
 *   - `refresh.lock`         non-blocking host lock of the refresher.
 *   - `spawn-<key>.marker`   per-repo spawn throttle of the probe.
 *
 * Hygiene: directories 0700, files 0600, writes are tmp + rename. The reader
 * accepts a regular file only (lstat — a symlink is refused), caps the size and
 * reports a parse failure as "absent with a reason", never as a throw.
 *
 * Zero imports beyond `node:*` and the config-dir resolver: the probe that reads
 * this module is reachable from the SessionStart hook.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

import { resolvePrivateConfigDir } from '../config/private-config-dir.mjs';

/** Cache freshness window for both the host and the repo part. */
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * NAMED CEILING (BV-004): 4 MiB per cache file. A repo entry holds at most
 * {@link MAX_CACHED_FINDINGS} reduced findings and the KEV list is ~1,500 ids
 * (~25 KiB, 2026-10), so the cap is two orders of magnitude above real size.
 * Revisit if a refresher ever writes a file the reader then refuses as `too-large`.
 */
export const CACHE_MAX_BYTES = 4 * 1024 * 1024;

/** NAMED CEILING (BV-004): findings kept per repo entry. Revisit when a repo legitimately exceeds it. */
export const MAX_CACHED_FINDINGS = 200;

export const CACHE_SCHEMA = 1;

/**
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {string} absolute cache directory (`SO_CONFIG_HOME` honoured)
 */
export function cacheDir({ env = process.env } = {}) {
  return path.join(resolvePrivateConfigDir({ env }), 'security-pulse');
}

/**
 * Stable per-repo key: first 16 hex of sha256 over the repo root's realpath.
 * A path that cannot be resolved falls back to `path.resolve` (same repo, same key).
 * @param {string} repoRoot
 * @returns {string}
 */
export function repoKey(repoRoot) {
  let real;
  try {
    real = realpathSync(repoRoot);
  } catch {
    real = path.resolve(repoRoot);
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 16);
}

/** @returns {{hostFile: string, repoFile: string, lockFile: string, spawnMarker: string, dir: string}} */
export function cachePaths(repoRoot, { env = process.env } = {}) {
  const dir = cacheDir({ env });
  const key = repoKey(repoRoot);
  return {
    dir,
    hostFile: path.join(dir, 'host.json'),
    repoFile: path.join(dir, 'repos', `${key}.json`),
    lockFile: path.join(dir, 'refresh.lock'),
    spawnMarker: path.join(dir, `spawn-${key}.marker`),
  };
}

/**
 * Read one cache file. Never throws.
 * @param {string} file
 * @returns {{ok: true, value: object, mtimeMs: number} | {ok: false, reason: 'absent'|'not-regular'|'too-large'|'unreadable'|'parse-error'}}
 */
export function readCacheFile(file) {
  let st;
  try {
    st = lstatSync(file);
  } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'absent' : 'unreadable' };
  }
  if (!st.isFile()) return { ok: false, reason: 'not-regular' };
  if (st.size > CACHE_MAX_BYTES) return { ok: false, reason: 'too-large' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'parse-error' };
    return { ok: true, value, mtimeMs: st.mtimeMs };
  } catch {
    return { ok: false, reason: 'parse-error' };
  }
}

/** Create `dir` (and parents up to the cache root) with mode 0700; tighten an existing one. */
export function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Atomically write `text` to `file` with mode 0600 (tmp in the same dir + rename).
 * Throws on failure; the tmp file is removed.
 * @param {string} file
 * @param {string} text
 */
export function writePrivateFile(file, text) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let fd = null;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}

/** JSON variant of {@link writePrivateFile}. */
export function writeCacheJson(file, value) {
  writePrivateFile(file, `${JSON.stringify(value)}\n`);
}

/**
 * Epoch ms of an ISO stamp, or null.
 * @param {*} iso
 * @returns {number|null}
 */
export function stampMs(iso) {
  if (typeof iso !== 'string') return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}
