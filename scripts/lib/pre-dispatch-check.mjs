/**
 * pre-dispatch-check.mjs — guard against untracked-file data loss when
 * Claude Code's Agent tool runs with `isolation: "worktree"`.
 *
 * Background (issue #180): the Agent tool's built-in worktree isolation
 * syncs directories back to the coordinator's working tree when the agent
 * completes. If the coordinator holds untracked files that overlap with
 * the agent's scope, the sync silently overwrites them. This helper lets
 * the coordinator detect the overlap before dispatching, and either warn
 * or hard-refuse per the caller's policy.
 *
 * Stdlib-only, cross-platform, no zx.
 */

import { execFileSync } from 'node:child_process';
import { pathMatchesPattern } from './hardening.mjs';

/**
 * @typedef {Object} OverlapResult
 * @property {string[]} overlapping        relative paths of untracked files overlapping the scope
 * @property {string[]} untracked          full list of untracked files discovered
 * @property {'ok'|'warn'|'block'} decision
 * @property {string} message              human-readable summary
 */

/**
 * Detect untracked coordinator files that overlap a planned agent scope.
 *
 * @param {Object} opts
 * @param {string[]} opts.scope        agent file scope (paths, directories, or globs)
 * @param {string}   [opts.cwd]        project root (defaults to process.cwd())
 * @param {'warn'|'block'|'off'} [opts.mode='warn']
 *   - `warn`  — return decision:'warn' when overlap found
 *   - `block` — return decision:'block' when overlap found
 *   - `off`   — never flag (short-circuit, decision:'ok')
 * @returns {OverlapResult}
 */
export function checkUntrackedOverlap({ scope, cwd = process.cwd(), mode = 'warn' } = {}) {
  if (mode === 'off') {
    return { overlapping: [], untracked: [], decision: 'ok', message: 'pre-dispatch check disabled' };
  }

  if (!Array.isArray(scope) || scope.length === 0) {
    return { overlapping: [], untracked: [], decision: 'ok', message: 'empty scope — no overlap possible' };
  }

  const untracked = listUntracked(cwd);

  const overlapping = untracked.filter((file) => scope.some((pat) => pathMatchesPattern(file, pat)));

  if (overlapping.length === 0) {
    return { overlapping: [], untracked, decision: 'ok', message: 'no overlap between untracked files and agent scope' };
  }

  const decision = mode === 'block' ? 'block' : 'warn';
  const verb = decision === 'block' ? 'REFUSING' : 'WARNING';
  const action =
    decision === 'block'
      ? 'commit or stash them before dispatching, or rerun with mode=warn to acknowledge the risk'
      : 'the Agent tool\'s worktree isolation may overwrite these on merge-back (issue #180)';
  const message =
    `${verb}: ${overlapping.length} untracked coordinator file(s) overlap the agent scope — ${action}\n` +
    overlapping.map((f) => `  - ${f}`).join('\n');

  return { overlapping, untracked, decision, message };
}

/**
 * Run `git status --porcelain` and extract untracked files (prefix "??").
 * Returns paths relative to `cwd`. Returns [] on any git failure.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
export function listUntracked(cwd) {
  let stdout;
  try {
    stdout = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' });
  } catch {
    return [];
  }

  const files = [];
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.startsWith('?? ')) continue;
    // Porcelain v1 wraps paths in quotes when they contain special chars. Strip them.
    let rel = rawLine.slice(3);
    if (rel.startsWith('"') && rel.endsWith('"')) {
      rel = rel.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    // Directory entries end with `/` in porcelain output — expand to file list for fidelity.
    if (rel.endsWith('/')) {
      files.push(...expandDirectory(cwd, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

/**
 * Enumerate untracked files under a directory via `git ls-files --others`.
 * Runs in the given cwd and resolves the directory relative to that root.
 * Returns repo-relative paths. Best-effort — swallows errors and falls back
 * to the directory entry itself so callers still see something.
 *
 * @param {string} cwd
 * @param {string} relDir  repo-relative directory with trailing `/`
 * @returns {string[]}
 */
function expandDirectory(cwd, relDir) {
  try {
    const stdout = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', relDir],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const lines = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return lines.length > 0 ? lines : [relDir];
  } catch {
    return [relDir];
  }
}
