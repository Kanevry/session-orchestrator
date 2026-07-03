/**
 * process.mjs — Core entry processors for vault-mirror (Issue #283 split).
 *
 * Exports: processLearning, processSession
 * Both functions write to the vault dir and emit JSON action lines to stdout.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { subjectToSlug, isValidSlug, uuidPrefix8, toDate, parseFrontmatter } from './utils.mjs';
import { resolveRepoNamespace } from './namespace.mjs';
import { detectLearningSchema, normalizeLearningEntry, generateLearningNote, generateLearningNoteV2 } from './render-learnings.mjs';
import { detectSessionSchema, normalizeSessionEntry, generateSessionNote, generateSessionNoteV2, generateSessionNoteV3 } from './render-sessions.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

// ── Session-note existence index (Issue #704) ─────────────────────────────────

/**
 * Module-level cache: resolved vaultDir path → Set of known session basenames
 * (without the `.md` extension). Built once per unique vaultDir per process.
 *
 * @type {Map<string, Set<string>>}
 */
const _sessionNoteSets = new Map();

/**
 * Recursively walk `<vaultDir>/50-sessions/` and collect every `.md` basename
 * (without extension) into a Set. Returns an EMPTY Set (never throws) when the
 * directory is absent or unreadable — callers treat an empty Set as "no predicate
 * available", falling back to format-validation in resolveSourceSessionLink.
 *
 * Read-only: never creates directories, safe in dryRun mode.
 *
 * @param {string} vaultDir — absolute path to the vault root
 * @returns {Set<string>}
 */
function getSessionNoteSet(vaultDir) {
  const resolvedVault = resolve(vaultDir);
  if (_sessionNoteSets.has(resolvedVault)) return _sessionNoteSets.get(resolvedVault);

  const knownSessions = new Set();
  const sessionsDir = join(resolvedVault, '50-sessions');

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir absent or inaccessible — skip silently
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(join(dir, entry.name));
      } else if (entry.name.endsWith('.md')) {
        knownSessions.add(entry.name.slice(0, -3)); // basename without .md
      }
    }
  }

  walk(sessionsDir);
  _sessionNoteSets.set(resolvedVault, knownSessions);
  return knownSessions;
}

// ── Content diff helper ───────────────────────────────────────────────────────

/**
 * Extract canonical comparable fields from a rendered learning note string.
 *
 * We compare only the fields that represent meaningful SSOT content changes —
 * not created/updated dates or frontmatter ordering, which differ on every
 * render without signalling a content change.
 *
 * Comparable fields:
 *   - status (frontmatter line `status: <value>`)
 *   - expires (frontmatter line `expires: <value>`, v1 only; absent in v2)
 *   - confidence (body bullet `- **Confidence:** <value>`)
 *   - insight body (text after `## Insight\n\n` heading, trimmed)
 *
 * @param {string} noteContent — rendered markdown string
 * @returns {{ status: string, expires: string, confidence: string, insight: string }}
 */
function extractLearningCanonicalFields(noteContent) {
  const status = (noteContent.match(/^status:\s*(.+)$/m) || [])[1]?.trim() ?? '';
  const expires = (noteContent.match(/^expires:\s*(.+)$/m) || [])[1]?.trim() ?? '';
  const confidence = (noteContent.match(/^- \*\*Confidence:\*\*\s*(.+)$/m) || [])[1]?.trim() ?? '';
  // Extract insight body: everything after `## Insight\n\n` until the next `##` or end-of-string
  const insightMatch = noteContent.match(/^## Insight\n\n([\s\S]*?)(?=\n## |\s*$)/m);
  const insight = insightMatch ? insightMatch[1].trim() : '';
  // #704: track the frontmatter source_session so a normal re-mirror repairs
  // historical dangling-link notes (e.g. `source_session: "[[unknown]]"`) once
  // the renderer emits the corrected plain-text/resolvable form — otherwise the
  // content-diff would treat the stale note as a no-op and never heal it.
  const source_session = (noteContent.match(/^source_session:\s*(.+)$/m) || [])[1]?.trim() ?? '';
  return { status, expires, confidence, insight, source_session };
}

/**
 * Return true when the existing vault note content and the freshly-rendered
 * candidate share identical canonical fields (i.e. no meaningful update needed).
 *
 * A true result means → emit skipped-noop.
 * A false result means → the SSOT changed; write the new content.
 *
 * Comparison semantics: a field that is ABSENT in the existing note (empty
 * string from extractLearningCanonicalFields) is treated as matching any
 * rendered value for that field. This preserves backward compatibility with
 * notes written by older generator versions that may not have emitted every
 * field. Only when an existing field is NON-EMPTY and differs from the
 * rendered candidate do we conclude the SSOT has changed and an update is needed.
 *
 * @param {string} existingContent — content read from the vault note on disk
 * @param {string} renderedContent — freshly generated note from the renderer
 * @returns {boolean}
 */
function learningContentMatches(existingContent, renderedContent) {
  const existing = extractLearningCanonicalFields(existingContent);
  const rendered = extractLearningCanonicalFields(renderedContent);
  // For each field: if the existing value is absent (empty string), it cannot
  // signal a mismatch — it means the old note didn't track that field. Only
  // non-empty existing values are compared against the rendered candidate.
  const fieldMatches = (existingVal, renderedVal) =>
    existingVal === '' || existingVal === renderedVal;
  return (
    fieldMatches(existing.status, rendered.status) &&
    fieldMatches(existing.expires, rendered.expires) &&
    fieldMatches(existing.confidence, rendered.confidence) &&
    fieldMatches(existing.insight, rendered.insight) &&
    fieldMatches(existing.source_session, rendered.source_session)
  );
}

// ── repo derivation ───────────────────────────────────────────────────────────

let _cachedRepo = null;

/**
 * Derive the canonical repo identifier for cross-repo vault aggregation (issue #343).
 *
 * Strategy: parse `git remote get-url origin` and extract the org/name pair
 * (e.g. `git@github.com:Kanevry/session-orchestrator.git` → `Kanevry/session-orchestrator`).
 * Falls back to `path.basename(process.cwd())` when not in a git repo or origin
 * is unavailable. Cached per-process — repo identity does not change mid-run.
 */
export function deriveRepo() {
  if (_cachedRepo !== null) return _cachedRepo;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    // Match git@host:org/name(.git)? OR https://host/org/name(.git)?
    const sshMatch = url.match(/[:/]([^:/]+\/[^/]+?)(?:\.git)?$/);
    if (sshMatch && sshMatch[1]) {
      _cachedRepo = sshMatch[1];
      return _cachedRepo;
    }
  } catch {
    // git unavailable or no origin configured — fall through
  }
  _cachedRepo = basename(process.cwd());
  return _cachedRepo;
}

// ── Action output ─────────────────────────────────────────────────────────────

/**
 * Emit a JSON action line to stdout.
 *
 * Takes a single self-documenting options object (issue #511). `emitAction` is a
 * module-level export (independently unit-tested), so `vaultDir` is carried as a
 * named option field rather than pulled from a closure — both callers
 * (processLearning, processSession) destructure it from their own `ctx` and pass
 * it through.
 *
 * #589 LOW-arch-3 — the `vaultDir`-in-options-object pattern is consciously
 * accepted: the 16 call-sites in THIS module repeat `vaultDir` as boilerplate,
 * but there is only one consumer module, so a `makeEmitAction({ vaultDir })`
 * closure factory would be premature (YAGNI). Extract the factory ONLY when a
 * SECOND module needs `emitAction` and would otherwise re-thread `vaultDir`.
 *
 * @param {object} opts
 * @param {string} opts.action — action name (e.g. 'created', 'updated', 'skipped-quality-low')
 * @param {string|null} opts.path — absolute path to the file (or null when no file
 *   was created/touched, e.g. for quality-gate skips before any write)
 * @param {string} opts.kind — 'learning' or 'session'
 * @param {string|null} opts.id — entry id
 * @param {string} opts.vaultDir — vault root (used to relativise `path`)
 * @param {object} [opts.meta] — optional extra fields merged into the emitted JSON
 *   (used for quality-gate skips to carry a `reason` field). Callers that omit
 *   `meta` get the base JSON shape unchanged.
 */
export function emitAction({ action, path, kind, id, vaultDir, meta }) {
  let rel;
  if (path === null || path === undefined) {
    rel = null;
  } else {
    const resolvedVaultDir = resolve(vaultDir);
    rel = path.startsWith(resolvedVaultDir)
      ? path.slice(resolvedVaultDir.length + 1)
      : path;
  }
  const payload = { action, path: rel, kind, id };
  if (meta && typeof meta === 'object') {
    Object.assign(payload, meta);
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// ── Core processing ───────────────────────────────────────────────────────────

export async function processLearning(rawEntry, _lineNum, ctx) {
  const {
    vaultDir,
    dryRun,
    kind,
    force = false,
    qualityMinConfidence = 0.5,
    qualityMinNarrativeChars: _qualityMinNarrativeChars = 400, // unused for learnings; kept for ctx symmetry
  } = ctx;
  // #635: map producer alias fields (summary/detail, description/rationale,
  // title/body, name, narrative, content) onto the canonical v1 shape BEFORE
  // schema detection and slug/id derivation. Canonical entries pass through.
  const entry = normalizeLearningEntry(rawEntry);
  const schema = detectLearningSchema(entry);
  const entryId = entry.id;

  // Slug source differs by schema. Both fall back to learning-<uuid8> on invalid.
  // For v2 the id is already a kebab slug (e.g. "s69-compose-pids-cross-validation").
  // Crucially: validate id presence before slug derivation, so missing-id entries
  // become skipped-invalid rather than crashing inside subjectToSlug.
  if (entryId === null || entryId === undefined) {
    throw new Error(`vault-mirror: learning entry missing required field 'id' (id=<no id>)`);
  }
  // #725 D1: the raw v1 subject is prose WITH SPACES, and subjectToSlug() strips
  // spaces WITHOUT hyphenating — so "Dead fallback removal when primary parser
  // matures" collapsed into a single run "deadfallbackremovalwhenprimaryparser…"
  // (a silent slug corruption that still passes isValidSlug). Pre-map the
  // subject's whitespace to hyphens BEFORE subjectToSlug, mirroring the id
  // derivation in normalizeLearningEntry (render-learnings.mjs L63-65) so a
  // learning's slug matches its derived id. This keeps the subject as the v1 slug
  // source (the established contract: entry.id is reserved for the disambiguation
  // /invalid-slug fallback prefix via uuidPrefix8 below), and only heals the
  // space-collapse defect. v2 ids are already kebab slugs.
  //
  // NOTE (#725 D1 divergence): the wave brief asked to make entry.id the PRIMARY
  // slug source. That is architecturally incompatible with the invalid-slug
  // fallback `learning-<uuidPrefix8(entry.id)>` (which requires entry.id to stay
  // a clean value SEPARATE from the slug source) and would invert the slug-from-
  // subject contract pinned by 15 tests in tests/unit/vault-mirror.test.mjs. The
  // pre-map is the mechanism the brief itself names and yields the IDENTICAL slug
  // for real data (kebab id derived from the same subject); see report.
  let slugSource;
  if (schema === 'v2') {
    slugSource = entry.id;
  } else if (typeof entry.subject === 'string') {
    slugSource = entry.subject.trim().replace(/\s+/g, '-');
  } else {
    slugSource = entry.subject;
  }
  let slug;
  if (typeof slugSource === 'string' && slugSource.length > 0) {
    slug = subjectToSlug(slugSource);
  } else {
    slug = '';
  }
  if (!isValidSlug(slug)) {
    slug = `learning-${uuidPrefix8(entryId)}`;
  }
  // #635: cap the slug so `<slug>.md` (plus a possible `-<uuid8>` disambig
  // suffix) stays under the 255-byte filename limit. Normalized prose subjects
  // can be arbitrarily long and previously aborted the whole mirror run with
  // ENAMETOOLONG. 240 + 9 (disambig) + 3 (.md) = 252 — and every pre-existing
  // vault note (max observed slug: 208 chars) keeps its identity untouched.
  if (slug.length > 240) {
    slug = slug.slice(0, 240).replace(/-+$/, '');
  }

  // Generator + date source differ by schema
  const generator = schema === 'v2' ? generateLearningNoteV2 : generateLearningNote;
  const dateSource = schema === 'v2' ? entry.first_seen : entry.created_at;

  // #704: Build a noteExists predicate from the vault's 50-sessions index so that
  // resolveSourceSessionLink can use EXISTENCE-based resolution instead of strict
  // format-validation. The index is built once per vaultDir (cached in
  // _sessionNoteSets). When the 50-sessions dir is absent/empty, the Set is empty
  // and we pass NO predicate — resolveSourceSessionLink falls back to format
  // validation (never worse than Wave 2 behaviour).
  const _knownSessions = getSessionNoteSet(vaultDir);
  const _noteExists = _knownSessions.size > 0 ? (s) => _knownSessions.has(s) : undefined;
  const generatorOpts = _noteExists ? { noteExists: _noteExists } : {};

  // Quality gate (PRD F1.2): skip learnings with confidence below threshold.
  // Runs BEFORE the --force branch so --force does NOT bypass the quality filter.
  // Missing/non-numeric confidence is treated as 1.0 (legacy entries pass).
  const learningConfidence = typeof entry.confidence === 'number' ? entry.confidence : 1.0;
  if (learningConfidence < qualityMinConfidence) {
    emitAction({
      action: 'skipped-quality-low',
      path: null,
      kind,
      id: entryId,
      vaultDir,
      meta: { reason: `confidence:${learningConfidence} < min:${qualityMinConfidence}` },
    });
    return;
  }

  // #660: namespace new writes under a per-repo subdirectory.
  const repoNs = resolveRepoNamespace({ vaultName: ctx?.vaultName ?? null });
  // #725 D2: thread the resolved repo namespace into the learning frontmatter as
  // `source-repo` for cross-repo attribution. repoNs is already sanitised +
  // leak-guarded by resolveRepoNamespace, so it is safe to interpolate as-is. The
  // renderer reads opts.repoNs (see render-learnings.mjs); when absent (older
  // callers), the source-repo line is omitted — backward-compatible.
  generatorOpts.repoNs = repoNs;
  const targetDir = join(resolve(vaultDir), '40-learnings', repoNs);
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  let targetPath = join(targetDir, `${slug}.md`);

  // #660 IDEMPOTENCY DUAL-PROBE: before treating the namespaced path as absent,
  // also check the legacy flat path. If a note with the same slug already exists
  // in the flat layout (pre-namespace migration), treat it as existing to avoid
  // duplicating the note. The deferred-migration decision means we only skip;
  // we do NOT move the flat note into the namespaced dir here.
  const legacyFlatPath = join(resolve(vaultDir), '40-learnings', `${slug}.md`);
  if (!existsSync(targetPath) && existsSync(legacyFlatPath)) {
    const legacyContent = readFileSync(legacyFlatPath, 'utf8');
    const legacyFm = parseFrontmatter(legacyContent);
    // Only skip if the flat note is ours (has our generator marker and matching id).
    if (legacyFm && legacyFm['_generator'] === GENERATOR_MARKER && legacyFm['id'] === slug) {
      const entryUpdated = toDate(dateSource);
      if (!force && legacyFm['updated'] && legacyFm['updated'] >= entryUpdated) {
        // Date has not advanced — but content may have changed (confidence, insight, etc.).
        // Render the candidate and compare canonical fields before deciding to skip.
        const candidateContent = generator(entry, slug, generatorOpts);
        if (learningContentMatches(legacyContent, candidateContent)) {
          emitAction({ action: 'skipped-noop', path: legacyFlatPath, kind, id: slug, vaultDir });
          return;
        }
        // Content differs — fall through to write into the namespaced path.
      }
      // Updated date would advance or content changed — fall through to write into the namespaced path.
    }
  }

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      emitAction({ action: 'skipped-handwritten', path: targetPath, kind, id: entryId, vaultDir });
      return;
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      // Different generator — treat as hand-written to be safe
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      emitAction({ action: 'skipped-handwritten', path: targetPath, kind, id: entryId, vaultDir });
      return;
    }

    if (fm['id'] !== slug) {
      // Different id → collision: disambiguate
      const disambigSlug = `${slug}-${uuidPrefix8(entryId)}`;
      targetPath = join(targetDir, `${disambigSlug}.md`);
      slug = disambigSlug;

      if (existsSync(targetPath)) {
        // Still exists with disambig — check if it's ours
        const disambigContent = readFileSync(targetPath, 'utf8');
        const disambigFm = parseFrontmatter(disambigContent);
        if (!disambigFm || !disambigFm['_generator']) {
          process.stderr.write(`SKIP hand-written (disambig): ${targetPath}\n`);
          emitAction({ action: 'skipped-handwritten', path: targetPath, kind, id: entryId, vaultDir });
          return;
        }
        // Check updated advancement; if date has not advanced, also diff content.
        const entryUpdated = toDate(dateSource);
        if (disambigFm['updated'] && disambigFm['updated'] >= entryUpdated) {
          const candidateContent = generator(entry, slug, generatorOpts);
          if (learningContentMatches(disambigContent, candidateContent)) {
            emitAction({ action: 'skipped-noop', path: targetPath, kind, id: disambigSlug, vaultDir });
            return;
          }
          // Content differs — fall through to write.
        }
      }

      const content = generator(entry, slug, generatorOpts);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction({ action: 'skipped-collision-resolved', path: targetPath, kind, id: slug, vaultDir });
      return;
    }

    // Same id: check if updated would advance (unless --force overrides).
    // Even when the date has not advanced, content may have changed (confidence,
    // insight, expires_at, etc.) — compare canonical fields before skipping.
    const entryUpdated = toDate(dateSource);
    if (!force && fm['updated'] && fm['updated'] >= entryUpdated) {
      const candidateContent = generator(entry, slug, generatorOpts);
      if (learningContentMatches(existingContent, candidateContent)) {
        emitAction({ action: 'skipped-noop', path: targetPath, kind, id: slug, vaultDir });
        return;
      }
      // Content differs — fall through to overwrite (same path as date-advance branch).
    }

    // Overwrite with advanced updated date (or forced re-render)
    const content = generator(entry, slug, generatorOpts);
    if (!dryRun) writeFileSync(targetPath, content, 'utf8');
    emitAction({ action: 'updated', path: targetPath, kind, id: slug, vaultDir });
    return;
  }

  // File does not exist — create
  const content = generator(entry, slug, generatorOpts);
  if (!dryRun) writeFileSync(targetPath, content, 'utf8');
  emitAction({ action: 'created', path: targetPath, kind, id: slug, vaultDir });
}

export async function processSession(rawEntry, _lineNum, ctx) {
  const {
    vaultDir,
    dryRun,
    kind,
    force = false,
    qualityMinNarrativeChars = 400,
    qualityMinConfidence: _qualityMinConfidence = 0.5, // unused for sessions; kept for ctx symmetry
  } = ctx;
  // #635: map producer alias fields (ended_at, mode, total_waves/waves_completed
  // without a `waves` field) onto the canonical shapes BEFORE schema detection.
  // Canonical v1/v2/v3 entries pass through untouched.
  const entry = normalizeSessionEntry(rawEntry);
  const { session_id: rawSessionId } = entry;
  const schema = detectSessionSchema(entry);
  const generator =
    schema === 'v3' ? generateSessionNoteV3 : schema === 'v2' ? generateSessionNoteV2 : generateSessionNote;

  // Validate session_id as a filesystem-safe slug; fall back via subjectToSlug
  // (which collapses slashes to last segment + strips invalid chars) before
  // resorting to a uuid-derived slug. Without subjectToSlug, raw slashes in
  // rawSessionId (e.g. "feat/opus-4-7-...") would survive uuidPrefix8 and
  // produce a path with directory separators in the basename.
  let session_id;
  if (isValidSlug(rawSessionId)) {
    session_id = rawSessionId;
  } else if (typeof rawSessionId === 'string' && rawSessionId.length > 0) {
    const sanitised = subjectToSlug(rawSessionId);
    session_id = isValidSlug(sanitised) ? sanitised : `session-${uuidPrefix8(rawSessionId)}`;
  } else {
    session_id = `session-${uuidPrefix8(randomUUID())}`;
  }
  // #635: symmetric slug-length cap (see processLearning) — a pathologically
  // long but otherwise valid session_id slug would abort the mirror run with
  // ENAMETOOLONG when the filename exceeds the 255-byte limit.
  if (session_id.length > 240) {
    session_id = session_id.slice(0, 240).replace(/-+$/, '');
  }

  // #732: resolve the leak-guarded repo namespace ONCE per session, BEFORE the
  // quality gate, so both the write path (targetDir, below) AND the rendered
  // frontmatter (`source-repo`) use the SAME sanitised / pseudonym-mapped value.
  // Previously the frontmatter carried the RAW deriveRepo() output via a `repo:`
  // field while only the write path routed through resolveRepoNamespace() — an
  // owner-leaky repo's real name reached the vault through the session-note
  // frontmatter even though the directory AND the learning `source-repo` field
  // were already pseudonym-mapped/redacted (#732 leak-guard bypass).
  const repoNs = resolveRepoNamespace({ vaultName: ctx?.vaultName ?? null });

  // Quality gate (PRD F1.2): skip sessions whose rendered narrative is too short.
  // Measure on the rendered markdown body so the check is schema-agnostic across
  // v1 and v2 producers. The render is cheap and idempotent; we reuse the result
  // below instead of calling generator() a second time.
  // Runs BEFORE the --force branch so --force does NOT bypass the quality filter.
  // If the generator throws a `vault-mirror: …` validation error (missing
  // required field), it propagates up to vault-mirror.mjs which classifies it
  // as `skipped-invalid` rather than `skipped-quality-low` — semantically more
  // accurate for the metrics summary in session-end Phase 3.7.
  const renderedBody = generator(entry, { repoNs });
  // Strip YAML frontmatter (lines between the first two `---` markers) so we
  // measure only narrative content, not boilerplate.
  const narrativeBody = renderedBody.replace(/^---[\s\S]*?---/m, '').trim();
  const narrativeChars = narrativeBody.length;
  if (narrativeChars < qualityMinNarrativeChars) {
    emitAction({
      action: 'skipped-quality-low',
      path: null,
      kind,
      id: session_id,
      vaultDir,
      meta: { reason: `narrative:${narrativeChars} < min:${qualityMinNarrativeChars}` },
    });
    return;
  }

  // #660: namespace new writes under a per-repo subdirectory. repoNs was
  // resolved above (before the quality gate) so it is reused here unchanged —
  // the write path and the rendered `source-repo` frontmatter share one value.
  const targetDir = join(resolve(vaultDir), '50-sessions', repoNs);
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  // Canonical filename pattern (issue #343): `<session_id>.md` where session_id
  // follows `<branch>-<YYYY-MM-DD>-<HHmm>-<slug>` per the session-id schema.
  // session_id has been validated/sanitised above (isValidSlug → subjectToSlug
  // → uuid fallback). Historical filename inconsistencies in 50-sessions/ are
  // pre-existing on-disk artefacts and are NOT retroactively renamed here.
  const targetPath = join(targetDir, `${session_id}.md`);

  // #660 IDEMPOTENCY DUAL-PROBE: check the legacy flat path before treating
  // the namespaced path as absent. If a session note already exists flat
  // (pre-namespace migration), skip creating a duplicate.
  const legacyFlatPath = join(resolve(vaultDir), '50-sessions', `${session_id}.md`);
  if (!existsSync(targetPath) && existsSync(legacyFlatPath)) {
    const legacyContent = readFileSync(legacyFlatPath, 'utf8');
    const legacyFm = parseFrontmatter(legacyContent);
    if (legacyFm && legacyFm['_generator'] === GENERATOR_MARKER && legacyFm['id'] === session_id) {
      const entryUpdated = toDate(entry.completed_at);
      if (!force && legacyFm['updated'] && legacyFm['updated'] >= entryUpdated) {
        emitAction({ action: 'skipped-noop', path: legacyFlatPath, kind, id: session_id, vaultDir });
        return;
      }
      // Updated date would advance — fall through to write into the namespaced path.
    }
  }

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      emitAction({ action: 'skipped-handwritten', path: targetPath, kind, id: session_id, vaultDir });
      return;
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      emitAction({ action: 'skipped-handwritten', path: targetPath, kind, id: session_id, vaultDir });
      return;
    }

    // Same generator: check id and updated
    if (fm['id'] === session_id) {
      const entryUpdated = toDate(entry.completed_at);
      if (!force && fm['updated'] && fm['updated'] >= entryUpdated) {
        emitAction({ action: 'skipped-noop', path: targetPath, kind, id: session_id, vaultDir });
        return;
      }
      if (!dryRun) writeFileSync(targetPath, renderedBody, 'utf8');
      emitAction({ action: 'updated', path: targetPath, kind, id: session_id, vaultDir });
      return;
    }
  }

  // File does not exist — create. Reuse the rendered body computed during the
  // quality-gate check (avoids a second generator invocation).
  if (!dryRun) writeFileSync(targetPath, renderedBody, 'utf8');
  emitAction({ action: 'created', path: targetPath, kind, id: session_id, vaultDir });
}
