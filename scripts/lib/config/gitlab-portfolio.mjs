/**
 * gitlab-portfolio.mjs — Parser for the top-level `gitlab-portfolio:` YAML block.
 */

/** Default values for the gitlab-portfolio block. */
export const GITLAB_PORTFOLIO_DEFAULTS = {
  enabled: false,
  mode: 'warn',
  'stale-days': 30,
  'critical-labels': ['priority:critical', 'priority:high'],
};

const VALID_MODES = new Set(['warn', 'strict', 'off']);

/**
 * Coerce a raw `gitlab-portfolio` block (already parsed as a plain object) into a
 * normalized, fully-defaulted config object.
 *
 * Unknown keys are dropped silently. Invalid types fall back to defaults.
 * Returns the defaults object when input is missing or not a plain object.
 *
 * @param {unknown} raw
 * @returns {{ enabled: boolean, mode: 'warn'|'strict'|'off', 'stale-days': number, 'critical-labels': string[] }}
 */
export function coerceGitlabPortfolio(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...GITLAB_PORTFOLIO_DEFAULTS, 'critical-labels': [...GITLAB_PORTFOLIO_DEFAULTS['critical-labels']] };
  }

  // enabled: only strict true is coerced to true
  const enabled = raw['enabled'] === true;

  // mode: must be one of warn | strict | off, otherwise default
  const mode = VALID_MODES.has(raw['mode']) ? /** @type {'warn'|'strict'|'off'} */ (raw['mode']) : 'warn';

  // stale-days: finite integer >= 1, otherwise default
  const rawStaleDays = raw['stale-days'];
  const staleDays =
    typeof rawStaleDays === 'number' &&
    Number.isFinite(rawStaleDays) &&
    Number.isInteger(rawStaleDays) &&
    rawStaleDays >= 1
      ? rawStaleDays
      : GITLAB_PORTFOLIO_DEFAULTS['stale-days'];

  // critical-labels: array of non-empty strings; filter out invalid entries, fall back to defaults if result is empty or invalid
  const rawLabels = raw['critical-labels'];
  let criticalLabels;
  if (Array.isArray(rawLabels)) {
    const filtered = rawLabels.filter((l) => typeof l === 'string' && l.length > 0);
    criticalLabels = filtered.length > 0 ? filtered : [...GITLAB_PORTFOLIO_DEFAULTS['critical-labels']];
  } else {
    criticalLabels = [...GITLAB_PORTFOLIO_DEFAULTS['critical-labels']];
  }

  return { enabled, mode, 'stale-days': staleDays, 'critical-labels': criticalLabels };
}

/**
 * Parse the top-level `gitlab-portfolio:` YAML block from markdown content.
 * Returns fully-defaulted values when the block is absent or malformed.
 *
 * @param {string} content — full file contents (CLAUDE.md or AGENTS.md)
 * @returns {{ enabled: boolean, mode: 'warn'|'strict'|'off', 'stale-days': number, 'critical-labels': string[] }}
 */
export function _parseGitlabPortfolio(content) {
  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^gitlab-portfolio:\s*$/.test(line)) inBlock = true;
      continue;
    }
    // A non-empty line without leading whitespace signals end of block
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) {
    return { ...GITLAB_PORTFOLIO_DEFAULTS, 'critical-labels': [...GITLAB_PORTFOLIO_DEFAULTS['critical-labels']] };
  }

  let gpEnabled = false;
  let gpMode = /** @type {'warn'|'strict'|'off'} */ ('warn');
  let gpStaleDays = GITLAB_PORTFOLIO_DEFAULTS['stale-days'];
  let gpCriticalLabels = /** @type {string[]|null} */ (null);
  let inCriticalLabelsBlock = false;

  for (const rawLine of blockLines) {
    // Strip inline comments and trailing whitespace
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // List item under critical-labels (deeper indent with leading `- `)
    if (inCriticalLabelsBlock) {
      const listMatch = clean.match(/^\s{3,}-\s+(.*)/);
      if (listMatch) {
        let val = listMatch[1].trim();
        if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1);
        else if (val.startsWith("'") && val.endsWith("'") && val.length >= 2) val = val.slice(1, -1);
        if (val.length > 0) {
          if (gpCriticalLabels === null) gpCriticalLabels = [];
          gpCriticalLabels.push(val);
        }
        continue;
      }
    }

    // Top-level key under gitlab-portfolio (2-space indent)
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    inCriticalLabelsBlock = false;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        gpEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (VALID_MODES.has(v)) gpMode = /** @type {'warn'|'strict'|'off'} */ (v);
        break;
      case 'stale-days': {
        const n = parseFloat(v);
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) gpStaleDays = n;
        break;
      }
      case 'critical-labels':
        // Value is empty (block style) — switch to list-collection mode
        inCriticalLabelsBlock = true;
        break;
    }
  }

  const criticalLabels =
    gpCriticalLabels !== null && gpCriticalLabels.length > 0
      ? gpCriticalLabels
      : [...GITLAB_PORTFOLIO_DEFAULTS['critical-labels']];

  return { enabled: gpEnabled, mode: gpMode, 'stale-days': gpStaleDays, 'critical-labels': criticalLabels };
}
