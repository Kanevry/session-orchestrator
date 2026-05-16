/**
 * cli.mjs — GitLab Portfolio CLI orchestrator.
 *
 * Discovers repos from the vault → aggregates open issues → renders the
 * portfolio markdown → writes it to the vault. Designed to be invoked by
 * the /portfolio command and by session-start hooks when enabled.
 *
 * Usage:
 *   node scripts/lib/gitlab-portfolio/cli.mjs [flags]
 *
 * Flags:
 *   --dry-run          Never write to disk (passes dryRun: true to writePortfolio)
 *   --repo <slug|id>   Restrict to a single repo by slug or repo identifier
 *   --vault-dir <path> Override the vault-dir from Session Config
 *   --config <path>    Override the Session Config file path (for tests)
 *   --json             Emit a single JSON summary line to stdout
 *   -h, --help         Show usage and exit 0
 *
 * Exit codes (per cli-design.md):
 *   0  Success (or disabled / no-repos)
 *   1  User / input error (bad args, repo not found, config issue)
 *   2  System error (vault-dir not configured, strict-mode failures)
 *
 * All dependencies are injectable via the second argument for testability.
 */

import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { readConfigFile, parseSessionConfig } from '../config.mjs';
import { parseFrontmatter } from '../vault-mirror/utils.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';

import { discoverVaultRepos } from './vcs-detect.mjs';
import { fetchIssuesMultiRepo, summarizeRepo } from './aggregator.mjs';
import { renderPortfolio, writePortfolio } from './markdown-writer.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` to os.homedir().
 *
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p === 'string' && p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

/**
 * Print a human-readable summary line to stdout.
 *
 * @param {string} label
 * @param {string} value
 */
function printField(label, value) {
  process.stdout.write(`  ${label}: ${value}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Orchestrate the GitLab Portfolio pipeline.
 *
 * @param {string[]} argv — CLI args (excluding node + script path)
 * @param {{
 *   fs?: object,
 *   parseConfig?: (content: string) => object,
 *   readConfig?: (root: string) => Promise<string>,
 *   discoverRepos?: typeof discoverVaultRepos,
 *   fetchIssues?: typeof fetchIssuesMultiRepo,
 *   summarize?: typeof summarizeRepo,
 *   render?: typeof renderPortfolio,
 *   write?: typeof writePortfolio,
 *   now?: () => Date,
 * }} [deps]
 * @returns {Promise<{
 *   exitCode: number,
 *   action: string,
 *   path?: string,
 *   reposScanned: number,
 *   reposFailed: number,
 *   openIssues?: number,
 *   critical?: number,
 *   stale?: number,
 * }>}
 */
export async function main(argv, deps = {}) {
  // ── Dependency injection ───────────────────────────────────────────────────
  const {
    fs: injectedFs,
    parseConfig = parseSessionConfig,
    readConfig = readConfigFile,
    discoverRepos = discoverVaultRepos,
    fetchIssues = fetchIssuesMultiRepo,
    summarize = summarizeRepo,
    render = renderPortfolio,
    write = writePortfolio,
    now: nowFn = () => new Date(),
  } = deps;

  // ── Argument parsing ───────────────────────────────────────────────────────
  let flagDryRun = false;
  let flagJson = false;
  let flagHelp = false;
  let optRepo = null;
  let optVaultDir = null;
  let optConfig = null;

  const argList = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < argList.length; i++) {
    const arg = argList[i];
    switch (arg) {
      case '--dry-run':
        flagDryRun = true;
        break;
      case '--json':
        flagJson = true;
        break;
      case '--help':
      case '-h':
        flagHelp = true;
        break;
      case '--repo': {
        const next = argList[i + 1];
        if (!next || next.startsWith('--')) {
          process.stderr.write(`gitlab-portfolio: --repo requires a value\n`);
          return { exitCode: 1, action: 'error', reposScanned: 0, reposFailed: 0 };
        }
        optRepo = next;
        i++;
        break;
      }
      case '--vault-dir': {
        const next = argList[i + 1];
        if (!next || next.startsWith('--')) {
          process.stderr.write(`gitlab-portfolio: --vault-dir requires a value\n`);
          return { exitCode: 1, action: 'error', reposScanned: 0, reposFailed: 0 };
        }
        optVaultDir = next;
        i++;
        break;
      }
      case '--config': {
        const next = argList[i + 1];
        if (!next || next.startsWith('--')) {
          process.stderr.write(`gitlab-portfolio: --config requires a value\n`);
          return { exitCode: 1, action: 'error', reposScanned: 0, reposFailed: 0 };
        }
        optConfig = next;
        i++;
        break;
      }
      default:
        process.stderr.write(`gitlab-portfolio: unknown argument: ${arg}\n`);
        process.stderr.write(`Run with --help for usage.\n`);
        return { exitCode: 1, action: 'error', reposScanned: 0, reposFailed: 0 };
    }
  }

  if (flagHelp) {
    process.stdout.write(`gitlab-portfolio — generate a GitLab Portfolio dashboard in the vault

USAGE
  node scripts/lib/gitlab-portfolio/cli.mjs [flags]

FLAGS
  --dry-run           Never write to disk; show what would be written.
  --repo <slug|id>    Restrict to a single repo by slug or repo identifier.
  --vault-dir <path>  Override the vault-dir from Session Config.
  --config <path>     Override the Session Config file path.
  --json              Emit a single JSON summary line to stdout.
  -h, --help          Show this help text and exit.

EXIT CODES
  0  Success (or feature disabled / no repos configured)
  1  User / input error (bad args, repo filter matched nothing)
  2  System error (vault-dir not configured, strict-mode repo failures)
`);
    return { exitCode: 0, action: 'help', reposScanned: 0, reposFailed: 0 };
  }

  // ── Load Session Config ────────────────────────────────────────────────────
  let config;
  try {
    let mdContent;
    if (optConfig) {
      mdContent = await readFile(optConfig, 'utf8');
    } else {
      mdContent = await readConfig(process.cwd());
    }
    config = parseConfig(mdContent);
  } catch (err) {
    process.stderr.write(`gitlab-portfolio: failed to load Session Config: ${err.message}\n`);
    return { exitCode: 2, action: 'error', reposScanned: 0, reposFailed: 0 };
  }

  // ── Check enabled flag ─────────────────────────────────────────────────────
  const portfolioConfig = config['gitlab-portfolio'] ?? {};
  if (portfolioConfig.enabled === false) {
    if (!flagJson) {
      process.stdout.write(`gitlab-portfolio: disabled (set gitlab-portfolio.enabled: true in Session Config)\n`);
    } else {
      process.stdout.write(JSON.stringify({ action: 'disabled', reposScanned: 0, reposFailed: 0 }) + '\n');
    }
    return { exitCode: 0, action: 'disabled', reposScanned: 0, reposFailed: 0 };
  }

  // ── Resolve vault-dir ──────────────────────────────────────────────────────
  const vaultIntegration = config['vault-integration'] ?? {};
  const configVaultDir = vaultIntegration['vault-dir'];
  const resolvedVaultDir = optVaultDir
    ? expandHome(optVaultDir)
    : configVaultDir
      ? expandHome(configVaultDir)
      : null;

  if (!resolvedVaultDir) {
    process.stderr.write(
      `gitlab-portfolio: vault-integration.vault-dir not configured in Session Config\n` +
      `  Add "vault-dir: ~/Projects/vault" under vault-integration: in CLAUDE.md (or AGENTS.md on Codex CLI)\n`,
    );
    return { exitCode: 2, action: 'error', reposScanned: 0, reposFailed: 0 };
  }

  // ── Path-traversal guard (CWE-22, GH #44) ─────────────────────────────────
  // Both lexical (../ traversal) and symlink-escape checks must pass.
  // Root: os.homedir() — vault is a per-user resource; must reside under ~.
  const vaultDirRoot = path.resolve(os.homedir());
  const vaultDirValidation = validatePathInsideProject(resolvedVaultDir, vaultDirRoot);
  if (!vaultDirValidation.ok) {
    if (vaultDirValidation.reason === 'symlink') {
      process.stderr.write(
        `gitlab-portfolio: --vault-dir resolves (via symlink) outside your home directory\n`,
      );
    } else {
      process.stderr.write(
        `gitlab-portfolio: --vault-dir must be inside your home directory (got: ${resolvedVaultDir})\n`,
      );
    }
    return { exitCode: 2, action: 'error', reposScanned: 0, reposFailed: 0 };
  }

  // ── Discover repos from vault ──────────────────────────────────────────────
  let discovered;
  try {
    discovered = await discoverRepos({
      vaultDir: resolvedVaultDir,
      fs: injectedFs ? {
        readdir: injectedFs.readdir,
        readFile: injectedFs.readFile,
        stat: injectedFs.stat,
      } : undefined,
      parseFrontmatter,
    });
  } catch (err) {
    process.stderr.write(`gitlab-portfolio: repo discovery failed: ${err.message}\n`);
    return { exitCode: 2, action: 'error', reposScanned: 0, reposFailed: 0 };
  }

  if (discovered.length === 0) {
    if (!flagJson) {
      process.stdout.write(`gitlab-portfolio: no-repos\n`);
      process.stdout.write(`  No repos found in ${resolvedVaultDir}/01-projects/ (add gitlab: or github: frontmatter to _overview.md files)\n`);
    } else {
      process.stdout.write(JSON.stringify({ action: 'no-repos', reposScanned: 0, reposFailed: 0 }) + '\n');
    }
    return { exitCode: 0, action: 'no-repos', reposScanned: 0, reposFailed: 0 };
  }

  // ── Filter to --repo if provided ───────────────────────────────────────────
  let reposToProcess = discovered;
  if (optRepo) {
    reposToProcess = discovered.filter(
      (r) => r.slug === optRepo || r.repo === optRepo,
    );
    if (reposToProcess.length === 0) {
      process.stderr.write(
        `gitlab-portfolio: --repo "${optRepo}" did not match any discovered repo\n` +
        `  Available slugs: ${discovered.map((r) => r.slug).join(', ')}\n`,
      );
      return { exitCode: 1, action: 'error', reposScanned: 0, reposFailed: 0 };
    }
  }

  // ── Fetch issues in parallel ───────────────────────────────────────────────
  const staleDays = portfolioConfig['stale-days'] ?? 30;
  const criticalLabels = portfolioConfig['critical-labels'] ?? ['priority:critical', 'priority:high'];
  const mode = portfolioConfig.mode ?? 'warn';

  let resultsMap;
  try {
    resultsMap = await fetchIssues({
      repos: reposToProcess,
      concurrency: 8,
      timeoutMs: 15_000,
    });
  } catch (err) {
    process.stderr.write(`gitlab-portfolio: fetchIssuesMultiRepo failed unexpectedly: ${err.message}\n`);
    return { exitCode: 2, action: 'error', reposScanned: 0, reposFailed: 0 };
  }

  // ── Summarize per-repo ─────────────────────────────────────────────────────
  const currentTime = nowFn();
  const summariesMap = new Map();
  let reposFailed = 0;
  let totalOpen = 0;
  let totalCritical = 0;
  let totalStale = 0;

  for (const { repo } of reposToProcess) {
    const result = resultsMap.get(repo);
    if (!result || result.ok === false) {
      reposFailed++;
      if (!flagJson) {
        process.stderr.write(`gitlab-portfolio: WARN: failed to fetch ${repo}: ${result?.error ?? 'no result'}\n`);
      }
      // Provide an empty summary for the failed repo so it still appears in the output
      summariesMap.set(repo, {
        openCount: 0,
        criticalCount: 0,
        staleCount: 0,
        nextMilestone: null,
        lastActivity: null,
        topThree: [],
      });
      continue;
    }

    const summary = summarize(result.issues, {
      now: currentTime,
      staleDays,
      criticalLabels,
    });
    summariesMap.set(repo, summary);
    totalOpen += summary.openCount;
    totalCritical += summary.criticalCount;
    totalStale += summary.staleCount;
  }

  // ── Render markdown ────────────────────────────────────────────────────────
  // Attempt to preserve createdIso from existing portfolio file.
  const outputPath = path.join(resolvedVaultDir, '01-projects', '_PORTFOLIO.md');
  let createdIso;
  try {
    const existingFsReadFile = injectedFs?.readFile ?? readFile;
    const existingContent = await existingFsReadFile(outputPath, 'utf8');
    const fm = parseFrontmatter(existingContent);
    createdIso = fm?.['created'] ?? undefined;
  } catch {
    // File does not exist yet — createdIso will be undefined, renderPortfolio uses now
    createdIso = undefined;
  }

  const content = render(summariesMap, {
    now: currentTime,
    createdIso,
    staleDays,
  });

  // ── Write portfolio ────────────────────────────────────────────────────────
  let writeResult;
  try {
    writeResult = write({
      outputPath,
      content,
      now: currentTime,
      dryRun: flagDryRun,
      fs: injectedFs,
    });
  } catch (err) {
    process.stderr.write(`gitlab-portfolio: write failed: ${err.message}\n`);
    return { exitCode: 2, action: 'error', reposScanned: reposToProcess.length, reposFailed };
  }

  const action = writeResult.action;
  const writtenPath = writeResult.path;
  const reposScanned = reposToProcess.length;

  // ── Apply error mode ───────────────────────────────────────────────────────
  let exitCode = 0;
  if (reposFailed > 0 && mode === 'strict') {
    exitCode = 2;
    process.stderr.write(
      `gitlab-portfolio: ${reposFailed} repo(s) failed to fetch and mode is strict → exit 2\n`,
    );
  }

  // ── Emit output ────────────────────────────────────────────────────────────
  const summary = {
    action,
    path: writtenPath,
    reposScanned,
    reposFailed,
    openIssues: totalOpen,
    critical: totalCritical,
    stale: totalStale,
  };

  if (flagJson) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(`gitlab-portfolio: ${action}\n`);
    printField('output', writtenPath ?? '(none)');
    printField('repos scanned', String(reposScanned));
    printField('repos failed', String(reposFailed));
    printField('open issues total', String(totalOpen));
    printField('critical total', String(totalCritical));
    printField('stale total', String(totalStale));
  }

  return { exitCode, ...summary };
}

// ── CLI guard — prevent process.exit during test-time imports ─────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((result) => {
    process.exit(result.exitCode);
  }).catch((err) => {
    process.stderr.write(`gitlab-portfolio: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
