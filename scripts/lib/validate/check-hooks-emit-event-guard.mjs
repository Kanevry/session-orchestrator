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
 * HEAD 2ccea0f2 (2026-09-02, GitLab #1183) and are BASELINED below: each
 * reports as a WARN, never a FAIL, so this checker can ship blocking-by-
 * default without going red on arrival. Any unguarded call NOT in the
 * baseline is a genuine regression and FAILs the build. Shrink the baseline
 * as sites get fixed under their own file-scope; never grow it silently — a
 * baseline addition with no linked issue defeats the point of a baseline.
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
// Baseline — pre-existing unguarded sites, census'd at HEAD 2ccea0f2
// (2026-09-02, #1183). Keyed on `<repo-relative-file>::<event-type-literal>`
// rather than a line number: `hooks/` churns under other waves in this
// repo's normal operation, and a line-number key would silently stop
// matching (or worse, mismatch a DIFFERENT call) on any unrelated edit
// above these sites. All five call sites pass a static string literal as
// their first argument, so this key is stable.
// ---------------------------------------------------------------------------

const BASELINE_UNGUARDED = new Set([
  'hooks/on-session-end.mjs::orchestrator.session.ended',
  'hooks/pre-bash-memory-propose-audit.mjs::orchestrator.memory.propose_invoked',
  'hooks/on-session-start.mjs::orchestrator.session.started',
  'hooks/on-stop.mjs::orchestrator.session.stopped',
  'hooks/on-stop.mjs::orchestrator.agent.stopped',
]);

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
 * @typedef {{file: string, line: number, eventType: string | null, baselined: boolean}} Finding
 */

/**
 * @param {string} repoRoot
 * @returns {{findings: Finding[], parseErrors: {file: string, message: string}[]}}
 */
export function scanHooksEmitEventGuard(repoRoot) {
  const files = listRepoFiles(repoRoot, { dirs: [HOOKS_DIR_REL], exts: ['mjs'] });
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{file: string, message: string}[]} */
  const parseErrors = [];

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
      findings.push({
        file: rel,
        line: call.line,
        eventType: call.eventType,
        baselined: BASELINE_UNGUARDED.has(key),
      });
    }
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
 * @returns {number} 0 = clean (baselined WARNs allowed), 1 = new finding(s), 2 = tool error
 */
export function runCheckHooksEmitEventGuard(repoRoot) {
  console.log('--- Check: hooks emitEvent() try/catch guard (#1183) ---');

  const { findings, parseErrors } = scanHooksEmitEventGuard(repoRoot);

  if (parseErrors.length > 0) {
    for (const e of parseErrors) console.log(`  FAIL: ${e.file} — ${e.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${parseErrors.length} failed`);
    return 2;
  }

  const newFindings = findings.filter((f) => !f.baselined);
  const baselinedFindings = findings.filter((f) => f.baselined);

  if (newFindings.length === 0) {
    console.log(
      baselinedFindings.length === 0
        ? '  PASS: every hooks/**/*.mjs emitEvent() call site is try/catch-guarded'
        : `  PASS: no NEW unguarded emitEvent() call sites (${baselinedFindings.length} pre-existing, baselined — see #1183)`,
    );
  }
  for (const f of baselinedFindings) {
    console.log(
      `  WARN: ${f.file}:${f.line} — emitEvent('${f.eventType ?? '?'}') not inside a try/catch (pre-existing, baselined #1183 — out of this checker's file-scope to fix)`,
    );
  }
  for (const f of newFindings) {
    console.log(
      `  FAIL: ${f.file}:${f.line} — emitEvent('${f.eventType ?? '?'}') not inside a try/catch — a throw here aborts the hook process`,
    );
  }

  console.log('');
  console.log(`Results: ${newFindings.length === 0 ? 1 : 0} passed, ${newFindings.length} failed`);
  return newFindings.length > 0 ? 1 : 0;
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
