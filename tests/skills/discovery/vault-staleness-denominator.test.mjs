/**
 * tests/skills/discovery/vault-staleness-denominator.test.mjs
 *
 * NAMED BUG — GitLab #1238: `skills/discovery/probes/vault-staleness.mjs` compared
 * each `01-projects/<slug>/_overview.md` frontmatter `lastSync` against the PROBE'S
 * OWN RUNTIME (`now - lastSync`). A repo with no new commits therefore read as
 * permanently stale, and grew staler every day nobody touched it.
 *
 * Measured on the live vault: 2026-09-05 → 33 of 48 overviews "stale", 26 of them
 * > 7 days, with a completely healthy sync chain. 2026-09-06 → 16 of 48 synced
 * today, 18 unchanged since 2026-08-23, none missing.
 *
 * The fixture below reproduces that 2026-09-06 shape (34 projects: 16 + 18) with a
 * healthy chain — every `lastSync` at or after its own `lastCommit`. Acceptance:
 * the probe reports 0 stale. Against the pre-fix probe the 18 unchanged-since-
 * 2026-08-23 projects all cross the 24h wall-clock threshold and it reports 18.
 *
 * Fixture only — this file never reads the operator's real vault.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProbe } from '../../../skills/discovery/probes/vault-staleness.mjs';

const dirs = [];
afterEach(() => {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  dirs.length = 0;
});

function makeVault() {
  const root = mkdtempSync(join(tmpdir(), 'vault-staleness-1238-'));
  dirs.push(root);
  const vaultDir = join(root, 'vault');
  const projectsDir = join(vaultDir, '01-projects');
  mkdirSync(projectsDir, { recursive: true });
  return { root, vaultDir, projectsDir };
}

function writeOverview(projectsDir, slug, fields) {
  const dir = join(projectsDir, slug);
  mkdirSync(dir, { recursive: true });
  const body = ['---'];
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.push(`${k}: ${v}`);
  body.push('---', '', `# ${slug}`, '');
  writeFileSync(join(dir, '_overview.md'), body.join('\n'), 'utf8');
}

const iso = (ms) => new Date(ms).toISOString();
const daysAgoMs = (n) => Date.now() - n * 86_400_000;

describe('vault-staleness denominator (#1238)', () => {
  it('reports 0 stale on the measured 2026-09-06 shape: 16 synced today, 18 unchanged since 2026-08-23, chain healthy', async () => {
    const { root, vaultDir, projectsDir } = makeVault();

    // 16 synced today — repo committed a few hours ago, synced after it.
    for (let i = 0; i < 16; i++) {
      writeOverview(projectsDir, `fresh-${i}`, {
        slug: `fresh-${i}`,
        tier: 'active',
        lastCommit: iso(Date.now() - 5 * 3_600_000),
        lastSync: iso(Date.now() - 2 * 3_600_000),
      });
    }

    // 18 unchanged since 2026-08-23 — nobody committed, nobody needed to sync.
    // Wall-clock age ~14 days; repo-anchored delta 0. Healthy, not stale.
    for (let i = 0; i < 18; i++) {
      const stamp = iso(daysAgoMs(14));
      writeOverview(projectsDir, `idle-${i}`, {
        slug: `idle-${i}`,
        tier: 'active',
        lastCommit: stamp,
        lastSync: stamp,
      });
    }

    const result = await runProbe(root, { 'vault-integration': { 'vault-dir': vaultDir } });

    expect(result.metrics.scanned_projects).toBe(34);
    expect(result.metrics.errors).toBe(0);
    expect(result.metrics.stale_count).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('still flags a repo that genuinely advanced past its sync', async () => {
    const { root, vaultDir, projectsDir } = makeVault();
    writeOverview(projectsDir, 'drifted', {
      slug: 'drifted',
      tier: 'top',
      lastSync: iso(daysAgoMs(30)),      // synced a month ago …
      lastCommit: iso(daysAgoMs(2)),     // … but committed two days ago
    });

    const result = await runProbe(root, { 'vault-integration': { 'vault-dir': vaultDir } });

    expect(result.metrics.stale_count).toBe(1);
    const f = result.findings[0];
    expect(f.severity).toBe('medium');   // 28d > 7d
    expect(f.confidence).toBe(0.9);
    expect(f.evidence.basis).toBe('lastCommit');
    expect(f.description).toContain('advanced');
  });

  it('a sync that ran AFTER the newest commit is current, however old the clock says it is', async () => {
    const { root, vaultDir, projectsDir } = makeVault();
    writeOverview(projectsDir, 'synced-after', {
      slug: 'synced-after',
      lastCommit: iso(daysAgoMs(120)),
      lastSync: iso(daysAgoMs(119)),
    });

    const result = await runProbe(root, { 'vault-integration': { 'vault-dir': vaultDir } });
    expect(result.metrics.stale_count).toBe(0);
  });

  it('without lastCommit it falls back to wall-clock, marks the basis, and lowers confidence', async () => {
    const { root, vaultDir, projectsDir } = makeVault();
    writeOverview(projectsDir, 'no-commit-field', {
      slug: 'no-commit-field',
      lastSync: iso(daysAgoMs(3)),
      // lastCommit deliberately absent — no repo-activity signal exists
    });

    const result = await runProbe(root, { 'vault-integration': { 'vault-dir': vaultDir } });

    expect(result.metrics.stale_count).toBe(1);
    const f = result.findings[0];
    expect(f.evidence.basis).toBe('probe-runtime');
    expect(f.confidence).toBe(0.6);
    expect(f.description).toContain('No lastCommit');
  });

  it('carries basis and last_commit into the JSONL record', async () => {
    const { root, vaultDir, projectsDir } = makeVault();
    const lastCommit = iso(daysAgoMs(2));
    writeOverview(projectsDir, 'drifted', {
      slug: 'drifted',
      lastSync: iso(daysAgoMs(30)),
      lastCommit,
    });

    await runProbe(root, { 'vault-integration': { 'vault-dir': vaultDir } });

    const line = (await import('node:fs')).readFileSync(
      join(root, '.orchestrator/metrics/vault-staleness.jsonl'), 'utf8',
    ).trim().split('\n').at(-1);
    const record = JSON.parse(line);
    expect(record.findings[0].basis).toBe('lastCommit');
    expect(record.findings[0].last_commit).toBe(lastCommit);
  });
});
