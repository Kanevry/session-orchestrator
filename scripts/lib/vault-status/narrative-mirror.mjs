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
 *   NARRATIVE_EVENT        — canonical telemetry event name for a mirror attempt
 *   extractNarrative       — pure: STATE.md contents → { waveHistory, deviations, whatNotToRetry, missionStatus }
 *   renderNarrative        — pure: narrative + repo + now → full markdown (frontmatter + body)
 *   writeNarrative         — idempotent write with skip-handwritten / skip-noop / dry-run + _overview refusal
 *   resolveNarrativePath   — vaultDir + repoSlug → <vaultDir>/01-projects/<repoSlug>/_session-narrative.md
 *   mirrorNarrative        — convenience: read STATE.md, resolve vault-dir from config, write (no-op when vault disabled)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { emitEvent, sessionAttribution } from '../events.mjs';
import { parseStateMd, parseMissionStatus } from '../state-md.mjs';
import {
  parseFrontmatter,
  toDate,
  yamlQuoteIfNeeded,
  subjectToSlug,
} from '../vault-mirror/utils.mjs';
import { matchesModuloRedaction } from '../vault-mirror/process.mjs';
import { readConfigFile, parseSessionConfig } from '../config.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';
import { createSecretValueMasker } from '../secret-masker.mjs';
import { expandTilde } from '../common.mjs';

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

// ── Secret masking (#974 / #1025) ───────────────────────────────────────────────

/**
 * Mask every env-derived secret VALUE inside an extracted narrative, BEFORE any
 * of it is rendered into the vault file.
 *
 * WHY THIS FILE NEEDS IT AT ALL. `mirrorNarrative` writes into
 * `<vault>/01-projects/<slug>/_session-narrative.md`, and those files are TRACKED
 * AND PUSHED in the operator's vault repo. Its content is STATE.md free text —
 * Deviations, Wave History, mission-status task descriptions — i.e. agent-authored
 * prose that routinely quotes command lines and error output. That is exactly the
 * class a shape-regex cannot catch: the VALUE sits in the prose with no
 * `FOO_TOKEN=` key beside it. A leak here is not fixable by deleting a line — it
 * needs a history rewrite in a foreign repo, which neither this repo's
 * `.gitleaks.toml` nor `check-owner-leakage.mjs` can reach (the vault has no
 * `.husky/` and no active git hooks).
 *
 * WHY THE CALL SITE IS AFTER `extractNarrative`, NOT BEFORE IT. Masking the raw
 * STATE.md string first would let `[REDACTED]` land inside the source
 * FRONTMATTER, where `[…]` reads as a YAML flow sequence. `extractNarrative`
 * parses that frontmatter to obtain `missionStatus`; on a parse error it falls
 * back to `frontmatter = null`, so `missionStatus` becomes null and the Mission
 * Status table SILENTLY disappears from the mirrored file. Masking the parsed
 * narrative keeps the parse on clean input.
 *
 * WHICH OF THE FOUR `vault-mirror/process.mjs` REASONS CARRY HERE — measured, not
 * assumed. Not (1) filename: the basename is the constant `_session-narrative.md`.
 * Not (2) stdout: `mirrorNarrative` prints nothing. Not (3) YAML validity: every
 * output frontmatter field derives from the slug, the date and the repo name —
 * none reads from `narrative`. Only (4) IDEMPOTENCY carries, and it is decisive:
 * `writeNarrative` compares byte-for-byte modulo `updated:`, so masking after
 * that comparison would make every affected file re-render (and re-commit)
 * forever.
 *
 * WHY A GENERIC WALK RATHER THAN FIELD-BY-FIELD. Three of the four narrative keys
 * are strings, but `missionStatus` is an array of objects whose `id`/`task`/
 * `wave`/`status` fields are rendered into the body by `renderMissionTable`. A
 * field-by-field masker would publish a secret sitting in a `task:` description.
 * The walk also stays correct when a future key is added to the narrative shape.
 *
 * NAMED CEILING (build-value BV-004): the masker is built once PER CALL rather
 * than cached in a module-level singleton the way `vault-mirror/process.mjs` does.
 * `mirrorNarrative` runs once per repo per session-end, not in a loop, so the
 * O(env) construction is irrelevant — and a cached masker would silently go stale
 * against a mutated `process.env`, making the result depend on which consumer
 * happened to construct it first in the process. REVISIT TRIGGER: if this module
 * ever gains a per-record or per-wave loop, hoist the masker to the loop head
 * (still not to module scope).
 *
 * Fail-soft by construction: with zero needles the narrative is returned BY
 * REFERENCE (byte-identical downstream), and `mask` passes non-strings through —
 * masking must never be the reason a mirror run dies.
 *
 * Takes the ALREADY-BUILT masker (rather than building its own) so
 * `runNarrativeMirror` can build it exactly ONCE per run and reuse it for both
 * the actual masking below AND the `orchestrator.secret_masker.applied`
 * telemetry (#1028) — the masker's `needleCount` is measured once, not
 * potentially twice with process.env read between the two reads.
 *
 * @param {{ waveHistory: string, deviations: string, whatNotToRetry: string, missionStatus: object[]|null }} narrative
 * @param {{ mask: (text: string) => string, needleCount: number }} masker
 * @returns {{ narrative: { waveHistory: string, deviations: string, whatNotToRetry: string, missionStatus: object[]|null }, hits: number }}
 */
function maskNarrative(narrative, masker) {
  const { mask, needleCount } = masker;
  if (needleCount === 0) return { narrative, hits: 0 };

  let hits = 0;
  const walk = (value) => {
    if (typeof value === 'string') {
      const masked = mask(value);
      if (masked !== value) hits++;
      return masked;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };

  return { narrative: walk(narrative), hits };
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
 *   3. skip-noop: rendered content (modulo the `updated:` timestamp AND modulo any
 *      `[REDACTED]` span already on disk) matches the existing content → no write.
 *   4. otherwise write (mkdir -p the parent dir first).
 *
 * WHY STEP 3 IS NOT A PLAIN BYTE COMPARE (#1025). Masking is env-derived and the
 * env is not part of STATE.md, so the two sides of this comparison can be masked
 * DIFFERENTLY: a file written while `FOO_TOKEN` was set carries `[REDACTED]`, and
 * a later run with that var absent renders the RAW value. A byte compare then
 * reports "changed" and this function PUBLISHES THE RAW SECRET into a file that is
 * tracked and pushed in the operator's vault repo — where the vault has no
 * `.husky/` and no active git hooks, so nothing catches it and only a history
 * rewrite in a foreign repo removes it. Reproduced without touching the source
 * between runs: run 1 (env set) → `skipped-noop`, run 2 (env absent) → `written`
 * with the raw value on disk.
 *
 * `matchesModuloRedaction` is IMPORTED from `../vault-mirror/process.mjs`, not
 * re-derived here: `secret-masker.mjs`'s header states this compensation as a
 * contract binding on every consumer that diffs a written artifact against a fresh
 * render, and a contract held at two addresses is a contract that drifts. This
 * module already depends on `vault-mirror/utils.mjs`, and `vault-mirror` imports
 * nothing from `vault-status`, so the direction adds no cycle.
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

      // skip-noop: content identical modulo the `updated:` timestamp, or —
      // #1025 — identical once every `[REDACTED]` span already on disk is read
      // as a wildcard. See the guard-order note above for why the second arm is
      // load-bearing rather than a nicety.
      const existingNormalized = normalizeUpdated(existingContent);
      const candidateNormalized = normalizeUpdated(content);
      if (
        existingNormalized === candidateNormalized ||
        matchesModuloRedaction(existingNormalized, candidateNormalized)
      ) {
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

// ── Telemetry ────────────────────────────────────────────────────────────────────

/**
 * Canonical event name for a narrative-mirror attempt (issue #1129).
 *
 * ONE event per {@link mirrorNarrative} call — the REJECTION and NO-OP paths
 * included, because those are the point. Before this existed, a vault-disabled
 * config, a missing STATE.md, a hand-authored target file and a healthy write
 * were all indistinguishable from the ledger's side: measured 2026-08-23 over
 * 28 387 records in `.orchestrator/metrics/events.jsonl`, ZERO board/mirror
 * events, because this module did not import {@link emitEvent} at all. Its only
 * caller is shell prose in `skills/session-end/session-metrics-write.md`, whose
 * `mode: warn` degradation prints a WARNING and closes the session anyway — so
 * an outage of this writer left no durable trace whatsoever.
 *
 * Name deliberately NOT minted here: it is the one the wave assigned, so the
 * fact "a narrative mirror ran" has exactly one address in the ledger.
 */
export const NARRATIVE_EVENT = 'orchestrator.vault.narrative_mirrored';

/**
 * Emit the narrative-mirror telemetry record. Best-effort: never throws, never
 * alters the mirror result.
 *
 * ABSENT IS NOT ZERO (`docs/events-schema.md`): every optional field is spread
 * conditionally, so an UNMEASURED field is MISSING from the record rather than
 * written as `0`. `chars: 0` would then honestly mean "the narrative rendered to
 * an empty document"; an absent `chars` means "no render was reached on this
 * path" — reading the missing key as `0` conflates the two in both directions.
 *
 * NAMED CEILING (build-value BV-004): when `repoRoot` is absent or empty this
 * emits NOTHING. `emitEvent` without `opts.repoRoot` falls back to
 * `SO_PROJECT_DIR` (#941), so the only destination left for a rootless call is
 * whichever repo the process happens to sit in — i.e. a caller that named no
 * repo would silently append to a FOREIGN ledger, and the two call shapes that
 * reach this branch today are the `repoRoot: ''` / omitted-`repoRoot` unit
 * tests, which would then write synthetic records into this repo's real fleet
 * telemetry on every suite run. REVISIT TRIGGER: if a production caller ever
 * legitimately invokes `mirrorNarrative` without a `repoRoot`, that call needs a
 * destination decision of its own — not this silent skip.
 *
 * @param {object} opts
 * @param {string} [opts.repoRoot] — pins the ledger to THIS repo's
 *   `.orchestrator/metrics/events.jsonl` (#941), and supplies session attribution.
 * @param {string} opts.action — the `action` the mirror returned, or `'error'`
 *   when the writer threw. ALWAYS present.
 * @param {string} [opts.path] — resolved narrative path, when one was resolved.
 * @param {number} [opts.chars] — length of the rendered narrative document this
 *   call produced. Present whenever the render was reached (so also on
 *   `skipped-noop` / `dry-run`, where the document was built but not written —
 *   `action` is what says whether it landed); absent on the earlier no-op paths,
 *   which return before anything is rendered.
 * @param {string} [opts.errorCode] — `err.code` on the throw path (a bounded
 *   token such as `EACCES`). The error MESSAGE is deliberately NOT recorded: it
 *   can quote a path or STATE.md content, and this module's whole reason for
 *   masking (#1025) is that such prose carries secrets.
 * @returns {Promise<void>}
 */
/**
 * Reduce an absolute vault path to its LAST TWO segments for telemetry.
 *
 * The full path is the module's public return contract and stays untouched.
 * What must not travel is the path in the EMITTED payload: on a real host it
 * reads `/Users/<name>/Projects/<vault>/01-projects/<private-slug>/…`, i.e. an
 * OS username plus a private project slug. Those are exactly the two shapes
 * `scripts/lib/validate/check-owner-leakage.mjs` blocks as CP1 and CP6 — and
 * that scanner structurally cannot see this one, because it walks `git ls-files`
 * and `.orchestrator/metrics/*.jsonl` is gitignored (`.gitignore:40`).
 * The record is invisible to the pre-commit guard and visible to the optional
 * Clank webhook (`scripts/lib/events.mjs`, `CLANK_EVENT_URL`), which posts the
 * payload verbatim with no redaction.
 *
 * The BASENAME is the deliberate ceiling — one segment, not two. Two segments
 * would keep the parent directory, and under `01-projects/` that directory IS
 * the private project slug, i.e. exactly the CP6 shape this is meant to drop.
 * The diagnostic value lives in the filename alone: it says WHICH writer ran
 * (`_session-narrative.md` vs `_active-sessions.md`), which is the question the
 * event exists to answer. Which project it was is already answerable from the
 * record's own `session_id` / repo-scoped ledger location.
 * Revisit trigger: a consumer that needs more than the filename — then it
 * belongs in the RETURN value, which already carries the absolute path, never
 * in the event.
 *
 * @param {unknown} outputPath
 * @returns {string|undefined} `undefined` when there is nothing measured to report.
 */
function telemetrySafePath(outputPath) {
  if (typeof outputPath !== 'string' || outputPath.length === 0) return undefined;
  const base = path.basename(outputPath);
  return base.length > 0 ? base : undefined;
}

async function emitNarrativeEvent({ repoRoot, action, path: outputPath, chars, errorCode }) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return;
  try {
    await emitEvent(
      NARRATIVE_EVENT,
      {
        action,
        ...(telemetrySafePath(outputPath) !== undefined ? { path_tail: telemetrySafePath(outputPath) } : {}),
        // `typeof … === 'number'` rather than `!= null`: the repo's eslint
        // `eqeqeq: always` forbids the loose form, and this shape additionally
        // refuses a non-numeric `chars` outright. A measured `0` still lands.
        ...(typeof chars === 'number' ? { chars } : {}),
        // `typeof === 'string'`, not truthiness: an `err.code` of '' is a measured
        // empty code, and the sibling `chars` field four lines up already states
        // why this file rejects the loose form.
        ...(typeof errorCode === 'string' && errorCode.length > 0 ? { error_code: errorCode } : {}),
        // session_id / semantic_session_id — omitted entirely when no session
        // lock is readable (CI, ad-hoc runs). See sessionAttribution's contract:
        // a fabricated id would read as a real session.
        ...sessionAttribution(repoRoot),
      },
      { repoRoot },
    );
  } catch {
    /* Best-effort telemetry. emitEvent does real file I/O (mkdir + append), so a
       read-only or occupied ledger path WILL throw — and a broken ledger must
       never fail a narrative write. The mirror result is authoritative. */
  }
}

/**
 * Emit this channel's `orchestrator.secret_masker.applied` record (#1028
 * residue 2). Until now the narrative mirror was the ONLY masker channel of
 * the three (`vault-mirror`, `narrative-mirror`, `export-hw-learnings`) that
 * never emitted this event — `maskNarrative` has masked unconditionally since
 * #1025, but nothing told the ledger. A census grepping event NAMES for
 * `narrative` therefore read as "this channel masks nothing", which was never
 * true; it just never SAID so.
 *
 * Emitted UNCONDITIONALLY once per `mirrorNarrative` run whenever a `repoRoot`
 * was resolvable — including every skip outcome, not only `written` — so
 * `needle_count: 0` is a REAL measured "the env carries no secret-shaped
 * value" rather than a stand-in for "the masker never ran" (same
 * force-build-don't-default posture as `getMaskerStats()` in
 * `scripts/lib/vault-mirror/process.mjs`). `records` is the literal `1`: one
 * `mirrorNarrative` run always masks (or attempts to mask) exactly one
 * STATE.md, unlike the CLI channels that fan out over many JSONL lines.
 *
 * Same field set as the `vault-mirror` channel's own masker emit
 * (`channel`, `needle_count`, `records`, `hits`, `dry_run`), PLUS
 * `session_id`/`semantic_session_id` via `sessionAttribution` — matching this
 * module's own `emitNarrativeEvent` above rather than the CLI's 2-arg
 * `emitEvent` call, because `mirrorNarrative` (unlike the CLI) already always
 * carries a `repoRoot` to attribute against.
 *
 * Best-effort: never throws, never alters the mirror result.
 *
 * @param {{ repoRoot?: string, needleCount: number, hits: number, dryRun: boolean }} opts
 * @returns {Promise<void>}
 */
async function emitMaskerEvent({ repoRoot, needleCount, hits, dryRun }) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return;
  try {
    await emitEvent(
      'orchestrator.secret_masker.applied',
      {
        channel: 'narrative-mirror',
        needle_count: needleCount,
        records: 1,
        hits,
        dry_run: dryRun,
        ...sessionAttribution(repoRoot),
      },
      { repoRoot },
    );
  } catch {
    /* Best-effort telemetry — see emitNarrativeEvent above for why. */
  }
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
 * THIS FUNCTION WRITES TO THE OPERATOR'S REAL VAULT UNLESS YOU STOP IT. `vault-dir`
 * resolves HOST-LOCALLY — `SO_VAULT_DIR` > `owner.yaml` `paths.vault-dir` >
 * committed Session Config (`scripts/lib/config/host-paths.mjs`) — so the literal
 * value in a CLAUDE.md you just wrote into a tmp dir LOSES to both overrides. A
 * probe that passes a synthetic `repoRoot` and nothing else has already written
 * into the live vault once (#1025 review). Any caller that must not touch the real
 * vault passes `hostPaths: { env: {}, ownerConfig: undefined }` (see below),
 * `dryRun: true`, or a fully injected `fs`; a tmp `repoRoot` alone is NOT enough.
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
  let outcome;
  try {
    outcome = await runNarrativeMirror(opts);
  } catch (err) {
    // The harshest silent-failure case: `session-metrics-write.md` catches this
    // throw, prints a WARNING under `mode: warn` and closes the session anyway.
    // Record it, then re-throw — telemetry observes, it never swallows.
    await emitNarrativeEvent({
      repoRoot: opts?.repoRoot,
      action: 'error',
      errorCode: typeof err?.code === 'string' ? err.code : undefined,
    });
    throw err;
  }

  await emitNarrativeEvent({
    repoRoot: opts?.repoRoot,
    action: outcome.result.action,
    path: outcome.result.path,
    chars: outcome.chars,
  });

  // #1028 residue 2: the masker-telemetry sibling of the narrative event
  // above, on every non-throwing outcome (including skips) — see
  // emitMaskerEvent for why this fires unconditionally.
  await emitMaskerEvent({
    repoRoot: opts?.repoRoot,
    needleCount: outcome.needleCount,
    hits: outcome.hits,
    dryRun: outcome.dryRun,
  });

  return outcome.result;
}

/**
 * The mirror itself — every early return of {@link mirrorNarrative} lives here.
 *
 * Split out so that the two emit sites in `mirrorNarrative` (the narrative
 * event AND, since #1028, the masker event) each cover EVERY outcome from
 * ONE call: a future early return added inside this function is telemetered
 * by construction, whereas hand-placing an emit beside each of the seven
 * `return`s makes "forgot the new one" the default failure. The `chars` companion travels beside the result
 * rather than inside it because the returned object is a PUBLIC shape that
 * callers (and tests) compare with `toEqual` — adding a key there would be an
 * observable contract change for a purely internal measurement.
 *
 * @param {Parameters<typeof mirrorNarrative>[0]} opts
 * @returns {Promise<{ result: { action: string, path?: string }, chars?: number, needleCount: number, hits: number, dryRun: boolean }>}
 */
async function runNarrativeMirror(opts) {
  const { repoRoot, repo, now = new Date(), dryRun = false, fs: injectedFs, hostPaths } = opts;

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    return { result: { action: 'skipped-vault-disabled' }, needleCount: 0, hits: 0, dryRun };
  }

  // #1028: the masker is built ONCE per run, right here — before every
  // remaining early-return below — so `mirrorNarrative`'s
  // `orchestrator.secret_masker.applied` emit always carries a REAL measured
  // `needle_count` on every outcome (including a skip), rather than a
  // defaulted 0 that would be indistinguishable from "the masker never ran".
  // Same "force-build, never default" posture as `getMaskerStats()` in
  // `scripts/lib/vault-mirror/process.mjs`.
  const masker = createSecretValueMasker(process.env);

  // Read Session Config (CLAUDE.md / AGENTS.md) and resolve vault settings.
  let config;
  try {
    const configText = await readConfigFile(repoRoot);
    config = parseSessionConfig(configText, { hostPaths });
  } catch {
    return { result: { action: 'skipped-vault-disabled' }, needleCount: masker.needleCount, hits: 0, dryRun };
  }

  const vaultIntegration = config?.['vault-integration'];
  if (!vaultIntegration || vaultIntegration.enabled !== true) {
    return { result: { action: 'skipped-vault-disabled' }, needleCount: masker.needleCount, hits: 0, dryRun };
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
    return { result: { action: 'skipped-vault-disabled' }, needleCount: masker.needleCount, hits: 0, dryRun };
  }

  const vaultDir = path.resolve(expandTilde(rawVaultDir));
  const candidateSlug = subjectToSlug(repoName) || 'unknown';
  // Loose-match against existing 01-projects/ folders before minting a new
  // slug (issue #829 Finding 3) — see resolveLooseSlug for the ambiguity
  // rules. Falls through to `candidateSlug` unchanged on any read failure.
  const repoSlug = resolveLooseSlug(vaultDir, candidateSlug, { readdirSync: injectedFs?.readdirSync });
  const outputPath = resolveNarrativePath(vaultDir, repoSlug);

  // Defense-in-depth: ensure the resolved file stays inside the vault root.
  //
  // `canonicalizeRoot: true` (#1033) is load-bearing, not hygiene. The guard's
  // realpath phase is skipped while the target is ABSENT (ENOENT) and fires once
  // it EXISTS — so on a vault root reached through a symlink, run 1 writes and
  // run 2 resolves the file to the canonical path, reads it as outside the
  // LEXICAL root, and returns `skipped-invalid-path` forever after. Canonicalizing
  // the root makes both sides of the comparison the same kind of path. Same call
  // shape as scripts/lib/reconcile/writer.mjs and scripts/lib/memory-proposals/store.mjs.
  const inside = validatePathInsideProject(path.relative(vaultDir, outputPath), vaultDir, {
    canonicalizeRoot: true,
  });
  if (!inside.ok) {
    return { result: { action: 'skipped-invalid-path', path: outputPath }, needleCount: masker.needleCount, hits: 0, dryRun };
  }

  // Read STATE.md (best-effort; absent STATE.md → nothing to mirror).
  const stateMdPath = path.join(repoRoot, '.claude', 'STATE.md');
  let stateContents;
  try {
    stateContents = await readFile(stateMdPath, 'utf8');
  } catch {
    return { result: { action: 'skipped-no-statemd', path: outputPath }, needleCount: masker.needleCount, hits: 0, dryRun };
  }

  // #1025: the ONE masking site for the narrative mirror — after the frontmatter
  // parse (so `[REDACTED]` can never break it) and before the render, the
  // idempotency comparison and the write. See maskNarrative above.
  const { narrative, hits } = maskNarrative(extractNarrative(stateContents), masker);
  const content = renderNarrative({ repo: repoName, narrative, now });

  // `chars` measures the document THIS call rendered — so it is present on
  // `skipped-noop` and `dry-run` too, where the render happened but nothing
  // landed. `action` is the field that says whether it landed.
  return {
    result: writeNarrative({ outputPath, content, dryRun, fs: injectedFs }),
    chars: content.length,
    needleCount: masker.needleCount,
    hits,
    dryRun,
  };
}
