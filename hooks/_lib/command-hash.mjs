/**
 * command-hash.mjs — the ONE keyed `command_hash` recipe for hook telemetry (#1880).
 *
 * Until #1880 four hooks each carried their own `sha256(command).slice(0, 16)`.
 * An unsalted hash of a short, guessable string is a pseudonym, not a secret:
 * on 2026-09-20 a sibling project recovered a real production share code from
 * such a mark in 605 s by hashing candidates. Consumer repos track
 * `.orchestrator/metrics/events.jsonl`, so every mark lands in git history.
 *
 * The mark is now `hmac:` + 16 hex of HMAC-SHA256(command) under a host-local
 * 32-byte key. It stays COUNTABLE and GROUPABLE on one host (the only property
 * any consumer reads), but it can no longer be reversed by dictionary without
 * the key, and two hosts produce different marks for the same command.
 *
 * Key file: `<private config dir>/command-hash.key` (0600, dir 0700), created
 * on first use. Dir precedence is copied from
 * `scripts/lib/config/private-config-dir.mjs` (`SO_CONFIG_HOME` >
 * `XDG_CONFIG_HOME/session-orchestrator` > `~/.config/session-orchestrator`)
 * — deliberately re-implemented, not imported: a hook `_lib` module must stay
 * free of `scripts/lib/**` imports. `SO_COMMAND_HASH_KEY_FILE` overrides the
 * whole path (tests).
 *
 * If the key can be neither read nor created (read-only FS, EACCES, a
 * directory at the path, a short file), the mark uses a PER-PROCESS random key
 * and carries the prefix `v0-` (`v0-hmac:<16 hex>`): still not reversible, but
 * not comparable across processes. It never falls back to the unsalted sha256.
 *
 * Synchronous on purpose — PreToolUse hooks are hot-path and synchronous.
 * Zero repo imports: `node:crypto`, `node:fs`, `node:os`, `node:path` only.
 *
 * Non-command inputs carry a `<domain>:` prefix so a directory and a command
 * of the same text never share a mark: `cwd:<resolved path>`
 * (`hooks/pre-bash-memory-propose-audit.mjs`) and `args:<JSON tool_input>`
 * (`hooks/loop-guard.mjs`), both #1915. CEILING (build-value.md § BV-004):
 * the domain stays a string convention, not a `hashWithDomain(domain, input)`
 * API. Revisit when a consumer must parse the domain back out of a mark, or a
 * third domain appears.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_BYTES = 32;
const KEY_FILE_NAME = 'command-hash.key';

/** Resolved key per key-file path (a test may switch the path in-process). */
const _keyCache = new Map();
/** Lazily created per-process fallback key — never written anywhere. */
let _processKey = null;

/**
 * Resolve the key-file path. Reads env at CALL time.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {string}
 */
function resolveKeyFilePath(env) {
  const override = (env.SO_COMMAND_HASH_KEY_FILE || '').trim();
  if (override) return override;
  const own = (env.SO_CONFIG_HOME || '').trim();
  if (own) return path.join(own, KEY_FILE_NAME);
  const xdg = (env.XDG_CONFIG_HOME || '').trim();
  if (xdg) return path.join(xdg, 'session-orchestrator', KEY_FILE_NAME);
  return path.join(os.homedir(), '.config', 'session-orchestrator', KEY_FILE_NAME);
}

/**
 * Read a key file. Returns the key, `null` when the file does not exist, and
 * throws for anything else (directory, EACCES, short/empty file).
 *
 * @param {string} file
 * @returns {Buffer|null}
 */
function readKey(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (buf.length < KEY_BYTES) throw new Error('command-hash key file too short');
  return buf.subarray(0, KEY_BYTES);
}

/**
 * Create the key file atomically and without clobbering: write a 0600 tmp
 * file, then `link()` it to the final name — `link` fails with EEXIST when a
 * concurrent hook won the race, and we adopt ITS key, so two processes never
 * end up with two keys. `rename` is the fallback for filesystems without hard
 * links.
 *
 * @param {string} file
 * @returns {Buffer}
 */
function createKey(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(KEY_BYTES);
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, key, { mode: 0o600, flag: 'wx' });
  try {
    try {
      fs.linkSync(tmp, file);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        const existing = readKey(file);
        if (existing) return existing;
        throw err;
      }
      // direct-rename:ok no retry: sync hot path, linkSync-first key-file fallback (#1880, #1865)
      fs.renameSync(tmp, file);
    }
    return key;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed away or already gone */ }
  }
}

/**
 * Resolve the HMAC key for `command_hash`. The key never leaves this module
 * in printable form; callers only learn whether it is persistent.
 *
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 * @returns {{ key: Buffer, persistent: boolean }} `persistent: false` means the
 *   per-process fallback key is in use (marks are prefixed `v0-`).
 */
export function resolveCommandHashKey({ env = process.env } = {}) {
  const file = resolveKeyFilePath(env);
  const cached = _keyCache.get(file);
  if (cached) return cached;
  let resolved;
  try {
    const key = readKey(file) ?? createKey(file);
    resolved = { key, persistent: true };
  } catch {
    if (!_processKey) _processKey = crypto.randomBytes(KEY_BYTES);
    resolved = { key: _processKey, persistent: false };
  }
  _keyCache.set(file, resolved);
  return resolved;
}

/**
 * Keyed, host-local mark of a shell command for telemetry: `hmac:<16 hex>`,
 * or `v0-hmac:<16 hex>` when only the per-process fallback key is available.
 * Never the command text, never an unsalted digest.
 *
 * @param {string} command
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 * @returns {string}
 */
export function hashCommand(command, opts = {}) {
  const { key, persistent } = resolveCommandHashKey(opts);
  const hex = crypto.createHmac('sha256', key).update(String(command)).digest('hex').slice(0, 16);
  return persistent ? `hmac:${hex}` : `v0-hmac:${hex}`;
}
