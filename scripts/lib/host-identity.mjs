/**
 * host-identity.mjs — device fingerprint + SSH/local detection for env-aware sessions.
 *
 * Produces a stable, anonymized host fingerprint cached per-project at
 * `.orchestrator/host.json` (sharable) plus a local-only twin at
 * `~/.config/session-orchestrator/host-private.json` that holds raw hostname and
 * absolute project paths (never leaves the machine).
 *
 * Part of v3.1.0 Epic #157, Sub-Epic #158 (A+B). Issue #162.
 *
 * The fingerprint shape is:
 *   {
 *     host_class: 'macos-arm64-m3pro' | 'linux-x86_64' | ...,
 *     os: 'darwin' | 'linux' | 'win32',
 *     os_version: '14.3',
 *     cpu_cores: 12,
 *     ram_total_gb: 18,
 *     hostname_hash: '<sha256 hex>',
 *     is_ssh: false,
 *     platform: 'claude' | 'codex' | 'cursor' | null,
 *     first_seen: '2026-04-19T11:00:00Z',
 *   }
 *
 * The private twin shape is:
 *   {
 *     hostname: 'actual-hostname.local',
 *     project_path: '/Users/.../Projects/session-orchestrator',
 *     first_seen: '2026-04-19T11:00:00Z',
 *   }
 */

import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { digestSha256WithSalt } from './crypto-digest-utils.mjs';
import path from 'node:path';
import os from 'node:os';
// NOTE (#1072 gate fix): platform.mjs is deliberately NOT imported statically.
// Its module level computes SO_PLATFORM/SO_PLUGIN_ROOT via detectPlatform()/
// resolvePluginRoot(), which walk the filesystem (existsSync + readFileSync of
// package.json up the tree). session-lock.mjs now imports this module, which
// put those import-time reads into every graph that imports session-lock —
// including fs-mocked test graphs (tests/lib/vault-mirror/process.test.mjs went
// red: the walk consumed the mocks' sequenced return values). The only two
// consumers (SO_OS/SO_PLATFORM in collectFingerprint) are async — load lazily.

const FINGERPRINT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PLACEHOLDER_SALT = 'env-aware-v1-default-salt-replaced-by-owner-yaml';

// ---------------------------------------------------------------------------
// SSH detection
// ---------------------------------------------------------------------------

/**
 * True when the current process is running inside an SSH session.
 * Honors the three standard OpenSSH env vars set at login.
 */
export function isSSH() {
  return Boolean(
    process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY
  );
}

// ---------------------------------------------------------------------------
// Host classification
// ---------------------------------------------------------------------------

function _darwinAppleSiliconClass(cpuModel) {
  // cpu().model on darwin arm64 looks like: "Apple M1", "Apple M3 Pro", "Apple M4 Max"
  if (!cpuModel) return 'macos-arm64-apple';
  const m = cpuModel.match(/Apple\s+(M\d+)(?:\s+(Pro|Max|Ultra))?/i);
  if (!m) return 'macos-arm64-apple';
  const chip = m[1].toLowerCase();
  const variant = m[2] ? m[2].toLowerCase() : '';
  return variant ? `macos-arm64-${chip}${variant}` : `macos-arm64-${chip}`;
}

/**
 * Reduce OS + arch + CPU info into a stable host_class string.
 * @param {string} osName   — 'darwin' | 'linux' | 'win32'
 * @param {string} arch     — 'arm64' | 'x64' | 'ia32'
 * @param {string} cpuModel — os.cpus()[0]?.model or ''
 */
export function classifyHost(osName, arch, cpuModel) {
  if (osName === 'darwin' && arch === 'arm64') {
    return _darwinAppleSiliconClass(cpuModel);
  }
  if (osName === 'darwin' && arch === 'x64') return 'macos-x86_64';
  if (osName === 'linux' && arch === 'arm64') return 'linux-arm64';
  if (osName === 'linux' && arch === 'x64') return 'linux-x86_64';
  if (osName === 'win32' && arch === 'arm64') return 'windows-arm64';
  if (osName === 'win32' && arch === 'x64') return 'windows-x86_64';
  return `${osName}-${arch}`;
}

// ---------------------------------------------------------------------------
// Hostname hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic one-way hash used for cross-host learning correlation without
 * leaking the actual hostname.
 */
export function hashHostname(hostname, salt) {
  return digestSha256WithSalt(hostname, { salt: String(salt) });
}

// ---------------------------------------------------------------------------
// Stable host identity (GitLab #1072)
// ---------------------------------------------------------------------------
//
// `os.hostname()` is NOT stable on a single machine. Measured on the reference
// host 2026-08-24: two readings ten minutes apart returned `Mac.home` and
// `Bernhards-MacBook-Pro.local`, and `.orchestrator/metrics/events.jsonl`
// carries both spellings (106× / 27×). Every `lock.host === os.hostname()`
// comparison in the lock family therefore fails against the machine's OWN lock
// after a flip: stale detection reports `cross-host` (and cross-host locks are
// never reaped or overridden by design, PSA-003), the reaper refuses with
// `cross-host-requires-operator`, and release owner-match returns `not-owner`.
//
// Two independent layers, because one is not enough:
//   1. `stableHostname()` normalises the SUFFIX difference (`Mac.home` vs
//      `Mac.local` → `mac`). It cannot bridge `mac` vs `bernhards-macbook-pro`
//      — those differ before the suffix.
//   2. The self-alias ledger records every spelling THIS machine has presented
//      itself under, so `hostnamesMatch()` can bridge the remaining gap. Only
//      names the local machine wrote about itself ever enter it, which is what
//      keeps a genuinely foreign host from ever matching.

/**
 * Suffixes stripped by {@link stableHostname}. mDNS (`.local`), the common
 * router-assigned search domains (`.home`, `.lan`), and the POSIX default
 * (`.localdomain`). Deliberately NOT a generic "strip the last label" rule:
 * `a.b.example.com` is a real FQDN whose labels carry meaning.
 */
const LOCAL_HOST_SUFFIXES = ['.local', '.home', '.lan', '.localdomain'];

/**
 * Normalise a hostname into a comparable form: trimmed, lowercased, with ONE
 * trailing local-network suffix removed.
 *
 * Never throws. A non-string, empty, or whitespace-only input yields `''`
 * (which {@link hostnamesMatch} treats as "no identity" — it never matches).
 *
 * NOTE on the default: `stableHostname()` and `stableHostname(undefined)` both
 * normalise `os.hostname()`, because that is JavaScript default-parameter
 * semantics. Pass `''` or `null` to get the empty result.
 *
 * @param {string} [raw=os.hostname()]
 * @returns {string} normalised hostname, or '' when there is nothing to normalise.
 */
export function stableHostname(raw = os.hostname()) {
  if (typeof raw !== 'string') return '';
  let name = raw.trim().toLowerCase();
  if (name === '') return '';
  for (const suffix of LOCAL_HOST_SUFFIXES) {
    // `name.length > suffix.length` keeps a bare `.local` from normalising to ''.
    if (name.endsWith(suffix) && name.length > suffix.length) {
      name = name.slice(0, -suffix.length);
      break; // ONE suffix only — `foo.lan.local` keeps its inner label.
    }
  }
  return name;
}

/**
 * Host-alias ledger path. `SO_HOST_ALIASES_FILE` overrides it — MANDATORY for
 * tests, which must never write into the operator's real `~/.config`.
 *
 * The `.trim() || fallback` shape is deliberate: a whitespace-only env var is
 * truthy and would otherwise short-circuit the `||` (see `.claude/rules/
 * development.md` § Error Handling, env-var fallback whitespace trap).
 *
 * @returns {string}
 */
function _hostAliasesFile() {
  const override = (process.env.SO_HOST_ALIASES_FILE || '').trim();
  if (override) return override;
  return path.join(_privateDir(), 'host-aliases.json');
}

/**
 * Named ceiling (BV-004): a machine realistically presents 2–4 spellings of
 * itself (`os.hostname()`, the mDNS variant, a DHCP-assigned name). 16 bounds
 * the pathological DHCP-churn case while leaving ample headroom. Revisit if a
 * real host is ever observed writing more than a handful of distinct names —
 * beyond that the ledger stops being an identity record and becomes a history.
 */
const HOST_ALIASES_MAX = 16;

/**
 * Synchronous atomic JSON write with an explicit mode. The async twin
 * `_writeJsonAtomic` below cannot serve the alias ledger: every caller of
 * {@link recordHostAlias} sits on a SYNCHRONOUS lock path. `io.mjs`'s
 * `writeJsonAtomicSync` is not reused because it offers no mode argument, and
 * 0o600 is the whole point of a file that lives beside `host-private.json`.
 *
 * @param {string} filePath
 * @param {*} data
 * @param {number} mode
 */
function _writeJsonAtomicSync(filePath, data, mode) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    // `flag: 'wx'` + `mode` on the CREATE, never a chmod after the rename.
    // Two distinct holes closed: `wx` fails with EEXIST rather than following a
    // pre-planted symlink at the (predictable) tmp path, so an attacker cannot
    // redirect the write; and the mode is applied at creation, so the file is
    // never briefly world-readable between `writeFileSync` and `chmodSync` —
    // the window in which the ledger beside `host-private.json` was readable.
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode, flag: 'wx' });
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  // Belt-and-braces for the pre-existing-target case: `rename` keeps the
  // SOURCE inode, so the mode above already governs — this only repairs a
  // umask-widened mode on platforms that ignore the create mode.
  try { chmodSync(filePath, mode); } catch { /* best effort */ }
}

/**
 * Read the self-alias ledger. Returns normalised names.
 *
 * Fail-CLOSED by construction: any failure (absent file, unreadable, malformed
 * JSON, wrong shape) yields `[]`, which reduces {@link hostnamesMatch} to plain
 * normalised equality. A broken ledger can therefore only ever REFUSE a match
 * that would otherwise have been made — it can never manufacture one.
 *
 * @returns {string[]} normalised alias names; `[]` on any failure.
 */
export function readHostAliases() {
  try {
    const parsed = JSON.parse(readFileSync(_hostAliasesFile(), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    for (const entry of parsed) {
      const norm = typeof entry === 'string' ? stableHostname(entry) : '';
      if (norm) seen.add(norm);
    }
    return [...seen];
  } catch {
    return [];
  }
}

/**
 * Record the name this machine currently presents itself under, so a later
 * reading under a DIFFERENT spelling can still be recognised as the same host.
 *
 * Best-effort and idempotent: never throws, never duplicates, and writes
 * nothing when the name is already present or normalises away to ''. Callers
 * invoke it once per session-lock acquisition — the one moment we know for a
 * fact that the current `os.hostname()` belongs to THIS machine.
 *
 * @param {string} [name=stableHostname()] — raw or normalised hostname.
 * @returns {string[]} the ledger contents after the call (`[]` on failure).
 */
export function recordHostAlias(name = stableHostname()) {
  try {
    const norm = stableHostname(typeof name === 'string' ? name : '');
    if (!norm) return readHostAliases();
    const current = readHostAliases();
    if (current.includes(norm)) return current;
    // Keep the MOST RECENT names when the cap bites — an old spelling this
    // machine has not used in 16 renames is the safest one to forget.
    const next = [...current, norm].slice(-HOST_ALIASES_MAX);
    _writeJsonAtomicSync(_hostAliasesFile(), next, 0o600);
    return next;
  } catch {
    return [];
  }
}

/**
 * Decide whether two hostnames name the SAME machine.
 *
 * Match when the normalised forms are equal, or when BOTH appear in the
 * self-alias set (see {@link recordHostAlias}). Requiring both sides to be in
 * the set is what preserves the cross-host invariants: a foreign host's name
 * was never written by this machine, so it cannot be in the ledger, so it can
 * never match — `cross-host` stays `cross-host` (PSA-003).
 *
 * The ledger is read ONLY when normalised equality already failed, so the
 * common same-host path costs no filesystem access even inside a poll loop.
 *
 * @param {string} a
 * @param {string} b
 * @param {{ aliases?: string[] }} [opts] — inject the alias set (tests, and
 *   callers that already hold it); omitted → read the ledger.
 * @returns {boolean}
 */
export function hostnamesMatch(a, b, { aliases } = {}) {
  const normA = stableHostname(typeof a === 'string' ? a : '');
  const normB = stableHostname(typeof b === 'string' ? b : '');
  if (!normA || !normB) return false;
  if (normA === normB) return true;

  const set = Array.isArray(aliases)
    ? aliases.map((x) => (typeof x === 'string' ? stableHostname(x) : '')).filter(Boolean)
    : readHostAliases();
  return set.includes(normA) && set.includes(normB);
}

/**
 * Pick the host identity to compare a lock body against: the normalised
 * `host_id` when it carries one, else the raw pre-#1072 `host`.
 *
 * `||`, not `??`, and that is the whole point. `??` falls back on `null` and
 * `undefined` only, so a lock whose `host_id` is the EMPTY STRING — what a
 * writer produces when `os.hostname()` momentarily returns '' or whitespace —
 * short-circuits to `''`, and `hostnamesMatch('', host)` is false by contract
 * ("no identity never matches"). The machine then reads its OWN lock as
 * cross-host: stale detection is disabled, the reaper refuses with
 * `cross-host-requires-operator`, and release returns `not-owner` — the exact
 * #1072 failure the `host_id` field was added to prevent, re-entered through
 * the fallback operator. Falling back on '' costs nothing: an empty `host` too
 * yields '' here, and `hostnamesMatch` still refuses it.
 *
 * The `.trim()` extends the same fix one step: a whitespace-only `host_id` is
 * TRUTHY, so a bare `||` would short-circuit on it exactly as `??` does on `''`
 * (`.claude/rules/development.md` § Error Handling, env-var fallback whitespace
 * trap — the same shape, one domain over).
 *
 * @param {{ host_id?: unknown, host?: unknown }|null|undefined} lock
 * @returns {string} raw (un-normalised, but trimmed) candidate name; '' when
 *   neither field carries a usable value. Never throws.
 */
export function lockHostCandidate(lock) {
  const id = typeof lock?.host_id === 'string' ? lock.host_id.trim() : '';
  if (id) return id;
  return typeof lock?.host === 'string' ? lock.host.trim() : '';
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function _privateDir() {
  return path.join(os.homedir(), '.config', 'session-orchestrator');
}

function _privateFile() {
  return path.join(_privateDir(), 'host-private.json');
}

function _publicFile(projectRoot) {
  return path.join(projectRoot, '.orchestrator', 'host.json');
}

// ---------------------------------------------------------------------------
// Salt resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the per-host hash-salt. Reads from `~/.config/session-orchestrator/owner.yaml`
 * when present (Sub-Epic D+G #174 surface). Falls back to a placeholder constant
 * until owner.yaml exists — documented behavior during the interim period.
 *
 * The placeholder is intentionally known-public so that fingerprints produced
 * before owner.yaml lands can be regenerated against the real salt later without
 * ambiguity about which salt was used.
 */
export async function resolveSalt() {
  const ownerYaml = path.join(_privateDir(), 'owner.yaml');
  if (!existsSync(ownerYaml)) return PLACEHOLDER_SALT;
  try {
    const content = await readFile(ownerYaml, 'utf8');
    const match = content.match(/^\s*hash-salt:\s*["']?([^"'\n\r]+)["']?\s*$/m);
    if (match && match[1]) return match[1].trim();
  } catch {
    // Unreadable owner.yaml → fall through to placeholder
  }
  return PLACEHOLDER_SALT;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/**
 * Collect a fresh public (anonymized) fingerprint. Never reads or writes cache.
 * @param {object} [opts]
 * @param {string} [opts.salt] — override salt (tests)
 */
export async function collectFingerprint(opts = {}) {
  const { SO_OS, SO_PLATFORM } = await import('./platform.mjs');
  const osName = SO_OS;
  const arch = process.arch;
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model || '';
  const cpuCores = cpus.length;
  const ramTotalGb = Math.round(os.totalmem() / (1024 * 1024 * 1024));
  const hostname = os.hostname();
  const salt = opts.salt ?? (await resolveSalt());
  const hostnameHash = hashHostname(hostname, salt);
  const hostClass = classifyHost(osName, arch, cpuModel);
  // os.release() returns e.g. '23.3.0' on darwin or '5.15.0-91-generic' on linux.
  // Keep first two components to avoid leaking build numbers.
  const release = os.release();
  const osVersion = release.split('.').slice(0, 2).join('.');

  return {
    host_class: hostClass,
    os: osName,
    os_version: osVersion,
    cpu_cores: cpuCores,
    ram_total_gb: ramTotalGb,
    hostname_hash: hostnameHash,
    is_ssh: isSSH(),
    platform: SO_PLATFORM || null,
    first_seen: new Date().toISOString(),
  };
}

/**
 * Collect the private (local-only) twin.
 * @param {string} projectRoot — absolute path to the project root
 */
export function collectPrivateInfo(projectRoot) {
  return {
    hostname: os.hostname(),
    project_path: path.resolve(projectRoot),
    first_seen: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Cache management
// ---------------------------------------------------------------------------

async function _readJsonSafe(p) {
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function _writeJsonAtomic(filePath, data, { mode } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(tmp, filePath);
  if (mode !== undefined) {
    try { await chmod(filePath, mode); } catch { /* best effort */ }
  }
}

function _isFresh(entry, ttl) {
  if (!entry || !entry.first_seen) return false;
  const then = Date.parse(entry.first_seen);
  if (Number.isNaN(then)) return false;
  return Date.now() - then < ttl;
}

/**
 * Return the public fingerprint for the given project. Reads cache at
 * `.orchestrator/host.json` and returns it when fresh (<24h). Otherwise
 * collects and caches anew.
 * @param {string} projectRoot — absolute path to project root
 * @param {object} [opts]
 * @param {boolean} [opts.force] — force refresh
 * @param {number}  [opts.ttl]   — cache ttl in ms (default 24h)
 * @param {string}  [opts.salt]  — salt override (tests)
 */
export async function getHostFingerprint(projectRoot, opts = {}) {
  const ttl = opts.ttl ?? FINGERPRINT_TTL_MS;
  const cacheFile = _publicFile(projectRoot);

  if (!opts.force) {
    const cached = await _readJsonSafe(cacheFile);
    if (_isFresh(cached, ttl)) return cached;
  }

  const fresh = await collectFingerprint({ salt: opts.salt });
  await _writeJsonAtomic(cacheFile, fresh);
  return fresh;
}

/**
 * Return the private (raw hostname + project path) twin. Also refreshes the
 * local file at `~/.config/session-orchestrator/host-private.json` if absent.
 * Never leaves the local filesystem.
 * @param {string} projectRoot — absolute path to project root
 */
export async function getPrivateHostInfo(projectRoot) {
  const f = _privateFile();
  const cached = await _readJsonSafe(f);
  if (cached && _isFresh(cached, FINGERPRINT_TTL_MS) && cached.project_path === path.resolve(projectRoot)) {
    return cached;
  }
  const fresh = collectPrivateInfo(projectRoot);
  await _writeJsonAtomic(f, fresh, { mode: 0o600 });
  return fresh;
}
