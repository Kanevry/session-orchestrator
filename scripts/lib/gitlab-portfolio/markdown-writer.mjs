/**
 * markdown-writer.mjs — Render and write the GitLab Portfolio dashboard file.
 *
 * Exports:
 *   GENERATOR_MARKER   — frontmatter sentinel
 *   renderPortfolio    — pure render: Map<repo, summary> → markdown string
 *   writePortfolio     — idempotent write with skip-handwritten / skip-noop / dry-run
 *
 * Skip-on-manual-edit: if the existing file's _generator is absent or differs,
 * return { action: 'skipped-handwritten' } without writing.
 *
 * Skip-noop: if the rendered content (modulo the `updated:` timestamp) matches
 * the existing content byte-for-byte, return { action: 'skipped-noop' }.
 *
 * Dry-run: when dryRun: true, never write; return { action: 'dry-run' }.
 *
 * Created-preservation: if the existing file has a `created:` frontmatter field,
 * propagate it into the new render.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseFrontmatter } from '../vault-mirror/utils.mjs';

/** Frontmatter sentinel that identifies generator-owned files. */
export const GENERATOR_MARKER = 'session-orchestrator-gitlab-portfolio@1';

/** Placeholder used for noop comparison (replaces the live `updated:` value). */
const UPDATED_PLACEHOLDER = '__UPDATED_PLACEHOLDER__';

// ── Formatting helpers ─────────────────────────────────────────────────────────

/**
 * Format a Date as "YYYY-MM-DD HH:MM UTC".
 *
 * @param {Date} date
 * @returns {string}
 */
function formatDateUTC(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-` +
    `${pad(date.getUTCMonth() + 1)}-` +
    `${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:` +
    `${pad(date.getUTCMinutes())} UTC`
  );
}

/**
 * Format a Date as ISO 8601 (for frontmatter fields).
 *
 * @param {Date} date
 * @returns {string}
 */
function toIso(date) {
  return date.toISOString();
}

/**
 * Format a last-activity ISO string for display. Returns '—' if absent.
 *
 * @param {string|null|undefined} iso
 * @returns {string}
 */
function fmtActivity(iso) {
  if (!iso) return '—';
  // Display as YYYY-MM-DD HH:MM UTC
  try {
    const d = new Date(iso);
    return formatDateUTC(d);
  } catch {
    return iso;
  }
}

/**
 * Format a milestone for display.
 *
 * @param {{ title: string, due_date: string } | null} ms
 * @returns {string}
 */
function fmtMilestone(ms) {
  if (!ms) return '—';
  return ms.due_date ? `${ms.title} (${ms.due_date})` : ms.title;
}

// ── Render ─────────────────────────────────────────────────────────────────────

/**
 * Render the portfolio markdown body from per-repo summaries.
 *
 * Repos are sorted alphabetically by name for stable output.
 * topThree within each repo is already sorted by updated_at desc (from summarizeRepo).
 *
 * @param {Map<string, {
 *   openCount: number,
 *   criticalCount: number,
 *   staleCount: number,
 *   nextMilestone: { title: string, due_date: string } | null,
 *   lastActivity: string | null,
 *   topThree: Array<{ iid: number|string, title: string, labels: string[], url: string }>,
 * }>} summaries
 * @param {{
 *   now: Date,
 *   createdIso?: string,
 *   staleDays?: number,
 *   updatedPlaceholder?: string,
 * }} opts
 * @returns {string}  full markdown (frontmatter + body)
 */
export function renderPortfolio(summaries, opts) {
  const {
    now,
    createdIso,
    staleDays = 30,
    updatedPlaceholder,
  } = opts;

  const nowIso = toIso(now);
  const updatedValue = updatedPlaceholder ?? nowIso;
  const createdValue = createdIso ?? nowIso;

  // Aggregate totals
  let totalOpen = 0;
  let totalCritical = 0;
  let totalStale = 0;
  const sortedRepos = [...summaries.keys()].sort((a, b) => a.localeCompare(b));

  for (const repo of sortedRepos) {
    const s = summaries.get(repo);
    totalOpen += s.openCount;
    totalCritical += s.criticalCount;
    totalStale += s.staleCount;
  }

  const lines = [];

  // Frontmatter
  lines.push('---');
  lines.push(`_generator: ${GENERATOR_MARKER}`);
  lines.push(`type: dashboard`);
  lines.push(`created: ${createdValue}`);
  lines.push(`updated: ${updatedValue}`);
  lines.push('---');
  lines.push('');

  // Title + preamble
  lines.push('# GitLab Portfolio');
  lines.push('');
  lines.push(`> Generated ${formatDateUTC(now)}. Re-run /portfolio to refresh.`);
  lines.push('');

  // Summary table
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|---|---|');
  lines.push(`| Total repos | ${sortedRepos.length} |`);
  lines.push(`| Total open issues | ${totalOpen} |`);
  lines.push(`| Critical | ${totalCritical} |`);
  lines.push(`| Stale (>${staleDays} days) | ${totalStale} |`);
  lines.push('');

  // Repos overview table
  lines.push('## Repos');
  lines.push('');
  lines.push('| Repo | Open | Critical | Stale | Last activity | Next milestone |');
  lines.push('|---|---|---|---|---|---|');

  for (const repo of sortedRepos) {
    const s = summaries.get(repo);
    lines.push(
      `| ${repo} | ${s.openCount} | ${s.criticalCount} | ${s.staleCount} | ${fmtActivity(s.lastActivity)} | ${fmtMilestone(s.nextMilestone)} |`,
    );
  }
  lines.push('');

  // Per-repo detail
  lines.push('## Per-Repo Detail');
  lines.push('');

  for (const repo of sortedRepos) {
    const s = summaries.get(repo);
    lines.push(`### ${repo}`);
    lines.push('');
    lines.push(`- Last activity: ${fmtActivity(s.lastActivity)}`);
    lines.push(`- Next milestone: ${fmtMilestone(s.nextMilestone)}`);

    if (s.topThree.length > 0) {
      lines.push('- Top 3 open issues:');
      for (const issue of s.topThree) {
        const labelStr = issue.labels.length > 0 ? `labels: ${issue.labels.join(', ')}` : 'no labels';
        lines.push(`  - #${issue.iid} ${issue.title} (${labelStr}) — ${issue.url}`);
      }
    } else {
      lines.push('- No open issues.');
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ── Write (idempotent) ─────────────────────────────────────────────────────────

/**
 * Normalize a markdown string by replacing the `updated:` frontmatter line
 * with a stable placeholder, enabling byte-for-byte noop comparison.
 *
 * @param {string} content
 * @returns {string}
 */
function normalizeUpdated(content) {
  // Replace `updated: <anything>` in the frontmatter block with the placeholder.
  // Only replace within the first frontmatter section (between the first --- pair).
  return content.replace(
    /^(updated:\s*)(.+)$/m,
    `$1${UPDATED_PLACEHOLDER}`,
  );
}

/**
 * Write the portfolio file with idempotency guards.
 *
 * @param {{
 *   outputPath: string,
 *   content: string,
 *   now: Date,
 *   dryRun?: boolean,
 *   fs?: { readFileSync?: Function, writeFileSync?: Function, mkdirSync?: Function, existsSync?: Function },
 * }} opts
 * @returns {{ action: 'written'|'skipped-handwritten'|'skipped-noop'|'dry-run', path: string }}
 */
export function writePortfolio(opts) {
  const {
    outputPath,
    content,
    dryRun = false,
    fs: injectedFs,
  } = opts;

  // Resolve fs functions (injectable for tests)
  const fsReadFile = injectedFs?.readFileSync ?? readFileSync;
  const fsWriteFile = injectedFs?.writeFileSync ?? writeFileSync;
  const fsMkdir = injectedFs?.mkdirSync ?? mkdirSync;
  const fsExists = injectedFs?.existsSync ?? existsSync;

  // Dry-run: never write
  if (dryRun) {
    return { action: 'dry-run', path: outputPath };
  }

  if (fsExists(outputPath)) {
    let existingContent;
    try {
      existingContent = fsReadFile(outputPath, 'utf8');
    } catch {
      // Cannot read → treat as non-existent, write fresh
      existingContent = null;
    }

    if (existingContent !== null) {
      const fm = parseFrontmatter(existingContent);

      // Skip-on-manual-edit: no _generator or different generator
      if (!fm || !fm['_generator']) {
        return { action: 'skipped-handwritten', path: outputPath };
      }
      if (fm['_generator'] !== GENERATOR_MARKER) {
        return { action: 'skipped-handwritten', path: outputPath };
      }

      // Skip-noop: compare content modulo `updated:` timestamp
      const existingNormalized = normalizeUpdated(existingContent);
      const newNormalized = normalizeUpdated(content);
      if (existingNormalized === newNormalized) {
        return { action: 'skipped-noop', path: outputPath };
      }
    }
  }

  // Write
  const targetDir = dirname(outputPath);
  fsMkdir(targetDir, { recursive: true });
  fsWriteFile(outputPath, content, 'utf8');

  return { action: 'written', path: outputPath };
}
