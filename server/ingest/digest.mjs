/**
 * server/ingest/digest.mjs — weekly digest generator for the ingest server
 * (Epic #841, S8 / GitLab #849; PRD docs/prd/2026-07-20-anonymous-usage-telemetry.md
 * §2 (Read path) + §3-FA5).
 *
 * W1 decision (aligns with the eval-report doctrine): the JSON artifact is the
 * SSOT, the Markdown artifact is a DERIVED VIEW rendered from it. Both are
 * PII-free by construction — the digest is built exclusively from
 * `querySummary()`'s aggregate shape (db.mjs), which never surfaces raw
 * `anon_id` values, only a `distinctAnonIds` count.
 *
 * The digest always covers the most recently COMPLETED ISO week (Mon..Sun),
 * never the in-progress current week — `computeWeekRange()` looks one week
 * back from `now` by default.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from './config.mjs';
import { openDb, closeDb, querySummary, upsertWeeklyAggregate } from './db.mjs';

// ---------------------------------------------------------------------------
// Week-range computation
// ---------------------------------------------------------------------------

/**
 * ISO-8601 week string (`YYYY-Www`) for the week containing `date`, computed
 * purely on UTC calendar fields (no locale/timezone dependency).
 * @param {Date} date — a UTC-midnight Date for the target calendar day.
 * @returns {string}
 */
function isoWeekString(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoWeekday = d.getUTCDay() || 7; // Mon=1..Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - isoWeekday); // Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const weekNo = Math.ceil((((d.getTime() - yearStart) / 86400000) + 1) / 7);
  return `${isoYear}-W${String(weekNo).padStart(2, '0')}`;
}

/** Format a UTC-midnight Date as `YYYY-MM-DD`. */
function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * Compute the Monday..Sunday range of the most recently COMPLETED ISO week
 * relative to `now` — i.e. the week immediately before the one `now` falls in.
 *
 * @param {Date} [now]
 * @returns {{ week: string, fromDay: string, toDay: string }}
 */
export function computeWeekRange(now = new Date()) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const todayIsoWeekday = today.getUTCDay() || 7; // Mon=1..Sun=7

  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - (todayIsoWeekday - 1));

  const fromDate = new Date(thisMonday);
  fromDate.setUTCDate(thisMonday.getUTCDate() - 7);

  const toDate = new Date(fromDate);
  toDate.setUTCDate(fromDate.getUTCDate() + 6);

  return {
    week: isoWeekString(fromDate),
    fromDay: toYmd(fromDate),
    toDay: toYmd(toDate),
  };
}

// ---------------------------------------------------------------------------
// Digest build
// ---------------------------------------------------------------------------

// Persisted metric key ↔ querySummary() field mapping. Order here is the
// insertion order (SELECT order is asserted via `ORDER BY metric` in tests).
const METRIC_FIELDS = [
  ['total', 'total'],
  ['distinct_anon_ids', 'distinctAnonIds'],
  ['by_platform', 'byPlatform'],
  ['by_os', 'byOs'],
  ['by_node_major', 'byNodeMajor'],
  ['by_plugin_version', 'byPluginVersion'],
  ['top_skills', 'topSkills'],
  ['top_commands', 'topCommands'],
  ['fleet_vs_external', 'fleetVsExternal'],
];

/**
 * Build the weekly digest for `usage-ping` records in `[fromDay, toDay]` and
 * persist each top-level summary metric into `aggregates_weekly` (idempotent
 * upsert keyed on (week, kind, metric) — re-running for the same week never
 * duplicates rows).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ week: string, fromDay: string, toDay: string }} [range]
 * @returns {{
 *   week: string,
 *   generated_at: string,
 *   kind: string,
 *   range: { fromDay: string, toDay: string },
 *   summary: ReturnType<typeof querySummary>,
 * }}
 */
export function buildDigest(db, { week, fromDay, toDay } = computeWeekRange()) {
  const kind = 'usage-ping';
  const summary = querySummary(db, { kind, fromDay, toDay });

  for (const [metric, summaryField] of METRIC_FIELDS) {
    upsertWeeklyAggregate(db, {
      week,
      kind,
      metric,
      valueJson: JSON.stringify(summary[summaryField]),
    });
  }

  return {
    week,
    generated_at: new Date().toISOString(),
    kind,
    range: { fromDay, toDay },
    summary,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering (derived view — never a second source of truth)
// ---------------------------------------------------------------------------

/**
 * Render a `{ name, count }` map (or array) as a Markdown table, sorted
 * descending by count then ascending by name (mirrors db.mjs `toRanked`).
 * @param {string[]} headers
 * @param {Array<[string, number]>} entries
 * @returns {string}
 */
function renderCountTable(headers, entries) {
  if (entries.length === 0) return '_none_\n';
  const sorted = [...entries].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const headerLine = `| ${headers.join(' | ')} |`;
  const sepLine = `| ${headers.map(() => '---').join(' | ')} |`;
  const bodyLines = sorted.map(([name, count]) => `| ${name} | ${count} |`);
  return [headerLine, sepLine, ...bodyLines].join('\n') + '\n';
}

/**
 * Render a digest (as returned by `buildDigest`) as a compact Markdown view.
 * PII-free by construction: the only source is `digest.summary`, which never
 * carries a raw `anon_id` — only the pre-aggregated `distinctAnonIds` count.
 *
 * @param {ReturnType<typeof buildDigest>} digest
 * @returns {string}
 */
export function renderDigestMarkdown(digest) {
  const { week, generated_at, range, summary } = digest;

  const lines = [];
  lines.push(`# Usage Digest — ${week}`);
  lines.push('');
  lines.push(`Range: ${range.fromDay} .. ${range.toDay}  `);
  lines.push(`Generated: ${generated_at}`);
  lines.push('');
  lines.push(`Total: ${summary.total} · Distinct anon IDs: ${summary.distinctAnonIds}`);
  lines.push('');
  lines.push('## By Platform', '');
  lines.push(renderCountTable(['platform', 'count'], Object.entries(summary.byPlatform)));
  lines.push('## By OS', '');
  lines.push(renderCountTable(['os', 'count'], Object.entries(summary.byOs)));
  lines.push('## By Node Major', '');
  lines.push(renderCountTable(['node_major', 'count'], Object.entries(summary.byNodeMajor)));
  lines.push('## By Plugin Version', '');
  lines.push(renderCountTable(['plugin_version', 'count'], Object.entries(summary.byPluginVersion)));
  lines.push('## Top 10 Skills', '');
  lines.push(
    renderCountTable(
      ['skill', 'count'],
      summary.topSkills.slice(0, 10).map((s) => [s.name, s.count]),
    ),
  );
  lines.push('## Top 10 Commands', '');
  lines.push(
    renderCountTable(
      ['command', 'count'],
      summary.topCommands.slice(0, 10).map((c) => [c.name, c.count]),
    ),
  );
  lines.push('## Fleet vs External', '');
  lines.push(`Fleet: ${summary.fleetVsExternal.fleet} · External: ${summary.fleetVsExternal.external}`);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Artifact writers
// ---------------------------------------------------------------------------

/**
 * Write both digest artifacts — `<outDir>/<week>.json` (SSOT) and
 * `<outDir>/<week>.md` (derived Markdown view). Creates `outDir` if missing.
 *
 * @param {ReturnType<typeof buildDigest>} digest
 * @param {{ outDir: string }} opts
 * @returns {{ jsonPath: string, mdPath: string }}
 */
export function writeDigestArtifacts(digest, { outDir }) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `${digest.week}.json`);
  const mdPath = path.join(outDir, `${digest.week}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(digest, null, 2)}\n`);
  writeFileSync(mdPath, renderDigestMarkdown(digest));
  return { jsonPath, mdPath };
}

// ---------------------------------------------------------------------------
// CLI seam
// ---------------------------------------------------------------------------

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  let dbArg;
  let outArg;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db') dbArg = args[++i];
    else if (args[i] === '--out') outArg = args[++i];
  }

  const config = resolveConfig();
  const dbPath = dbArg || config.dbPath;

  if (dbPath !== ':memory:' && !existsSync(dbPath)) {
    process.stderr.write(`digest: database not found at ${dbPath}\n`);
    process.exit(2);
  }

  const outDir = outArg || path.join(path.dirname(dbPath), 'digests');

  const db = openDb(dbPath);
  const digest = buildDigest(db);
  const { jsonPath, mdPath } = writeDigestArtifacts(digest, { outDir });
  closeDb(db);

  process.stdout.write(
    `${JSON.stringify({ week: digest.week, jsonPath, mdPath, total: digest.summary.total })}\n`,
  );
  process.exit(0);
}
