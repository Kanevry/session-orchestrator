/**
 * process.mjs — Core entry processors for vault-mirror (Issue #283 split).
 *
 * Exports: processLearning, processSession
 * Both functions write to the vault dir and emit JSON action lines to stdout.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { subjectToSlug, isValidSlug, uuidPrefix8, toDate, parseFrontmatter } from './utils.mjs';
import { detectLearningSchema, generateLearningNote, generateLearningNoteV2 } from './render-learnings.mjs';
import { detectSessionSchema, generateSessionNote, generateSessionNoteV2 } from './render-sessions.mjs';

const GENERATOR_MARKER = 'session-orchestrator-vault-mirror@1';

// ── Action output ─────────────────────────────────────────────────────────────

export function emitAction(action, filePath, fileKind, id, vaultDir) {
  const resolvedVaultDir = resolve(vaultDir);
  const rel = filePath.startsWith(resolvedVaultDir)
    ? filePath.slice(resolvedVaultDir.length + 1)
    : filePath;
  process.stdout.write(
    JSON.stringify({ action, path: rel, kind: fileKind, id }) + '\n',
  );
}

// ── Core processing ───────────────────────────────────────────────────────────

export async function processLearning(entry, _lineNum, { vaultDir, dryRun, kind }) {
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

    // Same id: check if updated would advance
    const entryUpdated = toDate(dateSource);
    if (fm['updated'] && fm['updated'] >= entryUpdated) {
      emitAction('skipped-noop', targetPath, kind, slug, vaultDir);
      return;
    }

    // Overwrite with advanced updated date
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

export async function processSession(entry, _lineNum, { vaultDir, dryRun, kind }) {
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

  const targetDir = join(resolve(vaultDir), '50-sessions');
  if (!dryRun) mkdirSync(targetDir, { recursive: true });

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
      if (fm['updated'] && fm['updated'] >= entryUpdated) {
        emitAction('skipped-noop', targetPath, kind, session_id, vaultDir);
        return;
      }
      const content = generator(entry);
      if (!dryRun) writeFileSync(targetPath, content, 'utf8');
      emitAction('updated', targetPath, kind, session_id, vaultDir);
      return;
    }
  }

  // File does not exist — create
  const content = generator(entry);
  if (!dryRun) writeFileSync(targetPath, content, 'utf8');
  emitAction('created', targetPath, kind, session_id, vaultDir);
}
