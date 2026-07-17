/**
 * scope-gate.mjs — scope / pattern primitives.
 *
 * Split out of scripts/lib/hardening.mjs (concern B). Used by Wave 3 hooks on
 * hot-paths — all sync. Re-exported by hardening.mjs as a barrel so existing
 * importers keep working unchanged.
 *
 * Layering: hook-safe — pure functions only; no I/O at import time;
 * ESM-pure for fast hook hot-paths. Hooks (under `hooks/`) import from
 * this lib; this lib MUST NOT reverse-import from `hooks/`. Cross-cutting
 * invariant for all exports below — see #554 A2.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Find the wave-scope.json file for the given project root.
 *
 * Precedence (mirrors find_scope_file in hardening.sh):
 *   <root>/.pi/wave-scope.json
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
  for (const dir of ['.pi', '.cursor', '.codex', '.claude']) {
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
 * Is this fileScope entry a glob/prefix pattern (vs. a concrete file path)?
 * A `*` metachar OR a trailing `/` (directory prefix) marks it as a glob.
 * @param {string} entry
 * @returns {boolean}
 */
function isGlobScopeEntry(entry) {
  return entry.includes('*') || entry.endsWith('/');
}

/**
 * Literal prefix of a glob entry — the segment before the first `*`
 * metachar (or the whole entry when it has none). `src/**` → `src/`,
 * `src/lib/*.mjs` → `src/lib/`, `tests/` → `tests/`.
 * @param {string} entry
 * @returns {string}
 */
function literalScopePrefix(entry) {
  const star = entry.indexOf('*');
  return star === -1 ? entry : entry.slice(0, star);
}

/**
 * Assert that every entry of an agent's declared file scope is covered by the
 * wave's `allowedPaths` union — the mechanical form of the "allowedPaths is the
 * UNION of all agent file scopes" contract (wave-loop.md § Scope Manifest #3).
 *
 * Motivation (#796): `.claude/wave-scope.json` is GLOBAL per wave — one
 * allowedPaths union gates every agent in the wave (hooks/enforce-scope.mjs
 * Gate 7). A coordinator that (re)writes the union for only ONE agent of a
 * multi-agent batch silently denies its siblings' legitimate writes (observed
 * fix-pass incident). Running this assertion for EVERY agent before dispatch
 * catches that class before an agent is blocked mid-run.
 *
 * Semantics:
 *   - CONCRETE fileScope entry (no `*`, not a `dir/` prefix): covered iff it
 *     matches ≥1 allowedPaths pattern via `pathMatchesPattern` (the same matcher
 *     the enforcement hook uses at check time). `src/a.ts` ⊆ `src/**` → covered.
 *   - GLOB fileScope entry (`*` present, or a `dir/` prefix): covered iff it is
 *     present verbatim in allowedPaths, OR its literal prefix (the segment
 *     before the first glob metachar) matches an allowedPaths pattern.
 *
 * GLOB-vs-GLOB LIMITATION (deliberate design boundary): this is NOT a full
 * glob-⊆-glob subset calculus. For a glob fileScope entry the check reduces to
 * verbatim presence + literal-prefix coverage; it does not prove that e.g.
 * `src/**\/*.ts` ⊆ `src/**\/*.js` is false. The concrete-path branch above is
 * exact and carries the incident-relevant load (the union the coordinator
 * actually writes is verbatim, deduplicated agent scopes). Erring toward
 * over-approximating coverage keeps a legitimate union from being rejected on a
 * glob technicality rather than pretending to a precision this matcher lacks.
 *
 * Fail-closed & no-throw (module convention): a non-array `fileScope` or
 * `allowedPaths` returns `{ ok: false, missing: [] }` — "cannot assert → treat
 * as failure". An empty `fileScope` is a trivial subset → `{ ok: true }`.
 * Non-string / empty-string entries are skipped (the CLI caller validates the
 * array-of-strings shape upstream). Never throws.
 *
 * @param {string[]} fileScope — one agent's declared file scope entries
 * @param {string[]} allowedPaths — the wave's allowedPaths union
 * @returns {{ ok: boolean, missing: string[] }} missing = uncovered fileScope entries
 */
export function assertFileScopeSubset(fileScope, allowedPaths) {
  if (!Array.isArray(fileScope) || !Array.isArray(allowedPaths)) {
    return { ok: false, missing: [] };
  }
  const missing = [];
  for (const entry of fileScope) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    let covered;
    if (isGlobScopeEntry(entry)) {
      // GLOB entry: verbatim presence OR literal-prefix coverage.
      const prefix = literalScopePrefix(entry);
      covered = allowedPaths.some((p) => p === entry || pathMatchesPattern(prefix, p));
    } else {
      // CONCRETE entry: must match ≥1 allowedPaths pattern.
      covered = allowedPaths.some((p) => pathMatchesPattern(entry, p));
    }
    if (!covered) missing.push(entry);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Extract likely file-write TARGETS from a Bash command string (#800).
 *
 * Motivation: `hooks/enforce-scope.mjs` Gate 1 only gates the Edit/Write/MultiEdit
 * tools — Bash write channels (heredocs, `>`/`>>` redirects, `tee`, `sed -i`,
 * `dd of=`) bypass the wave-scope gate structurally. This function is the parsing
 * half of the opt-in, WARN-ONLY `bash-write-guard` (wired in enforce-commands.mjs).
 *
 * DESIGN POSTURE — conservative, under- rather than over-match (v1 is warn-only):
 * a false NEGATIVE (missed write) is a silent no-warn; a false POSITIVE (spurious
 * warn on a benign command) is operator noise that erodes trust in the guard. When
 * in doubt we DROP the candidate. This is deliberately NOT a full shell parser.
 *
 * MATCHED write channels:
 *   (a) redirects `> p`, `>> p`, `2> p`, `2>> p`, `&> p`, `&>> p` (fd/`&` prefix ok)
 *   (b) `tee [-a] p [p2 …]` (all non-flag file args of a `tee` command-head)
 *   (c) `sed -i[.bak] … p` (the LAST non-flag argument of a `sed` command-head
 *       carrying an in-place `-i*` flag; the `sed` SCRIPT arg is not the target)
 *   (d) `dd of=p` (the `of=` argument of a `dd` command-head)
 *   (e) heredocs `cat > p <<EOF` — covered by the redirect part `(a)`; the `<<`
 *       delimiter itself is an INPUT redirect, never a write target.
 *
 * Deliberately NOT matched (documented skip rules — each is a false-positive trap):
 *   - targets beginning with `$` or `~`, or containing ANY `$` (variable /
 *     expansion — the concrete path is unknowable at parse time; e.g. `> $LOG`,
 *     `>> ${TMPDIR}/x`)
 *   - `/dev/…`, `/tmp/…`, `/private/tmp/…` (device + temp sinks — never wave scope)
 *   - process substitution `>(…)` (an operator, not a file; the `(` breaks it)
 *   - fd duplication `>&`, `2>&1` (dup, not a file target)
 *   - input redirects `<`, `<<` (reads, not writes)
 *   - quoted targets containing a space (best-effort — a spaced path is far more
 *     likely a quoting artefact than a real wave-scoped file)
 *   - a `>` / `tee` / `sed` / `dd` that appears INSIDE quotes (e.g. `echo '>' x`)
 *     — the tokenizer tracks quote state, so a quoted `>` is a word, not an op.
 *
 * Targets are returned VERBATIM (repo-relative where the command wrote them
 * relatively, absolute where the command used an absolute path) and de-duplicated
 * in first-seen order. The caller relativises + matches against allowedPaths.
 *
 * Hook-safe: pure, deterministic, no I/O. Never throws — a non-string / empty
 * input returns `[]`.
 *
 * @param {string} command — the raw Bash command string
 * @returns {string[]} de-duplicated list of likely write targets (may be empty)
 */
export function extractBashWriteTargets(command) {
  if (typeof command !== 'string' || command.length === 0) return [];

  const tokens = tokenizeShellForWrites(command);

  const out = [];
  const seen = new Set();
  const add = (value, hadSpace) => {
    if (shouldSkipWriteTarget(value, hadSpace)) return;
    const v = value.replace(/^\.\//, '');
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  // Second pass: interpret the token stream. `mode` tracks a command-head that
  // owns following args (tee/sed/dd); `pendingRedirect` marks that the NEXT word
  // token is a redirect target.
  let mode = null; // null | 'tee' | 'sed' | 'dd'
  let pendingRedirect = false;
  let expectCommand = true; // next word is the command head of this segment
  let sedArgs = []; // { value } collected for a `sed` head
  let sedInPlace = false;

  const flushSed = () => {
    if (mode === 'sed' && sedInPlace) {
      for (let i = sedArgs.length - 1; i >= 0; i--) {
        if (!isShellFlag(sedArgs[i].value)) {
          add(sedArgs[i].value, sedArgs[i].hadSpace);
          break;
        }
      }
    }
    sedArgs = [];
    sedInPlace = false;
  };

  for (const tk of tokens) {
    if (tk.type === 'redirect') {
      pendingRedirect = true;
      continue;
    }
    if (tk.type === 'in') {
      // input redirect / heredoc delimiter — not a write target
      pendingRedirect = false;
      continue;
    }
    if (tk.type === 'sep') {
      flushSed();
      mode = null;
      pendingRedirect = false;
      expectCommand = true;
      continue;
    }
    // word token
    if (pendingRedirect) {
      add(tk.value, tk.hadSpace);
      pendingRedirect = false;
      continue;
    }
    if (expectCommand) {
      expectCommand = false;
      flushSed(); // flush any prior sed segment defensively
      if (tk.value === 'tee') { mode = 'tee'; continue; }
      if (tk.value === 'sed') { mode = 'sed'; continue; }
      if (tk.value === 'dd') { mode = 'dd'; continue; }
      mode = null;
      continue;
    }
    // subsequent argument words, interpreted per active command-head mode
    if (mode === 'tee') {
      if (!isShellFlag(tk.value)) add(tk.value, tk.hadSpace);
    } else if (mode === 'sed') {
      if (/^-i/.test(tk.value)) sedInPlace = true;
      sedArgs.push(tk);
    } else if (mode === 'dd') {
      if (tk.value.startsWith('of=')) add(tk.value.slice(3), tk.hadSpace);
    }
  }
  flushSed();

  return out;
}

/**
 * Is this token a CLI flag (starts with `-`)? Used to skip flags when picking
 * file arguments for tee/sed. `-` alone (stdin) also counts as a flag.
 * @param {string} v
 * @returns {boolean}
 */
function isShellFlag(v) {
  return typeof v === 'string' && v.startsWith('-');
}

/**
 * Skip-rule gate for a candidate write target — see the documented skip list on
 * {@link extractBashWriteTargets}. Returns true when the candidate must be dropped.
 * @param {string} value — unquoted target text
 * @param {boolean} hadSpace — true if the source token was quoted AND contained a space
 * @returns {boolean}
 */
function shouldSkipWriteTarget(value, hadSpace) {
  if (typeof value !== 'string' || value.length === 0) return true;
  if (hadSpace || value.includes(' ')) return true; // quoted-with-space (best-effort)
  if (value.startsWith('$') || value.startsWith('~')) return true; // variable / expansion
  if (value.includes('$')) return true; // any embedded expansion (covers ${TMPDIR})
  if (value.includes('(') || value.includes(')')) return true; // process-sub remnants
  if (value.startsWith('/dev/')) return true; // device sink
  if (value.startsWith('/tmp/') || value.startsWith('/private/tmp/')) return true; // temp sink
  return false;
}

/**
 * Minimal quote-aware tokenizer for write-target extraction. Walks the command
 * left-to-right tracking single/double quote state; recognises redirect / input /
 * separator operators ONLY outside quotes, and emits everything else as `word`
 * tokens with the quotes stripped. Not a general shell tokenizer — it captures
 * exactly what {@link extractBashWriteTargets} needs.
 *
 * Token shapes: { type: 'redirect' } | { type: 'in' } | { type: 'sep' }
 *             | { type: 'word', value: string, hadSpace: boolean }
 *
 * @param {string} command
 * @returns {Array<{type:string, value?:string, hadSpace?:boolean}>}
 */
function tokenizeShellForWrites(command) {
  const tokens = [];
  const n = command.length;
  let i = 0;
  const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  while (i < n) {
    const c = command[i];
    const next = command[i + 1];

    if (isWs(c)) { i++; continue; }

    // `&>` / `&>>` — redirect stdout+stderr to a file (write target follows)
    if (c === '&' && next === '>') {
      i += 2;
      if (command[i] === '>') i++;
      tokens.push({ type: 'redirect' });
      continue;
    }
    // `&&` / `&` — command separators
    if (c === '&') {
      i += next === '&' ? 2 : 1;
      tokens.push({ type: 'sep' });
      continue;
    }
    // `>&` — fd duplication (NOT a file target); consume the dup + trailing fd/`-`
    if (c === '>' && next === '&') {
      i += 2;
      while (i < n && (/[0-9]/.test(command[i]) || command[i] === '-')) i++;
      continue; // no token — dup carries no write target
    }
    // `>(` — process substitution: leave the `>` inert; `(` is emitted as a sep
    if (c === '>' && next === '(') { i++; continue; }
    // `>>` / `>` — write redirects
    if (c === '>') {
      i += next === '>' ? 2 : 1;
      tokens.push({ type: 'redirect' });
      continue;
    }
    // `<<` / `<` — input redirects / heredoc delimiters (never a write target)
    if (c === '<') {
      i += next === '<' ? 2 : 1;
      tokens.push({ type: 'in' });
      continue;
    }
    // `||` / `|` / `;` / `(` / `)` — separators (break the current command)
    if (c === '|') { i += next === '|' ? 2 : 1; tokens.push({ type: 'sep' }); continue; }
    if (c === ';') { i++; tokens.push({ type: 'sep' }); continue; }
    if (c === '(' || c === ')') { i++; tokens.push({ type: 'sep' }); continue; }

    // Otherwise: read a WORD, honouring single/double quotes (quotes stripped).
    let value = '';
    let quoted = false;
    let hadSpace = false;
    while (i < n) {
      const ch = command[i];
      if (ch === "'") {
        quoted = true;
        i++;
        while (i < n && command[i] !== "'") { if (command[i] === ' ') hadSpace = true; value += command[i]; i++; }
        i++; // closing quote (or EOF)
        continue;
      }
      if (ch === '"') {
        quoted = true;
        i++;
        while (i < n && command[i] !== '"') { if (command[i] === ' ') hadSpace = true; value += command[i]; i++; }
        i++; // closing quote (or EOF)
        continue;
      }
      if (isWs(ch)) break;
      // unquoted operator chars end the word
      if (ch === '>' || ch === '<' || ch === '|' || ch === ';' || ch === '&' || ch === '(' || ch === ')') break;
      value += ch;
      i++;
    }
    tokens.push({ type: 'word', value, hadSpace, quoted });
  }

  return tokens;
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
