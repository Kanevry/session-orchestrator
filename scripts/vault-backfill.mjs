#!/usr/bin/env node
/**
 * vault-backfill.mjs — GitLab group scanner + .vault.yaml backfill CLI (Issue #241).
 *
 * Scans GitLab groups for repos missing .vault.yaml and either previews (dry-run,
 * default) or renders the canonical template content (--apply).
 *
 * CLI usage:
 *   node scripts/vault-backfill.mjs [--groups <CSV>] [--dry-run] [--apply]
 *     [--out-dir <path>] [--yes <manifest.json>] [--vault-dir <path>] [--verbose]
 *
 * Exit codes:
 *   0 — success (clean run, dry or apply, even if some repos skipped)
 *   1 — validation error (bad CLI flags, missing --groups AND no Session Config
 *         gitlab-groups, malformed manifest, missing glab CLI)
 *   2 — filesystem error (template missing, cannot write to out-dir)
 *   3 — GitLab API error (auth failure, rate limit, group not found — when ALL
 *         groups fail to resolve OR all repo-probes fail and nothing was processed)
 *   4 — dry-run found nothing to backfill (informational; not an error)
 *
 * All logging → stderr. Structured JSON actions → stdout (one object per line).
 * No external dependencies — Node stdlib only.
 *
 * Part of Vault-Docs Sub-Epic C (Issue #241).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';

import {
  assertGlabExists, setVerbose as setGlabVerbose,
  listGroupRepos, checkVaultYaml, fetchRepoOwner,
} from './lib/vault-backfill/glab.mjs';

import {
  loadTemplate, slugToHumanName, pathToSlug, renderTemplate,
} from './lib/vault-backfill/template.mjs';

import { validateManifest, SLUG_RE } from './lib/vault-backfill/manifest.mjs';

// ── CLI argument parsing ──────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(name) {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}

const flagGroups  = getArg('--groups');
const flagDryRun  = args.includes('--dry-run');
const flagApply   = args.includes('--apply');
const flagYes     = getArg('--yes');
const flagVaultDir = getArg('--vault-dir');
const flagOutDir  = getArg('--out-dir');
const flagVerbose = args.includes('--verbose');

// ── Logging + output ──────────────────────────────────────────────────────────

function log(msg) {
  process.stderr.write(`[vault-backfill] ${msg}\n`);
}

function emitAction(action, repoPath, extra = {}) {
  process.stdout.write(JSON.stringify({ action, path: repoPath, ...extra }) + '\n');
}

function die(code, msg) {
  process.stderr.write(`[vault-backfill] ERROR: ${msg}\n`);
  process.exit(code);
}

// ── Validation ────────────────────────────────────────────────────────────────

if (flagDryRun && flagApply) die(1, '--dry-run and --apply are mutually exclusive');

const applyWrites = flagApply === true;

/** Resolved staging output directory (used when --apply is set). */
const outDir = resolve(flagOutDir ?? './.vault-backfill-staging');

/** Whether any file writes failed (contributes to exit 2). */
let hadWriteError = false;

if (flagVerbose) setGlabVerbose(true);

// ── Session Config reader (inline) ───────────────────────────────────────────

/** Read vault-integration.{gitlab-groups,vault-dir} from CLAUDE.md / AGENTS.md in CWD. */
function readVaultIntegrationConfig() {
  const candidates = [join(process.cwd(), 'CLAUDE.md'), join(process.cwd(), 'AGENTS.md')];

  let content = null;
  for (const p of candidates) {
    if (existsSync(p)) {
      try { content = readFileSync(p, 'utf8'); break; } catch { /* try next */ }
    }
  }

  if (!content) return { 'gitlab-groups': null, 'vault-dir': null };

  let inBlock = false;
  let gitlabGroups = null;
  let vaultDir = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '');

    if (!inBlock && /^vault-integration:\s*$/.test(line)) { inBlock = true; continue; }
    if (inBlock) {
      if (line.length > 0 && !/^\s/.test(line)) break;

      const m = line.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
      if (!m) continue;

      const k = m[1].trim();
      let v = m[2].trim().replace(/\s*#.*$/, '').trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }

      if (k === 'gitlab-groups' && v) {
        gitlabGroups = v.replace(/^\[/, '').replace(/\]$/, '').trim() || null;
      }
      if (k === 'vault-dir' && v && v !== 'none' && v !== 'null') {
        vaultDir = v;
      }
    }
  }

  return { 'gitlab-groups': gitlabGroups, 'vault-dir': vaultDir };
}

// ── Vault-dir folder stub ─────────────────────────────────────────────────────

function createVaultFolderStub(vaultDir, slug) {
  if (!vaultDir) return;
  const stubDir = join(resolve(vaultDir), '01-projects', slug);
  try {
    if (!existsSync(stubDir)) {
      if (applyWrites) {
        mkdirSync(stubDir, { recursive: true });
        log(`created vault folder stub: ${stubDir}`);
      } else {
        log(`[dry-run] would create vault folder stub: ${stubDir}`);
      }
    }
  } catch (err) {
    process.stderr.write(
      `[vault-backfill] WARN: could not create vault stub for ${slug}: ${err.message}\n`,
    );
  }
}

// ── Process one repo ──────────────────────────────────────────────────────────

function processRepo(entry, vaultDir, templateContent) {
  const { path: repoPath, slug, tier, visibility, group, id } = entry;
  const humanName = slugToHumanName(slug);

  const owner = applyWrites ? fetchRepoOwner(id) : 'unknown';

  let renderedContent;
  try {
    renderedContent = renderTemplate(
      { humanName, slug, tier, gitlabPath: repoPath, owner },
      templateContent,
    );
  } catch (err) {
    process.stderr.write(
      `[vault-backfill] WARN: template render failed for ${repoPath}: ${err.message}\n`,
    );
    emitAction('skipped-render-error', repoPath, { slug, tier, visibility, error: err.message });
    return;
  }

  if (!applyWrites) {
    // Dry-run: emit preview action only (no disk write)
    emitAction('vault-yaml-rendered', repoPath, { slug, tier, visibility, group, content: renderedContent });
    log(`[dry-run] ${repoPath}: would write .vault.yaml (slug=${slug}, tier=${tier})`);
    createVaultFolderStub(vaultDir, slug);
    return;
  }

  // Apply: write to staging directory at <out-dir>/<group>/<repo>/.vault.yaml
  const writePath = join(outDir, repoPath, '.vault.yaml');
  try {
    mkdirSync(dirname(writePath), { recursive: true });
    writeFileSync(writePath, renderedContent, 'utf8');
    emitAction('wrote', writePath, { slug, id, tier, visibility, group });
    log(`${repoPath}: wrote .vault.yaml → ${writePath}`);
  } catch (err) {
    emitAction('write-failed', writePath, { error: err.message, slug, group });
    process.stderr.write(
      `[vault-backfill] ERROR: cannot write ${writePath}: ${err.message}\n`,
    );
    hadWriteError = true;
  }

  createVaultFolderStub(vaultDir, slug);
}

// ── Scan groups ───────────────────────────────────────────────────────────────

function scanGroups(groups) {
  let failedGroups = 0;
  const missing = [];

  for (const group of groups) {
    log(`scanning group: ${group}`);
    const repos = listGroupRepos(group);
    if (repos === null) { failedGroups++; continue; }

    log(`  found ${repos.length} repo(s) in ${group}`);
    for (const repo of repos) {
      if (!repo.path) continue;
      const status = checkVaultYaml(repo.path);
      if (status === 'present') {
        log(`  ${repo.path}: already has .vault.yaml — skipping`);
        emitAction('skipped-has-vault-yaml', repo.path, { visibility: repo.visibility, createdAt: repo.createdAt });
        continue;
      }
      missing.push({ ...repo, group });
    }
  }

  const allGroupsFailed = failedGroups > 0 && failedGroups === groups.length;
  return { repos: missing, apiError: failedGroups > 0, allGroupsFailed };
}

// ── Table printer ─────────────────────────────────────────────────────────────

function printTable(repos) {
  if (repos.length === 0) { process.stderr.write('\n  (no repos to backfill)\n'); return; }

  const COL_REPO = Math.max(4, ...repos.map((r) => r.path.length));
  const pad = (s, n) => String(s).padEnd(n);
  const sep = `  ${'-'.repeat(COL_REPO + 26)}\n`;

  process.stderr.write('\n');
  process.stderr.write(`  ${pad('Repo', COL_REPO)}  ${pad('Date', 10)}  Visibility\n`);
  process.stderr.write(sep);
  for (const r of repos) {
    process.stderr.write(`  ${pad(r.path, COL_REPO)}  ${pad(r.createdAt, 10)}  ${r.visibility}\n`);
  }
  process.stderr.write('\n');
}

// ── Interactive prompt ────────────────────────────────────────────────────────

async function promptForRepo(rl, repoPath, suggestedSlug) {
  const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

  process.stderr.write(`\n  Repo: ${repoPath}\n`);

  let slug = '';
  while (true) {
    const input = await ask(`  Slug [${suggestedSlug}]: `);
    slug = input || suggestedSlug;
    if (SLUG_RE.test(slug)) break;
    process.stderr.write(`  Invalid slug — must match [a-z0-9]+(-[a-z0-9]+)*\n`);
  }

  let tier = '';
  while (true) {
    const input = await ask(`  Tier (top/active/archived) [active]: `);
    tier = input || 'active';
    if (['top', 'active', 'archived'].includes(tier)) break;
    process.stderr.write(`  Invalid tier — must be top|active|archived\n`);
  }

  const skip = await ask(`  Skip this repo? [y/N]: `);
  if (skip.toLowerCase() === 'y') return null;
  return { slug, tier };
}

// ── Headless (--yes) path ─────────────────────────────────────────────────────

async function runHeadless(manifestPath, vaultDir) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    die(1, `cannot parse manifest '${manifestPath}': ${err.message}`);
  }

  const repos = validateManifest(raw, die);
  const templateContent = loadTemplate(die);
  const pending = repos.filter((r) => !r.skip);

  log(`manifest: ${repos.length} entries, ${pending.length} to process`);
  if (pending.length === 0) { log('nothing to backfill (all skip:true)'); process.exit(4); }

  // When --yes manifest is provided, it is the authoritative scope — skip the
  // GitLab API .vault.yaml presence check so the CLI works without live repo access.
  for (const entry of pending) {
    processRepo(
      { ...entry, group: entry.path.split('/')[0] ?? '' },
      vaultDir,
      templateContent,
    );
  }
}

// ── Interactive path ──────────────────────────────────────────────────────────

async function runInteractive(groups, vaultDir) {
  const templateContent = loadTemplate(die);

  log('scanning groups for repos missing .vault.yaml …');
  const { repos: missing, apiError, allGroupsFailed } = scanGroups(groups);

  if (apiError) log('WARN: one or more groups had API errors; results may be incomplete');

  // Exit 3 only when ALL groups failed and nothing was processed at all
  if (allGroupsFailed) {
    die(3, 'all GitLab group scans failed — check auth (GITLAB_TOKEN) and group paths');
  }

  if (missing.length === 0) { log('all scanned repos already have .vault.yaml — nothing to backfill'); process.exit(4); }

  printTable(missing);
  log(`found ${missing.length} repo(s) without .vault.yaml`);

  if (!applyWrites) {
    log('(dry-run mode — use --apply to write .vault.yaml files)');
    for (const repo of missing) {
      processRepo({ ...repo, slug: pathToSlug(repo.path), tier: 'active' }, vaultDir, templateContent);
    }
    return;
  }

  // Interactive prompts
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const decisions = [];

  for (const repo of missing) {
    const decision = await promptForRepo(rl, repo.path, pathToSlug(repo.path));
    if (decision === null) {
      log(`${repo.path}: skipped by user`);
      emitAction('skipped-by-user', repo.path, { visibility: repo.visibility });
      continue;
    }
    decisions.push({ repo, ...decision });
  }

  if (decisions.length === 0) {
    rl.close();
    log('no repos selected — nothing to apply');
    process.exit(0);
  }

  process.stderr.write(`\n  ${decisions.length} repo(s) will receive .vault.yaml. Apply? [y/N]: `);
  const confirmed = await new Promise((resolve) => {
    rl.question('', (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });

  if (confirmed !== 'y') { log('aborted by user — no writes performed'); process.exit(0); }

  for (const { repo, slug, tier } of decisions) {
    processRepo({ ...repo, slug, tier }, vaultDir, templateContent);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const cfgConfig = readVaultIntegrationConfig();

  let groups;
  if (flagGroups) {
    groups = flagGroups.split(',').map((g) => g.trim()).filter(Boolean);
  } else if (cfgConfig['gitlab-groups']) {
    groups = cfgConfig['gitlab-groups'].split(',').map((g) => g.trim()).filter(Boolean);
  }

  const vaultDir = flagVaultDir ?? cfgConfig['vault-dir'] ?? null;

  if (!flagYes && (!groups || groups.length === 0)) {
    die(1, 'no GitLab groups specified — pass --groups <CSV> or set vault-integration.gitlab-groups in CLAUDE.md');
  }

  if (flagYes) {
    // Headless path: manifest is authoritative. No glab required (CI / air-gapped).
    await runHeadless(flagYes, vaultDir);
  } else {
    // Interactive path: glab is required for group scanning + per-repo presence checks.
    assertGlabExists(die);
    await runInteractive(groups, vaultDir);
  }

  // Propagate write failures (EACCES, ENOSPC, etc.) as exit code 2
  if (hadWriteError) {
    process.stderr.write('[vault-backfill] ERROR: one or more .vault.yaml writes failed (see above)\n');
    process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`[vault-backfill] unexpected error: ${err.message}\n`);
  if (flagVerbose && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(2);
});
