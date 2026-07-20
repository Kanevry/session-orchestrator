/**
 * narrative-mirror.mjs — Durable per-repo narrative mirror (Epic #673 Phase 1, #675).
 *
 * At session-end, extract from a repo's `.claude/STATE.md` the DURABLE narrative —
 * `## Wave History`, `## Deviations`, `## What Not To Retry`, plus the mission-status
 * rollup — and idempotently mirror it into a generator-owned per-repo vault file, so a
 * reviewer or stand-in can read PER REPO what was done, what failed, and what not to
 * retry, WITHOUT opening the repo.
 *
 * Design decision (Discovery D3): there is NO Wave-History parser and NO `readDeviations`
 * in scripts/lib/state-md.mjs, and `readWhatNotToRetry`'s expected format DIVERGES from
 * the real FeedFoundryV2 fixture (which uses a plain `- <text> (<session>, <date>) —
 * why: …` bullet). Rather than rely on structured parsers that silently return `[]` on
 * format drift, this module extracts the RAW verbatim markdown block of each section —
 * robust to format drift and faithful to the "mirror the narrative for human
 * traceability" goal. Both the top-level `## Wave History` form and the nested
 * `### Wave History (…)` form (under `## Previous Session` in FeedFoundryV2) are handled.
 *
 * Exports:
 *   GENERATOR_MARKER       — frontmatter sentinel identifying generator-owned files
 *   extractNarrative       — pure: STATE.md contents → { waveHistory, deviations, whatNotToRetry, missionStatus }
 *   renderNarrative        — pure: narrative + repo + now → full markdown (frontmatter + body)
 *   writeNarrative         — idempotent write with skip-handwritten / skip-noop / dry-run + _overview refusal
 *   resolveNarrativePath   — vaultDir + repoSlug → <vaultDir>/01-projects/<repoSlug>/_session-narrative.md
 *   mirrorNarrative        — convenience: read STATE.md, resolve vault-dir from config, write (no-op when vault disabled)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { parseStateMd, parseMissionStatus } from '../state-md.mjs';
import {
  parseFrontmatter,
  toDate,
  yamlQuoteIfNeeded,
  subjectToSlug,
} from '../vault-mirror/utils.mjs';
import { readConfigFile, parseSessionConfig } from '../config.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';

/** Frontmatter sentinel that identifies generator-owned narrative files. */
export const GENERATOR_MARKER = 'session-orchestrator-vault-status-narrative@1';

/** Placeholder used for noop comparison (replaces the live `updated:` value). */
const UPDATED_PLACEHOLDER = '__UPDATED_PLACEHOLDER__';

/**
 * The durable section headings we mirror, in render order. Each is extracted as
 * a raw verbatim block (Discovery D3). Both the top-level `## <Name>` form and a
 * nested `### <Name>` (optionally with a `(…)` suffix) are matched.
 */
const SECTION_TITLES = {
  waveHistory: 'Wave History',
  deviations: 'Deviations',
  whatNotToRetry: 'What Not To Retry',
};

// ── Raw section extraction ──────────────────────────────────────────────────────

/**
 * Expand a leading `~` to the current user's home directory.
 *
 * NOTE: deferred shared-helper extraction. The same `expandHome` pattern lives in
 * other vault-status modules; W2 forbids introducing a shared new file, so this is
 * inlined here. Consolidate into a shared util in a follow-up wave.
 *
 * @param {string} p
 * @returns {string}
 */
function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Match an ATX markdown heading line. Returns `{ level, text }` or null.
 *
 * @param {string} line
 * @returns {{ level: number, text: string } | null}
 */
function matchHeading(line) {
  const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
  if (!m) return null;
  return { level: m[1].length, text: m[2] };
}

/**
 * Determine whether a heading text refers to the given section title, tolerating
 * a trailing parenthetical (e.g. `Wave History (main-2026-06-18-1646, completed)`).
 *
 * @param {string} headingText
 * @param {string} title
 * @returns {boolean}
 */
function headingMatchesTitle(headingText, title) {
  const stripped = headingText.replace(/\s*\(.*\)\s*$/, '').trim();
  return stripped.toLowerCase() === title.toLowerCase();
}

/**
 * Extract the RAW verbatim markdown block for a section by title.
 *
 * Finds the FIRST heading whose text matches `title` (top-level `##` or nested
 * `###` form), then captures every line up to — but not including — the next
 * heading of the SAME-OR-HIGHER level (i.e. heading.level <= openingLevel). The
 * heading line itself is excluded; only the body content is returned. Trailing
 * blank lines are trimmed; an empty/absent section yields ''.
 *
 * @param {string} contents - full STATE.md body (or whole file; headings are scanned linewise)
 * @param {string} title
 * @returns {string}
 */
function extractSectionBlock(contents, title) {
  if (typeof contents !== 'string' || contents.length === 0) return '';
  const lines = contents.split('\n');

  let openIdx = -1;
  let openLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = matchHeading(lines[i]);
    if (h && headingMatchesTitle(h.text, title)) {
      openIdx = i;
      openLevel = h.level;
      break;
    }
  }
  if (openIdx === -1) return '';

  const collected = [];
  for (let i = openIdx + 1; i < lines.length; i++) {
    const h = matchHeading(lines[i]);
    if (h && h.level <= openLevel) break; // next same-or-higher heading closes the block
    collected.push(lines[i]);
  }

  // Trim leading/trailing blank lines but preserve interior structure verbatim.
  while (collected.length && collected[0].trim() === '') collected.shift();
  while (collected.length && collected[collected.length - 1].trim() === '') collected.pop();

  return collected.join('\n');
}

// ── Pure extraction ──────────────────────────────────────────────────────────────

/**
 * Extract the durable narrative from STATE.md contents.
 *
 * Returns raw verbatim section blocks plus the parsed mission-status rollup.
 * Each section is the empty string when absent or empty. `missionStatus` is the
 * frontmatter `mission-status:` array, or null when the key is absent (both real
 * fixtures lack the frontmatter key — handled gracefully without crashing).
 *
 * Pure — no I/O. Never throws on malformed input (parseStateMd returns null).
 *
 * @param {string} stateMdContents
 * @returns {{ waveHistory: string, deviations: string, whatNotToRetry: string, missionStatus: object[]|null }}
 */
export function extractNarrative(stateMdContents) {
  const safe = typeof stateMdContents === 'string' ? stateMdContents : '';

  const parsed = parseStateMd(safe);
  const frontmatter = parsed && parsed.frontmatter ? parsed.frontmatter : null;
  // Section extraction runs over the whole file: headings live in the body, and
  // scanning the raw string is robust whether or not frontmatter parsed cleanly.
  const body = parsed && typeof parsed.body === 'string' ? parsed.body : safe;

  const missionStatus = frontmatter ? parseMissionStatus(frontmatter) : null;

  return {
    waveHistory: extractSectionBlock(body, SECTION_TITLES.waveHistory),
    deviations: extractSectionBlock(body, SECTION_TITLES.deviations),
    whatNotToRetry: extractSectionBlock(body, SECTION_TITLES.whatNotToRetry),
    missionStatus,
  };
}

// ── Pure render ────────────────────────────────────────────────────────────────

/**
 * Render a single mission-status rollup table from the parsed array.
 *
 * Tolerant of heterogeneous entry shapes (id/task/wave/status are read defensively).
 *
 * @param {object[]} missionStatus
 * @returns {string}
 */
function renderMissionTable(missionStatus) {
  const lines = [];
  lines.push('| ID | Task | Wave | Status |');
  lines.push('|---|---|---|---|');
  for (const entry of missionStatus) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const id = e.id ?? '—';
    // Escape pipes so a task description never breaks the table layout.
    const task = String(e.task ?? '—').replace(/\|/g, '\\|');
    const wave = e.wave ?? '—';
    const status = e.status ?? '—';
    lines.push(`| ${id} | ${task} | ${wave} | ${status} |`);
  }
  return lines.join('\n');
}

/**
 * Render the full per-repo narrative markdown (frontmatter + body).
 *
 * Frontmatter ordering mirrors render-sessions.mjs conventions: id, type: session,
 * title (double-quoted), created/updated (YYYY-MM-DD via toDate), repo, then
 * `_generator` LAST. Body carries each verbatim section block (omitting empty
 * sections from a "captured" claim but always emitting the heading so the file is
 * structurally stable), plus a mission-status rollup table when present.
 *
 * Pure — no I/O.
 *
 * @param {{
 *   repo: string,
 *   narrative: { waveHistory: string, deviations: string, whatNotToRetry: string, missionStatus: object[]|null },
 *   now: Date,
 *   createdIso?: string,
 *   updatedPlaceholder?: string,
 * }} opts
 * @returns {string}  full markdown
 */
export function renderNarrative(opts) {
  const { repo, narrative, now, createdIso, updatedPlaceholder } = opts;
  const n = narrative ?? { waveHistory: '', deviations: '', whatNotToRetry: '', missionStatus: null };

  const nowIso = (now instanceof Date ? now : new Date()).toISOString();
  const createdValue = toDate(createdIso ?? nowIso);
  const updatedValue = updatedPlaceholder ?? toDate(nowIso);

  const repoSlug = subjectToSlug(String(repo ?? 'unknown')) || 'unknown';
  const noteId = `${repoSlug}-session-narrative`;
  const titleValue = `${repo ?? 'unknown'} — Session Narrative`;
  const title = yamlQuoteIfNeeded(titleValue) === titleValue ? `"${titleValue}"` : yamlQuoteIfNeeded(titleValue);

  const lines = [];

  // Frontmatter — `_generator` LAST (markdown-writer / render-sessions convention).
  lines.push('---');
  lines.push(`id: ${noteId}`);
  lines.push('type: session');
  lines.push(`title: ${title}`);
  lines.push(`created: ${createdValue}`);
  lines.push(`updated: ${updatedValue}`);
  lines.push(`repo: ${yamlQuoteIfNeeded(String(repo ?? 'unknown'))}`);
  lines.push(`_generator: ${GENERATOR_MARKER}`);
  lines.push('---');
  lines.push('');

  // Title + preamble
  lines.push(`# ${repo ?? 'unknown'} — Session Narrative`);
  lines.push('');
  lines.push(
    '> Durable per-repo narrative mirrored from `.claude/STATE.md` (Epic #673). ' +
      'What was done, what failed, and what not to retry — readable without opening the repo.',
  );
  lines.push('');

  // Wave History
  lines.push('## Wave History');
  lines.push('');
  lines.push(n.waveHistory && n.waveHistory.trim() ? n.waveHistory : '_(none recorded)_');
  lines.push('');

  // Deviations
  lines.push('## Deviations');
  lines.push('');
  lines.push(n.deviations && n.deviations.trim() ? n.deviations : '_(none recorded)_');
  lines.push('');

  // What Not To Retry
  lines.push('## What Not To Retry');
  lines.push('');
  lines.push(n.whatNotToRetry && n.whatNotToRetry.trim() ? n.whatNotToRetry : '_(none recorded)_');
  lines.push('');

  // Mission Status rollup — only when the frontmatter key was present + non-empty.
  lines.push('## Mission Status');
  lines.push('');
  if (Array.isArray(n.missionStatus) && n.missionStatus.length > 0) {
    lines.push(renderMissionTable(n.missionStatus));
  } else {
    lines.push('_(no mission-status rollup recorded)_');
  }
  lines.push('');

  return lines.join('\n');
}

// ── Path resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve the generator-owned narrative file path inside the vault.
 *
 * @param {string} vaultDir
 * @param {string} repoSlug
 * @returns {string}
 */
export function resolveNarrativePath(vaultDir, repoSlug) {
  return path.join(vaultDir, '01-projects', repoSlug, '_session-narrative.md');
}

// ── Idempotent write ─────────────────────────────────────────────────────────────

/**
 * Normalize a markdown string by replacing the `updated:` frontmatter line with a
 * stable placeholder, enabling byte-for-byte noop comparison.
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeUpdated(content) {
  return content.replace(/^(updated:\s*)(.+)$/m, `$1${UPDATED_PLACEHOLDER}`);
}

/**
 * Write the narrative file with idempotency guards (mirrors gitlab-portfolio
 * markdown-writer.mjs contract).
 *
 * Guard order:
 *   0. dry-run → never write, return { action: 'dry-run' }.
 *   1. SAFETY (Epic #673 #1 risk): refuse if the target basename is `_overview.md`
 *      — that file is a hand-authored vault overview and must NEVER be clobbered by
 *      a generator. Return { action: 'skipped-handwritten' }.
 *   2. skip-handwritten: existing file with no `_generator` or a FOREIGN `_generator`
 *      marker is hand-authored / owned by another generator → never overwrite.
 *   3. skip-noop: rendered content (modulo the `updated:` timestamp) byte-identical
 *      to the existing content → no write.
 *   4. otherwise write (mkdir -p the parent dir first).
 *
 * @param {{
 *   outputPath: string,
 *   content: string,
 *   dryRun?: boolean,
 *   fs?: { readFileSync?: Function, writeFileSync?: Function, mkdirSync?: Function, existsSync?: Function },
 * }} opts
 * @returns {{ action: 'written'|'skipped-handwritten'|'skipped-noop'|'dry-run', path: string }}
 */
export function writeNarrative(opts) {
  const { outputPath, content, dryRun = false, fs: injectedFs } = opts;

  const fsReadFile = injectedFs?.readFileSync ?? readFileSync;
  const fsWriteFile = injectedFs?.writeFileSync ?? writeFileSync;
  const fsMkdir = injectedFs?.mkdirSync ?? mkdirSync;
  const fsExists = injectedFs?.existsSync ?? existsSync;

  // Dry-run: never write.
  if (dryRun) {
    return { action: 'dry-run', path: outputPath };
  }

  // SAFETY (Epic #673 #1 risk table): a generator must NEVER clobber the
  // hand-authored vault `_overview.md`. Defense-in-depth alongside the
  // dedicated `_session-narrative.md` target name and the marker guard below.
  if (path.basename(outputPath) === '_overview.md') {
    return { action: 'skipped-handwritten', path: outputPath };
  }

  if (fsExists(outputPath)) {
    let existingContent;
    try {
      existingContent = fsReadFile(outputPath, 'utf8');
    } catch {
      existingContent = null; // unreadable → treat as fresh write
    }

    if (existingContent !== null) {
      const fm = parseFrontmatter(existingContent);

      // skip-handwritten: no _generator or a foreign marker.
      if (!fm || !fm['_generator']) {
        return { action: 'skipped-handwritten', path: outputPath };
      }
      if (fm['_generator'] !== GENERATOR_MARKER) {
        return { action: 'skipped-handwritten', path: outputPath };
      }

      // skip-noop: content identical modulo the `updated:` timestamp.
      if (normalizeUpdated(existingContent) === normalizeUpdated(content)) {
        return { action: 'skipped-noop', path: outputPath };
      }
    }
  }

  fsMkdir(path.dirname(outputPath), { recursive: true });
  fsWriteFile(outputPath, content, 'utf8');
  return { action: 'written', path: outputPath };
}

// ── Loose-slug folder matching (issue #829 Finding 3) ────────────────────────────

/**
 * Fold a slug candidate to a comparison-only form: lowercase, every
 * non-alphanumeric character stripped. Used purely for equality comparison —
 * never as a slug value itself. `subjectToSlug` (vault-mirror/utils.mjs) does
 * NOT insert a hyphen at a camelCase boundary, so `GotzendorferV2` mints
 * `gotzendorferv2` — a DIFFERENT folder than a hand-created `gotzendorfer-v2`.
 * `looseSlug('gotzendorfer-v2') === looseSlug('gotzendorferv2')`, so the two
 * forms can be reconciled without changing `subjectToSlug` itself.
 *
 * @param {string} s
 * @returns {string}
 */
function looseSlug(s) {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Loose-match a freshly-minted candidate slug against EXISTING `01-projects/`
 * folder names before falling back to minting a new one (issue #829 Finding
 * 3). When EXACTLY ONE existing folder's {@link looseSlug} equals the
 * candidate's, that folder's EXACT on-disk name is reused (auto-resolving
 * casing/punctuation drift, e.g. `GotzendorferV2` → `gotzendorfer-v2`,
 * `LeadPipeDACH` → `leadpipe-dach`). Zero or MORE THAN ONE matches are
 * ambiguous (or there is genuinely no match) — the caller's `subjectToSlug`
 * candidate is returned unchanged, preserving current behaviour.
 *
 * Best-effort by design: any read failure (missing `01-projects/` dir,
 * permission error, first-ever write for this vault, …) falls through to the
 * candidate slug rather than throwing — a listing failure must never block a
 * narrative write.
 *
 * @param {string} vaultDir
 * @param {string} candidateSlug
 * @param {{ readdirSync?: Function }} [fsSeam] — injectable `readdirSync` (test seam).
 * @returns {string}
 */
function resolveLooseSlug(vaultDir, candidateSlug, fsSeam = {}) {
  const readdir = fsSeam.readdirSync ?? readdirSync;
  let entries;
  try {
    entries = readdir(path.join(vaultDir, '01-projects'), { withFileTypes: true });
  } catch {
    return candidateSlug;
  }
  if (!Array.isArray(entries)) return candidateSlug;

  const candidateLoose = looseSlug(candidateSlug);
  const matches = [];
  for (const entry of entries) {
    // Accept either a Dirent (real fs) or a plain string (a simplified test
    // seam) — only Dirents that report as non-directories are excluded; a
    // plain string is assumed to already denote a project folder.
    const isDirent = entry && typeof entry === 'object' && typeof entry.name === 'string';
    const name = isDirent ? entry.name : entry;
    if (typeof name !== 'string' || name.length === 0) continue;
    if (isDirent && typeof entry.isDirectory === 'function' && !entry.isDirectory()) continue;
    if (looseSlug(name) === candidateLoose) matches.push(name);
  }

  return matches.length === 1 ? matches[0] : candidateSlug;
}

// ── Convenience orchestration ────────────────────────────────────────────────────

/**
 * Read a repo's STATE.md, resolve the vault-dir from Session Config, render the
 * narrative, and write it idempotently.
 *
 * Silently no-ops (returns { action: 'skipped-vault-disabled' }) when
 * `vault-integration.enabled` is false/absent or the vault-dir is unset. The
 * resolved vault path is validated to live inside the (home-expanded) vault root
 * before any write.
 *
 * @param {{
 *   repoRoot: string,
 *   repo: string,
 *   now?: Date,
 *   dryRun?: boolean,
 *   fs?: object,
 *   hostPaths?: { env?: Record<string, string|undefined>, ownerConfig?: object },
 * }} opts
 *   `hostPaths` is forwarded verbatim to {@link parseSessionConfig}'s `hostPaths` DI
 *   seam (issue #653). Tests MUST pass a hermetic ctx (e.g. `{ env: {}, ownerConfig:
 *   undefined }`) when asserting a fixture's committed `vault-dir` — omitting it reads
 *   the REAL host `owner.yaml`, whose `paths.vault-dir` override (if set) wins over the
 *   fixture value and bleeds into the assertion (issue #783). Production callers omit
 *   this — the default (real owner.yaml resolution) is the correct host-local behavior.
 * @returns {Promise<{ action: string, path?: string }>}
 */
export async function mirrorNarrative(opts) {
  const { repoRoot, repo, now = new Date(), dryRun = false, fs: injectedFs, hostPaths } = opts;

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { action: 'skipped-vault-disabled' };
  }

  // Read Session Config (CLAUDE.md / AGENTS.md) and resolve vault settings.
  let config;
  try {
    const configText = await readConfigFile(repoRoot);
    config = parseSessionConfig(configText, { hostPaths });
  } catch {
    return { action: 'skipped-vault-disabled' };
  }

  const vaultIntegration = config?.['vault-integration'];
  if (!vaultIntegration || vaultIntegration.enabled !== true) {
    return { action: 'skipped-vault-disabled' };
  }

  // Defense-in-depth: when the caller omits (or passes an empty) `repo`, derive
  // it from the operator-configured `vault-name` override (#660/#832) when set,
  // else the repoRoot basename — never silently mis-file under 'unknown' (#675
  // review). Precedence: explicit `repo` opt > `vault-name` > basename.
  const vaultNameOverride =
    typeof vaultIntegration['vault-name'] === 'string' && vaultIntegration['vault-name'].trim()
      ? vaultIntegration['vault-name'].trim()
      : null;
  const repoName = (typeof repo === 'string' && repo.trim().length > 0)
    ? repo
    : vaultNameOverride ?? path.basename(path.resolve(repoRoot));

  const rawVaultDir = vaultIntegration['vault-dir'];
  if (!rawVaultDir || typeof rawVaultDir !== 'string') {
    return { action: 'skipped-vault-disabled' };
  }

  const vaultDir = path.resolve(expandHome(rawVaultDir));
  const candidateSlug = subjectToSlug(repoName) || 'unknown';
  // Loose-match against existing 01-projects/ folders before minting a new
  // slug (issue #829 Finding 3) — see resolveLooseSlug for the ambiguity
  // rules. Falls through to `candidateSlug` unchanged on any read failure.
  const repoSlug = resolveLooseSlug(vaultDir, candidateSlug, { readdirSync: injectedFs?.readdirSync });
  const outputPath = resolveNarrativePath(vaultDir, repoSlug);

  // Defense-in-depth: ensure the resolved file stays inside the vault root.
  const inside = validatePathInsideProject(path.relative(vaultDir, outputPath), vaultDir);
  if (!inside.ok) {
    return { action: 'skipped-invalid-path', path: outputPath };
  }

  // Read STATE.md (best-effort; absent STATE.md → nothing to mirror).
  const stateMdPath = path.join(repoRoot, '.claude', 'STATE.md');
  let stateContents;
  try {
    stateContents = await readFile(stateMdPath, 'utf8');
  } catch {
    return { action: 'skipped-no-statemd', path: outputPath };
  }

  const narrative = extractNarrative(stateContents);
  const content = renderNarrative({ repo: repoName, narrative, now });

  return writeNarrative({ outputPath, content, dryRun, fs: injectedFs });
}
