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

import { tokenizeCommand, splitChainSegments, resolveSegmentVerb } from './command-blocker.mjs';

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
 * ## Segment-first, wrapper-aware verb resolution (#996.2)
 *
 * The interpretation is SEGMENT-first: the token stream is split on shell chain
 * operators / newlines by {@link splitChainSegments} BEFORE it is interpreted,
 * and each segment's real command verb is resolved through the shared
 * {@link resolveSegmentVerb} wrapper table. A lone `expectCommand` flag used to
 * read the FIRST word of a segment as the command head, so a transparent wrapper
 * (`sudo`, `env FOO=1`, `timeout 5`, `nice -n 10`, `command`, `/usr/bin/time`)
 * consumed the head slot and the REAL verb (`tee`/`sed`/`dd`) landed in argument
 * position where it was never matched — measured `sudo tee src/x.ts` → `[]`, a
 * DETECTION LOSS. This is the same fail-open class #991 closed in the ledger
 * guard, in a warn-only (#800) consumer. `resolveSegmentVerb` unwraps the
 * wrappers and returns a BASENAME-normalized verb, so an absolute `/usr/bin/tee`
 * resolves to `tee` for free. It ALSO reports wrapper-written file operands
 * (`writesFile: true`, the #992 discriminator) — `/usr/bin/time -o FILE npm test`
 * truncates FILE while the verb is `npm`, a write with no redirect operator and
 * no tee/sed/dd head; those are harvested exactly as {@link extractRedirectTargets}
 * does.
 *
 * Hook-safe: pure, deterministic, no I/O. Never throws — a non-string / empty
 * input returns `[]`.
 *
 * @param {string} command — the raw Bash command string
 * @returns {string[]} de-duplicated list of likely write targets (may be empty)
 */
export function extractBashWriteTargets(command) {
  if (typeof command !== 'string' || command.length === 0) return [];

  const out = [];
  const seen = new Set();
  const add = (value) => {
    if (shouldSkipWriteTarget(value)) return;
    const v = value.replace(/^\.\//, '');
    if (!v || seen.has(v)) return;
    seen.add(v);
    out.push(v);
  };

  // Segment-first (#996.2): split on shell chain operators / newlines BEFORE
  // interpreting, then resolve each segment's REAL verb through the shared
  // wrapper table. `out`/`seen`/`add` stay outside the loop so de-duplication
  // and first-seen ordering hold across segments (`echo a > x; echo b >> x`).
  for (const segment of splitChainSegments(tokenizeCommand(command))) {
    // #996.2 namespace fix: resolve the verb in the SAME (paren-peeled,
    // redirect-target-excluded) namespace the interpretation loop's `wordsSeen`
    // counter walks below — see {@link verbResolutionSegment}. Passing the RAW
    // segment mis-resolved a LEADING redirect (`> a.txt tee b.ts` → verb `>`) or a
    // LEADING subshell paren (`(tee inner.ts)` → verb `(tee`): mode never became
    // `tee`/`sed`/`dd` and the `index + 1` head-skip then swallowed the real
    // write target. For A5's 10 wrapper forms (no leading redirect/paren) the view
    // is a no-op, so verb/index/wrapperArgs — incl. the #992 `writesFile` marks —
    // are byte-identical to the raw call.
    const { verb, index, wrapperArgs } = resolveSegmentVerb(verbResolutionSegment(segment));
    const tokens = classifyShellTokens(segment);

    // A wrapper can WRITE a file through its OWN option, with no redirect and no
    // tee/sed/dd verb: `/usr/bin/time -o src/report.txt npm test` truncates
    // src/report.txt while the resolved verb is `npm`. `resolveSegmentVerb` marks
    // exactly those operands `writesFile: true` (the #992 discriminator that
    // keeps `nice -n 10` / `sudo -u root` operands OUT). Harvest them exactly as
    // collectRedirectTargets does — the write is otherwise invisible to this pass.
    for (const wa of wrapperArgs) {
      if (wa.writesFile === true && typeof wa.value === 'string') add(wa.value);
    }

    // `mode` tracks a command-head that owns following args (tee/sed/dd). It is
    // set ONCE per segment from the resolved verb, which `resolveSegmentVerb`
    // returns basename-normalized — so an absolute `/usr/bin/tee` resolves to
    // `tee` for free. `pendingRedirect` marks that the NEXT word is a redirect
    // target; `heredocOpen` that a here-doc BODY word (DATA) follows.
    const mode = verb === 'tee' || verb === 'sed' || verb === 'dd' ? verb : null;
    let pendingRedirect = false;
    let heredocOpen = false;
    const sedArgs = []; // classified word tokens collected for a `sed -i` head
    let sedInPlace = false;

    // THE ONE CARE POINT of the #996.2 refactor: the first `index + 1` WORD
    // tokens that REACH the `wordsSeen` counter are the wrapper chain + the verb
    // itself, never file arguments. `index` now comes from
    // {@link verbResolutionSegment}, which resolves the verb in the SAME namespace
    // this loop walks — paren-peeled words with redirect targets removed — so
    // `index` is 1:1 with the `word` tokens that reach the counter below (a
    // leading redirect or subshell paren no longer shifts it out of alignment).
    // `peelSubshellParens` emits AT MOST one `word` per raw token.
    const headWordsToSkip = index + 1;
    let wordsSeen = 0;

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
        // Within a segment the ONLY seps are peeled subshell parens — chain
        // operators were already consumed by splitChainSegments. Reset only the
        // pending redirect so `> >(cat)` stays inert (without it the peeled `cat`
        // reads as the redirect target); mode/heredoc reset live at segment end.
        pendingRedirect = false;
        continue;
      }
      // word token
      if (pendingRedirect) {
        add(tk.value);
        pendingRedirect = false;
        continue;
      }
      if (wordsSeen < headWordsToSkip) {
        wordsSeen++; // wrapper chain + verb head — not a file argument
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

    // Segment end: flush a pending `sed -i` file argument (last non-flag arg).
    // Only reached once per segment now that each segment carries a single verb,
    // so the former sep-branch / defensive flushes are unnecessary.
    if (mode === 'sed' && sedInPlace) {
      for (let i = sedArgs.length - 1; i >= 0; i--) {
        if (!isShellFlag(sedArgs[i].value)) {
          add(sedArgs[i].value);
          break;
        }
      }
    }
  }

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
 * Project a raw chain segment into the token list used for VERB resolution,
 * in the SAME namespace {@link extractBashWriteTargets}'s interpretation loop
 * walks with its `wordsSeen` counter (#996.2 namespace fix).
 *
 * {@link resolveSegmentVerb} resolves argv[0] from RAW tokens. Two segment shapes
 * put a NON-verb token in raw position 0 and so mis-resolve the command head,
 * losing the write target the pre-#996.2 pass had detected:
 *   - a LEADING write-redirect — `> a.txt tee b.ts` resolves the `>` operator as
 *     the "verb" (mode never becomes `tee`), and the loop's `index + 1` head-skip
 *     then swallows `tee`, dropping `b.ts`.
 *   - a LEADING subshell paren — `(tee inner.ts)` keeps the raw token `(tee`
 *     (`.replace(/^.*\//,'')` leaves it untouched, no `/`), so the wrapper table
 *     never matches: verb is the literal `(tee`, again mode-less. The classified
 *     stream peels the paren AFTER, so the raw verb index and the peeled word
 *     stream diverge.
 *
 * The projection makes both namespaces agree: peel leading/trailing parens off
 * each unquoted token (matching {@link peelSubshellParens}' WORD output) and drop
 * every write-redirect operator together with its target word — exactly the
 * tokens the interpretation loop keeps OUT of `wordsSeen` (redirect operators are
 * not `word`s; their targets are consumed by the `pendingRedirect` branch before
 * the counter). The resulting segment's verb INDEX is then 1:1 with `wordsSeen`,
 * so `index + 1` skips the wrapper chain + verb and no more.
 *
 * A5's 10 transparent-wrapper forms carry neither a leading redirect nor a paren,
 * so this is a NO-OP for them: `resolveSegmentVerb`'s verb/index/wrapperArgs (incl.
 * the #992 `writesFile` operand marks) are byte-identical to the raw-segment call.
 *
 * @param {Array<{ text: string, quoted: boolean }>} segment
 * @returns {Array<{ text: string, quoted: boolean }>}
 */
function verbResolutionSegment(segment) {
  const out = [];
  let pendingRedirectTarget = false;
  for (const tok of segment) {
    if (!tok.quoted) {
      // A write redirect consumes the NEXT token as its target — neither the
      // operator nor its target reaches `wordsSeen`, so both must be absent here
      // to keep the verb index aligned.
      if (WRITE_REDIRECT_OP_RE.test(tok.text)) {
        pendingRedirectTarget = true;
        continue;
      }
      // heredoc / input-redirect operators carry no immediate target token that
      // reaches `wordsSeen` (the here-doc delimiter emits nothing; an input target
      // DOES reach the counter and so is kept) — drop only the operator itself.
      if (HEREDOC_OP_RE.test(tok.text) || INPUT_REDIRECT_OP_RE.test(tok.text)) {
        pendingRedirectTarget = false;
        continue;
      }
      // Within a segment the only separator that can appear is an fd-dup `&`
      // (e.g. `2>&1`), which classifyShellTokens also treats as a `sep` that
      // resets the pending redirect — mirror that so the target after it stays.
      if (SHELL_SEPARATOR_OPS.has(tok.text)) {
        pendingRedirectTarget = false;
        continue;
      }
    }
    if (pendingRedirectTarget) {
      pendingRedirectTarget = false;
      continue; // this token is the dropped write-redirect target
    }
    if (tok.quoted) {
      out.push(tok);
      continue;
    }
    let text = tok.text;
    while (text.startsWith('(')) text = text.slice(1);
    while (text.endsWith(')')) text = text.slice(0, -1);
    if (text.length === 0) continue; // pure paren = a separator, not a word
    out.push({ text, quoted: false });
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

/**
 * Merge many agents' declared file scopes into ONE deduplicated, order-stable
 * list — the mechanical form of "allowedPaths is the UNION of all agent file
 * scopes" (#1020, wave-loop.md § Scope Manifest #3).
 *
 * Motivation: today the coordinator writes `wave-scope.json` `allowedPaths` from
 * one hand-kept list and the agent briefs from a SECOND, separately formulated
 * list. Nothing couples them; they diverged five times in one session (#1020).
 * Deriving the union FROM the per-agent declarations makes that divergence
 * structurally impossible instead of discipline-dependent.
 *
 * Accepts BOTH input shapes, because the two call sites differ:
 *   - `[['a.mjs','b.mjs'], ['c.mjs']]`                 — bare scope arrays
 *   - `[{id:'W1-D1', files:['a.mjs']}, {id:'W1-D2', …}]` — the CLI/plan record
 *     shape, which is also {@link findScopeCollisions}' input (one source object
 *     feeding both consumers is the whole point of #1020).
 *
 * Order is INSERTION order (first-seen wins), never sorted: the union is written
 * into a manifest that a human reads next to the plan, and a stable order keeps
 * its diff readable across re-unions (#796 rewrites it mid-wave).
 *
 * Fail-closed & no-throw (module convention): a non-array input returns `[]`;
 * non-array / non-object members and non-string, empty entries are skipped.
 * Pure, sync, no I/O — hook-safe per the module header.
 *
 * @param {Array<string[]|{id?: string, files?: string[]}>} scopes
 * @returns {string[]} deduplicated union in first-seen order
 */
export function unionFileScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  const out = [];
  const seen = new Set();
  for (const scope of scopes) {
    let files = null;
    if (Array.isArray(scope)) files = scope;
    else if (scope !== null && typeof scope === 'object' && Array.isArray(scope.files)) {
      files = scope.files;
    }
    if (files === null) continue;
    for (const entry of files) {
      if (typeof entry !== 'string' || entry.length === 0) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
    }
  }
  return out;
}

/**
 * Is this scope entry RECURSIVE — does it grant everything below a directory?
 * `**` is the explicit form; a trailing `/` is the implicit one, because
 * {@link pathMatchesPattern} matches a `dir/` prefix with `startsWith`, i.e. at
 * ANY depth. Both must count, or `tests/` vs `tests/lib/*.mjs` reads as disjoint.
 * @param {string} entry
 * @returns {boolean}
 */
function isRecursiveScopeEntry(entry) {
  return entry.includes('**') || entry.endsWith('/');
}

/**
 * Literal SUFFIX of a glob entry — the text after its last `*` metachar
 * (`src/**\/*.mjs` → `.mjs`, `src/**` → `''`). Returns `null` for an entry with
 * no `*` at all (a `dir/` prefix), where the concept does not apply: such an
 * entry constrains only the head of a path, never its tail.
 * @param {string} entry
 * @returns {string|null}
 */
function literalScopeSuffix(entry) {
  const star = entry.lastIndexOf('*');
  return star === -1 ? null : entry.slice(star + 1);
}

/**
 * Normalize the `agentScopes` input of {@link findScopeCollisions} into
 * `{id, declaredId, files}` records. Never throws; malformed members are
 * repaired rather than dropped.
 *
 * A member with NO usable `id` keeps its files in the check under a synthetic
 * `<unnamed#i>` id (i = its index). Dropping it instead would be a FALSE
 * NEGATIVE — the whole point of this function is that an unreviewed scope is
 * exactly the one that collides.
 *
 * @param {Array<{id?: string, files?: string[]}>} agentScopes
 * @returns {Array<{id: string, declaredId: string|null, files: string[]}>}
 */
function normalizeAgentScopes(agentScopes) {
  const out = [];
  for (let i = 0; i < agentScopes.length; i++) {
    const raw = agentScopes[i];
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const declaredId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
    const files = Array.isArray(raw.files)
      ? raw.files.filter((f) => typeof f === 'string' && f.length > 0)
      : [];
    out.push({ id: declaredId ?? `<unnamed#${i}>`, declaredId, files });
  }
  return out;
}

/**
 * Classify a SINGLE cross-agent entry pair, in the binding three-stage order.
 * Returns the collision `kind`, or `null` when the two entries are disjoint.
 *
 * Stage order is not cosmetic — see {@link findScopeCollisions} for why the two
 * exact stages must run BEFORE the approximate one.
 *
 * @param {string} x — an entry from agent A
 * @param {string} y — an entry from agent B
 * @param {(glob: string) => Set<string>} expand — memoized KNOWN-set expander
 * @returns {'concrete'|'glob-expanded'|'glob-prefix'|null}
 */
function classifyEntryCollision(x, y, expand) {
  // Stage 1 — exact string equality. The commonest real case (#1020 Vorfall 3),
  // and the ONLY stage that works for a file that does not exist yet.
  if (x === y) return 'concrete';

  const xIsGlob = isGlobScopeEntry(x);
  const yIsGlob = isGlobScopeEntry(y);

  // Stage 2 — concrete vs glob. `pathMatchesPattern` is DIRECTED (arg 1 is a
  // literal path, arg 2 becomes the regex); used in that one correct direction
  // it is exact and needs no filesystem witness.
  if (!xIsGlob && yIsGlob) return pathMatchesPattern(x, y) ? 'concrete' : null;
  if (xIsGlob && !yIsGlob) return pathMatchesPattern(y, x) ? 'concrete' : null;
  if (!xIsGlob && !yIsGlob) return null; // two distinct concrete paths: disjoint

  // Stage 3a — glob ∩ glob, decided by a shared WITNESS from the KNOWN set.
  const xHits = expand(x);
  for (const witness of expand(y)) {
    if (xHits.has(witness)) return 'glob-expanded';
  }

  // Stage 3b — prefix fallback, for the intersection that exists only in files
  // NOT YET on disk (the KNOWN set cannot witness those).
  const xPrefix = literalScopePrefix(x);
  const yPrefix = literalScopePrefix(y);
  if (!(xPrefix.startsWith(yPrefix) || yPrefix.startsWith(xPrefix))) return null;
  if (!(isRecursiveScopeEntry(x) || isRecursiveScopeEntry(y))) return null;
  // Suffix compatibility is a NECESSARY condition, so filtering on it adds no
  // false negative: a string ending in both `sx` and `sy` forces the shorter to
  // be a suffix of the longer. It removes the obvious false positive
  // `scripts/**\/*.ts` vs `scripts/**\/*.mjs`, which share a prefix and are both
  // recursive yet can never match the same path.
  const xSuffix = literalScopeSuffix(x);
  const ySuffix = literalScopeSuffix(y);
  if (
    xSuffix !== null &&
    ySuffix !== null &&
    !(xSuffix.endsWith(ySuffix) || ySuffix.endsWith(xSuffix))
  ) {
    return null;
  }
  return 'glob-prefix';
}

/**
 * Detect files claimed by TWO agents of the SAME wave, BEFORE dispatch (#1020).
 *
 * ## The bug this closes
 * `tests/scripts/sweep-expired-learnings-cli.test.mjs` was handed to two agents
 * of one wave (#1020 Vorfall 3). Nothing caught it up front: the pre-dispatch
 * assertion {@link assertFileScopeSubset} checks each agent against the union
 * (a SUBSET relation, which two overlapping agents both satisfy), and the
 * commit-time `wave-scope-commit-guard` only sees the union as well. It surfaced
 * afterwards, from an agent's own PSA-002 report. Per
 * `.claude/rules/parallel-sessions.md` § Decision Tree a file inside two
 * declared scopes of one dispatch round is never a benign sibling signal — it is
 * a deconfliction gap, and that round ended well by luck, not construction.
 *
 * ## The three stages, and why the order is binding
 *  1. **Exact string equality** → `concrete`. Covers the commonest real case AND
 *     every file that does not exist yet (no filesystem witness required).
 *  2. **Concrete vs glob** via {@link pathMatchesPattern} → `concrete`. Exact and
 *     I/O-free, because the matcher is used in its one correct direction.
 *  3. **Glob vs glob** — expand both against
 *     `KNOWN = opts.knownFiles ∪ {every concrete entry of every agent}`;
 *     a non-empty intersection is `glob-expanded`. As a fallback for files not
 *     yet on disk, a literal-prefix containment plus at least one recursive
 *     entry is `glob-prefix`.
 *
 * Stage 3 must come LAST because {@link pathMatchesPattern} is DIRECTED and
 * therefore useless for glob∩glob: it compiles argument 2 into a regex and tests
 * argument 1 as a literal string. Measured:
 * `pathMatchesPattern('scripts/**\/*.mjs', 'scripts/lib/*.mjs') === false`, even
 * though both match `scripts/lib/x.mjs`. {@link assertFileScopeSubset} documents
 * that boundary at its own glob branch and OVER-approximates coverage, which is
 * the safe direction for a subset check. For a COLLISION check the sign flips:
 * the same over-approximation becomes a FALSE NEGATIVE — a missed collision,
 * i.e. exactly the incident. Hence stages 1 and 2 decide first, and stage 3 is
 * reached only for pairs neither of them can settle.
 *
 * ## Duplicate ids are a SEPARATE finding, not a collision
 * Two records carrying the same `id` are a malformed plan, not two agents
 * fighting over a file; reporting them as a self-collision (`a === b`) would be
 * noise. They are listed in `duplicateIds` and such pairs are skipped in the
 * pairwise scan. `duplicateIds` is always present (empty when clean) so
 * consumers need no conditional-key handling.
 *
 * ## `knownFiles` is INJECTED, never discovered
 * The module header's hook-safe invariant (pure, sync, no I/O, no process spawn)
 * is binding: `hooks/enforce-scope.mjs` reaches this module on a hot path, and
 * under the exit-0/stdout-JSON protocol a throw here reads as "no decision" =
 * ALLOW. So `git ls-files` belongs to the CLI layer and its result arrives as a
 * parameter. An absent/invalid `knownFiles` is not an error — stage 3a simply
 * has fewer witnesses and stage 3b carries the load.
 *
 * Fail-closed & no-throw: a non-array `agentScopes` returns
 * `{ ok: false, collisions: [], duplicateIds: [] }` ("cannot assert → treat as
 * failure", the same convention as {@link assertFileScopeSubset}).
 *
 * Output ordering is deterministic: agent pairs in input order, then kinds in
 * stage order (`concrete` → `glob-expanded` → `glob-prefix`); `evidence` holds
 * the involved entries of that kind, deduplicated in first-seen order.
 *
 * @param {Array<{id?: string, files?: string[]}>} agentScopes — one wave's agents
 * @param {{knownFiles?: string[]}} [opts] — existing repo files (injected)
 * @returns {{ok: boolean,
 *            collisions: Array<{a: string, b: string, evidence: string[],
 *                               kind: 'concrete'|'glob-expanded'|'glob-prefix'}>,
 *            duplicateIds: string[]}}
 */
export function findScopeCollisions(agentScopes, opts = {}) {
  if (!Array.isArray(agentScopes)) return { ok: false, collisions: [], duplicateIds: [] };
  const options = opts !== null && typeof opts === 'object' ? opts : {};
  const agents = normalizeAgentScopes(agentScopes);

  // Duplicate DECLARED ids (synthetic `<unnamed#i>` ids are unique by index).
  const seenIds = new Set();
  const dupIds = new Set(); // Set preserves insertion order → stable report
  for (const agent of agents) {
    if (agent.declaredId === null) continue;
    if (seenIds.has(agent.declaredId)) dupIds.add(agent.declaredId);
    else seenIds.add(agent.declaredId);
  }
  const duplicateIds = [...dupIds];

  // KNOWN = injected repo files ∪ every concrete entry of every agent. The
  // second half matters: a file the wave is about to CREATE is not in
  // `git ls-files`, but if one agent names it concretely it can still witness
  // another agent's glob.
  const known = [];
  const knownSeen = new Set();
  const addKnown = (f) => {
    if (typeof f !== 'string' || f.length === 0 || knownSeen.has(f)) return;
    knownSeen.add(f);
    known.push(f);
  };
  if (Array.isArray(options.knownFiles)) options.knownFiles.forEach(addKnown);
  for (const agent of agents) {
    for (const entry of agent.files) if (!isGlobScopeEntry(entry)) addKnown(entry);
  }

  const expansions = new Map();
  const expand = (glob) => {
    let hits = expansions.get(glob);
    if (hits === undefined) {
      hits = new Set(known.filter((f) => pathMatchesPattern(f, glob)));
      expansions.set(glob, hits);
    }
    return hits;
  };

  const KIND_ORDER = ['concrete', 'glob-expanded', 'glob-prefix'];
  const collisions = [];
  for (let i = 0; i < agents.length; i++) {
    for (let j = i + 1; j < agents.length; j++) {
      const a = agents[i];
      const b = agents[j];
      if (a.id === b.id) continue; // duplicate-id record: reported separately
      const buckets = new Map();
      for (const x of a.files) {
        for (const y of b.files) {
          const kind = classifyEntryCollision(x, y, expand);
          if (kind === null) continue;
          let evidence = buckets.get(kind);
          if (evidence === undefined) {
            evidence = new Set();
            buckets.set(kind, evidence);
          }
          evidence.add(x);
          evidence.add(y);
        }
      }
      for (const kind of KIND_ORDER) {
        const evidence = buckets.get(kind);
        if (evidence !== undefined) {
          collisions.push({ a: a.id, b: b.id, evidence: [...evidence], kind });
        }
      }
    }
  }

  return { ok: collisions.length === 0 && duplicateIds.length === 0, collisions, duplicateIds };
}

// ---------------------------------------------------------------------------
// Empty-`allowedPaths` classification (#1057)
// ---------------------------------------------------------------------------
//
// ## The bug this fixes — and the one it deliberately does NOT
//
// FIVE distinct repository states produce `allowedPaths.length === 0`, and the
// DENY VERDICT IS CORRECT IN ALL FIVE. What collapses is the REASON: every one
// of them printed the single sentence {@link suggestForScopeViolation} emits for
// an empty allowlist — "update the session plan and restart the wave".
//
//   1. A Discovery wave, where `[]` is the deliberate read-only contract
//      (`skills/session-plan/SKILL.md`, `wave-loop.md` § Scope Manifest #5, and
//      the #256 NO-OP regression lock in tests/hooks/enforce-scope.test.mjs).
//      There the sentence is CORRECT but misleading — nothing is broken.
//   2. Corrupt JSON, which `hooks/enforce-scope.mjs` folds onto `scope = {}`
//      (#794 GAP-5), and malformed `allowedPaths` shapes, which `Array.isArray`
//      folds onto `[]` (#558). There the sentence is USELESS — the plan is fine,
//      the file is not.
//   3. A leftover manifest from a session that crashed before deleting it.
//      There the sentence is ACTIVELY WRONG: restarting the wave does not remove
//      a file the previous session left behind — `rm -f` does.
//   4. A writable role whose union came out empty because the coordinator's
//      `--union` step did not complete. There the operator must re-run `--union`,
//      not restart.
//
// The classifier below is the discriminator. It changes NO verdict — see
// {@link suggestForEmptyScope}, which only ever selects a different sentence.
//
// ## Named ceiling (BV-004)
//
//   - This buys a CORRECT INSTRUCTION, never an unlock. A writable wave with a
//     broken union still denies every write; the operator is simply told which
//     command repairs it.
//   - It cannot see a union that is NON-EMPTY but WRONG. That is
//     `--assert-subset`'s job and stays there.
//   - `stale-manifest` degrades to `'unknown'` when no session clock is
//     readable — never to an allow. Absence is preserved, never guessed.
//   - There is NO age threshold and no TTL. The comparison is a PROVENANCE
//     subtraction (manifest mtime vs. this session's start), so a legitimate
//     14-hour deep session never ages into a blind spot. Deliberately NOT
//     `IN_FLIGHT_TTL_MS` — see `hooks/post-bash-write-verify.mjs` § "Why the
//     minimum, and why NOT a staleness cap" for the argument this inherits.
//   - Revisit trigger: a second read-only wave role, or a manifest written by a
//     process whose clock is not this repo's `.orchestrator/` pair.
// ---------------------------------------------------------------------------

/**
 * The closed set of {@link classifyEmptyScope} verdicts. Shaped after
 * `DEGRADED_REASONS` in `scripts/lib/mirror-issues-banner.mjs`: a frozen array
 * so a consumer can enumerate the states rather than re-listing them in prose.
 *
 * `'unknown'` is a first-class member, not an error — it is what the classifier
 * returns when the inputs do not DECIDE, and it maps to the pre-#1057 generic
 * sentence. Absence-preserving by construction.
 *
 * @type {ReadonlyArray<'unreadable'|'read-only-role'|'stale-manifest'|'writer-defect'|'unknown'>}
 */
export const EMPTY_SCOPE_REASONS = Object.freeze([
  'unreadable',
  'read-only-role',
  'stale-manifest',
  'writer-defect',
  'unknown',
]);

/**
 * Wave roles for which an EMPTY `allowedPaths` is the intended contract rather
 * than a defect. THE list — `skills/session-plan/SKILL.md` § Discovery and
 * `skills/wave-executor/wave-loop.md` § Scope Manifest #5 describe it; they do
 * not restate it.
 *
 * Canonical casing; comparison is trimmed + case-insensitive (see
 * {@link isReadOnlyWaveRole}) for the same reason
 * {@link TEST_SIBLING_EXPANSION_ROLES} is: the manifest on disk is written by
 * LLM prose and by hand, and `"discovery"` vs `Discovery` must not silently
 * change which sentence the operator reads.
 *
 * @type {ReadonlyArray<string>}
 */
export const READ_ONLY_WAVE_ROLES = Object.freeze(['Discovery']);

/** Lower-cased lookup for {@link isReadOnlyWaveRole}. @type {ReadonlyMap<string, string>} */
const READ_ONLY_ROLE_KEYS = new Map(READ_ONLY_WAVE_ROLES.map((r) => [r.toLowerCase(), r]));

/**
 * Is this wave role one for which `allowedPaths: []` is BY DESIGN?
 *
 * Trimmed + case-insensitive; a non-string role is never read-only (fail-closed
 * in the direction that produces a MORE alarming message, never a quieter one).
 *
 * @param {unknown} role
 * @returns {boolean}
 */
export function isReadOnlyWaveRole(role) {
  if (typeof role !== 'string') return false;
  return READ_ONLY_ROLE_KEYS.has(role.trim().toLowerCase());
}

/**
 * Classify WHY a wave manifest grants zero paths. Pure, sync, no I/O — every
 * observation is passed in, exactly like {@link testSiblingExpansionApplies}.
 * Never throws.
 *
 * Modelled on `readLockDetailed` (`scripts/lib/session-lock.mjs`): a small
 * closed status union, where "cannot tell" is its own member instead of being
 * folded into the most alarming one.
 *
 * ## Precedence (each rung is load-bearing)
 *
 *   1. `parseOk === false` → `'unreadable'`. FIRST, because a manifest that did
 *      not parse has no trustworthy `role` either — reading `role` off `{}` and
 *      reporting "writer defect" would blame the coordinator for a corrupt file.
 *      Only an EXPLICIT `false` classifies; `undefined` means "caller did not
 *      observe it" and falls through.
 *   2. `role` ∈ {@link READ_ONLY_WAVE_ROLES} → `'read-only-role'`. Before the
 *      clock comparison ON PURPOSE: for a Discovery wave the empty scope is the
 *      contract whether the manifest is one second or one day old, so a stale
 *      Discovery leftover reports the read-only sentence. The cost is named
 *      rather than hidden — it is the one state where a leftover manifest is
 *      described by its role instead of by its age.
 *   3. `scopeMtimeMs < sessionStartMs` → `'stale-manifest'`. Requires BOTH
 *      clocks to be finite numbers; either one absent ⇒ `'unknown'`, never a
 *      guess in either direction.
 *   4. A writable role with a manifest at least as new as this session ⇒
 *      `'writer-defect'`.
 *   5. Everything else ⇒ `'unknown'`.
 *
 * @param {{role?: unknown, parseOk?: unknown, scopeMtimeMs?: unknown, sessionStartMs?: unknown}} [input]
 * @returns {'unreadable'|'read-only-role'|'stale-manifest'|'writer-defect'|'unknown'}
 */
export function classifyEmptyScope(input = {}) {
  if (input === null || typeof input !== 'object') return 'unknown';

  if (input.parseOk === false) return 'unreadable';
  if (isReadOnlyWaveRole(input.role)) return 'read-only-role';

  const mtime = typeof input.scopeMtimeMs === 'number' && Number.isFinite(input.scopeMtimeMs)
    ? input.scopeMtimeMs
    : null;
  const started = typeof input.sessionStartMs === 'number' && Number.isFinite(input.sessionStartMs)
    ? input.sessionStartMs
    : null;
  if (mtime === null || started === null) return 'unknown';

  if (mtime < started) return 'stale-manifest';
  return typeof input.role === 'string' && input.role.trim().length > 0
    ? 'writer-defect'
    : 'unknown';
}

/**
 * The suggestion half of a scope-violation deny, when `allowedPaths` is EMPTY.
 *
 * A strict superset of {@link suggestForScopeViolation}'s empty-allowlist
 * branch: `'unknown'` delegates to it verbatim, so the pre-#1057 sentence has
 * exactly one copy and every other branch is an ADDITION. Pure, sync, never
 * throws.
 *
 * @param {string} relPath — the project-relative path that was blocked
 * @param {string} reason — a {@link EMPTY_SCOPE_REASONS} member; anything else
 *   is treated as `'unknown'` (fail-safe toward the generic text)
 * @param {{role?: unknown, scopePath?: unknown}} [opts]
 *   `scopePath` is the manifest's location as the operator should type it
 *   (project-relative is ideal); it appears inside the `rm -f` hint.
 * @returns {string}
 */
export function suggestForEmptyScope(relPath, reason, opts = {}) {
  const bag = opts !== null && typeof opts === 'object' ? opts : {};
  const scopeHint = typeof bag.scopePath === 'string' && bag.scopePath.length > 0
    ? bag.scopePath
    : '<state-dir>/wave-scope.json';
  const rawRole = typeof bag.role === 'string' ? bag.role.trim() : '';

  switch (reason) {
    case 'unreadable':
      return (
        `wave-scope.json is unreadable — failing closed. ` +
        `The manifest exists but did not parse into a usable scope record, so NO path can be granted. ` +
        `Inspect '${scopeHint}'; a truncated or half-written manifest is repaired by re-running the ` +
        `coordinator's scope-manifest step, not by editing the plan.`
      );

    case 'read-only-role': {
      // Canonical casing from the list, so ' DISCOVERY ' and 'discovery' both
      // render the documented sentence.
      const canonical = READ_ONLY_ROLE_KEYS.get(rawRole.toLowerCase()) ?? rawRole;
      return (
        `${canonical} wave is read-only — no writes permitted. ` +
        `An empty allowedPaths is this role's deliberate contract (#256), not a misconfiguration: ` +
        `report '${relPath}' as a finding instead of editing it.`
      );
    }

    case 'stale-manifest':
      return (
        `'${scopeHint}' was written before this session started — likely a leftover from a crashed session. ` +
        `Restarting the wave will NOT clear it; remove it with \`rm -f ${scopeHint}\` and let the ` +
        `coordinator write a fresh manifest.`
      );

    case 'writer-defect':
      return (
        `the wave's allowedPaths union is empty for role \`${rawRole}\` — ` +
        `the coordinator's \`--union\` step did not complete. Re-run it; do not hand-edit.`
      );

    default:
      return suggestForScopeViolation(relPath, '');
  }
}

/**
 * Milliseconds since one of this session's clocks was written, or `null` when
 * none is readable — the MINIMUM over `.orchestrator/current-session.json`
 * `timestamp` and `.orchestrator/session.lock` `started_at`.
 *
 * MOVED here from `hooks/post-bash-write-verify.mjs` (#1057) so both consumers
 * share ONE implementation: a lib module may be imported by a hook, but a hook
 * must never be imported by another hook or by this lib (module header, #554
 * A2). Behaviour is byte-identical to the original — including the `Math.min`
 * choice and the dropping of NEGATIVE (future-dated) ages, both of which that
 * hook's docblock argues at length under "Why the minimum, and why NOT a
 * staleness cap". That argument is the reason this repo has no TTL here either.
 *
 * Sync fs reads at CALL time only (same shape as {@link getEnforcementLevel});
 * no I/O at import time. Never throws — an unreadable or malformed clock is
 * simply absent.
 *
 * @param {string} repoRoot
 * @param {number} [now]
 * @returns {number|null}
 */
export function sessionAgeMs(repoRoot, now = Date.now()) {
  const dir = path.join(repoRoot, '.orchestrator');
  const ages = [
    clockAgeMs(path.join(dir, 'current-session.json'), 'timestamp', now),
    clockAgeMs(path.join(dir, 'session.lock'), 'started_at', now),
  ].filter((age) => age !== null);
  return ages.length > 0 ? Math.min(...ages) : null;
}

/**
 * Age in ms of one JSON clock file's ISO timestamp field, or `null` when the
 * file is missing, unparseable, carries no parseable timestamp, or is dated in
 * the FUTURE. Private helper of {@link sessionAgeMs}; moved verbatim with it.
 *
 * @param {string} file
 * @param {string} field
 * @param {number} now
 * @returns {number|null}
 */
function clockAgeMs(file, field, now) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const startedAt = Date.parse(parsed?.[field]);
    if (!Number.isFinite(startedAt)) return null;
    const age = now - startedAt;
    return age >= 0 ? age : null;
  } catch {
    return null;
  }
}

/**
 * Absolute epoch-ms at which this session started, or `null` when no clock is
 * readable — the value {@link classifyEmptyScope} compares a manifest's mtime
 * against.
 *
 * Derived from {@link sessionAgeMs} rather than re-reading the files, so there
 * is ONE clock policy: `now - min(ages)` is the LATEST of the two recorded start
 * times, which is exactly the freshness `Math.min` was chosen to express (a
 * leftover `current-session.json` from a previous session is outvoted by a
 * freshly-acquired `session.lock`). `now` is threaded through so both halves see
 * the same instant.
 *
 * Never throws. No clock ⇒ `null` ⇒ the caller cannot decide staleness and must
 * fall back to `'unknown'`.
 *
 * @param {string} repoRoot
 * @param {number} [now]
 * @returns {number|null}
 */
export function sessionStartedAtMs(repoRoot, now = Date.now()) {
  const age = sessionAgeMs(repoRoot, now);
  return age === null ? null : now - age;
}
