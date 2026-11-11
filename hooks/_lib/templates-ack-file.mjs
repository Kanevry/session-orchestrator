/**
 * templates-ack-file.mjs — the templates-first acknowledgement-file resolver.
 *
 * #1917 point 1: `/templates-ack` (commands/templates-ack.md) and the
 * pre-bash-templates-first hook must name one file, so they share one
 * resolver. It lives here, not in the hook, because a top-level hook entry
 * module is a process entry point and must not be loaded as a library.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveProjectDir, resolvePluginRoot, resolveRuntimeStateRoot } from '../../scripts/lib/platform.mjs';
import { readJson } from '../../scripts/lib/common.mjs';

/**
 * Default acknowledgement path, relative to project root. Used when the
 * policy omits the `acknowledgement_file` key.
 */
const DEFAULT_ACK_PATH = '.orchestrator/runtime/templates-acknowledged.json';

/**
 * Resolve the policy file path, searching in priority order. Mirrors the
 * resolution chain in pre-bash-destructive-guard.mjs so administrators only
 * have to maintain a single mental model for policy locations.
 *
 * @param {string|null} projectDir
 * @returns {string|null}
 */
export function resolvePolicyPath(projectDir) {
  const candidates = [
    path.join(
      process.cwd(),
      '.orchestrator',
      'policy',
      'templates-policy.json',
    ),
  ];

  if (projectDir && projectDir !== process.cwd()) {
    candidates.push(
      path.join(projectDir, '.orchestrator', 'policy', 'templates-policy.json'),
    );
  }

  const pluginRoot = resolvePluginRoot();
  if (pluginRoot) {
    candidates.push(
      path.join(pluginRoot, '.orchestrator', 'policy', 'templates-policy.json'),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Absolute acknowledgement-file path for a loaded policy: `acknowledgement_file`
 * when it is a nonempty string, else {@link DEFAULT_ACK_PATH}. A relative path is
 * runtime state, not a tracked file: it resolves under the checkout root of
 * `baseDir` (main checkout for a linked worktree, never a subdirectory —
 * #1729, #1730 Pkt 5), so the hook and `/templates-ack` name one file.
 *
 * @param {object|null} policy  parsed templates policy (may be null)
 * @param {string} baseDir
 * @returns {string}
 */
export function resolveAckFilePath(policy, baseDir) {
  const raw = policy && typeof policy === 'object' ? policy.acknowledgement_file : undefined;
  const ackRel = typeof raw === 'string' && raw.length > 0 ? raw : DEFAULT_ACK_PATH;
  return path.isAbsolute(ackRel) ? ackRel : path.join(resolveRuntimeStateRoot(baseDir), ackRel);
}

/**
 * The acknowledgement file `/templates-ack` writes (#1730 Pkt 4): the same
 * policy file and the same default the hook uses. A missing or unreadable
 * policy yields the default path (the hook then skips the guard anyway).
 *
 * @param {{ projectDir?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function resolveTemplatesAckFile({ projectDir = resolveProjectDir() } = {}) {
  const policyPath = resolvePolicyPath(projectDir);
  let policy = null;
  if (policyPath) {
    try { policy = await readJson(policyPath); } catch { policy = null; }
  }
  return resolveAckFilePath(policy, projectDir || process.cwd());
}
