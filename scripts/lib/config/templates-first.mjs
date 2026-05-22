/**
 * templates-first.mjs — Parser for the top-level `templates-first:` YAML block
 * (PRD gsd Pattern Adoption Quick-Wins — Pattern 3 / issues #517, #519).
 *
 * Drives the pre-bash hook that blocks `gh|glab pr|mr|issue create` calls
 * unless the matching repo template (.github/PULL_REQUEST_TEMPLATE,
 * .gitlab/merge_request_templates/*, …) was Read in the current session.
 *
 * Returns `{ enabled, hosts }`.
 * Tolerant parser: malformed values silently fall back to defaults.
 *
 * Consumer: `hooks/pre-bash-templates-first.mjs` (Wave 2).
 */

const ALLOWED_HOSTS = new Set(['github', 'gitlab']);
const DEFAULT_HOSTS = ['github', 'gitlab'];

/**
 * Parse the top-level `templates-first:` YAML block from markdown content.
 * Independent of the `## Session Config` section boundary.
 *
 * Defaults:
 *   enabled: true
 *   hosts:   ['github', 'gitlab']
 *
 * @param {string} content — full file contents
 * @returns {{ enabled: boolean, hosts: string[] }}
 */
export function _parseTemplatesFirst(content) {
  const defaults = {
    enabled: true,
    hosts: [...DEFAULT_HOSTS],
  };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (!inBlock) {
      if (/^templates-first:\s*$/.test(line)) inBlock = true;
      continue;
    }
    if (line.length > 0 && !/^\s/.test(line)) break;
    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let tfEnabled = true;
  let tfHosts = [...DEFAULT_HOSTS];

  for (const rawLine of blockLines) {
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        // Default is true → only flip to false on explicit "false"
        tfEnabled = v.toLowerCase() !== 'false';
        break;
      case 'hosts': {
        const stripped = v.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();
        if (stripped === '') {
          tfHosts = [];
        } else {
          const items = stripped
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .filter((s) => ALLOWED_HOSTS.has(s));
          if (items.length > 0) tfHosts = items;
        }
        break;
      }
    }
  }

  return {
    enabled: tfEnabled,
    hosts: tfHosts,
  };
}
