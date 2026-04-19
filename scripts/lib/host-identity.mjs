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
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { SO_OS, SO_PLATFORM } from './platform.mjs';

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
  const h = createHash('sha256');
  h.update(String(salt));
  h.update('\x00');
  h.update(String(hostname));
  return h.digest('hex');
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
