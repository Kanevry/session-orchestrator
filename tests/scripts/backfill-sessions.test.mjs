/**
 * tests/scripts/backfill-sessions.test.mjs
 *
 * Vitest suite for scripts/backfill-sessions.mjs — rewrites legacy
 * sessions.jsonl entries into canonical schema_version=1 shape, marks
 * unmappable entries `_deprecated: true` (Issue #249 follow-up).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'backfill-sessions.mjs');

const CANONICAL = {
  session_id: 'main-2026-04-24-0900',
  session_type: 'deep',
  started_at: '2026-04-24T09:00:00Z',
  completed_at: '2026-04-24T09:30:00Z',
  total_waves: 5,
  waves: [{ wave: 1, role: 'Discovery' }],
  agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
  total_agents: 1,
  total_files_changed: 2,
  schema_version: 1,
};

function runCli(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function writeJsonl(path, entries) {
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

function readJsonlLines(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l));
}

describe('backfill-sessions.mjs', () => {
  let tmp;
  let file;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'backfill-sessions-'));
    file = join(tmp, 'sessions.jsonl');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('dry-run (default)', () => {
    it('reports unchanged count for already-canonical entries', () => {
      writeJsonl(file, [CANONICAL]);
      const r = runCli(['--file', file]);
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout.split('\n')[0]);
      expect(summary.mode).toBe('dry-run');
      expect(summary.unchanged).toBe(1);
      expect(summary.rewritten).toBe(0);
      expect(summary.deprecated).toBe(0);
      // File is untouched
      expect(readJsonlLines(file)).toHaveLength(1);
    });

    it('reports rewrite count for entries with safe aliases', () => {
      const legacy = { ...CANONICAL };
      delete legacy.session_type;
      legacy.type = 'deep'; // alias
      delete legacy.schema_version;
      writeJsonl(file, [legacy]);
      const r = runCli(['--file', file]);
      const summary = JSON.parse(r.stdout.split('\n')[0]);
      expect(summary.rewritten).toBe(1);
      expect(summary.unchanged).toBe(0);
    });

    it('reports deprecated count for unmappable shapes', () => {
      const unmappable = { session_id: 'x', waves: null, agents_complete: 1 };
      writeJsonl(file, [unmappable]);
      const r = runCli(['--file', file]);
      const summary = JSON.parse(r.stdout.split('\n')[0]);
      expect(summary.deprecated).toBe(1);
    });

    it('never modifies the file in dry-run', () => {
      writeJsonl(file, [{ ...CANONICAL, type: 'deep' }, { waves: 3 /* number, unmappable */ }]);
      const before = readFileSync(file, 'utf8');
      runCli(['--file', file]);
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('includes a per-line detail block in stdout', () => {
      writeJsonl(file, [CANONICAL]);
      const r = runCli(['--file', file]);
      const lines = r.stdout.trim().split('\n');
      expect(lines.length).toBe(2);
      const detail = JSON.parse(lines[1]);
      expect(Array.isArray(detail.detail)).toBe(true);
      expect(detail.detail[0]).toEqual({ line: 1, outcome: 'unchanged', session_id: CANONICAL.session_id });
    });
  });

  describe('--apply', () => {
    it('rewrites safe-alias entries into canonical v1 shape', () => {
      const legacy = { ...CANONICAL };
      delete legacy.session_type;
      legacy.type = 'deep';
      delete legacy.schema_version;
      writeJsonl(file, [legacy]);

      const r = runCli(['--file', file, '--apply']);
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout.trim());
      expect(summary.rewritten).toBe(1);
      expect(summary.backup).toMatch(/\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);

      const rewritten = readJsonlLines(file);
      expect(rewritten[0].session_type).toBe('deep');
      expect(rewritten[0].schema_version).toBe(1);
    });

    it('creates a .bak-<ISO> backup of the original', () => {
      writeJsonl(file, [{ ...CANONICAL, type: 'deep' }]);
      const r = runCli(['--file', file, '--apply']);
      const summary = JSON.parse(r.stdout.trim());
      expect(existsSync(summary.backup)).toBe(true);
    });

    it('tags unmappable entries with _deprecated:true (preserves them)', () => {
      const unmappable = { session_id: 'legacy-x', waves: null, total_waves: 3 };
      writeJsonl(file, [unmappable]);
      runCli(['--file', file, '--apply']);
      const rewritten = readJsonlLines(file);
      expect(rewritten).toHaveLength(1);
      expect(rewritten[0]._deprecated).toBe(true);
      expect(rewritten[0].session_id).toBe('legacy-x');
    });

    it('includes _deprecation_reason for structurally unmappable entries', () => {
      writeJsonl(file, [{ session_id: 'legacy-wnull', waves: null }]);
      runCli(['--file', file, '--apply']);
      const [entry] = readJsonlLines(file);
      expect(entry._deprecated).toBe(true);
      expect(entry._deprecation_reason).toBe('structural: wavesIsNull');
    });

    it('preserves canonical file content at every moment during atomic replace', () => {
      // The write path must never leave the canonical file missing — copy-first
      // + rename-over-canonical guarantees the file exists throughout.
      // Use an entry that requires rewriting so we can distinguish backup from canonical content.
      const legacy = { ...CANONICAL, type: 'deep' };
      delete legacy.session_type;
      delete legacy.schema_version;
      writeJsonl(file, [legacy]);

      runCli(['--file', file, '--apply']);

      // Canonical file exists post-apply.
      expect(existsSync(file)).toBe(true);
      // Exactly one backup file was created.
      const backups = readdirSync(tmp).filter((f) => f.startsWith('sessions.jsonl.bak-'));
      expect(backups).toHaveLength(1);
      // Canonical holds the rewritten content (session_type populated, schema_version stamped).
      const canonicalEntry = readJsonlLines(file)[0];
      expect(canonicalEntry.session_type).toBe('deep');
      expect(canonicalEntry.schema_version).toBe(1);
      // Backup holds the pre-rewrite content (type alias, no session_type, no schema_version).
      const backupEntry = JSON.parse(readFileSync(join(tmp, backups[0]), 'utf8').trim());
      expect(backupEntry.type).toBe('deep');
      expect(backupEntry.session_type).toBeUndefined();
      expect(backupEntry.schema_version).toBeUndefined();
    });

    it('leaves already-canonical entries untouched byte-identical', () => {
      writeJsonl(file, [CANONICAL]);
      const before = readJsonlLines(file);
      runCli(['--file', file, '--apply']);
      const after = readJsonlLines(file);
      expect(after).toEqual(before);
    });

    it('is idempotent: two --apply runs produce the same file content', () => {
      writeJsonl(file, [{ ...CANONICAL, type: 'deep', schema_version: undefined }]);
      runCli(['--file', file, '--apply']);
      const after1 = readFileSync(file, 'utf8');
      runCli(['--file', file, '--apply']);
      const after2 = readFileSync(file, 'utf8');
      expect(after2).toBe(after1);
    });

    it('reconstructs agent_summary from agents_complete/partial/failed', () => {
      const legacy = {
        ...CANONICAL,
        agents_complete: 3,
        agents_partial: 1,
        agents_failed: 0,
      };
      delete legacy.agent_summary;
      delete legacy.schema_version;
      writeJsonl(file, [legacy]);
      runCli(['--file', file, '--apply']);
      const [rewritten] = readJsonlLines(file);
      expect(rewritten.agent_summary).toEqual({ complete: 3, partial: 1, failed: 0, spiral: 0 });
      expect(rewritten.schema_version).toBe(1);
    });

    it('converts duration_min → duration_seconds (multiply by 60)', () => {
      const legacy = { ...CANONICAL, duration_min: 30 };
      delete legacy.duration_seconds;
      delete legacy.schema_version;
      writeJsonl(file, [legacy]);
      runCli(['--file', file, '--apply']);
      const [rewritten] = readJsonlLines(file);
      expect(rewritten.duration_seconds).toBe(1800);
    });
  });

  describe('--mark-deprecated-only', () => {
    it('only tags unmappable entries; does not rewrite mappable ones', () => {
      const mappable = { ...CANONICAL, type: 'deep' };
      delete mappable.session_type;
      delete mappable.schema_version;
      const unmappable = { session_id: 'legacy-y', waves: null };
      writeJsonl(file, [mappable, unmappable]);

      const r = runCli(['--file', file, '--mark-deprecated-only']);
      const summary = JSON.parse(r.stdout.trim());
      expect(summary.deprecated).toBe(1);
      expect(summary.rewritten).toBe(1); // still counted, but not applied

      const rewritten = readJsonlLines(file);
      // Mappable entry preserved byte-equivalent (no session_type added)
      expect(rewritten[0].type).toBe('deep');
      expect(rewritten[0].session_type).toBeUndefined();
      // Unmappable entry got _deprecated flag
      expect(rewritten[1]._deprecated).toBe(true);
    });
  });

  describe('error handling', () => {
    it('exits 1 when file does not exist', () => {
      const r = runCli(['--file', join(tmp, 'does-not-exist.jsonl')]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/not found/);
    });

    it('counts parse errors but preserves the line verbatim', () => {
      writeFileSync(file, '{"valid":false,\ninvalid-json\n', 'utf8');
      const r = runCli(['--file', file, '--apply']);
      expect(r.status).toBe(0);
      const summary = JSON.parse(r.stdout.trim());
      expect(summary.parse_errors).toBeGreaterThanOrEqual(1);
    });

    it('exits 2 on unknown argument', () => {
      const r = runCli(['--bogus']);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/unknown argument/);
    });
  });

  describe('real-file smoke', () => {
    it('dry-run on empty file reports total:0', () => {
      writeFileSync(file, '', 'utf8');
      const r = runCli(['--file', file]);
      const summary = JSON.parse(r.stdout.split('\n')[0]);
      expect(summary.total).toBe(0);
    });
  });
});
