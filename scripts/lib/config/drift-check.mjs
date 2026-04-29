/**
 * drift-check.mjs — Parser for the top-level `drift-check:` YAML block.
 *
 * Ported from config-yaml-parser.sh (v2).
 */

/**
 * Parse the top-level `drift-check:` YAML block from markdown content.
 * Mirrors the shell parse_drift_check() in config-yaml-parser.sh.
 * Defaults: enabled=false, mode="warn",
 * include-paths=["CLAUDE.md","AGENTS.md","_meta/**\/*.md"] (CLAUDE.md and
 * AGENTS.md are transparent aliases per
 * skills/_shared/instruction-file-resolution.md),
 * all four per-check flags default to true.
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, mode: string, "include-paths": string[], "check-path-resolver": boolean, "check-project-count-sync": boolean, "check-issue-reference-freshness": boolean, "check-session-file-existence": boolean}}
 */
export function _parseDriftCheck(content) {
  // CLAUDE.md and AGENTS.md are transparent aliases per
  // skills/_shared/instruction-file-resolution.md. Both are included so
  // drift-check covers the project-instruction file regardless of which
  // platform created it.
  const DEFAULT_INCLUDE_PATHS = ['CLAUDE.md', 'AGENTS.md', '_meta/**/*.md'];
  const defaults = {
    enabled: false,
    mode: 'warn',
    'include-paths': DEFAULT_INCLUDE_PATHS,
    'check-path-resolver': true,
    'check-project-count-sync': true,
    'check-issue-reference-freshness': true,
    'check-session-file-existence': true,
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^drift-check:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let dcEnabled = false;
  let dcMode = 'warn';
  let dcChkPath = true;
  let dcChkCount = true;
  let dcChkIssue = true;
  let dcChkSess = true;
  const dcInclude = [];
  let inIncludeList = false;

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    if (/^\s+-\s+/.test(clean)) {
      if (inIncludeList) {
        let item = clean.replace(/^\s+-\s+/, '').trim();
        if (item.startsWith('"') && item.endsWith('"')) item = item.slice(1, -1);
        else if (item.startsWith("'") && item.endsWith("'")) item = item.slice(1, -1);
        if (item) dcInclude.push(item);
      }
      continue;
    }

    inIncludeList = false;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        dcEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['strict', 'warn', 'off'].includes(v)) dcMode = v;
        break;
      case 'include-paths':
        if (!v) inIncludeList = true;
        break;
      case 'check-path-resolver':
        dcChkPath = v.toLowerCase() !== 'false';
        break;
      case 'check-project-count-sync':
        dcChkCount = v.toLowerCase() !== 'false';
        break;
      case 'check-issue-reference-freshness':
        dcChkIssue = v.toLowerCase() !== 'false';
        break;
      case 'check-session-file-existence':
        dcChkSess = v.toLowerCase() !== 'false';
        break;
    }
  }

  return {
    enabled: dcEnabled,
    mode: dcMode,
    'include-paths': dcInclude.length > 0 ? dcInclude : DEFAULT_INCLUDE_PATHS,
    'check-path-resolver': dcChkPath,
    'check-project-count-sync': dcChkCount,
    'check-issue-reference-freshness': dcChkIssue,
    'check-session-file-existence': dcChkSess,
  };
}
