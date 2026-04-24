/**
 * tests/probes/vault-staleness.test.mjs
 *
 * Behavioral tests for skills/discovery/probes/vault-staleness.mjs.
 * Uses tmpdir-based isolation — never touches the host repo.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runProbe } from '../../skills/discovery/probes/vault-staleness.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'vault-staleness-'));
}

/**
 * Create a minimal vault directory structure under root.
 * Returns { vaultDir, projectsDir }.
 */
function makeVault(root) {
  const vaultDir = join(root, 'vault');
  mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
  return { vaultDir, projectsDir: join(vaultDir, '01-projects') };
}

/**
 * Create a project directory with _overview.md containing YAML frontmatter.
 */
function makeProject(projectsDir, slug, frontmatterFields, extraFiles = {}) {
  const projectDir = join(projectsDir, slug);
  mkdirSync(projectDir, { recursive: true });

  const lines = ['---'];
  for (const [k, v] of Object.entries(frontmatterFields)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', '# Project overview', '');
  writeFileSync(join(projectDir, '_overview.md'), lines.join('\n'), 'utf8');

  for (const [name, content] of Object.entries(extraFiles)) {
    writeFileSync(join(projectDir, name), content, 'utf8');
  }
}

/** ISO timestamp N hours ago */
function hoursAgo(n) {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

/** ISO timestamp N days ago */
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

// ---------------------------------------------------------------------------
// Test state — cleaned in afterEach
// ---------------------------------------------------------------------------

let dirs = [];

afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
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

describe('vault-staleness probe', () => {

  describe('skip paths', () => {
    it('returns skipped_reason when vault-dir is not configured', async () => {
      const result = await runProbe('/tmp', {});

      expect(result.skipped_reason).toContain('vault-dir not configured');
      expect(result.findings).toEqual([]);
      expect(result.metrics.scanned_projects).toBe(0);
      expect(result.metrics.stale_count).toBe(0);
      expect(result.metrics.errors).toBe(0);
    });

    it('does not write JSONL when vault-dir is not configured', async () => {
      const root = tmp();
      await runProbe(root, {});

      const jsonlPath = join(root, '.orchestrator/metrics/vault-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(false);
    });

    it('returns skipped_reason when vault-dir does not exist on disk', async () => {
      const result = await runProbe('/tmp', {
        'vault-integration': { 'vault-dir': '/tmp/nonexistent-vault-xyz-99999' },
      });

      expect(result.skipped_reason).toBeTruthy();
      expect(result.findings).toEqual([]);
      expect(result.metrics.scanned_projects).toBe(0);
    });

    it('does not write JSONL when vault-dir does not exist on disk', async () => {
      const root = tmp();
      await runProbe(root, {
        'vault-integration': { 'vault-dir': '/tmp/nonexistent-vault-xyz-99999' },
      });

      const jsonlPath = join(root, '.orchestrator/metrics/vault-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(false);
    });

    it('returns skipped_reason when 01-projects directory is missing from vault', async () => {
      const root = tmp();
      const vaultDir = join(root, 'vault');
      mkdirSync(vaultDir, { recursive: true }); // vault exists but no 01-projects

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.skipped_reason).toContain('01-projects');
      expect(result.findings).toEqual([]);
      expect(result.metrics.scanned_projects).toBe(0);
    });

    it('does not write JSONL when 01-projects directory is missing', async () => {
      const root = tmp();
      const vaultDir = join(root, 'vault');
      mkdirSync(vaultDir, { recursive: true });

      await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      const jsonlPath = join(root, '.orchestrator/metrics/vault-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(false);
    });
  });

  describe('happy paths', () => {
    it('returns empty findings and zero metrics when 01-projects is empty', async () => {
      const root = tmp();
      const { vaultDir } = makeVault(root);

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toEqual([]);
      expect(result.metrics.scanned_projects).toBe(0);
      expect(result.metrics.stale_count).toBe(0);
      expect(result.metrics.errors).toBe(0);
    });

    it('returns no finding for a project synced within the last hour', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'fresh-project', {
        slug: 'fresh-project',
        tier: 'active',
        lastSync: hoursAgo(1),
      });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(0);
      expect(result.metrics.scanned_projects).toBe(1);
      expect(result.metrics.stale_count).toBe(0);
    });
  });

  describe('stale detection', () => {
    it('produces a low-severity finding when lastSync is 36 hours ago', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'old-project', {
        slug: 'old-project',
        tier: 'active',
        lastSync: hoursAgo(36),
      });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('low');
      expect(result.findings[0].title).toContain('old-project');
      expect(result.metrics.stale_count).toBe(1);
    });

    it('produces a medium-severity finding when lastSync is 10 days ago', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'very-old', {
        slug: 'very-old',
        tier: 'top',
        lastSync: daysAgo(10),
      });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('medium');
      expect(result.findings[0].title).toContain('very-old');
      expect(result.metrics.stale_count).toBe(1);
    });

    it('produces a medium-severity finding with confidence 0.8 when lastSync is missing from frontmatter', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'no-sync', {
        slug: 'no-sync',
        tier: 'active',
        // lastSync intentionally omitted
      });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding.severity).toBe('medium');
      expect(finding.confidence).toBe(0.8);
      expect(finding.title).toContain('lastSync missing from frontmatter');
      expect(finding.title).toContain('no-sync');
    });
  });

  describe('malformed frontmatter', () => {
    it('increments errors and produces a low-severity finding when _overview.md has no frontmatter markers', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      const projectDir = join(projectsDir, 'bad-fm');
      mkdirSync(projectDir, { recursive: true });
      // No --- delimiters — parseFrontmatter returns null
      writeFileSync(
        join(projectDir, '_overview.md'),
        'This file has no frontmatter at all.\nJust plain text.\n',
        'utf8',
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.metrics.errors).toBe(1);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('low');
      expect(result.findings[0].confidence).toBe(0.6);
    });
  });

  describe('JSONL output', () => {
    it('appends a valid JSONL record after a non-skipped scan with one stale project', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'stale-slug', {
        slug: 'stale-slug',
        tier: 'active',
        lastSync: daysAgo(10),
      });

      await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      const jsonlPath = join(root, '.orchestrator/metrics/vault-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);

      const lastLine = readFileSync(jsonlPath, 'utf8').trim().split('\n').at(-1);
      const record = JSON.parse(lastLine);

      expect(record.probe).toBe('vault-staleness');
      expect(record.project_root).toBe(root);
      expect(record.vault_dir).toBe(vaultDir);
      expect(typeof record.timestamp).toBe('string');
      expect(record.scanned_projects).toBe(1);
      expect(record.stale_count).toBe(1);
      expect(record.errors).toBe(0);
      expect(typeof record.duration_ms).toBe('number');

      expect(record.findings).toHaveLength(1);
      const f = record.findings[0];
      expect(f.slug).toBe('stale-slug');
      expect(f.severity).toBe('medium');
      expect(f.flag).toBe('stale-yes');
      expect(typeof f.delta_hours).toBe('number');
    });

    it('appends a JSONL record even when there are zero findings (fresh project)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'new-proj', {
        slug: 'new-proj',
        lastSync: hoursAgo(2),
      });

      await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      const jsonlPath = join(root, '.orchestrator/metrics/vault-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);
      const lastLine = readFileSync(jsonlPath, 'utf8').trim().split('\n').at(-1);
      const record = JSON.parse(lastLine);
      expect(record.stale_count).toBe(0);
      expect(record.findings).toHaveLength(0);
    });
  });

  describe('no-throw discipline', () => {
    it('does not throw when _overview.md is a directory (causing readFileSync to fail)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);

      // Create a project dir where _overview.md is itself a directory —
      // readFileSync will throw EISDIR, exercising the per-project error path.
      const projectDir = join(projectsDir, 'bad-read');
      mkdirSync(join(projectDir, '_overview.md'), { recursive: true });

      let result;
      let threw = false;
      try {
        result = await runProbe(root, {
          'vault-integration': { 'vault-dir': vaultDir },
        });
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(result).toBeTruthy();
      expect(typeof result).toBe('object');
      // The probe must count the error internally
      expect(result.metrics.errors).toBe(1);
    });
  });

  describe('multi-project scan', () => {
    it('scans multiple projects and counts each independently', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'proj-a', { slug: 'proj-a', lastSync: hoursAgo(1) });
      makeProject(projectsDir, 'proj-b', { slug: 'proj-b', lastSync: daysAgo(2) });
      makeProject(projectsDir, 'proj-c', { slug: 'proj-c', lastSync: daysAgo(10) });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.metrics.scanned_projects).toBe(3);
      expect(result.metrics.stale_count).toBe(2);
      expect(result.findings).toHaveLength(2);
    });

    it('skips subdirectories that have no _overview.md', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      // A directory with no _overview.md should be silently skipped
      mkdirSync(join(projectsDir, 'not-a-project'), { recursive: true });
      makeProject(projectsDir, 'real-project', { slug: 'real-project', lastSync: hoursAgo(1) });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.metrics.scanned_projects).toBe(1);
    });
  });

  describe('duration_ms', () => {
    it('returns a non-negative duration_ms in every result', async () => {
      const result = await runProbe('/tmp', {});
      expect(typeof result.duration_ms).toBe('number');
      expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    });
  });
});
