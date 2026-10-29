/**
 * spawn.mjs — throttled, detached start of the security-pulse refresher (#1769, stage 2).
 *
 * Modelled on `scripts/lib/orphan-reaper/trigger.mjs`: the probe never waits for
 * the refresher, the child is `detached` with `stdio: 'ignore'` and `unref()`-ed,
 * and a per-repo marker throttles spawns to one per {@link SPAWN_THROTTLE_MS}.
 *
 * The throttle is a CLAIM, not a check-then-write: a session may spawn only after
 * it exclusively created `<marker>.claim` (`wx`, O_CREAT|O_EXCL — atomic on POSIX
 * and NTFS), re-read the marker under that claim and published its stamp by
 * renaming the claim over the marker. Two sessions starting at once therefore
 * spawn one child, and a claim that cannot be persisted spawns none (fail closed
 * for the side effect: an unwritable cache dir means the refresher could not
 * write its result either).
 */
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensurePrivateDir, stampMs } from './cache.mjs';
import { spawn } from '../native-command.mjs';

/** At most one refresher spawn per repo per 10 min. */
export const SPAWN_THROTTLE_MS = 10 * 60 * 1000;

/**
 * NAMED CEILING (BV-004): a claim older than this is abandoned (its holder died
 * between create and rename, which takes milliseconds) and may be broken.
 * Revisit if a claim is ever legitimately held longer (a hung fsync on a network FS).
 */
export const CLAIM_STALE_MS = 60 * 1000;

/** Env switch: `off` disables the refresher spawn (the test suite sets it fail-closed). */
export const REFRESH_SWITCH_ENV = 'SO_SECURITY_PULSE_REFRESH';

export const REFRESH_CLI = fileURLToPath(new URL('../../security-pulse-refresh.mjs', import.meta.url));

/**
 * Exact names (compared case-insensitively — Windows env names are) the
 * detached refresher may inherit. Each is read by the child or by what it runs:
 *   - PATH, PATHEXT: resolving `git` (defaultRunGit / execFile).
 *   - HOME, USERPROFILE, HOMEDRIVE, HOMEPATH: `os.homedir()` → the private config
 *     dir, `~/.npmrc` (readHostNpmrcPolicy) and git's global config (safe.directory).
 *   - TMPDIR, TEMP, TMP: `os.tmpdir()` for git and node.
 *   - SystemRoot, ComSpec, WINDIR: Windows process/DNS/TLS basics for node and git.
 *   - XDG_CONFIG_HOME: `resolvePrivateConfigDir()` tier 2 (where the cache lives).
 *   - NODE_EXTRA_CA_CERTS, NODE_USE_SYSTEM_CA, SSL_CERT_FILE, SSL_CERT_DIR: TLS
 *     trust behind a corporate CA (https to nodejs.org / cisa.gov / OSV).
 *   - HTTPS_PROXY, HTTP_PROXY, NO_PROXY (+ lower case via case-insensitivity),
 *     NODE_USE_ENV_PROXY: proxy routing for node's https and git.
 *   - LANG, LC_ALL: locale (gitEnv() pins them anyway; harmless).
 * @type {ReadonlySet<string>}
 */
const CHILD_ENV_NAMES = new Set([
  'PATH', 'PATHEXT',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TMPDIR', 'TEMP', 'TMP',
  'SYSTEMROOT', 'COMSPEC', 'WINDIR',
  'XDG_CONFIG_HOME',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
  'LANG', 'LC_ALL',
]);

/**
 * Whether one env name may reach the detached refresher. Beyond the exact names:
 *   - `SO_*`: the plugin's own host-local switches (SO_CONFIG_HOME = cache dir).
 *   - `npm_config_*` (any case) ONLY when the key is `userconfig` or ends in
 *     `registry`: `readHostNpmrcPolicy` → `applyEntry` reads exactly `registry`
 *     and `@scope:registry` (plus `userconfig` to locate the file). Auth keys
 *     (`//host/:_authToken`, `_auth`, `_password`) are never read there and
 *     are therefore not passed.
 * @param {string} name
 * @returns {boolean}
 */
export function childEnvAllowed(name) {
  const upper = name.toUpperCase();
  if (CHILD_ENV_NAMES.has(upper)) return true;
  if (name.startsWith('SO_')) return true;
  if (upper.startsWith('NPM_CONFIG_')) {
    const key = name.slice('npm_config_'.length).toLowerCase();
    return key === 'userconfig' || key.endsWith('registry');
  }
  return false;
}

/**
 * The filtered env block of the detached refresher (names in
 * {@link childEnvAllowed}; empty and non-string values dropped).
 * @param {NodeJS.ProcessEnv} env
 * @returns {Record<string, string>}
 */
export function refresherEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value === 'string' && childEnvAllowed(name)) out[name] = value;
  }
  return out;
}

/**
 * Is a spawn allowed now? A missing, non-regular or future-dated marker allows
 * one (fail toward refreshing — the same direction as `scan-throttle.mjs`); the
 * claim in {@link maybeSpawnRefresh} still decides who actually spawns.
 * @param {string} markerPath
 * @param {number} nowMs
 * @returns {boolean}
 */
export function spawnAllowed(markerPath, nowMs) {
  let st;
  try {
    st = lstatSync(markerPath);
  } catch {
    return true;
  }
  if (!st.isFile() || st.size > 64) return true;
  // The marker carries the stamp of the clock that wrote it (the probe's `now`);
  // mtime is only the fallback for an unparseable body.
  let at;
  try {
    at = stampMs(readFileSync(markerPath, 'utf8').trim());
  } catch {
    at = null;
  }
  if (at === null) at = st.mtimeMs;
  if (at > nowMs) return true;
  return nowMs - at >= SPAWN_THROTTLE_MS;
}

/**
 * Default spawner: detached CLI child with a filtered env, never awaited.
 * @param {{repoRoot: string, env?: NodeJS.ProcessEnv, cli?: string}} opts
 *   `cli` replaces the refresher script (tests observe the child env with it)
 * @returns {import('node:child_process').ChildProcess}
 */
export function defaultSpawnRefresh({ repoRoot, env = process.env, cli = REFRESH_CLI }) {
  const child = spawn(process.execPath, [cli, '--repo-root', repoRoot], {
    detached: true,
    stdio: 'ignore',
    env: refresherEnv(env),
  });
  // An async spawn error (ENOENT, EAGAIN) must not become an unhandled 'error'.
  child.on?.('error', () => {});
  child.unref?.();
  return child;
}

/** @param {string} file */
function unlinkQuiet(file) {
  try { unlinkSync(file); } catch { /* already gone */ }
}

/**
 * Exclusively create `claimPath`. A claim older than {@link CLAIM_STALE_MS} is
 * broken once: renamed to a unique name (only one breaker's rename finds the
 * source) and the create retried.
 * @param {string} claimPath
 * @returns {{fd: number} | {busy: true} | {failed: true}}
 */
function openClaim(claimPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { fd: openSync(claimPath, 'wx', 0o600) };
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err)?.code !== 'EEXIST') return { failed: true };
    }
    if (attempt > 0) return { busy: true };
    let st;
    try {
      st = lstatSync(claimPath);
    } catch {
      continue; // released between our create and our stat: retry the create
    }
    if (Date.now() - st.mtimeMs < CLAIM_STALE_MS) return { busy: true };
    // NAMED CEILING (BV-004): the takeover is not owner-aware. If a claim owner
    // stalls longer than CLAIM_STALE_MS between creating its claim and renaming
    // it over the marker, a successor breaks the claim; the stalled owner can
    // then rename the successor's claim over the marker, and a third session can
    // spawn as well, so two refresher children run. Bounded: a 60 s stall
    // between two adjacent syscalls in a SessionStart hook is outside normal
    // operation, and the refresher takes the non-blocking host lock
    // `refresh.lock` (`refresh.mjs`, `tryAcquireFileLock`), so the second child
    // exits `skipped: locked` without network work. Revisit when a refresher run
    // that is not `skipped: locked` is seen while another refresher of the same
    // host is alive, or when CLAIM_STALE_MS is lowered.
    const tomb = `${claimPath}.${process.pid}.${Date.now()}.stale`;
    try {
      renameSync(claimPath, tomb);
    } catch {
      return { busy: true }; // another breaker won
    }
    unlinkQuiet(tomb);
  }
  return { busy: true };
}

/**
 * Throttled refresher start. Never throws.
 *
 * Results: `spawned`; `disabled` ({@link REFRESH_SWITCH_ENV}=off); `throttled`
 * (marker fresh, or another session holds the claim); `claim-failed` (the claim
 * could not be created or published — no spawn); `error` (anything else).
 *
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} opts.markerPath
 * @param {number} opts.nowMs
 * @param {NodeJS.ProcessEnv} [opts.env]  read for the switch (fallback `process.env`) and handed to the spawner
 * @param {(o: {repoRoot: string, env?: NodeJS.ProcessEnv}) => void} [opts.spawnRefresh]
 * @returns {'spawned'|'disabled'|'throttled'|'claim-failed'|'error'}
 */
export function maybeSpawnRefresh({ repoRoot, markerPath, nowMs, env, spawnRefresh = defaultSpawnRefresh }) {
  try {
    const switchValue = (env ?? process.env)[REFRESH_SWITCH_ENV];
    if (String(switchValue ?? '').trim().toLowerCase() === 'off') return 'disabled';
    if (!spawnAllowed(markerPath, nowMs)) return 'throttled';

    try {
      ensurePrivateDir(path.dirname(markerPath));
    } catch {
      return 'claim-failed';
    }
    const claimPath = `${markerPath}.claim`;
    const claim = openClaim(claimPath);
    if ('busy' in claim) return 'throttled';
    if ('failed' in claim) return 'claim-failed';

    // Under the claim: re-check, so a session that read the old marker just
    // before another one published its stamp does not spawn a second child.
    let fd = claim.fd;
    try {
      if (!spawnAllowed(markerPath, nowMs)) {
        closeSync(fd);
        fd = -1;
        unlinkQuiet(claimPath);
        return 'throttled';
      }
      writeSync(fd, `${new Date(nowMs).toISOString()}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = -1;
      // Publish the stamp and release the claim in one step. Stamp BEFORE
      // spawning: a spawn that throws synchronously is still throttled.
      renameSync(claimPath, markerPath);
    } catch {
      if (fd !== -1) {
        try { closeSync(fd); } catch { /* already closed */ }
      }
      unlinkQuiet(claimPath);
      return 'claim-failed';
    }
    spawnRefresh({ repoRoot, env });
    return 'spawned';
  } catch {
    return 'error';
  }
}
