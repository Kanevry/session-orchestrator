import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectLearningsFromFile } from '@lib/learnings/select.mjs';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal();
  return { ...fs, readFile: vi.fn(fs.readFile), open: vi.fn(fs.open) };
});
const fs = await vi.importActual('node:fs/promises');
const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
const query = 'Inspect the adapter';
const record = {
  id: 'synthetic-current-record', type: 'proven-pattern', subject: 'adapter',
  insight: 'Original snapshot.', evidence: 'Synthetic contract probe.',
  confidence: 0.7, source_session: 'synthetic-session', schema_version: 1,
  created_at: '2026-10-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z',
  scope: 'local', host_class: null, anonymized: false, file_paths: ['src/adapter.mjs'],
};
const original = `${JSON.stringify(record)}\n`;
const updated = `${JSON.stringify({ ...record, insight: 'Updated snapshot.', confidence: 0.9 })}\n`;
let root;
let source;

beforeEach(() => {
  vi.mocked(readFile).mockReset().mockImplementation(fs.readFile);
  vi.mocked(open).mockReset().mockImplementation(fs.open);
  root = mkdtempSync(join(tmpdir(), 'candidate-source-read-'));
  source = join(root, 'learnings.jsonl');
  writeFileSync(source, original);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

it('does no provider file I/O and preserves the return shape without explicit opt-in', async () => {
  const selection = await selectLearningsFromFile(source, { file_paths: ['src/adapter.mjs'], text: query });
  expect(selection.entries.map((entry) => entry.id)).toEqual([record.id]);
  expect(selection).not.toHaveProperty('evidence');
  expect(open).not.toHaveBeenCalled();
  expect(readFile).toHaveBeenCalledTimes(1);
});

function writeArtifact(sourceBytes) {
  const generation = hash(sourceBytes);
  const artifactPath = join(root, 'candidates.json');
  writeFileSync(artifactPath, JSON.stringify({
    schema_version: 1, status: 'ok',
    query: { text: query, source_repos: ['example-repo'], audience: 'private', evidence_types: ['learning'] },
    freshness: { mode: 'live_sources', checked_at: '2026-10-19T00:00:00Z' },
    generation, source_generations: { 'example-repo': generation },
    retrieval: { requested: 'bm25', effective: 'bm25' },
    candidates: [{
      evidence_type: 'learning', source_repo: 'example-repo', source_record_id: record.id,
      source_generation: generation, source_path: 'learnings.jsonl', source_sha256: generation,
      source_revision: 'synthetic', line_start: 1, line_end: 1,
      index_generation: generation, modelspace: generation, rank: 1,
    }],
  }));
  return artifactPath;
}

it('uses one source snapshot rather than validating a newer record while emitting the older baseline object', async () => {
  const artifactPath = writeArtifact(Buffer.from(updated));
  // The old two-read implementation sees the new artifact generation only on
  // its second read, then keeps the old baseline object because the ID matches.
  vi.mocked(readFile).mockResolvedValueOnce(Buffer.from(original)).mockResolvedValueOnce(Buffer.from(updated));
  const selection = await selectLearningsFromFile(source, { file_paths: ['src/adapter.mjs'], text: query }, {
    evidenceCandidates: artifactPath, sourceRepo: 'example-repo',
  });
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(selection.evidence).toMatchObject({ status: 'stale', accepted: 0 });
  expect(selection.entries[0].insight).toBe(record.insight);
});

it('rejects invalid UTF-8 even when replacement decoding aliases the original source hash', async () => {
  const originalBytes = Buffer.from(`${JSON.stringify({ ...record, insight: 'Replacement \uFFFD marker.' })}\n`);
  const marker = originalBytes.indexOf(Buffer.from('\uFFFD'));
  const corruptedBytes = Buffer.concat([
    originalBytes.subarray(0, marker), Buffer.from([0xff]), originalBytes.subarray(marker + 3),
  ]);
  expect(hash(corruptedBytes)).not.toBe(hash(originalBytes));
  expect(hash(corruptedBytes.toString('utf8'))).toBe(hash(originalBytes));
  writeFileSync(source, corruptedBytes);
  const selection = await selectLearningsFromFile(source, { file_paths: ['src/adapter.mjs'], text: query }, {
    evidenceCandidates: writeArtifact(originalBytes), sourceRepo: 'example-repo', poolSize: 0,
  });
  expect(selection.evidence).toMatchObject({ status: 'corrupt', reason: 'source_utf8_invalid', accepted: 0 });
  expect(selection.entries).toEqual([]);
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(readFile).toHaveBeenCalledWith(source);
});

it.each([
  ['BOM and CRLF', '\uFEFF', '\r\n'],
  ['CRLF', '', '\r\n'],
  ['BOM and LF', '\uFEFF', '\n'],
])('preserves exact source bytes while accepting valid UTF-8 with %s', async (_label, prefix, newline) => {
  const bytes = Buffer.from(`${prefix}${JSON.stringify(record)}${newline}`);
  writeFileSync(source, bytes);
  const selection = await selectLearningsFromFile(source, { file_paths: ['src/adapter.mjs'], text: query }, {
    evidenceCandidates: writeArtifact(bytes), sourceRepo: 'example-repo', poolSize: 0,
  });
  expect(selection.evidence).toMatchObject({ status: 'ok', accepted: 1 });
  expect(selection.entries.map((entry) => entry.id)).toEqual([record.id]);
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(readFile).toHaveBeenCalledWith(source);
});
