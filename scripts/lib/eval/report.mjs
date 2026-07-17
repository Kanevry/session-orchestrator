/**
 * eval/report.mjs — self-contained, byte-stable HTML run-report renderer for
 * the aiat-llm-eval standard (Epic #803, S5). Renders directly off a
 * session-eval record (scripts/lib/eval/schema.mjs, read-only reference here —
 * this module never validates or mutates records, only reads their fields).
 *
 * The report is a DERIVED VIEW; `.orchestrator/metrics/eval.jsonl` remains the
 * Single Source of Truth (BridgeBench journal-as-SSOT pattern) — the report
 * can always be rebuilt from a stored record via the same renderer.
 *
 * ── Determinism contract (load-bearing for --verify / the golden-file test) ──
 *
 *   renderEvalReport(record, { generatedAt }) is a PURE function: the same
 *   record plus the same `generatedAt` parameter produce a byte-identical HTML
 *   string. No `Date.now()`, no `Math.random()`, no locale-dependent
 *   formatting anywhere in this module — every timestamp is a caller-supplied
 *   parameter or a raw field already on the record, and every number is
 *   stringified with plain `String()` / `toFixed()` (both locale-independent).
 *
 * ── No global score, ever ─────────────────────────────────────────────────
 *
 * Mirrors schema.mjs's FORBIDDEN_GLOBALSCORE_KEYS guarantee: this renderer
 * never sums, averages, or otherwise aggregates dimension scores into a
 * headline number. Per-dimension evidence only.
 *
 * ── Never-throw write path ────────────────────────────────────────────────
 *
 * writeEvalReport mirrors eval/sink.mjs's appendEvalRecord contract: it must
 * never throw (the future session-end eval phase is advisory and must never
 * block /close). Both a rendering failure and a filesystem failure are
 * swallowed into a stderr WARN + a `{ ok:false, ... }` result.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KPI_FIELDS } from './schema.mjs';

/** Default output directory for rendered HTML reports (gitignored, #808/#803). */
export const DEFAULT_EVAL_REPORTS_DIR = '.orchestrator/eval/reports';

// ---------------------------------------------------------------------------
// Escaping + formatting helpers
// ---------------------------------------------------------------------------

/**
 * Escape a value for safe HTML text-node / attribute embedding. Non-string
 * values are stringified first via `String()`. null/undefined become '' —
 * callers that want a visible placeholder for a missing value use
 * formatOrNotRecorded instead (never silently faking a value as empty/0).
 *
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render a value, or the literal "not recorded" placeholder for null/undefined.
 * NEVER fakes a missing value as 0 or blank — mirrors schema.mjs's KPI
 * "don't fake perfect" contract (a missing KPI is null, never a guessed 0).
 *
 * @param {*} value
 * @returns {string}
 */
function formatOrNotRecorded(value) {
  if (value === null || value === undefined) return 'not recorded';
  return escapeHtml(value);
}

const KPI_LABELS = Object.freeze({
  duration_seconds: 'Duration (seconds)',
  total_waves: 'Total waves',
  total_agents: 'Total agents',
  token_input: 'Token input',
  token_output: 'Token output',
  carryover: 'Carryover',
});

const STATUS_BADGE_CLASS = Object.freeze({
  pass: 'badge-pass',
  fail: 'badge-fail',
  'not-applicable': 'badge-not-applicable',
  'cannot-determine': 'badge-cannot-determine',
});

const METHOD_BADGE_CLASS = Object.freeze({
  deterministic: 'badge-method-deterministic',
  judge: 'badge-method-judge',
});

// ---------------------------------------------------------------------------
// Inline CSS (self-contained — no external assets/CDNs/fonts/scripts)
// ---------------------------------------------------------------------------

const INLINE_STYLE = `
  :root { color-scheme: light; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    margin: 0; padding: 2rem; background: #f8fafc; color: #1e293b; line-height: 1.5;
  }
  header, section, footer { max-width: 960px; margin: 0 auto 2rem auto; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.15rem; border-bottom: 1px solid #cbd5e1; padding-bottom: 0.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  pre {
    background: #0f172a; color: #e2e8f0; padding: 0.75rem 1rem; border-radius: 6px;
    overflow-x: auto; white-space: pre-wrap; word-break: break-word;
  }
  header pre { background: #1e293b; }
  table { border-collapse: collapse; width: 100%; background: #ffffff; }
  th, td { text-align: left; padding: 0.4rem 0.75rem; border-bottom: 1px solid #e2e8f0; font-size: 0.92rem; }
  th { width: 40%; color: #475569; font-weight: 600; }
  details.dimension {
    background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px;
    margin-bottom: 0.6rem; padding: 0.5rem 0.9rem;
  }
  details.dimension summary { cursor: pointer; font-size: 0.95rem; }
  .dimension-body { margin-top: 0.6rem; }
  .badge {
    display: inline-block; padding: 0.1rem 0.5rem; border-radius: 999px;
    font-size: 0.75rem; font-weight: 600; margin-right: 0.35rem; text-transform: uppercase;
  }
  .badge-pass { background: #d1fae5; color: #065f46; }
  .badge-fail { background: #fee2e2; color: #991b1b; }
  .badge-not-applicable { background: #e2e8f0; color: #334155; }
  .badge-cannot-determine { background: #fef9c3; color: #854d0e; }
  .badge-method-deterministic { background: #e0e7ff; color: #3730a3; }
  .badge-method-judge { background: #ede9fe; color: #5b21b6; }
  .badge-advisory { background: #fed7aa; color: #7c2d12; }
  ul { padding-left: 1.25rem; }
  .limits { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 0.5rem 1rem 1rem; }
  footer { color: #64748b; font-size: 0.85rem; }
`;

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderHeader(record) {
  const runId = escapeHtml(record?.run_id);
  return `
  <header>
    <h1>aiat-llm-eval Run Report</h1>
    <p><strong>Run ID:</strong> ${runId}</p>
    <p><strong>Session ID:</strong> ${escapeHtml(record?.session_id)}</p>
    <p><strong>Re-verify this run:</strong></p>
    <pre><code>node scripts/eval-session.mjs --verify ${runId}</code></pre>
  </header>`;
}

function renderProvenance(record) {
  const model = record?.model ?? {};
  const harness = record?.harness ?? {};
  const provenance = record?.provenance ?? {};
  const rows = [
    ['Model ID', formatOrNotRecorded(model.id)],
    ['Model source', formatOrNotRecorded(model.source)],
    ['Plugin version', formatOrNotRecorded(harness.plugin_version)],
    ['Platform', formatOrNotRecorded(harness.platform)],
    ['Host class', formatOrNotRecorded(harness.host_class)],
    ['Standard version', formatOrNotRecorded(record?.standard_version)],
    ['Rubric version', formatOrNotRecorded(record?.rubric_version)],
    ['Rubric SHA-256', formatOrNotRecorded(provenance.rubric_sha256)],
    ['Engine commit', formatOrNotRecorded(provenance.engine_commit)],
    ['Hostname hash', formatOrNotRecorded(harness.hostname_hash)],
    ['Timestamp', formatOrNotRecorded(record?.timestamp)],
  ];
  const body = rows.map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`).join('\n        ');
  return `
  <section class="provenance">
    <h2>Provenance</h2>
    <table>
      <tbody>
        ${body}
      </tbody>
    </table>
  </section>`;
}

function renderKpis(record) {
  const kpis = record?.kpis ?? {};
  const rows = KPI_FIELDS.map((field) => {
    const label = KPI_LABELS[field] ?? field;
    return `<tr><th>${escapeHtml(label)}</th><td>${formatOrNotRecorded(kpis[field])}</td></tr>`;
  }).join('\n        ');
  return `
  <section class="kpis">
    <h2>KPIs</h2>
    <table>
      <tbody>
        ${rows}
      </tbody>
    </table>
  </section>`;
}

function renderDimension(dim) {
  const statusClass = STATUS_BADGE_CLASS[dim.status] ?? 'badge-not-applicable';
  const methodClass = METHOD_BADGE_CLASS[dim.method] ?? 'badge-method-deterministic';
  const advisoryBadge =
    dim.method === 'judge' ? '<span class="badge badge-advisory">ADVISORY — uncalibrated</span>' : '';
  const scoreRow = 'score' in dim ? `<p><strong>Score:</strong> ${formatOrNotRecorded(dim.score)}</p>` : '';
  return `
    <details class="dimension">
      <summary>
        <span class="badge ${statusClass}">${escapeHtml(dim.status)}</span>
        <span class="badge ${methodClass}">${escapeHtml(dim.method)}</span>
        ${advisoryBadge}
        <strong>${escapeHtml(dim.id)}</strong>
      </summary>
      <div class="dimension-body">
        <p><strong>Evidence:</strong></p>
        <pre>${escapeHtml(dim.evidence)}</pre>
        ${scoreRow}
      </div>
    </details>`;
}

function renderDimensions(record) {
  const dims = Array.isArray(record?.dimensions) ? record.dimensions : [];
  const body = dims.map((dim) => renderDimension(dim)).join('\n');
  return `
  <section class="dimensions">
    <h2>Dimensions</h2>
    ${body || '<p>No dimensions recorded.</p>'}
  </section>`;
}

function renderTriage(record) {
  const dims = Array.isArray(record?.dimensions) ? record.dimensions : [];
  const cannotDetermine = dims.filter((d) => d.status === 'cannot-determine');
  const total = dims.length;
  const count = cannotDetermine.length;
  const pct = total > 0 ? `${((count / total) * 100).toFixed(1)}%` : 'not recorded';
  const reasons =
    cannotDetermine.length > 0
      ? `<ul>${cannotDetermine
          .map((d) => `<li><strong>${escapeHtml(d.id)}:</strong> ${escapeHtml(d.evidence)}</li>`)
          .join('')}</ul>`
      : '<p>No dimensions abstained (no cannot-determine status recorded).</p>';
  return `
  <section class="triage">
    <h2>Abstention / Triage</h2>
    <p><strong>cannot-determine dimensions:</strong> ${count} of ${total} (${pct})</p>
    ${reasons}
  </section>`;
}

function renderLimits(record) {
  const dims = Array.isArray(record?.dimensions) ? record.dimensions : [];
  const judgeDims = dims.filter((d) => d.method === 'judge');
  const judgeNote =
    judgeDims.length > 0
      ? `This run includes ${judgeDims.length} judge dimension(s) (${judgeDims
          .map((d) => escapeHtml(d.id))
          .join(', ')}) — judge scoring is advisory and uncalibrated; v1 has no calibration stage.`
      : 'This run includes no judge dimensions.';
  const modelSource = record?.model?.source;
  const selfReportNote =
    modelSource === 'self-report'
      ? 'The model identity in this report is self-reported by the coordinator (model.source = "self-report") — not read from a deterministic harness source.'
      : `The model identity source for this report is "${formatOrNotRecorded(modelSource)}".`;
  return `
  <section class="limits">
    <h2>What this report does not prove</h2>
    <ul>
      <li>This is a single run (n=1) — no confidence intervals, no statistical significance.</li>
      <li>${judgeNote}</li>
      <li>${selfReportNote}</li>
      <li>Reproducibility here means an evidence + scoring replay via <code>--verify</code> — never a claim of deterministic model outputs.</li>
    </ul>
  </section>`;
}

function renderFooter(generatedAt) {
  return `
  <footer>
    <p>Report generated at: ${formatOrNotRecorded(generatedAt)}</p>
  </footer>`;
}

// ---------------------------------------------------------------------------
// Public API — render (pure)
// ---------------------------------------------------------------------------

/**
 * Render a session-eval record into a single, self-contained HTML string.
 * PURE function — no I/O, no clock reads, no randomness. The same record and
 * the same `generatedAt` string always produce byte-identical output (the
 * golden-file test in tests/eval/report.test.mjs pins this).
 *
 * @param {object} record — a session-eval record (see scripts/lib/eval/schema.mjs).
 * @param {{ generatedAt?: string }} [opts] — generatedAt is rendered verbatim
 *        (no Date parsing/formatting) so the caller controls determinism.
 * @returns {string} a complete `<!DOCTYPE html>` document.
 */
export function renderEvalReport(record, { generatedAt } = {}) {
  const titleRunId = escapeHtml(record?.run_id);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aiat-llm-eval Run Report — ${titleRunId}</title>
<style>${INLINE_STYLE}
</style>
</head>
<body>
${renderHeader(record)}
${renderProvenance(record)}
${renderKpis(record)}
${renderDimensions(record)}
${renderTriage(record)}
${renderLimits(record)}
${renderFooter(generatedAt)}
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Public API — write (never throws)
// ---------------------------------------------------------------------------

/**
 * Render and write a session-eval record's HTML report to
 * `<dir>/<run_id>.html`. NEVER throws (mirrors eval/sink.mjs's
 * appendEvalRecord contract) — both a rendering failure and a filesystem
 * failure are swallowed into a stderr WARN + `{ ok:false, ... }`.
 *
 * @param {object} record — a session-eval record; record.run_id is required
 *        to compute the output filename.
 * @param {{ dir?: string, generatedAt?: string }} [opts]
 * @returns {{ ok: true, path: string } | { ok: false, reason: 'render-error'|'fs-error', error: string }}
 */
export function writeEvalReport(record, { dir = DEFAULT_EVAL_REPORTS_DIR, generatedAt } = {}) {
  let html;
  try {
    html = renderEvalReport(record, { generatedAt });
  } catch (err) {
    const msg = err?.message ?? String(err);
    process.stderr.write(`[eval-report] WARN: could not render report: ${msg}\n`);
    return { ok: false, reason: 'render-error', error: msg };
  }

  // Charset-guard the run_id before it becomes a filename: replace anything
  // outside [A-Za-z0-9._-] with '_' so a hostile/degenerate run_id (e.g. one
  // containing '../' or path separators) can never escape `dir`.
  const safeRunId = String(record?.run_id ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  const filePath = path.join(dir, `${safeRunId}.html`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, html, 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    const msg = err?.message ?? String(err);
    process.stderr.write(`[eval-report] WARN: could not write ${filePath}: ${msg}\n`);
    return { ok: false, reason: 'fs-error', error: msg };
  }
}
