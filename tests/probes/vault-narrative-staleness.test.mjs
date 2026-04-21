/**
 * tests/probes/vault-narrative-staleness.test.mjs
 *
 * Behavioral tests for skills/discovery/probes/vault-narrative-staleness.mjs.
 * Uses tmpdir-based isolation — never touches the host repo.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runProbe } from '../../skills/discovery/probes/vault-narrative-staleness.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'vault-narrative-staleness-'));
}

/**
 * Create a minimal vault directory structure.
 * Returns { vaultDir, projectsDir }.
 */
function makeVault(root) {
  const vaultDir = join(root, 'vault');
  mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
  return { vaultDir, projectsDir: join(vaultDir, '01-projects') };
}

/**
 * Create a project directory with _overview.md and optional narrative files.
 *
 * @param {string} projectsDir
 * @param {string} slug
 * @param {Record<string,string>} overviewFrontmatter  key→value pairs for _overview.md
 * @param {Record<string,string>} narrativeFiles        filename→full-file-content
 */
function makeProject(projectsDir, slug, overviewFrontmatter, narrativeFiles = {}) {
  const projectDir = join(projectsDir, slug);
  mkdirSync(projectDir, { recursive: true });

  const lines = ['---'];
  for (const [k, v] of Object.entries(overviewFrontmatter)) {
    lines.push(`${k}: ${v}`);
  }
  lines.push('---', '', '# Project overview', '');
  writeFileSync(join(projectDir, '_overview.md'), lines.join('\n'), 'utf8');

  for (const [name, content] of Object.entries(narrativeFiles)) {
    writeFileSync(join(projectDir, name), content, 'utf8');
  }
}

/** Build narrative file content with a frontmatter `updated` field. */
function narrativeWithUpdated(updatedIso) {
  return `---\nupdated: ${updatedIso}\n---\n\n# Content\n`;
}

/** Build narrative file content with no `updated` field in frontmatter. */
function narrativeNoUpdated() {
  return `---\nauthor: someone\n---\n\n# Content\n`;
}

/** ISO timestamp N days ago */
function daysAgo(n) {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

/** ISO timestamp N hours ago (for "fresh" tests) */
function hoursAgo(n) {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------
// Tmpdir cleanup
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

describe('vault-narrative-staleness probe', () => {

  describe('skip paths', () => {
    it('returns skipped_reason when vault-dir is not in config', async () => {
      // Ensure VAULT_DIR env is not set for this check
      const savedEnv = process.env.VAULT_DIR;
      delete process.env.VAULT_DIR;
      try {
        const result = await runProbe('/tmp', {});
        expect(result.skipped_reason).toContain('vault-dir not configured');
        expect(result.findings).toEqual([]);
        expect(result.metrics.scanned_projects).toBe(0);
      } finally {
        if (savedEnv !== undefined) process.env.VAULT_DIR = savedEnv;
      }
    });

    it('does not write JSONL when vault-dir is not configured', async () => {
      const root = tmp();
      const savedEnv = process.env.VAULT_DIR;
      delete process.env.VAULT_DIR;
      try {
        await runProbe(root, {});
        const jsonlPath = join(root, '.orchestrator/metrics/vault-narrative-staleness.jsonl');
        expect(existsSync(jsonlPath)).toBe(false);
      } finally {
        if (savedEnv !== undefined) process.env.VAULT_DIR = savedEnv;
      }
    });

    it('returns skipped_reason when vault-dir does not exist on disk', async () => {
      const result = await runProbe('/tmp', {
        'vault-integration': { 'vault-dir': '/tmp/nonexistent-vault-narrative-99999' },
      });

      expect(result.skipped_reason).toBeTruthy();
      expect(result.findings).toEqual([]);
      expect(result.metrics.scanned_projects).toBe(0);
    });

    it('does not write JSONL when vault-dir does not exist on disk', async () => {
      const root = tmp();
      await runProbe(root, {
        'vault-integration': { 'vault-dir': '/tmp/nonexistent-vault-narrative-99999' },
      });
      const jsonlPath = join(root, '.orchestrator/metrics/vault-narrative-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(false);
    });

    it('returns skipped_reason when 01-projects directory is missing from vault', async () => {
      const root = tmp();
      const vaultDir = join(root, 'vault');
      mkdirSync(vaultDir, { recursive: true });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.skipped_reason).toContain('01-projects');
      expect(result.findings).toEqual([]);
    });

    it('does not write JSONL when 01-projects directory is missing', async () => {
      const root = tmp();
      const vaultDir = join(root, 'vault');
      mkdirSync(vaultDir, { recursive: true });

      await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });
      const jsonlPath = join(root, '.orchestrator/metrics/vault-narrative-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(false);
    });
  });

  describe('happy paths', () => {
    it('returns zero scanned_narratives and no findings when project has no narrative files', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(projectsDir, 'no-narratives', { slug: 'no-narratives', tier: 'active' });

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(0);
      expect(result.metrics.scanned_narratives).toBe(0);
      expect(result.metrics.stale_narratives).toBe(0);
    });

    it('returns no finding for a narrative updated recently (within threshold)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'fresh-proj', { slug: 'fresh-proj', tier: 'active' },
        { 'context.md': narrativeWithUpdated(hoursAgo(2)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(0);
      expect(result.metrics.scanned_narratives).toBe(1);
      expect(result.metrics.stale_narratives).toBe(0);
    });
  });

  describe('severity escalation — active tier (60d threshold)', () => {
    it('produces low severity when age is 65 days (within 2× threshold of 120d)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'proj-low', { slug: 'proj-low', tier: 'active' },
        { 'context.md': narrativeWithUpdated(daysAgo(65)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('low');
      expect(result.metrics.stale_narratives).toBe(1);
    });

    it('produces medium severity when age is 130 days (beyond 2× but within 3× threshold)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'proj-medium', { slug: 'proj-medium', tier: 'active' },
        { 'context.md': narrativeWithUpdated(daysAgo(130)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('medium');
    });

    it('produces high severity when age is 200 days (beyond 3× threshold of 180d)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'proj-high', { slug: 'proj-high', tier: 'active' },
        { 'context.md': narrativeWithUpdated(daysAgo(200)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].severity).toBe('high');
    });
  });

  describe('tier behavior', () => {
    it('defaults to active tier (60d threshold) when tier field is absent from _overview.md', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      // No tier field — should default to active (60d)
      makeProject(
        projectsDir, 'no-tier', { slug: 'no-tier' /* tier omitted */ },
        { 'context.md': narrativeWithUpdated(daysAgo(65)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      // 65d > 60d threshold → should produce a finding
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence.tier).toBe('active');
    });

    it('uses 30-day threshold for top tier projects (35d old narrative is stale)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'top-proj', { slug: 'top-proj', tier: 'top' },
        { 'context.md': narrativeWithUpdated(daysAgo(35)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].evidence.threshold_days).toBe(30);
    });

    it('uses 180-day threshold for archived tier (90d old narrative is fresh)', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'archived-proj', { slug: 'archived-proj', tier: 'archived' },
        { 'context.md': narrativeWithUpdated(daysAgo(90)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      // 90d < 180d threshold → no finding
      expect(result.findings).toHaveLength(0);
    });
  });

  describe('missing updated field', () => {
    it('produces low-severity finding with confidence 0.7 when updated field is absent', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'no-updated', { slug: 'no-updated', tier: 'active' },
        { 'context.md': narrativeNoUpdated() },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      const finding = result.findings[0];
      expect(finding.severity).toBe('low');
      expect(finding.confidence).toBe(0.7);
      expect(finding.title).toContain('updated field missing');
    });
  });

  describe('multiple narrative files per project', () => {
    it('finds 2 stale and 1 fresh narrative in a single project', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'mixed-proj', { slug: 'mixed-proj', tier: 'active' },
        {
          'context.md':   narrativeWithUpdated(daysAgo(90)),  // stale (90 > 60)
          'decisions.md': narrativeWithUpdated(daysAgo(90)),  // stale
          'people.md':    narrativeWithUpdated(hoursAgo(2)),  // fresh
        },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(2);
      expect(result.metrics.scanned_narratives).toBe(3);
      expect(result.metrics.stale_narratives).toBe(2);
    });
  });

  describe('JSONL output', () => {
    it('appends a valid JSONL record with correct shape after a non-skipped scan', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'jsonl-proj', { slug: 'jsonl-proj', tier: 'active' },
        { 'context.md': narrativeWithUpdated(daysAgo(90)) },
      );

      await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      const jsonlPath = join(root, '.orchestrator/metrics/vault-narrative-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);

      const lastLine = readFileSync(jsonlPath, 'utf8').trim().split('\n').at(-1);
      const record = JSON.parse(lastLine);

      expect(record.probe).toBe('vault-narrative-staleness');
      expect(record.project_root).toBe(root);
      expect(record.vault_dir).toBe(vaultDir);
      expect(typeof record.timestamp).toBe('string');
      expect(record.scanned_projects).toBe(1);
      expect(record.scanned_narratives).toBe(1);
      expect(record.stale_narratives).toBe(1);
      expect(record.errors).toBe(0);
      expect(typeof record.duration_ms).toBe('number');

      expect(record.findings).toHaveLength(1);
      const f = record.findings[0];
      expect(f.slug).toBe('jsonl-proj');
      expect(f.file).toBe('context.md');
      expect(f.tier).toBe('active');
      expect(typeof f.severity).toBe('string');
      expect(typeof f.age_days).toBe('number');
      expect(f.threshold_days).toBe(60);
    });

    it('still writes JSONL with zero findings when all narratives are fresh', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'all-fresh', { slug: 'all-fresh', tier: 'active' },
        { 'context.md': narrativeWithUpdated(hoursAgo(5)) },
      );

      await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      const jsonlPath = join(root, '.orchestrator/metrics/vault-narrative-staleness.jsonl');
      expect(existsSync(jsonlPath)).toBe(true);
      const record = JSON.parse(readFileSync(jsonlPath, 'utf8').trim().split('\n').at(-1));
      expect(record.stale_narratives).toBe(0);
      expect(record.findings).toHaveLength(0);
    });
  });

  describe('no-throw discipline', () => {
    it('returns an object and does not throw when given a completely invalid root path', async () => {
      // Probe must never throw — top-level catch handles all errors
      const result = await runProbe('/dev/null/not-a-dir', {
        'vault-integration': { 'vault-dir': '/dev/null/also-not-a-dir' },
      });

      expect(result).toBeTruthy();
      expect(typeof result).toBe('object');
      // Should either skip or return a safe error shape
      expect(result.findings).toBeDefined();
      expect(result.metrics).toBeDefined();
    });
  });

  describe('evidence shape', () => {
    it('includes slug, file, tier, age_days, threshold_days in finding evidence', async () => {
      const root = tmp();
      const { vaultDir, projectsDir } = makeVault(root);
      makeProject(
        projectsDir, 'evidence-proj', { slug: 'evidence-proj', tier: 'top' },
        { 'decisions.md': narrativeWithUpdated(daysAgo(35)) },
      );

      const result = await runProbe(root, {
        'vault-integration': { 'vault-dir': vaultDir },
      });

      expect(result.findings).toHaveLength(1);
      const ev = result.findings[0].evidence;
      expect(ev.slug).toBe('evidence-proj');
      expect(ev.file).toBe('decisions.md');
      expect(ev.tier).toBe('top');
      expect(typeof ev.age_days).toBe('number');
      expect(ev.threshold_days).toBe(30);
    });
  });

  describe('duration_ms', () => {
    it('returns a non-negative duration_ms in every result', async () => {
      const savedEnv = process.env.VAULT_DIR;
      delete process.env.VAULT_DIR;
      try {
        const result = await runProbe('/tmp', {});
        expect(typeof result.duration_ms).toBe('number');
        expect(result.duration_ms).toBeGreaterThanOrEqual(0);
      } finally {
        if (savedEnv !== undefined) process.env.VAULT_DIR = savedEnv;
      }
    });
  });
});
