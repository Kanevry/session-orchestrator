#!/usr/bin/env node
// check-untracked-test-deps.mjs — STATIC guard against the "a test depends on a
// path that is not in the repository" class.
//
// THE CLASS. A test reads a path that exists on the developer's disk but is not
// tracked by git (gitignored, or simply never `git add`-ed). Locally it is green;
// on CI — which starts from a fresh clone — the path is absent, so the test is
// either red (fatal read) or silently degraded to zero coverage. Third recorded
// instance in this repo (learnings `fcfd01dc` conf 0.80, `ea56c14b` conf 0.75).
//
// WHY THE OBVIOUS SCAN DOES NOT WORK. The instance that turned CI red —
// `tests/scripts/site-numbers.test.mjs` — never names `.orchestrator` at all.
// The dependency is TRANSITIVE: the test calls `collect(REPO_ROOT)`, and
// `scripts/site-numbers.mjs` does `join(root, '.orchestrator', 'metrics',
// 'sessions.jsonl')` with `root` as a runtime parameter. A scan over `tests/**`
// alone scores zero on exactly this incident. The scan must follow the IMPORT
// CLOSURE.
//
// THE TWO RULES. Four rule variants were measured against the ground truth
// (582 files / 14,039 tests, tracked tree vs tracked+store; 27 status diffs in
// 2 files):
//
//   R0  closure names an ignored path                      227 hits, 2 TP, 225 FP
//   R1  R0 + test contains a repo-root expression           68 hits, 1 TP,  67 FP
//   R3  test contains a bare ignored path literal           48 hits, 1 TP,  47 FP
//   R2  ← implemented                                        1 hit,  1 TP,   0 FP
//   R4  ← implemented                                        1 hit,  1 TP,   0 FP
//
// MEASURED DIVERGENCE, recorded rather than smoothed over: this implementation
// of R2 finds TWO test files against the live tree, not one. The second —
// `tests/lib/validate/check-learning-provenance.test.mjs` — reaches the same
// gitignored store and is a fully documented accommodation (it branches on the
// store's absence). It is invisible to the differential measurement above by
// construction: that measurement asks "does the test's STATUS change with and
// without the store", and a test that accommodates correctly changes status in
// neither direction. The two measurements are both right about different
// populations. The static scan is the wider one; the ignore marker is how an
// accommodation is declared.
//
//   R2: the test passes a STATICALLY RESOLVABLE REAL repo root
//       (`fileURLToPath(new URL('../../', import.meta.url))`, `resolve(__dirname,
//       '../..')`, `process.cwd()`) as an argument to a LOCALLY IMPORTED
//       function whose import closure names an untracked path.
//   R4: the test reads an untracked path CWD-RELATIVE — `readFileSync`/
//       `existsSync`/… on a bare literal, or on an identifier bound to a bare
//       literal, with NO `join`/`resolve` wrapping.
//
// The false-positive avoidance falls out of the RULE FORM, it is not a
// heuristic: R2 demands a STATICALLY resolvable real root, which a
// `mkdtempSync(...)` root can never be; R4 demands the ABSENCE of any
// `join`/`resolve` wrapping, which every tmp-fixture target has.
// R1/R3, at 98-99% false positives, are precisely the shape of check this repo
// has had to demote to WARN-only three times — they are deliberately NOT built.
//
// ORACLE. "Untracked" is `git check-ignore` OR (exists on disk AND absent from
// `git ls-files`). `check-ignore` alone misses a file that is simply never
// `git add`-ed. MEASURED PITFALL: `git check-ignore --stdin` aborts with `fatal`
// on the first path beginning with `../` and DISCARDS THE REST OF THE STREAM —
// in one intermediate run that swallowed 44 of 45 hits, and it recurred here
// with a JSON fixture blob that merely happened to contain a slash. Two layers,
// because a charset filter alone is an arms race: escaping/absolute/exotic specs
// are filtered out before the batch (`normalizeCandidate`), AND the batch
// BISECTS on a fatal (`checkIgnoreBatch`), so one refused spec costs one dropped
// candidate instead of the whole result set.
//
// WHY STATIC (termination, not cost). `scripts/validate-plugin.mjs` runs in NO
// CI job and NOT in the pre-push gate; it is reached only via two tests that
// spawn it (`tests/scripts/orchestrators-e2e.test.mjs`,
// `tests/agents/persona-reviewers.test.mjs`). A check that spawned `vitest`
// would run from a vitest test that spawns validate-plugin that spawns the
// check: unbounded recursion. This check spawns `git` only.
//
// ESCAPE HATCH. A line carrying the inline marker `check-untracked-test-deps:ignore`
// is exempt (same shape as `check-dead-bridge:ignore`). Use it only for a
// DOCUMENTED accommodation, and always with a rationale beside it.
//
// NAMED CEILING (BV-004) — what R2+R4 provably does NOT catch:
//   1. SUBPROCESS ARGV — `spawnSync(node, [SCRIPT, REPO_ROOT])`. This is the
//      MOST LIKELY form of the next instance; in the current incident it only
//      narrowly failed to be the trigger.
//   2. MODULE-SCOPE ROOT — the module resolves `process.cwd()` itself, so the
//      test passes no root argument at all and R2's conjunct never arms.
//   3. COMPOSED FILENAMES — `join(root, '.orchestrator', 'metrics',
//      `${name}.jsonl`)`: the directory itself is tracked/unignored, only
//      `*.jsonl` inside it is ignored, so the assembled candidate misses.
//   4. NON-STATIC IMPORTS — `require()`, `import(variable)`: not in the closure.
//   5. ENVIRONMENT DEPENDENCIES — `$HOME`, the vault dir, `.env.local`: not a
//      repo-relative path, so the oracle cannot judge them.
//   6. UNTRACKED DIRECTORIES that no ignore rule names. The oracle's
//      exists-but-untracked half is FILES ONLY (see `resolveUntrackedOracle`),
//      because `git ls-files` lists no directories at all — judging directories
//      by it condemns `.git`. So a closure naming a bare `.orchestrator/metrics`
//      is a miss, while `.orchestrator/metrics/sessions.jsonl` is caught.
//   Additionally, code inside a TEMPLATE LITERAL is masked as data (this is what
//   keeps a test that embeds fixture source from flagging itself), so a
//   genuine `readFileSync(`${d}/x`)` is a miss; and a candidate `git check-ignore`
//   refuses outright is dropped by the bisect rather than guessed at.
//   REVISIT TRIGGER: any further instance of the class that slips through R2+R4.
//
// Usage: check-untracked-test-deps.mjs <repo-root>
// Output: `  PASS: …` / `  FAIL: …` lines (exactly two leading spaces), then
// `Results: N passed, M failed`. Exit 0 = clean, 1 = finding(s), 2 = tool error.
//
// Import-safety: importing this module MUST NOT execute anything — the isMain
// guard at the bottom is the only side-effecting path.

import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Inline exemption marker — mirrors `check-dead-bridge:ignore`. */
export const IGNORE_MARKER = 'check-untracked-test-deps:ignore';

/** Directory (repo-relative) walked for test files. */
const TESTS_DIR = 'tests';

/** Test-file suffix. */
const TEST_SUFFIX = '.test.mjs';

/** Extensions a local import may resolve to. */
const MODULE_EXTS = ['.mjs', '.js', '.cjs'];

/**
 * Vitest `resolve.alias` entries that point INTO this repo. Kept as a tiny
 * literal map rather than parsing `vitest.config.mjs`: there is exactly one
 * alias, and a parser for a config that has never had a second entry is the
 * speculative-abstraction anti-pattern (`build-value.md` BV-001).
 */
const IMPORT_ALIASES = { '@lib': 'scripts/lib' };

/** Depth cap for the import-closure walk (cycles are also visited-guarded). */
const MAX_CLOSURE_DEPTH = 6;

/** Callees whose string-literal arguments assemble into a path (R2 closure). */
const PATH_JOIN_FNS = new Set(['join', 'resolve', 'path.join', 'path.resolve']);

/** Filesystem readers whose FIRST argument is a path (R4). */
const FS_READ_FNS = new Set([
  'readFileSync', 'readdirSync', 'existsSync', 'statSync', 'lstatSync',
  'openSync', 'accessSync', 'realpathSync', 'readlinkSync', 'createReadStream',
  'readFile', 'readdir', 'stat', 'lstat', 'access', 'open',
]);

/** An expression that resolves to a REAL, static location (R2 numerator). */
const REAL_ROOT_EXPR_RE = /import\.meta\.url|__dirname|process\s*\.\s*cwd\s*\(/;

/**
 * …unless it is a throwaway temp directory. This single negation is what makes
 * R2's zero-false-positive property structural rather than tuned.
 */
const TMP_ROOT_RE = /mkdtemp|tmpdir/;

/** Upper bound on a plausible repo-relative path. */
const MAX_CANDIDATE_LEN = 200;

/** Characters a path in THIS repo can be built from (positive allowlist). */
const SANE_PATH_RE = /^[A-Za-z0-9._@+\-/ ]+$/;

/** Words that look like a call but are not one. */
const NON_CALLEES = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'await', 'new', 'do', 'else', 'in', 'of', 'delete', 'void', 'yield', 'import',
]);

// ---------------------------------------------------------------------------
// Source masking — string/template/comment/regex interiors become spaces
// ---------------------------------------------------------------------------

/**
 * Blank out the INTERIOR of every string literal, template literal, comment and
 * regex literal, preserving byte offsets and newlines. Delimiters are kept so
 * paren/comma balance and identifier boundaries survive.
 *
 * This is what separates CODE from DATA. A test that embeds fixture source in a
 * template literal (this check's own test file does) must not be scanned as
 * though that fixture were its own body — masking makes that structural instead
 * of relying on a self-exemption marker.
 *
 * @param {string} text
 * @returns {string} same-length masked source
 */
export function maskSource(text) {
  const out = text.split('');
  const n = out.length;
  let i = 0;
  // Last significant (non-space) char before `i`, used for the regex/division
  // disambiguation below.
  let prev = '';

  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    // Line comment.
    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    // Block comment.
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(text[j] === '*' && text[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = Math.min(j + 2, n);
      continue;
    }
    // Single/double-quoted string — keep the quotes, blank the interior.
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== c) {
        if (text[j] === '\\') j++;
        if (text[j] === '\n') break; // unterminated — bail at EOL
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      prev = c;
      continue;
    }
    // Template literal — blank everything including `${…}` substitutions.
    if (c === '`') {
      let j = i + 1;
      while (j < n && text[j] !== '`') {
        if (text[j] === '\\') j++;
        j++;
      }
      blank(i + 1, j);
      i = Math.min(j + 1, n);
      prev = c;
      continue;
    }
    // Regex literal — only when the previous significant char cannot end an
    // expression, AND a closing unescaped `/` exists on the SAME line. The
    // same-line bound keeps a misread division from swallowing the file.
    if (c === '/' && (prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      let closed = -1;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') inClass = true;
        else if (text[j] === ']') inClass = false;
        else if (text[j] === '/' && !inClass) { closed = j; break; }
        j++;
      }
      if (closed > i) {
        blank(i + 1, closed);
        i = closed + 1;
        prev = '/';
        continue;
      }
    }

    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Tiny source scanners (offset-aligned against the masked text)
// ---------------------------------------------------------------------------

/**
 * Build a line-number lookup for a source text.
 * @param {string} text
 * @returns {(index: number) => number} 1-based line number for a char offset
 */
function lineLookup(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * Split the argument list of the call whose `(` sits at `openIdx`. Operates on
 * MASKED text (string interiors already blanked), so nothing inside a literal
 * can affect the paren/comma balance.
 *
 * @param {string} masked
 * @param {number} openIdx index of the opening `(`
 * @returns {Array<{start: number, end: number}> | null} null when unbalanced
 */
function argRanges(masked, openIdx) {
  const ranges = [];
  let depth = 0;
  let start = openIdx + 1;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        if (i > start || ranges.length > 0) ranges.push({ start, end: i });
        return ranges;
      }
    } else if (c === ',' && depth === 1) {
      ranges.push({ start, end: i });
      start = i + 1;
    }
  }
  return null;
}

const CALL_RE = /(?<![\w$.])((?:[A-Za-z_$][\w$]*\s*\.\s*)?[A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Enumerate every call expression in a source file.
 *
 * @param {string} original raw source (argument VALUES are sliced from here)
 * @param {string} masked   masked source (call STRUCTURE is found here)
 * @returns {Array<{callee: string, args: string[], index: number}>}
 */
function scanCalls(original, masked) {
  const calls = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(masked)) !== null) {
    const callee = m[1].replace(/\s+/g, '');
    if (NON_CALLEES.has(callee)) continue;
    const openIdx = m.index + m[0].length - 1;
    const ranges = argRanges(masked, openIdx);
    if (!ranges) continue;
    calls.push({
      callee,
      args: ranges.map((r) => original.slice(r.start, r.end).trim()),
      index: m.index,
    });
  }
  return calls;
}

/** A bare single/double-quoted string literal, whole-argument. */
const WHOLE_STRING_RE = /^(['"])((?:[^'"\\]|\\.)*)\1$/;

/** A bare identifier, whole-argument. */
const WHOLE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * @param {string} arg trimmed argument source
 * @returns {string | null} the literal's value, or null when not a bare literal
 */
function asStringLiteral(arg) {
  const m = WHOLE_STRING_RE.exec(arg);
  return m ? m[2] : null;
}

// ---------------------------------------------------------------------------
// Path-candidate extraction
// ---------------------------------------------------------------------------

/**
 * Normalize a raw path candidate to a repo-relative form, or return null when
 * it cannot be one.
 *
 * A candidate must LOOK repo-relative: it either contains a `/` or begins with
 * a `.` (a dotfile/dotdir). A single bare segment such as `package.json` or
 * `node_modules` is rejected — joined onto an unknown base it is a filename,
 * not a repo-relative path, and attributing it to the repo root is what would
 * manufacture false positives.
 *
 * @param {string} raw
 * @returns {string | null}
 */
export function normalizeCandidate(raw) {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p || p.length > MAX_CANDIDATE_LEN) return null;
  // Positive charset, not a blocklist. A test corpus contains string literals
  // that merely HAPPEN to carry a slash — a JSON fixture, a prose sentence, a
  // regex source. One such literal reaching `git check-ignore --stdin` aborts
  // the batch and discards the rest of the stream (measured: a `[{"number":63,
  // …}]` fixture blob did exactly that here). Anything outside this charset is
  // not a path this repo could contain, so it never enters the batch.
  if (!SANE_PATH_RE.test(p)) return null;
  if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p)) return null;
  if (p.startsWith('~')) return null;
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  while (p.startsWith('./')) p = p.slice(2);
  if (!p || p === '.') return null;
  if (p.split('/').some((seg) => seg === '..')) return null; // check-ignore fatal
  if (!p.includes('/') && !p.startsWith('.')) return null;
  return p;
}

/**
 * Extract every path candidate a module NAMES: `join(...)`/`resolve(...)`
 * assembled from string-literal segments, plus bare path-shaped literals.
 *
 * @param {string} original
 * @param {string} masked
 * @returns {Array<{candidate: string, line: number}>}
 */
function extractPathCandidates(original, masked) {
  const lineOf = lineLookup(original);
  /** @type {Array<{candidate: string, line: number}>} */
  const out = [];
  const seen = new Set();
  const push = (raw, index) => {
    const candidate = normalizeCandidate(raw);
    if (!candidate) return;
    const line = lineOf(index);
    const key = `${candidate}@${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ candidate, line });
  };

  // (a) join()/resolve() assembled from the ordered string-literal arguments.
  for (const call of scanCalls(original, masked)) {
    if (!PATH_JOIN_FNS.has(call.callee)) continue;
    const segs = call.args.map(asStringLiteral).filter((s) => s !== null);
    if (segs.length === 0) continue;
    push(segs.join('/'), call.index);
  }

  // (b) bare path-shaped string literals anywhere in the module.
  const litRe = /(['"])((?:[^'"\\\n]|\\.)*)\1/g;
  let m;
  while ((m = litRe.exec(masked)) !== null) {
    // masked blanks the interior — read the value from the original at the
    // same offsets.
    const value = original.slice(m.index + 1, m.index + m[0].length - 1);
    push(value, m.index);
  }

  return out;
}

/**
 * Extract ONLY the bare path-shaped string literals of a source file (no
 * join/resolve assembly). Exported so the false-positive regression test can
 * build the R3 candidate corpus mechanically instead of hand-listing it.
 *
 * @param {string} original
 * @param {string} masked
 * @returns {Array<{candidate: string, line: number}>}
 */
export function extractLiteralCandidates(original, masked) {
  const lineOf = lineLookup(original);
  const out = [];
  const seen = new Set();
  const litRe = /(['"])((?:[^'"\\\n]|\\.)*)\1/g;
  let m;
  while ((m = litRe.exec(masked)) !== null) {
    const value = original.slice(m.index + 1, m.index + m[0].length - 1);
    const candidate = normalizeCandidate(value);
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    out.push({ candidate, line: lineOf(m.index) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Import resolution + closure
// ---------------------------------------------------------------------------

const IMPORT_RE = /import\s+([\s\S]*?)\s+from\s+(['"])([^'"]+)\2/g;
const BARE_IMPORT_RE = /import\s+(['"])([^'"]+)\1/g;

/**
 * Resolve an import specifier to an absolute file path INSIDE the repo, or null
 * for bare/external/unresolvable specifiers.
 *
 * @param {string} repoRoot
 * @param {string} fromFile absolute path of the importing file
 * @param {string} spec
 * @returns {string | null}
 */
function resolveLocalImport(repoRoot, fromFile, spec) {
  let base = null;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    base = path.resolve(path.dirname(fromFile), spec);
  } else {
    for (const [alias, target] of Object.entries(IMPORT_ALIASES)) {
      if (spec === alias || spec.startsWith(`${alias}/`)) {
        base = path.resolve(repoRoot, target, spec.slice(alias.length + 1));
        break;
      }
    }
  }
  if (!base) return null;
  const rel = path.relative(repoRoot, base);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

  const tryPaths = [base, ...MODULE_EXTS.map((e) => base + e),
    ...MODULE_EXTS.map((e) => path.join(base, `index${e}`))];
  for (const p of tryPaths) {
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch { /* unreadable — treat as unresolvable */ }
  }
  return null;
}

/**
 * Parse the static imports of a source file into
 * `{ bindings: Map<name, absPath>, modules: Set<absPath> }`.
 *
 * Structure is matched on the MASKED text (so an `import` word inside a comment
 * or a fixture template literal is invisible), but the specifier VALUE is
 * sliced from the ORIGINAL at the same offsets — masking blanks string
 * interiors, and the specifier is a string interior.
 *
 * @param {string} repoRoot
 * @param {string} file absolute path of the importing file
 * @param {string} original
 * @param {string} masked
 * @returns {{bindings: Map<string, string>, modules: Set<string>}}
 */
function parseImports(repoRoot, file, original, masked) {
  const bindings = new Map();
  const modules = new Set();

  const addModule = (spec) => {
    const abs = resolveLocalImport(repoRoot, file, spec);
    if (abs) modules.add(abs);
    return abs;
  };
  /** Slice the specifier value out of the original using the masked match. */
  const specOf = (m, group) => {
    const end = m.index + m[0].length - 1; // closing quote
    return original.slice(end - m[group].length, end);
  };

  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(masked)) !== null) {
    const clause = m[1];
    const abs = addModule(specOf(m, 3));
    if (!abs) continue;
    // `{ a, b as c }` — named; `* as ns` — namespace; `d` — default.
    const named = clause.match(/\{([\s\S]*?)\}/);
    if (named) {
      for (const part of named[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const asMatch = t.match(/^([\w$]+)\s+as\s+([\w$]+)$/);
        bindings.set(asMatch ? asMatch[2] : t.replace(/\s.*$/, ''), abs);
      }
    }
    const ns = clause.match(/\*\s+as\s+([\w$]+)/);
    if (ns) bindings.set(ns[1], abs);
    const head = clause.replace(/\{[\s\S]*?\}/g, '').replace(/\*\s+as\s+[\w$]+/g, '')
      .split(',')[0].trim();
    if (head && /^[\w$]+$/.test(head)) bindings.set(head, abs);
  }

  BARE_IMPORT_RE.lastIndex = 0;
  while ((m = BARE_IMPORT_RE.exec(masked)) !== null) addModule(specOf(m, 2));

  return { bindings, modules };
}

/**
 * Breadth-first import closure of a file, with the shortest chain to each
 * reached module.
 *
 * @param {string} repoRoot
 * @param {string} entry absolute path
 * @param {(abs: string) => {original: string, masked: string} | null} readSource
 * @returns {Map<string, string[]>} absPath → chain of absPaths from entry
 */
function importClosure(repoRoot, entry, readSource) {
  /** @type {Map<string, string[]>} */
  const reached = new Map();
  let frontier = [{ file: entry, chain: [entry] }];
  const visited = new Set([entry]);

  for (let depth = 0; depth < MAX_CLOSURE_DEPTH && frontier.length > 0; depth++) {
    const nextFrontier = [];
    for (const { file, chain } of frontier) {
      const src = readSource(file);
      if (!src) continue;
      const { modules } = parseImports(repoRoot, file, src.original, src.masked);
      for (const mod of modules) {
        if (visited.has(mod)) continue;
        visited.add(mod);
        const nextChain = [...chain, mod];
        reached.set(mod, nextChain);
        nextFrontier.push({ file: mod, chain: nextChain });
      }
    }
    frontier = nextFrontier;
  }
  return reached;
}

// ---------------------------------------------------------------------------
// Oracle — "untracked" = ignored OR (exists on disk AND not in git ls-files)
// ---------------------------------------------------------------------------

/**
 * Ask `git check-ignore` which of `specs` are ignored, adding them to `out`.
 *
 * BISECTING, on purpose. `git check-ignore --stdin` aborts with `fatal` on the
 * first spec it refuses (one escaping `../`, one over-long or exotic string) and
 * DISCARDS THE REST OF THE STREAM — in one intermediate run that swallowed 44 of
 * 45 hits, and it recurred here with a JSON fixture blob. A charset filter alone
 * is an arms race against whatever literal the next test file contains; halving
 * the batch on a fatal isolates the offender in O(log n) spawns and costs at
 * most one dropped candidate instead of the whole result set.
 *
 * @param {string} repoRoot
 * @param {string[]} specs
 * @param {Set<string>} out
 */
function checkIgnoreBatch(repoRoot, specs, out) {
  if (specs.length === 0) return;
  const ci = spawnSync('git', ['check-ignore', '--stdin'], {
    cwd: repoRoot, input: specs.join('\n'), encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // 0 = at least one ignored (listed on stdout); 1 = none ignored; else fatal.
  if (ci.status === 0) {
    for (const line of (ci.stdout || '').split('\n')) {
      const p = line.trim();
      if (p) out.add(p);
    }
    return;
  }
  if (ci.status === 1) return;
  if (specs.length === 1) {
    process.stderr.write(
      `  WARN: git check-ignore rejected "${specs[0]}" — candidate dropped (${(ci.stderr || '').trim().split('\n')[0]})\n`,
    );
    return;
  }
  const mid = specs.length >> 1;
  checkIgnoreBatch(repoRoot, specs.slice(0, mid), out);
  checkIgnoreBatch(repoRoot, specs.slice(mid), out);
}

/**
 * Batch-classify repo-relative candidate paths as untracked.
 *
 * MEASURED PITFALL: `git check-ignore --stdin` aborts with `fatal` on the first
 * spec beginning with `../` and DISCARDS the remainder of the stream (44 of 45
 * hits swallowed in one intermediate run). `normalizeCandidate` already rejects
 * `..` segments and absolute specs; this function re-filters defensively so a
 * caller that bypasses normalization cannot re-open the hole.
 *
 * @param {string} repoRoot
 * @param {Iterable<string>} candidates
 * @returns {{untracked: Set<string>, error: string | null}}
 */
export function resolveUntrackedOracle(repoRoot, candidates) {
  const all = [...new Set(candidates)].filter(
    (c) => typeof c === 'string' && c && !c.startsWith('/') && !c.startsWith('-')
      && !c.includes('\0') && !c.split('/').some((s) => s === '..'),
  );
  const untracked = new Set();
  if (all.length === 0) return { untracked, error: null };

  const ls = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (ls.status !== 0) {
    return { untracked, error: `git ls-files failed: ${(ls.stderr || '').trim()}` };
  }
  const tracked = new Set((ls.stdout || '').split('\0').filter(Boolean));

  checkIgnoreBatch(repoRoot, all, untracked);

  // Second half of the oracle: a FILE that exists on disk but is absent from
  // `git ls-files` — the never-`git add`-ed case `check-ignore` cannot see.
  //
  // Deliberately FILES ONLY. `git ls-files` enumerates files, so every
  // DIRECTORY is trivially "absent" from it — judging directories by this
  // branch condemns `.git` (present in every clone by construction), plus every
  // directory whose tracked children happen to sit one level deeper. Measured:
  // that variant produced 31 findings across 8 test files, of which the
  // directory candidates (`.git`, `.claude`, `docs/prd`, `skills/bootstrap`, …)
  // were all false. A directory can therefore only be condemned by
  // `check-ignore`, which does judge directories correctly.
  for (const c of all) {
    if (untracked.has(c)) continue;
    if (tracked.has(c)) continue;
    try {
      const abs = path.join(repoRoot, c);
      if (existsSync(abs) && statSync(abs).isFile()) untracked.add(c);
    } catch { /* unreadable — not classifiable */ }
  }
  return { untracked, error: null };
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/**
 * Recursively collect `*.test.mjs` under `absDir`.
 * @param {string} absDir
 * @returns {string[]}
 */
function walkTests(absDir) {
  const out = [];
  let entries;
  try {
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) return out;
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch { return out; }
  for (const ent of entries) {
    const full = path.join(absDir, ent.name);
    try {
      if (ent.isDirectory()) out.push(...walkTests(full));
      else if (ent.isFile() && full.endsWith(TEST_SUFFIX)) out.push(full);
    } catch { /* skip unreadable entry */ }
  }
  return out.sort();
}

/**
 * Scan a repository and return every R2/R4 finding.
 *
 * @param {string} repoRoot absolute repo root
 * @returns {{findings: Array<{rule: 'R2'|'R4', file: string, line: number, candidate: string, message: string}>, error: string | null}}
 */
export function scanUntrackedTestDeps(repoRoot) {
  /** @type {Map<string, {original: string, masked: string, lines: string[]}>} */
  const cache = new Map();
  const readSource = (abs) => {
    if (cache.has(abs)) return cache.get(abs);
    let original;
    try { original = readFileSync(abs, 'utf8'); } catch { return null; }
    const entry = { original, masked: maskSource(original), lines: original.split(/\r?\n/) };
    cache.set(abs, entry);
    return entry;
  };
  const rel = (abs) => path.relative(repoRoot, abs).split(path.sep).join('/');

  const testFiles = walkTests(path.join(repoRoot, TESTS_DIR));
  /** @type {Array<{rule: 'R2'|'R4', file: string, line: number, candidate: string, message: string}>} */
  const raw = [];

  for (const testFile of testFiles) {
    const src = readSource(testFile);
    if (!src) continue;
    const lineOf = lineLookup(src.original);
    const calls = scanCalls(src.original, src.masked);

    // ---- R4: cwd-relative read from a bare literal (or an identifier bound
    // to one), with NO join/resolve wrapping. ------------------------------
    /** @type {Map<string, {value: string, line: number}>} */
    const literalBindings = new Map();
    const bindRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])((?:[^'"\\\n]|\\.)*)\2/g;
    let bm;
    while ((bm = bindRe.exec(src.masked)) !== null) {
      const valueStart = bm.index + bm[0].length - bm[3].length - 1;
      const value = src.original.slice(valueStart, valueStart + bm[3].length);
      literalBindings.set(bm[1], { value, line: lineOf(bm.index) });
    }

    for (const call of calls) {
      const bare = call.callee.includes('.') ? call.callee.split('.').pop() : call.callee;
      if (!FS_READ_FNS.has(bare)) continue;
      const first = call.args[0];
      if (!first) continue;
      // The absence of any wrapping IS the rule: a `(` in the argument means a
      // join/resolve/anything-else wrapper, which every tmp fixture target has.
      if (first.includes('(')) continue;
      let value = asStringLiteral(first);
      let bindLine = null;
      if (value === null && WHOLE_IDENT_RE.test(first) && literalBindings.has(first)) {
        value = literalBindings.get(first).value;
        bindLine = literalBindings.get(first).line;
      }
      const candidate = normalizeCandidate(value ?? '');
      if (!candidate) continue;
      const line = lineOf(call.index);
      // Marker on the read line OR on the binding line exempts the finding.
      if (hasMarker(src.lines, line) || (bindLine && hasMarker(src.lines, bindLine))) continue;
      raw.push({
        rule: 'R4',
        file: testFile,
        line,
        candidate,
        message: `${rel(testFile)}:${line} — reads "${candidate}" CWD-RELATIVE via ${bare}() (no join/resolve): the path is NOT in the repository, so this is green locally and absent on a fresh CI clone`,
      });
    }

    // ---- R2: a statically resolvable REAL root passed to a locally imported
    // function whose import closure names an untracked path. ---------------
    const rootVars = new Set();
    const rootBindRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g;
    let rm;
    while ((rm = rootBindRe.exec(src.masked)) !== null) {
      const rhsStart = rm.index + rm[0].length - rm[2].length;
      const rhs = src.original.slice(rhsStart, rhsStart + rm[2].length);
      if (REAL_ROOT_EXPR_RE.test(rhs) && !TMP_ROOT_RE.test(rhs)) rootVars.add(rm[1]);
    }
    const isRootArg = (arg) => {
      const t = arg.trim();
      if (!t) return false;
      if (WHOLE_IDENT_RE.test(t)) return rootVars.has(t);
      return REAL_ROOT_EXPR_RE.test(t) && !TMP_ROOT_RE.test(t);
    };

    const { bindings } = parseImports(repoRoot, testFile, src.original, src.masked);
    /** @type {Array<{callee: string, line: number}>} */
    const armed = [];
    for (const call of calls) {
      const head = call.callee.includes('.') ? call.callee.split('.')[0] : call.callee;
      if (!bindings.has(head)) continue;
      if (!call.args.some(isRootArg)) continue;
      armed.push({ callee: call.callee, line: lineOf(call.index) });
    }
    if (armed.length === 0) continue;

    const closure = importClosure(repoRoot, testFile, readSource);
    /** @type {Set<string>} */
    const reported = new Set();
    for (const [mod, chain] of closure) {
      const modSrc = readSource(mod);
      if (!modSrc) continue;
      for (const { candidate, line: modLine } of extractPathCandidates(modSrc.original, modSrc.masked)) {
        if (reported.has(candidate)) continue;
        const site = armed.find((a) => !hasMarker(src.lines, a.line));
        if (!site) continue;
        reported.add(candidate);
        const chainStr = chain.map(rel).join(' → ');
        raw.push({
          rule: 'R2',
          file: testFile,
          line: site.line,
          candidate,
          message: `${rel(testFile)}:${site.line} — passes a real repo root to \`${site.callee}()\`; its import closure reaches ${rel(mod)}:${modLine}, which names "${candidate}" — a path that is NOT in the repository (chain: ${chainStr})`,
        });
      }
    }
  }

  const { untracked, error } = resolveUntrackedOracle(repoRoot, raw.map((f) => f.candidate));
  return { findings: raw.filter((f) => untracked.has(f.candidate)), error };
}

/**
 * @param {string[]} lines
 * @param {number} lineNo 1-based
 * @returns {boolean}
 */
function hasMarker(lines, lineNo) {
  const l = lines[lineNo - 1];
  return typeof l === 'string' && l.includes(IGNORE_MARKER);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Run the check against a repo root, printing the validate-plugin line
 * vocabulary.
 *
 * @param {string} repoRoot
 * @returns {number} 0 = clean, 1 = finding(s), 2 = tool error
 */
export function runCheckUntrackedTestDeps(repoRoot) {
  console.log('--- Check: untracked test dependencies (R2 transitive / R4 cwd-relative) ---');

  const gitCheck = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: repoRoot, encoding: 'utf8',
  });
  if (gitCheck.status !== 0) {
    console.log(`  FAIL: not a git repository: ${repoRoot} — the untracked oracle needs git`);
    console.log('');
    console.log('Results: 0 passed, 1 failed');
    return 2;
  }

  const { findings, error } = scanUntrackedTestDeps(repoRoot);
  if (error) {
    console.log(`  FAIL: oracle error — ${error}`);
    console.log('');
    console.log('Results: 0 passed, 1 failed');
    return 2;
  }

  const rules = ['R2', 'R4'];
  const hit = new Set(findings.map((f) => f.rule));
  for (const r of rules) {
    if (hit.has(r)) continue;
    const what = r === 'R2'
      ? 'no test passes a real repo root into an import closure that names an untracked path'
      : 'no test reads an untracked path cwd-relative';
    console.log(`  PASS: ${r} — ${what}`);
  }
  for (const f of findings) console.log(`  FAIL: [${f.rule}] ${f.message}`);

  console.log('');
  console.log(`Results: ${rules.length - hit.size} passed, ${findings.length} failed`);
  return findings.length > 0 ? 1 : 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: check-untracked-test-deps.mjs <repo-root>');
    process.exit(2);
  }
  process.exit(runCheckUntrackedTestDeps(path.resolve(root)));
}
