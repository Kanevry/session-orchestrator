#!/usr/bin/env node
/**
 * archive-closed-prds.mjs — archive docs whose referenced Epic/Issue is closed
 * into the Meta-Vault. Generic over the doc directory: used for both `docs/prd`
 * (default) and `docs/plans` (via `--prd-dir docs/plans`, #786).
 *
 * Epic #774 (docs Public-Split) / S8 (#782) — the durable close routine; #786
 * generalised it to also archive executable plans (`docs/plans/`). Runs as a
 * `custom-phases:` entry — one entry per doc directory (see CLAUDE.md):
 *   - `node scripts/archive-closed-prds.mjs --apply` (docs/prd, defaults)
 *   - `… --apply --prd-dir docs/plans --vault-subdir <plans-subdir>` (docs/plans)
 *
 * Flow:
 *   1. findProjectRoot → resolve CLAUDE.md → parseSessionConfig → vault-integration.vault-dir
 *      (host-resolved: SO_VAULT_DIR env > owner.yaml paths.vault-dir > committed).
 *   2. Enumerate tracked .md files under --prd-dir (git ls-files), excluding
 *      *.original-uncommitted.md. A missing/empty --prd-dir yields [] → clean
 *      report, exit 0 (no crash) — see listTrackedPrds.
 *   3. For each doc: parse an Epic/Issue DECLARATION out of the header region
 *      (first ~20 lines, up to the first `## ` section) — frontmatter key, label
 *      line, or H1 title suffix. A bare `#NNN` in prose is a CITATION and never
 *      counts (`citation-only`); no `#NNN` at all → `no-epic-ref`. Both skip.
 *   4. Session ownership: a doc with uncommitted changes (`uncommitted`) or one
 *      committed at/after this session's `started_at` (`foreign-session`) is
 *      skipped — it belongs to a parallel session, not to us (#1123).
 *   5. `glab issue view <iid> --output json` → state. Only `closed` refs archive;
 *      `opened` and unknown/error states skip (never guess).
 *   6. Closed → archiveFileToVault(...) into <vault>/<--vault-subdir>/. Under
 *      --apply the source doc is removed with `git rm`; --dry-run (default) writes
 *      NOTHING (not even to the vault).
 *
 * Output: human-readable summary + optional --json manifest. Data → stdout,
 * diagnostics → stderr.
 *
 * Exit codes: 0 success · 1 input/config error · 2 system error.
 *
 * Exports (for tests): main, parseEpicDeclaration, parseEpicRef, readHeaderRegion,
 *   listTrackedPrds, epicState, classifyOwnership, readSessionStartedAt,
 *   defaultGlabRepo.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

import { findProjectRoot, resolveInstructionFile, warn } from './lib/common.mjs';
import { parseSessionConfig } from './lib/config.mjs';
import { glabRun as defaultGlabRun } from './lib/vault-backfill/glab.mjs';
import { archiveFileToVault, titleFromMarkdown } from './lib/vault-archive.mjs';
import { defaultGlabRepo } from './lib/vcs-repo-spec.mjs';
import { readLock } from './lib/session-lock.mjs';
import { resolveStateMdPath } from './lib/state-md/frontmatter-mutators.mjs';
import { parseStateMd } from './lib/state-md/yaml-parser.mjs';

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

// Best-effort auto-detection of the glab `-R` repo spec from the local git
// remotes (prefers a `gitlab` helper-remote, else `origin`) — lifted into
// `scripts/lib/vcs-repo-spec.mjs::defaultGlabRepo` (#839) as the single shared
// implementation; re-exported here (`export { defaultGlabRepo }` below) so
// existing callers/tests importing it from this module keep working.
//
// This keeps the committed custom-phase command host-agnostic (no private host
// in CLAUDE.md — owner-leakage/#494) while still resolving the correct host when
// glab is spawned non-interactively (a bare `glab` spawn ignores the shell
// wrapper and falls back to the ambient GITLAB_HOST, which may not match).
export { defaultGlabRepo };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// A DECLARATION line names the doc's own tracking Epic/Issue. Three accepted
// spellings, all anchored at line start so prose can never reach them:
//   (a) `**Epic:** #1113`   — colon INSIDE the bold (the shape 2 of 4 live PRDs use)
//   (b) `**Epic**: #1113`   — colon outside the bold
//   (c) `Source: docs/prd/x.md (#786)` — unbolded (the plan-header shape,
//       skills/write-executable-plan/SKILL.md:193)
// The optional leading `-`/`*` covers list items (`- **Issue:** #366`).
const LABEL_WORD = String.raw`(?:parent[ \t]+)?(?:epic|issues?|source)`;
const LABEL_LINE_RE = new RegExp(
  String.raw`^[-*]?[ \t]*(?:` +
    String.raw`\*\*[ \t]*${LABEL_WORD}[ \t]*:[ \t]*\*\*` +
    String.raw`|\*\*[ \t]*${LABEL_WORD}[ \t]*\*\*[ \t]*:` +
    String.raw`|${LABEL_WORD}[ \t]*:` +
    String.raw`)[ \t]*(\S.*)$`,
  'i',
);
const FRONTMATTER_LINE_RE = /^(?:epic|issues?)[ \t]*:[ \t]*\[?[ \t]*['"]?#?(\d+)/i;
const TITLE_SUFFIX_RE = /^#[ \t]+.*\(#(\d+)\)[ \t]*$/;
const ANY_IID_RE = /#(\d+)/;

/**
 * Parse the doc's DECLARED Epic/Issue out of its header region.
 *
 * Precedence (first hit wins): frontmatter key → label line → H1 title suffix.
 * A bare `#NNN` in prose is a CITATION and NEVER counts — that conflation is
 * what deleted a live PRD on 2026-08-22 (#1112): a quoted, long-closed `#214`
 * inside a blockquote read as the doc's own Epic, so the doc looked finished.
 * The rule therefore prefers, by construction, documents that carry LESS
 * context — hence the anchored line shapes below.
 *
 * @param {string} headerText — output of readHeaderRegion().
 * @returns {{ iid: string, via: 'frontmatter'|'label'|'title' }|null}
 */
export function parseEpicDeclaration(headerText) {
  const lines = String(headerText).split(/\r?\n/);

  // (1) Frontmatter — only inside the LEADING `---` block, never a stray
  // `epic:` line further down the header.
  //
  // A leading `---` alone does NOT make a frontmatter block: in Markdown it is
  // also a thematic break, and a doc that opens with one would otherwise have
  // its BODY read as frontmatter (a body line `epic: 1113` — or any `issue:`
  // note — would then win over the real declaration below). Require a CLOSING
  // `---` inside the header region; without it, fall through to label/title.
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (close !== -1) {
      for (let i = 1; i < close; i++) {
        const m = FRONTMATTER_LINE_RE.exec(lines[i]);
        if (m) return { iid: m[1], via: 'frontmatter' };
      }
    }
  }

  // (2) Label line — the first `#NNN` on a recognised label line. Taking the
  // first is correct for `**Epic:** #1048 · **Sub-Issues:** #1049 …`: the
  // primary declaration leads, the sub-issues trail.
  for (const line of lines) {
    const label = LABEL_LINE_RE.exec(line);
    if (!label) continue;
    const iid = ANY_IID_RE.exec(label[1]);
    if (iid) return { iid: iid[1], via: 'label' };
  }

  // (3) H1 title suffix — `# Feature: Foo (#1113)`.
  for (const line of lines) {
    const m = TITLE_SUFFIX_RE.exec(line);
    if (m) return { iid: m[1], via: 'title' };
  }

  return null;
}

/**
 * @deprecated Use {@link parseEpicDeclaration} — it also reports HOW the iid was
 * declared, which the caller needs to tell `citation-only` from `no-epic-ref`.
 * Retained as a thin shim for existing importers.
 * @param {string} headerText
 * @returns {string|null} the declared iid as a string, or null when absent.
 */
export function parseEpicRef(headerText) {
  return parseEpicDeclaration(headerText)?.iid ?? null;
}

/**
 * Decide whether a doc belongs to THIS session or to a parallel one (#1123).
 *
 * Author IDENTITY carries no signal here — every session commits as the same
 * human — so the discriminator is commit TIME against this session's
 * `started_at`, taken as MAX(author date, committer date) so a rebased or
 * cherry-picked peer commit cannot read as old.
 * Fail-closed in every ambiguous direction: a failed git probe,
 * an unparseable commit timestamp, or a missing `sessionStartedAt` all yield
 * `'foreign'`, because 'foreign' is the verdict that does NOT delete.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.rel — repo-relative doc path.
 * @param {string|null|undefined} args.sessionStartedAt — ISO-8601.
 * @param {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} args.gitRunFn
 * @returns {'mine'|'foreign'|'uncommitted'} never throws.
 */
export function classifyOwnership({ repoRoot, rel, sessionStartedAt, gitRunFn }) {
  let status;
  try {
    status = gitRunFn(['-C', repoRoot, 'status', '--porcelain', '--', rel]);
  } catch {
    return 'foreign';
  }
  if (!status?.ok) return 'foreign';
  // Non-empty porcelain output = staged, unstaged or untracked (`??`) — either
  // way there is work in the tree that a `git rm` would destroy.
  if (String(status.stdout).trim() !== '') return 'uncommitted';

  const startedMs = Date.parse(String(sessionStartedAt ?? ''));
  if (Number.isNaN(startedMs)) return 'foreign';

  let log;
  try {
    // BOTH timestamps, newest wins. `%aI` alone is the AUTHOR date, which
    // survives rebase, cherry-pick and `--amend` UNCHANGED — a peer session's
    // doc rebased onto this branch keeps its old author date and would read as
    // 'mine', i.e. as ours to `git rm`. `%cI` (committer date) moves with every
    // rewrite, so MAX(author, committer) is the moment the object entered THIS
    // history — the quantity the session-ownership guard actually needs.
    log = gitRunFn(['-C', repoRoot, 'log', '-1', '--format=%aI%n%cI', '--', rel]);
  } catch {
    return 'foreign';
  }
  if (!log?.ok) return 'foreign';
  const stamps = String(log.stdout)
    .split(/\r?\n/)
    .map((s) => Date.parse(s.trim()))
    .filter((n) => !Number.isNaN(n));
  if (stamps.length === 0) return 'foreign';
  const committedMs = Math.max(...stamps);

  return committedMs >= startedMs ? 'foreign' : 'mine';
}

/**
 * Resolve THIS session's `started_at` (ISO-8601): the session lock first, the
 * STATE.md frontmatter as fallback.
 *
 * @param {string} repoRoot
 * @returns {string|null} null when neither source yields a parseable timestamp.
 */
export function readSessionStartedAt(repoRoot) {
  try {
    const startedAt = readLock({ repoRoot })?.started_at;
    if (typeof startedAt === 'string' && !Number.isNaN(Date.parse(startedAt))) return startedAt;
  } catch {
    // fall through to STATE.md
  }
  try {
    const parsed = parseStateMd(readFileSync(resolveStateMdPath(repoRoot), 'utf8'));
    const startedAt = parsed?.frontmatter?.started_at;
    if (typeof startedAt === 'string' && !Number.isNaN(Date.parse(startedAt))) return startedAt;
  } catch {
    // no STATE.md, or unreadable → null (fail-closed at the call site)
  }
  return null;
}

/**
 * Read the issue iids this session declared in STATE.md frontmatter (`issues:`).
 * @param {string} repoRoot
 * @returns {Set<string>} empty when STATE.md is absent or carries no list.
 */
function readSessionIssues(repoRoot) {
  try {
    const parsed = parseStateMd(readFileSync(resolveStateMdPath(repoRoot), 'utf8'));
    const issues = parsed?.frontmatter?.issues;
    if (Array.isArray(issues)) return new Set(issues.map((n) => String(n)));
  } catch {
    // absent/unreadable → empty set
  }
  return new Set();
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
 * List tracked markdown docs under `prdDir`, excluding uncommitted-original
 * snapshots (`*.original-uncommitted.md`). Generic over the doc directory
 * (docs/prd or docs/plans).
 *
 * A MISSING or empty `prdDir` is graceful, not an error: `git ls-files` on an
 * untracked/non-existent pathspec exits 0 with empty output, so this returns []
 * → the caller emits a clean "(no tracked docs)" report and exits 0. This is the
 * expected state for docs/plans when the last plan was already archived (#786).
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
  process.stdout.write(`archive-closed-prds.mjs — archive docs of closed Epics/Issues into the Meta-Vault
  (generic over the doc directory: docs/prd default, or docs/plans via --prd-dir).

USAGE
  node scripts/archive-closed-prds.mjs [--dry-run|--apply] [--json]
    [--prd-dir DIR] [--vault-subdir DIR] [--glab-repo SPEC]
    [--ignore-session-guard] [--owned-issues-only] [--help]

FLAGS
  --dry-run          (default) Plan the archive; write NOTHING (not even the vault).
  --apply            Copy each closed-Epic/Issue doc into the vault and 'git rm' the source.
  --json             Emit a machine-readable JSON manifest to stdout.
  --prd-dir DIR      Repo-relative doc directory (default: ${DEFAULT_PRD_DIR}; e.g. docs/plans).
  --vault-subdir DIR Vault-relative destination (default: ${DEFAULT_VAULT_SUBDIR}).
  --glab-repo SPEC   OWNER/REPO or repo URL passed to glab as -R, so Epic state
                     resolves non-interactively (a bare glab spawn ignores any
                     shell wrapper and uses the ambient GITLAB_HOST). When
                     omitted, the spec is auto-detected from the local git
                     remote (prefers 'gitlab', else 'origin').
  --ignore-session-guard
                     Escape hatch for a CATCH-UP SWEEP: also consider docs last
                     committed at/after this session's start (normally skipped
                     as 'foreign-session', because they belong to a parallel
                     session — #1123). Docs with uncommitted changes are STILL
                     skipped; this flag never widens that guard.
  --owned-issues-only
                     Opt-in: archive only docs whose declared iid appears in
                     this session's STATE.md 'issues:' list. Everything else
                     skips as 'epic-#NNN-not-owned'.
  -h, --help         Show this help and exit.

EXIT CODES
  0  success
  1  input/config error
  2  system error
`);
}

function printHuman(archived, skipped, isDryRun, vaultDir, vaultSubdir) {
  process.stdout.write(
    `Doc archive ${isDryRun ? '(dry-run)' : '(apply)'} → ${vaultDir}/${vaultSubdir}\n`,
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
    process.stdout.write('  (no tracked docs found)\n');
  }
  process.stdout.write(
    isDryRun
      ? `\nDry-run. Use --apply to copy the ${archived.length} doc(s) into the vault and 'git rm' the sources.\n`
      : `\nApplied. Archived ${archived.length} doc(s).\n`,
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
 * @param {string|null} [opts.sessionStartedAt] — ISO-8601 override for the
 *   session-ownership guard (#1123). Omitted → readSessionStartedAt(root).
 * @returns {{ code: 0|1|2, archived: object[], skipped: object[], vaultDir?: string, dryRun?: boolean }}
 */
export function main({
  argv = process.argv.slice(2),
  repoRoot,
  glabRunFn = defaultGlabRun,
  gitRunFn = defaultGitRun,
  now,
  hostPaths,
  sessionStartedAt,
} = {}) {
  // ── Parse flags ──────────────────────────────────────────────────────────
  let apply = false;
  let dryRun = false;
  let json = false;
  let help = false;
  let prdDir = DEFAULT_PRD_DIR;
  let vaultSubdir = DEFAULT_VAULT_SUBDIR;
  let glabRepo;
  let ignoreSessionGuard = false;
  let ownedIssuesOnly = false;

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
    else if (a === '--ignore-session-guard') ignoreSessionGuard = true;
    else if (a === '--owned-issues-only') ownedIssuesOnly = true;
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

  // ── Session identity (ownership guard, #1123) ────────────────────────────
  const startedAt = sessionStartedAt !== undefined ? sessionStartedAt : readSessionStartedAt(root);
  if (!startedAt && !ignoreSessionGuard) {
    warn(
      'archive-closed-prds: no session started_at (session.lock/STATE.md) — every doc is treated ' +
        'as foreign-session. Use --ignore-session-guard for a deliberate catch-up sweep.',
    );
  }
  const ownedIssues = ownedIssuesOnly ? readSessionIssues(root) : null;

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

    const decl = parseEpicDeclaration(header);
    if (!decl) {
      // Distinguish "nothing to go on" from "only a CITATION to go on" — the
      // latter is the #1112 shape and the more dangerous of the two, because a
      // quoted closed issue reads exactly like a declared one.
      const citationOnly = ANY_IID_RE.test(header);
      skipped.push({ source: rel, reason: citationOnly ? 'citation-only' : 'no-epic-ref' });
      warn(
        citationOnly
          ? `archive-closed-prds: ${rel} header has #NNN only as a citation, not a declaration — skipped (#1112).`
          : `archive-closed-prds: no Epic reference in header of ${rel} — skipped (never guess).`,
      );
      continue;
    }
    const { iid, via } = decl;

    // Session ownership BEFORE any glab call: a doc a parallel session just
    // committed is not ours to archive, whatever its Epic's state (#1123).
    const ownership = classifyOwnership({ repoRoot: root, rel, sessionStartedAt: startedAt, gitRunFn });
    if (ownership === 'uncommitted') {
      skipped.push({ source: rel, reason: 'uncommitted', iid, via, ownership });
      warn(`archive-closed-prds: ${rel} has uncommitted changes — skipped (never 'git rm' live work).`);
      continue;
    }
    if (ownership === 'foreign' && !ignoreSessionGuard) {
      skipped.push({ source: rel, reason: 'foreign-session', iid, via, ownership });
      warn(
        `archive-closed-prds: ${rel} was last committed at/after this session's start — skipped ` +
          '(belongs to a parallel session; --ignore-session-guard overrides).',
      );
      continue;
    }

    if (ownedIssues && !ownedIssues.has(String(iid))) {
      skipped.push({ source: rel, reason: `epic-#${iid}-not-owned`, iid, via, ownership });
      continue;
    }

    const state = epicState(iid, glabRunFn, effectiveGlabRepo);
    if (state === 'opened') {
      skipped.push({ source: rel, reason: `epic-#${iid}-open`, iid, via, ownership });
      continue;
    }
    if (state === 'unknown') {
      skipped.push({ source: rel, reason: `epic-#${iid}-state-unknown`, iid, via, ownership });
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
      skipped.push({ source: rel, reason: `archive-failed: ${err.message}`, iid, via, ownership });
      warn(`archive-closed-prds: failed to archive ${rel}: ${err.message}`);
      continue;
    }
    entry.iid = iid;
    entry.via = via;
    entry.ownership = ownership;

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
