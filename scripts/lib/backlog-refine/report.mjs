/**
 * report.mjs — report object and Markdown rendering of the backlog checker
 * (#2094). Contract: docs/backlog-refinement.md § Data contract.
 */

const MAX_FINDINGS_PER_CHECK = 25;
const TITLE_MAX = 80;

/**
 * Assemble the report object of the contract.
 *
 * @param {object} input
 * @param {{ vcs: string, host: string, projectPath: string }} input.target resolved target (fetch.mjs `resolveTarget`)
 * @param {ReturnType<typeof import('./criteria.mjs').evaluateBacklog>} input.evaluation
 * @param {string} input.measuredAt ISO timestamp
 * @param {number} input.closedDays
 * @returns {object} report, `schema: 1`
 */
export function buildReport({ target, evaluation, measuredAt, closedDays }) {
  return {
    schema: 1,
    repo: { vcs: target?.vcs, host: target?.host, project: target?.projectPath },
    measured_at: measuredAt,
    window: { closed_days: closedDays },
    population: evaluation.population,
    taxonomy: evaluation.taxonomy,
    checks: evaluation.checks,
    findings: evaluation.findings,
    metrics: evaluation.metrics,
    epics: evaluation.epics,
  };
}

/**
 * Make tracker text safe for one Markdown line or table cell: newlines
 * collapsed, trimmed, `|` escaped, optionally truncated.
 *
 * @param {unknown} text
 * @param {number} [max]
 */
function inline(text, max = Infinity) {
  // Tracker text is untrusted: drop control and bidi-override characters so a
  // title cannot drive the terminal (ESC, BEL, OSC) or reorder the line.
  let s = String(text ?? '')
    // eslint-disable-next-line no-control-regex -- stripping them is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.replace(/\|/g, '\\|');
}

/** @param {object} check */
function result(check) {
  if (check.state !== 'measured') return `not measured (${inline(check.reason)})`;
  // A lookup that failed is neither a hit nor a clean result: say so beside the count.
  const unmeasured = check.unmeasured > 0 ? ` (${check.unmeasured} not measured)` : '';
  return `${check.fired}/${check.of}${unmeasured}${check.noisy ? ' (noisy)' : ''}`;
}

/**
 * Render the report for a human reader. Noisy checks become one summary line;
 * each other check lists at most 25 findings.
 *
 * @param {ReturnType<typeof buildReport>} report
 * @returns {string}
 */
export function renderMarkdown(report) {
  const lines = [];
  const repo = report.repo ?? {};
  lines.push(`# Backlog refinement: ${inline(repo.project)}`, '');
  lines.push(`- Repository: ${inline(repo.host)}/${inline(repo.project)} (${inline(repo.vcs)})`);
  lines.push(`- Measured at: ${inline(report.measured_at)}`);
  lines.push(
    `- Population: ${report.population?.open ?? 0} open, ${report.population?.closed_in_window ?? 0} closed in the last ${report.window?.closed_days ?? '?'} days`,
    '',
  );

  const checks = Array.isArray(report.checks) ? report.checks : [];
  lines.push('## Checks', '', '| Check | Scope | Severity | Result |', '|---|---|---|---|');
  for (const c of checks) lines.push(`| ${inline(c.id)} | ${inline(c.scope)} | ${inline(c.severity)} | ${result(c)} |`);
  lines.push('');

  const findings = Array.isArray(report.findings) ? report.findings : [];
  const byCheck = new Map();
  for (const f of findings) {
    if (!byCheck.has(f.check)) byCheck.set(f.check, []);
    byCheck.get(f.check).push(f);
  }
  const ordered = [...checks.filter((c) => c.severity === 'warn'), ...checks.filter((c) => c.severity !== 'warn')];
  lines.push('## Findings', '');
  let any = false;
  for (const c of ordered) {
    const list = byCheck.get(c.id);
    if (!list || list.length === 0) continue;
    any = true;
    if (c.noisy) {
      lines.push(`- ${c.id}: fired on ${c.fired} of ${c.of} — too frequent to list, re-aim the check or fix the cause in bulk`);
      continue;
    }
    lines.push(`### ${c.id} (${c.severity})`, '');
    for (const f of list.slice(0, MAX_FINDINGS_PER_CHECK)) {
      const sev = f.severity !== c.severity ? ` [${f.severity}]` : '';
      lines.push(`- #${f.iid} ${inline(f.title, TITLE_MAX)} — ${inline(f.detail)}${sev}`);
    }
    if (list.length > MAX_FINDINGS_PER_CHECK) lines.push(`- … and ${list.length - MAX_FINDINGS_PER_CHECK} more`);
    lines.push('');
  }
  if (!any) lines.push('No findings.', '');

  const m = report.metrics ?? {};
  const age = m.age_days ?? {};
  lines.push('## Metrics', '');
  lines.push(`- Status: ready ${m.ready ?? 0}, in progress ${m.in_progress ?? 0}, review ${m.review ?? 0}, blocked ${m.blocked ?? 0}`);
  lines.push(`- Ready without warn finding: ${m.ready_clean ?? 'not measured'}`);
  lines.push(`- Age of open issues (days): q1 ${age.q1 ?? '-'}, median ${age.median ?? '-'}, q3 ${age.q3 ?? '-'}, max ${age.max ?? '-'}`);
  lines.push(`- Older than 90 days: ${m.older_than_90_days ?? 0}`);
  lines.push(`- Closed with every checkbox unchecked: ${m.closed_all_unchecked ?? 0}`);
  lines.push(`- Closed without merge request: ${m.closed_without_mr ?? 0}`, '');

  const epics = Array.isArray(report.epics) ? report.epics : [];
  lines.push('## Epics', '');
  if (epics.length === 0) lines.push('No epics.');
  for (const e of epics) {
    lines.push(`- #${e.iid} ${inline(e.title, TITLE_MAX)} — open children ${e.open_children?.length ?? 0}, closed children ${e.closed_children?.length ?? 0}`);
  }
  lines.push('');
  return lines.join('\n');
}
