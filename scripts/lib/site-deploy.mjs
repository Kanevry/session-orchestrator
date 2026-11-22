/**
 * site-deploy.mjs — select, export and deploy the website from a private source commit
 * with the Vercel CLI (#2219).
 *
 * The file set comes from `site-deploy.json` at the repo root, not from the public-mirror
 * policy: that policy will drop `site/` and `vercel.json`, and the site must keep
 * deploying after it does. Entry semantics match `.orchestrator/policy/public-export.json`:
 * an entry ending in `/` is a directory prefix, anything else an exact path; no globs.
 *
 * Nothing here spawns at import time. The CLI is scripts/site-deploy.mjs.
 */

import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { spawnSync } from './native-command.mjs';

export const CONFIG_FILE = 'site-deploy.json';
export const MODES = ['plan', 'preview', 'stage', 'promote'];

const ID = /^[A-Za-z0-9_.-]+$/;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f]/;
/** Paths per `git archive` call; keeps argv far below ARG_MAX on every host. */
const ARCHIVE_CHUNK = 200;

/** A `site-deploy.json` that does not have the documented shape. */
export class SiteDeployConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteDeployConfigError';
  }
}

/** The export directory does not hold exactly the planned files. */
export class SiteDeployExportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SiteDeployExportError';
  }
}

/**
 * @typedef {{ name: string, scope: string, orgId: string, projectId: string }} SiteDeployProject
 * @typedef {{ version: 1, project: SiteDeployProject, include: string[], exclude: string[] }} SiteDeployConfig
 * @typedef {import('./github-export.mjs').GitRunner} GitRunner
 */

function checkPath(field, p) {
  if (typeof p !== 'string' || p === '') throw new SiteDeployConfigError(`${field}: entries must be non-empty strings`);
  if (CONTROL.test(p)) throw new SiteDeployConfigError(`${field}: '${JSON.stringify(p)}' contains a control character`);
  if (p.startsWith('/') || p.includes('\\')) throw new SiteDeployConfigError(`${field}: '${p}' must be repo-relative with forward slashes`);
  if (p.split('/').some((seg) => seg === '..' || seg === '.')) throw new SiteDeployConfigError(`${field}: '${p}' must not contain '.' or '..' segments`);
}

/**
 * Parse and validate `site-deploy.json`.
 * @param {string} text file content
 * @returns {SiteDeployConfig}
 * @throws {SiteDeployConfigError} naming the bad field
 */
export function loadSiteDeployConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SiteDeployConfigError(`${CONFIG_FILE} is not JSON`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SiteDeployConfigError(`${CONFIG_FILE} must be an object`);
  if (raw.version !== 1) throw new SiteDeployConfigError(`version: expected 1, got ${JSON.stringify(raw.version)}`);
  const project = raw.project;
  if (!project || typeof project !== 'object' || Array.isArray(project)) throw new SiteDeployConfigError('project: must be an object');
  for (const key of ['name', 'scope', 'orgId', 'projectId']) {
    if (typeof project[key] !== 'string' || !ID.test(project[key])) {
      throw new SiteDeployConfigError(`project.${key}: must be a non-empty string of [A-Za-z0-9_.-]`);
    }
  }
  if (!Array.isArray(raw.include) || raw.include.length === 0) throw new SiteDeployConfigError('include: must be a non-empty array');
  const exclude = raw.exclude ?? [];
  if (!Array.isArray(exclude)) throw new SiteDeployConfigError('exclude: must be an array');
  raw.include.forEach((p) => checkPath('include', p));
  exclude.forEach((p) => checkPath('exclude', p));
  return {
    version: 1,
    project: { name: project.name, scope: project.scope, orgId: project.orgId, projectId: project.projectId },
    include: [...raw.include],
    exclude: [...exclude],
  };
}

const under = (path) => (entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry);

/**
 * Tracked paths under an include entry and under no exclude entry, sorted.
 * @param {string[]} trackedPaths forward-slash repo-relative paths
 * @param {Pick<SiteDeployConfig, 'include'|'exclude'>} config
 * @returns {string[]}
 */
export function selectDeployFiles(trackedPaths, config) {
  return trackedPaths
    .filter((p) => config.include.some(under(p)) && !config.exclude.some(under(p)))
    .sort();
}

/**
 * Paths that must never reach a deployment, whatever the config says: env files,
 * anything inside `.vercel/` or `.git/`, and `.DS_Store`.
 * @param {string[]} paths
 * @returns {string[]}
 */
export function forbiddenDeployFiles(paths) {
  return paths.filter((p) => {
    const segs = p.split('/');
    const base = segs[segs.length - 1];
    return base.startsWith('.env') || base === '.DS_Store' || segs.slice(0, -1).some((s) => s === '.vercel' || s === '.git');
  });
}

/**
 * Resolve the source, list its tracked files and select the deploy set.
 * A git failure is `{ ok: false, system: true }`, never an empty list.
 * @param {{ git: GitRunner, source: string, config: SiteDeployConfig }} opts
 * @returns {{ ok: true, sourceSha: string, files: string[], bytes: number } | { ok: false, system?: true, reason: string }}
 */
export function planDeploy({ git, source, config }) {
  const rev = git(['rev-parse', '--verify', '--quiet', `${source}^{commit}`]);
  if (rev.status !== 0 || !rev.stdout.trim()) return { ok: false, system: true, reason: `source '${source}' does not resolve to a commit` };
  const sourceSha = rev.stdout.trim();
  // One `-l` listing gives names and sizes together; a submodule (type commit) is no file.
  const ls = git(['ls-tree', '-r', '-l', '-z', sourceSha]);
  if (ls.status !== 0) return { ok: false, system: true, reason: `ls-tree of ${sourceSha.slice(0, 12)} failed` };
  /** @type {Map<string, number>} */
  const sizes = new Map();
  /** @type {Map<string, string>} */
  const modes = new Map();
  for (const row of ls.stdout.split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode, type, , size] = row.slice(0, tab).split(/\s+/);
    if (type === 'blob') {
      sizes.set(row.slice(tab + 1), Number(size));
      modes.set(row.slice(tab + 1), mode);
    }
  }
  if (sizes.size === 0) return { ok: false, system: true, reason: `ls-tree of ${sourceSha.slice(0, 12)} listed no files` };
  const files = selectDeployFiles([...sizes.keys()], config);
  if (files.length === 0) return { ok: false, reason: 'no tracked file matches site-deploy.json include' };
  // A symlink (120000) is a blob too; extracted, it would point anywhere on the host.
  const notRegular = files.filter((f) => modes.get(f) !== '100644' && modes.get(f) !== '100755');
  if (notRegular.length > 0) {
    return { ok: false, reason: `non-regular file(s) selected: ${notRegular.slice(0, 5).map((f) => `${f} (mode ${modes.get(f)})`).join(', ')}` };
  }
  const forbidden = forbiddenDeployFiles(files);
  if (forbidden.length > 0) return { ok: false, reason: `forbidden file(s) selected: ${forbidden.slice(0, 5).join(', ')}` };
  return { ok: true, sourceSha, files, bytes: files.reduce((n, f) => n + sizes.get(f), 0) };
}

/**
 * Every regular file below `root`, forward-slash relative. Links are never followed;
 * a symlink or any other non-regular entry throws.
 * @throws {SiteDeployExportError}
 */
function walk(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const rel = relative(root, abs).split(sep).join('/');
      if (st.isDirectory()) visit(abs);
      else if (st.isFile()) out.push(rel);
      else throw new SiteDeployExportError(`non-regular entry in the export: ${rel}${st.isSymbolicLink() ? ' (symlink)' : ''}`);
    }
  };
  visit(root);
  return out.sort();
}

/**
 * Extract exactly `files` of `sourceSha` into the empty directory `dir`, verify the
 * result by walking it, then write `.vercel/project.json` from the config.
 * @param {{ git: GitRunner, sourceSha: string, files: string[], config: SiteDeployConfig, dir: string, tar?: typeof spawnSync }} opts
 * @returns {{ dir: string, files: number }}
 * @throws {SiteDeployExportError} on a git/tar failure or when the extracted set differs
 */
export function materializeDeployDir({ git, sourceSha, files, config, dir, tar = spawnSync }) {
  if (readdirSync(dir).length !== 0) throw new SiteDeployExportError(`${dir} is not empty`);
  const tarFile = join(dir, '.site-deploy.tar');
  try {
    for (let i = 0; i < files.length; i += ARCHIVE_CHUNK) {
      // `:(literal)` keeps a file name with glob characters from matching other files.
      const specs = files.slice(i, i + ARCHIVE_CHUNK).map((f) => `:(literal)${f}`);
      const arch = git(['archive', '--format=tar', '-o', tarFile, sourceSha, '--', ...specs]);
      if (arch.status !== 0) throw new SiteDeployExportError(`git archive ${sourceSha.slice(0, 12)} failed: ${arch.stderr.trim()}`);
      const x = tar('tar', ['-x', '-f', tarFile, '-C', dir], { encoding: 'utf8' });
      if (x.status !== 0) throw new SiteDeployExportError(`tar -x failed: ${String(x.stderr || x.error?.message || '').trim()}`);
    }
  } finally {
    rmSync(tarFile, { force: true });
  }
  const walked = walk(dir);
  const want = [...files].sort();
  const missing = want.filter((f) => !walked.includes(f));
  const extra = walked.filter((f) => !want.includes(f));
  if (missing.length > 0 || extra.length > 0) {
    throw new SiteDeployExportError(`export differs from the plan: ${missing.length} missing (${missing.slice(0, 3).join(', ')}), ${extra.length} extra (${extra.slice(0, 3).join(', ')})`);
  }
  const forbidden = forbiddenDeployFiles(walked);
  if (forbidden.length > 0) throw new SiteDeployExportError(`forbidden file(s) in the export: ${forbidden.slice(0, 5).join(', ')}`);
  writeVercelLink(dir, config);
  return { dir, files: walked.length };
}

/**
 * Write `dir/.vercel/project.json` from the config, so the Vercel CLI run in `dir`
 * targets this project and never links (with `--yes`) to one named after the cwd.
 * @param {string} dir
 * @param {SiteDeployConfig} config
 */
export function writeVercelLink(dir, config) {
  mkdirSync(join(dir, '.vercel'));
  writeFileSync(join(dir, '.vercel', 'project.json'), `${JSON.stringify({ orgId: config.project.orgId, projectId: config.project.projectId, projectName: config.project.name })}\n`);
}

/** `https://<host>.vercel.app` with nothing after the host but an optional `/`. */
export function isVercelDeploymentUrl(url) {
  return typeof url === 'string' && /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.vercel\.app\/?$/.test(url);
}

/**
 * argv for the three write modes. `stage` builds a production deployment without
 * moving the domains; only `promote` moves them.
 * @param {'preview'|'stage'|'promote'} mode
 * @param {{ scope: string, url?: string }} opts
 * @returns {string[]}
 */
export function vercelArgs(mode, { scope, url }) {
  if (typeof scope !== 'string' || !ID.test(scope)) throw new SiteDeployConfigError('scope: must be a non-empty string of [A-Za-z0-9_.-]');
  if (mode === 'preview') return ['deploy', '--yes', '--scope', scope];
  if (mode === 'stage') return ['deploy', '--prod', '--skip-domain', '--yes', '--scope', scope];
  if (mode === 'promote') {
    if (!isVercelDeploymentUrl(url)) throw new SiteDeployConfigError(`url: expected https://<deployment>.vercel.app, got '${url}'`);
    return ['promote', url, '--yes', '--scope', scope];
  }
  throw new SiteDeployConfigError(`mode: '${mode}' has no vercel command`);
}

/**
 * The deployment URL Vercel prints: the last `https://….vercel.app` token on stdout.
 * @param {string} stdout
 * @returns {string|null}
 */
export function deploymentUrlFrom(stdout) {
  const all = String(stdout).match(/https:\/\/[a-z0-9-]+\.vercel\.app/g);
  return all ? all[all.length - 1] : null;
}
