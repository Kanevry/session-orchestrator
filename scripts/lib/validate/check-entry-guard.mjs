#!/usr/bin/env node
/**
 * check-entry-guard.mjs — census of SYMLINK-FRAGILE ESM entry guards.
 *
 * ## The defect class (#1371)
 *
 * A module that runs `main()` only when invoked as a CLI compares "the module I
 * am" against "the script Node was told to run". The two are not the same kind
 * of path: Node resolves `import.meta.url` to the **realpath**, while
 * `process.argv[1]` is the path **as typed**. With a symlink anywhere in the
 * invocation path — a `node_modules/.bin/` shim, a `~/bin` convenience link, a
 * plugin directory symlinked into `~/.claude/plugins/`, or `/tmp` itself (a
 * symlink to `/private/tmp` on macOS) — the comparison is false.
 *
 * The failure mode is the worst shape a defect can have: `main()` never runs,
 * nothing is printed, and the process exits 0. Every caller reads that as
 * success.
 *
 * The fix is `isMainModule()` from `scripts/lib/is-main-module.mjs`, which
 * realpaths BOTH sides. This check is the recurrence guard: it fails the build
 * when a new hand-written comparison appears.
 *
 * ## Oracle
 *
 * Over every tracked `.mjs` under `scripts/` + `hooks/` (via `git ls-files`,
 * so an untracked scratch file is never a finding):
 *
 *   1. strip comments (line comments, trailing `//`, and block comments),
 *   2. split the remainder into statement fragments on `;{}`,
 *   3. inside each fragment mentioning `process.argv[1]`, apply two oracles:
 *      a. **comparison form** — take every `===` / `!==` comparison and its two
 *         operands (bounded to the adjacent `&&` / `||` segment) and FAIL when
 *         one operand mentions `process.argv[1]` and the other mentions
 *         `import.meta.url` or `__filename`;
 *      b. **bare-basename form** — FAIL on `process.argv[1].endsWith('x.mjs')`
 *         (plus the `?.`, `String(...)` and `(argv[1] || '')` receiver
 *         variants) against a `.mjs`/`.js`/`.cjs` string literal. This form has
 *         no comparison operator at all, so oracle (a) never saw it.
 *   4. In both cases, a fragment wrapping either side in a `realpath*` call is
 *      the safe idiom and must not be flagged.
 *
 * Both oracles are anchored on a SYNTAX shape, which is what keeps prose out of
 * the census: `scripts/validate-plugin.mjs`,
 * `scripts/lib/vault-consolidate-fs.mjs`, `hooks/post-edit-import-probe.mjs`
 * and this file's own header all MENTION a broken idiom inside a comment and
 * are excluded by step 1 without needing an allowlist entry.
 * `scripts/lib/baseline-archetypes.mjs` (`await import(process.argv[1])`) is a
 * deliberate cross-process trick that is neither a comparison nor a basename
 * test — out of scope for this check.
 *
 * `scripts/lib/ecosystem-wizard.mjs` (bare `argv[1].endsWith(...)`) and
 * `scripts/lib/fetch-baseline.mjs` (a hybrid `===`-plus-`endsWith` guard, which
 * needed the ALLOWLIST below) were the two hand-written guards this check was
 * built to catch (#1371); both were fixed to `isMainModule()` in #1378. Oracle
 * (b) was added afterwards because reverting the FIRST of them was caught by
 * nothing: the bare form was outside oracle (a) by construction, and neither
 * file's symlink smoke test reproduced its own regression (a same-named file
 * behind a symlinked DIRECTORY still ends with the basename). The allowlist is
 * empty — kept as a frozen mechanism (see its docblock) rather than deleted,
 * since the next hand-written exception is exactly what would re-populate it.
 *
 * `scripts/lib/is-main-module.mjs` itself is excluded: it is the fix, and its
 * docblock quotes every variant it replaces.
 *
 * ## Mode: BLOCKING
 *
 * Unlike the WARN-only censuses in validate-plugin (`check-unwired-features`,
 * `check-learning-provenance`, `check-vcs-repo-flag`), this one blocks. It can
 * do so honestly because the backlog was drained to zero in the same change
 * that introduced it — a blocking gate is only dishonest when it is red on
 * arrival for work nobody intends to do.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isMainModule } from '../is-main-module.mjs';
import { maskSource } from './check-untracked-test-deps.mjs';

/**
 * Files whose `process.argv[1]` comparison the oracle flags but which are NOT
 * the defect class. Every entry carries the reason it is exempt; a stale entry
 * (one the oracle no longer flags) is itself reported, so this list cannot rot
 * into a silent suppression.
 *
 * Empty since #1378: the one entry this list ever carried
 * (`scripts/lib/fetch-baseline.mjs`, whose hybrid guard's `endsWith(basename)`
 * fallback made it non-fragile) was removed when that file was fixed to
 * `isMainModule()` instead of being kept as a hand-verified exception. The
 * mechanism is retained rather than deleted: the stale-entry check below only
 * fires for an entry that is PRESENT and no longer flagged, so an empty object
 * never trips it, and a future hand-written exception can still be recorded
 * here.
 *
 * @type {Record<string, string>}
 */
const ALLOWLIST = {};

/** The one module allowed to contain every broken variant: it documents them. */
const SELF_EXEMPT = 'scripts/lib/is-main-module.mjs';

/**
 * Remove comments while preserving character offsets (so line numbers survive).
 *
 * A thin wrapper over the shared lexer `maskSource` in `keepLiterals` mode:
 * string, template and regex literals are skipped INTACT. That is load-bearing
 * twice over — the V1 idiom \`file://${process.argv[1]}\` carries a `//` that a
 * naive scanner reads as a line comment, and a regex literal must be recognised
 * as one (#1383: a `/` the lexer read as a division let the regex body's `/*`
 * open a block comment that blanked the guard below it — a fail-open miss, for
 * a quote-bearing regex, a `/[/*]/` character class, and a regex after a keyword
 * alike).
 *
 * @param {string} src module source
 * @returns {string} same length, comment bytes replaced by spaces
 */
export function stripComments(src) {
  return maskSource(src, { keepLiterals: true });
}

/**
 * A `.endsWith('<something>.mjs')` call with a module-basename-shaped literal.
 * Scanned rather than matched in one shot so the RECEIVER can be judged from the
 * text preceding each hit — a `.endsWith()` on anything other than
 * `process.argv[1]` is not this defect class.
 */
const ENDS_WITH_LITERAL = /endsWith\(\s*(['"`])([^'"`]*)\1\s*\)/g;

/**
 * The receiver chain, whitespace-stripped, that makes an `.endsWith()` call a
 * test on the invocation path. Deliberately unanchored at the START so an outer
 * wrapper (`String(...)`, `path.basename(...)`) still matches; anchored at the
 * END so only the call immediately downstream of `process.argv[1]` counts.
 */
const ARGV_RECEIVER_TAIL = /process\.argv\[1\](?:\|\|''|\|\|"")?\)*\??\.$/;

/**
 * Findings for one module body.
 *
 * `kind` distinguishes the two oracles: `comparison` is the
 * `argv[1] === import.meta.url` family, `basename` the bare
 * `argv[1].endsWith('x.mjs')` family. Both are symlink-fragile; only the remedy
 * wording differs.
 *
 * @param {string} src module source
 * @returns {Array<{line: number, text: string, kind: 'comparison'|'basename'}>} one per fragile guard
 */
export function findFragileGuards(src) {
  // Template substitutions are rewritten `${x}` → `$(x)` BEFORE the fragment
  // split: the V1 idiom `import.meta.url === \`file://${process.argv[1]}\`` puts
  // braces INSIDE the comparison, so splitting on `{}` would tear the statement
  // in two and the most common variant of the defect class (12 of 50 files at
  // ca214376) would never be seen. Length is preserved so line numbers survive.
  const stripped = stripComments(src).replace(/\$\{([^{}]*)\}/g, (_m, inner) => `$(${inner})`);
  const findings = [];
  let cursor = 0;
  for (const fragment of stripped.split(/[;{}]/)) {
    const fragStart = cursor;
    cursor += fragment.length + 1;
    if (!fragment.includes('process.argv[1]')) continue;

    /** @type {(offset: number) => number} 1-based line of an offset in `fragment` */
    const lineAt = (offset) =>
      stripped.slice(0, Math.min(fragStart + offset, stripped.length)).split('\n').length;

    if (!/import\.meta\.url|__filename/.test(fragment)) {
      // Oracle (b): no self-path mention at all, so the comparison oracle below
      // cannot see this fragment. The bare basename test lives exactly here.
      if (!/realpath/i.test(fragment)) {
        ENDS_WITH_LITERAL.lastIndex = 0;
        let m;
        while ((m = ENDS_WITH_LITERAL.exec(fragment)) !== null) {
          if (!/\.(?:mjs|js|cjs)$/.test(m[2])) continue;
          const receiver = fragment.slice(0, m.index).replace(/\s+/g, '');
          if (!ARGV_RECEIVER_TAIL.test(receiver)) continue;
          findings.push({
            line: lineAt(m.index),
            text: `process.argv[1]…${m[0]}`,
            kind: 'basename',
          });
          break; // one finding per statement is enough to act on
        }
      }
      continue;
    }

    const parts = fragment.split(/===|!==/);
    for (let k = 0; k < parts.length - 1; k++) {
      const left = parts[k].split(/&&|\|\|/).pop() ?? '';
      const right = parts[k + 1].split(/&&|\|\|/)[0] ?? '';
      const mentionsArgv = /process\.argv\[1\]/.test(left) || /process\.argv\[1\]/.test(right);
      const mentionsSelf =
        /import\.meta\.url|__filename/.test(left) || /import\.meta\.url|__filename/.test(right);
      if (!mentionsArgv || !mentionsSelf) continue;
      if (/realpath/i.test(left) || /realpath/i.test(right)) continue; // the safe idiom
      const line = lineAt(parts.slice(0, k + 1).join('===').length || 0);
      findings.push({
        line,
        text: `${left.trim()} === ${right.trim()}`.replace(/\s+/g, ' '),
        kind: 'comparison',
      });
      break; // one finding per statement is enough to act on
    }
  }
  return findings;
}

/**
 * Tracked `.mjs` files under `scripts/` and `hooks/`.
 *
 * @param {string} repoRoot absolute repo root
 * @returns {string[]} repo-relative POSIX paths
 */
function trackedModules(repoRoot) {
  // Pathspecs are DIRECTORIES, not `scripts/**/*.mjs`: git's wildmatch requires
  // `**` to consume at least one path component, so a `scripts/**/*.mjs` spec
  // silently drops every top-level `scripts/*.mjs` AND all of `hooks/*.mjs` —
  // measured 2026-09-16: 61 files matched vs 176 actually tracked. The extension
  // filter therefore lives here, where it cannot be wrong about that.
  //
  // Re-measured 2026-09-17 (the 61/176 pair no longer reproduces at any scope I
  // could reconstruct, so it is kept as-dated rather than edited):
  // `git ls-files -- 'scripts/**/*.mjs' 'hooks/**/*.mjs' | wc -l` → 422 against
  // `git ls-files -- scripts hooks | grep -c '\.mjs$'` → 508. Direction of the
  // trap is unchanged; only the magnitude moved.
  const out = execFileSync('git', ['ls-files', '--', 'scripts', 'hooks'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('.mjs'));
}

/**
 * Run the census.
 *
 * @param {string} repoRoot absolute repo root
 * @returns {Promise<number>} 0 clean · 1 findings · 2 tool error
 */
export async function runCheckEntryGuard(repoRoot) {
  let files;
  try {
    files = trackedModules(repoRoot);
  } catch (err) {
    console.log(`  FAIL: cannot enumerate tracked modules: ${err.message}`);
    console.log('');
    console.log('Results: 0 passed, 1 failed');
    return 2;
  }

  let failed = 0;
  const flagged = new Set();
  for (const rel of files) {
    if (rel === SELF_EXEMPT) continue;
    let body;
    try {
      body = readFileSync(path.join(repoRoot, rel), 'utf8');
    } catch {
      continue; // deleted between ls-files and read — not this check's business
    }
    const findings = findFragileGuards(body);
    if (findings.length === 0) continue;
    flagged.add(rel);
    if (rel in ALLOWLIST) continue;
    for (const f of findings) {
      const why =
        f.kind === 'basename'
          ? 'a basename test answers "was a file with this name run?", never "was THIS ' +
            'module run" — it is true for any same-named file (a sibling copy, a ' +
            'vendored duplicate, a fixture) and resolves no path at all, so main() ' +
            'fires or stays silent for reasons unrelated to identity'
          : '`import.meta.url` is the realpath, `process.argv[1]` is the path as typed, ' +
            'so the guard is false under any symlinked invocation and main() silently ' +
            'never runs (exit 0, no output)';
      console.log(
        `  FAIL: ${rel}:${f.line} — symlink-fragile entry guard \`${f.text}\`: ${why}. ` +
          'Use `isMainModule(import.meta.url)` from scripts/lib/is-main-module.mjs',
      );
      failed++;
    }
  }

  const censused = new Set(files);
  for (const [rel, reason] of Object.entries(ALLOWLIST)) {
    if (flagged.has(rel)) continue;
    // Not present at all (a fixture repo, a fork that deleted the file) is not
    // rot — only an entry whose file IS censused and no longer flagged is.
    if (!censused.has(rel)) continue;
    console.log(
      `  FAIL: ${rel} — stale allowlist entry: the oracle no longer flags this file, ` +
        `so the exemption (“${reason}”) suppresses nothing. Remove it.`,
    );
    failed++;
  }

  if (failed === 0) {
    console.log(
      `  PASS: censused ${files.length} tracked module(s) under scripts/ + hooks/ — ` +
        `0 symlink-fragile entry guard(s), ${Object.keys(ALLOWLIST).length} allowlisted`,
    );
  }
  console.log('');
  console.log(`Results: ${failed === 0 ? 1 : 0} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const usage =
    'Usage: check-entry-guard.mjs [<repo-root>]\n' +
    'Exit: 0 clean · 1 symlink-fragile entry guard(s) found · 2 tool error';
  if (argv.includes('--help')) {
    console.log(usage);
    process.exitCode = 0;
  } else {
    const positional = argv.filter((a) => !a.startsWith('--'));
    const unknown = argv.filter((a) => a.startsWith('--') && a !== '--help');
    if (unknown.length > 0) {
      console.error(`Unknown flag(s): ${unknown.join(', ')}\n${usage}`);
      process.exitCode = 1;
    } else {
      process.exitCode = await runCheckEntryGuard(path.resolve(positional[0] ?? process.cwd()));
    }
  }
}
