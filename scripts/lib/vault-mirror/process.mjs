/**
 * process.mjs — Core entry processors for vault-mirror (Issue #283 split).
 *
 * Exports: processLearning, processSession
 * Both functions write to the vault dir and emit JSON action lines to stdout.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { subjectToSlug, isValidSlug, uuidPrefix8, toDate, parseFrontmatter } from './utils.mjs';
import { resolveRepoNamespace } from './namespace.mjs';
import { detectLearningSchema, normalizeLearningEntry, generateLearningNote, generateLearningNoteV2 } from './render-learnings.mjs';
import { detectSessionSchema, normalizeSessionEntry, generateSessionNote, generateSessionNoteV2, generateSessionNoteV3 } from './render-sessions.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

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
  const slugSource = schema === 'v2' ? entry.id : entry.subject;
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
        emitAction({ action: 'skipped-noop', path: legacyFlatPath, kind, id: slug, vaultDir });
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
        // Check updated advancement
        const entryUpdated = toDate(dateSource);
        if (disambigFm['updated'] && disambigFm['updated'] >= entryUpdated) {
          emitAction({ action: 'skipped-noop', path: targetPath, kind, id: disambigSlug, vaultDir });
          return;
        }
      }

      const content = generator(entry, slug);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction({ action: 'skipped-collision-resolved', path: targetPath, kind, id: slug, vaultDir });
      return;
    }

    // Same id: check if updated would advance (unless --force overrides)
    const entryUpdated = toDate(dateSource);
    if (!force && fm['updated'] && fm['updated'] >= entryUpdated) {
      emitAction({ action: 'skipped-noop', path: targetPath, kind, id: slug, vaultDir });
      return;
    }

    // Overwrite with advanced updated date (or forced re-render)
    const content = generator(entry, slug);
    if (!dryRun) writeFileSync(targetPath, content, 'utf8');
    emitAction({ action: 'updated', path: targetPath, kind, id: slug, vaultDir });
    return;
  }

  // File does not exist — create
  const content = generator(entry, slug);
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

  // Derive repo once per session so V1+V2 frontmatter both carry it (issue #343).
  // We derive it BEFORE the quality gate so the gate can call the generator once
  // (rendered output is reused below to avoid double-rendering).
  const repo = deriveRepo();

  // Quality gate (PRD F1.2): skip sessions whose rendered narrative is too short.
  // Measure on the rendered markdown body so the check is schema-agnostic across
  // v1 and v2 producers. The render is cheap and idempotent; we reuse the result
  // below instead of calling generator() a second time.
  // Runs BEFORE the --force branch so --force does NOT bypass the quality filter.
  // If the generator throws a `vault-mirror: …` validation error (missing
  // required field), it propagates up to vault-mirror.mjs which classifies it
  // as `skipped-invalid` rather than `skipped-quality-low` — semantically more
  // accurate for the metrics summary in session-end Phase 3.7.
  const renderedBody = generator(entry, { repo });
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

  // #660: namespace new writes under a per-repo subdirectory.
  // repoNs uses the sanitised, leak-guarded segment from namespace.mjs.
  // Keep the existing `repo` value (deriveRepo()) for frontmatter unchanged —
  // repoNs is ONLY used for the write path, not for the rendered content.
  const repoNs = resolveRepoNamespace({ vaultName: ctx?.vaultName ?? null });
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
