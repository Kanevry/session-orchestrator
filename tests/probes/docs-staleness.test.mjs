/**
 * tests/probes/docs-staleness.test.mjs
 *
 * Behavioral tests for skills/discovery/probes/docs-staleness.mjs.
 * Uses tmpdir-based isolation — never touches the host repo.
 *
 * Learning (conf 0.85): no hardcoded absolute-date fixtures — mtimes are set
 * via relative offsets (utimesSync with Date.now() - N days).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// Passthrough factory so vi.spyOn(fs, 'statSync') below can override the SUT's
// named `statSync` import via the shared ES-module namespace object (mirrors
// tests/lib/path-utils.test.mjs's vi.spyOn(fs, 'realpathSync') pattern).
// A REAL broken symlink was verified NOT to exercise the catch branch this
// test targets: Node's `Dirent.isFile()` returns false for a symlink dirent
// (broken or not) — see docs-staleness.mjs's `listMarkdownFiles()` filter
// (`e.isFile() && e.name.endsWith('.md')`), which excludes symlinks from
// scanning entirely before statSync is ever reached. Mocking statSync directly
// is the only way to exercise the per-file "cannot stat" catch branch.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual('node:fs');
  return { ...actual };
});

import { runProbe } from '../../skills/discovery/probes/docs-staleness.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'docs-staleness-'));
}

/** Write a markdown doc at root-relative `relPath` (e.g. "docs/guide.md"). */
function writeDoc(root, relPath, content = '# doc\n') {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, 'utf8');
  return full;
}

/** Set a file's mtime (and atime) to N days before now — relative, never absolute. */
function setMtimeDaysAgo(filePath, days) {
  const target = new Date(Date.now() - days * 86_400_000);
  utimesSync(filePath, target, target);
}

// ---------------------------------------------------------------------------
// Tmpdir cleanup
// ---------------------------------------------------------------------------

let dirs = [];

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  dirs = [];
});

function tmp() {
  const d = makeTmp();
  dirs.push(d);
  return d;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('docs-staleness probe', () => {
  describe('skip paths', () => {
    it('returns skipped_reason when docs/ directory is missing', async () => {
      const root = tmp();
      const result = await runProbe(root, {});

      expect(result.skipped_reason).toContain('docs/ directory not found');
      expect(result.findings).toEqual([]);
      expect(result.metrics.scanned_docs).toBe(0);
    });

    it('does not write JSONL when docs/ is missing', async () => {
      const root = tmp();
      await runProbe(root, {});
      expect(existsSync(join(root, '.orchestrator/metrics/docs-staleness.jsonl'))).toBe(false);
    });
  });

  describe('happy path', () => {
    it('returns zero findings for a freshly-written doc', async () => {
      const root = tmp();
      writeDoc(root, 'docs/README.md');

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(0);
      expect(result.metrics.scanned_docs).toBe(1);
      expect(result.metrics.stale_docs).toBe(0);
    });
  });

  describe('severity escalation — default 90d threshold', () => {
    it('produces low severity at 100 days (within 2x threshold)', async () => {
      const root = tmp();
      const docPath = writeDoc(root, 'docs/guide.md');
      setMtimeDaysAgo(docPath, 100);

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('low');
      expect(result.metrics.stale_docs).toBe(1);
    });

    it('produces medium severity at 200 days (beyond 2x but within 3x)', async () => {
      const root = tmp();
      const docPath = writeDoc(root, 'docs/guide.md');
      setMtimeDaysAgo(docPath, 200);

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('medium');
    });

    it('produces high severity at 300 days (beyond 3x threshold)', async () => {
      const root = tmp();
      const docPath = writeDoc(root, 'docs/guide.md');
      setMtimeDaysAgo(docPath, 300);

      const result = await runProbe(root, {});

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('high');
    });
  });

  describe('docs/examples scanning', () => {
    it('scans docs/examples/*.md alongside docs/*.md root files', async () => {
      const root = tmp();
      writeDoc(root, 'docs/guide.md'); // fresh
      const examplePath = writeDoc(root, 'docs/examples/sample-config.md');
      setMtimeDaysAgo(examplePath, 100);

      const result = await runProbe(root, {});

      expect(result.metrics.scanned_docs).toBe(2);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence.file).toBe(join('examples', 'sample-config.md'));
    });
  });

  describe('exclusion of adr/ and prd/', () => {
    it('does not scan docs/adr/*.md or docs/prd/*.md', async () => {
      const root = tmp();
      const adrPath = writeDoc(root, 'docs/adr/0001-decision.md');
      setMtimeDaysAgo(adrPath, 500);
      const prdPath = writeDoc(root, 'docs/prd/2026-01-01-feature.md');
      setMtimeDaysAgo(prdPath, 500);

      const result = await runProbe(root, {});

      expect(result.metrics.scanned_docs).toBe(0);
      expect(result.findings).toHaveLength(0);
    });
  });

  describe('config thresholds', () => {
    it('respects a non-default threshold from Session Config', async () => {
      const root = tmp();
      const docPath = writeDoc(root, 'docs/guide.md');
      setMtimeDaysAgo(docPath, 15);

      const resultDefault = await runProbe(root, {});
      expect(resultDefault.findings).toHaveLength(0); // 15d < 90d default

      const resultCustom = await runProbe(root, {
        'docs-staleness': { enabled: true, thresholds: { living: 10 } },
      });
      expect(resultCustom.findings).toHaveLength(1);
      expect(resultCustom.findings[0].evidence.threshold_days).toBe(10);
    });

    it('falls back to the default threshold on a non-positive configured value', async () => {
      const root = tmp();
      const docPath = writeDoc(root, 'docs/guide.md');
      setMtimeDaysAgo(docPath, 100);

      const result = await runProbe(root, {
        'docs-staleness': { enabled: true, thresholds: { living: -5 } },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence.threshold_days).toBe(90);
    });
  });

  describe('JSONL output', () => {
    it('appends a valid JSONL record after a non-skipped scan', async () => {
      const root = tmp();
      const docPath = writeDoc(root, 'docs/guide.md');
      setMtimeDaysAgo(docPath, 100);

      await runProbe(root, {});

      const jsonlPath = join(root, '.orchestrator/metrics/docs-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);

      const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').at(-1));

      expect(record.probe).toBe('docs-staleness');
      expect(record.project_root).toBe(root);
      expect(typeof record.timestamp).toBe('string');
      expect(record.scanned_docs).toBe(1);
      expect(record.stale_docs).toBe(1);
      expect(record.errors).toBe(0);
      expect(typeof record.duration_ms).toBe('number');

      expect(record.findings).toHaveLength(1);
      expect(record.findings[0].file).toBe('guide.md');
      expect(typeof record.findings[0].age_days).toBe('number');
      expect(record.findings[0].threshold_days).toBe(90);
    });

    it('still writes JSONL with zero findings when all docs are fresh', async () => {
      const root = tmp();
      writeDoc(root, 'docs/guide.md');

      await runProbe(root, {});

      const jsonlPath = join(root, '.orchestrator/metrics/docs-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);
      const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').at(-1));
      expect(record.stale_docs).toBe(0);
      expect(record.findings).toHaveLength(0);
    });
  });

  describe('no-throw discipline', () => {
    it('returns an object and does not throw when given a completely invalid root path', async () => {
      const result = await runProbe('/dev/null/not-a-dir', {});

      expect(result).toBeTruthy();
      expect(typeof result).toBe('object');
      expect(result.findings).toBeDefined();
      expect(result.metrics).toBeDefined();
    });
  });

  describe('duration_ms', () => {
    it('returns a non-negative duration_ms', async () => {
      const root = tmp();
      mkdirSync(join(root, 'docs'), { recursive: true });

      const result = await runProbe(root, {});

      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });

  describe('per-file statSync error path (qa finding: untested "cannot stat" branch)', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('counts a statSync failure as an error and emits a "cannot stat" finding', async () => {
      const root = tmp();
      writeDoc(root, 'docs/unreadable.md');

      vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
        throw new Error('ENOENT: no such file or directory, stat');
      });

      const result = await runProbe(root, {});

      expect(result.metrics.errors).toBe(1);
      expect(result.metrics.scanned_docs).toBe(1);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].title).toContain('cannot stat');
      expect(result.findings[0].severity).toBe('low');
    });
  });
});
