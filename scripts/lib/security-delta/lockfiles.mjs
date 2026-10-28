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
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parseAllDocuments } from 'yaml';

import { gitEnv, isGitExecError, PATH_ABSENT } from './floating-tags.mjs';

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
 * Parsed package-lock.json v2/v3 → { packages: [{ name, version, resolved }], invalid: string[] }.
 * `invalid` names entries without a usable version (counted unchecked, never queried).
 */
function parsePackageLock(doc) {
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

/** Parsed pnpm-lock.yaml → { packages: [{ name, version, resolved }], invalid: string[] }. */
function parsePnpmLock(doc) {
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

/**
 * ALLOWLIST of requirements-file options (#1772): each maps to what its value
 * is. `index` values decide where pins come from (classified by host), `include`
 * values are `-r`/`-c` files (pip applies their index options to the whole
 * install), `other` values and `flag`s cannot redirect the source. Every option
 * NOT listed here — `--no-index`, `--use-feature`, any unknown long or short
 * option, an optparse prefix (`--index`), a stray positional token — makes the
 * whole install context unverifiable: the scanner never guesses pip semantics.
 */
const LONG_OPTIONS = new Map([
  ['index-url', 'index'],
  ['extra-index-url', 'index'],
  ['find-links', 'index'],
  ['requirement', 'include'],
  ['constraint', 'include'],
  ['hash', 'other'],
  ['only-binary', 'other'],
  ['no-binary', 'other'],
  ['trusted-host', 'other'],
  ['editable', 'other'], // an editable line is a local/VCS project, never a pin
  ['pre', 'flag'],
  ['prefer-binary', 'flag'],
  ['require-hashes', 'flag'],
]);
const SHORT_OPTIONS = new Map([
  ['i', 'index'],
  ['f', 'index'],
  ['r', 'include'],
  ['c', 'include'],
  ['e', 'other'],
]);
const PYPI_HOSTS = new Set(['pypi.org', 'files.pythonhosted.org']);

/**
 * pip reads a requirements file with Python's `str.splitlines()`, which also
 * breaks on a lone CR, form feed, vertical tab, the file/group/record
 * separators, NEL and U+2028/U+2029. Splitting on `\n` alone kept
 * `pin==1.0<CR>--index-url <private>` as one pin line and sent the name to OSV.
 * Built from char codes so no line-terminator character sits in the source.
 */
const PY_LINE_BREAK = new RegExp(`\r\n|[${String.fromCharCode(0x0a, 0x0d, 0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029)}]`);

/**
 * `resolved` marker for pins whose index could not be established (an include
 * or a pip.conf that cannot be read, an option outside the allowlist): not a
 * URL, so the public filter excludes them, and the OSV check counts each one
 * as an unchecked gap (`pip-index-unverifiable`) instead of a clean result.
 */
export const PIP_INDEX_UNVERIFIABLE = 'pip-index-unverifiable';

/**
 * Split an option line the way pip does (`shlex.split`, POSIX mode): whitespace
 * separates, single quotes are literal, double quotes honour `\"` and `\\`, a
 * backslash outside quotes escapes the next character. null = unbalanced quote
 * or dangling escape (pip itself would reject the line).
 */
function shellSplit(line) {
  const tokens = [];
  let cur = '';
  let inToken = false;
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else cur += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += c;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) tokens.push(cur);
      cur = '';
      inToken = false;
      continue;
    }
    inToken = true;
    if (c === "'" || c === '"') quote = c;
    else if (c === '\\') {
      if (i + 1 >= line.length) return null;
      cur += line[++i];
    } else cur += c;
  }
  if (quote !== null) return null;
  if (inToken) tokens.push(cur);
  return tokens;
}

/**
 * Tokens of one option line → every index value and include target on it, in
 * order (`--opt=v`, `--opt v`, `-iv`, `-i v`; exact long names only). `broken`
 * = a token outside the allowlist (LONG_OPTIONS / SHORT_OPTIONS), a value
 * option without a value, a flag given a value, or any value containing `${`
 * (pip expands `${VAR}` in requirements files; the expansion is not
 * reproduced, so the real host is unknown).
 */
function scanOptionTokens(tokens) {
  const indexes = [];
  const includes = [];
  let broken = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    let kind;
    let value;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      kind = LONG_OPTIONS.get((eq === -1 ? t.slice(2) : t.slice(2, eq)).toLowerCase());
      if (kind === 'flag') {
        if (eq !== -1) broken = true;
        continue;
      }
      if (kind !== undefined) value = eq === -1 ? tokens[++i] : t.slice(eq + 1);
    } else if (t.length >= 2 && t[0] === '-') {
      kind = SHORT_OPTIONS.get(t[1]);
      if (kind !== undefined) value = t.length > 2 ? t.slice(2) : tokens[++i];
    }
    if (kind === undefined || value === undefined || value === '' || value.includes('${')) {
      broken = true;
      continue;
    }
    if (kind === 'index') indexes.push(value);
    else if (kind === 'include') includes.push(value);
  }
  return { indexes, includes, broken };
}

/** Whether a requirements index option points at PyPI itself. */
function isPypiIndex(url) {
  try {
    return PYPI_HOSTS.has(new URL(url).hostname.toLowerCase());
  } catch {
    return false; // local find-links paths and unparseable URLs are not PyPI
  }
}

/** An index URL without its userinfo (`https://user:token@host/…` → `https://host/…`); non-URLs pass unchanged. */
function redactIndex(value) {
  try {
    const u = new URL(value);
    if (!u.username && !u.password) return value;
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return value;
  }
}

/**
 * requirements*.txt → { packages: [{ name, version, resolved }], unpinnedLines: string[], includes: string[], privateIndex: string|null }.
 * A non-PyPI `--index-url` / `--extra-index-url` / `--find-links` anywhere in
 * the file marks EVERY pin with that URL (userinfo stripped) as `resolved`, so
 * the public filter keeps all of them away from OSV (fail closed: pip may fetch
 * any of them there). Option lines are split like pip splits them (shlex), so
 * every index option of a line counts and quotes never reach the stored URL.
 * Option lines are judged against an ALLOWLIST (LONG_OPTIONS / SHORT_OPTIONS):
 * a line that does not split, an option outside the allowlist (`--no-index`,
 * `--use-feature`, unknown or prefixed names), a missing value, or a value
 * with `${` (pip's env expansion, not reproduced) marks the pins
 * PIP_INDEX_UNVERIFIABLE. `includes` lists the raw `-r`/`-c` targets; the
 * async caller resolves them in the include context of the ref
 * (`makeRequirementsContext`) together with the host's pip environment and
 * config files (`readHostPipIndex`, #1772).
 *
 * Ceilings (BV-004): (1) an index passed on the pip command line (CI scripts,
 * Dockerfiles) and pyproject/Pipfile `[[source]]` entries are not followed —
 * a private index configured only there is not seen and its pins read as
 * public. Revisit trigger: the first fleet repo that sets its index there.
 * (2) Options trailing a pin (`pkg==1 --hash=…`, `--config-settings`) are not
 * judged: pip accepts only per-requirement options there, none of which
 * selects an index. Revisit trigger: a pip release that adds one.
 */
function parseRequirements(text) {
  const packages = [];
  const unpinnedLines = [];
  const includes = [];
  let privateIndex = null;
  // pip semantics: a line ending in `\` continues on the next one, so an option
  // and its value (`--index-url \` + URL) or a pin and its `--hash` form one line.
  const lines = [];
  let pending = '';
  for (const raw of text.split(PY_LINE_BREAK)) {
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
      // Options, -r/-c includes, --hash continuations: every index option of the
      // line counts; a line pip's shlex split rejects is unverifiable.
      const tokens = shellSplit(line);
      const opts = tokens === null ? null : scanOptionTokens(tokens);
      if (opts === null || opts.broken) privateIndex ??= PIP_INDEX_UNVERIFIABLE;
      if (opts === null) continue;
      const priv = opts.indexes.find((v) => !isPypiIndex(v));
      if (priv !== undefined) privateIndex ??= redactIndex(priv);
      includes.push(...opts.includes);
      continue;
    }
    // Env markers after `;`, then trailing per-requirement options (`--hash=…`).
    const spec = line.split(';')[0].split(/\s--?[A-Za-z]/)[0].trim();
    const pin = parsePin(spec);
    if (pin) packages.push({ ...pin, resolved: null });
    else unpinnedLines.push(spec);
  }
  if (privateIndex !== null) for (const p of packages) p.resolved = privateIndex;
  return { packages, unpinnedLines, includes, privateIndex };
}

/** Include depth beyond which a chain is not followed (and fails closed). */
const MAX_INCLUDE_DEPTH = 8;
/** Requirements files one ref's include context may parse; beyond it the changed file is unverifiable. */
const MAX_CONTEXT_FILES = 256;

/** git modes of a regular blob; anything else (symlink 120000, submodule 160000, absent) is opaque. */
const isRegularMode = (mode) => mode === '100644' || mode === '100755';

/**
 * `git ls-tree --full-tree -r -z <ref>` → Map(path → mode), root-relative even
 * when git runs from a subdirectory (without `--full-tree` ls-tree lists only
 * the cwd's subtree, shortened). The `diff --name-only` and `show <ref>:<path>`
 * calls of this module are root-relative already. Read once per ref; a git
 * failure rethrows (the file then counts unparsed).
 */
async function treeModes(git, ref) {
  const out = await git(['ls-tree', '--full-tree', '-r', '-z', ref]);
  const modes = new Map();
  for (const entry of String(out ?? '').split('\0')) {
    const m = /^(\d{6}) \S+ \S+\t([\s\S]+)$/.exec(entry);
    if (m) modes.set(m[2], m[1]);
  }
  return modes;
}

/**
 * The include context of one ref (#1772): pip applies every index option of
 * every file an install reads to the WHOLE install, so a requirements file
 * reached from a root that has (or reaches) a private or unverifiable source
 * shares that source. Roots are the tracked files `lockfileKind` reads as
 * requirements plus the changed file; edges are `-r`/`-c` includes. Files are
 * parsed once per ref (memoised), walks are cycle-safe and stop at depth 8.
 *
 * An OPAQUE member — not a regular blob (symlink, submodule), missing,
 * unreadable, or an include that leaves the tree (URL, absolute, `~`, `..`) —
 * has an unknown reach: it may include the changed file and carries an unknown
 * index. A closure with an opaque member is therefore treated like a truncated
 * one: every changed requirements file reads as unverifiable. That includes a
 * detected root that is itself a symlink (`requirements.txt` → `prod.in`).
 * The file budget (MAX_CONTEXT_FILES) is checked BEFORE each new file is read.
 *
 * Ceilings (BV-004): (1) a root with a non-standard name (`deps/prod.in`) that
 * is neither detected as requirements nor itself changed is not a root, so a
 * private index set only there does not reach the files it includes. Revisit
 * trigger: the first fleet repo that installs from such a file. (2) A symlink
 * is never followed, even a relative link to a regular blob inside the repo:
 * one tracked symlink anywhere in a requirements graph makes every changed
 * requirements file unverifiable (counted, never sent). Revisit trigger: a
 * fleet repo whose security-delta degrades on such a link.
 */
function makeRequirementsContext(git, ref) {
  let tree = null;
  const nodes = new Map(); // path → Promise<{ own: string|null, edges: string[], opaque: boolean }>
  const OPAQUE = { own: PIP_INDEX_UNVERIFIABLE, edges: [], opaque: true };

  const nodeFromParsed = (file, parsed) => {
    let own = parsed.privateIndex;
    let opaque = false;
    const edges = [];
    for (const target of parsed.includes) {
      const resolvedPath = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      const outside =
        /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('~') ||
        resolvedPath === '..' || resolvedPath.startsWith('../');
      if (outside) {
        // URL, absolute, home-relative or escaping: an unknown file with an unknown reach.
        own ??= PIP_INDEX_UNVERIFIABLE;
        opaque = true;
      } else edges.push(resolvedPath);
    }
    return { own, edges, opaque };
  };

  /** Over-budget signal: thrown before a read, caught in contextSource. */
  const OVER_BUDGET = Symbol('over-budget');

  const node = (file) => {
    if (!nodes.has(file)) {
      if (nodes.size >= MAX_CONTEXT_FILES) throw OVER_BUDGET;
      nodes.set(
        file,
        (async () => {
          // Missing, or a symlink / submodule (`git show` of a link yields its
          // target text): not readable as pip reads it.
          if (!isRegularMode((await tree).get(file))) return OPAQUE;
          const text = await showAt(git, ref, file);
          if (text === null) return OPAQUE;
          return nodeFromParsed(file, parseRequirements(text));
        })(),
      );
    }
    return nodes.get(file);
  };

  /** BFS from `root` → { members, source, truncated }; an opaque member truncates. */
  const closure = async (root) => {
    const members = new Set([root]);
    let frontier = [root];
    let source = null;
    let truncated = false;
    for (let depth = 0; frontier.length > 0; depth++) {
      const next = [];
      for (const file of frontier) {
        const { own, edges, opaque } = await node(file);
        source ??= own;
        if (opaque) truncated = true;
        for (const e of edges) {
          if (members.has(e)) continue;
          if (depth + 1 > MAX_INCLUDE_DEPTH) {
            truncated = true;
            continue;
          }
          members.add(e);
          next.push(e);
        }
      }
      frontier = next;
    }
    if (truncated) source ??= PIP_INDEX_UNVERIFIABLE;
    return { members, source, truncated };
  };

  /**
   * The source every pin of `file` shares through its context: a private index
   * (userinfo stripped), PIP_INDEX_UNVERIFIABLE, or null (public).
   */
  const contextSource = async (file, parsed) => {
    tree ??= treeModes(git, ref);
    // The changed file was already read at this ref (its mode is checked by the caller).
    if (!nodes.has(file)) nodes.set(file, Promise.resolve(nodeFromParsed(file, parsed)));
    const roots = [file, ...[...(await tree).keys()].filter((f) => f !== file && lockfileKind(f) === 'requirements')];
    if (roots.length > MAX_CONTEXT_FILES) return PIP_INDEX_UNVERIFIABLE;
    try {
      for (const root of roots) {
        const c = await closure(root);
        // A truncated walk (depth or opaque member) cannot rule out that it reaches `file`: fail closed.
        if (c.truncated) return c.source; // never null: closure() fills it on truncation
        if (c.source !== null && c.members.has(file)) return c.source;
      }
    } catch (err) {
      if (err === OVER_BUDGET) return PIP_INDEX_UNVERIFIABLE;
      throw err;
    }
    return null;
  };

  return {
    contextSource,
    /** The git mode of `file` at this ref, or undefined when it is not in the tree. */
    modeOf: async (file) => {
      tree ??= treeModes(git, ref);
      return (await tree).get(file);
    },
  };
}

const PIP_CONF_KEYS = ['index-url', 'extra-index-url', 'find-links'];
/** Sections pip install reads. */
const PIP_CONF_SECTIONS = ['global', 'install'];

/**
 * pip.conf text → the first non-PyPI index URL among the EFFECTIVE values of
 * `[global]` and `[install]` (`index-url`, `extra-index-url`, `find-links`;
 * multi-line values allowed), null when none, PIP_INDEX_UNVERIFIABLE when a
 * line does not parse as INI. configparser semantics: a `[DEFAULT]` key fills
 * only a section that EXISTS and does not set that key itself; with no
 * `[global]`/`[install]` section, `[DEFAULT]` is unused. Section names are
 * compared case-insensitively and a repeated section/key unions its values
 * (pip rejects both; the union only marks more pins private).
 */
function pipConfIndex(text) {
  const sections = new Map(); // section → Map(key → values[])
  let values = null; // value list of the current key, for continuation lines
  let current = null;
  // configparser reads in text mode: universal newlines, so a lone CR ends a line too.
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (/^\s*([#;].*)?$/.test(raw)) continue;
    if (/^\s/.test(raw)) {
      if (values === null) return PIP_INDEX_UNVERIFIABLE; // continuation without a key
      values.push(...raw.trim().split(/\s+/));
      continue;
    }
    const sec = /^\[([^\]]+)\]\s*$/.exec(raw);
    if (sec) {
      const name = sec[1].trim().toLowerCase();
      if (!sections.has(name)) sections.set(name, new Map());
      current = sections.get(name);
      values = null;
      continue;
    }
    const kv = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(raw);
    if (!kv || current === null) return PIP_INDEX_UNVERIFIABLE;
    const key = kv[1].toLowerCase().replace(/_/g, '-');
    if (!current.has(key)) current.set(key, []);
    values = current.get(key);
    if (kv[2].trim()) values.push(...kv[2].trim().split(/\s+/));
  }
  const defaults = sections.get('default') ?? new Map();
  const effective = [];
  for (const name of PIP_CONF_SECTIONS) {
    const section = sections.get(name);
    if (section === undefined) continue;
    for (const key of PIP_CONF_KEYS) effective.push(...(section.get(key) ?? defaults.get(key) ?? []));
  }
  const priv = effective.find((v) => !isPypiIndex(v));
  return priv === undefined ? null : redactIndex(priv);
}

/** Default pip.conf reader: text, or null when the file does not exist. Other errors throw. */
function defaultReadConfigFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * `PIP_CONFIG_FILE=<os.devnull>` is pip's documented switch that loads NO
 * config file at all; the PIP_* index variables still apply. pip compares the
 * UNTRIMMED value with `os.devnull`: `/dev/null` on POSIX, `nul` on Windows —
 * `nul` on macOS or ` /dev/null` disable nothing.
 */
function pipConfigFilesDisabled(env, platform) {
  return (env.PIP_CONFIG_FILE ?? '') === (platform === 'win32' ? 'nul' : '/dev/null');
}

/** Entries of a path-list env var, or the fallback list when unset/blank. */
function envPathList(value, fallback) {
  const entries = (value || '').split(path.delimiter).map((d) => d.trim()).filter(Boolean);
  return entries.length > 0 ? entries : fallback;
}

/**
 * The private index the HOST's pip would add to every requirements file:
 * `PIP_INDEX_URL` / `PIP_EXTRA_INDEX_URL` / `PIP_FIND_LINKS`, then every pip
 * config location (global: `/etc/pip.conf`, `$XDG_CONFIG_DIRS/pip/pip.conf`,
 * `$XDG_DATA_DIRS/pip/pip.conf`, macOS `/Library/Application Support/pip`,
 * `%ProgramData%\pip\pip.ini`; user: `$XDG_CONFIG_HOME/pip`, `~/.pip`,
 * `~/Library/Application Support/pip`, `%APPDATA%\pip`, `%USERPROFILE%\pip`;
 * site: `$VIRTUAL_ENV/pip.conf` and `pip.ini`; then `PIP_CONFIG_FILE`). Reading a location
 * pip would not read only marks more pins private. Returns the first non-PyPI
 * URL (userinfo stripped), PIP_INDEX_UNVERIFIABLE when a config file exists but
 * cannot be read or parsed (fail closed), or null.
 *
 * Ceiling (BV-004): the site config of an interpreter outside a venv
 * (`<sys.prefix>/pip.conf`) and app-bundle configs (a framework Python's
 * `.../Resources/pip.conf`) are not read — locating them needs the
 * interpreter. Revisit trigger: a fleet host whose private index is set there
 * (`python3 -I -m pip config debug` lists every location).
 *
 * @param {{env?: Record<string,string|undefined>, homeDir?: string, readConfigFile?: (file: string) => string|null, platform?: string}} [opts]
 *   `platform` decides pip's `os.devnull` for PIP_CONFIG_FILE (default process.platform)
 */
export function readHostPipIndex({ env = process.env, homeDir = homedir(), readConfigFile = defaultReadConfigFile, platform = process.platform } = {}) {
  for (const name of ['PIP_INDEX_URL', 'PIP_EXTRA_INDEX_URL', 'PIP_FIND_LINKS']) {
    const values = (env[name] || '').trim().split(/\s+/).filter(Boolean);
    const priv = values.find((v) => !isPypiIndex(v));
    if (priv !== undefined) return redactIndex(priv);
  }
  if (pipConfigFilesDisabled(env, platform)) return null;
  const xdg = (env.XDG_CONFIG_HOME || '').trim() || path.join(homeDir, '.config');
  const files = [
    '/etc/pip.conf',
    ...envPathList(env.XDG_CONFIG_DIRS, ['/etc/xdg']).map((d) => path.join(d, 'pip', 'pip.conf')),
    ...envPathList(env.XDG_DATA_DIRS, ['/usr/local/share', '/usr/share']).map((d) => path.join(d, 'pip', 'pip.conf')),
    '/Library/Application Support/pip/pip.conf',
    path.join(xdg, 'pip', 'pip.conf'),
    path.join(homeDir, '.pip', 'pip.conf'),
    path.join(homeDir, 'Library', 'Application Support', 'pip', 'pip.conf'),
  ];
  for (const name of ['ProgramData', 'APPDATA', 'USERPROFILE']) {
    const dir = (env[name] || '').trim();
    if (dir) files.push(path.join(dir, 'pip', 'pip.ini'));
  }
  // A venv's site file is pip.ini on Windows and pip.conf elsewhere; reading both only marks more pins private.
  const venv = (env.VIRTUAL_ENV || '').trim();
  if (venv) files.push(path.join(venv, 'pip.conf'), path.join(venv, 'pip.ini'));
  // pip opens the value as given (untrimmed).
  if (env.PIP_CONFIG_FILE) files.push(env.PIP_CONFIG_FILE);
  for (const file of files) {
    let text;
    try {
      text = readConfigFile(file);
    } catch {
      return PIP_INDEX_UNVERIFIABLE;
    }
    if (text === null || text === undefined) continue;
    const found = pipConfIndex(String(text));
    if (found !== null) return found;
  }
  return null;
}

/** A tracked pip.conf next to the requirements file or at the repo root, read at `ref`. */
async function trackedPipConfIndex(git, ref, file) {
  for (const dir of new Set([path.posix.dirname(file), '.'])) {
    const text = await showAt(git, ref, dir === '.' ? 'pip.conf' : `${dir}/pip.conf`);
    if (text === null) continue;
    const found = pipConfIndex(text);
    if (found !== null) return found;
  }
  return null;
}

/**
 * A lockfile whose text the JSON/YAML parser rejected (#1788). Only this and a
 * git-exec error count a file `unparsed`; any other throw (a TypeError in our
 * own traversal) is a defect and surfaces as `internal-error`.
 */
class LockfileParseError extends Error {
  constructor(cause) {
    super('lockfile text does not parse', { cause });
    this.name = 'LockfileParseError';
  }
}

/** Run a third-party parser; whatever it throws (SyntaxError, YAMLParseError, alias-limit ReferenceError) is a parse failure. */
function parseWith(parser, text) {
  try {
    return parser(text);
  } catch (err) {
    throw new LockfileParseError(err);
  }
}

/**
 * Every YAML document of a pnpm-lock.yaml (#5725). pnpm 12 with a
 * `packageManager` field writes the package manager's own dependencies (pnpm,
 * `@pnpm/exe.*`) as a FIRST document ahead of the project lockfile — measured on
 * a pnpm 12.3.4 lockfile: `yaml.parse` refuses it with `MULTIPLE_DOCS`, so the
 * whole file counted `unparsed` and none of its new packages reached OSV. Both
 * documents are installs from the registry, so both are read. `parseAllDocuments`
 * does not throw; a document carrying errors is a parse failure like before.
 *
 * @param {string} text
 * @returns {object[]} one plain object per document
 */
function parsePnpmDocuments(text) {
  const docs = parseAllDocuments(text);
  const list = Array.isArray(docs) ? docs : [];
  for (const doc of list) if (doc.errors.length > 0) throw doc.errors[0];
  return list.map((doc) => doc.toJS());
}

/** Packages of every pnpm document, in document order (the delta dedupes). */
function parsePnpmLocks(docs) {
  const packages = [];
  const invalid = [];
  for (const doc of docs) {
    const one = parsePnpmLock(doc);
    packages.push(...one.packages);
    invalid.push(...one.invalid);
  }
  return { packages, invalid };
}

function parseLockfile(kind, text) {
  if (text === null) return { packages: [], invalid: [], unpinnedLines: [] };
  switch (kind) {
    case 'package-lock':
      return { ...parsePackageLock(parseWith(JSON.parse, text)), unpinnedLines: [] };
    case 'pnpm':
      return { ...parsePnpmLocks(parseWith(parsePnpmDocuments, text)), unpinnedLines: [] };
    case 'uv':
      return { ...parseUvLock(text), unpinnedLines: [] };
    default:
      return { ...parseRequirements(text), invalid: [] };
  }
}

/**
 * The git runner the lockfile reader uses by default, bound to `repoRoot`;
 * resolves stdout, rejects with the execFile error (`isGitExecError`).
 * @param {string} repoRoot
 * @returns {(args: string[]) => Promise<string>}
 */
export function defaultRunGit(repoRoot) {
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

/**
 * Mark every pin of the head version of a requirements file private when its
 * index is set outside the file: the host's pip environment (`hostPip`), the
 * file's include context at head (`contextSource`), or a tracked pip.conf at
 * head (skipped when `PIP_CONFIG_FILE=/dev/null` disables config files).
 * Only head matters: base pins are subtracted by name and version alone.
 */
async function applyRequirementsSources(git, head, file, parsed, hostPip, contextSource, configFilesDisabled) {
  if (parsed.packages.length === 0 || parsed.privateIndex !== null) return parsed;
  const source =
    hostPip() ??
    (await contextSource(file, parsed)) ??
    (configFilesDisabled ? null : await trackedPipConfIndex(git, head, file));
  if (source !== null) for (const p of parsed.packages) p.resolved = source;
  return parsed;
}

/** One changed lockfile → its introduced packages, new unpinned lines and new invalid entries. */
async function deltaForFile(git, base, head, file, pip) {
  const kind = lockfileKind(file);
  const [baseText, headText] = await Promise.all([showAt(git, base, file), showAt(git, head, file)]);
  const before = parseLockfile(kind, baseText);
  let after = parseLockfile(kind, headText);
  // A changed requirements file that is not a regular blob at head (symlink
  // 120000, submodule 160000) parsed as its link text: its real pins are
  // unknown, so it counts unparsed. An entry missing from the full tree while
  // `show` read the file cannot occur with real git (`--full-tree`); it is parsed.
  if (kind === 'requirements' && headText !== null) {
    const mode = await pip.modeOf(file);
    if (mode !== undefined && !isRegularMode(mode)) return { packages: [], unpinned: 0, invalid: 1 };
  }
  if (kind === 'requirements') {
    after = await applyRequirementsSources(git, head, file, after, pip.hostPip, pip.contextSource, pip.configFilesDisabled);
  }
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
 * @param {Record<string,string|undefined>} [opts.env]  host env for the pip index lookup (default process.env)
 * @param {string} [opts.homeDir]  home for the pip.conf locations (default os.homedir())
 * @param {(file: string) => string|null} [opts.readConfigFile]  pip.conf reader; null = absent
 * @param {string} [opts.platform]  host platform for pip's `os.devnull` (default process.platform)
 * @returns {Promise<{packages: {ecosystem:'npm'|'PyPI', name:string, version:string, file:string, resolved:string|null}[], unpinned:number, unparsed:number, files:string[]}>}
 *   `packages` = only pairs added or version-changed in head; `unpinned` = new
 *   non-`==` requirement lines in head; `unparsed` = lockfiles that could not
 *   be read or parsed plus new entries without a usable version (each costs
 *   only itself — the other files and entries are still measured);
 *   `files` = changed lockfiles. Any other error (a defect) rejects.
 */
export async function readLockfileDelta({ repoRoot, base, head, runGit, env, homeDir, readConfigFile, platform = process.platform } = {}) {
  const git = runGit ?? defaultRunGit(repoRoot);
  const nameOut = await git(['diff', '--name-only', '-z', base, head]);
  const files = nameOut.split('\0').filter((f) => f && lockfileKind(f) !== null);
  // Host pip state is read at most once, and only when a requirements file has pins.
  let hostPipCache;
  const pipEnv = env ?? process.env;
  const hostPip = () => {
    if (hostPipCache === undefined) hostPipCache = readHostPipIndex({ env: pipEnv, homeDir, readConfigFile, platform });
    return hostPipCache;
  };
  // One include context for head, shared by every changed requirements file.
  const context = makeRequirementsContext(git, head);
  const pip = {
    hostPip,
    contextSource: context.contextSource,
    modeOf: context.modeOf,
    configFilesDisabled: pipConfigFilesDisabled(pipEnv, platform),
  };

  const perFile = await Promise.all(
    files.map(async (file) => {
      try {
        return await deltaForFile(git, base, head, file, pip);
      } catch (err) {
        // Unreadable (git failed) or unparseable text costs only this file; any
        // other throw is a defect and must surface as `internal-error` (#1788).
        if (!(err instanceof LockfileParseError) && !isGitExecError(err)) throw err;
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

