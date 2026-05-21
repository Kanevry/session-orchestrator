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
import { detectLearningSchema, generateLearningNote, generateLearningNoteV2 } from './render-learnings.mjs';
import { detectSessionSchema, generateSessionNote, generateSessionNoteV2 } from './render-sessions.mjs';

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
 * @param {string} action — action name (e.g. 'created', 'updated', 'skipped-quality-low')
 * @param {string|null} filePath — absolute path to the file (or null when no file
 *   was created/touched, e.g. for quality-gate skips before any write)
 * @param {string} fileKind — 'learning' or 'session'
 * @param {string|null} id — entry id
 * @param {string} vaultDir — vault root (used to relativise filePath)
 * @param {object} [meta] — optional extra fields merged into the emitted JSON
 *   (used for quality-gate skips to carry a `reason` field). Backward-compatible:
 *   callers that omit `meta` get the original JSON shape unchanged.
 */
export function emitAction(action, filePath, fileKind, id, vaultDir, meta) {
  let rel;
  if (filePath === null || filePath === undefined) {
    rel = null;
  } else {
    const resolvedVaultDir = resolve(vaultDir);
    rel = filePath.startsWith(resolvedVaultDir)
      ? filePath.slice(resolvedVaultDir.length + 1)
      : filePath;
  }
  const payload = { action, path: rel, kind: fileKind, id };
  if (meta && typeof meta === 'object') {
    Object.assign(payload, meta);
  }
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// ── Core processing ───────────────────────────────────────────────────────────

export async function processLearning(entry, _lineNum, ctx) {
  const {
    vaultDir,
    dryRun,
    kind,
    force = false,
    qualityMinConfidence = 0.5,
    qualityMinNarrativeChars: _qualityMinNarrativeChars = 400, // unused for learnings; kept for ctx symmetry
  } = ctx;
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

  // Generator + date source differ by schema
  const generator = schema === 'v2' ? generateLearningNoteV2 : generateLearningNote;
  const dateSource = schema === 'v2' ? entry.first_seen : entry.created_at;

  // Quality gate (PRD F1.2): skip learnings with confidence below threshold.
  // Runs BEFORE the --force branch so --force does NOT bypass the quality filter.
  // Missing/non-numeric confidence is treated as 1.0 (legacy entries pass).
  const learningConfidence = typeof entry.confidence === 'number' ? entry.confidence : 1.0;
  if (learningConfidence < qualityMinConfidence) {
    emitAction(
      'skipped-quality-low',
      null,
      kind,
      entryId,
      vaultDir,
      { reason: `confidence:${learningConfidence} < min:${qualityMinConfidence}` },
    );
    return;
  }

  const targetDir = join(resolve(vaultDir), '40-learnings');
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  let targetPath = join(targetDir, `${slug}.md`);

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, entryId, vaultDir);
      return;
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      // Different generator — treat as hand-written to be safe
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, entryId, vaultDir);
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
          emitAction('skipped-handwritten', targetPath, kind, entryId, vaultDir);
          return;
        }
        // Check updated advancement
        const entryUpdated = toDate(dateSource);
        if (disambigFm['updated'] && disambigFm['updated'] >= entryUpdated) {
          emitAction('skipped-noop', targetPath, kind, disambigSlug, vaultDir);
          return;
        }
      }

      const content = generator(entry, slug);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction('skipped-collision-resolved', targetPath, kind, slug, vaultDir);
      return;
    }

    // Same id: check if updated would advance (unless --force overrides)
    const entryUpdated = toDate(dateSource);
    if (!force && fm['updated'] && fm['updated'] >= entryUpdated) {
      emitAction('skipped-noop', targetPath, kind, slug, vaultDir);
      return;
    }

    // Overwrite with advanced updated date (or forced re-render)
    const content = generator(entry, slug);
    if (!dryRun) writeFileSync(targetPath, content, 'utf8');
    emitAction('updated', targetPath, kind, slug, vaultDir);
    return;
  }

  // File does not exist — create
  const content = generator(entry, slug);
  if (!dryRun) writeFileSync(targetPath, content, 'utf8');
  emitAction('created', targetPath, kind, slug, vaultDir);
}

export async function processSession(entry, _lineNum, ctx) {
  const {
    vaultDir,
    dryRun,
    kind,
    force = false,
    qualityMinNarrativeChars = 400,
    qualityMinConfidence: _qualityMinConfidence = 0.5, // unused for sessions; kept for ctx symmetry
  } = ctx;
  const { session_id: rawSessionId } = entry;
  const schema = detectSessionSchema(entry);
  const generator = schema === 'v2' ? generateSessionNoteV2 : generateSessionNote;

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
    emitAction(
      'skipped-quality-low',
      null,
      kind,
      session_id,
      vaultDir,
      { reason: `narrative:${narrativeChars} < min:${qualityMinNarrativeChars}` },
    );
    return;
  }

  const targetDir = join(resolve(vaultDir), '50-sessions');
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

  // Canonical filename pattern (issue #343): `<session_id>.md` where session_id
  // follows `<branch>-<YYYY-MM-DD>-<HHmm>-<slug>` per the session-id schema.
  // session_id has been validated/sanitised above (isValidSlug → subjectToSlug
  // → uuid fallback). Historical filename inconsistencies in 50-sessions/ are
  // pre-existing on-disk artefacts and are NOT retroactively renamed here.
  const targetPath = join(targetDir, `${session_id}.md`);

  if (existsSync(targetPath)) {
    const existingContent = readFileSync(targetPath, 'utf8');
    const fm = parseFrontmatter(existingContent);

    if (!fm || !fm['_generator']) {
      // Hand-written: skip
      process.stderr.write(`SKIP hand-written: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, session_id, vaultDir);
      return;
    }

    if (fm['_generator'] !== GENERATOR_MARKER) {
      process.stderr.write(`SKIP unknown generator: ${targetPath}\n`);
      emitAction('skipped-handwritten', targetPath, kind, session_id, vaultDir);
      return;
    }

    // Same generator: check id and updated
    if (fm['id'] === session_id) {
      const entryUpdated = toDate(entry.completed_at);
      if (!force && fm['updated'] && fm['updated'] >= entryUpdated) {
        emitAction('skipped-noop', targetPath, kind, session_id, vaultDir);
        return;
      }
      if (!dryRun) writeFileSync(targetPath, renderedBody, 'utf8');
      emitAction('updated', targetPath, kind, session_id, vaultDir);
      return;
    }
  }

  // File does not exist — create. Reuse the rendered body computed during the
  // quality-gate check (avoids a second generator invocation).
  if (!dryRun) writeFileSync(targetPath, renderedBody, 'utf8');
  emitAction('created', targetPath, kind, session_id, vaultDir);
}
