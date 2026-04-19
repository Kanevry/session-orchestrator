#!/usr/bin/env node
/**
 * on-session-start.mjs — SessionStart hook: emit event + optional host/resource banner.
 *
 * Node.js port of hooks/on-session-start.sh. Part of v3.0.0 migration
 * (Epic #124, issue #140). Extended in v3.1.0 (Epic #157, issue #164) with a
 * host-identity + resource-probe banner surfaced via systemMessage, cached for
 * downstream skills at .orchestrator/host.json.
 *
 * Behaviour:
 *   1. Resolves project name and current git branch.
 *   2. When env-aware libs are available AND enable-host-banner config is true,
 *      collects host fingerprint + resource snapshot and emits a one-line
 *      systemMessage banner. Populates .orchestrator/host.json for skills.
 *   3. Emits "orchestrator.session.started" event to .orchestrator/metrics/events.jsonl.
 *   4. Optionally POSTs to Clank Event Bus if CLANK_EVENT_SECRET is set.
 *
 * Exit codes:
 *   0 — always (informational, never blocking)
 *
 * hooks.json wiring (SessionStart, async: true, timeout: 5s) is managed separately.
 * stdin: none expected.
 */

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

import { emitEvent } from '../scripts/lib/events.mjs';
import { SO_PLATFORM, resolveProjectDir } from '../scripts/lib/platform.mjs';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a git command in cwd; return trimmed stdout. Returns null on failure.
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function gitOutput(args, cwd) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * Read `enable-host-banner` from CLAUDE.md / AGENTS.md Session Config. Returns
 * true as the default — missing config or parse errors fall back to enabled,
 * matching the documented behaviour for issue #166.
 */
async function isHostBannerEnabled(projectRoot) {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    try {
      const raw = await readFile(path.join(projectRoot, name), 'utf8');
      const m = raw.match(/^\s*enable-host-banner:\s*(true|false)\b/im);
      if (m) return m[1].toLowerCase() === 'true';
    } catch { /* file missing is fine */ }
  }
  return true;
}

/**
 * Attempt to collect and emit the host + resource banner. Pure best-effort:
 * any failure (missing lib, no home dir, probe throws) is swallowed so the
 * session-start hook never blocks.
 * @returns {Promise<{host: object, resources: object}|null>}
 */
async function emitHostBanner(projectRoot) {
  try {
    const [{ getHostFingerprint }, { probe }] = await Promise.all([
      import('../scripts/lib/host-identity.mjs'),
      import('../scripts/lib/resource-probe.mjs'),
    ]);
    const [host, resources] = await Promise.all([
      getHostFingerprint(projectRoot).catch(() => null),
      probe({ skipProcessCounts: false }).catch(() => null),
    ]);
    if (!host || !resources) return null;

    const hostLine = `🖥️  Host: ${host.host_class} · ${host.ram_total_gb} GB RAM · ${host.platform ?? 'unknown'} · ${host.is_ssh ? 'ssh' : 'local'}`;
    const procSuffix = resources.claude_processes_count === null
      ? ''
      : ` · ${resources.claude_processes_count} Claude process${resources.claude_processes_count === 1 ? '' : 'es'} running`;
    const resourceLine = `📊 Resources: ${resources.ram_free_gb.toFixed(1)} GB free · CPU ${resources.cpu_load_pct}%${procSuffix}`;
    const banner = `${hostLine}\n${resourceLine}`;

    // systemMessage envelope is the Claude Code hook contract; ignored by
    // consumers that do not read stdout, harmless in all cases.
    console.log(JSON.stringify({ systemMessage: banner }));

    return { host, resources };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const projectRoot = resolveProjectDir();

  // Resolve project name: basename of git toplevel, falling back to cwd basename.
  const topLevel = await gitOutput(['rev-parse', '--show-toplevel'], projectRoot);
  const projectName = topLevel
    ? topLevel.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown'
    : projectRoot.split(/[/\\]/).filter(Boolean).pop() ?? 'unknown';

  // Resolve current branch; fall back to "unknown" when detached HEAD or no git.
  const branch = (await gitOutput(['branch', '--show-current'], projectRoot)) ?? 'unknown';

  // v3.1.0 env-aware banner (opt-out via enable-host-banner: false in Session Config).
  let bannerData = null;
  if (await isHostBannerEnabled(projectRoot)) {
    bannerData = await emitHostBanner(projectRoot);
  }

  const payload = {
    platform: process.env.SO_PLATFORM ?? SO_PLATFORM,
    project: projectName,
    branch,
  };
  if (bannerData) {
    payload.host_class = bannerData.host.host_class;
    payload.ram_free_gb = bannerData.resources.ram_free_gb;
    payload.cpu_load_pct = bannerData.resources.cpu_load_pct;
    payload.claude_processes_count = bannerData.resources.claude_processes_count;
  }
  await emitEvent('orchestrator.session.started', payload);
}

// Top-level guard — always exit 0 (non-blocking informational hook).
main().catch(() => {}).finally(() => {
  process.exit(0);
});
