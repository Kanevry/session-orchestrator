#!/usr/bin/env node
/**
 * check-hook-entry-guards.mjs — recurrence guard for #1393: every hook
 * REGISTERED in a platform manifest must run its handler ONLY when it is the
 * script node was invoked with. #1422.
 *
 * ## The gap this fills (and why the existing checker cannot)
 *
 * `./check-entry-guard.mjs` (#1371) censuses guards that are ALREADY THERE for
 * symlink-fragile comparison forms. Its oracle only ever looks at statement
 * fragments that mention the invocation-path expression — so a hook file
 * carrying NO guard at all is never seen by it and passes trivially. That is
 * exactly the regression #1393 fixed across 25 hooks, and exactly the shape
 * nothing would have caught coming back.
 *
 * The two checkers are complements, not overlaps:
 *
 *   | checker                | question                                  |
 *   |------------------------|-------------------------------------------|
 *   | `check-entry-guard`    | is the guard that EXISTS written safely?  |
 *   | this one               | is there a guard AT ALL, around the entry? |
 *
 * ## Why it matters, measured (#1393, 2026-09-20)
 *
 * Before the sweep, under `SO_HOOK_PROFILE=off`, EVERY one of the 11
 * registered hooks in one agent's half killed the process that merely
 * IMPORTED it — the profile gate's `process.exit(0)` sat at module top level.
 * Under a default environment only 3 of 28 were observably broken, because
 * the exit is CONDITIONAL. A defect that is invisible in the common
 * environment and total in the uncommon one is precisely the kind worth a
 * mechanical oracle rather than a reviewer's attention.
 *
 * The cost side has a name too: `post-tool-failure-corrective-context.mjs`
 * did not merely exit on import — it WROTE a PostToolUseFailure envelope onto
 * the importer's stdout.
 *
 * ## Population
 *
 * The union of every `.mjs` path appearing in a `command` string of the four
 * platform manifests: `hooks/hooks.json` (Claude Code), `hooks-codex.json`,
 * `hooks-cursor.json`, `hooks-pi.json`. The three foreign manifests are
 * subsets of the first today, but they are read anyway so a hook registered
 * ONLY on a foreign platform can never fall out of the census. A manifest
 * file that does not exist is SKIPPED (not an error): a consumer repo, or a
 * fork, may legitimately ship fewer platforms.
 *
 * A path is normalised by taking the last `hooks` path SEGMENT onward, so
 * `"$CURSOR_PLUGIN_ROOT/hooks/on-stop.mjs"` and `hooks/on-stop.mjs` are one
 * entry, while a hypothetical `subhooks/x.mjs` is not mistaken for one (the
 * match is on a whole segment, never a substring).
 *
 * ## Findings
 *
 * - `missing-entry-guard` — the file has no guard construct at all, or a
 *   module-top-level `main(...)` call sits OUTSIDE one. Either way a bare
 *   `import()` of the file runs the handler.
 * - `toplevel-profile-exit` — a `shouldRunHook(...)` call at module top level,
 *   outside the guard, in a statement that also calls `process.exit`. This is
 *   the #1393 defect verbatim: importing the hook terminates the IMPORTER
 *   whenever the profile happens to disable that hook.
 *
 * `unregistered-file` is deliberately NOT a finding here — whether a hook file
 * on disk is wired into a manifest is `check-plugin-hooks`-shaped work, a
 * different question with a different population.
 *
 * ## Method (AST, not regex)
 *
 * `@babel/parser` (already a `dependencies` entry, used for the identical
 * domain by `check-hooks-emit-event-guard.mjs` and
 * `check-guard-requires-parity.mjs`), `sourceType: 'module'` with
 * `topLevelAwait` + `importMeta`. The two questions asked — "does this call
 * sit lexically inside an `if` whose test is the guard" and "is this call at
 * module top level, i.e. inside no function" — are questions about lexical
 * nesting, which a text scan answers only by accident: a brace inside a
 * string, a template literal or a regex literal defeats brace counting, and
 * #1383 is this repo's own record of a regex literal blanking a guard for a
 * lexer that did not know regex literals.
 *
 * A file that fails to parse is a tool error (exit 2), never a silent skip.
 *
 * ## Recognised guard forms
 *
 *   if (isMainModule(import.meta.url)) { … }      // 24 of 27 hooks
 *   if (invokedAsScript()) { … }                  // the documented inline
 *                                                 // form, 3 of 27 hooks
 *   const isMain = isMainModule(import.meta.url); // the indirected variant
 *   if (isMain) { … }
 *
 * NAMED CEILING (BV-004): the entry call this checker recognises is
 * `main(...)` by name. A hook naming its entry differently is still covered by
 * the stronger of the two rules — a file with NO guard construct at all is a
 * finding regardless of how its entry is spelled — so the ceiling costs only
 * the second rule (a SECOND, unguarded entry call in a file that does have a
 * guard). REVISIT by extending `ENTRY_NAMES` if a hook ever names its entry
 * something else; do not weaken the rule to "any top-level call", which would
 * flag every legitimate top-level `const X = loadThing()`.
 *
 * ## Mode: BLOCKING
 *
 * Census at HEAD 98d06598 (2026-09-22): 27 registered `.mjs`, 27 guarded,
 * 0 top-level profile exits. A blocking gate is only dishonest when it is red
 * on arrival for work nobody intends to do; this one is green on arrival
 * because #1393 drained the backlog first.
 *
 * Usage: check-hook-entry-guards.mjs [<repo-root>]
 * Output: `  PASS: …` / `  FAIL: …` lines (two leading spaces), then
 * `Results: N passed, M failed`. Exit 0 = clean, 1 = finding(s), 2 = tool
 * error (unparseable/unreadable hook, or an empty census).
 *
 * Import-safety: importing this module MUST NOT execute anything — the
 * isMain guard at the bottom is the only side-effecting path. (This checker
 * would report itself otherwise.)
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import { isMainModule } from '../is-main-module.mjs';

/**
 * Exempted hook files, `Map<repo-relative-path, reason>`.
 *
 * EMPTY on arrival and kept as a frozen MECHANISM rather than deleted — the
 * same shape `check-entry-guard.mjs`'s `ALLOWLIST` and
 * `check-hooks-emit-event-guard.mjs`'s `BASELINE_UNGUARDED` already use in
 * this directory: the next hand-verified exception is exactly what would
 * re-populate it, and an entry that carries no reason from day one rots into
 * a silent permanent suppression. A baselined file still REPORTS (as a WARN),
 * and an entry that no longer matches any finding is itself a FAIL
 * (`baseline-stale`), so the list drains itself.
 *
 * @type {Map<string, string>}
 */
export const BASELINE = Object.freeze(new Map());

/** The four platform manifests, repo-relative. A missing one is skipped. */
export const MANIFESTS = Object.freeze([
  'hooks/hooks.json',
  'hooks/hooks-codex.json',
  'hooks/hooks-cursor.json',
  'hooks/hooks-pi.json',
]);

/** Entry-function names treated as "runs the handler". See the NAMED CEILING. */
const ENTRY_NAMES = new Set(['main']);

/** Node types that open a new function scope — crossing one leaves top level. */
const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ObjectMethod',
  'ClassMethod',
  'ClassPrivateMethod',
]);

/** AST metadata keys with no code nesting — never descended into. */
const SKIP_KEYS = new Set([
  'loc', 'start', 'end', 'extra', 'tokens', 'comments', 'errors',
  'leadingComments', 'trailingComments', 'innerComments',
]);

/**
 * The exact shape a registered hook's tail must have. Quoted verbatim in
 * every remedy so the fix needs no second file open.
 *
 * @param {string} hookName basename without extension
 * @returns {string}
 */
function targetForm(hookName) {
  return (
    `if (isMainModule(import.meta.url)) { ` +
    `if (!shouldRunHook('${hookName}')) process.exit(0); main()... }`
  );
}

const WHY =
  '#1393: a bare `import()` of a registered hook must run no handler and must ' +
  'not terminate the importing process — measured under SO_HOOK_PROFILE=off, ' +
  'every hook whose profile gate sat at module top level killed its importer, ' +
  "and one of them wrote a PostToolUseFailure envelope onto the importer's stdout";

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

/**
 * Every `command` string value anywhere inside a parsed manifest.
 *
 * @param {unknown} node
 * @param {string[]} out
 * @returns {void}
 */
function collectCommands(node, out) {
  if (Array.isArray(node)) {
    for (const item of node) collectCommands(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'command' && typeof value === 'string') out.push(value);
    else collectCommands(value, out);
  }
}

/**
 * Normalise one whitespace/quote-delimited token to a repo-relative hook path,
 * anchored on a whole `hooks` path SEGMENT (so `subhooks/x.mjs` is not one).
 *
 * @param {string} token
 * @returns {string | null}
 */
function normaliseHookPath(token) {
  const segments = token.split('/');
  const idx = segments.lastIndexOf('hooks');
  if (idx === -1) return null;
  return segments.slice(idx).join('/');
}

const MJS_TOKEN = /[^\s"']*\/?hooks\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.mjs/g;

/**
 * The union population: every `.mjs` registered by any present manifest.
 *
 * @param {string} repoRoot absolute repo root
 * @returns {{files: string[], manifests: {rel: string, present: boolean, count: number}[], errors: {file: string, message: string}[]}}
 */
export function collectRegisteredHooks(repoRoot) {
  /** @type {Map<string, Set<string>>} hook path -> manifests registering it */
  const registry = new Map();
  const manifests = [];
  const errors = [];

  for (const rel of MANIFESTS) {
    const abs = path.join(repoRoot, rel);
    if (!existsSync(abs)) {
      manifests.push({ rel, present: false, count: 0 });
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      errors.push({ file: rel, message: `unparseable manifest: ${err?.message ?? String(err)}` });
      manifests.push({ rel, present: true, count: 0 });
      continue;
    }
    /** @type {string[]} */
    const commands = [];
    collectCommands(parsed, commands);
    let count = 0;
    for (const command of commands) {
      MJS_TOKEN.lastIndex = 0;
      let match;
      while ((match = MJS_TOKEN.exec(command)) !== null) {
        const hookPath = normaliseHookPath(match[0]);
        if (!hookPath) continue;
        if (!registry.has(hookPath)) registry.set(hookPath, new Set());
        registry.get(hookPath).add(rel);
        count += 1;
      }
    }
    manifests.push({ rel, present: true, count });
  }

  return { files: [...registry.keys()].sort(), manifests, errors };
}

// ---------------------------------------------------------------------------
// AST oracle
// ---------------------------------------------------------------------------

/**
 * @param {string} source
 * @param {string} filename repo-relative, for parse-error messages only
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
 * `isMainModule(import.meta.url)` or `invokedAsScript()`.
 *
 * @param {any} node
 * @returns {boolean}
 */
function isGuardCall(node) {
  if (!node || node.type !== 'CallExpression' || node.callee?.type !== 'Identifier') return false;
  const name = node.callee.name;
  if (name === 'invokedAsScript') return node.arguments.length === 0;
  if (name !== 'isMainModule') return false;
  const arg = node.arguments[0];
  return (
    arg?.type === 'MemberExpression' &&
    arg.property?.type === 'Identifier' &&
    arg.property.name === 'url' &&
    arg.object?.type === 'MetaProperty'
  );
}

/**
 * Module-level `const X = <guard call>` names — the indirected guard form
 * (`const isMain = invokedAsScript(); if (isMain) {…}`), used by
 * `hooks/post-bash-write-verify.mjs` among others.
 *
 * @param {any} program
 * @returns {Set<string>}
 */
function guardVariableNames(program) {
  const names = new Set();
  for (const stmt of program.body) {
    if (stmt.type !== 'VariableDeclaration') continue;
    for (const decl of stmt.declarations) {
      if (decl.id?.type === 'Identifier' && isGuardCall(decl.init)) names.add(decl.id.name);
    }
  }
  return names;
}

/**
 * Is this `if` test the entry guard? Accepts the direct call, the indirected
 * identifier, and either side of a `&&`/`||` (a guard ANDed with an extra
 * condition still gates the body behind the guard).
 *
 * @param {any} node
 * @param {Set<string>} guardVars
 * @returns {boolean}
 */
function isGuardTest(node, guardVars) {
  if (!node) return false;
  if (isGuardCall(node)) return true;
  if (node.type === 'Identifier') return guardVars.has(node.name);
  if (node.type === 'LogicalExpression') {
    return isGuardTest(node.left, guardVars) || isGuardTest(node.right, guardVars);
  }
  return false;
}

/**
 * Walk the ancestor chain outward.
 *
 * @param {{node: any, key: string | number}[]} ancestors outer→inner
 * @param {Set<string>} guardVars
 * @returns {{inFunction: boolean, inGuard: boolean}}
 */
function classifyPosition(ancestors, guardVars) {
  let inFunction = false;
  let inGuard = false;
  for (let i = ancestors.length - 1; i >= 0; i -= 1) {
    const { node, key } = ancestors[i];
    if (FUNCTION_TYPES.has(node.type)) inFunction = true;
    if (
      node.type === 'IfStatement' &&
      key === 'consequent' &&
      isGuardTest(node.test, guardVars)
    ) {
      inGuard = true;
    }
  }
  return { inFunction, inGuard };
}

/**
 * @typedef {{kind: 'missing-entry-guard' | 'toplevel-profile-exit', file: string, line: number, detail: string}} Finding
 */

/**
 * Analyse one hook module body.
 *
 * @param {string} source
 * @param {string} rel repo-relative path (finding key + parse-error message)
 * @returns {{findings: Finding[], guardCount: number, entryCalls: number}}
 */
export function analyzeHookSource(source, rel) {
  const ast = parseModule(source, rel);
  const program = ast.program;
  const guardVars = guardVariableNames(program);

  let guardCount = 0;
  let entryCalls = 0;
  /** @type {Finding[]} */
  const findings = [];
  const hookName = path.basename(rel, '.mjs');

  /** Top-level statement index → does it contain a top-level `process.exit` call? */
  const exitStatements = new Set();
  /** Candidate top-level unguarded `shouldRunHook` calls, keyed by statement index. */
  const profileCalls = [];

  let stmtIndex = -1;

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

    if (node.type === 'IfStatement' && isGuardTest(node.test, guardVars)) guardCount += 1;

    if (node.type === 'CallExpression') {
      const callee = node.callee;
      const calleeName = callee?.type === 'Identifier' ? callee.name : null;

      if (calleeName && ENTRY_NAMES.has(calleeName)) {
        const { inFunction, inGuard } = classifyPosition(ancestors, guardVars);
        if (!inFunction) {
          entryCalls += 1;
          if (!inGuard) {
            findings.push({
              kind: 'missing-entry-guard',
              file: rel,
              line: node.loc?.start?.line ?? 0,
              detail:
                `module-top-level \`${calleeName}()\` call outside any entry guard — ` +
                `importing this file RUNS the handler. Wrap it: ${targetForm(hookName)}`,
            });
          }
        }
      }

      if (calleeName === 'shouldRunHook') {
        const { inFunction, inGuard } = classifyPosition(ancestors, guardVars);
        if (!inFunction && !inGuard) {
          profileCalls.push({ stmtIndex, line: node.loc?.start?.line ?? 0 });
        }
      }

      if (
        callee?.type === 'MemberExpression' &&
        callee.object?.type === 'Identifier' &&
        callee.object.name === 'process' &&
        callee.property?.type === 'Identifier' &&
        callee.property.name === 'exit'
      ) {
        const { inFunction } = classifyPosition(ancestors, guardVars);
        if (!inFunction) exitStatements.add(stmtIndex);
      }
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

  for (let i = 0; i < program.body.length; i += 1) {
    stmtIndex = i;
    visit(program.body[i], [{ node: program, key: 'body' }]);
  }

  for (const call of profileCalls) {
    if (!exitStatements.has(call.stmtIndex)) continue;
    findings.push({
      kind: 'toplevel-profile-exit',
      file: rel,
      line: call.line,
      detail:
        'module-top-level `shouldRunHook(…)` whose statement calls `process.exit` — ' +
        'importing this file TERMINATES the importing process whenever the profile ' +
        `disables this hook. Move the gate inside the entry guard: ${targetForm(hookName)}`,
    });
  }

  if (guardCount === 0) {
    findings.unshift({
      kind: 'missing-entry-guard',
      file: rel,
      line: 0,
      detail:
        'no entry guard anywhere in the file — neither `if (isMainModule(import.meta.url))` ' +
        `nor \`if (invokedAsScript())\`. Required tail: ${targetForm(hookName)}`,
    });
  }

  return { findings, guardCount, entryCalls };
}

/**
 * Scan every registered hook.
 *
 * @param {string} repoRoot absolute repo root
 * @param {{baseline?: Map<string, string>}} [options] `baseline` defaults to
 *   the module-level {@link BASELINE} (empty in production); injectable so
 *   tests exercise the WARN / `baseline-stale` paths without mutating it.
 * @returns {{findings: Finding[], baselineFindings: {key: string, message: string}[], toolErrors: {file: string, message: string}[], registered: string[], guarded: number, manifests: {rel: string, present: boolean, count: number}[]}}
 */
export function scanHookEntryGuards(repoRoot, { baseline = BASELINE } = {}) {
  const { files, manifests, errors } = collectRegisteredHooks(repoRoot);
  /** @type {Finding[]} */
  const findings = [];
  /** @type {{file: string, message: string}[]} */
  const toolErrors = [...errors];
  const flagged = new Set();
  let guarded = 0;

  for (const rel of files) {
    const abs = path.join(repoRoot, rel);
    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch (err) {
      toolErrors.push({ file: rel, message: `registered but unreadable: ${err?.message ?? String(err)}` });
      continue;
    }
    let result;
    try {
      result = analyzeHookSource(source, rel);
    } catch (err) {
      toolErrors.push({ file: rel, message: `parse failed: ${err?.message ?? String(err)}` });
      continue;
    }
    if (result.findings.length === 0) guarded += 1;
    else flagged.add(rel);
    for (const finding of result.findings) {
      findings.push({ ...finding, baselined: baseline.has(rel) });
    }
  }

  /** @type {{key: string, message: string}[]} */
  const baselineFindings = [];
  for (const [key, reason] of baseline.entries()) {
    if (!flagged.has(key)) {
      baselineFindings.push({
        key,
        message: 'baseline entry no longer matches a finding (guarded or deregistered) — remove it',
      });
    } else if (String(reason ?? '').trim() === '') {
      baselineFindings.push({
        key,
        message: 'baseline entry has no reason — name the linked issue or remove the entry',
      });
    }
  }

  return { findings, baselineFindings, toolErrors, registered: files, guarded, manifests };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Run the check, printing the validate-plugin line vocabulary.
 *
 * @param {string} repoRoot absolute repo root
 * @param {{baseline?: Map<string, string>}} [options] forwarded to {@link scanHookEntryGuards}
 * @returns {number} 0 clean · 1 finding(s) · 2 tool error (incl. empty census)
 */
export function runCheckHookEntryGuards(repoRoot, options) {
  const { findings, baselineFindings, toolErrors, registered, guarded, manifests } =
    scanHookEntryGuards(repoRoot, options);

  if (toolErrors.length > 0) {
    for (const e of toolErrors) console.log(`  FAIL: ${e.file} — ${e.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${toolErrors.length} failed`);
    return 2;
  }

  // Vacuum guard: an empty census is never green. A manifest that moved, a
  // command shape this extractor stopped recognising, or a fixture root with
  // no hooks at all would otherwise report PASS over nothing — the exact
  // failure mode this checker exists to prevent, one level up.
  if (registered.length === 0) {
    const present = manifests.filter((m) => m.present).map((m) => m.rel);
    console.log(
      `  FAIL: no registered hook .mjs found in ${present.length} present manifest(s)` +
        `${present.length > 0 ? ` (${present.join(', ')})` : ''} — an empty census cannot be clean`,
    );
    console.log('');
    console.log('Results: 0 passed, 1 failed');
    return 2;
  }

  const live = findings.filter((f) => !f.baselined);
  const warned = findings.filter((f) => f.baselined);

  if (live.length === 0 && baselineFindings.length === 0) {
    const presentCount = manifests.filter((m) => m.present).length;
    console.log(
      `  PASS: ${guarded}/${registered.length} registered hook module(s) across ` +
        `${presentCount} manifest(s) run their entry only under an entry guard ` +
        '(0 missing-entry-guard, 0 toplevel-profile-exit)',
    );
  }
  for (const f of warned) {
    console.log(`  WARN: ${f.file}:${f.line} — ${f.kind}: ${f.detail} (baselined)`);
  }
  for (const f of live) {
    console.log(`  FAIL: ${f.file}:${f.line} — ${f.kind}: ${f.detail}. WHY — ${WHY}`);
  }
  for (const b of baselineFindings) {
    console.log(`  FAIL: ${b.key} — ${b.message}`);
  }

  const failCount = live.length + baselineFindings.length;
  console.log('');
  console.log(`Results: ${failCount === 0 ? 1 : 0} passed, ${failCount} failed`);
  return failCount > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const usage =
    'Usage: check-hook-entry-guards.mjs [<repo-root>]\n' +
    'Exit: 0 clean · 1 missing entry guard / top-level profile exit · 2 tool error';
  if (argv.includes('--help')) {
    console.log(usage);
    process.exitCode = 0;
  } else {
    const unknown = argv.filter((a) => a.startsWith('--') && a !== '--help');
    if (unknown.length > 0) {
      console.error(`Unknown flag(s): ${unknown.join(', ')}\n${usage}`);
      process.exitCode = 1;
    } else {
      const positional = argv.filter((a) => !a.startsWith('--'));
      console.log('--- Check: registered hook entry guards (#1422) ---');
      process.exitCode = runCheckHookEntryGuards(path.resolve(positional[0] ?? process.cwd()));
    }
  }
}
