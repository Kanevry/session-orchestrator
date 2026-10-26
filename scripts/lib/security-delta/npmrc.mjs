/**
 * npmrc.mjs — the trust boundary in front of the OSV query (#1769, stage 1).
 *
 * Private package names must never leave the host. A package is sent to OSV
 * only when it provably comes from a public registry; every doubt excludes it
 * (fail closed). Excluded packages are neither findings nor unchecked items —
 * they are out of scope for a public advisory database.
 *
 * Policy sources (#1788), unioned — a non-npmjs registry in any of them counts:
 * - the repo's `.npmrc` files AT THE CHECKED REVISION `head` (root and next to
 *   each lockfile), read through git — never the working tree, which may lack
 *   the directory or differ from what was committed;
 * - `npm_config_*` environment variables (read the way npm reads them);
 * - the user config (`npm_config_userconfig`, else `~/.npmrc`).
 * Ceiling (BV-004): the global/builtin npmrc (`$PREFIX/etc/npmrc`,
 * `npm_config_globalconfig`) is not read. Revisit when a fleet host sets its
 * private registry only there.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isGitExecError } from './floating-tags.mjs';

const NPM_PUBLIC_HOST = 'registry.npmjs.org';
const PYPI_PUBLIC_HOSTS = new Set(['files.pythonhosted.org', 'pypi.org']);
/** Read errors that mean the file does not exist (measured 2026-10-24: a file as a path component → ENOTDIR). */
const ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);
/** Tree-entry modes of a regular file; a symlinked (120000), tree or submodule `.npmrc` is unreadable. */
const BLOB_MODES = new Set(['100644', '100755']);
/** `unreadable` label of the user config — never its absolute path, which names the home directory. */
const USER_NPMRC_LABEL = 'user:.npmrc';

/** Hostname of a URL, or null when it does not parse. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function emptyPolicy() {
  return { privateScopes: new Set(), privateDefaultRegistry: false, unreadable: [] };
}

/** Fold one config `key = value` into the policy; only `registry` and `@scope:registry` matter. */
function applyEntry(policy, key, rawValue) {
  const scoped = /^(@[^:\s=]+)\s*:\s*registry$/.exec(key);
  if (!scoped && key !== 'registry') return;
  const url = String(rawValue).trim().replace(/^["']|["']$/g, '');
  if (hostOf(url) === NPM_PUBLIC_HOST) return; // an unparseable URL counts as private
  if (scoped) policy.privateScopes.add(scoped[1]);
  else policy.privateDefaultRegistry = true;
}

/** True when `val` is wrapped in one pair of matching `"…"` or `'…'` quotes (ini `isQuoted`). */
function isQuoted(val) {
  return (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
}

/**
 * One key or value the way npm's `ini` parser (`unsafe`) reads it: trimmed; a
 * quoted string loses its quotes (double quotes then go through JSON.parse, so
 * `@`-style escapes resolve); an unquoted one ends at the first unescaped
 * `;` or `#` (inline comment) and keeps `\;` / `\#` as literal characters.
 */
function iniUnquote(raw) {
  let val = (raw || '').trim();
  if (isQuoted(val)) {
    if (val.charAt(0) === "'") val = val.slice(1, -1);
    try {
      val = JSON.parse(val);
    } catch {
      // not JSON: ini keeps the text as it stands
    }
    return String(val);
  }
  let esc = false;
  let out = '';
  for (const c of val) {
    if (esc) {
      out += '\\;#'.includes(c) ? c : `\\${c}`;
      esc = false;
    } else if (c === ';' || c === '#') break;
    else if (c === '\\') esc = true;
    else out += c;
  }
  if (esc) out += '\\';
  return out.trim();
}

/**
 * Fold the registry lines of one `.npmrc` text into the policy. Values are parsed, never echoed (SEC-008).
 *
 * Lines are read with npm's `ini` semantics (#1788 review — a quoted
 * `"@scope:registry"` key was ignored here while npm honoured it): comment
 * lines start with `;` or `#`, the key runs to the first `=`, key and value are
 * unquoted by `iniUnquote`, a trailing `[]` marks an array key, and every key
 * after a `[section]` header belongs to that section — npm reads registry
 * config from the top level only, so section keys are ignored.
 * Fail closed: npm expands an unescaped `${VAR}` in a key from the environment
 * at install time, so such a key may become any `@scope:registry`; it makes
 * the default registry private.
 * Ceiling (BV-004): a hand port of `ini` `decode`/`unsafe` plus the
 * `@npmcli/config` envReplace trigger — `ini` is only a transitive dependency,
 * so it is not imported. Revisit when npm changes its npmrc grammar or `ini`
 * becomes a direct dependency (then call `ini.decode`).
 */
function applyNpmrcText(policy, text) {
  let inSection = false;
  for (const line of String(text).split(/[\r\n]+/)) {
    if (!line || /^\s*[;#]/.test(line) || /^\s*$/.test(line)) continue;
    if (/^\[[^\]]*\]\s*$/.test(line)) {
      inSection = true;
      continue;
    }
    const m = /^([^=]+)(=(.*))?$/.exec(line);
    if (!m || inSection) continue;
    let key = iniUnquote(m[1]);
    if (key.length > 2 && key.endsWith('[]')) key = key.slice(0, -2);
    if (!key.startsWith('//') && /(?<!\\)\$\{[^${}]+\}/.test(key)) {
      policy.privateDefaultRegistry = true; // env-substituted key: its scope is unknowable here
      continue;
    }
    if (m[2] !== undefined) applyEntry(policy, key.replace(/\s+/g, ''), iniUnquote(m[3]));
  }
}

/** An `.npmrc` that exists but cannot be read: its scopes are unknown, so the default registry counts as private. */
function markUnreadable(policy, label) {
  policy.privateDefaultRegistry = true;
  policy.unreadable.push(label);
}

/**
 * `npm_config_*` keys the way npm itself reads them (@npmcli/config loadEnv):
 * case-insensitive prefix, empty values ignored, `_` after the first character
 * becomes `-`, then lowercased — so `NPM_CONFIG_REGISTRY` and
 * `npm_config_@acme:registry` both count.
 */
function envConfig(env) {
  const out = new Map();
  for (const [envKey, value] of Object.entries(env ?? {})) {
    if (!/^npm_config_/i.test(envKey) || typeof value !== 'string' || value === '') continue;
    let key = envKey.slice('npm_config_'.length);
    if (!key.startsWith('//')) key = key.replace(/(?!^)_/g, '-').toLowerCase();
    out.set(key, value);
  }
  return out;
}

/**
 * The host part of the policy: `npm_config_*` environment variables and the
 * user config file. A non-npmjs registry there counts as private (fail closed),
 * even where a project `.npmrc` would override it for npm itself.
 * An existing but unreadable user config fails closed like a repo `.npmrc` (#1775).
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]  environment (tests pass a synthetic one)
 * @param {string} [opts.homeDir]         home directory holding the default `~/.npmrc`
 * @returns {{privateScopes: Set<string>, privateDefaultRegistry: boolean, unreadable: string[]}}
 */
export function readHostNpmrcPolicy({ env = process.env, homeDir = os.homedir() } = {}) {
  const policy = emptyPolicy();
  const config = envConfig(env);
  for (const [key, value] of config) applyEntry(policy, key, value);
  const userconfig = config.get('userconfig') ?? path.join(homeDir, '.npmrc');
  const read = readUserConfigFile(userconfig);
  if (read.absent) return policy;
  if (read.unreadable) markUnreadable(policy, USER_NPMRC_LABEL);
  else applyNpmrcText(policy, read.text);
  return policy;
}

/**
 * Read the user config only if its FINAL target is a regular file: `{ text }`,
 * `{ absent: true }` or `{ unreadable: true }`. A symlink to a regular file is
 * read — dotfile managers symlink `~/.npmrc`, and degrading every run for that
 * would be a broken instrument (HR-101). The stat (following links) decides:
 * nothing there — confirmed by lstat, so a dangling link is not "absent" (#1775)
 * — is absent; a directory, FIFO, socket, device or dangling link is unreadable
 * (#1788 review — a FIFO blocked the synchronous read before any network
 * deadline applied, `/dev/null` read as an empty public policy). The open adds
 * `O_NONBLOCK` where defined, and the handle's fstat must be the same regular
 * file (dev/ino) as the stat, so a swap in between is unreadable too. win32
 * defines no `O_NONBLOCK`; there the identity check stands alone and the
 * filesystem has no FIFOs (see no-follow-open.mjs).
 * Only the user config goes through here; the committed `.npmrc` is read from
 * `head` via git and keeps its own symlink rule (readNpmrcAt).
 */
function readUserConfigFile(file) {
  let before;
  try {
    before = statSync(file);
  } catch (err) {
    if (!ABSENT_CODES.has(err?.code)) return { unreadable: true };
    try {
      lstatSync(file);
      return { unreadable: true }; // something exists (a dangling link): fail closed
    } catch (lerr) {
      return ABSENT_CODES.has(lerr?.code) ? { absent: true } : { unreadable: true };
    }
  }
  if (!before.isFile()) return { unreadable: true };
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return { unreadable: true };
    return { text: readFileSync(fd, 'utf8') };
  } catch {
    return { unreadable: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * `<dir>/.npmrc` at `head`: `{ text }`, `{ absent: true }` or `{ unreadable: true }`.
 * Absence is read from the listing of the tree `<head>:<dir>` (exit 0 without a
 * `.npmrc` entry), never from an error message: git words a missing object like
 * a missing path. A git failure or a non-blob entry is unreadable; any other
 * error is a defect and rethrows (→ the caller's `internal-error`).
 */
async function readNpmrcAt(runGit, head, dir) {
  try {
    const listing = await runGit(['ls-tree', '-z', `${head}:${dir === '.' ? '' : dir}`]);
    const entry = String(listing)
      .split('\0')
      .map((line) => /^(\d+) (\w+) ([0-9a-f]+)\t(.*)$/s.exec(line))
      .find((m) => m?.[4] === '.npmrc');
    if (!entry) return { absent: true };
    if (!BLOB_MODES.has(entry[1]) || entry[2] !== 'blob') return { unreadable: true };
    return { text: await runGit(['cat-file', 'blob', entry[3]]) };
  } catch (err) {
    if (!isGitExecError(err)) throw err;
    return { unreadable: true };
  }
}

/**
 * The registry policy that governs one lockfile at the checked revision: the
 * `.npmrc` of the repo root and, when `dir` is a subdirectory, the one next to
 * the lockfile — both read from `head` via git (#1788) — unioned with the host
 * policy. A private scope or a non-npmjs default registry in any source counts.
 *
 * An `.npmrc` that exists at `head` but cannot be read (git failure, symlink,
 * tree, submodule) fails closed (#1775): its private scopes are unknown, so the
 * default registry counts as private — every npm package without a
 * registry.npmjs.org `resolved` URL is then excluded — and it is listed in
 * `unreadable` so the caller reports degraded.
 * Ceiling (BV-004): a package whose `resolved` URL IS registry.npmjs.org still
 * passes, exactly as with a readable `.npmrc` (npmjs-hosted private packages are
 * not detectable from the lockfile either way).
 *
 * @param {object} opts
 * @param {string} opts.head  checked revision (full SHA)
 * @param {(args: string[]) => Promise<string>} opts.runGit  git runner bound to the repository
 * @param {string} [opts.dir]  repo-relative posix directory of the lockfile (default `.`)
 * @param {ReturnType<typeof readHostNpmrcPolicy>} [opts.host]  host policy; read fresh when omitted
 * @returns {Promise<{privateScopes: Set<string>, privateDefaultRegistry: boolean, unreadable: string[]}>}
 *   `unreadable`: `.npmrc` labels (repo-relative, or `user:.npmrc`) that exist but could not be read
 */
export async function readNpmrcPolicy({ head, runGit, dir = '.', host = readHostNpmrcPolicy() }) {
  const policy = emptyPolicy();
  for (const scope of host.privateScopes) policy.privateScopes.add(scope);
  policy.privateDefaultRegistry = host.privateDefaultRegistry;
  policy.unreadable.push(...host.unreadable);
  for (const d of new Set(['.', path.posix.normalize(dir || '.')])) {
    const read = await readNpmrcAt(runGit, head, d);
    if (read.absent) continue;
    if (read.unreadable) markUnreadable(policy, path.posix.join(d, '.npmrc'));
    else applyNpmrcText(policy, read.text);
  }
  return policy;
}

function isPublic(pkg, privateScopes, privateDefaultRegistry) {
  if (!pkg || typeof pkg.name !== 'string' || pkg.name.length === 0) return false;
  for (const scope of privateScopes) {
    if (pkg.name.startsWith(`${scope}/`)) return false;
  }
  const resolved = pkg.resolved ?? null;
  if (pkg.ecosystem === 'npm') {
    // No resolved URL: the package came from the default registry — public only if that is npmjs.
    if (resolved === null) return !privateDefaultRegistry;
    return hostOf(resolved) === NPM_PUBLIC_HOST;
  }
  if (pkg.ecosystem === 'PyPI') {
    return resolved === null || PYPI_PUBLIC_HOSTS.has(hostOf(resolved));
  }
  return false; // unknown ecosystem: no public registry to vouch for it
}

/**
 * Split packages into the ones that may be sent to OSV and a count of the rest.
 * Excluded: a private scope prefix, an npm package not resolved from
 * registry.npmjs.org (or without a resolved URL while the default registry is
 * private), a PyPI package resolved from a non-PyPI host, an unparseable
 * `resolved` URL, or an unknown ecosystem.
 *
 * @param {{ecosystem:string, name:string, resolved?:string|null}[]} packages
 * @param {{privateScopes?: Set<string>, privateDefaultRegistry?: boolean}} [opts]
 * @returns {{public: object[], excluded: number}}
 */
export function filterPublicPackages(packages, { privateScopes = new Set(), privateDefaultRegistry = false } = {}) {
  const pub = [];
  let excluded = 0;
  for (const pkg of packages ?? []) {
    if (isPublic(pkg, privateScopes, privateDefaultRegistry)) pub.push(pkg);
    else excluded += 1;
  }
  return { public: pub, excluded };
}
