/**
 * confidential-names-list.mjs — generate and describe the host-local CP11 name list (#2238).
 *
 * The CP11 rule of `validate/check-owner-leakage.mjs` reads a host-local JSON array
 * of confidential repo / customer names (#728a, loader `validate/confidential-names.mjs`).
 * This module PRODUCES that file from the GitLab projects the account is a member
 * of, and DESCRIBES its state (status, count, age) for the release preflight and
 * the advisory pre-commit line.
 *
 * Three host-local files, all beside owner.yaml in the private config dir and never
 * in a repo:
 *   - `confidential-names.json`        generated; a JSON array of names (the loader's shape)
 *   - `confidential-names-allow.json`  hand-kept; a JSON array of names the generator
 *     must NOT emit — common words that are also project paths, and own products
 *     the operator advertises publicly. Matched case-insensitively. Never overwritten.
 *   - `confidential-names-extra.json`  hand-kept; a JSON array of names the generator
 *     ALWAYS emits (customer or product names that are no GitLab project), unless
 *     the exception list names them too. Never overwritten.
 *
 * Privacy: nothing here prints a name. Results carry counts; reasons carry exit
 * codes and basenames. glab's stdout/stderr never reach the caller's output (its
 * stderr can carry the private GitLab host).
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { expandTilde } from './common.mjs';
import { resolvePrivateConfigDir } from './config/private-config-dir.mjs';
import { resolveHostPath } from './config/host-paths.mjs';
import { writeJsonAtomicSync } from './io.mjs';
import { spawnSync } from './native-command.mjs';
import { inspectConfidentialNames } from './validate/confidential-names.mjs';

export const NAMES_FILE = 'confidential-names.json';
export const ALLOW_FILE = 'confidential-names-allow.json';
export const EXTRA_FILE = 'confidential-names-extra.json';

/**
 * Group namespace segments that only describe how a code host is organised
 * (#2251). Measured 2026-11-23: seven of nine unlisted group segments were such
 * words and matched 6 to 757 files of a public tree each — listed, they turn every
 * export red without guarding anything confidential. Applied to GROUP segments
 * only; a project path or name that happens to be one of these words stays listed,
 * so nothing guarded before is dropped. Lowercase, compared case-insensitively;
 * no word shorter than the length limit, which drops those anyway.
 * A confidential group name that collides with an entry here goes into the extra
 * list. Revisit trigger (BV-004): a generate run whose remaining group segments
 * still match widely — add the word here rather than to every operator's exceptions.
 */
export const GENERIC_GROUP_SEGMENTS = new Set([
  // products and delivery
  'products', 'product', 'apps', 'app', 'services', 'service', 'platform', 'platforms',
  'releases', 'release', 'mobile', 'web', 'websites', 'sites', 'backend', 'frontend',
  'clients', 'plugins', 'extensions', 'bots', 'agents', 'ventures',
  // code organisation
  'libs', 'libraries', 'packages', 'modules', 'components', 'core', 'shared', 'common',
  'tools', 'tooling', 'utils', 'scripts', 'config', 'configs', 'templates', 'examples',
  'demos', 'playground', 'sandbox', 'experiments', 'labs', 'research', 'misc',
  'archive', 'archived', 'legacy', 'projects', 'repos', 'docs', 'documentation',
  // teams and operations
  'team', 'teams', 'internal', 'public', 'private', 'dev', 'development', 'ops',
  'devops', 'infra', 'infrastructure', 'infra-ops', 'security', 'testing',
  'data', 'design', 'marketing', 'personal',
]);

/** A list older than this is stale: the release preflight says so (warn, never red). */
export const MAX_LIST_AGE_DAYS = 7;

/** Command the operator runs to refresh the list; quoted in every stale/red detail. */
export const REGENERATE_COMMAND = 'node scripts/confidential-names.mjs generate';

const PER_PAGE = 100;
// Ceiling: 100 pages × 100 = 10,000 projects. A member of more is not a single
// publisher's account; the generator refuses rather than writing a partial list.
// Revisit trigger (BV-004): a real account reaches the ceiling.
const MAX_PAGES = 100;
// Names shorter than this match as a word almost everywhere (`ui`, `os`) and would
// turn CP11 into noise. Revisit trigger (BV-004): a confidential two-letter name.
const MIN_NAME_LENGTH = 3;
// Same cap as the loader's MAX_NAME_LENGTH; a longer entry would be dropped there.
const MAX_NAME_LENGTH = 256;

/** @typedef {{ path?: unknown, name?: unknown, namespace?: { kind?: unknown, full_path?: unknown } }} MemberProject */

/**
 * Default host-local paths of the three files, under the private config dir.
 * @param {{ env?: Record<string, string|undefined> }} [opts]
 * @returns {{ namesPath: string, allowPath: string, extraPath: string }}
 */
export function defaultListPaths({ env = process.env } = {}) {
  const dir = resolvePrivateConfigDir({ env });
  return { namesPath: join(dir, NAMES_FILE), allowPath: join(dir, ALLOW_FILE), extraPath: join(dir, EXTRA_FILE) };
}

/** @param {string} name trimmed @returns {boolean} */
function withinLengthLimits(name) {
  return name.length >= MIN_NAME_LENGTH && name.length <= MAX_NAME_LENGTH;
}

/**
 * Read every project the account is a member of, page by page.
 * `glab api --paginate` concatenates page arrays (not one JSON document), hence
 * manual paging. Any failed or unparseable page aborts: a partial list would
 * silently stop guarding the missing names.
 *
 * @param {{ run?: (cmd: string, args: string[], opts: object) => {status: number|null, stdout?: string, error?: Error} }} [deps]
 * @returns {{ ok: true, projects: MemberProject[], pages: number } | { ok: false, reason: string }}
 */
export function fetchMemberProjects({ run = spawnSync } = {}) {
  const projects = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = run('glab', ['api', `projects?membership=true&simple=true&per_page=${PER_PAGE}&page=${page}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.error) return { ok: false, reason: `glab could not run (${res.error.code ?? res.error.name})` };
    if (res.status !== 0) return { ok: false, reason: `glab api failed on page ${page} (exit ${res.status})` };
    let rows;
    try {
      rows = JSON.parse(res.stdout ?? '');
    } catch {
      return { ok: false, reason: `glab api page ${page} is not JSON` };
    }
    if (!Array.isArray(rows)) return { ok: false, reason: `glab api page ${page} is not a JSON array` };
    projects.push(...rows);
    if (rows.length < PER_PAGE) return { ok: true, projects, pages: page };
  }
  return { ok: false, reason: `more than ${MAX_PAGES * PER_PAGE} projects — refusing a partial list` };
}

/**
 * Candidate names from project paths, names and group namespace segments.
 * Dedupe case-insensitively (first spelling wins) and enforce length limits.
 * Group segments enter the list by default (#2251), except the words in
 * GENERIC_GROUP_SEGMENTS, which describe the host's structure, not a confidential
 * name; those are counted as `groupGeneric`. `includeGroups: false` leaves every
 * group segment out (still counted in `groupSegments`). Project paths and names
 * are never filtered.
 * @param {MemberProject[]} projects
 * @param {{ includeGroups?: boolean }} [opts]
 * @returns {{ names: string[], tooShort: number, groupSegments: number, groupGeneric: number }}
 */
export function deriveNames(projects, { includeGroups = true } = {}) {
  const seen = new Map();
  const groupSegments = new Set();
  const groupGeneric = new Set();
  let tooShort = 0;

  /** @param {unknown} raw @param {boolean} [fromGroup] */
  function addName(raw, fromGroup = false) {
    if (typeof raw !== 'string') return;
    const name = raw.trim();
    const key = name.toLowerCase();
    if (fromGroup) {
      if (withinLengthLimits(name)) groupSegments.add(key);
      // A group segment left out of the list must not move the list's own counts.
      if (!includeGroups) return;
      if (GENERIC_GROUP_SEGMENTS.has(key)) {
        groupGeneric.add(key);
        return;
      }
    }
    if (name.length < MIN_NAME_LENGTH) {
      if (name) tooShort += 1;
      return;
    }
    if (name.length > MAX_NAME_LENGTH) return;
    if (!seen.has(key)) seen.set(key, name);
  }

  for (const project of projects) {
    addName(project?.path);
    addName(project?.name);
    const namespace = project?.namespace;
    if (namespace?.kind === 'group' && typeof namespace.full_path === 'string') {
      for (const segment of namespace.full_path.split('/')) addName(segment, true);
    }
  }
  return { names: [...seen.values()], tooShort, groupSegments: groupSegments.size, groupGeneric: groupGeneric.size };
}

/**
 * Read a hand-kept name file (the exception list or the extra list). Absent is
 * normal (no entries); a present file that is not a JSON array of strings is
 * `malformed` and the caller refuses to generate — silently ignoring it would
 * publish names the operator excepted for a reason, or guard nothing they expect
 * it to guard.
 * @param {string} listPath
 * @returns {{ status: 'absent'|'ok'|'malformed', names: string[] }}
 */
export function readAllowList(listPath) {
  if (!existsSync(listPath)) return { status: 'absent', names: [] };
  try {
    const raw = readFileSync(listPath, 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!Array.isArray(parsed) || parsed.some((e) => typeof e !== 'string')) return { status: 'malformed', names: [] };
    return { status: 'ok', names: parsed.map((e) => e.trim()).filter(Boolean) };
  } catch {
    return { status: 'malformed', names: [] };
  }
}

/**
 * Add the extra list to the candidates: same length limits, case-insensitive
 * dedupe (an extra name already derived keeps the derived spelling).
 * @param {string[]} candidates @param {string[]} extra
 * @returns {{ names: string[], extra: number, tooShort: number }}
 *   `extra` counts the distinct extra names within the length limits.
 */
export function mergeExtraNames(candidates, extra) {
  const seen = new Map(candidates.map((n) => [n.toLowerCase(), n]));
  const valid = new Set();
  let tooShort = 0;
  for (const name of extra) {
    if (!withinLengthLimits(name)) {
      if (name.length < MIN_NAME_LENGTH) tooShort += 1;
      continue;
    }
    const key = name.toLowerCase();
    valid.add(key);
    if (!seen.has(key)) seen.set(key, name);
  }
  return { names: [...seen.values()], extra: valid.size, tooShort };
}

/**
 * Subtract the exception list (case-insensitive) from the candidates.
 * @param {string[]} candidates @param {string[]} allow
 * @returns {{ names: string[], excepted: number }}
 */
export function applyAllowList(candidates, allow) {
  const drop = new Set(allow.map((a) => a.toLowerCase()));
  const names = candidates.filter((n) => !drop.has(n.toLowerCase()));
  return { names, excepted: candidates.length - names.length };
}

/**
 * Write the list atomically (tmp + rename) with mode 0600; parent dirs this call
 * creates get 0700. An existing parent keeps its mode (same rule as owner.yaml).
 * @param {string} namesPath @param {string[]} names
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function writeNamesList(namesPath, names) {
  try {
    mkdirSync(dirname(namesPath), { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, reason: `could not create the config directory (${err.code ?? err.name})` };
  }
  const res = writeJsonAtomicSync(namesPath, names, { mode: 0o600, tmpPrefix: `.${basename(namesPath)}` });
  return res.ok ? { ok: true } : { ok: false, reason: `could not write ${basename(namesPath)} (${res.code ?? 'fs-error'})` };
}

/**
 * Generate the list: fetch, derive, add the extra list, subtract exceptions,
 * write (unless dryRun). The exception list wins over the extra list, so it stays
 * the one place to loosen the list. Refuses to write zero names — a `[]` file is
 * the loader's explicit opt-out and would read as "CP11 switched off" instead of
 * "generation went wrong".
 *
 * @param {{ namesPath: string, allowPath: string, extraPath?: string, dryRun?: boolean, includeGroups?: boolean, run?: Function }} opts
 *   `extraPath` omitted = no extra list.
 * @returns {{ ok: true, projects: number, pages: number, candidates: number, groupSegments: number, groupGeneric: number, groupsIncluded: boolean, extra: number, tooShort: number, excepted: number, names: number, written: boolean, allowList: string, extraList: string }
 *   | { ok: false, reason: string }}
 */
export function generateNamesList({ namesPath, allowPath, extraPath, dryRun = false, includeGroups = true, run }) {
  const allow = readAllowList(allowPath);
  if (allow.status === 'malformed') return { ok: false, reason: `${basename(allowPath)} is not a JSON array of strings` };
  const extraList = extraPath ? readAllowList(extraPath) : { status: 'absent', names: [] };
  if (extraList.status === 'malformed') return { ok: false, reason: `${basename(extraPath)} is not a JSON array of strings` };
  const fetched = fetchMemberProjects(run ? { run } : {});
  if (!fetched.ok) return fetched;
  if (fetched.projects.length === 0) return { ok: false, reason: 'glab api returned no projects — nothing written' };
  const derived = deriveNames(fetched.projects, { includeGroups });
  const merged = mergeExtraNames(derived.names, extraList.names);
  const result = applyAllowList(merged.names, allow.names);
  if (result.names.length === 0) return { ok: false, reason: 'every derived name is excepted or too short — nothing written' };
  if (!dryRun) {
    const w = writeNamesList(namesPath, result.names);
    if (!w.ok) return w;
  }
  return {
    ok: true,
    projects: fetched.projects.length,
    pages: fetched.pages,
    candidates: merged.names.length,
    groupSegments: derived.groupSegments,
    groupGeneric: derived.groupGeneric,
    groupsIncluded: includeGroups,
    extra: merged.extra,
    tooShort: derived.tooShort + merged.tooShort,
    excepted: result.excepted,
    names: result.names.length,
    written: !dryRun,
    allowList: allow.status,
    extraList: extraList.status,
  };
}

/**
 * State of the list CP11 would use, resolved exactly as the scanner resolves it
 * (`SO_CONFIDENTIAL_NAMES_FILE` > owner.yaml `paths.confidential-names-file`).
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object, now?: number }} [opts]
 * @returns {{ status: 'ok'|'empty'|'all-dropped'|'missing'|'malformed'|'unconfigured', count: number, ageDays: number|null, stale: boolean, file: string|null }}
 *   `file` is the basename only.
 */
export function describeNamesList({ env = process.env, ownerConfig, now = Date.now() } = {}) {
  const namesPath = expandTilde(resolveHostPath('confidential-names-file', '', { env, ownerConfig }));
  if (typeof namesPath !== 'string' || namesPath.trim() === '') {
    return { status: 'unconfigured', count: 0, ageDays: null, stale: false, file: null };
  }
  const { status, names } = inspectConfidentialNames({ namesPath });
  let ageDays = null;
  try {
    // max(0, …): an mtime a few ms ahead of `now` (fs clock granularity) is today, not -1.
    ageDays = Math.max(0, Math.floor((now - statSync(namesPath).mtimeMs) / 86_400_000));
  } catch {
    // missing / unreadable: the status already says so.
  }
  return { status, count: names.length, ageDays, stale: ageDays !== null && ageDays > MAX_LIST_AGE_DAYS, file: basename(namesPath) };
}

/**
 * Release-preflight verdict for a repo that publishes (`mirror: curated`). Red for
 * every status but `ok` and the explicit `[]` opt-out; a stale `ok` list stays
 * green with the regenerate command in the detail. Non-curated repos: skipped.
 * @param {{ curated: boolean, list: ReturnType<typeof describeNamesList> }} input
 * @returns {{ ok: boolean, detail: string }}
 */
export function evaluateNamesListRow({ curated, list }) {
  if (!curated) return { ok: true, detail: 'skipped — not mirror: curated' };
  if (list.status === 'empty') return { ok: true, detail: `${list.file} is [] — CP11 deliberately off` };
  if (list.status !== 'ok') {
    return { ok: false, detail: `list ${list.status} — CP11 cannot guard the public tree; run: ${REGENERATE_COMMAND}, then set paths.confidential-names-file` };
  }
  const age = list.ageDays === null ? 'age unknown' : `${list.ageDays} day(s) old`;
  if (list.stale) return { ok: true, detail: `WARN ${list.count} names, ${age} (> ${MAX_LIST_AGE_DAYS}) — refresh: ${REGENERATE_COMMAND}` };
  return { ok: true, detail: `${list.count} names, ${age}` };
}
