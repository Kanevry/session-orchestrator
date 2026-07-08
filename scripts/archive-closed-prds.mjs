#!/usr/bin/env node
/**
 * archive-closed-prds.mjs — archive PRDs whose Epic is closed into the Meta-Vault.
 *
 * Epic #774 (docs Public-Split) / S8 (#782) — the durable Epic-close routine.
 * Runs as a `custom-phases:` entry (`node scripts/archive-closed-prds.mjs --apply`).
 *
 * Flow:
 *   1. findProjectRoot → resolve CLAUDE.md → parseSessionConfig → vault-integration.vault-dir
 *      (host-resolved: SO_VAULT_DIR env > owner.yaml paths.vault-dir > committed).
 *   2. Enumerate tracked PRD .md files under --prd-dir (git ls-files), excluding
 *      *.original-uncommitted.md.
 *   3. For each PRD: parse the FIRST `#NNN` Epic reference in the header region
 *      (first ~20 lines, up to the first `## ` section). No ref → skip (WARN).
 *   4. `glab issue view <iid> --output json` → state. Only `closed` Epics archive;
 *      `opened` and unknown/error states skip (never guess).
 *   5. Closed → archiveFileToVault(...) into <vault>/<--vault-subdir>/. Under
 *      --apply the source PRD is removed with `git rm`; --dry-run (default) writes
 *      NOTHING (not even to the vault).
 *
 * Output: human-readable summary + optional --json manifest. Data → stdout,
 * diagnostics → stderr.
 *
 * Exit codes: 0 success · 1 input/config error · 2 system error.
 *
 * Exports (for tests): main, parseEpicRef, readHeaderRegion, listTrackedPrds,
 *   epicState, defaultGlabRepo.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { findProjectRoot, resolveInstructionFile, warn } from './lib/common.mjs';
import { parseSessionConfig } from './lib/config.mjs';
import { glabRun as defaultGlabRun } from './lib/vault-backfill/glab.mjs';
import { archiveFileToVault, titleFromMarkdown } from './lib/vault-archive.mjs';

const DEFAULT_PRD_DIR = 'docs/prd';
const DEFAULT_VAULT_SUBDIR = '01-projects/session-orchestrator/prd';

// ---------------------------------------------------------------------------
// Default child-process runners (overridable via DI for hermetic tests)
// ---------------------------------------------------------------------------

/** @returns {{ ok: boolean, stdout: string, stderr: string }} */
function defaultGitRun(gitArgs) {
  const r = spawnSync('git', gitArgs, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (r.error) return { ok: false, stdout: '', stderr: r.error.message };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Best-effort auto-detection of the glab `-R` repo spec from the local git
 * remotes (prefers a `gitlab` helper-remote, else `origin`). Returned as the raw
 * remote URL, which glab `-R` accepts (HTTPS, `.git`, or SSH forms all work).
 *
 * This keeps the committed custom-phase command host-agnostic (no private host
 * in CLAUDE.md — owner-leakage/#494) while still resolving the correct host when
 * glab is spawned non-interactively (a bare `glab` spawn ignores the shell
 * wrapper and falls back to the ambient GITLAB_HOST, which may not match).
 *
 * @param {string} repoRoot
 * @param {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} gitRunFn
 * @returns {string|undefined}
 */
export function defaultGlabRepo(repoRoot, gitRunFn) {
  for (const remote of ['gitlab', 'origin']) {
    const { ok, stdout } = gitRunFn(['-C', repoRoot, 'remote', 'get-url', remote]);
    const url = ok ? stdout.trim() : '';
    if (url) return url;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse the FIRST `#NNN` issue reference out of a PRD header region.
 * @param {string} headerText
 * @returns {string|null} the numeric iid as a string, or null when absent.
 */
export function parseEpicRef(headerText) {
  const m = String(headerText).match(/#(\d+)/);
  return m ? m[1] : null;
}

/**
 * Read the header region of a PRD: the first `maxLines` lines, truncated at the
 * first `## ` (level-2) section heading — the boundary between the metadata
 * header and the PRD body.
 * @param {string} absPath
 * @param {number} [maxLines=20]
 * @returns {string}
 */
export function readHeaderRegion(absPath, maxLines = 20) {
  const raw = readFileSync(absPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const region = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) break;
    region.push(line);
    if (region.length >= maxLines) break;
  }
  return region.join('\n');
}

/**
 * List tracked PRD markdown files under `prdDir`, excluding uncommitted-original
 * snapshots (`*.original-uncommitted.md`).
 * @param {string} repoRoot
 * @param {string} prdDir — repo-relative directory.
 * @param {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} gitRunFn
 * @returns {string[]} repo-relative paths.
 */
export function listTrackedPrds(repoRoot, prdDir, gitRunFn) {
  const { ok, stdout } = gitRunFn(['-C', repoRoot, 'ls-files', prdDir]);
  if (!ok) return [];
  return stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => p.endsWith('.md') && !p.endsWith('.original-uncommitted.md'));
}

/**
 * Resolve an Epic's lifecycle state via glab.
 *
 * When `glabRepo` is provided it is passed through as `-R <spec>` so glab resolves
 * the correct host non-interactively. This matters because a bare `spawnSync('glab')`
 * bypasses any shell `glab()` wrapper and falls back to the ambient `GITLAB_HOST`,
 * which may not match this repo's remotes (host-mismatch → fail-closed 'unknown').
 *
 * @param {string} iid
 * @param {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} glabRunFn
 * @param {string} [glabRepo] — OWNER/REPO or a full repo URL (glab `-R`).
 * @returns {'closed'|'opened'|'unknown'}
 */
export function epicState(iid, glabRunFn, glabRepo) {
  const args = ['issue', 'view', String(iid), '--output', 'json'];
  if (glabRepo) args.push('-R', glabRepo);
  const { ok, stdout } = glabRunFn(args);
  if (!ok) return 'unknown';
  try {
    const data = JSON.parse(stdout);
    const state = data?.state;
    if (state === 'closed') return 'closed';
    if (state === 'opened' || state === 'open') return 'opened';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function printHelp() {
  process.stdout.write(`archive-closed-prds.mjs — archive PRDs of closed Epics into the Meta-Vault

USAGE
  node scripts/archive-closed-prds.mjs [--dry-run|--apply] [--json]
    [--prd-dir DIR] [--vault-subdir DIR] [--help]

FLAGS
  --dry-run          (default) Plan the archive; write NOTHING (not even the vault).
  --apply            Copy each closed-Epic PRD into the vault and 'git rm' the source.
  --json             Emit a machine-readable JSON manifest to stdout.
  --prd-dir DIR      Repo-relative PRD directory (default: ${DEFAULT_PRD_DIR}).
  --vault-subdir DIR Vault-relative destination (default: ${DEFAULT_VAULT_SUBDIR}).
  --glab-repo SPEC   OWNER/REPO or repo URL passed to glab as -R, so Epic state
                     resolves non-interactively (a bare glab spawn ignores any
                     shell wrapper and uses the ambient GITLAB_HOST). When
                     omitted, the spec is auto-detected from the local git
                     remote (prefers 'gitlab', else 'origin').
  -h, --help         Show this help and exit.

EXIT CODES
  0  success
  1  input/config error
  2  system error
`);
}

function printHuman(archived, skipped, isDryRun, vaultDir, vaultSubdir) {
  process.stdout.write(
    `PRD archive ${isDryRun ? '(dry-run)' : '(apply)'} → ${vaultDir}/${vaultSubdir}\n`,
  );
  if (archived.length > 0) {
    process.stdout.write(`  ${isDryRun ? 'WOULD ARCHIVE' : 'ARCHIVED'} (${archived.length}):\n`);
    for (const e of archived) {
      process.stdout.write(`    ${e.source} → ${e.target}  [epic #${e.iid}]\n`);
    }
  }
  if (skipped.length > 0) {
    process.stdout.write(`  SKIPPED (${skipped.length}):\n`);
    for (const s of skipped) {
      process.stdout.write(`    ${s.source} — ${s.reason}\n`);
    }
  }
  if (archived.length === 0 && skipped.length === 0) {
    process.stdout.write('  (no tracked PRDs found)\n');
  }
  process.stdout.write(
    isDryRun
      ? `\nDry-run. Use --apply to copy the ${archived.length} PRD(s) into the vault and 'git rm' the sources.\n`
      : `\nApplied. Archived ${archived.length} PRD(s).\n`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {string} [opts.repoRoot]
 * @param {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} [opts.glabRunFn]
 * @param {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} [opts.gitRunFn]
 * @param {Date} [opts.now]
 * @param {{ env?: Record<string, string|undefined>, ownerConfig?: object }} [opts.hostPaths]
 *   — forwarded to parseSessionConfig. Tests pass `{ env: {}, ownerConfig: undefined }`
 *   for hermetic, owner.yaml-free vault-dir resolution (issue #653 bleed guard).
 * @returns {{ code: 0|1|2, archived: object[], skipped: object[], vaultDir?: string, dryRun?: boolean }}
 */
export function main({
  argv = process.argv.slice(2),
  repoRoot,
  glabRunFn = defaultGlabRun,
  gitRunFn = defaultGitRun,
  now,
  hostPaths,
} = {}) {
  // ── Parse flags ──────────────────────────────────────────────────────────
  let apply = false;
  let dryRun = false;
  let json = false;
  let help = false;
  let prdDir = DEFAULT_PRD_DIR;
  let vaultSubdir = DEFAULT_VAULT_SUBDIR;
  let glabRepo;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') help = true;
    else if (a === '--prd-dir') prdDir = argv[++i];
    else if (a.startsWith('--prd-dir=')) prdDir = a.slice('--prd-dir='.length);
    else if (a === '--vault-subdir') vaultSubdir = argv[++i];
    else if (a.startsWith('--vault-subdir=')) vaultSubdir = a.slice('--vault-subdir='.length);
    else if (a === '--glab-repo') glabRepo = argv[++i];
    else if (a.startsWith('--glab-repo=')) glabRepo = a.slice('--glab-repo='.length);
    else {
      process.stderr.write(`archive-closed-prds: unknown argument: ${a}\n`);
      process.stderr.write('Run with --help for usage.\n');
      return { code: 1, archived: [], skipped: [] };
    }
  }

  if (help) {
    printHelp();
    return { code: 0, archived: [], skipped: [] };
  }
  if (apply && dryRun) {
    process.stderr.write('archive-closed-prds: --apply and --dry-run are mutually exclusive.\n');
    return { code: 1, archived: [], skipped: [] };
  }
  const isDryRun = !apply; // default dry-run

  if (!prdDir) {
    process.stderr.write('archive-closed-prds: --prd-dir requires a value.\n');
    return { code: 1, archived: [], skipped: [] };
  }
  if (!vaultSubdir) {
    process.stderr.write('archive-closed-prds: --vault-subdir requires a value.\n');
    return { code: 1, archived: [], skipped: [] };
  }

  // ── Resolve repo root + vault dir ────────────────────────────────────────
  const root = repoRoot ?? findProjectRoot();
  const instr = resolveInstructionFile(root);
  if (!instr) {
    process.stderr.write(`archive-closed-prds: no CLAUDE.md/AGENTS.md at ${root}.\n`);
    return { code: 1, archived: [], skipped: [] };
  }

  let vaultDir;
  try {
    const content = readFileSync(instr.path, 'utf8');
    const config = parseSessionConfig(content, hostPaths ? { hostPaths } : undefined);
    vaultDir = config?.['vault-integration']?.['vault-dir'];
  } catch (err) {
    process.stderr.write(`archive-closed-prds: failed to parse Session Config: ${err.message}\n`);
    return { code: 2, archived: [], skipped: [] };
  }
  if (!vaultDir || typeof vaultDir !== 'string' || vaultDir.trim() === '') {
    process.stderr.write(
      'archive-closed-prds: vault-integration.vault-dir is not configured — cannot archive.\n',
    );
    return { code: 1, archived: [], skipped: [] };
  }

  // Resolve the glab repo spec: explicit --glab-repo wins, else auto-detect from
  // the local git remote (host-agnostic; nothing host-specific committed).
  const effectiveGlabRepo = glabRepo ?? defaultGlabRepo(root, gitRunFn);

  // ── Enumerate + classify PRDs ────────────────────────────────────────────
  const prds = listTrackedPrds(root, prdDir, gitRunFn);
  const archived = [];
  const skipped = [];
  const takenIds = new Set();

  for (const rel of prds) {
    const abs = join(root, rel);
    let header;
    try {
      header = readHeaderRegion(abs);
    } catch (err) {
      skipped.push({ source: rel, reason: `unreadable: ${err.message}` });
      warn(`archive-closed-prds: cannot read ${rel}: ${err.message}`);
      continue;
    }

    const iid = parseEpicRef(header);
    if (!iid) {
      skipped.push({ source: rel, reason: 'no-epic-ref' });
      warn(`archive-closed-prds: no Epic reference in header of ${rel} — skipped (never guess).`);
      continue;
    }

    const state = epicState(iid, glabRunFn, effectiveGlabRepo);
    if (state === 'opened') {
      skipped.push({ source: rel, reason: `epic-#${iid}-open`, iid });
      continue;
    }
    if (state === 'unknown') {
      skipped.push({ source: rel, reason: `epic-#${iid}-state-unknown`, iid });
      warn(`archive-closed-prds: could not resolve state of Epic #${iid} for ${rel} — skipped.`);
      continue;
    }

    // state === 'closed' → archive.
    let entry;
    try {
      entry = archiveFileToVault({
        repoRoot: root,
        vaultDir,
        sourcePath: abs,
        targetSubdir: vaultSubdir,
        dryRun: isDryRun,
        now,
        takenIds,
        issueRef: iid,
        title: titleFromMarkdown(header),
      });
    } catch (err) {
      skipped.push({ source: rel, reason: `archive-failed: ${err.message}`, iid });
      warn(`archive-closed-prds: failed to archive ${rel}: ${err.message}`);
      continue;
    }
    entry.iid = iid;

    if (!isDryRun) {
      const rm = gitRunFn(['-C', root, 'rm', '--', rel]);
      entry.removed = rm.ok;
      if (!rm.ok) warn(`archive-closed-prds: 'git rm ${rel}' failed: ${rm.stderr.trim()}`);
    }

    archived.push(entry);
  }

  // ── Output ───────────────────────────────────────────────────────────────
  if (json) {
    process.stdout.write(
      JSON.stringify({ dryRun: isDryRun, vaultDir, vaultSubdir, archived, skipped }, null, 2) + '\n',
    );
  } else {
    printHuman(archived, skipped, isDryRun, vaultDir, vaultSubdir);
  }

  return { code: 0, archived, skipped, vaultDir, dryRun: isDryRun };
}

// ---------------------------------------------------------------------------
// CLI guard — prevents process.exit during test-time imports
// ---------------------------------------------------------------------------

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { code } = main();
    process.exit(code ?? 0);
  } catch (err) {
    process.stderr.write(`archive-closed-prds: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  }
}
