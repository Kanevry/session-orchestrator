#!/usr/bin/env node
/**
 * check-hooks-emit-event-guard.mjs — every `emitEvent(...)` call site under
 * `hooks/**\/*.mjs` must sit lexically inside a `try {} catch {}`, because
 * `emitEvent()` THROWS `EventValidationError` on a malformed record
 * (`scripts/lib/events.mjs`, #1177). An unguarded call site turns a
 * telemetry-shape defect into an uncaught exception inside a
 * PreToolUse/PostToolUse/Stop/SessionEnd/SessionStart hook — several of
 * which are deny-capable. Per `.claude/rules/` "moving a guard from
 * exit-code signalling to stdout-JSON inverts its failure direction": an
 * aborted hook process writes no `permissionDecision` envelope at all, which
 * several harnesses read as fail-OPEN (no decision → default allow) rather
 * than fail-closed. #1183.
 *
 * SCOPE. `hooks/` is out of the file-scope this checker's OWNING task may
 * edit (see the dispatching wave's FILE-SCOPE) — this checker only REPORTS,
 * it never fixes. Five pre-existing unguarded call sites were census'd at
 * HEAD 2ccea0f2 (2026-09-02, GitLab #1183) and were BASELINED below; all
 * five were fixed in the same wave that added the reason/staleness
 * discipline described next (FX-C, MED-3), so `BASELINE_UNGUARDED` is EMPTY
 * on arrival. It stays a `Map<key, reason>`, not a bare `Set`, so the NEXT
 * addition carries a reason from day one — mirroring
 * `check-unwired-features.mjs`'s `ALLOWLIST` precedent verbatim: "Add an
 * entry to `ALLOWLIST` keyed by the FULL dotted key path, whose value is a
 * non-empty reason naming the actual consumer ... Every entry needs a
 * reason — an empty or whitespace-only one is itself reported
 * (`allowlist-missing-reason`) ... The list also drains itself: an entry is
 * reported as `allowlist-stale` both when its key has left every config
 * surface AND when the key stops triggering a finding (i.e. it finally got
 * wired), so a fixed key does not leave a permanent exemption behind." Any
 * unguarded call NOT in the baseline is a genuine regression and FAILs the
 * build; a baseline entry whose site is now guarded or gone FAILs as
 * `baseline-stale`; an entry with an empty reason FAILs as
 * `baseline-missing-reason`. A baselined-but-still-unguarded site (a valid,
 * reasoned entry that still matches) reports as a WARN, never a FAIL, so
 * this checker can ship blocking-by-default without going red on arrival.
 *
 * METHOD (BV-001.5 substitution). A real AST scope-walk via `@babel/parser`
 * (`sourceType: 'module'`, `topLevelAwait` + `importMeta` plugins — the same
 * combination `check-guard-requires-parity.mjs` already parses every hook
 * with), not brace-depth counting over source text. Brace-depth counting is
 * fooled by a `{`/`}` inside a string, template literal, regex literal or
 * comment; a real parser is immune to that class entirely, and
 * `@babel/parser` is already an installed `dependencies` entry (not just
 * `devDependencies`) used for the identical domain — reasoning about the
 * lexical nesting of `hooks/**\/*.mjs`.
 *
 * GUARD DEFINITION. An `emitEvent(...)` `CallExpression` counts as guarded
 * when walking its AST ancestor chain OUTWARD reaches a `TryStatement` —
 * entered via its `.block` property specifically (not `.handler` /
 * `.finalizer`: sitting INSIDE a catch or finally block is not "guarded by"
 * that try) AND carrying a non-null `.handler` (an actual `catch` clause — a
 * bare `try {} finally {}` does not swallow the throw, so it doesn't count
 * either) — BEFORE crossing a function boundary (`FunctionDeclaration`,
 * `FunctionExpression`, `ArrowFunctionExpression`, `ObjectMethod`,
 * `ClassMethod`, `ClassPrivateMethod`). Crossing a function boundary first
 * means the call can only be guarded by ITS OWN function's try, never by an
 * outer function's — this is what makes the textbook false-negative case
 * (`await helper()` inside an outer `try`, where `helper()` itself calls
 * `emitEvent()` unguarded) correctly report unguarded rather than a false
 * negative from naive text-proximity matching.
 *
 * NAMED CEILING (BV-004): a hook file that fails to parse under the plugin
 * set above is reported as a tool-error FAIL for that file — never silently
 * skipped, because a parse failure hiding a finding is worse than a loud
 * one. REVISIT if `hooks/` ever needs syntax outside `topLevelAwait` +
 * `importMeta` (e.g. decorators) — this repo's own ESLint config would need
 * the same addition first, so the two drift together, not silently.
 *
 * Usage: check-hooks-emit-event-guard.mjs <repo-root>
 * Output: `  PASS: …` / `  WARN: …` / `  FAIL: …` lines (two leading
 * spaces), then `Results: N passed, M failed`. Exit 0 = clean (WARNs do not
 * fail the build), 1 = at least one NEW (non-baselined) finding, 2 = tool
 * error.
 *
 * Import-safety: importing this module MUST NOT execute anything — the
 * isMain guard at the bottom is the only side-effecting path.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { listRepoFiles } from './repo-files.mjs';

// ---------------------------------------------------------------------------
// Baseline — Map<key, reason>, keyed on
// `<repo-relative-file>::<event-type-literal>` rather than a line number:
// `hooks/` churns under other waves in this repo's normal operation, and a
// line-number key would silently stop matching (or worse, mismatch a
// DIFFERENT call) on any unrelated edit above a baselined site. A static
// string-literal first argument (as every real emitEvent() call in this
// repo uses) makes the key stable.
//
// Empty on arrival (MED-3, FX-C, 2026-09-02): the five sites census'd at
// HEAD 2ccea0f2 (#1183) were guarded in the same wave that added this Map
// plus the baseline-stale / baseline-missing-reason detection below. A
// future addition MUST carry a non-empty reason naming the linked issue —
// an empty reason fails as `baseline-missing-reason`, and an entry whose
// site is later guarded (or removed) fails as `baseline-stale` rather than
// lingering as a silent, permanent WARN exemption.
// ---------------------------------------------------------------------------

const BASELINE_UNGUARDED = new Map();

const HOOKS_DIR_REL = 'hooks';

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

/** AST metadata keys that are never worth descending into (no code nesting). */
const SKIP_KEYS = new Set([
  'loc',
  'start',
  'end',
  'extra',
  'tokens',
  'comments',
  'errors',
  'leadingComments',
  'trailingComments',
  'innerComments',
]);

/**
 * Parse a source module with the same syntax family used by this repository
 * for `hooks/**\/*.mjs` (mirrors `check-guard-requires-parity.mjs`).
 *
 * @param {string} source
 * @param {string} filename
 * @returns {import('@babel/parser').ParseResult<import('@babel/types').File>}
 */
function parseModule(source, filename) {
  return parse(source, {
    sourceType: 'module',
    sourceFilename: filename,
    errorRecovery: false,
    plugins: ['topLevelAwait', 'importMeta'],
  });
}

/**
 * @param {{node: any, key: string | number}[]} ancestors outer→inner
 * @returns {boolean}
 */
function isGuardedByTry(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const { node, key } = ancestors[i];
    if (FUNCTION_TYPES.has(node.type)) return false; // own function's scope — stop here
    if (node.type === 'TryStatement' && key === 'block' && node.handler !== null && node.handler !== undefined) return true;
  }
  return false;
}

/**
 * @param {any} callNode a CallExpression node
 * @returns {string | null} the first argument's literal string value, else null
 */
function eventTypeLiteral(callNode) {
  const arg = callNode.arguments?.[0];
  return arg && arg.type === 'StringLiteral' ? arg.value : null;
}

/**
 * Find every `emitEvent(...)` call site in `source` and classify each as
 * guarded/unguarded per {@link isGuardedByTry}.
 *
 * @param {string} source
 * @param {string} filename repo-relative path, used only for parse error messages
 * @returns {{line: number, guarded: boolean, eventType: string | null}[]}
 */
export function findEmitEventCalls(source, filename) {
  const ast = parseModule(source, filename);
  const calls = [];

  /**
   * @param {any} node
   * @param {{node: any, key: string | number}[]} ancestors
   */
  function visit(node, ancestors) {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, ancestors);
      return;
    }
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;

    if (
      node.type === 'CallExpression' &&
      node.callee?.type === 'Identifier' &&
      node.callee.name === 'emitEvent'
    ) {
      calls.push({
        line: node.loc?.start?.line ?? 0,
        guarded: isGuardedByTry(ancestors),
        eventType: eventTypeLiteral(node),
      });
    }

    for (const [key, child] of Object.entries(node)) {
      if (SKIP_KEYS.has(key)) continue;
      if (child && typeof child === 'object') {
        ancestors.push({ node, key });
        visit(child, ancestors);
        ancestors.pop();
      }
    }
  }

  visit(ast.program, []);
  return calls;
}

/**
 * @typedef {{kind: 'unguarded', file: string, line: number, eventType: string | null, baselined: boolean}} UnguardedFinding
 * @typedef {{kind: 'baseline-stale' | 'baseline-missing-reason', key: string, message: string}} BaselineFinding
 * @typedef {UnguardedFinding | BaselineFinding} Finding
 */

/**
 * @param {string} repoRoot
 * @param {{baseline?: Map<string, string>}} [options] `baseline` defaults to
 *   the module-level `BASELINE_UNGUARDED` (empty in production); injectable
 *   so tests can exercise `baseline-stale` / `baseline-missing-reason`
 *   against a synthetic map without mutating the shipped baseline.
 * @returns {{findings: Finding[], parseErrors: {file: string, message: string}[]}}
 */
export function scanHooksEmitEventGuard(repoRoot, { baseline = BASELINE_UNGUARDED } = {}) {
  const files = listRepoFiles(repoRoot, { dirs: [HOOKS_DIR_REL], exts: ['mjs'] });
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{file: string, message: string}[]} */
  const parseErrors = [];
  /** @type {Set<string>} baseline keys that matched a real unguarded call site this scan */
  const flagged = new Set();

  for (const absFile of files) {
    const rel = path.relative(repoRoot, absFile).split(path.sep).join('/');
    let source;
    try {
      source = readFileSync(absFile, 'utf8');
    } catch (err) {
      parseErrors.push({ file: rel, message: `unreadable: ${err?.message ?? String(err)}` });
      continue;
    }
    if (!source.includes('emitEvent(')) continue; // cheap textual pre-filter

    let calls;
    try {
      calls = findEmitEventCalls(source, rel);
    } catch (err) {
      parseErrors.push({ file: rel, message: err?.message ?? String(err) });
      continue;
    }

    for (const call of calls) {
      if (call.guarded) continue;
      const key = `${rel}::${call.eventType ?? `L${call.line}`}`;
      const isBaselined = baseline.has(key);
      if (isBaselined) {
        flagged.add(key);
        const reason = baseline.get(key);
        if (String(reason ?? '').trim() === '') {
          findings.push({
            kind: 'baseline-missing-reason',
            key,
            message: 'baseline entry has no reason — name the linked issue or remove the entry',
          });
        }
      }
      findings.push({
        kind: 'unguarded',
        file: rel,
        line: call.line,
        eventType: call.eventType,
        baselined: isBaselined,
      });
    }
  }

  // Mirrors check-unwired-features.mjs's ALLOWLIST drain (see the header
  // quote above): a baseline entry that no longer matches ANY unguarded call
  // site this scan found — because the site is now guarded, or gone
  // entirely — is stale and must be removed, not left as a permanent
  // exemption.
  for (const key of baseline.keys()) {
    if (flagged.has(key)) continue;
    findings.push({
      kind: 'baseline-stale',
      key,
      message: 'baseline entry no longer matches an unguarded call site (guarded or removed) — remove the entry',
    });
  }

  return { findings, parseErrors };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Run the check against a repo root, printing the validate-plugin line
 * vocabulary.
 *
 * @param {string} repoRoot
 * @param {{baseline?: Map<string, string>}} [options] forwarded to
 *   {@link scanHooksEmitEventGuard} — see its JSDoc for why this is
 *   injectable (test-only; the CLI entrypoint below never passes it).
 * @returns {number} 0 = clean (baselined WARNs allowed), 1 = new finding(s), 2 = tool error
 */
export function runCheckHooksEmitEventGuard(repoRoot, options) {
  console.log('--- Check: hooks emitEvent() try/catch guard (#1183) ---');

  const { findings, parseErrors } = scanHooksEmitEventGuard(repoRoot, options);

  if (parseErrors.length > 0) {
    for (const e of parseErrors) console.log(`  FAIL: ${e.file} — ${e.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${parseErrors.length} failed`);
    return 2;
  }

  const unguarded = findings.filter((f) => f.kind === 'unguarded');
  const baselineIssues = findings.filter((f) => f.kind === 'baseline-stale' || f.kind === 'baseline-missing-reason');

  const newUnguarded = unguarded.filter((f) => !f.baselined);
  const baselinedUnguarded = unguarded.filter((f) => f.baselined);

  if (newUnguarded.length === 0 && baselineIssues.length === 0) {
    console.log(
      baselinedUnguarded.length === 0
        ? '  PASS: every hooks/**/*.mjs emitEvent() call site is try/catch-guarded'
        : `  PASS: no NEW unguarded emitEvent() call sites (${baselinedUnguarded.length} pre-existing, baselined — see #1183)`,
    );
  }
  for (const f of baselinedUnguarded) {
    console.log(
      `  WARN: ${f.file}:${f.line} — emitEvent('${f.eventType ?? '?'}') not inside a try/catch (pre-existing, baselined #1183 — out of this checker's file-scope to fix)`,
    );
  }
  for (const f of newUnguarded) {
    console.log(
      `  FAIL: ${f.file}:${f.line} — emitEvent('${f.eventType ?? '?'}') not inside a try/catch — a throw here aborts the hook process`,
    );
  }
  for (const f of baselineIssues) {
    console.log(`  FAIL: ${f.key} — ${f.message} (${f.kind})`);
  }

  const failCount = newUnguarded.length + baselineIssues.length;
  console.log('');
  console.log(`Results: ${failCount === 0 ? 1 : 0} passed, ${failCount} failed`);
  return failCount > 0 ? 1 : 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '').href;
if (isMain) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: check-hooks-emit-event-guard.mjs <repo-root>');
    process.exit(2);
  }
  process.exit(runCheckHooksEmitEventGuard(path.resolve(root)));
}
