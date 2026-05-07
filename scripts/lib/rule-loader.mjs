/**
 * Rule Loader — issue #336 glob-scoped rules.
 *
 * Reads `.claude/rules/*.md` files, parses optional YAML `globs:` frontmatter,
 * and returns the subset of rules applicable to a given set of file paths.
 *
 * Rules with no `globs:` frontmatter are always-on (loaded for every wave).
 * Rules with `globs:` load only when at least one `scopePath` matches at least
 * one glob pattern.
 *
 * Parse errors fall back to always-on — a rule is never silently dropped.
 *
 * @module rule-loader
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { createRequire } from 'node:module';

// ---------------------------------------------------------------------------
// Picomatch integration (available in the project's node_modules).
// We resolve it dynamically so the module stays loadable in environments where
// picomatch is absent — the inline fallback glob-to-RegExp takes over then.
// ---------------------------------------------------------------------------

let _picomatch = null;

function getPicomatch() {
  if (_picomatch !== null) return _picomatch;
  try {
    const require = createRequire(import.meta.url);
    _picomatch = require('picomatch');
  } catch {
    // picomatch not available — will use inline fallback
    _picomatch = false;
  }
  return _picomatch;
}

/**
 * Minimal glob-to-RegExp fallback used only when picomatch is absent.
 * Handles `**`, `*`, and literal character matching.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegExp(pattern) {
  // Normalize Windows separators
  const p = pattern.replace(/\\/g, '/');
  let re = '';
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      // `**` — match zero or more path segments
      re += '.*';
      i += 2;
      // Consume optional trailing separator
      if (p[i] === '/') i++;
    } else if (c === '*') {
      // `*` — match any characters except separator
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '.') {
      re += '\\.';
      i++;
    } else {
      // Escape regex-special characters
      re += c.replace(/[$()+[\]^{|}]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Returns true when `filePath` matches `globPattern` using picomatch (or the
 * inline fallback when picomatch is absent).
 *
 * @param {string} filePath - path relative to repo root, forward-slash separated
 * @param {string} globPattern
 * @returns {boolean}
 */
function matchGlob(filePath, globPattern) {
  const pm = getPicomatch();
  if (pm) {
    return pm.isMatch(filePath, globPattern, { dot: true });
  }
  return globToRegExp(globPattern).test(filePath);
}

// ---------------------------------------------------------------------------
// Minimal YAML frontmatter parser (matches state-md.mjs style)
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Parses the `globs:` field from a YAML frontmatter block.
 *
 * Returns:
 *   - `{ globs: string[] }` when `globs:` is present and valid
 *   - `{ globs: null }` when no frontmatter or no `globs:` key (always-on)
 *   - throws `Error` on malformed frontmatter so the caller can fall back
 *
 * Only the `globs:` key is extracted; other keys are ignored.
 *
 * @param {string} contents - raw file contents
 * @returns {{ globs: string[] | null }}
 */
function parseGlobsFrontmatter(contents) {
  const match = FRONTMATTER_RE.exec(contents);
  if (!match) return { globs: null };

  const fmText = match[1];
  const lines = fmText.split(/\r?\n/);

  let globsValue = null;
  let inGlobs = false;

  for (const line of lines) {
    const rstripped = line.replace(/\s+$/, '');

    // Skip blank lines and comments
    if (rstripped === '' || /^\s*#/.test(rstripped)) {
      // If inside a `globs:` block, a blank line ends the sequence only if
      // the next non-blank line is at col 0 (a new key). We just keep inGlobs
      // until we hit a non-indented non-blank line.
      continue;
    }

    if (inGlobs) {
      // Inside a `globs:` block — expect `  - value` indented lines
      const seqMatch = rstripped.match(/^(\s+)-\s+(.*)/);
      if (seqMatch) {
        const raw = seqMatch[2].trim().replace(/^["']|["']$/g, '');
        if (!Array.isArray(globsValue)) globsValue = [];
        globsValue.push(raw);
        continue;
      }
      // Non-indented line — end of globs block
      inGlobs = false;
    }

    // Top-level key detection
    if (/^\s/.test(rstripped)) {
      // Indented but not in a known block — skip (another block's continuation)
      continue;
    }

    const colonIdx = rstripped.indexOf(':');
    if (colonIdx === -1) {
      throw new Error(`Malformed frontmatter line: ${JSON.stringify(rstripped)}`);
    }

    const key = rstripped.slice(0, colonIdx).trim();
    const valuePart = rstripped.slice(colonIdx + 1).trim();

    if (key === 'globs') {
      if (valuePart === '') {
        // Block-style list follows
        inGlobs = true;
        globsValue = [];
      } else if (valuePart.startsWith('[') && valuePart.endsWith(']')) {
        // Flow-style: globs: ["src/**", "lib/**"]
        const inner = valuePart.slice(1, -1).trim();
        globsValue = inner === ''
          ? []
          : inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
      } else {
        // Single inline value (unusual but handle gracefully)
        globsValue = [valuePart.replace(/^["']|["']$/g, '')];
      }
    }
    // Ignore all other keys
  }

  return { globs: globsValue };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {object} RuleEntry
 * @property {string} path - absolute path to the rule file
 * @property {string} content - raw file contents
 * @property {boolean} alwaysOn - true when no `globs:` frontmatter is present
 * @property {string[]} matchedGlobs - globs that matched; empty when alwaysOn
 */

/**
 * Loads rule files from `rulesDir` and returns those applicable to the given
 * `scopePaths`.
 *
 * Rules without `globs:` frontmatter are always included (alwaysOn: true).
 * Rules with `globs:` are included only when at least one scopePath matches at
 * least one glob pattern.
 *
 * On frontmatter parse error, the rule is treated as always-on and a warning
 * is emitted to stderr — rules are never silently dropped.
 *
 * @param {object} opts
 * @param {string} opts.rulesDir - absolute path to the directory containing rule *.md files
 * @param {string[]} [opts.scopePaths] - paths (relative to repo root) to match against globs
 * @returns {RuleEntry[]}
 */
export function loadApplicableRules({ rulesDir, scopePaths = [] }) {
  /** @type {string[]} */
  let entries;
  try {
    entries = readdirSync(rulesDir);
  } catch (err) {
    process.stderr.write(`[rule-loader] Cannot read rulesDir ${rulesDir}: ${err.message}\n`);
    return [];
  }

  // Normalize scopePaths to forward slashes for consistent matching
  const normalizedScope = scopePaths.map((p) => p.replace(/\\/g, '/'));

  /** @type {RuleEntry[]} */
  const results = [];

  for (const entry of entries) {
    if (extname(entry) !== '.md') continue;

    const filePath = join(rulesDir, entry);
    let content;

    try {
      content = readFileSync(filePath, 'utf8');
    } catch (err) {
      process.stderr.write(`[rule-loader] Cannot read ${filePath}: ${err.message}\n`);
      continue;
    }

    let globs;
    let parseError = false;

    try {
      ({ globs } = parseGlobsFrontmatter(content));
    } catch (err) {
      process.stderr.write(
        `[rule-loader] Frontmatter parse error in ${filePath}: ${err.message} — treating as always-on\n`,
      );
      globs = null;
      parseError = true;
    }

    if (globs === null) {
      // No globs frontmatter (or parse error) → always-on
      results.push({
        path: filePath,
        content,
        alwaysOn: true,
        matchedGlobs: [],
        ...(parseError ? { _parseError: true } : {}),
      });
      continue;
    }

    if (globs.length === 0) {
      // Empty globs array: matches nothing (intentionally scoped out)
      continue;
    }

    // Check whether any scopePath matches any glob
    const matchedGlobs = [];
    for (const glob of globs) {
      const matched = normalizedScope.some((sp) => matchGlob(sp, glob));
      if (matched) {
        matchedGlobs.push(glob);
      }
    }

    if (matchedGlobs.length > 0) {
      results.push({
        path: filePath,
        content,
        alwaysOn: false,
        matchedGlobs,
      });
    }
  }

  return results;
}
