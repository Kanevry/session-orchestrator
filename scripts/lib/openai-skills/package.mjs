/**
 * package.mjs — build and validate the OpenAI skills-only package (#1931).
 *
 * The OpenAI plugin directory (ChatGPT + Codex) accepts session-orchestrator
 * only as a skills-only package: no lifecycle hooks, no MCP configuration,
 * one plugin root with an Agent Plugins 1.0.0 `plugin.json`, and skills under
 * `skills/<name>/SKILL.md`. This module holds the pure-ish core; the CLI is
 * `scripts/export-openai-skills.mjs`. Rationale: docs/distribution/openai-skills-only.md.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  closeSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isAlias, isMap, parseDocument, visit } from 'yaml';

import { getAjv2020 } from '../ajv-loader.mjs';
import { renameSyncWithRetry } from '../io.mjs';
import { ZipFormatError, readZip } from './zip.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export const PLUGIN_NAME = 'session-orchestrator';
export const SCHEMA_URL = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const MAX_DESCRIPTION = 1024;
export const MAX_QUALIFIED_NAME = 64;
export const DEFAULT_REPO_ROOT = resolve(HERE, '..', '..', '..');
export const DEFAULT_OUT_DIR = join('.orchestrator', 'tmp', 'openai-skills');

const SCHEMA_PATH = join(HERE, 'plugin.schema.json');
const ALLOWLIST_PATH = join(HERE, 'allowlist.json');
// Names every allowlisted skill as "<name>:"; a test fails when the allowlist
// gains a skill this text does not name.
const MANIFEST_DESCRIPTION =
  'Working methods for coding agents from session-orchestrator. grill: stress-test a plan or design one question at a time against the real code. eli5: explain a result in plain words without dropping a fact. deepen: make a task deeper, not bigger, with an outside judge for the result. debug: find the root cause of a bug in four phases before any fix. Skills only, no hooks, no MCP servers.';

const HOOKS_SEGMENT = /^hooks(\.json)?$/i;
const MCP_SEGMENT = /^\.?mcp([_-]?servers)?\.json$/i;
const FORBIDDEN_KEY = /^(hooks|mcpservers|mcp_servers)$/i;
/** C0 controls and DEL; a NUL truncates the name in C-based extractors. */
const hasControlChar = (name) => [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/** The export refused to touch something it cannot prove it created. Exit 1, not 2. */
export class ExportRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportRefusedError';
  }
}

/**
 * @typedef {{ from: string, to: string, sections: string[] | null }} Include
 *   a declared file from outside the skill directory: `from` is repo-relative,
 *   `to` is relative to the skill directory, `sections` names the `## `
 *   headings to carry (null = the whole file)
 */

/** @returns {boolean} whether `p` is a relative POSIX path to a Markdown file without `..` or empty segments */
const isSafeMdPath = (p) =>
  typeof p === 'string' && p.endsWith('.md') && !p.startsWith('/') && !p.includes('\\') && !/^[A-Za-z]:/.test(p) &&
  p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');

/**
 * The reviewed allowlist: skill names and, per skill, the declared files from
 * outside its directory that the export carries (`include`).
 *
 * @param {{ allowlistPath?: string }} [opts]
 * @returns {Array<{ name: string, includes: Include[] }>} sorted by name
 * @throws {TypeError} on a malformed allowlist
 */
export function loadAllowlist({ allowlistPath = ALLOWLIST_PATH } = {}) {
  const data = JSON.parse(readFileSync(allowlistPath, 'utf8'));
  if (!data || !Array.isArray(data.skills)) throw new TypeError(`${allowlistPath}: "skills" must be an array`);
  return data.skills
    .map((s) => {
      const name = String(s.name);
      const raw = s.include ?? [];
      if (!Array.isArray(raw)) throw new TypeError(`${allowlistPath}: ${name}: "include" must be an array`);
      const includes = raw.map((inc) => {
        const where = `${allowlistPath}: ${name}: include ${JSON.stringify(inc)}`;
        if (!inc || !isSafeMdPath(inc.from) || !isSafeMdPath(inc.to)) {
          throw new TypeError(`${where}: "from" and "to" must be relative .md paths without ".."`);
        }
        if (inc.from.startsWith(`skills/${name}/`)) throw new TypeError(`${where}: "from" is inside the skill itself`);
        const sections = inc.sections ?? null;
        if (sections !== null && (!Array.isArray(sections) || sections.length === 0 || !sections.every((t) => typeof t === 'string' && t.trim() !== ''))) {
          throw new TypeError(`${where}: "sections" must be a non-empty array of heading titles`);
        }
        return { from: inc.from, to: inc.to, sections };
      });
      return { name, includes };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The reviewed skill selection.
 *
 * @param {{ allowlistPath?: string }} [opts]
 * @returns {string[]} skill directory names, sorted
 */
export function selectSkills(opts = {}) {
  return loadAllowlist(opts).map((s) => s.name);
}

/**
 * The declared includes per skill.
 *
 * @param {{ allowlistPath?: string }} [opts]
 * @returns {Record<string, Include[]>}
 */
export function selectIncludes(opts = {}) {
  return Object.fromEntries(loadAllowlist(opts).map((s) => [s.name, s.includes]));
}

/**
 * Cut the named level-2 sections out of a Markdown file. A section runs from
 * its `## <title>` line to the next `#` or `##` heading outside a code
 * fence; `###` subsections stay inside it. Deterministic: same input, same
 * bytes.
 *
 * @param {string} text
 * @param {string[]} titles in output order
 * @param {string} label source path, for error messages
 * @returns {string}
 * @throws {Error} when a title is not found exactly once
 */
export function extractSections(text, titles, label) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const heads = [];
  let fence = false;
  lines.forEach((line, i) => {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    else if (!fence && /^#{1,2} /.test(line)) heads.push({ i, level: line.indexOf(' '), title: line.slice(line.indexOf(' ') + 1).trim() });
  });
  const parts = titles.map((t) => {
    const hits = heads.filter((h) => h.level === 2 && h.title === t.trim());
    if (hits.length !== 1) throw new Error(`${label}: section "## ${t}" found ${hits.length} times, expected exactly once`);
    const next = heads.find((h) => h.i > hits[0].i);
    return lines.slice(hits[0].i, next ? next.i : lines.length).join('\n').trimEnd();
  });
  return `# Excerpt: ${titles.join(', ')}\n\n${parts.join('\n\n')}\n`;
}

/**
 * Apply a skill's declared includes to its exported files: add each included
 * file at `skills/<name>/<to>` and rewrite every mention of its repo path
 * (`from`) in the skill's Markdown files to the path inside the skill. Only
 * the exported copy changes; the source tree stays as it is.
 *
 * @param {string} name skill name
 * @param {Array<{path: string, data: Buffer}>} skillFiles the skill's files (mutated in place)
 * @param {Include[]} includes
 * @param {string} repoRoot
 * @throws {Error} when an include target collides with a skill file or the skill never mentions `from`
 */
function applyIncludes(name, skillFiles, includes, repoRoot) {
  for (const inc of includes) {
    const target = `skills/${name}/${inc.to}`;
    // Case-folded: on a case-insensitive volume (APFS) "skill.md" overwrites SKILL.md.
    const fold = (p) => p.normalize('NFC').toLowerCase();
    if (skillFiles.some((f) => fold(f.path) === fold(target))) throw new Error(`${target}: include target collides with a file of the skill`);
    let mentions = 0;
    for (const f of skillFiles) {
      if (!f.path.endsWith('.md')) continue;
      // split/join, not String.replace: a replacement string would read "$" patterns.
      const parts = f.data.toString('utf8').split(inc.from);
      if (parts.length === 1) continue;
      mentions += parts.length - 1;
      f.data = Buffer.from(parts.join(inc.to));
    }
    // A declaration nothing points at is stale; it would ship an orphan file.
    if (mentions === 0) throw new Error(`skills/${name}: include "${inc.from}" is declared but the skill never mentions it`);
    const sourcePath = join(repoRoot, ...inc.from.split('/'));
    if (lstatSync(sourcePath).isSymbolicLink()) throw new Error(`${inc.from}: include source is a symlink, refusing to package`);
    const source = readFileSync(sourcePath, 'utf8');
    const text = inc.sections ? extractSections(source, inc.sections, inc.from) : source;
    skillFiles.push({ path: target, data: Buffer.from(text) });
  }
}

/**
 * Normalise an npm repository field to a browsable URL string.
 *
 * @param {unknown} repo
 * @returns {string|undefined}
 */
function repositoryUrl(repo) {
  const raw = typeof repo === 'string' ? repo : repo && typeof repo === 'object' ? repo.url : undefined;
  if (typeof raw !== 'string' || raw === '') return undefined;
  return raw.replace(/^git\+/, '').replace(/\.git$/, '');
}

/**
 * Root `plugin.json` per Agent Plugins 1.0.0, from the repo's metadata SSOTs:
 * version/homepage/license/repository from `package.json`, author from
 * `.claude-plugin/plugin.json` (package.json carries none).
 *
 * @param {{ repoRoot?: string }} [opts]
 * @returns {Record<string, unknown>}
 */
export function buildManifest({ repoRoot = DEFAULT_REPO_ROOT } = {}) {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const claudePlugin = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
  /** @type {Record<string, unknown>} */
  const manifest = {
    $schema: SCHEMA_URL,
    name: PLUGIN_NAME,
    version: pkg.version,
    description: MANIFEST_DESCRIPTION,
  };
  const a = claudePlugin.author;
  if (a && typeof a === 'object') {
    manifest.author = Object.fromEntries(
      ['name', 'email', 'url'].filter((k) => typeof a[k] === 'string').map((k) => [k, a[k]]),
    );
  }
  if (typeof pkg.homepage === 'string') manifest.homepage = pkg.homepage;
  const repository = repositoryUrl(pkg.repository);
  if (repository) manifest.repository = repository;
  if (typeof pkg.license === 'string') manifest.license = pkg.license;
  return manifest;
}

/**
 * All files below `dir`, as POSIX paths relative to `dir`, sorted. Symlinks
 * are reported, never followed.
 *
 * @param {string} dir
 * @returns {Array<{path: string, abs: string, isSymlink: boolean}>}
 */
function listTree(dir) {
  const out = [];
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      const child = join(abs, name);
      const st = lstatSync(child);
      const rel = relative(dir, child).split(sep).join('/');
      if (st.isSymbolicLink()) out.push({ path: rel, abs: child, isSymlink: true });
      else if (st.isDirectory()) walk(child);
      else out.push({ path: rel, abs: child, isSymlink: false });
    }
  };
  walk(dir);
  return out;
}

/**
 * The package as a flat file list (POSIX paths relative to the plugin root).
 *
 * @param {{ repoRoot?: string, skills?: string[], includes?: Record<string, Include[]> }} [opts]
 * @returns {Array<{path: string, data: Buffer}>}
 */
export function collectPackageFiles({ repoRoot = DEFAULT_REPO_ROOT, skills = selectSkills(), includes = selectIncludes() } = {}) {
  const files = [{ path: 'plugin.json', data: Buffer.from(`${JSON.stringify(buildManifest({ repoRoot }), null, 2)}\n`) }];
  for (const name of skills) {
    const src = join(repoRoot, 'skills', name);
    const skillFiles = [];
    for (const f of listTree(src)) {
      if (f.isSymlink) throw new Error(`skills/${name}/${f.path}: symlink in source skill, refusing to package`);
      skillFiles.push({ path: `skills/${name}/${f.path}`, data: readFileSync(f.abs) });
    }
    applyIncludes(name, skillFiles, includes[name] ?? [], repoRoot);
    files.push(...skillFiles);
  }
  return files.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** @returns {boolean} true when `manifest` is the root plugin.json this exporter writes */
function isOurManifest(manifest) {
  return Boolean(manifest) && typeof manifest === 'object' && manifest.$schema === SCHEMA_URL && manifest.name === PLUGIN_NAME;
}

/**
 * Whether `dir` is recognisably an earlier export: a real directory whose top
 * level is exactly `plugin.json` + `skills/`, with our schema URL and name.
 *
 * @param {string} dir
 * @returns {boolean}
 */
export function isPreviousExportDir(dir) {
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    if (readdirSync(dir).sort().join('\0') !== 'plugin.json\0skills') return false;
    if (!lstatSync(join(dir, 'plugin.json')).isFile() || !lstatSync(join(dir, 'skills')).isDirectory()) return false;
    return isOurManifest(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')));
  } catch {
    return false;
  }
}

/**
 * Whether `zipPath` is recognisably an earlier export: a readable archive with
 * the single root `<PLUGIN_NAME>/` and our root plugin.json.
 *
 * @param {string} zipPath
 * @returns {boolean}
 */
export function isPreviousExportZip(zipPath) {
  try {
    if (!lstatSync(zipPath).isFile()) return false;
    const entries = readZip(readFileSync(zipPath));
    if (!entries.every((e) => e.path.startsWith(`${PLUGIN_NAME}/`))) return false;
    const manifest = entries.find((e) => e.path === `${PLUGIN_NAME}/plugin.json`);
    return Boolean(manifest?.data) && isOurManifest(JSON.parse(manifest.data.toString('utf8')));
  } catch {
    return false;
  }
}

/**
 * Throw unless an existing `zipPath` is an earlier export that may be
 * replaced or removed.
 *
 * @param {string} zipPath
 * @returns {boolean} whether the file exists
 * @throws {ExportRefusedError}
 */
export function assertReplaceableZip(zipPath) {
  if (!existsSync(zipPath) && !isSymlinkPath(zipPath)) return false;
  if (!isPreviousExportZip(zipPath)) {
    throw new ExportRefusedError(`refusing to replace ${zipPath}: it is not an earlier ${PLUGIN_NAME} export; move it away or pick another --out`);
  }
  return true;
}

/** @returns {boolean} */
function isSymlinkPath(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Resolve symlinks in the longest existing prefix of `p`. */
function realish(p) {
  const abs = resolve(p);
  let head = abs;
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(basename(head));
    head = parent;
  }
  // `.native` returns the on-disk case on case-insensitive volumes (APFS);
  // the JS implementation keeps the caller's case, so /USERS/x would slip past.
  return join(realpathSync.native(head), ...tail);
}

/**
 * Refuse an output directory that equals or contains a guarded root (the
 * repo checkout, the user's home directory): a build there would place its
 * plugin root beside, or in the worst case over, the user's own files.
 *
 * @param {string} outDir
 * @param {{ guardedRoots?: string[] }} [opts]
 * @throws {ExportRefusedError}
 */
export function assertSafeOutDir(outDir, { guardedRoots = [DEFAULT_REPO_ROOT, homedir()] } = {}) {
  const out = realish(outDir);
  for (const g of guardedRoots) {
    const guarded = realish(g);
    const rel = relative(out, guarded);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new ExportRefusedError(`refusing --out ${outDir}: it equals or contains ${g}`);
    }
  }
}

/**
 * Write the plugin root directory `<outDir>/<PLUGIN_NAME>/`. The root is built
 * in a fresh temp sibling and renamed into place, so stale files from an
 * earlier allowlist never ship. An existing root is only replaced when it is
 * an earlier export ({@link isPreviousExportDir}); anything else is refused.
 *
 * When the swap into place fails after the old export was moved aside, the
 * old export is moved back, so a failed build never leaves the root missing.
 *
 * @param {{ outDir: string, repoRoot?: string, skills?: string[], includes?: Record<string, Include[]>, fs?: { renameSync: Function } }} opts
 *   `fs` replaces `renameSync` (test seam, as in {@link renameSyncWithRetry})
 * @returns {{ root: string, files: Array<{path: string, data: Buffer}> }}
 * @throws {ExportRefusedError}
 */
export function buildPackage({ outDir, repoRoot = DEFAULT_REPO_ROOT, skills = selectSkills(), includes = selectIncludes(), fs }) {
  const files = collectPackageFiles({ repoRoot, skills, includes });
  const moveDir = (from, to) => renameSyncWithRetry(from, to, { fs });
  const root = join(outDir, PLUGIN_NAME);
  const exists = existsSync(root) || isSymlinkPath(root);
  if (exists && !isPreviousExportDir(root)) {
    throw new ExportRefusedError(`refusing to replace ${root}: it is not an earlier ${PLUGIN_NAME} export; move it away or pick another --out`);
  }
  mkdirSync(outDir, { recursive: true });
  const staging = mkdtempSync(join(outDir, `.${PLUGIN_NAME}.build-`));
  try {
    for (const f of files) {
      const target = join(staging, ...f.path.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.data);
    }
    if (exists) {
      // Move the verified old export into a temp dir of our own, then delete that.
      const trash = mkdtempSync(join(outDir, `.${PLUGIN_NAME}.old-`));
      const parked = join(trash, PLUGIN_NAME);
      moveDir(root, parked);
      try {
        moveDir(staging, root);
      } catch (err) {
        try {
          moveDir(parked, root);
        } catch (restoreErr) {
          // Keep the trash dir: it now holds the only copy of the old export.
          throw new Error(`replacing ${root} failed and the earlier export could not be moved back; it is at ${parked}`, { cause: restoreErr });
        }
        rmSync(trash, { recursive: true, force: true });
        throw err;
      }
      rmSync(trash, { recursive: true, force: true });
    } else {
      moveDir(staging, root);
    }
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
  return { root, files };
}

/**
 * Parse the SKILL.md frontmatter block as YAML, the way the directory's own
 * reader does. A line-based reader misjudges blank-line continuations, quoted
 * keys, duplicate keys and comments; a YAML parser does not.
 *
 * Anchors and aliases are refused outright: an alias can stand in for a value
 * defined elsewhere, and no skill needs either.
 *
 * @param {string} text the whole SKILL.md
 * @returns {{ ok: true, data: Map<unknown, unknown>, body: string } | { ok: false, missing: boolean, error: string }}
 */
function parseSkillFrontmatter(text) {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(normalised);
  if (!m) return { ok: false, missing: true, error: 'no frontmatter block' };
  const doc = parseDocument(m[1], { uniqueKeys: true, prettyErrors: false });
  if (doc.errors.length > 0) return { ok: false, missing: false, error: doc.errors[0].message.split('\n')[0] };
  let anchored = false;
  visit(doc, (_key, node) => {
    if (isAlias(node) || node?.anchor) {
      anchored = true;
      return visit.BREAK;
    }
    return undefined;
  });
  if (anchored) return { ok: false, missing: false, error: 'anchors and aliases are not allowed' };
  if (!isMap(doc.contents)) return { ok: false, missing: false, error: 'frontmatter is not a mapping' };
  return { ok: true, data: doc.toJS({ mapAsMap: true }), body: normalised.slice(m[0].length) };
}

/**
 * Validate package entries. Pure apart from the schema validator, which the
 * caller supplies (see {@link loadManifestValidator}).
 *
 * @param {Array<{path: string, data: Buffer|null, isDirectory?: boolean, isSymlink?: boolean}>} entries
 *   paths relative to the archive/build container (each starting with the plugin root segment)
 * @param {{ skills: string[], validateManifest: (m: unknown) => string[], includes?: Record<string, Include[]> }} ctx
 *   `includes`: the declared includes per skill; each must be present in a
 *   shipped skill, and the skill must point at it, not at the repo path
 * @returns {Array<{code: string, path: string, message: string}>}
 */
export function validateEntries(entries, { skills, validateManifest, includes = {} }) {
  /** @type {Array<{code: string, path: string, message: string}>} */
  const v = [];
  const add = (code, path, message) => v.push({ code, path, message });
  const allowed = new Set(skills);

  const roots = new Set();
  const seen = new Set();
  /** @type {Set<object>} */
  const skip = new Set();
  for (const e of entries) {
    if (hasControlChar(e.path)) {
      add('bad-entry-name', JSON.stringify(e.path), 'entry name contains a NUL or control character');
      skip.add(e);
      continue;
    }
    // Case-folded: a case-insensitive file system collapses the copies on extraction.
    const key = e.path.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (seen.has(key)) {
      add('duplicate-entry', e.path, 'entry name occurs more than once; extractors disagree on which copy wins');
      skip.add(e);
      continue;
    }
    seen.add(key);
    if (isAbsolute(e.path) || /^[A-Za-z]:/.test(e.path) || e.path.includes('\\')) {
      add('path-escape', e.path, 'absolute or backslash path');
      continue;
    }
    if (e.path.split('/').some((seg) => seg === '..')) {
      add('path-escape', e.path, 'path contains ".." segment');
      continue;
    }
    roots.add(e.path.split('/')[0]);
  }
  if (roots.size !== 1) add('root-count', '.', `expected exactly one plugin root, found ${roots.size}: ${[...roots].sort().join(', ')}`);
  const [root] = [...roots];
  if (root !== undefined && entries.some((e) => e.path === root && !e.isDirectory)) add('root-count', root, 'plugin root is a file, not a directory');

  /** @type {Map<string, Buffer>} */
  const files = new Map();
  for (const e of entries) {
    if (skip.has(e)) continue;
    const segs = e.path.split('/');
    if (segs[0] !== root || segs.includes('..') || isAbsolute(e.path)) continue;
    const rel = segs.slice(1).join('/').replace(/\/$/, '');
    if (rel === '') continue;
    if (e.isSymlink) {
      add('symlink', e.path, 'symlinks are not allowed in the package');
      continue;
    }
    if (segs.slice(1).some((s) => HOOKS_SEGMENT.test(s))) add('hooks-present', e.path, 'lifecycle hooks make the plugin ineligible');
    if (segs.slice(1).some((s) => MCP_SEGMENT.test(s))) add('mcp-config-present', e.path, 'MCP configuration is excluded from skills-only packages');
    if (e.isDirectory) continue;
    files.set(rel, e.data ?? Buffer.alloc(0));
    if (rel === 'plugin.json') continue;
    const m = /^skills\/([^/]+)\/.+$/.exec(rel);
    if (!m || !allowed.has(m[1])) add('not-allowlisted', e.path, 'file does not belong to an allowlisted skill');
    // Skills are instructions; any other file type is a way to ship code or config.
    else if (!rel.endsWith('.md')) add('not-allowed-file-type', e.path, 'only Markdown files are allowed inside a skill directory');
  }

  const manifestBuf = files.get('plugin.json');
  if (!manifestBuf) {
    add('manifest-missing', `${root ?? '.'}/plugin.json`, 'root plugin.json missing');
  } else {
    let manifest;
    try {
      manifest = JSON.parse(manifestBuf.toString('utf8'));
    } catch (err) {
      add('manifest-invalid', `${root}/plugin.json`, `not JSON: ${err.message}`);
    }
    if (manifest && typeof manifest === 'object') {
      // Recursive, so `extensions.<namespace>.mcpServers` counts as well.
      const walk = (node, at) => {
        if (!node || typeof node !== 'object') return;
        for (const [k, val] of Object.entries(node)) {
          const where = `${at}/${k}`;
          if (FORBIDDEN_KEY.test(k)) {
            if (/^hooks$/i.test(k)) add('hooks-present', `${root}/plugin.json`, `manifest declares "${where}"`);
            else add('mcp-config-present', `${root}/plugin.json`, `manifest declares "${where}"`);
          }
          walk(val, where);
        }
      };
      walk(manifest, '');
      for (const msg of validateManifest(manifest)) add('manifest-schema', `${root}/plugin.json`, msg);
    }
  }

  const shipped = [...new Set([...files.keys()].map((p) => /^skills\/([^/]+)\//.exec(p)?.[1]).filter(Boolean))].sort();
  if (shipped.length === 0) add('no-skills', `${root ?? '.'}/skills`, 'at least one skill is required');
  for (const name of shipped) {
    const skillPath = `${root}/skills/${name}/SKILL.md`;
    const buf = files.get(`skills/${name}/SKILL.md`);
    if (!buf) {
      add('skill-md-missing', skillPath, 'SKILL.md missing');
      continue;
    }
    const text = buf.toString('utf8');
    const fm = parseSkillFrontmatter(text);
    if (!fm.ok) {
      if (fm.missing) add('frontmatter-missing', skillPath, fm.error);
      else add('frontmatter-invalid', skillPath, `SKILL.md frontmatter is not valid YAML for this package: ${fm.error}`);
      continue;
    }
    for (const key of fm.data.keys()) {
      const k = String(key);
      if (!FORBIDDEN_KEY.test(k)) continue;
      if (/^hooks$/i.test(k)) add('hooks-present', skillPath, `SKILL.md frontmatter declares "${k}"`);
      else add('mcp-config-present', skillPath, `SKILL.md frontmatter declares "${k}"`);
    }
    const rawName = fm.data.get('name');
    const rawDesc = fm.data.get('description');
    const fmName = typeof rawName === 'string' ? rawName.trim() : '';
    const desc = typeof rawDesc === 'string' ? rawDesc.trim() : '';
    if (fmName === '') add('frontmatter-name', skillPath, 'frontmatter "name" missing or not a string');
    else if (fmName !== name) add('frontmatter-name', skillPath, `frontmatter name "${fmName}" differs from directory "${name}"`);
    if (typeof rawDesc === 'string' && /[\r\n]/.test(rawDesc)) add('frontmatter-description-multiline', skillPath, 'frontmatter "description" must be a single line once parsed');
    else if (desc === '') add('frontmatter-description', skillPath, 'frontmatter "description" missing or not a string');
    else if (desc.length > MAX_DESCRIPTION) add('description-too-long', skillPath, `description has ${desc.length} chars (max ${MAX_DESCRIPTION})`);
    const qualified = `${PLUGIN_NAME}:${fmName || name}`;
    if (qualified.length > MAX_QUALIFIED_NAME) add('qualified-name-too-long', skillPath, `"${qualified}" has ${qualified.length} chars (max ${MAX_QUALIFIED_NAME})`);
    if (fm.body.trim() === '') add('empty-body', skillPath, 'SKILL.md body is empty');
    for (const inc of allowed.has(name) ? (includes[name] ?? []) : []) {
      if (!files.has(`skills/${name}/${inc.to}`)) add('include-missing', `${root}/skills/${name}/${inc.to}`, `declared include of "${inc.from}" is missing`);
      for (const [rel, buf] of files) {
        if (rel.startsWith(`skills/${name}/`) && rel.endsWith('.md') && buf.toString('utf8').includes(inc.from)) {
          add('include-unrewritten', `${root}/${rel}`, `still points at "${inc.from}", a file the package does not carry; expected "${inc.to}"`);
        }
      }
    }
  }
  return v;
}

/**
 * Compile the vendored Agent Plugins 1.0.0 schema.
 *
 * @returns {Promise<(m: unknown) => string[]>} error messages, empty when valid
 */
export async function loadManifestValidator() {
  const ajv = await getAjv2020({ allErrors: true, strict: false });
  const validate = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
  return (m) => (validate(m) ? [] : (validate.errors ?? []).map(
          (e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? `: "${e.params.additionalProperty}"` : ''}`,
        ));
}

/**
 * Read a built package directory (the container holding the plugin root, or
 * the plugin root itself) into entries for {@link validateEntries}.
 *
 * @param {string} dir
 * @returns {Array<{path: string, data: Buffer|null, isSymlink: boolean}>}
 */
export function readPackageDir(dir) {
  const abs = resolve(dir);
  // A plugin root has plugin.json at top; validate it as the single root.
  let base = abs;
  let prefix = '';
  try {
    lstatSync(join(abs, 'plugin.json'));
    base = dirname(abs);
    prefix = `${relative(base, abs)}/`;
  } catch {
    /* container directory */
  }
  const scanRoot = prefix ? abs : base;
  return listTree(scanRoot).map((f) => ({
    path: `${prefix}${f.path}`,
    data: f.isSymlink ? null : readFileSync(f.abs),
    isSymlink: f.isSymlink,
  }));
}

/**
 * Validate a build directory or a `.zip` file.
 *
 * @param {string} target
 * @param {{ skills?: string[], includes?: Record<string, Include[]> }} [opts]
 * @returns {Promise<Array<{code: string, path: string, message: string}>>}
 */
export async function validatePackage(target, { skills = selectSkills(), includes = selectIncludes() } = {}) {
  const validateManifest = await loadManifestValidator();
  // Any regular file is read as an archive, whatever its extension's case.
  if (!lstatSync(target).isDirectory()) {
    if (!/\.zip$/i.test(target) && !hasZipMagic(target)) {
      return [{ code: 'zip-malformed', path: target, message: 'not a directory and not a zip archive' }];
    }
    try {
      return validateEntries(readZip(readFileSync(target)), { skills, validateManifest, includes });
    } catch (err) {
      if (err instanceof ZipFormatError) return [{ code: 'zip-malformed', path: target, message: err.message }];
      throw err;
    }
  }
  return validateEntries(readPackageDir(target), { skills, validateManifest, includes });
}

/** @returns {boolean} whether the file starts with a local-header or empty-archive signature */
function hasZipMagic(file) {
  const head = Buffer.alloc(4);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, head, 0, 4, 0);
  } finally {
    closeSync(fd);
  }
  return head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) || head.equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
}
