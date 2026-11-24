/**
 * status.mjs — `/security status`: which security mechanisms run in this repo (#2201).
 *
 * One check per mechanism, each in exactly one state:
 *   on             configured and called in this repo
 *   off            present and disabled by a config value (the value is named)
 *   not-wired      nothing in this repo calls or configures it (a measured absence)
 *   not-measurable the state could not be read (with the reason)
 *   skipped        the last pulse had nothing to check (with the reason)
 *
 * Reads only: the working tree, or `git ls-tree` / `git show` at `ref`. The
 * advisory pulse contributes counts only — no package name, no advisory id.
 * Contract: ./contract.mjs.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { resolveInstructionFile } from '../common.mjs';
import { parseSessionConfig } from '../config.mjs';
import { execFileSync } from '../native-command.mjs';
import { cachePaths, readCacheFile, stampMs } from '../security-pulse/cache.mjs';
import { makeResult } from './contract.mjs';

/** NAMED CEILING (BV-004): 1 MiB per config file read. Revisit if a real CI or instruction file exceeds it. */
const MAX_READ_BYTES = 1024 * 1024;

const GIT_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * MAX_READ_BYTES };

/** Typed read failure; `code` is the error class reported as the reason. */
class ReadFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReadFailure';
    this.code = code;
  }
}

/**
 * File access at one basis: the working tree (`ref === null`) or a commit.
 * `read` returns the text or null when the path is absent; any other failure throws ReadFailure.
 */
function makeReader(repoRoot, ref) {
  if (ref === null) {
    return {
      read(rel) {
        let st;
        try {
          st = lstatSync(path.join(repoRoot, rel));
        } catch (err) {
          if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return null;
          throw new ReadFailure(err?.code ?? 'unreadable');
        }
        if (!st.isFile()) throw new ReadFailure('not-regular');
        if (st.size > MAX_READ_BYTES) throw new ReadFailure('too-large');
        try {
          return readFileSync(path.join(repoRoot, rel), 'utf8');
        } catch (err) {
          throw new ReadFailure(err?.code ?? 'unreadable');
        }
      },
      list(relDir) {
        try {
          return readdirSync(path.join(repoRoot, relDir || '.'));
        } catch (err) {
          if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return [];
          throw new ReadFailure(err?.code ?? 'unreadable');
        }
      },
    };
  }
  const lsTree = (spec) => {
    try {
      return execFileSync('git', ['-C', repoRoot, 'ls-tree', '--name-only', ref, '--', spec], GIT_OPTS)
        .split('\n').filter(Boolean);
    } catch {
      throw new ReadFailure('git-ls-tree-failed');
    }
  };
  return {
    read(rel) {
      if (!lsTree(rel).includes(rel)) return null;
      let text;
      try {
        text = execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${rel}`], GIT_OPTS);
      } catch (err) {
        throw new ReadFailure(err?.code === 'ENOBUFS' ? 'too-large' : 'git-show-failed');
      }
      if (Buffer.byteLength(text) > MAX_READ_BYTES) throw new ReadFailure('too-large');
      return text;
    },
    list(relDir) {
      const prefix = relDir ? `${relDir}/` : '';
      return lsTree(prefix || '.').map((p) => p.slice(prefix.length));
    },
  };
}

const failureCode = (err) => (err instanceof ReadFailure ? err.code : err?.name ?? 'unreadable');

/** Lines that are not YAML comments, with trailing ` # …` comments removed. */
function codeLines(text) {
  return text.split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s#.*$/, ''));
}

/**
 * Read every CI file of the target repo.
 * @returns {{files: Array<{rel: string, lines: string[]}>, problem: string|null}}
 */
function readCi(reader) {
  const files = [];
  const rels = ['.gitlab-ci.yml'];
  try {
    for (const name of reader.list('.github/workflows')) {
      if (/\.ya?ml$/.test(name)) rels.push(`.github/workflows/${name}`);
    }
  } catch (err) {
    return { files, problem: `.github/workflows unreadable (${failureCode(err)})` };
  }
  for (const rel of rels) {
    try {
      const text = reader.read(rel);
      if (text !== null) files.push({ rel, lines: codeLines(text) });
    } catch (err) {
      return { files, problem: `${rel} unreadable (${failureCode(err)})` };
    }
  }
  return { files, problem: null };
}

const CI_MECHANISMS = [
  // `npm audit` etc., but not `npm audit signatures` (that is the next check).
  { id: 'ci-audit-job', check: 'CI audit job', re: /\b(?:npm|pnpm|yarn|bun)\s+audit\b(?!\s+signatures)/, what: 'dependency audit' },
  { id: 'ci-signature-check', check: 'CI signature check', re: /\bnpm\s+audit\s+signatures\b/, what: 'npm audit signatures' },
  { id: 'secret-scan', check: 'secret scan', re: /\bgitleaks\b/, what: 'gitleaks' },
];

function ciChecks(ci) {
  return CI_MECHANISMS.map(({ id, check, re, what }) => {
    if (ci.problem) return { id, check, state: 'not-measurable', detail: 'CI configuration could not be read', reason: ci.problem };
    // A missing CI file is a measured absence, not an unreadable state.
    if (ci.files.length === 0) return { id, check, state: 'not-wired', detail: 'no CI file in this repo' };
    const hits = ci.files.filter((f) => f.lines.some((l) => re.test(l))).map((f) => f.rel);
    if (hits.length > 0) return { id, check, state: 'on', detail: `${what} runs in ${hits.join(', ')}`, file: hits[0] };
    // Jobs may come from an included template this reader cannot see.
    const includes = ci.files.filter((f) => f.lines.some((l) => /^include\s*:/.test(l))).map((f) => f.rel);
    if (includes.length > 0) {
      return { id, check, state: 'not-measurable', detail: `no ${what} job found`, reason: `${includes.join(', ')} includes templates that are not read` };
    }
    return { id, check, state: 'not-wired', detail: `no job runs ${what} (${ci.files.map((f) => f.rel).join(', ')})` };
  });
}

/** Session Config of the target repo, or the reason it could not be read. */
function readConfig(reader, repoRoot, ref) {
  let rel = null;
  let text = null;
  try {
    if (ref === null) {
      const found = resolveInstructionFile(repoRoot);
      if (found) {
        rel = path.basename(found.path);
        text = reader.read(rel);
      }
    } else {
      for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        text = reader.read(name);
        if (text !== null && text.length > 0) {
          rel = name;
          break;
        }
      }
    }
  } catch (err) {
    return { config: null, rel, problem: `instruction file unreadable (${failureCode(err)})` };
  }
  if (text === null || rel === null) return { config: null, rel, problem: 'no CLAUDE.md or AGENTS.md' };
  // Without the block the parser returns defaults; those are not this repo's values.
  if (!/^## Session Config\s*$/m.test(text)) return { config: null, rel, problem: `${rel} has no ## Session Config block` };
  try {
    return { config: parseSessionConfig(text), rel, problem: null };
  } catch (err) {
    return { config: null, rel, problem: `Session Config could not be parsed (${failureCode(err)})` };
  }
}

function configChecks(cfg) {
  const delta = { id: 'close-time-delta', check: 'close-time security delta' };
  const slop = { id: 'hallucinated-package-check', check: 'hallucinated-package check' };
  if (cfg.problem) {
    return [
      { ...delta, state: 'not-measurable', detail: 'Session Config not read', reason: cfg.problem },
      { ...slop, state: 'not-measurable', detail: 'Session Config not read', reason: cfg.problem },
    ];
  }
  const mode = cfg.config?.['security-delta']?.mode;
  const enabled = cfg.config?.slopcheck?.enabled;
  return [
    typeof mode !== 'string'
      ? { ...delta, state: 'not-measurable', detail: 'security-delta.mode has no value', reason: 'parser returned no mode', file: cfg.rel }
      : mode === 'off'
        ? { ...delta, state: 'off', detail: 'security-delta.mode: off (also the value when the key is absent)', file: cfg.rel }
        : { ...delta, state: 'on', detail: `security-delta.mode: ${mode}`, file: cfg.rel },
    typeof enabled !== 'boolean'
      ? { ...slop, state: 'not-measurable', detail: 'slopcheck.enabled has no value', reason: 'parser returned no boolean', file: cfg.rel }
      : { ...slop, state: enabled ? 'on' : 'off', detail: `slopcheck.enabled: ${enabled}`, file: cfg.rel },
  ];
}

const count = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** Advisory pulse from the host-local cache: counts only, never a cached string. */
function pulseCheck(repoRoot, env, now) {
  const base = { id: 'advisory-pulse', check: 'advisory pulse' };
  let entry;
  try {
    entry = readCacheFile(cachePaths(repoRoot, { env }).repoFile);
  } catch (err) {
    return { ...base, state: 'not-measurable', detail: 'pulse cache not read', reason: `cache path unresolvable (${failureCode(err)})` };
  }
  if (!entry.ok) {
    const reason = entry.reason === 'absent'
      ? 'no pulse cache entry for this checkout; the cache is keyed by the checkout path, so worktrees usually have none'
      : `pulse cache entry ${entry.reason}`;
    return { ...base, state: 'not-measurable', detail: 'pulse cache not read', reason };
  }
  const fetched = stampMs(entry.value.fetched_at);
  const age = fetched === null ? 'age unknown' : `${Math.max(0, Math.round((now.getTime() - fetched) / 3_600_000))} h old`;
  // The refresh writes the lockfile check's status (CHECK_STATUS) and short machine reason.
  // Only a reason of the machine-token shape is shown; anything else could be cached text.
  const recStatus = entry.value.status;
  if (recStatus === 'skipped') {
    // BV-004 ceiling: expose only runLockfileCheck's two skip reasons; cached text may name a package.
    // Revisit-Trigger: runLockfileCheck emits another skip reason.
    const reason = ['no-range', 'no-lockfile-change'].includes(entry.value.reason) ? entry.value.reason : 'unknown';
    return { ...base, state: 'skipped', detail: `pulse cache ${age}`, reason: `last pulse refresh skipped (${reason})` };
  }
  if (recStatus === 'degraded' || recStatus === 'not-measurable') {
    const rawReason = entry.value.reason;
    const reasonClass = typeof rawReason === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(rawReason) ? rawReason : 'unknown';
    return { ...base, state: 'not-measurable', detail: `pulse cache ${age}`, reason: `last pulse refresh ${recStatus} (${reasonClass})` };
  }
  const total = count(entry.value.findings_total);
  const checked = count(entry.value.checked);
  const unchecked = count(entry.value.unchecked);
  if (total === null || checked === null || unchecked === null) {
    return { ...base, state: 'not-measurable', detail: 'pulse cache entry has no counts', reason: 'cache entry shape not recognised' };
  }
  return {
    ...base,
    state: 'on',
    detail: `${total} advisory finding(s), ${checked} package(s) checked, ${unchecked} not checked; cache ${age}`,
    counts: { findings: total, checked, unchecked },
  };
}

function mirrorAuditCheck(reader, ci) {
  const base = { id: 'mirror-protection-audit', check: 'mirror-protection audit' };
  const needle = /github-protection-audit/;
  if (!ci.problem) {
    const hit = ci.files.find((f) => f.lines.some((l) => needle.test(l)));
    if (hit) return { ...base, state: 'on', detail: `called in ${hit.rel}`, file: hit.rel };
  }
  let pkg;
  try {
    const text = reader.read('package.json');
    pkg = text === null ? null : JSON.parse(text);
  } catch (err) {
    return { ...base, state: 'not-measurable', detail: 'package.json not read', reason: `package.json unreadable (${failureCode(err)})` };
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? Object.values(pkg.scripts) : [];
  if (scripts.some((s) => typeof s === 'string' && needle.test(s))) {
    return { ...base, state: 'on', detail: 'called by a package.json script', file: 'package.json' };
  }
  if (ci.problem) return { ...base, state: 'not-measurable', detail: 'CI configuration could not be read', reason: ci.problem };
  return { ...base, state: 'not-wired', detail: 'no CI job or package.json script calls github-protection-audit' };
}

/**
 * Renovate and Dependabot config files, shared by `status` and `posture` (`posture.mjs`).
 * An entry ending in `*` is a root-level name prefix (`.renovaterc`, `.renovaterc.json`, …).
 */
export const UPDATE_AUTOMATION_FILES = Object.freeze([
  'renovate.json', 'renovate.json5', '.renovaterc*',
  '.gitlab/renovate.json', '.github/renovate.json', '.github/dependabot.yml', '.github/dependabot.yaml',
]);

/**
 * Update-automation config files present, per UPDATE_AUTOMATION_FILES: root hits in
 * listing order first, then nested entries in list order.
 * @param {(dir: string) => string[]} list  names directly inside `dir` ('' = repo root); may throw
 * @returns {string[]} repo-relative paths
 */
export function findUpdateAutomationFiles(list) {
  const rootEntries = UPDATE_AUTOMATION_FILES.filter((e) => !e.includes('/'));
  const found = list('').filter((n) => rootEntries.some((e) => (e.endsWith('*') ? n.startsWith(e.slice(0, -1)) : n === e)));
  for (const rel of UPDATE_AUTOMATION_FILES.filter((e) => e.includes('/'))) {
    const [dir, name] = rel.split('/');
    if (list(dir).includes(name)) found.push(rel);
  }
  return found;
}

function updateAutomationCheck(reader) {
  const base = { id: 'update-automation', check: 'update automation' };
  try {
    const found = findUpdateAutomationFiles((dir) => reader.list(dir));
    if (found.length > 0) return { ...base, state: 'on', detail: `config: ${found.join(', ')}`, file: found[0] };
    return { ...base, state: 'not-wired', detail: 'no Renovate or Dependabot config in this repo' };
  } catch (err) {
    return { ...base, state: 'not-measurable', detail: 'repo tree not listed', reason: `listing failed (${failureCode(err)})` };
  }
}

/**
 * @param {{repoRoot: string, ref: string|null, env: NodeJS.ProcessEnv, now: Date}} args
 * @returns {Promise<import('./contract.mjs').Result>}
 */
export async function run({ repoRoot, ref, env, now }) {
  const reader = makeReader(repoRoot, ref);
  const ci = readCi(reader);
  const checks = [
    ...ciChecks(ci),
    ...configChecks(readConfig(reader, repoRoot, ref)),
    pulseCheck(repoRoot, env, now),
    mirrorAuditCheck(reader, ci),
    updateAutomationCheck(reader),
  ];
  const notChecked = checks.filter((c) => c.state === 'not-measurable').length;
  const basis = { tree: ref === null ? 'working-tree' : 'commit', ref, note: ref === null ? null : 'the advisory pulse is per checkout, not per commit' };
  if (notChecked === checks.length) {
    return makeResult({ mode: 'status', status: 'degraded', checks, notChecked, basis, reason: 'no mechanism state could be read' });
  }
  return makeResult({ mode: 'status', status: 'ok', checks, notChecked, basis });
}
