/**
 * lockfiles.mjs — packages a session INTRODUCED via lockfile changes (#1769, stage 1).
 *
 * Reads every lockfile changed in `base..head` at both refs and returns only
 * the (name, version) pairs present in head but absent in base: new packages
 * and version changes. Unchanged packages never reach the OSV query.
 *
 * Supported: package-lock.json (v2/v3 `packages` map), pnpm-lock.yaml
 * (`packages:` keys, v5/v6/v9 forms), uv.lock (`[[package]]` blocks) and
 * requirements*.txt (exact `==` pins only).
 * Ceiling (BV-004): package-lock v1 (`dependencies` tree only), yarn.lock,
 * poetry.lock and Pipfile.lock are not read — revisit when a fleet repo
 * commits one of them.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parse as parseYaml } from 'yaml';

import { gitEnv, PATH_ABSENT } from './floating-tags.mjs';

const execFileAsync = promisify(execFile);

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Which parser handles a basename; null = not a lockfile. */
function lockfileKind(file) {
  const parts = file.split('/');
  if (parts.includes('node_modules')) return null;
  const base = parts[parts.length - 1];
  if (base === 'package-lock.json') return 'package-lock';
  if (base === 'pnpm-lock.yaml') return 'pnpm';
  if (base === 'uv.lock') return 'uv';
  if (/^requirements.*\.txt$/.test(base)) return 'requirements';
  return null;
}

/**
 * Marker for a package that comes from no registry (local path, git, …). Any
 * non-null, non-registry `resolved` value makes the public filter exclude it.
 */
const NON_REGISTRY = 'non-registry-source';

/** A version string OSV can answer for; blank reads as "any version" there. */
function isUsableVersion(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * package-lock.json v2/v3 → { packages: [{ name, version, resolved }], invalid: string[] }.
 * `invalid` names entries without a usable version (counted unchecked, never queried).
 */
function parsePackageLock(text) {
  const doc = JSON.parse(text);
  const packages = [];
  const invalid = [];
  for (const [key, entry] of Object.entries(doc?.packages ?? {})) {
    if (key === '' || !entry || typeof entry !== 'object' || entry.link === true) continue;
    const idx = key.lastIndexOf('node_modules/');
    if (idx === -1) continue; // workspace folder entries (`packages/foo`) are not registry packages
    const name = key.slice(idx + 'node_modules/'.length);
    if (!name || !isUsableVersion(entry.version)) {
      invalid.push(key);
      continue;
    }
    packages.push({ name, version: entry.version, resolved: typeof entry.resolved === 'string' ? entry.resolved : null });
  }
  return { packages, invalid };
}

/** v5 key shape: `name/1.2.3` or `@scope/name/1.2.3` (anything may follow the version). */
const PNPM_V5_KEY = /^(?:@[^/@]+\/)?[^/@]+\/\d/;

/** One pnpm `packages:` key → { name, version } or null. */
function parsePnpmKey(rawKey) {
  let key = String(rawKey);
  if (key.startsWith('/')) key = key.slice(1);
  if (PNPM_V5_KEY.test(key)) {
    // v5: the version segment follows the name; a `_peer@x` suffix may follow it.
    const firstSlash = key.indexOf('/');
    const slash = key.startsWith('@') ? key.indexOf('/', firstSlash + 1) : firstSlash;
    return { name: key.slice(0, slash), version: key.slice(slash + 1).split('_')[0] };
  }
  const paren = key.indexOf('(');
  if (paren !== -1) key = key.slice(0, paren); // v6/v9 peer suffix `(react@18.0.0)`
  const at = key.lastIndexOf('@');
  if (at > 0) return { name: key.slice(0, at), version: key.slice(at + 1) };
  return null;
}

/** pnpm keys that name a local or VCS source instead of a registry package. */
// `git@<host>:` is the scp form only; `git@0.1.5` is the public npm package `git`.
const PNPM_NON_REGISTRY_KEY = /^\/?(?:file:|link:|git\+|git:|git@[^:/@]+:|github:|github\.com\/|gitlab\.com\/|bitbucket\.org\/|https?:)/;

/** pnpm-lock.yaml → { packages: [{ name, version, resolved }], invalid: string[] }. */
function parsePnpmLock(text) {
  const doc = parseYaml(text);
  const packages = [];
  const invalid = [];
  for (const [key, entry] of Object.entries(doc?.packages ?? {})) {
    const parsed = parsePnpmKey(key);
    if (!parsed || !parsed.name || !isUsableVersion(parsed.version)) {
      if (!PNPM_NON_REGISTRY_KEY.test(key)) invalid.push(key);
      continue;
    }
    const resolution = entry?.resolution ?? {};
    let resolved = typeof resolution.tarball === 'string' ? resolution.tarball : null;
    // A URL/path "version" (`name@https://…`, `name@file:…`) is not a registry
    // version; carry it as `resolved` so the public filter can exclude it.
    if (resolved === null && parsed.version.includes(':')) resolved = parsed.version;
    // Directory / git resolutions and local/VCS keys never come from a registry.
    if (['directory', 'repo', 'commit', 'type'].some((f) => resolution[f] !== undefined) || PNPM_NON_REGISTRY_KEY.test(key)) {
      resolved = NON_REGISTRY;
    }
    packages.push({ name: parsed.name, version: parsed.version, resolved });
  }
  return { packages, invalid };
}

const TOML_STRING = /^"((?:[^"\\]|\\.)*)"/;

/** uv.lock → { packages: [{ name, version, resolved }], invalid: string[] }; hand-parsed, no TOML dependency. */
function parseUvLock(text) {
  const out = [];
  const invalid = [];
  let current = null;
  const flush = () => {
    if (current?.name && isUsableVersion(current.version)) out.push(current);
    // A local project may legitimately carry no version (dynamic); it is never queried anyway.
    else if (current?.name && current.resolved !== 'local-source') invalid.push(current.name);
    current = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === '[[package]]') {
      flush();
      current = { name: null, version: null, resolved: null };
      continue;
    }
    if (line.startsWith('[')) {
      // Any other table header ends the top-level keys of the current block.
      flush();
      continue;
    }
    if (!current) continue;
    const m = /^(name|version|source)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'source') {
      // `{ registry = "url" }` / `{ git = "url" }` / `{ url = "url" }` carry a host;
      // `{ editable = "." }` / `{ virtual = "." }` / `{ path = … }` are local
      // projects — mark them non-URL so the public filter excludes them.
      const urlMatch = /\b(?:registry|git|url)\s*=\s*"([^"]*)"/.exec(m[2]);
      current.resolved = urlMatch ? urlMatch[1] : 'local-source';
      continue;
    }
    const s = TOML_STRING.exec(m[2]);
    if (s) current[m[1]] = s[1];
  }
  flush();
  return { packages: out, invalid };
}

// Linear-time pieces of a `name[extras]==version` pin (no backtracking across
// adjacent `\s*` groups — a 50,000-space line took >1 s with the old pattern).
const REQ_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REQ_VERSION = /^[^\s=,;<>!~]+$/;

/** `name[extras]==version` → { name, version } or null. */
function parsePin(spec) {
  const eq = spec.indexOf('==');
  if (eq === -1) return null;
  let name = spec.slice(0, eq).trim();
  const bracket = name.indexOf('[');
  if (bracket !== -1) {
    if (!name.endsWith(']')) return null;
    name = name.slice(0, bracket).trim();
  }
  const version = spec.slice(eq + 2).trim();
  if (!REQ_NAME.test(name) || !REQ_VERSION.test(version)) return null;
  return { name, version };
}

/** Index options whose URL decides where every pin of the file comes from. */
const INDEX_OPTION = /^(?:--index-url|--extra-index-url|--find-links|-i|-f)(?:\s*=\s*|\s+)?(\S+)/;
const PYPI_HOSTS = new Set(['pypi.org', 'files.pythonhosted.org']);

/** Whether a requirements index option points at PyPI itself. */
function isPypiIndex(url) {
  try {
    return PYPI_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false; // local find-links paths and unparseable URLs are not PyPI
  }
}

/**
 * requirements*.txt → { packages: [{ name, version, resolved }], unpinnedLines: string[] }.
 * A non-PyPI `--index-url` / `--extra-index-url` / `--find-links` anywhere in
 * the file marks EVERY pin with that URL as `resolved`, so the public filter
 * keeps all of them away from OSV (fail closed: pip may fetch any of them there).
 *
 * Ceiling (BV-004): `-r`/`-c` includes, `PIP_INDEX_URL` and `pip.conf` are not
 * followed — a private index configured only there is not seen and its pins
 * read as public. Revisit trigger: the first fleet repo that sets its index
 * outside the requirements file.
 */
function parseRequirements(text) {
  const packages = [];
  const unpinnedLines = [];
  let privateIndex = null;
  // pip semantics: a line ending in `\` continues on the next one, so an option
  // and its value (`--index-url \` + URL) or a pin and its `--hash` form one line.
  const lines = [];
  let pending = '';
  for (const raw of text.split(/\r?\n/)) {
    const stripped = raw.replace(/(^|\s)#.*$/, '').trim();
    if (stripped.endsWith('\\')) {
      pending += `${stripped.slice(0, -1).trim()} `;
      continue;
    }
    lines.push(pending + stripped);
    pending = '';
  }
  if (pending) lines.push(pending);
  for (const joined of lines) {
    const line = joined.trim();
    if (!line) continue;
    if (line.startsWith('-')) {
      // options, -r/-c includes, --hash continuations; only index URLs matter here
      const opt = INDEX_OPTION.exec(line);
      if (opt && privateIndex === null && !isPypiIndex(opt[1])) privateIndex = opt[1];
      continue;
    }
    // Env markers after `;`, then trailing per-requirement options (`--hash=…`).
    const spec = line.split(';')[0].split(/\s--?[A-Za-z]/)[0].trim();
    const pin = parsePin(spec);
    if (pin) packages.push({ ...pin, resolved: null });
    else unpinnedLines.push(spec);
  }
  if (privateIndex !== null) for (const p of packages) p.resolved = privateIndex;
  return { packages, unpinnedLines };
}

function parseLockfile(kind, text) {
  if (text === null) return { packages: [], invalid: [], unpinnedLines: [] };
  switch (kind) {
    case 'package-lock':
      return { ...parsePackageLock(text), unpinnedLines: [] };
    case 'pnpm':
      return { ...parsePnpmLock(text), unpinnedLines: [] };
    case 'uv':
      return { ...parseUvLock(text), unpinnedLines: [] };
    default:
      return { ...parseRequirements(text), invalid: [] };
  }
}

function defaultRunGit(repoRoot) {
  return async (args) => {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      maxBuffer: GIT_MAX_BUFFER,
      env: gitEnv(),
    });
    return stdout;
  };
}

/**
 * `git show <ref>:<file>`, or null when the file does not exist at that ref.
 * Any other failure (maxBuffer, bad ref, …) rethrows: an unread file is
 * unchecked, never "absent" (which would read as zero packages).
 */
async function showAt(runGit, ref, file) {
  try {
    return await runGit(['show', `${ref}:${file}`]);
  } catch (err) {
    if (PATH_ABSENT.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`)) return null;
    throw err;
  }
}

/** One changed lockfile → its introduced packages, new unpinned lines and new invalid entries. */
async function deltaForFile(git, base, head, file) {
  const kind = lockfileKind(file);
  const [baseText, headText] = await Promise.all([showAt(git, base, file), showAt(git, head, file)]);
  const before = parseLockfile(kind, baseText);
  const after = parseLockfile(kind, headText);
  const ecosystem = kind === 'package-lock' || kind === 'pnpm' ? 'npm' : 'PyPI';
  const seen = new Set(before.packages.map((p) => `${p.name}\0${p.version}`));
  const packages = [];
  for (const p of after.packages) {
    const key = `${p.name}\0${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key); // dedupe within the file as well
    packages.push({ ecosystem, name: p.name, version: p.version, file, resolved: p.resolved });
  }
  const oldUnpinned = new Set(before.unpinnedLines);
  const oldInvalid = new Set(before.invalid);
  return {
    packages,
    unpinned: after.unpinnedLines.filter((l) => !oldUnpinned.has(l)).length,
    invalid: after.invalid.filter((k) => !oldInvalid.has(k)).length,
  };
}

/**
 * Packages introduced by lockfile changes in `base..head`.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot   repository root (used by the default git runner)
 * @param {string} opts.base       base ref (full SHA)
 * @param {string} opts.head       head ref (full SHA)
 * @param {(args: string[]) => Promise<string>} [opts.runGit]  injectable git runner; resolves stdout
 * @returns {Promise<{packages: {ecosystem:'npm'|'PyPI', name:string, version:string, file:string, resolved:string|null}[], unpinned:number, unparsed:number, files:string[]}>}
 *   `packages` = only pairs added or version-changed in head; `unpinned` = new
 *   non-`==` requirement lines in head; `unparsed` = lockfiles that could not
 *   be read or parsed plus new entries without a usable version (each costs
 *   only itself — the other files and entries are still measured);
 *   `files` = changed lockfiles.
 */
export async function readLockfileDelta({ repoRoot, base, head, runGit } = {}) {
  const git = runGit ?? defaultRunGit(repoRoot);
  const nameOut = await git(['diff', '--name-only', '-z', base, head]);
  const files = nameOut.split('\0').filter((f) => f && lockfileKind(f) !== null);

  const perFile = await Promise.all(
    files.map(async (file) => {
      try {
        return await deltaForFile(git, base, head, file);
      } catch {
        return { packages: [], unpinned: 0, invalid: 1 };
      }
    }),
  );

  return {
    packages: perFile.flatMap((r) => r.packages),
    unpinned: perFile.reduce((n, r) => n + r.unpinned, 0),
    unparsed: perFile.reduce((n, r) => n + r.invalid, 0),
    files,
  };
}

