/**
 * hardening.mjs — env/runtime checks + scope/pattern primitives.
 *
 * Node.js port of the relevant functions from scripts/lib/hardening.sh.
 * Pure ESM. No zx dependency — lightweight for hook hot-paths.
 *
 * Layering: hook-safe — pure functions only; no I/O at import time;
 * ESM-pure for fast hook hot-paths. Hooks (under `hooks/`) import from
 * this lib; this lib MUST NOT reverse-import from `hooks/`. Cross-cutting
 * invariant for all exports below — see #554 A2.
 *
 * Part of v3.0.0 migration (Epic #124, issue #135).
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveProjectDir } from './platform.mjs';

// ---------------------------------------------------------------------------
// A) Env / runtime checks
// ---------------------------------------------------------------------------

/**
 * Assert that the running Node.js version meets the minimum major version.
 * Throws an Error with a clear message if the current major is below `min`.
 * Returns void on success.
 *
 * @param {number} [min=20]
 * @returns {Promise<void>}
 */
export async function assertNodeVersion(min = 20) {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < min) {
    throw new Error(
      `Node.js ${min}+ is required, but found ${process.versions.node}. ` +
      `Please upgrade Node.js before running session-orchestrator scripts.`
    );
  }
}

/**
 * Check whether a Node module is importable.
 * Returns true on success, false on failure. Does NOT throw.
 *
 * @param {string} name — module name (e.g. "zx")
 * @returns {Promise<boolean>}
 */
export async function assertDepInstalled(name) {
  try {
    await import(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run environment checks and return a structured result.
 *
 * Hard checks (ok = false if any fail):
 *   - Node >= 20
 *
 * Soft checks (warning only):
 *   - 'zx' importable
 *   - SO_PROJECT_DIR resolvable (resolveProjectDir returns a non-empty string)
 *
 * @returns {Promise<{ok: boolean, missing: string[], warnings: string[]}>}
 */
export async function checkEnvironment() {
  const missing = [];
  const warnings = [];

  // Hard: Node >= 20
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  if (nodeMajor < 20) {
    missing.push(`node>=20 (found ${process.versions.node})`);
  }

  // Soft: zx installed
  const hasZx = await assertDepInstalled('zx');
  if (!hasZx) {
    warnings.push("'zx' is not installed — run 'npm ci' in the plugin root before executing wave scripts.");
  }

  // Soft: SO_PROJECT_DIR resolvable
  const projectDir = resolveProjectDir();
  if (!projectDir) {
    warnings.push('SO_PROJECT_DIR could not be resolved — wave scripts may not locate the project root correctly.');
  }

  return {
    ok: missing.length === 0,
    missing,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// B) Scope / pattern primitives (used by Wave 3 hooks on hot-paths — all sync)
// ---------------------------------------------------------------------------

/**
 * Find the wave-scope.json file for the given project root.
 *
 * Precedence (mirrors find_scope_file in hardening.sh):
 *   <root>/.cursor/wave-scope.json
 *   <root>/.codex/wave-scope.json
 *   <root>/.claude/wave-scope.json
 *
 * Returns the absolute path string, or null if none exist.
 * Sync (uses fs.existsSync).
 *
 * @param {string} projectRoot — absolute path to project root
 * @returns {string|null}
 */
export function findScopeFile(projectRoot) {
  for (const dir of ['.cursor', '.codex', '.claude']) {
    const candidate = path.join(projectRoot, dir, 'wave-scope.json');
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Read the enforcement level from a scope file.
 * Defaults to "strict" (fail-closed) on parse error or missing field.
 * Sync. Never throws.
 *
 * @param {string} scopeFilePath — absolute path to wave-scope.json
 * @returns {string}
 */
export function getEnforcementLevel(scopeFilePath) {
  try {
    const data = JSON.parse(readFileSync(scopeFilePath, 'utf8'));
    return data.enforcement ?? 'strict';
  } catch {
    return 'strict';
  }
}

/**
 * Check whether a named gate is enabled in the scope file.
 * Returns true if the field is missing or true, false only if explicitly false.
 * Sync. Never throws.
 *
 * @param {string} scopeFilePath — absolute path to wave-scope.json
 * @param {string} gateName — key within .gates
 * @returns {boolean}
 */
export function gateEnabled(scopeFilePath, gateName) {
  try {
    const data = JSON.parse(readFileSync(scopeFilePath, 'utf8'));
    const gates = data.gates;
    if (gates === undefined || gates === null) return true;
    const value = gates[gateName];
    if (value === undefined || value === null) return true;
    return value !== false;
  } catch {
    return true;
  }
}

/**
 * Test whether a relative file path matches a single glob-style pattern.
 *
 * Supported patterns:
 *   - `prefix/`       — directory prefix: any file under prefix/ (including nested)
 *   - `src/**\/*.ts`  — recursive glob: `**` = any depth (including zero dirs)
 *   - `src/*.ts`      — single-segment glob: `*` = one segment (no slashes)
 *   - `path/to/file`  — exact match
 *
 * Conversion order:
 *   1. Escape all regex special chars EXCEPT `*` and `/`.
 *   2. Replace `**` with `<<DBL>>` placeholder.
 *   3. Replace remaining `*` with `[^/]*` (single segment).
 *   4. Replace `<<DBL>>` with `.*` (any depth).
 *   5. Anchor: `^...$`.
 *
 * Case-sensitive. Empty pattern returns false.
 *
 * Hook-safe: pure, deterministic, no I/O. Current importers (grep-verified
 * #554 A2): hooks/wave-scope-commit-guard.mjs, hooks/enforce-scope.mjs,
 * scripts/lib/worktree-freshness.mjs, scripts/lib/pre-dispatch-check.mjs.
 *
 * @param {string} relPath
 * @param {string} pattern
 * @returns {boolean}
 */
export function pathMatchesPattern(relPath, pattern) {
  if (!pattern) return false;

  // Directory prefix shortcut: pattern ends with '/'
  if (pattern.endsWith('/')) {
    return relPath.startsWith(pattern);
  }

  // Build a regex from the glob pattern.
  // Step 1: Escape regex special chars (everything except * and /)
  const specialChars = /[.+?|[\](){}\\^$]/g;
  let regex = pattern.replace(specialChars, (ch) => `\\${ch}`);

  // Step 2: Replace `**/` with placeholder (matches zero-or-more dir segments WITH trailing slash)
  // `src/**/foo` must match `src/foo` (zero dirs) and `src/a/b/foo` (two dirs).
  // Replacing `**/` → `(.*\/)?` captures "any number of segments + slash, or nothing".
  regex = regex.replace(/\*\*\//g, '<<DBLS>>');

  // Replace remaining `**` (not followed by /) with a second placeholder.
  // MUST use a placeholder (not `.*` directly) — the single-* pass below would otherwise
  // re-process the `*` quantifier in `.*`, yielding `.[^/]*` which blocks nested paths
  // under `tests/**` etc. (issue #220).
  regex = regex.replace(/\*\*/g, '<<DBLG>>');

  // Step 3: Single * → one path segment (no slashes)
  regex = regex.replace(/\*/g, '[^/]*');

  // Step 4: Expand placeholders
  regex = regex.replace(/<<DBLS>>/g, '(.*\\/)?');
  regex = regex.replace(/<<DBLG>>/g, '.*');

  // Step 5: Anchor
  regex = `^${regex}$`;

  return new RegExp(regex).test(relPath);
}

/**
 * Shell interpreters whose QUOTED argument text is still executed as a command.
 * When a command segment's argv[0] (or `command <verb>` / `env … <verb>`) is one
 * of these, a blocked pattern found inside a quoted token is NOT inert — it is the
 * payload the interpreter will run. Includes SQL executors (`psql -c "DROP TABLE …"`)
 * and `find` (`find . -exec rm -rf {} \;`).
 *
 * Used by the quoted-payload guard in commandMatchesBlocked (#641).
 */
const SHELL_EXEC_INTERPRETERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh',
  'eval', 'xargs', 'env', 'command',
  'psql', 'mysql', 'sqlite3',
  'find',
]);

/**
 * Hand-rolled quote-aware command lexer.
 *
 * Splits a command string into tokens on UNQUOTED whitespace, tracking single- and
 * double-quote state and backslash escapes. Each token records whether ANY of its
 * characters originated inside quotes (`quoted: true`). Quote characters and the
 * escaping backslash are consumed (not part of the token text), so the returned
 * token text is the logical argument value a shell would pass.
 *
 * This is deliberately NOT node:util.parseArgs — parseArgs operates on an already-
 * tokenized argv array and does not lex raw shell strings with quote semantics.
 * No new npm dependency is introduced (hook hot-path constraint).
 *
 * Notes / scope (sufficient for the guard, not a full POSIX shell parser):
 *   - Single quotes: literal, no escapes inside (POSIX).
 *   - Double quotes: backslash escapes the next char.
 *   - Outside quotes: backslash escapes the next char (incl. whitespace → same token).
 *   - A token that mixes quoted + unquoted runs (e.g. foo"bar") is `quoted: true`
 *     because part of it came from a quoted run — conservative for the guard.
 *
 * @param {string} command
 * @returns {Array<{ text: string, quoted: boolean }>}
 */
export function tokenizeCommand(command) {
  const tokens = [];
  if (typeof command !== 'string' || command.length === 0) return tokens;

  let text = '';
  let started = false;     // a token is in progress
  let sawQuote = false;    // any char of the current token came from inside quotes
  let state = 'normal';    // 'normal' | 'single' | 'double'

  const flush = () => {
    if (started) {
      tokens.push({ text, quoted: sawQuote });
      text = '';
      started = false;
      sawQuote = false;
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (state === 'single') {
      if (ch === "'") { state = 'normal'; continue; }
      text += ch; started = true; sawQuote = true;
      continue;
    }

    if (state === 'double') {
      if (ch === '"') { state = 'normal'; continue; }
      if (ch === '\\' && i + 1 < command.length) {
        const next = command[i + 1];
        // In double quotes, backslash only escapes a small set; keep it simple:
        // consume the backslash and take the next char literally.
        text += next; started = true; sawQuote = true; i++;
        continue;
      }
      text += ch; started = true; sawQuote = true;
      continue;
    }

    // state === 'normal'
    if (ch === "'") { state = 'single'; started = true; continue; }
    if (ch === '"') { state = 'double'; started = true; continue; }
    if (ch === '\\' && i + 1 < command.length) {
      text += command[i + 1]; started = true; i++;
      continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }

    // Unquoted shell control operators become standalone tokens so chain-splitting
    // and per-segment verb detection work even without surrounding whitespace
    // (e.g. `/tmp/x;rm -rf src/`). Recognised: ; && || | & — longest match first.
    if (ch === ';' || ch === '|' || ch === '&') {
      flush();
      let op = ch;
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) { op = ch + ch; i++; }
      tokens.push({ text: op, quoted: false });
      continue;
    }

    text += ch; started = true;
  }

  // Unterminated quote → flush whatever accumulated (mark quoted so the guard treats
  // the dangling text conservatively).
  if (state === 'single' || state === 'double') sawQuote = true;
  flush();

  return tokens;
}

/**
 * Split a tokenized command into chained segments on shell control operators
 * (`;`, `&&`, `||`, `|`, `&`). Only UNQUOTED single-token operators split; an
 * operator that arrived inside quotes stays part of its segment.
 *
 * @param {Array<{ text: string, quoted: boolean }>} tokens
 * @returns {Array<Array<{ text: string, quoted: boolean }>>}
 */
function splitSegments(tokens) {
  const segments = [];
  let current = [];
  const operators = new Set([';', '&&', '||', '|', '&']);
  for (const tok of tokens) {
    if (!tok.quoted && operators.has(tok.text)) {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(tok);
  }
  segments.push(current);
  return segments.filter((s) => s.length > 0);
}

/**
 * Resolve the effective argv[0] (the command verb) for a chain segment, skipping
 * leading `VAR=value` env assignments and unwrapping `env …`/`command …` prefixes.
 * Returns the bare program name (basename, no path) or null.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {string|null}
 */
function segmentVerb(segment) {
  let i = 0;
  // Skip leading FOO=bar env assignments (unquoted).
  while (i < segment.length && !segment[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i].text)) {
    i++;
  }
  // Unwrap `env [VAR=val …]` and `command` prefixes that delegate to a real verb.
  while (i < segment.length) {
    const raw = segment[i].text;
    const verb = raw.replace(/^.*\//, ''); // basename
    if (verb === 'env') {
      i++;
      // env may carry its own VAR=val assignments before the real command
      while (i < segment.length && !segment[i].quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[i].text)) {
        i++;
      }
      continue;
    }
    if (verb === 'command') { i++; continue; }
    break;
  }
  if (i >= segment.length) return null;
  return segment[i].text.replace(/^.*\//, '');
}

/**
 * Build the case-sensitive boundary regex for a blocked pattern. Boundary chars:
 * whitespace + shell operators + quotes. Matches at start/end too.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function boundaryRegex(pattern) {
  const escaped = pattern.replace(/[.*+?|[\](){}\\^$]/g, '\\$&');
  const boundary = '[\\s;|&(){}`\'"]';
  return new RegExp(`(^|${boundary})${escaped}(${boundary}|$)`);
}

/**
 * Test whether a blocked pattern occurs in the raw concatenation of a segment's
 * QUOTED token payloads (with the boundary rule applied per token). Used to decide
 * whether an interpreter segment carries the pattern inside its quoted argument.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {RegExp} re
 * @returns {boolean}
 */
function quotedTokensMatch(segment, re) {
  for (const tok of segment) {
    if (tok.quoted && re.test(tok.text)) return true;
  }
  return false;
}

/**
 * Test whether a blocked pattern occurs OUTSIDE quoted tokens within a segment.
 * Reconstructs the unquoted skeleton (quoted tokens replaced by a single space
 * placeholder so they cannot bridge an adjacent-token match) and applies the
 * boundary regex.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @param {RegExp} re
 * @returns {boolean}
 */
function unquotedSegmentMatch(segment, re) {
  const skeleton = segment.map((t) => (t.quoted ? ' ' : t.text)).join(' ');
  return re.test(skeleton);
}

/**
 * Test whether a command string contains a blocked pattern with shell-aware
 * boundaries AND a quoted-payload guard (#641).
 *
 * Verb detection stays boundary-tolerant: a pattern that appears UNQUOTED — including
 * across shell operators (`ls;rm -rf /`, `ls&&rm -rf /`, `(rm -rf /)`, piped into
 * `xargs rm -rf`, prefixed by `FOO=1 …`) — still matches.
 *
 * Quoted-payload guard: a pattern whose ONLY occurrences are wholly inside quoted
 * tokens is treated as inert literal text (no match) UNLESS the enclosing chain
 * segment's verb (argv[0], after skipping env-assignments and unwrapping
 * `env`/`command`) is a shell-exec interpreter (`bash -c "rm -rf /"`,
 * `eval "…"`, `psql -c "DROP TABLE …"`, `find … -exec …`). The guard is applied
 * PER chain segment: a quoted pattern in segment N is judged against segment N's verb.
 *
 * Boundary characters: whitespace, shell operators (`;`, `|`, `&`, `(`, `)`,
 * `{`, `}`, backtick), or string quotes (`'`, `"`). Case-sensitive.
 *
 * @param {string} command — full command string
 * @param {string} pattern — blocked pattern to search for
 * @returns {boolean}
 */
export function commandMatchesBlocked(command, pattern) {
  if (!pattern) return false;
  if (typeof command !== 'string' || command.length === 0) return false;

  const re = boundaryRegex(pattern);

  // Fast path: if the boundary regex does not match the raw string at all, no
  // tokenization can produce a match. (Tokenization strips quotes, so it cannot
  // create new matches the raw string lacks for our boundary set.)
  if (!re.test(command)) return false;

  const segments = splitSegments(tokenizeCommand(command));

  for (const segment of segments) {
    // 1) Unquoted occurrence anywhere in the segment → always a match.
    if (unquotedSegmentMatch(segment, re)) return true;

    // 2) Quoted occurrence → only a match when the segment verb is an interpreter
    //    that executes its quoted payload.
    if (quotedTokensMatch(segment, re)) {
      const verb = segmentVerb(segment);
      if (verb && SHELL_EXEC_INTERPRETERS.has(verb)) return true;
      // else: inert literal inside quotes for a non-interpreter verb → no match
      // for THIS segment; keep scanning other segments.
    }
  }

  return false;
}

/**
 * Build an actionable suggestion string for a scope violation.
 *
 * @param {string} relPath — the relative path that was blocked
 * @param {string} allowedCsv — comma-separated list of allowed paths (may be empty)
 * @returns {string}
 */
export function suggestForScopeViolation(relPath, allowedCsv) {
  if (!allowedCsv) {
    return (
      `No paths are currently allowed for this wave. ` +
      `If '${relPath}' is in-scope, update the session plan and restart the wave.`
    );
  }
  return (
    `Allowed paths: [${allowedCsv}]. ` +
    `If '${relPath}' belongs to this wave, add its directory to the plan's wave scope and restart.`
  );
}

/**
 * Build an actionable suggestion string for a blocked command pattern.
 *
 * @param {string} pattern — the blocked command pattern
 * @returns {string}
 */
export function suggestForCommandBlock(pattern) {
  switch (pattern) {
    case 'rm -rf':
      return 'Destructive deletion is blocked. Move specific files instead or use trash-cli.';
    case 'git push --force':
    case 'git push -f':
      return "Force-push is blocked. Use 'git push --force-with-lease' after coordinator approval.";
    case 'git reset --hard':
      return "Hard reset is blocked. Use 'git reset --soft' or 'git stash' to preserve work.";
    case 'git checkout -- .':
      return 'Whole-tree discard is blocked. Target specific files instead.';
    default:
      return `Blocked command pattern '${pattern}' is not permitted during wave execution.`;
  }
}
