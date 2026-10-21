/**
 * Explicit, private-audience candidate artifacts are advisory lookup hints.
 * Only current local JSONL records enter the selector; artifact paths, scores
 * and text never become records, executable commands or additional authority.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { z } from 'zod';

import { parseLearningsText } from './io.mjs';
import { digestMultiBufferSha256 } from '../crypto-digest-utils.mjs';

// At most 40 hints in a small local artifact. Revisit the byte ceiling only if
// a valid 40-candidate producer payload demonstrably exceeds it.
export const EVIDENCE_ARTIFACT_MAX_BYTES = 128 * 1024;

const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const repo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/);
const evidenceType = z.enum(['learning', 'skill', 'adr']);
const retrievalMode = z.enum(['bm25', 'eg2', 'rrf']);
const unique = (values) => new Set(values).size === values.length;
const candidate = z.object({
  evidence_type: evidenceType,
  source_repo: repo,
  source_record_id: z.string().min(1).max(200).optional(),
  source_generation: hash.optional(),
  source_path: z.string().min(1).regex(/^(?!\/)(?![A-Za-z]:)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\).+$/),
  source_sha256: hash,
  source_revision: z.string().min(1).max(64),
  line_start: z.number().int().min(1),
  line_end: z.number().int().min(1),
  index_generation: hash,
  modelspace: hash,
  rank: z.number().int().min(1).max(40),
}).strict().refine((value) => value.evidence_type === 'learning'
  ? value.source_record_id !== undefined && value.source_generation !== undefined
  : value.source_record_id === undefined && value.source_generation === undefined);

/** Local boundary for urn:local-evidence:candidate-artifact:1. */
export const evidenceCandidateSchema = z.object({
  schema_version: z.literal(1),
  status: z.enum(['ok', 'empty', 'disabled', 'stale', 'unavailable', 'unreadable', 'corrupt', 'modelspace_mismatch', 'error']),
  query: z.object({
    text: z.string().min(1).max(4000),
    source_repos: z.array(repo).min(1).refine(unique),
    audience: z.literal('private'),
    evidence_types: z.array(evidenceType).min(1).refine(unique),
  }).strict(),
  freshness: z.object({
    mode: z.literal('live_sources'),
    checked_at: z.string().datetime({ offset: true }),
  }).strict(),
  generation: hash.nullable(),
  source_generations: z.record(repo, hash),
  retrieval: z.object({
    requested: retrievalMode,
    effective: retrievalMode,
    fallback_reason: z.enum(['semantic_unconfigured', 'semantic_unavailable', 'semantic_failed', 'modelspace_mismatch', 'index_lexical_only']).optional(),
  }).strict(),
  candidates: z.array(candidate).max(40),
}).strict().refine((value) => value.status === 'ok' || value.candidates.length === 0);

/** Bounded regular-file read; a supplied FIFO must not hang a dispatch. */
async function readArtifact(filePath) {
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > EVIDENCE_ARTIFACT_MAX_BYTES) throw new Error('invalid-artifact-file');
    const buffer = Buffer.alloc(EVIDENCE_ARTIFACT_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > EVIDENCE_ARTIFACT_MAX_BYTES) throw new Error('artifact-too-large');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally {
    await handle.close();
  }
}

/**
 * Resolve hints against the explicitly supplied current repo's canonical store.
 * Missing/stale/corrupt inputs return no additions, preserving the baseline.
 * Diagnostics contain only statuses/counts, never artifact paths or query text.
 */
export async function readEvidenceCandidates({ artifactPath, sourceRepo, query, sourceBytes }) {
  const result = (status, reason, entries = [], dropped = 0, retrieval) => ({
    entries,
    diagnostics: { status, ...(reason ? { reason } : {}), accepted: entries.length, dropped,
      ...(retrieval ? { retrieval } : {}) },
  });
  if (!repo.safeParse(sourceRepo).success || typeof query !== 'string' || !query.trim() ||
      query.length > 4000 || typeof artifactPath !== 'string' || !artifactPath) {
    return result('corrupt', 'invalid_request');
  }
  let artifact;
  try {
    const parsed = evidenceCandidateSchema.safeParse(await readArtifact(artifactPath));
    if (!parsed.success) return result('corrupt', 'invalid_artifact');
    artifact = parsed.data;
  } catch (error) {
    if (error instanceof SyntaxError) return result('corrupt', 'invalid_artifact');
    return result(error?.code === 'ENOENT' ? 'unavailable' : 'unreadable', 'artifact_read_failed');
  }
  if (artifact.query.text !== query || artifact.query.source_repos.length !== 1 ||
      artifact.query.source_repos[0] !== sourceRepo) return result('corrupt', 'request_mismatch');
  if (artifact.status !== 'ok') return result(artifact.status, 'provider_status', [], 0, artifact.retrieval);
  if (artifact.generation === null) return result('corrupt', 'missing_generation');

  // One source read supplies BOTH the baseline pool and these original records.
  // A missing store is distinct from an existing, valid empty JSONL snapshot.
  if (!Buffer.isBuffer(sourceBytes)) return result('unavailable', 'source_read_failed');
  let sourceText;
  try {
    // ignoreBOM retains the BOM in the decoded text; the canonical parser
    // removes it only from the first record, never from the generation hash.
    sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceBytes);
  } catch {
    return result('corrupt', 'source_utf8_invalid');
  }
  const snapshot = {
    ...parseLearningsText(sourceText),
    generation: `sha256:${digestMultiBufferSha256([sourceBytes])}`,
  };
  if (artifact.source_generations[sourceRepo] !== snapshot.generation) {
    return result('stale', 'source_generation_mismatch');
  }

  const byId = new Map();
  for (const entry of snapshot.entries) {
    if (typeof entry.id !== 'string') continue;
    // An ambiguous duplicate ID cannot identify one original record.
    byId.set(entry.id, byId.has(entry.id) ? null : entry);
  }
  const entries = [];
  const seen = new Set();
  let dropped = 0;
  for (const hint of artifact.candidates) {
    const entry = byId.get(hint.source_record_id);
    if (hint.evidence_type !== 'learning' || !artifact.query.evidence_types.includes('learning') ||
        hint.source_repo !== sourceRepo || hint.source_generation !== snapshot.generation ||
        hint.source_sha256 !== snapshot.generation || hint.index_generation !== artifact.generation ||
        hint.line_end < hint.line_start || !entry || seen.has(hint.source_record_id)) {
      dropped++;
      continue;
    }
    seen.add(hint.source_record_id);
    entries.push(entry);
  }
  return result('ok', undefined, entries, dropped, artifact.retrieval);
}
