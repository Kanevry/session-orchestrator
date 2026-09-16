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
 *   3. inside each fragment, take every `===` / `!==` comparison and its two
 *      operands (bounded to the adjacent `&&` / `||` segment),
 *   4. FAIL when one operand mentions `process.argv[1]` and the other mentions
 *      `import.meta.url` or `__filename`, UNLESS either operand is wrapped in a
 *      `realpath*` call — that is the safe idiom and must not be flagged.
 *
 * Requiring a comparison operator is what keeps prose out of the census:
 * `scripts/validate-plugin.mjs`, `scripts/lib/vault-consolidate-fs.mjs` and
 * `hooks/post-edit-import-probe.mjs` all MENTION the broken idiom inside a
 * comment and are excluded by step 1 + step 3 without needing an allowlist
 * entry. `scripts/lib/ecosystem-wizard.mjs` (`argv[1].endsWith(...)`) and
 * `scripts/lib/baseline-archetypes.mjs` (`await import(process.argv[1])`)
 * contain no such comparison at all.
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

/**
 * Files whose `process.argv[1]` comparison the oracle flags but which are NOT
 * the defect class. Every entry carries the reason it is exempt; a stale entry
 * (one the oracle no longer flags) is itself reported, so this list cannot rot
 * into a silent suppression.
 *
 * @type {Record<string, string>}
 */
const ALLOWLIST = {
  'scripts/lib/fetch-baseline.mjs':
    'hybrid guard: the argv[1]-vs-URL comparison is only the FIRST of three ' +
    'alternatives, and the final `endsWith(basename)` branch still matches under ' +
    'a symlinked invocation — so the guard does not silently fail',
};

/** The one module allowed to contain every broken variant: it documents them. */
const SELF_EXEMPT = 'scripts/lib/is-main-module.mjs';

/**
 * Remove comments while preserving character offsets (so line numbers survive).
 *
 * @param {string} src module source
 * @returns {string} same length, comment bytes replaced by spaces
 */
export function stripComments(src) {
  const out = src.split('');
  let i = 0;
  let mode = 'code';
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (mode === 'code') {
      if (two === '//') mode = 'line';
      else if (two === '/*') mode = 'block';
      else if (src[i] === '`' || src[i] === "'" || src[i] === '"') {
        // Skip OVER the literal to its closing delimiter, leaving the contents
        // intact. This is load-bearing, not hygiene: the V1 idiom is
        // \`file://${process.argv[1]}\` and the `//` in `file://` reads as a line
        // comment to a naive scanner, which blanks the rest of the line and
        // makes the most common variant of the defect class invisible.
        const quote = src[i];
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') i++;
          i++;
        }
        i++;
        continue;
      }
    }
    if (mode === 'line') {
      if (src[i] === '\n') mode = 'code';
      else out[i] = ' ';
    } else if (mode === 'block') {
      if (src[i] !== '\n') out[i] = ' ';
      if (two === '*/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
        mode = 'code';
        continue;
      }
    }
    i++;
  }
  return out.join('');
}

/**
 * Findings for one module body.
 *
 * @param {string} src module source
 * @returns {Array<{line: number, text: string}>} one per fragile comparison
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
    if (!/import\.meta\.url|__filename/.test(fragment)) continue;

    const parts = fragment.split(/===|!==/);
    for (let k = 0; k < parts.length - 1; k++) {
      const left = parts[k].split(/&&|\|\|/).pop() ?? '';
      const right = parts[k + 1].split(/&&|\|\|/)[0] ?? '';
      const mentionsArgv = /process\.argv\[1\]/.test(left) || /process\.argv\[1\]/.test(right);
      const mentionsSelf =
        /import\.meta\.url|__filename/.test(left) || /import\.meta\.url|__filename/.test(right);
      if (!mentionsArgv || !mentionsSelf) continue;
      if (/realpath/i.test(left) || /realpath/i.test(right)) continue; // the safe idiom
      const offset = fragStart + (parts.slice(0, k + 1).join('===').length || 0);
      const line = stripped.slice(0, Math.min(offset, stripped.length)).split('\n').length;
      findings.push({ line, text: `${left.trim()} === ${right.trim()}`.replace(/\s+/g, ' ') });
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
      console.log(
        `  FAIL: ${rel}:${f.line} — symlink-fragile entry guard \`${f.text}\`: ` +
          '`import.meta.url` is the realpath, `process.argv[1]` is the path as typed, ' +
          'so the guard is false under any symlinked invocation and main() silently ' +
          "never runs (exit 0, no output). Use `isMainModule(import.meta.url)` from " +
          'scripts/lib/is-main-module.mjs',
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
