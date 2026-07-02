/**
 * tests/scripts/backfill-learnings.test.mjs
 *
 * Vitest suite for scripts/backfill-learnings.mjs — Epic #723 B2 dialect
 * backfill for learnings.jsonl. Verifies:
 *   - dry-run (default) computes counts and mutates NOTHING
 *   - --apply rewrites atomically with a .bak-<ISO> backup
 *   - files→file_paths + schema_version:1 stamping land in the written file
 *   - parse-error lines survive byte-identical
 *   - records still invalid after migration are passed through byte-identical
 *   - summary counts are exact
 *   - error/edge handling (unknown arg, missing file, empty file)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'backfill-learnings.mjs');

// R1 — normalizes: legacy `files`, no-millis timestamps, missing schema_version.
const R1 = {
  id: 'r1',
  type: 'anti-pattern',
  subject: 's1',
  insight: 'i1',
  evidence: 'e1',
  confidence: 0.5,
  source_session: 'main-2026-04-19-0900',
  created_at: '2026-04-19T00:00:00Z',
  expires_at: '2026-05-19T00:00:00Z',
  files: ['scripts/a.mjs'],
};

// R2 — already canonical (schema_version:1, millis timestamps, no dialects).
const R2 = {
  id: 'r2',
  type: 'anti-pattern',
  subject: 's2',
  insight: 'i2',
  evidence: 'e2',
  confidence: 0.5,
  source_session: 'main-2026-04-19-1000',
  created_at: '2026-04-19T00:00:00.000Z',
  expires_at: '2026-05-19T00:00:00.000Z',
  schema_version: 1,
};

// R3 — a genuinely un-parseable line (kept verbatim).
const R3_RAW = '{ this is not valid json';

// R4 — invalid even after migration (confidence>1 + missing subject) AND carries
// a dialect key, to prove invalid records are passed through UNMUTATED.
const R4 = { id: 'r4', type: 'anti-pattern', confidence: 5, files: ['scripts/z.mjs'] };

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeFixture(path) {
  const body =
    [JSON.stringify(R1), JSON.stringify(R2), R3_RAW, JSON.stringify(R4)].join('\n') + '\n';
  writeFileSync(path, body, 'utf8');
}

/** Read raw non-empty lines (tolerant of the intentionally-invalid line). */
function rawLines(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0);
}

describe('backfill-learnings.mjs', () => {
  let tmp;
  let file;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backfill-learnings-'));
    file = join(tmp, 'learnings.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('dry-run (default)', () => {
    it('reports exact counts for the mixed fixture', () => {
      writeFixture(file);
      const r = runCli(['--file', file]);
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout.trim());
      expect(summary).toMatchObject({
        scanned: 4,
        normalized: 1,
        unchanged: 1,
        parse_errors: 1,
        invalid_after_migration: 1,
        applied: false,
        dry_run: true,
        backup: null,
      });
    });

    it('never modifies the file in dry-run', () => {
      writeFixture(file);
      const before = readFileSync(file, 'utf8');
      runCli(['--file', file]);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('creates no backup in dry-run', () => {
      writeFixture(file);
      runCli(['--file', file]);
      const backups = readdirSync(tmp).filter((f) => f.startsWith('learnings.jsonl.bak-'));
      expect(backups).toHaveLength(0);
    });
  });

  describe('--apply', () => {
    it('rewrites files→file_paths and stamps schema_version:1 on R1', () => {
      writeFixture(file);
      const r = runCli(['--file', file, '--apply']);
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout.trim());
      expect(summary.applied).toBe(true);
      expect(summary.backup).toMatch(/learnings\.jsonl\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);

      const lines = rawLines(file);
      const r1 = JSON.parse(lines[0]);
      expect(r1.file_paths).toEqual(['scripts/a.mjs']);
      expect('files' in r1).toBe(false);
      expect(r1.schema_version).toBe(1);
      // Timestamp re-serialized to canonical millis+Z (same instant).
      expect(r1.created_at).toBe('2026-04-19T00:00:00.000Z');
      expect(r1.expires_at).toBe('2026-05-19T00:00:00.000Z');
    });

    it('leaves the already-canonical R2 semantically unchanged', () => {
      writeFixture(file);
      runCli(['--file', file, '--apply']);
      const r2 = JSON.parse(rawLines(file)[1]);
      expect(r2).toEqual(R2);
    });

    it('preserves the un-parseable line byte-identical', () => {
      writeFixture(file);
      runCli(['--file', file, '--apply']);
      expect(rawLines(file)[2]).toBe(R3_RAW);
    });

    it('passes an invalid-after-migration record through UNMUTATED (dialect key kept)', () => {
      writeFixture(file);
      runCli(['--file', file, '--apply']);
      const r4 = JSON.parse(rawLines(file)[3]);
      // No normalization was applied: files NOT renamed, no schema_version stamp.
      expect(r4).toEqual(R4);
      expect('file_paths' in r4).toBe(false);
      expect('schema_version' in r4).toBe(false);
      // Byte-identical pin (analogous to the parse-error assertion above): proves
      // the raw line was passed through verbatim, not re-serialized with a
      // different key order/whitespace that would happen to parse equal.
      expect(rawLines(file)[3]).toBe(JSON.stringify(R4));
    });

    it('creates a .bak-<ISO> backup holding the pre-normalization content', () => {
      writeFixture(file);
      const before = readFileSync(file, 'utf8');
      const r = runCli(['--file', file, '--apply']);
      const summary = JSON.parse(r.stdout.trim());
      expect(existsSync(summary.backup)).toBe(true);
      expect(readFileSync(summary.backup, 'utf8')).toBe(before);
    });

    it('is idempotent — a second --apply produces identical content', () => {
      writeFixture(file);
      runCli(['--file', file, '--apply']);
      const after1 = readFileSync(file, 'utf8');
      runCli(['--file', file, '--apply']);
      const after2 = readFileSync(file, 'utf8');
      expect(after2).toBe(after1);
    });
  });

  describe('error + edge handling', () => {
    it('exits 1 when the file does not exist', () => {
      const r = runCli(['--file', join(tmp, 'nope.jsonl')]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/not found/);
    });

    it('exits 2 on an unknown argument', () => {
      const r = runCli(['--bogus']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/unknown argument/);
    });

    it('reports scanned:0 for an empty file', () => {
      writeFileSync(file, '', 'utf8');
      const r = runCli(['--file', file]);
      const summary = JSON.parse(r.stdout.trim());
      expect(summary.scanned).toBe(0);
      expect(summary.dry_run).toBe(true);
    });
  });
});
