#!/usr/bin/env node
/**
 * promote-vault-strict.mjs — promotes vault-integration mode: warn → strict
 * for eligible repos that pass the #305 DoD (≤5% invalid learnings + sessions).
 *
 * Usage:
 *   node scripts/promote-vault-strict.mjs [--repo <path>] [--apply] [--no-baseline]
 *
 * Flags:
 *   --repo <path>    Process only the given repo path (overrides ELIGIBLE_REPOS list)
 *   --apply          Write files and create git commits (DEFAULT: dry-run)
 *   --no-baseline    Skip the baseline template at ~/Projects/projects-baseline/…
 *
 * Exit codes:
 *   0  All repos processable (committed, already-strict, or no-config skips)
 *   1  One or more unrecoverable errors occurred
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Source: .orchestrator/audits/cross-repo-warn-strict-readiness.md (2026-05-01 D3 audit)
const ELIGIBLE_REPOS = [
  '~/Projects/Codex-Hackathon',
  '~/Projects/EventDrop.at',
  '~/Projects/GotzendorferAT',
  '~/Projects/WalkAITalkie',
  '~/Projects/ai-gateway',
  '~/Projects/eventdrop-render-service',
  '~/Projects/feedfoundry',
  '~/Projects/launchpad',
];

const BASELINE_TEMPLATE =
  '~/Projects/projects-baseline/templates/shared/CLAUDE.md.template';

const COMMIT_MSG = 'chore(orchestrator): Promote vault-integration to strict mode — refs #305';

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const helpFlag = args.includes('--help') || args.includes('-h');
if (helpFlag) {
  process.stdout.write(`Usage: promote-vault-strict.mjs [--repo <path>] [--apply] [--no-baseline]

Options:
  --repo <path>    Process only the given repo path (overrides ELIGIBLE_REPOS list)
  --apply          Write files and create git commits (default: dry-run)
  --no-baseline    Skip the baseline template

Exit codes:  0 success  1 error
`);
  process.exit(0);
}

const applyFlag = args.includes('--apply');
const dryRun = !applyFlag;
const noBaseline = args.includes('--no-baseline');

const repoIdx = args.indexOf('--repo');
const singleRepo = repoIdx !== -1 && args[repoIdx + 1] ? args[repoIdx + 1] : null;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/** Expand leading ~ to the user's home directory. */
function expandHome(p) {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

// ---------------------------------------------------------------------------
// Vault-integration mode replacement
// ---------------------------------------------------------------------------

/**
 * Patterns handled:
 *
 * 1. Inline: `- **vault-integration:** { ..., mode: warn }` (single line)
 *    The entire `mode: warn` token is on the same line as vault-integration.
 *
 * 2. YAML block:
 *    ```
 *    vault-integration:
 *      enabled: true
 *      vault-dir: ~/Projects/vault
 *      mode: warn               # comment
 *    ```
 *    Here `mode:` is indented and belongs to the vault-integration block.
 *
 * Strategy: find the line(s) that compose the vault-integration entry and
 * replace `mode: warn` only within those lines. We process the file line by
 * line to avoid greedy regex across unrelated blocks.
 *
 * Returns: { replaced: boolean, content: string, lineNumber: number | null }
 */
function replaceVaultMode(content, fromMode, toMode) {
  const lines = content.split('\n');
  let replaced = false;
  let lineNumber = null;

  // Mode 1: inline `vault-integration: { ..., mode: warn }`
  // We find any line that contains "vault-integration" AND "mode: <fromMode>".
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/vault-integration/i.test(line) && line.includes(`mode: ${fromMode}`)) {
      lines[i] = line.replace(`mode: ${fromMode}`, `mode: ${toMode}`);
      replaced = true;
      lineNumber = i + 1; // 1-based
      break;
    }
  }

  if (!replaced) {
    // Mode 2: YAML block — vault-integration: on its own line, followed by
    // indented child lines until the indentation decreases.
    let inVaultBlock = false;
    let blockIndent = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trimStart();
      const indent = line.length - trimmed.length;

      if (!inVaultBlock) {
        // Start of vault-integration block: line must match
        // (optional leading spaces) vault-integration:
        if (/^\s*vault-integration:\s*$/.test(line)) {
          inVaultBlock = true;
          blockIndent = indent;
          continue;
        }
      } else {
        // We're inside the block. A line with indent <= blockIndent (and
        // non-empty) signals end of block.
        if (line.trim() === '') continue; // blank lines are ok inside blocks

        if (indent <= blockIndent) {
          // Exited block without finding mode line
          break;
        }

        // Look for `mode: warn` in this child line
        if (/^\s+mode:\s+/.test(line) && line.includes(`mode: ${fromMode}`)) {
          lines[i] = line.replace(`mode: ${fromMode}`, `mode: ${toMode}`);
          replaced = true;
          lineNumber = i + 1;
          break;
        }
      }
    }
  }

  return { replaced, content: lines.join('\n'), lineNumber };
}

/**
 * Check whether a file contains vault-integration config with a given mode.
 *
 * Returns: 'warn' | 'strict' | 'other' | 'absent'
 */
function detectVaultMode(content) {
  // Inline form
  const inlineMatch = content.match(/vault-integration[^}]*mode:\s*(\w+)/);
  if (inlineMatch) return inlineMatch[1];

  // Block form — scan for vault-integration: block then mode:
  const lines = content.split('\n');
  let inVaultBlock = false;
  let blockIndent = -1;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (!inVaultBlock) {
      if (/^\s*vault-integration:\s*$/.test(line)) {
        inVaultBlock = true;
        blockIndent = indent;
        continue;
      }
    } else {
      if (line.trim() === '') continue;
      if (indent <= blockIndent) break;

      const modeMatch = line.match(/^\s+mode:\s+(\w+)/);
      if (modeMatch) return modeMatch[1];
    }
  }

  return 'absent';
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Run git -C <repoDir> with given args. Returns { ok, output, error }.
 */
function git(repoDir, gitArgs) {
  const result = spawnSync('git', ['-C', repoDir, ...gitArgs], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return {
    ok: result.status === 0,
    output: (result.stdout || '').trim(),
    error: (result.stderr || '').trim(),
  };
}

// ---------------------------------------------------------------------------
// Process a single target (repo or standalone file)
// ---------------------------------------------------------------------------

/**
 * @typedef {{ repo: string, configFile: string | null, status: string, commitSha: string, lineNumber: number | null }} RepoResult
 */

/**
 * Process one repo directory.
 *
 * @param {string} repoDir  Absolute path to the repo root
 * @param {object} opts
 * @param {boolean} opts.apply
 * @returns {RepoResult}
 */
function processRepo(repoDir, { apply }) {
  const claudePath = join(repoDir, 'CLAUDE.md');
  const agentsPath = join(repoDir, 'AGENTS.md');

  let configFile = null;
  if (existsSync(claudePath)) {
    configFile = claudePath;
  } else if (existsSync(agentsPath)) {
    configFile = agentsPath;
  }

  if (!configFile) {
    return { repo: repoDir, configFile: null, status: 'no-config-file', commitSha: '', lineNumber: null };
  }

  let content;
  try {
    content = readFileSync(configFile, 'utf8');
  } catch (err) {
    process.stderr.write(`promote-vault-strict: WARN failed to read ${configFile}: ${err.message}\n`);
    return { repo: repoDir, configFile, status: 'error', commitSha: '', lineNumber: null };
  }

  const detectedMode = detectVaultMode(content);

  if (detectedMode === 'absent') {
    return { repo: repoDir, configFile, status: 'no-config', commitSha: '', lineNumber: null };
  }

  if (detectedMode === 'strict') {
    return { repo: repoDir, configFile, status: 'already-strict', commitSha: '', lineNumber: null };
  }

  if (detectedMode !== 'warn') {
    return { repo: repoDir, configFile, status: `no-config`, commitSha: '', lineNumber: null };
  }

  // We have mode: warn — replace it
  const { replaced, content: newContent, lineNumber } = replaceVaultMode(content, 'warn', 'strict');

  if (!replaced) {
    // Detected warn but replacement failed — unexpected
    process.stderr.write(`promote-vault-strict: WARN could not replace mode in ${configFile}\n`);
    return { repo: repoDir, configFile, status: 'error', commitSha: '', lineNumber: null };
  }

  if (!apply) {
    // Dry-run: show what would change
    process.stdout.write(`  ${configFile}:${lineNumber}: mode: warn → mode: strict\n`);
    return { repo: repoDir, configFile, status: 'would-change', commitSha: '', lineNumber };
  }

  // Apply: write and commit
  try {
    writeFileSync(configFile, newContent, 'utf8');
  } catch (err) {
    process.stderr.write(`promote-vault-strict: ERROR failed to write ${configFile}: ${err.message}\n`);
    return { repo: repoDir, configFile, status: 'error', commitSha: '', lineNumber };
  }

  const addResult = git(repoDir, ['add', relative(repoDir, configFile)]);
  if (!addResult.ok) {
    process.stderr.write(`promote-vault-strict: ERROR git add failed in ${repoDir}: ${addResult.error}\n`);
    return { repo: repoDir, configFile, status: 'error', commitSha: '', lineNumber };
  }

  const commitResult = git(repoDir, ['commit', '-m', COMMIT_MSG]);
  if (!commitResult.ok) {
    process.stderr.write(`promote-vault-strict: ERROR git commit failed in ${repoDir}: ${commitResult.error}\n`);
    return { repo: repoDir, configFile, status: 'error', commitSha: '', lineNumber };
  }

  // Extract commit SHA
  const shaResult = git(repoDir, ['rev-parse', '--short', 'HEAD']);
  const commitSha = shaResult.ok ? shaResult.output : '';

  process.stdout.write(`  committed ${commitSha} in ${repoDir}\n`);
  return { repo: repoDir, configFile, status: 'committed', commitSha, lineNumber };
}

/**
 * Process a standalone file (used for the baseline template, which is not a
 * full git repo root — the git root is projects-baseline).
 *
 * @param {string} filePath     Absolute path to the config file
 * @param {string} gitRepoDir   Absolute path to the git repo root
 * @param {object} opts
 * @param {boolean} opts.apply
 * @returns {RepoResult}
 */
function processFile(filePath, gitRepoDir, { apply }) {
  if (!existsSync(filePath)) {
    process.stderr.write(`promote-vault-strict: WARN baseline template not found: ${filePath}\n`);
    return { repo: filePath, configFile: null, status: 'no-config-file', commitSha: '', lineNumber: null };
  }

  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`promote-vault-strict: WARN failed to read ${filePath}: ${err.message}\n`);
    return { repo: filePath, configFile: filePath, status: 'error', commitSha: '', lineNumber: null };
  }

  const detectedMode = detectVaultMode(content);

  if (detectedMode === 'absent') {
    return { repo: filePath, configFile: filePath, status: 'no-config', commitSha: '', lineNumber: null };
  }

  if (detectedMode === 'strict') {
    return { repo: filePath, configFile: filePath, status: 'already-strict', commitSha: '', lineNumber: null };
  }

  if (detectedMode !== 'warn') {
    return { repo: filePath, configFile: filePath, status: 'no-config', commitSha: '', lineNumber: null };
  }

  const { replaced, content: newContent, lineNumber } = replaceVaultMode(content, 'warn', 'strict');

  if (!replaced) {
    process.stderr.write(`promote-vault-strict: WARN could not replace mode in ${filePath}\n`);
    return { repo: filePath, configFile: filePath, status: 'error', commitSha: '', lineNumber: null };
  }

  if (!apply) {
    process.stdout.write(`  ${filePath}:${lineNumber}: mode: warn → mode: strict\n`);
    return { repo: filePath, configFile: filePath, status: 'would-change', commitSha: '', lineNumber };
  }

  try {
    writeFileSync(filePath, newContent, 'utf8');
  } catch (err) {
    process.stderr.write(`promote-vault-strict: ERROR failed to write ${filePath}: ${err.message}\n`);
    return { repo: filePath, configFile: filePath, status: 'error', commitSha: '', lineNumber };
  }

  const relPath = relative(gitRepoDir, filePath);

  const addResult = git(gitRepoDir, ['add', relPath]);
  if (!addResult.ok) {
    process.stderr.write(`promote-vault-strict: ERROR git add failed: ${addResult.error}\n`);
    return { repo: filePath, configFile: filePath, status: 'error', commitSha: '', lineNumber };
  }

  const commitResult = git(gitRepoDir, ['commit', '-m', COMMIT_MSG]);
  if (!commitResult.ok) {
    process.stderr.write(`promote-vault-strict: ERROR git commit failed: ${commitResult.error}\n`);
    return { repo: filePath, configFile: filePath, status: 'error', commitSha: '', lineNumber };
  }

  const shaResult = git(gitRepoDir, ['rev-parse', '--short', 'HEAD']);
  const commitSha = shaResult.ok ? shaResult.output : '';

  process.stdout.write(`  committed ${commitSha} in ${gitRepoDir} (baseline template)\n`);
  return { repo: filePath, configFile: filePath, status: 'committed', commitSha, lineNumber };
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

/**
 * Render a Markdown table from results.
 * @param {RepoResult[]} results
 */
function renderTable(results) {
  const rows = results.map((r) => {
    const repoLabel = r.repo.replace(homedir(), '~');
    const configLabel = r.configFile ? r.configFile.replace(homedir(), '~') : '—';
    return [repoLabel, configLabel, r.status, r.commitSha || '—'];
  });

  const headers = ['repo', 'config-file', 'status', 'commit-sha'];
  const allRows = [headers, ...rows];

  // Column widths
  const widths = headers.map((_, ci) =>
    Math.max(...allRows.map((row) => row[ci].length))
  );

  const sep = widths.map((w) => '-'.repeat(w)).join(' | ');
  const header = headers.map((h, ci) => h.padEnd(widths[ci])).join(' | ');
  const body = rows.map((row) => row.map((cell, ci) => cell.padEnd(widths[ci])).join(' | ')).join('\n');

  return `${header}\n${sep}\n${body}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

process.stdout.write(
  `promote-vault-strict: ${dryRun ? 'DRY-RUN' : 'APPLY'} mode\n\n`
);

/** @type {RepoResult[]} */
const results = [];

if (singleRepo) {
  // Single-repo mode
  const absRepo = expandHome(singleRepo);
  process.stdout.write(`Processing: ${absRepo}\n`);
  results.push(processRepo(absRepo, { apply: applyFlag }));
} else {
  // Batch mode — eligible repos
  for (const rawPath of ELIGIBLE_REPOS) {
    const absRepo = expandHome(rawPath);
    process.stdout.write(`Processing: ${absRepo}\n`);
    results.push(processRepo(absRepo, { apply: applyFlag }));
  }

  // Baseline template (unless --no-baseline)
  if (!noBaseline) {
    const templatePath = expandHome(BASELINE_TEMPLATE);
    const templateGitRoot = expandHome('~/Projects/projects-baseline');
    process.stdout.write(`Processing baseline: ${templatePath}\n`);
    results.push(processFile(templatePath, templateGitRoot, { apply: applyFlag }));
  }
}

process.stdout.write('\n## Summary\n\n');
process.stdout.write(renderTable(results));
process.stdout.write('\n');

// Exit code
const hasError = results.some((r) => r.status === 'error');
process.exit(hasError ? 1 : 0);
