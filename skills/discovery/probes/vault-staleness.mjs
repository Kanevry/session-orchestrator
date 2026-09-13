/**
 * skills/discovery/probes/vault-staleness.mjs
 *
 * Probe: detects stale vault mirroring — projects where the upstream repo
 * has advanced past the last vault sync. Threshold: 24 hours.
 *
 * Input: projectRoot (absolute path to the repo running discovery), config
 * (parsed Session Config object). Reads vault-integration.vault-dir from config.
 *
 * Output: {findings[], metrics, duration_ms, [skipped_reason]}. Never throws.
 * Also appends one JSONL summary record to .orchestrator/metrics/vault-staleness.jsonl.
 *
 * Denominator (GitLab #1238): staleness is `lastCommit - lastSync` — how far the
 * upstream repo advanced PAST the last sync — not `now - lastSync`. A mirror of a
 * repo nobody has committed to in three weeks is CURRENT, not three weeks stale.
 * `lastCommit` needs no slug→repo-path resolution: the vault sync writer already
 * stamps it into the same `_overview.md` frontmatter it writes `lastSync` into,
 * so both sides of the comparison come from one read of one file.
 *
 * Measured against the live vault before the fix (2026-09-05): 33 of 48 overviews
 * reported "stale", 26 of them >7d, with a demonstrably healthy sync chain —
 * because the clock, not the repo, was the denominator.
 *
 * Passive projects (GitLab #1238 point 2): a `01-projects/<slug>/` carrying a
 * `_passive.md` marker is one nobody syncs on purpose (vault convention
 * `_meta/conventions.md`; the same marker is already honoured by
 * `scripts/lib/context-coverage-banner.mjs` via its `COVERAGE_FILES` check).
 * Such a folder is skipped BEFORE any staleness comparison and counted in
 * `metrics.passive_skipped`, so the skip is visible rather than silent — a probe
 * that quietly ignored folders would be indistinguishable from one that found
 * them healthy.
 *
 * Fallback: an overview WITHOUT `lastCommit` carries no repo-activity signal at
 * all, so the wall-clock comparison is the only thing left. It is retained for
 * that case only, marked `basis: 'probe-runtime'` in the evidence and carried at
 * lower confidence, so a consumer can tell a measured delta from a guessed one.
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser — top-level scalar fields only (<30 lines).
// Strips surrounding quotes from values. Skips list items (lines starting "- ").
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) { start = i; }
      else { end = i; break; }
    }
  }
  if (start === -1 || end === -1) return null;
  const fm = {};
  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#') || line.trimStart().startsWith('- ')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[key] = val;
  }
  return fm;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Marker file that declares a `01-projects/<slug>/` deliberately un-synced.
 * Same filename `scripts/lib/context-coverage-banner.mjs` accepts as coverage.
 */
const PASSIVE_MARKER = '_passive.md';

const HOURS_24 = 24 * 60 * 60 * 1000;
const HOURS_168 = 7 * 24 * 60 * 60 * 1000; // 7 days

function deltaHours(ms) {
  return Math.round(ms / (60 * 60 * 1000) * 10) / 10;
}

function formatDelta(ms) {
  const h = ms / (60 * 60 * 1000);
  if (h < 48) return `${Math.round(h * 10) / 10}h`;
  return `${Math.round(h / 24 * 10) / 10}d`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export async function runProbe(projectRoot, config) {
  const start = Date.now();

  const makeSkip = (skipped_reason) => ({
    findings: [],
    metrics: { scanned_projects: 0, stale_count: 0, errors: 0, passive_skipped: 0 },
    duration_ms: Math.round(Date.now() - start),
    skipped_reason,
  });

  try {
    // --- Config validation (early exit paths) ---

    const vaultDir = config?.['vault-integration']?.['vault-dir'];
    if (!vaultDir) {
      return makeSkip('vault-dir not configured');
    }

    if (!existsSync(vaultDir)) {
      return makeSkip(`vault-dir does not exist: ${vaultDir}`);
    }

    const projectsDir = join(vaultDir, '01-projects');
    if (!existsSync(projectsDir)) {
      return makeSkip('01-projects directory missing in vault');
    }

    // --- Scan loop ---

    const findings = [];
    const metrics = { scanned_projects: 0, stale_count: 0, errors: 0, passive_skipped: 0 };
    const now = Date.now();

    let entries;
    try {
      entries = readdirSync(projectsDir, { withFileTypes: true });
    } catch (err) {
      return {
        findings: [{
          severity: 'medium',
          confidence: 0.5,
          title: '[vault-staleness] probe error',
          description: err.message,
          evidence: {},
        }],
        metrics: { scanned_projects: 0, stale_count: 0, errors: 1, passive_skipped: 0 },
        duration_ms: Math.round(Date.now() - start),
        error: err.message,
      };
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const projectDir = join(projectsDir, entry.name);

      // #1238 point 2 — a `_passive.md` marker means "nobody syncs this on
      // purpose". Skipped before any comparison, but COUNTED so the skip shows
      // up in the metrics instead of looking like a healthy project. Checked
      // BEFORE the `_overview.md` existence test: a passive folder that carries
      // no overview is still a deliberate skip, and the earlier ordering dropped
      // it into the silent non-project branch, under-reporting the metric. The
      // finding population is unchanged either way — neither branch can emit one.
      if (existsSync(join(projectDir, PASSIVE_MARKER))) {
        metrics.passive_skipped++;
        continue;
      }

      const overviewPath = join(projectDir, '_overview.md');
      if (!existsSync(overviewPath)) continue; // non-project dir, skip silently

      metrics.scanned_projects++;

      let text;
      try {
        text = readFileSync(overviewPath, 'utf8');
      } catch (err) {
        metrics.errors++;
        findings.push({
          severity: 'low',
          confidence: 0.6,
          file_path: overviewPath,
          title: `[vault-staleness] ${entry.name}: could not read _overview.md`,
          description: err.message,
          evidence: { slug: entry.name, tier: undefined, lastSync: undefined, delta_hours: undefined },
        });
        continue;
      }

      let fm;
      try {
        fm = parseFrontmatter(text);
      } catch {
        fm = null;
      }

      if (!fm) {
        metrics.errors++;
        findings.push({
          severity: 'low',
          confidence: 0.6,
          file_path: overviewPath,
          title: `[vault-staleness] ${entry.name}: missing or malformed frontmatter`,
          description: 'Could not parse YAML frontmatter from _overview.md',
          evidence: { slug: entry.name, tier: undefined, lastSync: undefined, delta_hours: undefined },
        });
        continue;
      }

      const slug = fm.slug || entry.name;
      const tier = fm.tier || undefined;
      const lastSync = fm.lastSync || undefined;
      const lastCommit = fm.lastCommit || undefined;

      if (!lastSync) {
        metrics.stale_count++;
        findings.push({
          severity: 'medium',
          confidence: 0.8,
          file_path: overviewPath,
          title: `[vault-staleness] ${slug}: lastSync missing from frontmatter`,
          description: 'The _overview.md has no lastSync field — vault sync status is unknown.',
          evidence: { slug, tier, lastSync: undefined, delta_hours: undefined },
        });
        continue;
      }

      // Parse lastSync as ISO 8601 (YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[Z/offset])
      const lastSyncMs = Date.parse(lastSync);
      if (isNaN(lastSyncMs)) {
        metrics.errors++;
        findings.push({
          severity: 'low',
          confidence: 0.6,
          file_path: overviewPath,
          title: `[vault-staleness] ${slug}: lastSync is not a valid date`,
          description: `Could not parse lastSync value: "${lastSync}"`,
          evidence: { slug, tier, lastSync, delta_hours: undefined },
        });
        continue;
      }

      // #1238 — the denominator. `lastCommit` is the repo's own newest activity,
      // so `lastCommit - lastSync` measures what the mirror actually MISSED.
      // A negative or zero delta means the sync ran at or after the newest
      // commit: current, whatever the wall clock says.
      const lastCommitMs = lastCommit ? Date.parse(lastCommit) : NaN;
      const haveCommitBasis = !isNaN(lastCommitMs);
      const basis = haveCommitBasis ? 'lastCommit' : 'probe-runtime';
      const delta = haveCommitBasis ? lastCommitMs - lastSyncMs : now - lastSyncMs;

      if (delta > HOURS_24) {
        const severity = delta > HOURS_168 ? 'medium' : 'low';
        const dh = deltaHours(delta);
        metrics.stale_count++;
        findings.push({
          severity,
          // A repo-anchored delta is a measurement; a clock-anchored one is the
          // best available guess about a repo this probe cannot see.
          confidence: haveCommitBasis ? 0.9 : 0.6,
          file_path: overviewPath,
          title: `[vault-staleness] ${slug}: ${formatDelta(delta)} since last sync`,
          description: haveCommitBasis
            ? `The repo advanced ${formatDelta(delta)} past the last vault sync ` +
              `(lastCommit ${lastCommit} vs lastSync ${lastSync}, threshold: 24h).`
            : `lastSync is ${formatDelta(delta)} old (threshold: 24h). ` +
              `No lastCommit in the frontmatter, so this compares against probe run time — ` +
              `an idle repo reads as stale here. Add lastCommit to make the delta repo-anchored.`,
          evidence: { slug, tier, lastSync, lastCommit, basis, delta_hours: dh },
        });
      }
    }

    const duration_ms = Math.round(Date.now() - start);

    // --- JSONL append (only when we actually scanned) ---
    const record = {
      timestamp: new Date().toISOString(),
      probe: 'vault-staleness',
      project_root: projectRoot,
      vault_dir: vaultDir,
      scanned_projects: metrics.scanned_projects,
      stale_count: metrics.stale_count,
      errors: metrics.errors,
      passive_skipped: metrics.passive_skipped,
      duration_ms,
      findings: findings.map(f => ({
        slug: f.evidence.slug,
        severity: f.severity,
        last_sync: f.evidence.lastSync,
        last_commit: f.evidence.lastCommit,
        basis: f.evidence.basis,
        delta_hours: f.evidence.delta_hours,
        flag: 'stale-yes',
      })),
    };
    try {
      mkdirSync(join(projectRoot, '.orchestrator/metrics'), { recursive: true });
      appendFileSync(
        join(projectRoot, '.orchestrator/metrics/vault-staleness.jsonl'),
        JSON.stringify(record) + '\n'
      );
    } catch {
      // JSONL write failure is non-fatal — telemetry append should not discard scan results.
    }

    return { findings, metrics, duration_ms };

  } catch (err) {
    return {
      findings: [{
        severity: 'medium',
        confidence: 0.5,
        title: '[vault-staleness] probe error',
        description: err.message,
        evidence: {},
      }],
      metrics: { scanned_projects: 0, stale_count: 0, errors: 1, passive_skipped: 0 },
      duration_ms: Math.round(Date.now() - start),
      error: err.message,
    };
  }
}

export default runProbe;
