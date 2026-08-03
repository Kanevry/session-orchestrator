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

import { tokenizeCommand } from './command-blocker.mjs';

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
 * Default production→test sibling rules (#970). `source` is matched with
 * {@link pathMatchesPattern}; `sibling` is a TEMPLATE expanded with `{basename}`
 * (filename without its extension) and `{dir}` (dirname, no trailing slash).
 *
 * This repo's layout only. Consumer repos override via `opts.rules` — observed
 * shapes there are `{ source: '**\/*.ts', sibling: '{dir}/{basename}.test.*' }`,
 * `{ source: '**\/*.ts', sibling: '{dir}/__tests__/**' }` and
 * `{ source: 'supabase/migrations/**', sibling: 'supabase/tests/**' }`.
 *
 * @type {ReadonlyArray<{source: string, sibling: string}>}
 */
export const DEFAULT_TEST_SIBLING_RULES = Object.freeze([
  Object.freeze({ source: '**/*.mjs', sibling: 'tests/**/{basename}*.test.mjs' }),
]);

/**
 * Patterns that identify an entry as ALREADY test-side. Used for the
 * no-inverse-expansion rule and, transitively, for idempotency.
 * @type {ReadonlyArray<string>}
 */
export const DEFAULT_TEST_PATH_PATTERNS = Object.freeze([
  'tests/**',
  'test/**',
  '**/__tests__/**',
  '**/*.test.*',
  '**/*.spec.*',
]);

/**
 * The wave roles for which test-sibling expansion (#970) fires. THE list — the
 * prose in `skills/wave-executor/wave-loop.md` § Scope Manifest and
 * `.cursor/rules/030-wave-execution.mdc` describes this constant; it does not
 * restate it. Canonical casing; comparison is case-insensitive (see
 * {@link testSiblingExpansionApplies}).
 *
 * Impl-Core / Impl-Polish are exactly where the incident occurred (an agent
 * changes a production file and must update its test). Every other role is a
 * documented non-expansion case: Discovery is deny-all `[]`, Quality phase 1
 * (Simplification) MUST NOT gain test-write access, Quality phase 2 is already
 * test-only (expansion is inert), Finalization writes no source.
 *
 * @type {ReadonlyArray<string>}
 */
export const TEST_SIBLING_EXPANSION_ROLES = Object.freeze(['Impl-Core', 'Impl-Polish']);

/** Lower-cased lookup set for {@link testSiblingExpansionApplies}. @type {ReadonlySet<string>} */
const EXPANSION_ROLE_KEYS = new Set(TEST_SIBLING_EXPANSION_ROLES.map((r) => r.toLowerCase()));

/**
 * Does test-sibling expansion (#970) apply for these options? The SINGLE
 * predicate behind both {@link expandTestSiblings} (which grants the siblings)
 * and {@link assertTestSiblingCoverage} (which requires them). They must agree:
 * a check that demands coverage the expander never produced blocks a dispatch
 * for a requirement nobody was told to satisfy.
 *
 * Precedence — `enabled` (explicit, BOTH directions) > `role` > fail-closed:
 *   1. `enabled === false` → NO. The unconditional opt-out; nothing overrides it.
 *   2. `enabled === true`  → YES. Explicit opt-in, for callers whose role
 *      vocabulary is not this repo's (consumer repos) and for focused tests.
 *   3. `role` present → YES iff it is in {@link TEST_SIBLING_EXPANSION_ROLES}
 *      (trimmed, case-insensitive — plans and `wave-scope.json` are written by
 *      LLM prose, and `impl-core` vs `Impl-Core` must not silently change
 *      behaviour).
 *   4. Otherwise (role ABSENT, non-string, or UNRECOGNISED) → NO.
 *
 * ## Why absent-role fails CLOSED (the load-bearing choice)
 * The two failure directions are not symmetric. Expansion wrongly OMITTED
 * blocks an agent's write: it fails loudly, at the tool boundary, and the agent
 * reports `blocked` — recoverable in one re-union. Expansion wrongly APPLIED
 * silently hands write access to the test suite; in a Quality phase-1
 * Simplification wave that is the "delete a dead export, then edit the test to
 * match" failure mode, which defeats the very gate the wave exists to run.
 * Silent-permissive is strictly worse than loud-restrictive, and this module's
 * convention is already "cannot assert → treat as failure"
 * (see {@link assertFileScopeSubset}). So a caller must NAME a role (or opt in
 * explicitly); forgetting is not a grant.
 *
 * @param {{enabled?: boolean, role?: string}} [opts]
 * @returns {boolean}
 */
export function testSiblingExpansionApplies(opts = {}) {
  if (opts === null || typeof opts !== 'object') return false;
  if (opts.enabled === false) return false;
  if (opts.enabled === true) return true;
  if (typeof opts.role !== 'string') return false;
  return EXPANSION_ROLE_KEYS.has(opts.role.trim().toLowerCase());
}

/**
 * Expand a wave scope list with the TEST SIBLING of every concrete production
 * file it grants (#970).
 *
 * ## The bug this closes
 * An `allowedPaths` / agent `fileScope` entry that lists a production file
 * WITHOUT its test sibling mechanically prevents the agent from updating that
 * test. Observed three times in one consumer-repo session: a SQL regression test
 * that could not be written, a cross-tenant security test left unwritable while
 * its subject file stayed red, and a suite left red because the importing test
 * lay outside every agent's scope. The scope guard enforced exactly the
 * inconsistency the quality gate exists to catch.
 *
 * ## Why a GLOB and not a computed path
 * The emitted sibling is `tests/**\/{basename}*.test.mjs`, never a concrete
 * path. Measured over all 430 tracked production `.mjs` in this repo:
 * a naive 1:1 mirror (`scripts/lib/X.mjs → tests/lib/X.test.mjs`) is right
 * 301/430 = 70.0% (`hooks/_lib` 0/5, `scripts/ci/` 0/1); a same-basename test
 * ANYWHERE under `tests/` is right 368/430 = 85.6%. The glob takes the 85.6%
 * form, and its failure mode is HARMLESS — it grants write access to files that
 * may not exist. A computed concrete path is wrong 30% of the time AND still
 * denies the real test, which is the original bug wearing a new face.
 *
 * ## Required behaviours (each is a nameable regression)
 *  1. `[]` → `[]` STRUCTURALLY. Discovery waves use an empty scope as a
 *     deliberate deny-all contract (#256 NO-OP); expansion must never be able to
 *     resurrect a write there.
 *  2. IDEMPOTENT — `expand(expand(x))` deep-equals `expand(x)`. The #796
 *     re-union path rewrites the manifest mid-wave and the scope MUST NEVER
 *     shrink, so expansion has to compose with a re-run. Guaranteed by (4): every
 *     synthesized entry is itself a test path and is therefore inert on re-entry.
 *  3. ABSOLUTE entries pass through untouched — a Gate-5b out-of-repo grant
 *     (`/Users/…/vault/**`) must not sprout a synthetic `tests/**` sibling
 *     outside the repo.
 *  4. NO INVERSE EXPANSION — a test path never causes a production path to be
 *     added. Quality phase 2's scope is already test-only; expansion is inert there.
 *  5. ROLE-GATED, fail-closed — the wave's `role` decides, via the shared
 *     predicate {@link testSiblingExpansionApplies}, and `opts.enabled` overrides
 *     it in both directions. Quality phase 1 (Simplification) must NOT expand, or
 *     simplification agents gain write access to the suite (the "delete a dead
 *     export, then edit the test to match" failure mode). An absent or
 *     unrecognised role does not expand — see the predicate for why.
 *
 * Glob source entries (`src/**`, `src/`) are NOT expanded: they have no single
 * basename, and the incident shape is a concrete production FILE.
 *
 * APPEND-ONLY: the returned array starts with the input entries in their original
 * order (deduplicated), then the synthesized siblings in first-seen order.
 *
 * Pure: no I/O, no filesystem probing, never throws. A non-array input returns `[]`.
 *
 * @param {string[]} paths — a wave `allowedPaths` union OR one agent's `fileScope`
 * @param {{enabled?: boolean, role?: string,
 *          rules?: ReadonlyArray<{source: string, sibling: string}>,
 *          testPathPatterns?: ReadonlyArray<string>}} [opts]
 * @returns {string[]} the input entries followed by synthesized test-sibling globs
 */
export function expandTestSiblings(paths, opts = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return []; // behaviour 1
  const entries = paths.filter((e) => typeof e === 'string' && e.length > 0);
  const seen = new Set(entries);
  const out = [...new Set(entries)];
  if (!testSiblingExpansionApplies(opts)) return out; // behaviour 5

  for (const sibling of testSiblingsFor(entries, opts)) {
    if (seen.has(sibling)) continue;
    seen.add(sibling);
    out.push(sibling);
  }
  return out;
}

/**
 * The synthesized test-sibling globs for a scope list, in first-seen order —
 * WITHOUT the original entries. Shared by {@link expandTestSiblings} and the
 * `--assert-subset` coverage check so both agree on what a sibling is.
 *
 * @param {string[]} entries — already-filtered non-empty string entries
 * @param {{rules?: ReadonlyArray<{source: string, sibling: string}>,
 *          testPathPatterns?: ReadonlyArray<string>}} [opts]
 * @returns {string[]}
 */
export function testSiblingsFor(entries, opts = {}) {
  const rules = Array.isArray(opts.rules) ? opts.rules : DEFAULT_TEST_SIBLING_RULES;
  const testPatterns = Array.isArray(opts.testPathPatterns)
    ? opts.testPathPatterns
    : DEFAULT_TEST_PATH_PATTERNS;
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry !== 'string' || entry.length === 0) continue;
    if (path.isAbsolute(entry)) continue; // behaviour 3
    if (isGlobScopeEntry(entry)) continue; // no single basename to mirror
    if (isTestPathEntry(entry, testPatterns)) continue; // behaviours 2 + 4
    for (const rule of rules) {
      if (!rule || typeof rule.source !== 'string' || typeof rule.sibling !== 'string') continue;
      if (!pathMatchesPattern(entry, rule.source)) continue;
      const sibling = renderSiblingTemplate(rule.sibling, entry);
      if (!sibling || seen.has(sibling)) continue;
      seen.add(sibling);
      out.push(sibling);
    }
  }
  return out;
}

/**
 * Is this entry already test-side? Behaviours 2 + 4 both reduce to this check.
 * @param {string} entry
 * @param {ReadonlyArray<string>} testPatterns
 * @returns {boolean}
 */
function isTestPathEntry(entry, testPatterns) {
  return testPatterns.some((p) => pathMatchesPattern(entry, p));
}

/**
 * Expand `{basename}` / `{dir}` in a sibling template against a production path.
 * `{basename}` is the filename with its final extension removed.
 * @param {string} template
 * @param {string} entry
 * @returns {string}
 */
function renderSiblingTemplate(template, entry) {
  const base = entry.slice(entry.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const basename = dot > 0 ? base.slice(0, dot) : base;
  const slash = entry.lastIndexOf('/');
  const dir = slash === -1 ? '.' : entry.slice(0, slash);
  return template.replaceAll('{basename}', basename).replaceAll('{dir}', dir);
}

/**
 * Assert that the wave's `allowedPaths` union grants the TEST SIBLING of every
 * concrete production file in an agent's declared `fileScope` (#970).
 *
 * Companion to {@link assertFileScopeSubset}, wired into
 * `validate-wave-scope.mjs --assert-subset --expand-test-siblings`. That flag is
 * the one mechanical, fail-closed enforcement point in the dispatch pipeline (it
 * exits 1); a warn there would be decorative, since warnings in that script do
 * not affect the exit code.
 *
 * DIRECTION MATTERS: this expands the AGENT'S fileScope and requires the union to
 * cover the result. Expanding `allowedPaths` instead would WEAKEN
 * `--assert-subset` — its value is that it is a conservative over-approximation,
 * and growing the union makes more things trivially "covered". This only ever
 * ADDS a requirement; a manifest that passed the plain subset check can now fail,
 * never the reverse.
 *
 * A synthesized glob `G` counts as covered when ANY of:
 *   1. `G` is present verbatim in allowedPaths;
 *   2. some allowedPaths entry MATCHES `G` — the union already grants a concrete
 *      file that IS a test sibling (`tests/lib/x.test.mjs` ⊨ `tests/**\/x*.test.mjs`);
 *   3. `G`'s literal prefix is covered by an allowedPaths pattern — the same
 *      glob rule {@link assertFileScopeSubset} uses (a broad `tests/**` grant).
 *
 * ROLE-GATED BY THE SAME PREDICATE as the expander
 * ({@link testSiblingExpansionApplies}). This is not symmetry for its own sake:
 * a Quality phase-1 union is production files with tests deliberately excluded,
 * so an ungated assertion would demand coverage that phase must never grant and
 * would hard-block its dispatch. When the gate is off the assertion adds NO
 * requirement (`{ ok: true }`) rather than failing closed — "expansion did not
 * fire here" and "the union is deficient" are different facts, and only the
 * second is a dispatch blocker. Non-array inputs still fail closed
 * (`{ ok: false }`), matching the module convention.
 *
 * @param {string[]} fileScope — one agent's declared file scope
 * @param {string[]} allowedPaths — the wave's allowedPaths union
 * @param {object} [opts] — same shape as {@link expandTestSiblings} (incl. `role`)
 * @returns {{ok: boolean, missing: string[]}} missing = uncovered sibling globs
 */
export function assertTestSiblingCoverage(fileScope, allowedPaths, opts = {}) {
  if (!Array.isArray(fileScope) || !Array.isArray(allowedPaths)) {
    return { ok: false, missing: [] };
  }
  if (!testSiblingExpansionApplies(opts)) return { ok: true, missing: [] };
  const missing = [];
  for (const sibling of testSiblingsFor(fileScope, opts)) {
    const prefix = literalScopePrefix(sibling);
    const covered = allowedPaths.some(
      (p) =>
        typeof p === 'string' &&
        p.length > 0 &&
        (p === sibling || pathMatchesPattern(p, sibling) || pathMatchesPattern(prefix, p)),
    );
    if (!covered) missing.push(sibling);
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
 * ## Lexing is DELEGATED to the shared tokenizer (#970)
 *
 * This function used to carry its OWN Bash lexer (`tokenizeShellForWrites`) —
 * the third in this repo that had to know about quoting. It knew nothing about
 * comments, here-doc BODIES or ANSI-C `$'…'` quotes, so it carried the exact
 * quote-desync defect #965 fixed in `tokenizeCommand`: one apostrophe in an
 * ordinary shell comment (`# don't`) wedged it in single-quote state and every
 * later `>` became quoted text. Measured before the fix — `# don't\necho x >
 * src/secret.ts` returned `[]`, i.e. an out-of-scope write was INVISIBLE to the
 * wave-scope write guard. Two here-doc and ANSI-C variants did the same.
 *
 * It now delegates to `tokenizeCommand` from `./command-blocker.mjs`, which
 * already emits the `>`/`>>`/`<<`/`;`/`|`/`&` operator tokens this pass needs
 * and is the single place comment / here-doc / quote semantics live. Layering
 * holds: `command-blocker.mjs` imports NOTHING (measured), so the edge
 * scope-gate → command-blocker adds no cycle, and both stay pure/no-I/O-at-
 * import for the hook hot path. The barrel `hardening.mjs` is not involved (a
 * module importing the barrel WOULD cycle).
 *
 * Two deltas the shared token stream does not carry, handled locally below:
 *   - `(`/`)`: `tokenizeCommand` keeps them inside word text (they are not
 *     control operators for its purpose). {@link peelSubshellParens} splits them
 *     back out as separators so `(echo x > y)` still yields `y` and
 *     `> >(cat)` still yields nothing.
 *   - here-doc BODY tokens arrive as ordinary quoted words. They are DATA, and a
 *     body is multi-line, so the whitespace skip rule in
 *     {@link shouldSkipWriteTarget} drops them. (The delimiter word itself now
 *     emits no token at all — an improvement: `tee out.txt <<EOF` used to report
 *     the literal `EOF` as a second write target.)
 *
 * Hook-safe: pure, deterministic, no I/O. Never throws — a non-string / empty
 * input returns `[]`.
 *
 * @param {string} command — the raw Bash command string
 * @returns {string[]} de-duplicated list of likely write targets (may be empty)
 */
export function extractBashWriteTargets(command) {
  if (typeof command !== 'string' || command.length === 0) return [];

  const tokens = classifyShellTokens(tokenizeCommand(command));

  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (shouldSkipWriteTarget(value)) return;
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
  // A here-doc was opened: `tokenizeCommand` will emit its BODY as an ordinary
  // quoted word token, and a single-word body (`hello`) would otherwise be read
  // as a `tee`/`sed`/`dd` file argument. Explicit `>` redirect targets stay
  // accepted — those carry their own operator and cannot be body text.
  let heredocOpen = false;
  let expectCommand = true; // next word is the command head of this segment
  let sedArgs = []; // { value } collected for a `sed` head
  let sedInPlace = false;

  const flushSed = () => {
    if (mode === 'sed' && sedInPlace) {
      for (let i = sedArgs.length - 1; i >= 0; i--) {
        if (!isShellFlag(sedArgs[i].value)) {
          add(sedArgs[i].value);
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
    if (tk.type === 'heredoc') {
      // here-doc: the delimiter emits no token; the BODY arrives later as data
      pendingRedirect = false;
      heredocOpen = true;
      continue;
    }
    if (tk.type === 'in') {
      // input redirect / here-string — not a write target
      pendingRedirect = false;
      continue;
    }
    if (tk.type === 'sep') {
      flushSed();
      mode = null;
      pendingRedirect = false;
      heredocOpen = false;
      expectCommand = true;
      continue;
    }
    // word token
    if (pendingRedirect) {
      add(tk.value);
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
    if (heredocOpen) continue; // DATA, not a file argument
    if (mode === 'tee') {
      if (!isShellFlag(tk.value)) add(tk.value);
    } else if (mode === 'sed') {
      if (/^-i/.test(tk.value)) sedInPlace = true;
      sedArgs.push(tk);
    } else if (mode === 'dd') {
      if (tk.value.startsWith('of=')) add(tk.value.slice(3));
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
 * @param {string} value — unquoted target text (quotes already stripped by the lexer)
 * @returns {boolean}
 */
function shouldSkipWriteTarget(value) {
  if (typeof value !== 'string' || value.length === 0) return true;
  // Any embedded whitespace: a quoted-with-space path (best-effort — far more
  // likely a quoting artefact than a real wave-scoped file) and, since #970, a
  // multi-line here-doc BODY token that reached an argument slot as DATA.
  if (/\s/.test(value)) return true;
  if (value.startsWith('$') || value.startsWith('~')) return true; // variable / expansion
  if (value.includes('$')) return true; // any embedded expansion (covers ${TMPDIR})
  if (value.includes('(') || value.includes(')')) return true; // process-sub remnants
  if (value.startsWith('/dev/')) return true; // device sink
  if (value.startsWith('/tmp/') || value.startsWith('/private/tmp/')) return true; // temp sink
  return false;
}

/** Unquoted `tokenizeCommand` operator texts that break the current command. */
const SHELL_SEPARATOR_OPS = new Set([';', '|', '||', '&', '&&']);
/** Write redirects: `>`, `>>`, `>|`, and fd-prefixed forms (`2>`, `2>>`). */
const WRITE_REDIRECT_OP_RE = /^\d*(?:>>|>\|?)$/;
/** Here-doc operators `<<` / `<<-` — a DATA body token follows at the next newline. */
const HEREDOC_OP_RE = /^\d*<<-?$/;
/** Other input redirects `<` / `<<<` (here-string) — never a write target, no body. */
const INPUT_REDIRECT_OP_RE = /^\d*(?:<<<|<)$/;

/**
 * Split leading `(` / trailing `)` off an UNQUOTED word token into standalone
 * separator tokens.
 *
 * `tokenizeCommand` does not treat parentheses as control operators (it does not
 * need to), so `(echo x > y)` arrives as words `(echo` … `y)`. Without this the
 * subshell's redirect target would read as the literal `y)` and be dropped by the
 * paren skip rule in {@link shouldSkipWriteTarget} — a silent DETECTION LOSS
 * versus the pre-#970 lexer. Peeling restores it, and process substitution
 * `> >(cat)` still yields nothing because the peeled `cat` lands in command-head
 * position rather than redirect-target position.
 *
 * Quoted tokens are never peeled: `echo '(' x` must keep its literal paren.
 *
 * @param {{text: string, quoted: boolean}} tok
 * @returns {Array<{type: string, value?: string}>}
 */
function peelSubshellParens(tok) {
  if (tok.quoted) return [{ type: 'word', value: tok.text }];
  let text = tok.text;
  const out = [];
  while (text.startsWith('(')) { out.push({ type: 'sep' }); text = text.slice(1); }
  const trailing = [];
  while (text.endsWith(')')) { trailing.push({ type: 'sep' }); text = text.slice(0, -1); }
  if (text.length > 0 || (out.length === 0 && trailing.length === 0)) {
    out.push({ type: 'word', value: text });
  }
  return out.concat(trailing);
}

/**
 * Re-shape the shared `tokenizeCommand` output into the redirect/in/sep/word
 * stream {@link extractBashWriteTargets} interprets. Operator classification is
 * applied ONLY to unquoted tokens, so `echo '>' x` keeps its `>` as literal text.
 *
 * `&>` is not a distinct token here: `tokenizeCommand` deliberately lexes it as
 * `&` followed by `>` (#965 Risk C). That still works — the redirect branch of the
 * interpretation loop is checked before the command-head branch, so `cmd &> log`
 * yields `log`. `2>&1` likewise yields nothing: the `&` separator resets the
 * pending redirect before `1` is read.
 *
 * Token shapes: { type: 'redirect' } | { type: 'in' } | { type: 'sep' }
 *             | { type: 'word', value: string }
 *
 * @param {Array<{text: string, quoted: boolean}>} tokens
 * @returns {Array<{type: string, value?: string}>}
 */
function classifyShellTokens(tokens) {
  const out = [];
  for (const tok of tokens) {
    if (!tok.quoted) {
      if (SHELL_SEPARATOR_OPS.has(tok.text)) { out.push({ type: 'sep' }); continue; }
      if (WRITE_REDIRECT_OP_RE.test(tok.text)) { out.push({ type: 'redirect' }); continue; }
      if (HEREDOC_OP_RE.test(tok.text)) { out.push({ type: 'heredoc' }); continue; }
      if (INPUT_REDIRECT_OP_RE.test(tok.text)) { out.push({ type: 'in' }); continue; }
    }
    out.push(...peelSubshellParens(tok));
  }
  return out;
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
