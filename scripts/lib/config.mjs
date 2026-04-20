/**
 * config.mjs — Session Config reader for CLAUDE.md / AGENTS.md.
 *
 * Implements the Session Config parser consumed by scripts/parse-config.mjs (the v3
 * entry point). Originally ported from parse-config.sh (v2) plus its helper libs
 * config-yaml-parser.sh and config-json-coercion.sh. Windows + CRLF safe.
 *
 * Part of v3.0.0 migration (Epic #124, issue #132).
 */

import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Internal: coercion helpers (ported from config-json-coercion.sh)
// ---------------------------------------------------------------------------

/**
 * Look up a key in the parsed KV map; returns the raw string value or the
 * given default. Last match wins (mirrors the shell `tail -1` behaviour).
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string|undefined} def
 * @returns {string|undefined}
 */
function _getVal(kv, key, def) {
  const val = kv.get(key);
  if (val !== undefined) return val;
  return def;
}

/**
 * Coerce a value to a JSON string or null.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string} [def] — omit for null default
 * @returns {string|null}
 */
function _coerceString(kv, key, def) {
  const val = _getVal(kv, key, def);
  if (val === undefined || val === '' || val === 'none' || val === 'null') return null;
  return val;
}

/**
 * Coerce a value to an integer, supporting override syntax "N (k: M)".
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {number} def
 * @returns {number | {default: number, [k: string]: number}}
 */
function _coerceInteger(kv, key, def) {
  const raw = _getVal(kv, key, String(def));

  // Override syntax: "6 (deep: 18)" or "6 (deep: 18, fast: 4)"
  const overrideMatch = raw.match(/^(\d+)\s*\(([^)]+)\)\s*$/);
  if (overrideMatch) {
    const base = parseInt(overrideMatch[1], 10);
    if (isNaN(base)) throw new Error(`config.mjs: invalid integer base for '${key}': '${raw}'`);
    const overridesStr = overrideMatch[2];
    const result = { default: base };
    for (const pair of overridesStr.split(',')) {
      const colonIdx = pair.indexOf(':');
      if (colonIdx === -1) continue;
      const okey = pair.slice(0, colonIdx).trim();
      const oval = pair.slice(colonIdx + 1).trim();
      const oint = parseInt(oval, 10);
      if (isNaN(oint) || !/^\d+$/.test(oval)) {
        throw new Error(`config.mjs: invalid integer override for '${key}.${okey}': '${oval}'`);
      }
      result[okey] = oint;
    }
    return result;
  }

  if (!/^\d+$/.test(raw)) {
    throw new Error(`config.mjs: invalid integer for '${key}': '${raw}'`);
  }
  return parseInt(raw, 10);
}

/**
 * Coerce a value to a float with optional bounds.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {number} def
 * @param {number} [min]
 * @param {number} [max] — exclusive upper bound
 * @returns {number}
 */
function _coerceFloat(kv, key, def, min, max) {
  const raw = _getVal(kv, key, String(def));

  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`config.mjs: invalid float for '${key}': '${raw}' (expected non-negative number)`);
  }
  const val = parseFloat(raw);

  if (min !== undefined && val < min) {
    throw new Error(`config.mjs: float '${key}' value '${raw}' is below minimum '${min}'`);
  }
  if (max !== undefined && val >= max) {
    throw new Error(`config.mjs: float '${key}' value '${raw}' must be less than '${max}'`);
  }
  return val;
}

/**
 * Coerce a value to a boolean.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {boolean} def
 * @returns {boolean}
 */
function _coerceBoolean(kv, key, def) {
  const raw = _getVal(kv, key, def ? 'true' : 'false');
  const lower = raw.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw new Error(`config.mjs: invalid boolean for '${key}': '${raw}' (expected true or false)`);
}

/**
 * Coerce a value to a JSON array of strings, or null.
 * Handles "[a, b, c]", "a, b, c", "[]", "none", or absent (null).
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string|null} [def] — raw default string like "[all]" or "[]"
 * @returns {string[]|null}
 */
function _coerceList(kv, key, def) {
  const raw = _getVal(kv, key, def !== undefined ? def : undefined);

  if (raw === undefined || raw === 'none' || raw === 'null') return null;

  // Strip surrounding brackets
  const stripped = raw.replace(/^\s*\[/, '').replace(/\]\s*$/, '').trim();

  if (stripped === '') return [];

  // If value contains '{', bail to null (complex object)
  if (stripped.includes('{')) return null;

  const items = stripped.split(',').map(s => s.trim()).filter(s => s.length > 0);
  return items;
}

/**
 * Coerce a value to an enum string (lower-cased), throw on invalid.
 * @param {Map<string, string>} kv
 * @param {string} key
 * @param {string} def
 * @param {string[]} allowed
 * @returns {string}
 */
export function _coerceEnum(kv, key, def, allowed) {
  const raw = _getVal(kv, key, def);
  const lower = raw.toLowerCase();
  if (!allowed.includes(lower)) {
    throw new Error(`config.mjs: ${key} must be ${allowed.join('|')}, got '${raw}'`);
  }
  return lower;
}

/**
 * Validate and normalise a collision-risk value from plan output JSON.
 * Returns the default when value is null/undefined; throws TypeError on invalid.
 * @param {*} value
 * @param {string} [def='low']
 * @returns {'low'|'medium'|'high'}
 */
export function _coerceCollisionRisk(value, def = 'low') {
  const ALLOWED = ['low', 'medium', 'high'];
  if (value === null || value === undefined) return def;
  const lower = String(value).toLowerCase();
  if (!ALLOWED.includes(lower)) {
    throw new TypeError(`_coerceCollisionRisk: must be low|medium|high, got '${value}'`);
  }
  return lower;
}

/**
 * Coerce a value to a plain object of string values, or null.
 * Handles "{ key1: val1, key2: val2 }".
 * @param {Map<string, string>} kv
 * @param {string} key
 * @returns {Record<string,string>|null}
 */
function _coerceObject(kv, key) {
  const raw = _getVal(kv, key, undefined);
  if (raw === undefined || raw === 'none' || raw === 'null') return null;

  const stripped = raw.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
  if (stripped === '') return null;

  const result = {};
  for (const pair of stripped.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    const v = pair.slice(colonIdx + 1).trim();
    if (k && v) result[k] = v;
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Coerce a value to an object of boolean values (for enforcement-gates).
 * @param {Map<string, string>} kv
 * @param {string} key
 * @returns {Record<string,boolean>|null}
 */
function _coerceBoolObject(kv, key) {
  const raw = _getVal(kv, key, undefined);
  if (raw === undefined || raw === 'none' || raw === 'null') return null;

  const stripped = raw.replace(/^\s*\{/, '').replace(/\}\s*$/, '').trim();
  if (stripped === '') return null;

  const result = {};
  for (const pair of stripped.split(',')) {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) continue;
    const k = pair.slice(0, colonIdx).trim();
    const v = pair.slice(colonIdx + 1).trim().toLowerCase();
    if (!k) continue;
    if (v === 'true') result[k] = true;
    else if (v === 'false') result[k] = false;
    else throw new Error(`config.mjs: invalid enforcement-gates value for '${k}': '${v}' (must be true or false)`);
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * Coerce max-turns: positive integer or "auto".
 * @param {Map<string, string>} kv
 * @returns {number|string}
 */
function _coerceMaxTurns(kv) {
  const raw = _getVal(kv, 'max-turns', 'auto');
  const lower = raw.toLowerCase();
  if (lower === 'auto') return 'auto';
  if (/^\d+$/.test(raw)) {
    const n = parseInt(raw, 10);
    if (n <= 0) throw new Error(`config.mjs: invalid max-turns: '${raw}' (must be positive integer or 'auto')`);
    return n;
  }
  throw new Error(`config.mjs: invalid max-turns: '${raw}' (must be positive integer or 'auto')`);
}

// ---------------------------------------------------------------------------
// Internal: section extraction (ported from config-yaml-parser.sh)
// ---------------------------------------------------------------------------

/**
 * Extract the raw ## Session Config block lines from markdown content.
 * - CRLF-tolerant
 * - Skips code fence lines (``` alone on a line)
 * - Strips trailing whitespace from each line
 * @param {string} content
 * @returns {string[]} lines of the Session Config block
 */
function _extractConfigSection(content) {
  const lines = content.split(/\r?\n/);
  const result = [];
  let inSection = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (line === '## Session Config') {
      inSection = true;
      continue;
    }

    if (inSection) {
      // Next ## header closes the section
      if (/^## /.test(line)) break;
      // Skip standalone code fences
      if (line.trim() === '```') continue;
      // Strip trailing whitespace and collect
      result.push(line.replace(/\s+$/, ''));
    }
  }

  return result;
}

/**
 * Parse the key-value pairs from extracted Session Config lines.
 * Supports Format 1: `- **key:** value`
 * Supports Format 2: plain `key: value`
 * Last occurrence of a key wins.
 * @param {string[]} lines
 * @returns {Map<string, string>}
 */
function _parseKV(lines) {
  // We accumulate all matches, last-match wins per key
  const allPairs = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    let key = '';
    let value = '';

    // Format 1: - **key:** value
    const fmt1 = line.match(/^\s*-\s+\*\*([^*:]+):\*\*\s*(.*)/);
    if (fmt1) {
      key = fmt1[1].trim();
      value = fmt1[2].trim();
    } else {
      // Format 2: key: value (key starts with letter, rest alphanum/hyphen/underscore)
      const fmt2 = line.match(/^\s*([a-zA-Z][a-zA-Z0-9_-]+):\s+(.*)/);
      if (fmt2) {
        key = fmt2[1].trim();
        value = fmt2[2].trim();
      } else {
        continue;
      }
    }

    if (!key) continue;

    // Strip surrounding double quotes from value
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }

    allPairs.push([key, value]);
  }

  // Last match wins: build the map by iterating in order
  const kv = new Map();
  for (const [k, v] of allPairs) {
    kv.set(k, v);
  }
  return kv;
}

// ---------------------------------------------------------------------------
// Internal: vault-sync block parser (ported from config-yaml-parser.sh)
// ---------------------------------------------------------------------------

/**
 * Parse the top-level `vault-sync:` YAML block from markdown content.
 * The block can appear anywhere (inside or outside ## Session Config).
 * Defaults: enabled=false, mode="warn", vault-dir=null, exclude=[].
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, mode: string, "vault-dir": string|null, exclude: string[]}}
 */
function _parseVaultSync(content) {
  const defaults = { enabled: false, mode: 'warn', 'vault-dir': null, exclude: [] };

  const lines = content.split(/\r?\n/);
  let inBlock = false;
  const blockLines = [];

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    if (!inBlock) {
      // Detect `vault-sync:` at column 0 with optional trailing spaces
      if (/^vault-sync:\s*$/.test(line)) {
        inBlock = true;
      }
      continue;
    }

    // Block terminates at first non-indented (non-whitespace-leading) line
    if (line.length > 0 && !/^\s/.test(line)) break;

    blockLines.push(line);
  }

  if (blockLines.length === 0) return defaults;

  let vsEnabled = false;
  let vsMode = 'warn';
  let vsDir = null;
  const vsExclude = [];
  let inExclude = false;

  for (const rawLine of blockLines) {
    // Strip inline comment and trailing whitespace, preserving leading indent
    const clean = rawLine.replace(/\s*#.*$/, '').replace(/\s+$/, '');
    if (!clean.trim()) continue;

    // Dash-prefixed list item
    if (/^\s+-\s+/.test(clean)) {
      if (inExclude) {
        let item = clean.replace(/^\s+-\s+/, '').trim();
        // Strip surrounding quotes
        if (item.startsWith('"') && item.endsWith('"')) item = item.slice(1, -1);
        else if (item.startsWith("'") && item.endsWith("'")) item = item.slice(1, -1);
        if (item) vsExclude.push(item);
      }
      continue;
    }

    // Any non-list line resets the exclude block state
    inExclude = false;

    // key: value under indentation
    const kvMatch = clean.match(/^\s+([a-zA-Z_-]+):\s*(.*)/);
    if (!kvMatch) continue;

    const k = kvMatch[1];
    let v = kvMatch[2].trim();
    // Strip surrounding quotes
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    else if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) v = v.slice(1, -1);

    switch (k) {
      case 'enabled':
        vsEnabled = v.toLowerCase() === 'true';
        break;
      case 'mode':
        if (['hard', 'warn', 'off'].includes(v)) vsMode = v;
        // invalid mode silently defaults to 'warn' (matches shell behaviour)
        break;
      case 'vault-dir':
        if (v && v !== 'none' && v !== 'null') vsDir = v;
        break;
      case 'exclude':
        if (!v) inExclude = true;
        break;
    }
  }

  return { enabled: vsEnabled, mode: vsMode, 'vault-dir': vsDir, exclude: vsExclude };
}

// ---------------------------------------------------------------------------
// Internal: drift-check block parser (ported from config-yaml-parser.sh)
// ---------------------------------------------------------------------------

/**
 * Parse the top-level `drift-check:` YAML block from markdown content.
 * Mirrors the shell parse_drift_check() in config-yaml-parser.sh.
 * Defaults: enabled=false, mode="warn", include-paths=["CLAUDE.md","_meta/**\/*.md"],
 * all four per-check flags default to true.
 * @param {string} content — full file contents
 * @returns {{enabled: boolean, mode: string, "include-paths": string[], "check-path-resolver": boolean, "check-project-count-sync": boolean, "check-issue-reference-freshness": boolean, "check-session-file-existence": boolean}}
 */
function _parseDriftCheck(content) {
  const defaults = {
    enabled: false,
    mode: 'warn',
    'include-paths': ['CLAUDE.md', '_meta/**/*.md'],
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
        if (['hard', 'warn', 'off'].includes(v)) dcMode = v;
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
    'include-paths': dcInclude.length > 0 ? dcInclude : ['CLAUDE.md', '_meta/**/*.md'],
    'check-path-resolver': dcChkPath,
    'check-project-count-sync': dcChkCount,
    'check-issue-reference-freshness': dcChkIssue,
    'check-session-file-existence': dcChkSess,
  };
}

// ---------------------------------------------------------------------------
// Internal: vault-integration sub-keys from Session Config KV map
// ---------------------------------------------------------------------------

/**
 * Extract vault-integration sub-keys from the Session Config KV map.
 * Sub-keys (enabled, vault-dir, mode) are stored flat in the same KV map
 * because they appear as indented YAML inside the `vault-integration:` block
 * but the shell parser treats them as top-level key-value pairs.
 * @param {Map<string, string>} kv
 * @returns {{enabled: boolean, "vault-dir": string|null, mode: string}}
 */
function _parseVaultIntegration(kv) {
  const enabled = _coerceBoolean(kv, 'enabled', false);
  const vaultDir = _coerceString(kv, 'vault-dir', undefined);
  // mode enum: warn|strict|off (hard is legacy alias — shell only allows warn/strict/off)
  const modeRaw = _getVal(kv, 'mode', 'warn');
  const modeAllowed = ['warn', 'strict', 'off'];
  const mode = modeAllowed.includes(modeRaw.toLowerCase()) ? modeRaw.toLowerCase() : 'warn';

  return { enabled, 'vault-dir': vaultDir, mode };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read CLAUDE.md or AGENTS.md from the project root.
 * Precedence: if AGENTS.md exists AND env var SO_PLATFORM === "codex", prefer AGENTS.md.
 * Otherwise CLAUDE.md. Throws if neither file found.
 * @param {string} projectRoot — absolute path to project root
 * @returns {Promise<string>} file contents as string (CRLF-tolerant)
 */
export async function readConfigFile(projectRoot) {
  const claudeMd = join(projectRoot, 'CLAUDE.md');
  const agentsMd = join(projectRoot, 'AGENTS.md');

  const isCodex = process.env.SO_PLATFORM === 'codex';

  if (isCodex) {
    // Prefer AGENTS.md for Codex platform
    try {
      await access(agentsMd);
      return await readFile(agentsMd, 'utf8');
    } catch {
      // Fall through to CLAUDE.md
    }
  }

  try {
    await access(claudeMd);
    return await readFile(claudeMd, 'utf8');
  } catch {
    // Try AGENTS.md as fallback (non-Codex)
  }

  try {
    await access(agentsMd);
    return await readFile(agentsMd, 'utf8');
  } catch {
    // Neither found
  }

  throw new Error(`config.mjs: neither CLAUDE.md nor AGENTS.md found in '${projectRoot}'`);
}

/**
 * Parse ## Session Config block from markdown content.
 * Applies all defaults for missing keys.
 * @param {string} mdContent — full CLAUDE.md content
 * @returns {object} config object with EXACT same shape as parse-config.sh stdout
 * @throws if any enum value is invalid
 */
export function parseSessionConfig(mdContent) {
  const sectionLines = _extractConfigSection(mdContent);
  const kv = _parseKV(sectionLines);

  // String fields
  const vcs = _coerceString(kv, 'vcs', undefined);
  const gitlabHost = _coerceString(kv, 'gitlab-host', undefined);
  const mirror = _coerceString(kv, 'mirror', undefined);
  const special = _coerceString(kv, 'special', undefined);
  const pencil = _coerceString(kv, 'pencil', undefined);
  const testCommand = _coerceString(kv, 'test-command', 'pnpm test --run');
  const typecheckCommand = _coerceString(kv, 'typecheck-command', 'tsgo --noEmit');
  const lintCommand = _coerceString(kv, 'lint-command', 'pnpm lint');
  const baselineRef = _coerceString(kv, 'baseline-ref', undefined);
  const baselineProjectId = _coerceString(kv, 'baseline-project-id', undefined);
  const planBaselinePath = _coerceString(kv, 'plan-baseline-path', undefined);
  const planDefaultVisibility = _coerceString(kv, 'plan-default-visibility', 'internal');
  const planPrdLocation = _coerceString(kv, 'plan-prd-location', 'docs/prd/');
  const planRetroLocation = _coerceString(kv, 'plan-retro-location', 'docs/retro/');

  // Integer fields
  const agentsPerWave = _coerceInteger(kv, 'agents-per-wave', 6);
  const waves = _coerceInteger(kv, 'waves', 5);
  const recentCommits = _coerceInteger(kv, 'recent-commits', 20);
  const issueLimit = _coerceInteger(kv, 'issue-limit', 50);
  const staleBranchDays = _coerceInteger(kv, 'stale-branch-days', 7);
  const staleIssueDays = _coerceInteger(kv, 'stale-issue-days', 30);
  const ssotFreshnessDays = _coerceInteger(kv, 'ssot-freshness-days', 5);
  const pluginFreshnessDays = _coerceInteger(kv, 'plugin-freshness-days', 30);
  const memoryCleanupThreshold = _coerceInteger(kv, 'memory-cleanup-threshold', 5);
  const learningExpiryDays = _coerceInteger(kv, 'learning-expiry-days', 30);
  const learningsSurfaceTopN = _coerceInteger(kv, 'learnings-surface-top-n', 15);
  const groundingInjectionMaxFiles = _coerceInteger(kv, 'grounding-injection-max-files', 3);
  const discoveryConfidenceThreshold = _coerceInteger(kv, 'discovery-confidence-threshold', 60);

  // Float fields
  const learningDecayRate = _coerceFloat(kv, 'learning-decay-rate', 0.05, 0.0, 1.0);

  // Boolean fields
  const persistence = _coerceBoolean(kv, 'persistence', true);
  const ecosystemHealth = _coerceBoolean(kv, 'ecosystem-health', false);
  const discoveryOnClose = _coerceBoolean(kv, 'discovery-on-close', false);
  const reasoningOutput = _coerceBoolean(kv, 'reasoning-output', false);
  const groundingCheck = _coerceBoolean(kv, 'grounding-check', true);
  const allowDestructiveOps = _coerceBoolean(kv, 'allow-destructive-ops', false);

  // List fields
  const crossRepos = _coerceList(kv, 'cross-repos', undefined);
  const ssotFiles = _coerceList(kv, 'ssot-files', undefined);
  const discoveryProbes = _coerceList(kv, 'discovery-probes', '[all]');
  const discoveryExcludePaths = _coerceList(kv, 'discovery-exclude-paths', '[]');
  const healthEndpoints = _coerceList(kv, 'health-endpoints', undefined);

  // Enum fields
  const enforcement = _coerceEnum(kv, 'enforcement', 'warn', ['strict', 'warn', 'off']);
  const isolation = _coerceEnum(kv, 'isolation', 'auto', ['worktree', 'none', 'auto']);
  const discoverySeverityThreshold = _coerceEnum(kv, 'discovery-severity-threshold', 'low', ['critical', 'high', 'medium', 'low']);

  // Object fields
  const agentMapping = _coerceObject(kv, 'agent-mapping');
  const enforcementGates = _coerceBoolObject(kv, 'enforcement-gates');

  // Special field
  const maxTurns = _coerceMaxTurns(kv);

  // vault-integration sub-keys
  const vaultIntegration = _parseVaultIntegration(kv);

  // vault-sync: parsed from full content (can live outside Session Config)
  const vaultSync = _parseVaultSync(mdContent);

  // drift-check: parsed from full content (standalone top-level block)
  const driftCheck = _parseDriftCheck(mdContent);

  return {
    'agents-per-wave': agentsPerWave,
    'waves': waves,
    'recent-commits': recentCommits,
    'special': special,
    'vcs': vcs,
    'gitlab-host': gitlabHost,
    'mirror': mirror,
    'cross-repos': crossRepos,
    'pencil': pencil,
    'ecosystem-health': ecosystemHealth,
    'health-endpoints': healthEndpoints,
    'issue-limit': issueLimit,
    'stale-branch-days': staleBranchDays,
    'stale-issue-days': staleIssueDays,
    'test-command': testCommand,
    'typecheck-command': typecheckCommand,
    'lint-command': lintCommand,
    'ssot-files': ssotFiles,
    'ssot-freshness-days': ssotFreshnessDays,
    'plugin-freshness-days': pluginFreshnessDays,
    'discovery-on-close': discoveryOnClose,
    'discovery-probes': discoveryProbes,
    'discovery-exclude-paths': discoveryExcludePaths,
    'discovery-severity-threshold': discoverySeverityThreshold,
    'discovery-confidence-threshold': discoveryConfidenceThreshold,
    'persistence': persistence,
    'memory-cleanup-threshold': memoryCleanupThreshold,
    'learning-expiry-days': learningExpiryDays,
    'learnings-surface-top-n': learningsSurfaceTopN,
    'learning-decay-rate': learningDecayRate,
    'enforcement': enforcement,
    'isolation': isolation,
    'max-turns': maxTurns,
    'baseline-ref': baselineRef,
    'baseline-project-id': baselineProjectId,
    'plan-baseline-path': planBaselinePath,
    'plan-default-visibility': planDefaultVisibility,
    'plan-prd-location': planPrdLocation,
    'plan-retro-location': planRetroLocation,
    'agent-mapping': agentMapping,
    'enforcement-gates': enforcementGates,
    'reasoning-output': reasoningOutput,
    'grounding-injection-max-files': groundingInjectionMaxFiles,
    'grounding-check': groundingCheck,
    'allow-destructive-ops': allowDestructiveOps,
    'vault-integration': vaultIntegration,
    'vault-sync': vaultSync,
    'drift-check': driftCheck,
  };
}

/**
 * Lookup a config value, falling back to default.
 * @param {object} config — result of parseSessionConfig
 * @param {string} key — key name (e.g., "agents-per-wave")
 * @param {*} defaultValue — fallback if key missing or null
 * @returns {*} the config value or defaultValue
 */
export function getConfigValue(config, key, defaultValue = null) {
  const val = config[key];
  if (val === undefined || val === null) return defaultValue;
  return val;
}
