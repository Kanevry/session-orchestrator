#!/usr/bin/env node
/**
 * check-test-posix-shell.mjs — tests must not spawn a POSIX shell by bare name.
 *
 * WHY. On native Windows `sh` is not on PATH and `bash` resolves to
 * C:\Windows\System32\bash.exe, which is WSL and cannot see Windows paths
 * (measured 2026-10-22 on the Windows 11 test PC, `where sh & where bash`,
 * SO#1613). A test that runs `spawnSync('sh', …)` or `execFileSync('/bin/bash', …)`
 * is therefore red on Windows for a reason that has nothing to do with the code
 * under test. The native run at fd8d3673 counted 301 red tests in exactly this
 * class; the same session moved ~25 test files to `posixShell()` from
 * `tests/_helpers/posix-shell.mjs`, which returns the name unchanged off Windows
 * and Git Bash's sh.exe/bash.exe on win32. This check keeps the class from
 * coming back.
 *
 * RULE. In tracked `tests/**\/*.mjs`, a finding is:
 *  - a call to `spawn` / `spawnSync` / `execFile` / `execFileSync` (bare or as a
 *    member, e.g. `cp.spawnSync`) whose FIRST argument is the string literal
 *    `sh`, `bash`, `/bin/sh` or `/bin/bash` in any quote style;
 *  - a call to `exec` / `execSync` whose command string literal starts with
 *    `sh `, `bash `, `/bin/sh ` or `/bin/bash `.
 * A call through `posixShell(...)` is never a finding (its first argument is not
 * a literal). `tests/_helpers/posix-shell.mjs` itself is exempt.
 *
 * METHOD. Textual, over the shared lexer `scripts/lib/js-mask.mjs`: the call
 * name and its opening quote are matched on the fully masked source (comments
 * and literal interiors blanked), so a commented-out spawn and fixture source
 * embedded in a template literal are not scanned as code; the literal VALUE is
 * then read at the same offset from the comments-only mask (offsets are
 * preserved by both modes).
 * Named ceiling (BV-004): a shell name passed through a variable
 * (`const SH = 'sh'; spawnSync(SH, …)`) is not seen. REVISIT if a native
 * Windows run shows that shape red.
 *
 * BASELINE. Three files are changed by open merge requests (!239/!237, !240) at the
 * time this check landed, so the #1613 session left them untouched; each is
 * baselined below (WARN, not FAIL) and gets converted after those MRs land. An
 * entry whose file no longer has a finding FAILs as `baseline-stale` so a
 * converted file does not leave a permanent exemption behind; an entry with an
 * empty reason FAILs as `baseline-missing-reason` (same discipline as
 * `check-hooks-emit-event-guard.mjs`). Every other site FAILs.
 *
 * Usage: check-test-posix-shell.mjs <repo-root>
 * Output: `  PASS: …` / `  WARN: …` / `  FAIL: …` lines, then
 * `Results: N passed, M failed`. Exit 0 = clean (baselined WARNs allowed),
 * 1 = at least one new finding or baseline defect, 2 = tool error.
 *
 * Import-safety: importing this module executes nothing — the isMain guard at
 * the bottom is the only side-effecting path.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { maskSource } from '../js-mask.mjs';
import { listRepoFiles } from './repo-files.mjs';
import { isMainModule } from '../is-main-module.mjs';

const SCAN_DIR = 'tests';

/** The helper that resolves the shell; it may name the shells itself. */
const EXEMPT_FILES = new Set(['tests/_helpers/posix-shell.mjs']);

/**
 * Baseline — Map<repo-relative file, reason>. Keyed per file, not per line:
 * the open MRs reshape these files, and a line key would silently stop matching.
 */
const BASELINE_FILES = new Map([
  [
    'tests/skills/tmux-layout.test.mjs',
    '#1613: file is changed by an open MR (!240); convert to posixShell() after it lands',
  ],
  [
    'tests/so-hud/rules.test.mjs',
    '#1613: file is changed by an open MR (!239/!237); convert to posixShell() after it lands',
  ],
  [
    'tests/scripts/sweep-expired-learnings-cli.test.mjs',
    '#1613: file is changed by an open MR (!239/!237); convert to posixShell() after it lands',
  ],
]);

const SHELL_NAMES = new Set(['sh', 'bash', '/bin/sh', '/bin/bash']);
const SHELL_COMMAND_PREFIX_RE = /^(?:\/bin\/)?(?:sh|bash) /;

/** Call name plus open paren plus a quote, on the masked source. */
const CALL_RE = /\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\s*\(\s*(['"`])/g;

/**
 * Read the string literal that opens at `start` (a quote char) in `text`.
 *
 * @param {string} text comments-only masked source
 * @param {number} start offset of the opening quote
 * @returns {string | null} the literal's value, or null when it is not a
 *   single-line literal without `${` interpolation
 */
function literalAt(text, start) {
  const quote = text[start];
  const end = text.indexOf(quote, start + 1);
  if (end === -1) return null;
  const value = text.slice(start + 1, end);
  if (value.includes('\n') || value.includes('${')) return null;
  return value;
}

/**
 * Find bare-shell spawn call sites in one source text.
 *
 * @param {string} source
 * @returns {{line: number, call: string, shell: string}[]}
 */
export function findBareShellCalls(source) {
  const masked = maskSource(source);
  const literals = maskSource(source, { keepLiterals: true });
  /** @type {{line: number, call: string, shell: string}[]} */
  const calls = [];
  for (const m of masked.matchAll(CALL_RE)) {
    const call = m[1];
    const quoteAt = m.index + m[0].length - 1;
    const value = literalAt(literals, quoteAt);
    if (value === null) continue;
    const isExecFamily = call === 'exec' || call === 'execSync';
    const hit = isExecFamily ? SHELL_COMMAND_PREFIX_RE.test(value) : SHELL_NAMES.has(value);
    if (!hit) continue;
    const line = source.slice(0, m.index).split('\n').length;
    calls.push({ line, call, shell: isExecFamily ? value.split(' ')[0] : value });
  }
  return calls;
}

/**
 * @typedef {{kind: 'bare-shell', file: string, line: number, call: string, shell: string, baselined: boolean}} ShellFinding
 * @typedef {{kind: 'baseline-stale' | 'baseline-missing-reason', file: string, message: string}} BaselineFinding
 */

/**
 * Scan tracked `tests/**\/*.mjs` under `repoRoot`.
 *
 * @param {string} repoRoot
 * @param {{baseline?: Map<string, string>}} [options] `baseline` defaults to the
 *   shipped {@link BASELINE_FILES}; injectable so tests exercise the baseline
 *   paths against a tmp fixture.
 * @returns {{findings: (ShellFinding | BaselineFinding)[], readErrors: {file: string, message: string}[]}}
 */
export function scanTestPosixShell(repoRoot, { baseline = BASELINE_FILES } = {}) {
  const files = listRepoFiles(repoRoot, { dirs: [SCAN_DIR], exts: ['mjs'] });
  /** @type {(ShellFinding | BaselineFinding)[]} */
  const findings = [];
  /** @type {{file: string, message: string}[]} */
  const readErrors = [];
  /** @type {Set<string>} */
  const matchedBaseline = new Set();

  for (const absFile of files) {
    const rel = path.relative(repoRoot, absFile).split(path.sep).join('/');
    if (EXEMPT_FILES.has(rel)) continue;
    let source;
    try {
      source = readFileSync(absFile, 'utf8');
    } catch (err) {
      readErrors.push({ file: rel, message: `unreadable: ${err?.message ?? String(err)}` });
      continue;
    }
    if (!/\b(?:spawn|exec)/.test(source)) continue; // cheap textual pre-filter

    const calls = findBareShellCalls(source);
    if (calls.length === 0) continue;
    const baselined = baseline.has(rel);
    if (baselined) {
      matchedBaseline.add(rel);
      if (String(baseline.get(rel) ?? '').trim() === '') {
        findings.push({
          kind: 'baseline-missing-reason',
          file: rel,
          message: 'baseline entry has no reason — name the linked issue or remove the entry',
        });
      }
    }
    for (const c of calls) findings.push({ kind: 'bare-shell', file: rel, ...c, baselined });
  }

  for (const file of baseline.keys()) {
    if (matchedBaseline.has(file)) continue;
    findings.push({
      kind: 'baseline-stale',
      file,
      message: 'baseline entry no longer has a bare shell spawn (converted or removed) — remove the entry',
    });
  }

  return { findings, readErrors };
}

/**
 * Run the check and print the validate-plugin line vocabulary.
 *
 * @param {string} repoRoot
 * @param {{baseline?: Map<string, string>}} [options] forwarded to {@link scanTestPosixShell}
 * @returns {number} 0 = clean, 1 = new finding(s), 2 = tool error
 */
export function runCheckTestPosixShell(repoRoot, options) {
  console.log('--- Check: tests spawn a POSIX shell via posixShell(), not by bare name (#1613) ---');

  const { findings, readErrors } = scanTestPosixShell(repoRoot, options);
  if (readErrors.length > 0) {
    for (const e of readErrors) console.log(`  FAIL: ${e.file} — ${e.message}`);
    console.log('');
    console.log(`Results: 0 passed, ${readErrors.length} failed`);
    return 2;
  }

  const shellFindings = /** @type {ShellFinding[]} */ (findings.filter((f) => f.kind === 'bare-shell'));
  const baselineIssues = /** @type {BaselineFinding[]} */ (findings.filter((f) => f.kind !== 'bare-shell'));
  const fresh = shellFindings.filter((f) => !f.baselined);
  const old = shellFindings.filter((f) => f.baselined);

  if (fresh.length === 0 && baselineIssues.length === 0) {
    console.log(
      old.length === 0
        ? '  PASS: no test spawns sh/bash by bare name'
        : `  PASS: no NEW bare sh/bash spawn in tests/ (${old.length} pre-existing, baselined — see #1613)`,
    );
  }
  for (const f of old) {
    console.log(`  WARN: ${f.file}:${f.line} — ${f.call}('${f.shell}' …) by bare name (baselined #1613, file is in an open MR)`);
  }
  for (const f of fresh) {
    console.log(
      `  FAIL: ${f.file}:${f.line} — ${f.call}('${f.shell}' …) by bare name; on native Windows sh is not on PATH and bash is WSL — use posixShell() from tests/_helpers/posix-shell.mjs`,
    );
  }
  for (const f of baselineIssues) console.log(`  FAIL: ${f.file} — ${f.message} (${f.kind})`);

  const failCount = fresh.length + baselineIssues.length;
  console.log('');
  console.log(`Results: ${failCount === 0 ? 1 : 0} passed, ${failCount} failed`);
  return failCount > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  const root = process.argv[2];
  if (!root) {
    console.error('Usage: check-test-posix-shell.mjs <repo-root>');
    process.exit(2);
  }
  process.exit(runCheckTestPosixShell(path.resolve(root)));
}
