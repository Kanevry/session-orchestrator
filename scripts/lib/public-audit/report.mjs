const incomplete = new Set(['unavailable', 'not-fetched', 'not-measurable']);

/** Exit priority: errors precede incomplete work; opportunities alone are successful. */
export function exitCode(report) {
  if (
    (report.measurements ?? []).some(
      (item) => item.state === 'finding' && item.category === 'error',
    )
  )
    return 1;
  if ((report.measurements ?? []).some((item) => incomplete.has(item.state))) return 3;
  return 0;
}
// DEL, C1 and bidi controls; JSON.stringify already escapes C0 but none of these.
const UNSAFE = '\\u007f-\\u009f\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069';
const LINE_CONTROL = new RegExp(`[\\u0000-\\u001f${UNSAFE}]`, 'gu');
const JSON_CONTROL = new RegExp(`[${UNSAFE}]`, 'gu');
const lineText = (value) => String(value ?? '').replace(LINE_CONTROL, ' ');
const escapeControls = (json) =>
  json.replace(
    JSON_CONTROL,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
/** Valid JSON whose unsafe control characters appear only as \uXXXX escapes. */
export function renderJson(report) {
  return escapeControls(JSON.stringify(report, null, 2)) + '\n';
}
export function renderReport(report) {
  const rows = report.measurements ?? [];
  const lines = [
    `Public audit: ${lineText(report.manifest?.baseUrl)}`,
    `Observed: ${lineText(report.timestamp)}`,
    '',
  ];
  for (const [label, predicate] of [
    ['Errors', (item) => item.state === 'finding' && item.category === 'error'],
    ['Opportunities', (item) => item.state === 'finding' && item.category === 'opportunity'],
    ['OK', (item) => item.state === 'ok'],
    ['Incomplete', (item) => incomplete.has(item.state)],
  ]) {
    lines.push(label);
    const matching = rows.filter(predicate);
    if (!matching.length) lines.push('  None');
    for (const item of matching) {
      lines.push(
        `  ${lineText(item.checkId)} [${lineText(item.state)}] ${lineText(item.url)} @ ${lineText(item.timestamp)}`,
      );
      if (item.reason) lines.push(`    ${lineText(item.reason)}`);
      if (item.value !== undefined) lines.push(`    ${escapeControls(JSON.stringify(item.value))}`);
      if (item.sources?.length)
        lines.push(
          `    Sources: ${item.sources.map((source) => `${lineText(source.url)} @ ${lineText(source.timestamp)}`).join('; ')}`,
        );
    }
    lines.push('');
  }
  lines.push('Requests by host');
  for (const row of report.budget ?? []) {
    lines.push(`  ${lineText(row.host)}: ${row.requests}`);
    lines.push(
      `    Sources: ${row.sources.map((source) => `${lineText(source.url)} @ ${lineText(source.timestamp)}`).join('; ')}`,
    );
  }
  return lines.join('\n') + '\n';
}
